import * as vscode from "vscode";
import { SessionConfig } from "../api";
import { runChecklist, TestChecklist } from "./tests";

export class WelcomePanel {
  private static current: WelcomePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private checklist: TestChecklist = { basic: null, thread: null, edge: null };
  private refreshInterval: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private config: SessionConfig | null,
    private context: vscode.ExtensionContext
  ) {
    const isActive = config !== null;
    this.panel = vscode.window.createWebviewPanel(
      "vibeBrief",
      isActive ? "JivaHire: Challenge Brief" : "JivaHire: Welcome",
      isActive ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
      { enableScripts: true }
    );
    this.panel.onDidDispose(() => {
      WelcomePanel.current = undefined;
      this.dispose();
    });
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.render();
    if (isActive) {
      this.refreshInterval = setInterval(() => this.render(), 5000);
    }
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

  static showOnboarding(context: vscode.ExtensionContext): void {
    if (WelcomePanel.current) {
      WelcomePanel.current.panel.reveal();
      return;
    }
    WelcomePanel.current = new WelcomePanel(null, context);
  }

  private handleMessage(msg: { command: string }): void {
    switch (msg.command) {
      case "startTest":
        vscode.commands.executeCommand("vibe.enterSessionKey");
        break;
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
    this.panel.webview.html = this.config
      ? this.renderBrief()
      : this.renderOnboarding();
  }

  private renderOnboarding(): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>JivaHire Vibe Coding Interview</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    margin: 0; padding: 0;
    font-size: 13px;
    line-height: 1.55;
  }
  .page { max-width: 640px; margin: 0 auto; padding: 28px 24px 52px; }

  /* Hero */
  .hero {
    text-align: center;
    padding: 24px 20px 20px;
    background: var(--vscode-editor-selectionHighlightBackground, rgba(100,100,255,0.06));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    margin-bottom: 24px;
    box-shadow: 0 1px 4px var(--vscode-widget-shadow, rgba(0,0,0,0.12));
  }
  .hero-badge {
    display: inline-block;
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: 20px; padding: 3px 10px; margin-bottom: 12px;
  }
  .hero h1 { font-size: 19px; font-weight: 700; margin: 0 0 6px; }
  .hero p { color: var(--vscode-descriptionForeground); margin: 0; font-size: 12.5px; }

  /* Section headers */
  .section-label {
    font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--vscode-descriptionForeground);
    margin: 20px 0 8px;
  }

  /* Step list */
  .steps { display: flex; flex-direction: column; gap: 1px; }
  .step {
    display: flex; gap: 14px; padding: 10px 12px;
    border-radius: 8px; align-items: flex-start;
    border: 1px solid transparent;
    transition: background 0.1s;
  }
  .step:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-panel-border);
  }
  .step-icon {
    width: 28px; height: 28px; border-radius: 7px; flex-shrink: 0;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; margin-top: 1px;
  }
  .step-title { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .step-desc { font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
  .step-desc strong { color: var(--vscode-foreground); font-weight: 600; }
  .step-desc code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-input-background);
    padding: 1px 5px; border-radius: 3px; font-size: 11px;
  }

  /* Apply-diff tip callout */
  .tip {
    margin: 12px 0;
    padding: 12px 14px;
    border-left: 3px solid var(--vscode-button-background);
    background: var(--vscode-editor-selectionHighlightBackground, rgba(100,100,255,0.05));
    border-radius: 0 7px 7px 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .tip strong { color: var(--vscode-foreground); }
  .tip pre {
    margin: 8px 0 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px;
    padding: 8px 10px;
    white-space: pre;
    overflow-x: auto;
    line-height: 1.5;
  }

  /* What gets recorded */
  .record-list { padding: 0; margin: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
  .record-list li {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 12.5px; color: var(--vscode-descriptionForeground);
    padding: 4px 0;
  }
  .record-icon { flex-shrink: 0; font-size: 13px; margin-top: 1px; }

  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 20px 0; }

  /* CTA */
  .cta {
    text-align: center; margin-top: 8px; padding: 22px 20px;
    background: var(--vscode-editor-selectionHighlightBackground, rgba(100,100,255,0.04));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    box-shadow: 0 1px 4px var(--vscode-widget-shadow, rgba(0,0,0,0.1));
  }
  .cta p { color: var(--vscode-descriptionForeground); font-size: 12.5px; margin: 0 0 14px; }
  .btn-start {
    padding: 11px 36px; font-size: 14px; font-weight: 700;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 8px; font-family: inherit;
    letter-spacing: 0.01em;
  }
  .btn-start:hover { background: var(--vscode-button-hoverBackground); }
  .btn-start:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
</style>
</head>
<body>
<div class="page">
  <div class="hero">
    <div class="hero-badge">JivaHire Vibe Coding Interview</div>
    <h1>Welcome to Your Technical Challenge</h1>
    <p>A timed, AI-assisted coding challenge. Read this guide carefully before starting.</p>
  </div>

  <div class="section-label">How It Works</div>
  <div class="steps">
    <div class="step">
      <div class="step-icon">🔑</div>
      <div class="step-body">
        <div class="step-title">Enter Your Session Key</div>
        <div class="step-desc">Click <strong>Start Test</strong> below and enter the session key provided by your recruiter. This validates your access and fetches your workspace configuration.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-icon">⬇</div>
      <div class="step-body">
        <div class="step-title">Workspace Clones Automatically</div>
        <div class="step-desc">VS Code automatically clones your private challenge repository and reopens in that workspace. <strong>You don't need to do anything</strong> — after a few seconds you'll land directly in the challenge folder with <code>README.md</code> ready to read.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-icon">📖</div>
      <div class="step-body">
        <div class="step-title">Read the Challenge</div>
        <div class="step-desc">Open <strong>README.md</strong> first. It contains the full problem statement, constraints, and build instructions. The starter code has intentional bugs and gaps — your job is to find and fix them. Plan before you code.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-icon">🤖</div>
      <div class="step-body">
        <div class="step-title">Use the AI Chat Sidebar (GPT-4o-mini)</div>
        <div class="step-desc">Click the <strong>JivaHire AI</strong> icon in the left activity bar to open the AI chat. Ask the LLM for help, explanations, or code suggestions. You have a fixed dollar budget — use it wisely. <strong>Your prompts are evaluated as part of grading.</strong></div>
      </div>
    </div>
  </div>

  <div class="tip">
    <strong>✨ Apply AI code directly to files</strong> — When the AI returns a code block, you'll see an <strong>[Apply]</strong> button. Click it to open a diff view (red = removed, green = added) and accept the change with one click. If no file can be inferred, use <strong>[Copy]</strong> and paste manually.
    <pre>AI response  ───────────────────────
 \`\`\`cpp file=include/lru_cache.hpp
 class LruCache { ... }
 \`\`\`
 [Apply]  [Copy]

Click Apply  ──▶  Diff editor opens
 Current file  │  AI suggestion
 ──────────────┼─────────────────
 - old_line    │ + new_line
               │
 [✓ Accept]  [✗ Reject]</pre>
  </div>

  <div class="steps" style="margin-top:4px;">
    <div class="step">
      <div class="step-icon">🧪</div>
      <div class="step-body">
        <div class="step-title">Run Tests &amp; Iterate</div>
        <div class="step-desc">Use the <strong>Run Tests</strong> button in the Challenge Brief panel (opens automatically after cloning). Fix failures, refine with the AI, repeat. Green = passing, red = failing.</div>
      </div>
    </div>
    <div class="step">
      <div class="step-icon">🚀</div>
      <div class="step-body">
        <div class="step-title">Submit When Ready</div>
        <div class="step-desc">Click <strong>Submit</strong> in the Challenge Brief. If the timer expires, your work is auto-submitted. Don't wait for the last second — submit early if you're done.</div>
      </div>
    </div>
  </div>

  <hr>

  <div class="section-label">What Gets Recorded</div>
  <ul class="record-list">
    <li><span class="record-icon">⌨</span>Typed vs pasted vs AI-applied character counts — the ratio matters for grading.</li>
    <li><span class="record-icon">💬</span>All AI chat exchanges (<code>.jivahire_chat_log.json</code>) committed to your branch, including prompt quality analysis.</li>
    <li><span class="record-icon">🔢</span>Token usage per chat turn: input, output, cached, and reasoning tokens.</li>
    <li><span class="record-icon">📸</span>Automatic code snapshots committed every 3 minutes — creates a tamper-evident timeline.</li>
    <li><span class="record-icon">✅</span>Test run results and final submission timestamp.</li>
  </ul>

  <div class="cta">
    <p>Ready? Enter your session key to begin. The timer starts once your session is validated.</p>
    <button class="btn-start" onclick="vscode.postMessage({command:'startTest'})">Start Test →</button>
  </div>
</div>
<script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }

  private renderBrief(): string {
    const config = this.config!;
    const remaining = Math.max(
      0,
      config.startedAt + config.maxMinutes * 60_000 - Date.now()
    );
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    const timeStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    const timerColor =
      remaining < 2 * 60_000
        ? "var(--vscode-errorForeground, #f44336)"
        : remaining < 10 * 60_000
        ? "#e8c000"
        : "var(--vscode-foreground)";
    const timerBg =
      remaining < 2 * 60_000
        ? "var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.1))"
        : remaining < 10 * 60_000
        ? "rgba(232,192,0,0.1)"
        : "var(--vscode-input-background)";

    const checkItem = (label: string, tag: string, state: boolean | null) => {
      const cls = state === true ? "pass" : state === false ? "fail" : "pending";
      const icon = state === true ? "✓" : state === false ? "✗" : "○";
      return `<div class="check-item ${cls}">
        <span class="check-icon">${icon}</span>
        <span class="check-label">${label}</span>
        <span class="check-tag">${tag}</span>
      </div>`;
    };

    const modelLabel = config.chatModel
      ? config.chatModel.replace(/^openai\//, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "GPT-4o-mini";

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>JivaHire: Challenge Brief</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    margin: 0; padding: 18px;
    font-size: 13px; line-height: 1.5;
  }
  .header {
    display: flex; justify-content: space-between;
    align-items: flex-start; margin-bottom: 12px; gap: 12px;
  }
  .challenge-name { font-size: 15px; font-weight: 700; margin: 0 0 5px; }
  .meta { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; color: var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px; padding: 2px 8px;
  }
  .timer {
    font-size: 22px; font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: ${timerColor};
    background: ${timerBg};
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; padding: 6px 12px; white-space: nowrap;
    flex-shrink: 0;
  }
  .desc {
    font-size: 12.5px; color: var(--vscode-descriptionForeground);
    margin: 0 0 14px; line-height: 1.55; padding: 10px 12px;
    background: var(--vscode-input-background);
    border-left: 3px solid var(--vscode-button-background);
    border-radius: 0 6px 6px 0;
  }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 14px 0; }
  .section-title {
    font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); margin-bottom: 8px;
  }
  .check-item {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 10px; border-radius: 6px; margin-bottom: 4px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border); font-size: 12.5px;
  }
  .check-icon { font-size: 13px; flex-shrink: 0; width: 16px; text-align: center; }
  .check-label { flex: 1; }
  .check-tag { font-size: 11px; color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace); }
  .pass .check-icon { color: #4caf50; }
  .fail .check-icon { color: #f44336; }
  .pending .check-icon { color: var(--vscode-descriptionForeground); }
  .actions { display: flex; flex-direction: column; gap: 7px; margin-top: 18px; }
  .btn {
    padding: 9px 14px; cursor: pointer; border: none; border-radius: 7px;
    font-size: 12.5px; font-weight: 500; font-family: inherit;
    text-align: left; display: flex; align-items: center; gap: 8px;
  }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
  }
  .btn-danger {
    background: var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.12));
    color: var(--vscode-errorForeground, #f48771);
    border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(244,67,54,0.4));
  }
  .model-pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11px; padding: 2px 9px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    color: var(--vscode-descriptionForeground);
  }
  .model-pill span { color: var(--vscode-foreground); font-weight: 600; }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="challenge-name">${config.challengeId}</div>
    <div class="meta">
      <span class="badge">💰 Budget: $${config.llmBudgetUsd.toFixed(2)}</span>
      <span class="model-pill">Model: <span>${modelLabel}</span></span>
    </div>
  </div>
  <div class="timer">⏱ ${timeStr}</div>
</div>
<p class="desc">Deliver a correct, thread-safe, templated LRU cache. See <strong>README.md</strong> for the full spec and build instructions.</p>
<hr>
<div class="section-title">Test Checklist</div>
${checkItem("Single-threaded correctness", "[basic]", this.checklist.basic)}
${checkItem("Concurrent get/put", "[thread]", this.checklist.thread)}
${checkItem("Capacity edge cases", "[edge]", this.checklist.edge)}
<div class="actions">
  <button class="btn btn-primary" onclick="vscode.postMessage({command:'runTests'})">▶ Run Tests</button>
  <button class="btn btn-secondary" onclick="vscode.postMessage({command:'openChat'})">💬 Open AI Chat</button>
  <button class="btn btn-danger" onclick="vscode.postMessage({command:'submit'})">✓ Submit Solution</button>
</div>
<script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }
}
