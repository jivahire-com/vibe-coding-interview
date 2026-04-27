import * as vscode from "vscode";
import { SessionConfig } from "../api";
import { runChecklist, TestChecklist } from "./tests";

export class WelcomePanel {
  private static current: WelcomePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private checklist: TestChecklist = { basic: null, thread: null, edge: null };
  private refreshInterval: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private config: SessionConfig,
    private context: vscode.ExtensionContext
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "vibeBrief",
      "Vibe: Challenge Brief",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    this.panel.onDidDispose(() => {
      WelcomePanel.current = undefined;
      this.dispose();
    });
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
    this.refreshInterval = setInterval(() => this.render(), 5000);
  }

  static show(config: SessionConfig, context: vscode.ExtensionContext): void {
    if (WelcomePanel.current) {
      WelcomePanel.current.config = config;
      WelcomePanel.current.panel.reveal();
      WelcomePanel.current.render();
      return;
    }
    WelcomePanel.current = new WelcomePanel(config, context);
  }

  private handleMessage(msg: { command: string }): void {
    switch (msg.command) {
      case "runTests": {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        this.checklist = runChecklist(ws);
        this.render();
        break;
      }
      case "openChat":
        vscode.commands.executeCommand("vibe.chat.focus");
        break;
      case "submit":
        vscode.commands.executeCommand("vibe.submit");
        break;
    }
  }

  private render(): void {
    const remaining = Math.max(
      0,
      this.config.startedAt + this.config.maxMinutes * 60_000 - Date.now()
    );
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    const timeStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    const check = (v: boolean | null) =>
      v === true ? "☑" : v === false ? "☒" : "☐";

    this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .timer { font-size: 1.4em; font-weight: bold; }
  .budget { color: var(--vscode-descriptionForeground); }
  .checklist { margin: 16px 0; }
  .checklist li { list-style: none; margin: 6px 0; font-size: 1.05em; }
  .pass { color: #4caf50; }
  .fail { color: #f44336; }
  .actions { display: flex; gap: 10px; margin-top: 20px; }
  button { padding: 8px 16px; cursor: pointer; background: var(--vscode-button-background);
           color: var(--vscode-button-foreground); border: none; border-radius: 4px; font-size: 0.95em; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 16px 0; }
</style>
</head>
<body>
<div class="header">
  <div>
    <strong>cpp-lru-cache</strong>
    <span class="budget"> · Budget: $${(this.config.llmBudgetUsd).toFixed(2)}</span>
  </div>
  <div class="timer">⏱ ${timeStr}</div>
</div>
<hr>
<p>Deliver a correct, thread-safe, templated LRU cache. See <strong>README.md</strong> for full details.</p>
<div class="checklist">
  <strong>Test checklist</strong>
  <ul>
    <li class="${this.checklist.basic === true ? "pass" : this.checklist.basic === false ? "fail" : ""}">
      ${check(this.checklist.basic)} [basic] — single-threaded correctness
    </li>
    <li class="${this.checklist.thread === true ? "pass" : this.checklist.thread === false ? "fail" : ""}">
      ${check(this.checklist.thread)} [thread] — concurrent get/put
    </li>
    <li class="${this.checklist.edge === true ? "pass" : this.checklist.edge === false ? "fail" : ""}">
      ${check(this.checklist.edge)} [edge] — capacity=0, move-only types
    </li>
  </ul>
</div>
<div class="actions">
  <button onclick="vscode.postMessage({command:'runTests'})">▶ Run tests</button>
  <button onclick="vscode.postMessage({command:'openChat'})">💬 Open chat</button>
  <button onclick="vscode.postMessage({command:'submit'})">✓ Submit</button>
</div>
<script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }
}
