import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import { SessionConfig } from "../api";
import { ChatLog } from "./chatlog";
import { applyCodeBlock } from "./apply";

interface Message {
  role: "user" | "assistant";
  content: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  latencyMs?: number;
}

export const STREAM_TIMEOUT_MS = 60_000;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private messages: Message[] = [];
  private chatLog?: ChatLog;
  private isLoading = false;
  private streamingText = "";
  private spentUsd = 0;
  private config: SessionConfig | undefined;
  private selectedModel: string = "openai/gpt-4o-mini";
  private budgetExhausted = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setConfig(config: SessionConfig): void {
    this.config = config;
    this.selectedModel = config.availableChatModels[0] ?? config.chatModel;
    if (!this.chatLog) {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      this.chatLog = new ChatLog(ws);
    }
    this.render();
  }

  focus(): void {
    this._view?.show(true);
  }

  dispose(): void {
    // No persistent resources to release; satisfies vscode.Disposable for subscriptions.
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
  }

  private handleMessage(msg: { command: string; text?: string; filePath?: string; codeText?: string; blockId?: string; model?: string }): void {
    if (msg.command === "send" && msg.text && !this.isLoading && this.config) {
      this.send(msg.text, this.config);
    }
    if (msg.command === "applyBlock" && msg.filePath && msg.codeText && msg.blockId) {
      applyCodeBlock(msg.filePath, msg.codeText, msg.blockId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Apply failed: ${message}`);
      });
    }
    if (msg.command === "copyText" && msg.text) {
      vscode.env.clipboard.writeText(msg.text);
    }
    if (msg.command === "changeModel" && msg.model) {
      this.selectedModel = msg.model;
    }
  }

  private async send(userText: string, config: SessionConfig): Promise<void> {
    // Capture the model at send time so model switches mid-stream do not
    // misattribute the response.
    const requestModel = this.selectedModel;
    this.messages.push({ role: "user", content: userText });
    this.isLoading = true;
    this.streamingText = "";
    this.render();

    const start = Date.now();
    let assistantText = "";
    let budgetExhausted = false;
    let errorMessage: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    try {
      await this.streamChat(config, this.messages, requestModel, (chunk) => {
        if (chunk.error) { budgetExhausted = true; return; }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          assistantText += delta;
          this.streamingText = assistantText;
          this._view?.webview.postMessage({ command: "streaming", text: assistantText });
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
          cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
      });
    } catch (e: any) {
      errorMessage = e?.message ?? String(e);
    }

    const latencyMs = Date.now() - start;
    this.isLoading = false;
    this.streamingText = "";

    if (errorMessage) {
      // Surface to user, but do NOT persist the error to the audit trail.
      vscode.window.showErrorMessage(`AI chat error: ${errorMessage}`);
      // Drop the optimistic user message from the history (it has no response
      // to pair with) and ALSO push the original text back to the webview so
      // the candidate can retry without retyping. The old code dropped the
      // message and cleared the textarea, forcing the user to start over.
      if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === "user") {
        this.messages.pop();
      }
      this._view?.webview.postMessage({ command: "restorePrompt", text: userText });
      this.render();
      return;
    }

    this.messages.push({
      role: "assistant",
      content: assistantText,
      model: requestModel,
      promptTokens,
      completionTokens,
      cachedTokens,
      latencyMs,
    });

    const _pricing: Record<string, { input: number; output: number }> = {
      'openai/gpt-4o':             { input: 2.50,  output: 10.00 },
      'openai/gpt-4o-mini':        { input: 0.15,  output: 0.60  },
      'openai/gpt-4o-2024-11-20':  { input: 2.50,  output: 10.00 },
    };
    const _p = _pricing[requestModel] ?? { input: 2.50, output: 10.00 };
    const billablePromptTokens = Math.max(0, promptTokens - cachedTokens);
    const inputCost  = (billablePromptTokens / 1_000_000) * _p.input;
    const outputCost = (completionTokens     / 1_000_000) * _p.output;
    this.spentUsd += inputCost + outputCost;

    this.chatLog?.append({
      timestamp: Date.now(),
      prompt_text: userText,
      response_text: assistantText,
      model_used: requestModel ?? "gpt-4o-mini",
      prompt_tokens: promptTokens,
      response_tokens: completionTokens,
      response_latency_ms: latencyMs,
      topic_hint: "",
      correction_loop: false,
    });

    if (budgetExhausted) {
      this.budgetExhausted = true;
    }
    this.render();
  }

  private streamChat(
    config: SessionConfig,
    messages: Message[],
    model: string,
    onChunk: (chunk: any) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
      const activeFileBlock = buildActiveFileBlock();
      if (activeFileBlock) {
        for (let i = apiMessages.length - 1; i >= 0; i--) {
          if (apiMessages[i].role === "user") {
            apiMessages[i] = { role: "user", content: activeFileBlock + apiMessages[i].content };
            break;
          }
        }
      }
      const body = JSON.stringify({ messages: apiMessages, model });
      const url = new URL(`${config.llmProxyUrl}/api/v1/llm/chat/completions`);
      const lib = url.protocol === "https:" ? https : http;
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        try { req.destroy(); } catch {}
        if (err) reject(err); else resolve();
      };

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${config.sessionKey}`,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 400) {
            let errBody = "";
            res.on("data", (d: Buffer) => { errBody += d.toString(); });
            res.on("end", () => {
              const trimmed = errBody.trim().slice(0, 300);
              done(new Error(`HTTP ${status}${trimmed ? `: ${trimmed}` : ""}`));
            });
            res.on("error", (e) => done(e));
            return;
          }
          let buf = "";
          res.on("data", (d: Buffer) => {
            buf += d.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") { done(); return; }
              try { onChunk(JSON.parse(payload)); } catch {}
            }
          });
          res.on("end", () => done());
          res.on("error", (e) => done(e));
        }
      );
      req.on("error", (e) => done(e));
      req.setTimeout(STREAM_TIMEOUT_MS, () => {
        done(new Error(`Request timed out after ${STREAM_TIMEOUT_MS}ms`));
      });
      req.write(body);
      req.end();
    });
  }

  private render(): void {
    if (!this._view || !this.config) return;

    const config = this.config;

    const prettyModel = (m: string | undefined): string =>
      (m ?? "openai/gpt-4o-mini")
        .replace(/^openai\//, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    const currentModelLabel = prettyModel(this.selectedModel);

    const modelOptions = (config.availableChatModels ?? [config.chatModel]).map((m) => {
      const label = prettyModel(m);
      const selected = m === this.selectedModel ? " selected" : "";
      return `<option value="${escHtml(m)}"${selected}>${escHtml(label)}</option>`;
    }).join("");

    const budgetUsd = config.llmBudgetUsd ?? 2.00;
    const spentPct = Math.min(100, (this.spentUsd / budgetUsd) * 100);
    const meterColor =
      spentPct > 95 ? "#f44336" : spentPct > 75 ? "#e8c000" : "var(--vscode-button-background)";

    let msgHtml = this.messages
      .map((m, i) => {
        if (m.role === "user") {
          return `<div class="msg user" id="msg-${i}">
            <div class="role-label">You</div>
            <div class="bubble user-bubble">${escHtml(m.content)}</div>
          </div>`;
        }
        const tokenInfo = m.promptTokens
          ? `<span class="token-info" title="Input / Output / Cached tokens  •  ${m.latencyMs}ms">↑${m.promptTokens} ↓${m.completionTokens}${m.cachedTokens ? ` ⚡${m.cachedTokens}` : ""} · ${m.latencyMs}ms</span>`
          : "";
        const formatted = formatContent(m.content);
        const msgLabel = prettyModel(m.model);
        return `<div class="msg assistant" id="msg-${i}">
          <div class="msg-header">
            <span class="role-label-ai">${escHtml(msgLabel)}</span>
            ${tokenInfo}
            <vscode-button appearance="icon" data-copy-msg="${i}" title="Copy response">&#8998;</vscode-button>
          </div>
          <div class="bubble ai-bubble">${formatted}</div>
        </div>`;
      })
      .join("");

    if (this.isLoading) {
      if (this.streamingText) {
        msgHtml += `<div class="msg assistant" id="streaming-msg">
          <div class="msg-header"><span class="role-label-ai">${currentModelLabel}</span></div>
          <div class="bubble ai-bubble">${formatContent(this.streamingText)}</div>
          <div class="shimmer-bar"></div>
        </div>`;
      } else {
        msgHtml += `<div class="msg assistant" id="streaming-msg">
          <div class="msg-header"><span class="role-label-ai">${currentModelLabel}</span></div>
          <div class="bubble ai-bubble loading-bubble">
            <div class="typing"><span></span><span></span><span></span></div>
          </div>
        </div>`;
      }
    }

    const chipPrompts = [
      "Explain the data structure choice and the O(1) requirement",
      "What thread-safety issues should I look for in the starter code?",
      "My put() is failing the [thread] test — here is my implementation:",
    ];
    const chipLabels = ["Explain core data structure", "Thread safety issues", "Debug thread test"];
    const exampleChips = `
      <div class="chips">
        ${chipPrompts.map((p, i) =>
          `<vscode-button class="chip-btn" appearance="secondary" data-chip="${escHtml(p)}">${escHtml(chipLabels[i])}</vscode-button>`
        ).join("")}
      </div>`;

    const msgContents = JSON.stringify(this.messages.map((m) => m.content)).replace(/</g, '\\u003c');

    const toolkitUri = this._view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "toolkit.min.js")
    );
    const cspSource = this._view.webview.cspSource;
    const nonce = crypto.randomBytes(16).toString("base64");

    this._view.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
<script type="module" nonce="${nonce}" src="${toolkitUri}"></script>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    display: flex;
    flex-direction: column;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
  }

  #top-strip {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px 5px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    flex-shrink: 0; gap: 8px;
  }
  .model-select {
    font-size: 11px; font-weight: 600;
    color: var(--vscode-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 2px 4px;
    max-width: 140px;
  }
  .budget-meter { flex: 1; max-width: 120px; }
  .budget-bar-track {
    height: 4px; background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px; overflow: hidden;
  }
  .budget-bar-fill {
    height: 100%;
    width: ${spentPct.toFixed(1)}%;
    background: ${meterColor};
    border-radius: 3px;
    transition: width 0.4s ease;
  }
  .budget-label {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    margin-top: 2px; text-align: right;
  }

  #msgs {
    flex: 1; overflow-y: auto;
    padding: 10px 10px 6px;
    display: flex; flex-direction: column; gap: 12px;
  }
  .empty-state {
    color: var(--vscode-descriptionForeground);
    text-align: center; padding: 20px 14px 8px; font-size: 12px; line-height: 1.55;
  }
  .chips { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
  .chip-btn { width: 100%; text-align: left; }

  .msg { display: flex; flex-direction: column; gap: 3px; }
  .msg.user { align-items: flex-end; }
  .msg.assistant { align-items: flex-start; }
  .role-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground); padding: 0 3px;
  }
  .msg-header { display: flex; align-items: center; gap: 6px; padding: 0 3px; flex-wrap: wrap; }
  .role-label-ai {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vscode-button-background);
  }
  .token-info {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .bubble {
    max-width: 96%; padding: 8px 11px; border-radius: 10px;
    line-height: 1.55; word-break: break-word;
  }
  .user-bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 3px; white-space: pre-wrap;
  }
  .ai-bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    border-bottom-left-radius: 3px; white-space: normal; width: 100%;
  }
  .ai-bubble p { margin: 0 0 6px; }
  .ai-bubble p:last-child { margin: 0; }

  .code-block { margin: 8px 0 4px; }
  .code-block pre {
    margin: 0; padding: 10px;
    background: rgba(0,0,0,0.2);
    border: 1px solid var(--vscode-panel-border);
    border-bottom: none; border-radius: 6px 6px 0 0;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px; white-space: pre; line-height: 1.4;
  }
  .code-actions {
    display: flex; gap: 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 0 0 6px 6px; overflow: hidden;
  }
  .code-btn {
    flex: 1; padding: 4px 0; cursor: pointer; border: none;
    font-size: 11px; font-weight: 500; font-family: inherit;
    background: var(--vscode-input-background); color: var(--vscode-descriptionForeground);
  }
  .code-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .code-btn + .code-btn { border-left: 1px solid var(--vscode-panel-border); }
  .code-btn.apply-btn { color: var(--vscode-button-background); }
  .code-btn.apply-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .ai-bubble code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: rgba(0,0,0,0.15);
    padding: 1px 4px; border-radius: 3px; font-size: 11.5px;
  }

  .shimmer-bar {
    height: 2px; border-radius: 1px; margin-top: 4px; width: 100%;
    background: linear-gradient(90deg,
      var(--vscode-panel-border) 0%, var(--vscode-button-background) 50%, var(--vscode-panel-border) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  .loading-bubble { padding: 10px 14px !important; }
  .typing { display: flex; gap: 5px; align-items: center; }
  .typing span {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--vscode-descriptionForeground);
    animation: bounce 1.3s ease-in-out infinite; display: inline-block;
  }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
    30% { transform: translateY(-5px); opacity: 1; }
  }

  #budget-warn {
    display: none;
    background: var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.1));
    color: var(--vscode-errorForeground, #f48771);
    border-top: 1px solid var(--vscode-inputValidation-errorBorder, rgba(244,67,54,0.3));
    padding: 7px 10px; font-size: 12px; text-align: center; flex-shrink: 0;
  }

  #input-row {
    display: flex; gap: 6px; padding: 8px 10px; align-items: flex-end;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    background: var(--vscode-editor-background);
    flex-shrink: 0;
  }
  #inp { flex: 1; resize: none; }
</style>
</head>
<body>
<div id="top-strip">
  <select id="model-select" class="model-select">${modelOptions}</select>
  <div class="budget-meter">
    <div class="budget-bar-track"><div class="budget-bar-fill"></div></div>
    <div class="budget-label">$${this.spentUsd.toFixed(3)} / $${budgetUsd.toFixed(2)}</div>
  </div>
</div>
<div id="msgs">
  ${msgHtml || `<div class="empty-state">
      <div style="font-size:20px;margin-bottom:8px;">&#129302;</div>
      <div style="font-weight:600;margin-bottom:4px;">Ask the AI anything about your challenge</div>
      <div style="font-size:11.5px;margin-bottom:12px;color:inherit;opacity:0.8;">Better prompts = better grade. Try to be specific.</div>
      ${exampleChips}
    </div>`}
</div>
<div id="budget-warn" style="${this.budgetExhausted ? "display:block;" : ""}">AI budget reached — finish the challenge on your own.</div>
<div id="input-row">
  <vscode-text-area id="inp" placeholder="${this.budgetExhausted ? "AI budget reached" : (this.isLoading ? "Generating…" : "Ask anything… (Enter to send, Shift+Enter for newline)")}" ${(this.isLoading || this.budgetExhausted) ? "disabled" : ""} resize="none" rows="1" style="flex:1"></vscode-text-area>
  <vscode-button id="send-btn" ${(this.isLoading || this.budgetExhausted) ? "disabled" : ""}>&#8593;</vscode-button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const msgs = document.getElementById('msgs');
  const msgContents = ${msgContents};

  msgs.scrollTop = msgs.scrollHeight;

  function getInp() { return document.getElementById('inp'); }
  function getSendBtn() { return document.getElementById('send-btn'); }

  document.getElementById('inp').addEventListener('keydown', function(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  document.getElementById('send-btn').addEventListener('click', send);

  // CSP forbids inline event handlers — wire chip clicks, model select, and
  // dynamically-added apply/copy/copyMsg buttons via event delegation on the
  // shared #msgs / #top-strip containers so newly rendered code blocks work
  // without needing to re-attach handlers.
  const modelSelect = document.getElementById('model-select');
  if (modelSelect) {
    modelSelect.addEventListener('change', function() { changeModel(modelSelect.value); });
  }
  document.body.addEventListener('click', function(ev) {
    let el = ev.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.chip) { useChip(el.dataset.chip); return; }
      if (el.dataset && el.dataset.copyMsg !== undefined) { copyMsg(parseInt(el.dataset.copyMsg, 10)); return; }
      if (el.dataset && el.dataset.applyBlockId) {
        applyBlock(el.dataset.applyBlockId, el.dataset.applyFile, el.dataset.applyEncoded);
        return;
      }
      if (el.dataset && el.dataset.copyEncoded) { copyBlock(el.dataset.copyEncoded); return; }
      el = el.parentNode;
    }
  });

  function send() {
    const inp = getInp();
    if (!inp || inp.hasAttribute('disabled')) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    vscode.postMessage({ command: 'send', text });
  }

  function copyMsg(idx) {
    vscode.postMessage({ command: 'copyText', text: msgContents[idx] || '' });
  }

  function applyBlock(blockId, filePath, encoded) {
    const codeText = decodeURIComponent(encoded);
    vscode.postMessage({ command: 'applyBlock', blockId, filePath, codeText });
  }

  function copyBlock(encoded) {
    vscode.postMessage({ command: 'copyText', text: decodeURIComponent(encoded) });
  }

  function useChip(text) {
    const inp = getInp();
    if (!inp || inp.hasAttribute('disabled')) return;
    inp.value = text;
    inp.focus();
  }

  function changeModel(model) {
    vscode.postMessage({ command: 'changeModel', model });
  }

  window.addEventListener('message', e => {
    const { command, text } = e.data;
    if (command === 'budgetExhausted') {
      document.getElementById('budget-warn').style.display = 'block';
      const inp = getInp();
      if (inp) inp.setAttribute('disabled', '');
      const sendBtn = getSendBtn();
      if (sendBtn) sendBtn.setAttribute('disabled', '');
    }
    if (command === 'streaming') {
      const el = document.getElementById('streaming-msg');
      if (el) {
        const bubble = el.querySelector('.bubble');
        if (bubble) bubble.innerHTML = formatContent(text);
        msgs.scrollTop = msgs.scrollHeight;
      }
    }
    if (command === 'restorePrompt') {
      // Bug fix: AI request failed — give the candidate back their prompt so
      // they can retry without retyping. The webview clears the textarea on
      // send; on error we never re-populated it before, which forced a re-type.
      const inp = getInp();
      if (inp && typeof text === 'string') {
        inp.value = text;
        inp.focus();
      }
    }
  });

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatContent(text) {
    const parts = [];
    const fenceRe = /\`\`\`(\\w*)(?: file=([^\\s\`]+))?(\\n|\\r\\n)([\\s\\S]*?)\`\`\`/g;
    let lastIdx = 0;
    let m;
    let blockCounter = 0;
    while ((m = fenceRe.exec(text)) !== null) {
      const pre = text.slice(lastIdx, m.index);
      if (pre) parts.push(renderProse(pre));
      const filePath = m[2] || '';
      const code = m[4];
      const blockId = 'blk-' + (++blockCounter) + '-' + Date.now();
      const encoded = encodeURIComponent(code);
      const canApply = filePath.length > 0;
      parts.push(
        '<div class="code-block">' +
        '<pre><code>' + escHtml(code) + '</code></pre>' +
        '<div class="code-actions">' +
        (canApply
          ? '<button class="code-btn apply-btn" data-apply-block-id="' + escHtml(blockId) + '" data-apply-file="' + escHtml(filePath) + '" data-apply-encoded="' + escHtml(encoded) + '">&#11015; Apply to ' + escHtml(filePath.split('/').pop() || filePath) + '</button>'
          : '<button class="code-btn apply-btn" disabled title="No file path in fence">&#11015; Apply (no file path)</button>') +
        '<button class="code-btn" data-copy-encoded="' + escHtml(encoded) + '">&#8998; Copy</button>' +
        '</div></div>'
      );
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) parts.push(renderProse(text.slice(lastIdx)));
    return parts.join('');
  }

  function renderProse(text) {
    let s = escHtml(text);
    s = s.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    s = s.replace(/\\n/g, '<br>');
    return s;
  }
</script>
</body>
</html>`;
  }
}

export const ACTIVE_FILE_MAX_BYTES = 50 * 1024;

export function buildFileFence(relPath: string, lang: string, text: string): string {
  // Find the longest run of backticks in the content and pick a fence that
  // strictly exceeds it, so files containing ``` don't terminate the block.
  let longestRun = 0;
  const runMatches = text.match(/`+/g) ?? [];
  for (const r of runMatches) {
    if (r.length > longestRun) longestRun = r.length;
  }
  const fenceLen = Math.max(3, longestRun + 1);
  const fence = "`".repeat(fenceLen);
  return (
    `# Current contents of ${relPath} (may include candidate edits since initial repo)\n` +
    fence + lang + "\n" + text + "\n" + fence + "\n\n"
  );
}

function buildActiveFileBlock(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "";
  const doc = editor.document;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!workspaceFolder) return "";
  const text = doc.getText();
  const relPath = vscode.workspace.asRelativePath(doc.uri, false);
  const lang = doc.languageId || "";
  if (Buffer.byteLength(text, "utf8") > ACTIVE_FILE_MAX_BYTES) {
    // Don't drop silently — at least tell the LLM the file is open but too big to inline.
    return `# Active file ${relPath} (omitted — exceeds ${ACTIVE_FILE_MAX_BYTES} bytes)\n\n`;
  }
  return buildFileFence(relPath, lang, text);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatContent(s: string): string {
  let result = escHtml(s);
  result = result.replace(/```[\w]*(?: file=[^\s`]+)?\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  result = result.replace(/\n<pre>/g, "<pre>").replace(/<\/pre>\n/g, "</pre>");
  result = result.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  result = result.replace(/\n/g, "<br>");
  return result;
}
