import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import { SessionConfig } from "../api";
import { ChatLog } from "./chatlog";
import { applyCodeBlock } from "./apply";

interface Message {
  role: "user" | "assistant";
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  latencyMs?: number;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messages: Message[] = [];
  private chatLog?: ChatLog;
  private config?: SessionConfig;
  private isLoading = false;
  private streamingText = "";
  private spentUsd = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setConfig(config: SessionConfig): void {
    this.config = config;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    this.chatLog = new ChatLog(ws);
    this.render();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
  }

  private handleMessage(msg: { command: string; text?: string; filePath?: string; codeText?: string; blockId?: string }): void {
    if (msg.command === "send" && msg.text && this.config && !this.isLoading) {
      this.send(msg.text, this.config);
    }
    if (msg.command === "applyBlock" && msg.filePath && msg.codeText && msg.blockId) {
      applyCodeBlock(msg.filePath, msg.codeText, msg.blockId);
    }
    if (msg.command === "copyText" && msg.text) {
      vscode.env.clipboard.writeText(msg.text);
    }
  }

  private async send(userText: string, config: SessionConfig): Promise<void> {
    this.messages.push({ role: "user", content: userText });
    this.isLoading = true;
    this.streamingText = "";
    this.render();

    const start = Date.now();
    let assistantText = "";
    let budgetExhausted = false;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    try {
      await this.streamChat(config, this.messages, (chunk) => {
        if (chunk.error) { budgetExhausted = true; return; }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          assistantText += delta;
          this.streamingText = assistantText;
          this.view?.webview.postMessage({ command: "streaming", text: assistantText });
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
          cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
      });
    } catch (e: any) {
      assistantText = `Error: ${e.message}`;
    }

    const latencyMs = Date.now() - start;
    this.isLoading = false;
    this.streamingText = "";
    this.messages.push({
      role: "assistant",
      content: assistantText,
      promptTokens,
      completionTokens,
      cachedTokens,
      latencyMs,
    });

    // Track approximate spend locally for the budget meter
    const inputCost = (promptTokens / 1_000_000) * 0.15;
    const outputCost = (completionTokens / 1_000_000) * 0.60;
    this.spentUsd += inputCost + outputCost;

    this.chatLog?.append({
      timestamp: Date.now(),
      prompt_text: userText,
      response_text: assistantText,
      model_used: config.chatModel ?? "gpt-4o-mini",
      prompt_tokens: promptTokens,
      response_tokens: completionTokens,
      response_latency_ms: latencyMs,
      topic_hint: "",
      correction_loop: false,
    });

    if (budgetExhausted) {
      this.view?.webview.postMessage({ command: "budgetExhausted" });
    }
    this.render();
  }

  private streamChat(
    config: SessionConfig,
    messages: Message[],
    onChunk: (chunk: any) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));
      const body = JSON.stringify({ messages: apiMessages });
      const url = new URL(`${config.llmProxyUrl}/api/v1/llm/chat/completions`);
      const lib = url.protocol === "https:" ? https : http;
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
          let buf = "";
          res.on("data", (d: Buffer) => {
            buf += d.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") { resolve(); return; }
              try { onChunk(JSON.parse(payload)); } catch {}
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  private render(): void {
    if (!this.view) return;
    const noSession = !this.config;
    const config = this.config;

    const modelLabel = config?.chatModel
      ? config.chatModel.replace(/^openai\//, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "GPT-4o-mini";

    const budgetUsd = config?.llmBudgetUsd ?? 2.00;
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
        return `<div class="msg assistant" id="msg-${i}">
          <div class="msg-header">
            <span class="role-label-ai">${modelLabel}</span>
            ${tokenInfo}
            <button class="icon-btn" onclick="copyMsg(${i})" title="Copy response">⎘</button>
          </div>
          <div class="bubble ai-bubble">${formatted}</div>
        </div>`;
      })
      .join("");

    if (this.isLoading) {
      if (this.streamingText) {
        msgHtml += `<div class="msg assistant" id="streaming-msg">
          <div class="msg-header"><span class="role-label-ai">${modelLabel}</span></div>
          <div class="bubble ai-bubble">${formatContent(this.streamingText)}</div>
          <div class="shimmer-bar"></div>
        </div>`;
      } else {
        msgHtml += `<div class="msg assistant" id="streaming-msg">
          <div class="msg-header"><span class="role-label-ai">${modelLabel}</span></div>
          <div class="bubble ai-bubble loading-bubble">
            <div class="typing"><span></span><span></span><span></span></div>
          </div>
        </div>`;
      }
    }

    const disabled = noSession || this.isLoading ? "disabled" : "";
    const placeholder = noSession
      ? "Session not active"
      : this.isLoading
      ? "Generating…"
      : "Ask anything… (Enter to send, Shift+Enter for newline)";

    const exampleChips = noSession ? "" : `
      <div class="chips">
        <button class="chip" onclick="useChip('Explain the LRU cache data structure and the O(1) requirement')">Explain LRU O(1)</button>
        <button class="chip" onclick="useChip('What thread-safety issues should I look for in the starter code?')">Thread safety issues</button>
        <button class="chip" onclick="useChip('My put() is failing the [thread] test — here is my implementation:')">Debug thread test</button>
      </div>`;

    // Serialize message content for JS (needed for copy)
    const msgContents = JSON.stringify(
      this.messages.map((m) => m.content)
    );

    this.view.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    display: flex;
    flex-direction: column;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    color: var(--vscode-foreground);
  }

  /* ── Top strip: model + budget ───────────────────── */
  #top-strip {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px 5px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    flex-shrink: 0; gap: 8px;
  }
  .model-pill {
    font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }
  .model-pill span { color: var(--vscode-foreground); }
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

  /* ── Message list ────────────────────────────────── */
  #msgs {
    flex: 1; overflow-y: auto;
    padding: 10px 10px 6px;
    display: flex; flex-direction: column; gap: 12px;
  }
  .empty-state {
    color: var(--vscode-descriptionForeground);
    text-align: center; padding: 20px 14px 8px; font-size: 12px; line-height: 1.55;
  }
  .chips {
    display: flex; flex-direction: column; gap: 5px; margin-top: 10px;
  }
  .chip {
    padding: 6px 10px; font-size: 11.5px; text-align: left; cursor: pointer;
    background: var(--vscode-input-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; font-family: inherit;
  }
  .chip:hover { background: var(--vscode-list-hoverBackground); }

  /* ── Messages ────────────────────────────────────── */
  .msg { display: flex; flex-direction: column; gap: 3px; }
  .msg.user { align-items: flex-end; }
  .msg.assistant { align-items: flex-start; }

  .role-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground); padding: 0 3px;
  }
  .msg-header {
    display: flex; align-items: center; gap: 6px; padding: 0 3px;
    flex-wrap: wrap;
  }
  .role-label-ai {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vscode-button-background);
  }
  .token-info {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .icon-btn {
    background: none; border: none; cursor: pointer; padding: 1px 4px;
    color: var(--vscode-descriptionForeground); font-size: 12px;
    border-radius: 3px; font-family: inherit;
  }
  .icon-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }

  .bubble {
    max-width: 96%; padding: 8px 11px; border-radius: 10px;
    line-height: 1.55; word-break: break-word;
  }
  .user-bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 3px;
    white-space: pre-wrap;
  }
  .ai-bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    border-bottom-left-radius: 3px;
    white-space: normal;
    width: 100%;
  }
  .ai-bubble p { margin: 0 0 6px; }
  .ai-bubble p:last-child { margin: 0; }

  /* Code blocks */
  .code-block { margin: 8px 0 4px; }
  .code-block pre {
    margin: 0;
    padding: 10px;
    background: rgba(0,0,0,0.2);
    border: 1px solid var(--vscode-panel-border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px;
    white-space: pre;
    line-height: 1.4;
  }
  .code-actions {
    display: flex; gap: 0;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 0 0 6px 6px;
    overflow: hidden;
  }
  .code-btn {
    flex: 1; padding: 4px 0; cursor: pointer; border: none;
    font-size: 11px; font-weight: 500; font-family: inherit;
    background: var(--vscode-input-background);
    color: var(--vscode-descriptionForeground);
  }
  .code-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .code-btn + .code-btn { border-left: 1px solid var(--vscode-panel-border); }
  .code-btn.apply-btn { color: var(--vscode-button-background); }
  .code-btn.apply-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Inline code */
  .ai-bubble code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: rgba(0,0,0,0.15);
    padding: 1px 4px; border-radius: 3px; font-size: 11.5px;
  }

  /* Streaming shimmer */
  .shimmer-bar {
    height: 2px; border-radius: 1px; margin-top: 4px; width: 100%;
    background: linear-gradient(90deg,
      var(--vscode-panel-border) 0%,
      var(--vscode-button-background) 50%,
      var(--vscode-panel-border) 100%);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* Typing dots (initial state) */
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

  /* Budget exhausted banner */
  #budget-warn {
    display: none;
    background: var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.1));
    color: var(--vscode-errorForeground, #f48771);
    border-top: 1px solid var(--vscode-inputValidation-errorBorder, rgba(244,67,54,0.3));
    padding: 7px 10px; font-size: 12px; text-align: center; flex-shrink: 0;
  }

  /* Input row */
  #input-row {
    display: flex; gap: 6px; padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    flex-shrink: 0;
  }
  #inp {
    flex: 1; resize: none; height: 36px; min-height: 36px; max-height: 120px;
    font-family: inherit; font-size: 13px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
    border-radius: 6px; padding: 7px 10px; line-height: 1.4;
    outline: none; overflow-y: auto;
  }
  #inp:focus { border-color: var(--vscode-focusBorder); }
  #inp:disabled { opacity: 0.45; cursor: not-allowed; }
  #send-btn {
    padding: 0 14px; height: 36px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; cursor: pointer;
    font-size: 13px; font-weight: 600; font-family: inherit;
    white-space: nowrap; flex-shrink: 0; align-self: flex-end;
  }
  #send-btn:hover { background: var(--vscode-button-hoverBackground); }
  #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
</head>
<body>
<div id="top-strip">
  <div class="model-pill">Model: <span>${modelLabel}</span></div>
  ${config ? `<div class="budget-meter">
    <div class="budget-bar-track"><div class="budget-bar-fill"></div></div>
    <div class="budget-label">$${this.spentUsd.toFixed(3)} / $${budgetUsd.toFixed(2)}</div>
  </div>` : ""}
</div>
<div id="msgs">
  ${noSession
    ? '<div class="empty-state">Enter your session key to activate AI Chat.</div>'
    : (msgHtml || `<div class="empty-state">
        <div style="font-size:20px;margin-bottom:8px;">🤖</div>
        <div style="font-weight:600;margin-bottom:4px;">Ask the AI anything about your challenge</div>
        <div style="font-size:11.5px;margin-bottom:12px;color:inherit;opacity:0.8;">Better prompts = better grade. Try to be specific.</div>
        ${exampleChips}
      </div>`)}
</div>
<div id="budget-warn">AI budget reached — finish the challenge on your own.</div>
<div id="input-row">
  <textarea id="inp"
    placeholder="${placeholder}"
    ${disabled}
    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}"></textarea>
  <button id="send-btn" onclick="send()" ${disabled}>↑</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const msgs = document.getElementById('msgs');
  const inp = document.getElementById('inp');
  const msgContents = ${msgContents};

  // Restore scroll
  msgs.scrollTop = msgs.scrollHeight;

  if (inp) {
    inp.addEventListener('input', function() {
      this.style.height = '36px';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }

  function send() {
    if (!inp || inp.disabled) return;
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    inp.style.height = '36px';
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
    if (!inp || inp.disabled) return;
    inp.value = text;
    inp.dispatchEvent(new Event('input'));
    inp.focus();
  }

  window.addEventListener('message', e => {
    const { command, text } = e.data;
    if (command === 'budgetExhausted') {
      document.getElementById('budget-warn').style.display = 'block';
      if (inp) inp.disabled = true;
      const sendBtn = document.getElementById('send-btn');
      if (sendBtn) sendBtn.disabled = true;
    }
    if (command === 'streaming') {
      const el = document.getElementById('streaming-msg');
      if (el) {
        const bubble = el.querySelector('.bubble');
        if (bubble) bubble.innerHTML = formatContent(text);
        msgs.scrollTop = msgs.scrollHeight;
      }
    }
  });

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatContent(text) {
    // Parse fenced code blocks with optional file= hint
    const parts = [];
    let remaining = text;
    const fenceRe = /\`\`\`(\\w*)(?: file=([^\\s\`]+))?(\\n|\\r\\n)([\\s\\S]*?)\`\`\`/g;
    let lastIdx = 0;
    let m;
    let blockCounter = 0;
    while ((m = fenceRe.exec(text)) !== null) {
      const pre = text.slice(lastIdx, m.index);
      if (pre) parts.push(renderProse(pre));
      const lang = m[1] || '';
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
          ? '<button class="code-btn apply-btn" onclick="applyBlock(' + JSON.stringify(blockId) + ',' + JSON.stringify(filePath) + ',' + JSON.stringify(encoded) + ')">⬇ Apply to ' + escHtml(filePath.split('/').pop() || filePath) + '</button>'
          : '<button class="code-btn apply-btn" disabled title="No file path in fence — copy and paste manually">⬇ Apply (no file path)</button>') +
        '<button class="code-btn" onclick="copyBlock(' + JSON.stringify(encoded) + ')">⎘ Copy</button>' +
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
