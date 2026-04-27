import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import { SessionConfig } from "../api";
import { ChatLog } from "./chatlog";

interface Message { role: "user" | "assistant"; content: string; }

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private messages: Message[] = [];
  private chatLog?: ChatLog;
  private config?: SessionConfig;

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

  private handleMessage(msg: { command: string; text?: string }): void {
    if (msg.command === "send" && msg.text && this.config) {
      this.send(msg.text, this.config);
    }
  }

  private async send(userText: string, config: SessionConfig): Promise<void> {
    this.messages.push({ role: "user", content: userText });
    this.render();

    const start = Date.now();
    let assistantText = "";
    let budgetExhausted = false;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      await this.streamChat(config, this.messages, (chunk) => {
        if (chunk.error) {
          budgetExhausted = true;
          return;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) { assistantText += delta; this.renderStreaming(assistantText); }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? 0;
          completionTokens = chunk.usage.completion_tokens ?? 0;
        }
      });
    } catch (e: any) {
      assistantText = `Error: ${e.message}`;
    }

    this.messages.push({ role: "assistant", content: assistantText });

    this.chatLog?.append({
      timestamp: Date.now(),
      prompt_text: userText,
      response_text: assistantText,
      model_used: "gpt-4o-mini",
      prompt_tokens: promptTokens,
      response_tokens: completionTokens,
      response_latency_ms: Date.now() - start,
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
      const body = JSON.stringify({ messages });
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
    const msgHtml = this.messages
      .map(
        (m) =>
          `<div class="msg ${m.role}"><strong>${m.role === "user" ? "You" : "AI"}:</strong>
           <pre>${escHtml(m.content)}</pre></div>`
      )
      .join("");

    this.view.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; margin: 0; padding: 8px; }
  #msgs { overflow-y: auto; height: calc(100vh - 80px); }
  .msg { margin: 6px 0; }
  .msg pre { white-space: pre-wrap; word-break: break-word; margin: 2px 0; }
  .user strong { color: var(--vscode-textLink-foreground); }
  .assistant strong { color: var(--vscode-terminal-ansiGreen); }
  #input-row { display: flex; gap: 4px; position: fixed; bottom: 8px; left: 8px; right: 8px; }
  textarea { flex: 1; resize: none; height: 36px; font-family: inherit; font-size: 13px;
             background: var(--vscode-input-background); color: var(--vscode-input-foreground);
             border: 1px solid var(--vscode-input-border); padding: 4px; }
  button { padding: 4px 10px; background: var(--vscode-button-background);
           color: var(--vscode-button-foreground); border: none; cursor: pointer; }
  #budget-warn { color: var(--vscode-errorForeground); text-align: center; padding: 8px; display:none; }
</style>
</head>
<body>
<div id="msgs">${noSession ? "<em>Enter your session key to start.</em>" : msgHtml}</div>
<div id="budget-warn">AI assistance budget reached. Complete the task with your own knowledge.</div>
<div id="input-row">
  <textarea id="inp" placeholder="${noSession ? "Session not active" : "Ask anything…"}"
    ${noSession ? "disabled" : ""}
    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}"></textarea>
  <button onclick="send()" ${noSession ? "disabled" : ""}>Send</button>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function send() {
    const t = document.getElementById('inp');
    const text = t.value.trim();
    if (!text) return;
    t.value = '';
    vscode.postMessage({command:'send', text});
  }
  window.addEventListener('message', e => {
    if (e.data.command === 'budgetExhausted') {
      document.getElementById('budget-warn').style.display = 'block';
      document.getElementById('inp').disabled = true;
      document.querySelector('button').disabled = true;
    }
    if (e.data.command === 'streaming') {
      const el = document.getElementById('streaming');
      if (el) el.textContent = e.data.text;
    }
  });
</script>
</body>
</html>`;
  }

  private renderStreaming(text: string): void {
    this.view?.webview.postMessage({ command: "streaming", text });
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
