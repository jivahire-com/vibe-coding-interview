import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { SessionConfig, DEFAULT_MODEL_PRICING, ModelPricing } from "../api";
import { applyCodeBlock } from "./apply";
import { Timer, TimerTick } from "../timer";

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

/**
 * Drilled into every chat request. The Apply button in the chat UI is
 * disabled for code blocks without `file=path`, so an answer that omits it
 * is functionally useless to the candidate — they can only copy/paste. This
 * prompt makes the rule explicit so the LLM consistently emits applyable
 * suggestions.
 */
export const SYSTEM_PROMPT = [
  "MANDATORY: every code block you emit MUST declare its target file in the fence header. No exceptions.",
  "",
  "Use this exact syntax for EVERY fenced code block — long files, short snippets, single-line edits, examples:",
  "",
  "```<language> file=<relative/path/to/file.ext>",
  "<code>",
  "```",
  "",
  "Rules (these are hard requirements, not suggestions):",
  "- file= is REQUIRED on every ``` fence. A code block without file= is invalid output.",
  "- The file path is RELATIVE to the workspace root (e.g. `file=src/lru.cpp`, never `file=/abs/path`).",
  "- The Apply button in the candidate's UI is DISABLED for code blocks that omit file=, so any answer without it leaves the candidate unable to apply your suggestion.",
  "- If the candidate's question references a specific file, use that file. Otherwise pick the most likely target based on the conversation and explicitly state your choice.",
  "- If you genuinely don't know which file the code belongs in, ASK the candidate first instead of emitting a fence without file=.",
  "- Inline ``code`` (single backticks) is fine for short references and does not need file=.",
  "",
  "The Apply button splices your code block into the target file:",
  "- Provide ONLY the function(s) / method(s) / class(es) you are actually changing — the extension finds each one in the file by its signature line and replaces just that region. Surrounding code (other methods, imports, the rest of the file) is preserved automatically.",
  "- NEVER use placeholders like `// ... rest of file unchanged ...`, `# ... existing code ...`, or `/* etc. */` — they would be applied verbatim and would corrupt the file.",
  "- If you need to rewrite the whole file (e.g. major restructure or the file is empty), emit the complete file content with all imports, classes, and functions intact.",
  "- Keep the signature line of each method/function IDENTICAL to the one already in the file (same name, same parameters) so it anchors correctly.",
].join("\n");

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private messages: Message[] = [];
  private isLoading = false;
  private streamingText = "";
  private spentUsd = 0;
  private config: SessionConfig | undefined;
  private selectedModel: string = "openai/gpt-4o";
  private budgetExhausted = false;
  // Chat-toolbar state — the timer pill, offline banner, and Run tests /
  // Submit / Join call buttons all live in the chat webview now, so the
  // provider owns their state.
  private timerTick: TimerTick = { text: "--:--", secondsLeft: -1, severity: "ok", running: false };
  private offline = false;
  private offlineMessage = "";
  private sessionEnded = false;
  // Workspace-relative paths the candidate has explicitly chosen to attach
  // (via right-click "Add to JivaHire chat" or the chat panel's attach
  // button). Consumed and cleared on the next send. The active editor is
  // NEVER auto-attached — the only file content the LLM sees is what the
  // candidate explicitly attached or referenced with @path in the prompt.
  private pendingAttachments: string[] = [];
  // Cached list of workspace-relative file paths used to power the @-mention
  // autocomplete dropdown in the webview. Refreshed via setConfig() and the
  // file-system watcher; never used to leak file CONTENT to the LLM.
  private workspaceFiles: string[] = [];
  private fileWatcher?: vscode.FileSystemWatcher;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Wires the live countdown into the chat toolbar. Timer ticks are forwarded
   * to the webview each second via postMessage so we don't re-render the whole
   * HTML on every second.
   */
  attachTimer(timer: Timer): void {
    timer.onTick((t) => {
      this.timerTick = t;
      this._view?.webview.postMessage({
        command: "timerTick",
        text: t.text,
        severity: t.severity,
        running: t.running,
      });
    });
  }

  /**
   * Surfaces auto-commit failures inside the chat panel. Originally lived as a
   * status-bar warning; moved here so the candidate sees it next to the rest
   * of the session UI without us touching the status bar at all.
   */
  setOfflineState(offline: boolean, message?: string): void {
    this.offline = offline;
    this.offlineMessage = message ?? "";
    this._view?.webview.postMessage({
      command: "offline",
      offline,
      message: this.offlineMessage,
    });
  }

  /**
   * Disables Run tests / Submit / Join call once the session has ended (submit
   * succeeded or expiry). Re-clicking them post-submit would either no-op or
   * try to push with a cleared session, so the buttons must visibly stop being
   * actionable.
   */
  markEnded(): void {
    this.sessionEnded = true;
    this.render();
  }

  setConfig(config: SessionConfig): void {
    this.config = config;
    this.selectedModel = config.availableChatModels[0] ?? config.chatModel;
    void this.refreshWorkspaceFiles();
    this.render();
  }

  /**
   * Rebuild the cached list of workspace files used by the @-mention
   * autocomplete. Skips heavy/build directories so the dropdown isn't
   * polluted by node_modules / dist contents. Pushes the fresh list to the
   * webview via postMessage so we don't need a full re-render.
   */
  private async refreshWorkspaceFiles(): Promise<void> {
    try {
      const findFiles = (vscode.workspace as { findFiles?: typeof vscode.workspace.findFiles }).findFiles;
      if (typeof findFiles !== "function") return;
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,build,.jivahire,out,.next,target,__pycache__,.venv,venv}/**",
        1000,
      );
      const rels = uris
        .map((u) => vscode.workspace.asRelativePath(u, false))
        .filter((r) => !!r && !r.startsWith(".."))
        .sort((a, b) => {
          const ba = a.split("/").pop()!.toLowerCase();
          const bb = b.split("/").pop()!.toLowerCase();
          if (ba !== bb) return ba < bb ? -1 : 1;
          return a < b ? -1 : 1;
        });
      this.workspaceFiles = rels;
      this._view?.webview.postMessage({ command: "updateWorkspaceFiles", files: rels });
    } catch {
      // Workspace lookup failed (e.g. test env without findFiles) — keep
      // the previous list rather than clearing it.
    }
  }

  /** Test introspection helper. */
  getWorkspaceFiles(): string[] {
    return [...this.workspaceFiles];
  }

  /**
   * Attach a workspace file to the next chat request. Called from the
   * right-click "Add to JivaHire chat" command and the chat panel's attach
   * picker. Silently ignores attempts to attach files outside the workspace
   * — only the workspace folder's tree is ever sent to the LLM.
   */
  attachFile(relPath: string): void {
    if (!relPath) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    if (!_isInsideWorkspace(relPath, ws)) return;
    if (!_fileExists(relPath, ws)) return;
    if (this.pendingAttachments.includes(relPath)) return;
    this.pendingAttachments.push(relPath);
    this.render();
  }

  /** Snapshot of currently-pending attachments (test helper / introspection). */
  getPendingAttachments(): string[] {
    return [...this.pendingAttachments];
  }

  focus(): void {
    this._view?.show(true);
  }

  isVisible(): boolean {
    return this._view?.visible ?? false;
  }

  dispose(): void {
    try { this.fileWatcher?.dispose(); } catch { /* watcher may not have been created */ }
    this.fileWatcher = undefined;
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
    this._setupFileWatcher();
    void this.refreshWorkspaceFiles();
    this.render();
  }

  private _setupFileWatcher(): void {
    if (this.fileWatcher) return;
    try {
      const createWatcher = (vscode.workspace as {
        createFileSystemWatcher?: typeof vscode.workspace.createFileSystemWatcher;
      }).createFileSystemWatcher;
      if (typeof createWatcher !== "function") return;
      const w = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
      w.onDidCreate(() => { void this.refreshWorkspaceFiles(); });
      w.onDidDelete(() => { void this.refreshWorkspaceFiles(); });
      this.fileWatcher = w;
    } catch {
      // Watcher unavailable (e.g. test env). The dropdown still works — it
      // just won't update mid-session when files are added/removed.
    }
  }

  private async handleMessage(msg: { command: string; text?: string; filePath?: string; codeText?: string; blockId?: string; model?: string; lang?: string }): Promise<void> {
    if (msg.command === "submit") {
      vscode.commands.executeCommand("vibe.submit");
      return;
    }
    if (msg.command === "joinMeet") {
      vscode.commands.executeCommand("vibe.joinMeet");
      return;
    }
    if (msg.command === "send" && msg.text && !this.isLoading && this.config) {
      this.send(msg.text, this.config);
    }
    if (msg.command === "applyBlock" && msg.codeText && msg.blockId) {
      let filePath = msg.filePath;
      if (!filePath) {
        // Fallback when the LLM forgot to emit `file=` on its fence: open a
        // workspace file picker so the candidate can pick the target manually.
        // This SHOULD be rare (the system prompt mandates file=) but small
        // models occasionally drop it, and we never want the candidate stuck.
        const picked = await pickWorkspaceFile(
          "AI didn't say which file — pick the file to apply this code to",
        );
        if (!picked) return;
        filePath = picked;
      }
      applyCodeBlock(filePath, msg.codeText, msg.blockId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Apply failed: ${message}`);
      });
    }
    if (msg.command === "copyText" && msg.text) {
      vscode.env.clipboard.writeText(msg.text);
    }
    if (msg.command === "changeModel" && msg.model) {
      this.selectedModel = msg.model;
      // Server enforces per-model budget — let the candidate try the new model.
      if (this.budgetExhausted) {
        this.budgetExhausted = false;
        this.render();
      }
    }
    if (msg.command === "removeAttachment" && msg.filePath) {
      const idx = this.pendingAttachments.indexOf(msg.filePath);
      if (idx >= 0) {
        this.pendingAttachments.splice(idx, 1);
        this.render();
      }
    }
    if (msg.command === "pickAttachment") {
      const rel = await pickWorkspaceFile();
      if (rel) this.attachFile(rel);
    }
  }

  private async send(userText: string, config: SessionConfig): Promise<void> {
    // Capture the model at send time so model switches mid-stream do not
    // misattribute the response.
    const requestModel = this.selectedModel;
    // Resolve attachments BEFORE the optimistic push so a mid-flight retry
    // doesn't double-attach. Explicit attachments + @-mentions are unioned
    // and deduped; @-mentions that don't resolve to a real workspace file
    // are silently dropped (we never send a file the candidate didn't
    // explicitly identify).
    const attachmentPaths = _collectAttachmentPaths(this.pendingAttachments, userText);
    const attachmentBlock = _buildAttachmentsBlock(attachmentPaths);
    this.pendingAttachments = [];
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
      await this.streamChat(config, this.messages, requestModel, attachmentBlock, (chunk) => {
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

    // Bug fix: budget exhaustion is treated as a terminal error for THIS
    // request. The proxy emitted an `error` chunk before any content arrived
    // (or partway through), so we must NOT pollute the audit trail with a
    // phantom assistant turn that contains an empty / truncated response.
    if (budgetExhausted) {
      this.budgetExhausted = true;
      // Drop the optimistic user message so the visible history matches what
      // was actually exchanged (no response = no logged turn).
      if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === "user") {
        this.messages.pop();
      }
      vscode.window.showWarningMessage(
        "AI budget exhausted — finish the challenge on your own.",
      );
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

    // Bug fix: the pricing table used to be hard-coded here, so any model the
    // server added (Anthropic, Gemini, …) silently fell through to GPT-4o
    // rates. Prefer server-supplied pricing (config.pricingPerMillion);
    // fall back to the bundled defaults; only then to the GPT-4o estimate.
    const _p = _resolvePricing(requestModel, config.pricingPerMillion);
    const billablePromptTokens = Math.max(0, promptTokens - cachedTokens);
    const inputCost  = (billablePromptTokens / 1_000_000) * _p.input;
    const outputCost = (completionTokens     / 1_000_000) * _p.output;
    this.spentUsd += inputCost + outputCost;

    this.render();
  }

  private streamChat(
    config: SessionConfig,
    messages: Message[],
    model: string,
    attachmentBlock: string,
    onChunk: (chunk: any) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const apiMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ];
      // ONLY prepend file content the candidate explicitly attached or
      // @-referenced. No automatic active-editor capture happens here.
      if (attachmentBlock) {
        for (let i = apiMessages.length - 1; i >= 0; i--) {
          if (apiMessages[i].role === "user") {
            apiMessages[i] = { role: "user", content: attachmentBlock + apiMessages[i].content };
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
              done(new Error(_chatErrorMessage(status, errBody)));
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
              try {
                onChunk(JSON.parse(payload));
              } catch (parseErr) {
                // Bug fix: malformed SSE chunks used to be swallowed silently,
                // which made it impossible to tell why a usage chunk was
                // missing or why streaming stalled. Log to the extension host
                // console so devs see it without hitting the candidate UI.
                console.warn("[ChatView] dropped malformed SSE chunk:", payload, parseErr);
              }
            }
          });
          res.on("end", () => done());
          res.on("error", (e) => done(e));
        }
      );
      req.on("error", (e) => done(e));
      req.setTimeout(STREAM_TIMEOUT_MS, () => {
        done(new Error(_chatErrorMessage(408, "")));
      });
      req.write(body);
      req.end();
    });
  }

  private render(): void {
    if (!this._view || !this.config) return;

    const config = this.config;

    const prettyModel = (m: string | undefined): string =>
      // Strip the OpenRouter/provider prefix so the picker shows compact labels
      // ("Gpt 4o", "Claude Opus 4.6", "Claude Haiku 4.5", …) instead
      // of the fully qualified `<provider>/<model>` ids the API takes.
      (m ?? "openai/gpt-4o")
        .replace(/^(?:openai|google|anthropic|meta-llama|mistralai|deepseek)\//, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    const currentModelLabel = prettyModel(this.selectedModel);

    const modelOptions = (config.availableChatModels ?? [config.chatModel]).map((m) => {
      const label = prettyModel(m);
      const selected = m === this.selectedModel ? " selected" : "";
      return `<option value="${escHtml(m)}"${selected}>${escHtml(label)}</option>`;
    }).join("");

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
    const wsFilesJson = JSON.stringify(this.workspaceFiles).replace(/</g, '\\u003c');

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

  #offline-banner {
    display: none;
    background: var(--vscode-inputValidation-warningBackground, rgba(255,140,0,0.15));
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,140,0,0.4));
    padding: 5px 10px; font-size: 11.5px; flex-shrink: 0;
  }
  #offline-banner.visible { display: block; }

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
  #attachments {
    display: flex; flex-wrap: wrap; gap: 4px;
    padding: 6px 10px 0;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    flex-shrink: 0;
  }
  #attachments:empty { display: none; }
  .att-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 4px 2px 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .att-chip-remove {
    cursor: pointer; border: none; background: transparent;
    color: var(--vscode-descriptionForeground); padding: 0 2px;
    font-size: 12px; line-height: 1;
  }
  .att-chip-remove:hover { color: var(--vscode-errorForeground, #f48771); }
  .attach-help {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    padding: 2px 10px 0; flex-shrink: 0;
  }
  .attach-help strong { color: var(--vscode-foreground); font-weight: 600; }

  #suggest-box {
    display: none;
    margin: 4px 10px 0;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    background: var(--vscode-input-background, var(--vscode-editor-background));
    border-radius: 4px;
    max-height: 180px;
    overflow-y: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px;
    flex-shrink: 0;
    box-shadow: 0 4px 10px rgba(0,0,0,0.18);
  }
  #suggest-box.active { display: block; }
  .suggest-item {
    display: flex; align-items: baseline; gap: 8px;
    padding: 4px 10px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.15));
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .suggest-item:last-child { border-bottom: none; }
  .suggest-item:hover { background: var(--vscode-list-hoverBackground); }
  .suggest-item.selected {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  }
  .suggest-item .basename { font-weight: 600; }
  .suggest-item .dir {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    overflow: hidden; text-overflow: ellipsis;
  }
  .suggest-item.empty-hint {
    color: var(--vscode-descriptionForeground); cursor: default; font-style: italic;
  }
</style>
</head>
<body>
<div id="offline-banner" class="${this.offline ? "visible" : ""}">${escHtml(this.offlineMessage || "Auto-save offline — check your network.")}</div>
<div id="top-strip">
  <select id="model-select" class="model-select">${modelOptions}</select>
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
<div id="attachments">${this.pendingAttachments.map((p) => `
  <span class="att-chip" data-attach-path="${escAttr(p)}">&#128206; ${escHtml(p)}<button class="att-chip-remove" data-remove-attach="${escAttr(p)}" title="Remove attachment">&times;</button></span>`).join("")}</div>
<div class="attach-help">Attach files by right-clicking &rarr; "Add to JivaHire chat" or by typing @ to pick a workspace file.</div>
<div id="suggest-box" role="listbox" aria-label="Workspace file suggestions"></div>
<div id="input-row">
  <vscode-button id="attach-btn" appearance="icon" title="Attach a workspace file">&#128206;</vscode-button>
  <vscode-text-area id="inp" placeholder="${this.budgetExhausted ? "AI budget reached" : (this.isLoading ? "Generating…" : "Ask anything… (Enter to send, Shift+Enter for newline)")}" ${(this.isLoading || this.budgetExhausted) ? "disabled" : ""} resize="none" rows="1" style="flex:1"></vscode-text-area>
  <vscode-button id="send-btn" ${(this.isLoading || this.budgetExhausted) ? "disabled" : ""}>&#8593;</vscode-button>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const msgs = document.getElementById('msgs');
  const msgContents = ${msgContents};
  let workspaceFiles = ${wsFilesJson};
  const SUGGEST_LIMIT = 8;
  let suggestState = { active: false, matches: [], idx: 0, query: '' };

  msgs.scrollTop = msgs.scrollHeight;

  function getInp() { return document.getElementById('inp'); }
  function getSendBtn() { return document.getElementById('send-btn'); }
  function getSuggestBox() { return document.getElementById('suggest-box'); }

  function getInpValue() {
    const inp = getInp();
    if (!inp) return '';
    if (typeof inp.value === 'string') return inp.value;
    const shadow = inp.shadowRoot && inp.shadowRoot.querySelector('textarea');
    return shadow ? shadow.value : '';
  }

  function setInpValue(v) {
    const inp = getInp();
    if (!inp) return;
    inp.value = v;
    const shadow = inp.shadowRoot && inp.shadowRoot.querySelector('textarea');
    if (shadow) shadow.value = v;
  }

  // Detect an in-progress @-mention to the LEFT of the caret. Returns
  // { atIdx, caret, query } or null. The @ must follow start-of-string or
  // whitespace so emails like "a@b.com" are not treated as mentions.
  function detectAtMention() {
    const text = getInpValue();
    if (!text) return null;
    const inp = getInp();
    let caret = text.length;
    const shadow = inp && inp.shadowRoot && inp.shadowRoot.querySelector('textarea');
    if (shadow && typeof shadow.selectionStart === 'number') caret = shadow.selectionStart;
    let i = caret - 1;
    let atIdx = -1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@') {
        if (i === 0 || /\\s/.test(text[i - 1])) atIdx = i;
        break;
      }
      if (/\\s/.test(ch)) break;
      i--;
    }
    if (atIdx < 0) return null;
    return { atIdx: atIdx, caret: caret, query: text.slice(atIdx + 1, caret) };
  }

  // Mirrors _filterWorkspaceFiles() in view.ts. Lower score = better match.
  function filterWorkspaceFiles(query) {
    if (!query) return workspaceFiles.slice(0, SUGGEST_LIMIT);
    const q = query.toLowerCase();
    const scored = [];
    for (let i = 0; i < workspaceFiles.length; i++) {
      const f = workspaceFiles[i];
      const lower = f.toLowerCase();
      const slash = lower.lastIndexOf('/');
      const base = slash >= 0 ? lower.slice(slash + 1) : lower;
      let score = -1;
      if (base.startsWith(q)) score = 0;
      else if (base.indexOf(q) >= 0) score = 1000 + base.indexOf(q);
      else if (lower.indexOf(q) >= 0) score = 2000 + lower.indexOf(q);
      if (score >= 0) scored.push({ f: f, s: score });
    }
    scored.sort(function(a, b) {
      if (a.s !== b.s) return a.s - b.s;
      return a.f < b.f ? -1 : a.f > b.f ? 1 : 0;
    });
    const out = [];
    for (let i = 0; i < scored.length && i < SUGGEST_LIMIT; i++) out.push(scored[i].f);
    return out;
  }

  function renderSuggestions() {
    const box = getSuggestBox();
    if (!box) return;
    if (!suggestState.active || suggestState.matches.length === 0) {
      if (!(suggestState.active && suggestState.query)) {
        box.classList.remove('active');
        box.innerHTML = '';
      }
      return;
    }
    const html = suggestState.matches.map(function(f, i) {
      const slash = f.lastIndexOf('/');
      const base = slash >= 0 ? f.slice(slash + 1) : f;
      const dir = slash >= 0 ? f.slice(0, slash) : '';
      const selected = i === suggestState.idx ? ' selected' : '';
      return '<div class="suggest-item' + selected + '" role="option" data-suggest-path="' + escHtml(f) + '">' +
        '<span class="basename">' + escHtml(base) + '</span>' +
        (dir ? '<span class="dir">' + escHtml(dir) + '</span>' : '') +
        '</div>';
    }).join('');
    box.innerHTML = html;
    box.classList.add('active');
    const sel = box.querySelector('.suggest-item.selected');
    if (sel && typeof sel.scrollIntoView === 'function') {
      sel.scrollIntoView({ block: 'nearest' });
    }
  }

  function updateSuggestions() {
    const m = detectAtMention();
    if (!m) {
      if (suggestState.active) {
        suggestState = { active: false, matches: [], idx: 0, query: '' };
        renderSuggestions();
        const box = getSuggestBox();
        if (box) { box.classList.remove('active'); box.innerHTML = ''; }
      }
      return;
    }
    const matches = filterWorkspaceFiles(m.query);
    if (matches.length === 0) {
      suggestState = { active: true, matches: [], idx: 0, query: m.query };
      const box = getSuggestBox();
      if (box) {
        box.innerHTML = '<div class="suggest-item empty-hint">No workspace files match "' + escHtml(m.query) + '"</div>';
        box.classList.add('active');
      }
      return;
    }
    suggestState = { active: true, matches: matches, idx: 0, query: m.query };
    renderSuggestions();
  }

  function insertSuggestion(filePath) {
    const m = detectAtMention();
    const text = getInpValue();
    if (!m) {
      setInpValue(text + (text.length === 0 || /\\s$/.test(text) ? '' : ' ') + '@' + filePath + ' ');
    } else {
      const before = text.slice(0, m.atIdx);
      const after = text.slice(m.caret);
      const sep = after.startsWith(' ') ? '' : ' ';
      setInpValue(before + '@' + filePath + sep + after);
    }
    suggestState = { active: false, matches: [], idx: 0, query: '' };
    const box = getSuggestBox();
    if (box) { box.classList.remove('active'); box.innerHTML = ''; }
    const inp = getInp();
    if (inp && typeof inp.focus === 'function') inp.focus();
  }

  document.getElementById('inp').addEventListener('keydown', function(event) {
    if (suggestState.active && suggestState.matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        suggestState.idx = (suggestState.idx + 1) % suggestState.matches.length;
        renderSuggestions();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        suggestState.idx = (suggestState.idx - 1 + suggestState.matches.length) % suggestState.matches.length;
        renderSuggestions();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertSuggestion(suggestState.matches[suggestState.idx]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        suggestState = { active: false, matches: [], idx: 0, query: '' };
        const box = getSuggestBox();
        if (box) { box.classList.remove('active'); box.innerHTML = ''; }
        return;
      }
    } else if (suggestState.active && event.key === 'Escape') {
      event.preventDefault();
      suggestState = { active: false, matches: [], idx: 0, query: '' };
      const box = getSuggestBox();
      if (box) { box.classList.remove('active'); box.innerHTML = ''; }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  document.getElementById('inp').addEventListener('input', updateSuggestions);
  document.getElementById('inp').addEventListener('keyup', function(e) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') return;
    updateSuggestions();
  });
  document.getElementById('inp').addEventListener('blur', function() {
    // Small delay so a click on a suggestion item lands before the dropdown
    // closes. Without this, mousedown→blur→click order kills the click.
    setTimeout(function() {
      suggestState = { active: false, matches: [], idx: 0, query: '' };
      const box = getSuggestBox();
      if (box) { box.classList.remove('active'); box.innerHTML = ''; }
    }, 150);
  });
  document.getElementById('send-btn').addEventListener('click', send);
  const attachBtn = document.getElementById('attach-btn');
  if (attachBtn) {
    attachBtn.addEventListener('click', function() {
      vscode.postMessage({ command: 'pickAttachment' });
    });
  }

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
      if (el.dataset && el.dataset.copyMsg !== undefined) { copyMsg(parseInt(el.dataset.copyMsg, 10), el); return; }
      if (el.dataset && el.dataset.applyBlockId) {
        if (el.hasAttribute && el.hasAttribute('disabled')) return;
        applyBlock(el.dataset.applyBlockId, el.dataset.applyFile, el.dataset.applyEncoded, el.dataset.applyLang, el);
        return;
      }
      if (el.dataset && el.dataset.copyEncoded) { copyBlock(el.dataset.copyEncoded, el); return; }
      if (el.dataset && el.dataset.removeAttach) {
        vscode.postMessage({ command: 'removeAttachment', filePath: el.dataset.removeAttach });
        return;
      }
      if (el.dataset && el.dataset.suggestPath) {
        insertSuggestion(el.dataset.suggestPath);
        return;
      }
      el = el.parentNode;
    }
  });
  // Prevent the textarea from losing focus when the candidate clicks a
  // suggestion item; otherwise the blur handler hides the dropdown before
  // the click registers.
  document.body.addEventListener('mousedown', function(ev) {
    let el = ev.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.suggestPath) { ev.preventDefault(); return; }
      el = el.parentNode;
    }
  });

  // Briefly swap a button's label so the user sees their click registered.
  // Without this feedback, both Copy and Apply look like dead buttons even
  // though the postMessage round-trip succeeded.
  function flashButtonLabel(btn, tempHtml, durationMs) {
    if (!btn || btn.dataset.flashing === '1') return;
    btn.dataset.flashing = '1';
    const originalHtml = btn.innerHTML;
    btn.innerHTML = tempHtml;
    setTimeout(function() {
      btn.innerHTML = originalHtml;
      delete btn.dataset.flashing;
    }, durationMs);
  }

  function send() {
    const inp = getInp();
    if (!inp || inp.hasAttribute('disabled')) return;
    const text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    vscode.postMessage({ command: 'send', text });
  }

  function copyMsg(idx, btn) {
    vscode.postMessage({ command: 'copyText', text: msgContents[idx] || '' });
    flashButtonLabel(btn, '&#10003;', 1500);
  }

  function applyBlock(blockId, filePath, encoded, lang, btn) {
    const codeText = decodeURIComponent(encoded);
    vscode.postMessage({ command: 'applyBlock', blockId, filePath, codeText, lang });
    flashButtonLabel(btn, '&#8987; Opening diff…', 2000);
  }

  function copyBlock(encoded, btn) {
    vscode.postMessage({ command: 'copyText', text: decodeURIComponent(encoded) });
    flashButtonLabel(btn, '&#10003; Copied!', 1500);
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
    if (command === 'offline') {
      const banner = document.getElementById('offline-banner');
      if (banner) {
        if (e.data.offline) {
          banner.textContent = e.data.message || 'Auto-save offline — check your network.';
          banner.classList.add('visible');
        } else {
          banner.classList.remove('visible');
        }
      }
      return;
    }
    if (command === 'updateWorkspaceFiles' && Array.isArray(e.data.files)) {
      workspaceFiles = e.data.files;
      if (suggestState.active) updateSuggestions();
      return;
    }
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
      const lang = m[1] || '';
      const filePath = m[2] || '';
      const code = m[4];
      const blockId = 'blk-' + (++blockCounter) + '-' + Date.now();
      const encoded = encodeURIComponent(code);
      const applyLabel = filePath
        ? '&#11015; Apply to ' + escHtml(filePath.split('/').pop() || filePath)
        : '&#11015; Apply to file… (pick)';
      const applyTitle = filePath
        ? 'Apply this code block to ' + escHtml(filePath)
        : 'AI did not specify a target file — click to pick one from your workspace';
      parts.push(
        '<div class="code-block">' +
        '<pre><code>' + escHtml(code) + '</code></pre>' +
        '<div class="code-actions">' +
        '<button class="code-btn apply-btn" title="' + applyTitle + '" data-apply-block-id="' + escHtml(blockId) + '" data-apply-file="' + escHtml(filePath) + '" data-apply-lang="' + escHtml(lang) + '" data-apply-encoded="' + escHtml(encoded) + '">' + applyLabel + '</button>' +
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

export const ATTACHMENT_MAX_BYTES = 50 * 1024;
// Kept under the previous export name for backwards compatibility with any
// importer; both point to the same byte cap on attached / referenced files.
export const ACTIVE_FILE_MAX_BYTES = ATTACHMENT_MAX_BYTES;

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

/**
 * Extract `@<path>` tokens from a candidate-typed prompt. Returns the raw
 * tokens — caller must validate each against the workspace before sending
 * anything to the LLM.
 *
 * Matches whitespace- or start-of-string preceded `@<non-whitespace>` (so an
 * email like `a@b.com` does NOT trigger a match because the @ is not
 * preceded by whitespace).
 */
export function parseAtMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].replace(/[),.;:!?]+$/, ""); // trim trailing punctuation
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Resolve a list of relative-path candidates (explicit attachments and
 * @-mentions, in order) to a deduped list of workspace-relative paths that
 * actually exist on disk and are confined to the workspace root. Anything
 * that doesn't resolve cleanly is dropped, NOT sent to the LLM.
 */
export function _collectAttachmentPaths(explicit: string[], promptText: string): string[] {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates = [...explicit, ...parseAtMentions(promptText)];
  for (const rel of candidates) {
    if (!rel || seen.has(rel)) continue;
    if (!_isInsideWorkspace(rel, ws)) continue;
    if (!_fileExists(rel, ws)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/**
 * Read each resolved attachment from disk and emit a concatenated string of
 * file fences for the LLM. Files that exceed the byte cap get a one-line
 * marker instead of the body (the LLM is told the file exists but is too
 * large) — never silently dropped, never partially included.
 */
export function _buildAttachmentsBlock(relPaths: string[]): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws || relPaths.length === 0) return "";
  const blocks: string[] = [];
  for (const rel of relPaths) {
    const abs = path.join(ws, rel);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      if (stat.size > ATTACHMENT_MAX_BYTES) {
        blocks.push(`# Attached file ${rel} (omitted — exceeds ${ATTACHMENT_MAX_BYTES} bytes)\n\n`);
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      blocks.push(buildFileFence(rel, _langFromPath(rel), text));
    } catch {
      // Stat / read failure — silently skip. Nothing leaks to the LLM.
    }
  }
  return blocks.join("");
}

function _langFromPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  if (!ext) return "";
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
    ".java": "java", ".kt": "kotlin", ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
    ".cs": "csharp", ".php": "php", ".swift": "swift", ".scala": "scala",
    ".md": "markdown", ".json": "json", ".yml": "yaml", ".yaml": "yaml",
    ".sh": "bash", ".html": "html", ".css": "css", ".sql": "sql",
  };
  return map[ext] ?? ext.slice(1);
}

/**
 * Score a list of workspace-relative file paths against an @-mention query
 * and return the top `limit` matches. Mirrors the same algorithm used inside
 * the webview script so unit tests cover the user-visible behavior.
 *
 * Scoring (lower = better):
 *   0          basename starts with query
 *   1000..     basename contains query (later positions score worse)
 *   2000..     path contains query
 *   no match → dropped
 *
 * Empty query returns the first `limit` files in caller-supplied order
 * (typically already basename-alphabetical so the dropdown is stable).
 */
export function _filterWorkspaceFiles(files: string[], query: string, limit = 8): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  type Scored = { f: string; s: number };
  const scored: Scored[] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const slash = lower.lastIndexOf("/");
    const base = slash >= 0 ? lower.slice(slash + 1) : lower;
    let score = -1;
    if (base.startsWith(q)) score = 0;
    else if (base.indexOf(q) >= 0) score = 1000 + base.indexOf(q);
    else if (lower.indexOf(q) >= 0) score = 2000 + lower.indexOf(q);
    if (score >= 0) scored.push({ f, s: score });
  }
  scored.sort((a, b) => {
    if (a.s !== b.s) return a.s - b.s;
    return a.f < b.f ? -1 : a.f > b.f ? 1 : 0;
  });
  return scored.slice(0, limit).map((x) => x.f);
}

export function _isInsideWorkspace(relPath: string, wsRoot: string): boolean {
  if (path.isAbsolute(relPath)) return false;
  if (relPath.includes("\0")) return false;
  const abs = path.normalize(path.join(wsRoot, relPath));
  const norm = path.normalize(wsRoot);
  if (abs === norm) return false; // refusing to attach the root itself
  const rel = path.relative(norm, abs);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function _fileExists(relPath: string, wsRoot: string): boolean {
  try {
    const abs = path.join(wsRoot, relPath);
    const stat = fs.statSync(abs);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Open a QuickPick of workspace files so the candidate can attach one from
 * the chat panel (paperclip button). Excludes the usual large/build paths.
 */
async function pickWorkspaceFile(placeHolder = "Attach a file to your next chat message"): Promise<string | undefined> {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return undefined;
  }
  const uris = await vscode.workspace.findFiles(
    "**/*",
    "**/{node_modules,.git,dist,build,.jivahire}/**",
    200,
  );
  if (!uris || uris.length === 0) {
    vscode.window.showInformationMessage("No files found in the workspace.");
    return undefined;
  }
  const items: vscode.QuickPickItem[] = uris.map((u) => ({
    label: vscode.workspace.asRelativePath(u, false),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
  });
  return picked?.label;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Escape a string for safe inclusion in an HTML attribute value, including
 * single-quote contexts.
 */
function escAttr(s: string): string {
  return escHtml(s).replace(/'/g, "&#39;");
}

/**
 * Resolve per-million-token pricing for a model, preferring the server-supplied
 * table over bundled defaults. Bug fix: the previous hard-coded table only
 * knew about three OpenAI models; any other model silently fell through to
 * GPT-4o pricing and the candidate's spend meter diverged from the proxy's
 * server-side enforcement.
 */
export function _chatErrorMessage(status: number, _body: string): string {
  if (status === 402) return "AI budget reached — switch models or finish on your own";
  if (status === 408 || status === 504) return "AI service is slow right now — wait a few seconds and retry";
  if (status === 429) return "Too many requests — wait 10s and retry";
  if (status >= 500 && status <= 599) return "AI service is temporarily unavailable — wait and retry";
  return `AI request failed (HTTP ${status}). Contact your recruiter if this persists.`;
}

export function _resolvePricing(
  model: string,
  serverTable: Record<string, ModelPricing> | undefined,
): ModelPricing {
  if (serverTable && serverTable[model]) return serverTable[model];
  if (DEFAULT_MODEL_PRICING[model]) return DEFAULT_MODEL_PRICING[model];
  console.warn(`[ChatView] unknown model "${model}" — falling back to GPT-4o pricing`);
  return { input: 2.5, output: 10.0 };
}

/**
 * Render assistant content to HTML for the persistent message panel. Bug fix:
 * the old impl emitted bare `<pre><code>` which dropped the Apply / Copy
 * buttons that the streaming-side JS formatter produces. Once streaming
 * completed and render() ran, the candidate lost the ability to apply the
 * snippet — they had to copy/paste manually. The buttons here use the same
 * `data-apply-block-id` / `data-copy-encoded` data-attributes that the
 * webview's `document.body` click delegate already listens for.
 */
function formatContent(s: string): string {
  const parts: string[] = [];
  // Match fenced code blocks, optionally with a language and a `file=` hint.
  // Use a unique fence-handler so we can preserve language and file context.
  const fenceRe = /```(\w*)(?: file=([^\s`]+))?\n([\s\S]*?)```/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let blockCounter = 0;
  const renderTs = Date.now();
  while ((m = fenceRe.exec(s)) !== null) {
    const pre = s.slice(lastIdx, m.index);
    if (pre) parts.push(_renderProse(pre));
    const lang = m[1] || "";
    const filePath = m[2] || "";
    const code = m[3];
    const blockId = `blk-rendered-${++blockCounter}-${renderTs}`;
    const encoded = encodeURIComponent(code);
    const applyLabel = filePath
      ? `&#11015; Apply to ${escHtml(filePath.split("/").pop() || filePath)}`
      : "&#11015; Apply to file… (pick)";
    const applyTitle = filePath
      ? `Apply this code block to ${escAttr(filePath)}`
      : "AI did not specify a target file — click to pick one from your workspace";
    parts.push(
      `<div class="code-block">` +
        `<pre><code>${escHtml(code)}</code></pre>` +
        `<div class="code-actions">` +
          `<button class="code-btn apply-btn" ` +
            `title="${applyTitle}" ` +
            `data-apply-block-id="${escAttr(blockId)}" ` +
            `data-apply-file="${escAttr(filePath)}" ` +
            `data-apply-lang="${escAttr(lang)}" ` +
            `data-apply-encoded="${escAttr(encoded)}">${applyLabel}</button>` +
          `<button class="code-btn" data-copy-encoded="${escAttr(encoded)}">&#8998; Copy</button>` +
        `</div>` +
      `</div>`,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < s.length) parts.push(_renderProse(s.slice(lastIdx)));
  return parts.join("");
}

function _renderProse(text: string): string {
  let result = escHtml(text);
  result = result.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  result = result.replace(/\n/g, "<br>");
  return result;
}
