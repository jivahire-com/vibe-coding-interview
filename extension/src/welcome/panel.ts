import * as vscode from "vscode";
import * as https from "https";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { SessionConfig } from "../api";

interface PrereqChecks {
  git: boolean | null;
  internet: boolean | null;
}

/** Escape user/server-supplied strings before they are interpolated into HTML. */
export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private config: SessionConfig | null = null;
  private submitted = false;
  private prereqs: PrereqChecks = { git: null, internet: null };
  private refreshInterval: ReturnType<typeof setInterval> | undefined;
  private _prereqRequest: ReturnType<typeof https.request> | undefined;
  private disposed = false;
  // Post-submit video-explainer recording link. Minted by runSubmit() once
  // the server has accepted the submission; surfaced in the dashboard so the
  // candidate can copy/open it in any browser (VS Code webviews can't access
  // camera/microphone, so the browser flow is the only path that works).
  private videoLink: { url: string; expiresUnix: number } | null = null;
  // When the candidate dismisses the "Reopen vs. Start Fresh" dialog at
  // activation, we render the welcome page and must NOT snap back to the
  // brief on subsequent resolveWebviewView calls (which happen whenever the
  // dashboard view re-resolves — e.g., the candidate toggles activity bar
  // views and returns to JivaHire). Reset by setConfig (a fresh session
  // explicitly overrides the dismissal).
  private _dismissed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this._runPrereqChecks();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    // If activate() hasn't called setConfig() yet (timing gap on workspace reload),
    // restore config directly from globalState so we show the session page immediately.
    // If the saved session is expired, drop it now so the welcome page renders
    // instead of leaving the panel stuck on a stale brief.
    if (!this.config && !this._dismissed) {
      const saved = this.context.globalState.get<SessionConfig>("vibe.session");
      if (saved && Date.now() - saved.startedAt <= saved.maxMinutes * 60_000) {
        this.config = saved;
        // setConfig() arms the refresh interval; ensure it is armed on restore too.
        this._armRefresh();
      }
    }
    // Bug fix: ALWAYS write webview.html on resolve. The render() guard further
    // down also covers the !this.view case (early calls from setConfig before
    // resolve), but the failure mode we keep hitting is "panel stuck on the VS
    // Code loading spinner" — that only happens when webview.html was never
    // assigned. Writing it unconditionally here closes that hole.
    this.render();
  }

  /**
   * Drop the current session config and re-render the onboarding/welcome page.
   * Called when the candidate elects to abandon a previously-saved session.
   * Without this the brief HTML stays on screen even after globalState is
   * cleared, because no render() tick is scheduled.
   */
  clearConfig(): void {
    this.config = null;
    this.submitted = false;
    this._stopRefresh();
    this.render();
  }

  reportSessionError(message: string): void {
    this.view?.webview.postMessage({ command: "sessionError", message });
  }

  /** Re-enable the welcome "Begin" form without flagging an error — used when
   *  the candidate dismisses the pre-clone tooling dialog (nothing failed). */
  resetWelcomeEntry(): void {
    this.view?.webview.postMessage({ command: "resetEntry" });
  }

  isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  /**
   * Mark the session as submitted. Stops the refresh interval and re-renders
   * the brief in a read-only state. Without this, the dashboard buttons stay
   * active and the candidate can resubmit / keep using AI budget after the
   * server-side state machine has already advanced to DONE.
   */
  markSubmitted(): void {
    this.submitted = true;
    this._stopRefresh();
    this.render();
  }

  /**
   * Surface the browser-recording link in the dashboard. Called by runSubmit()
   * after the server returns video_upload=true. Camera/mic APIs do not work
   * inside VS Code webviews, so the only working recording path is for the
   * candidate to open this link in a real browser (or on their phone).
   */
  setVideoLink(url: string, expiresUnix: number): void {
    this.videoLink = { url, expiresUnix };
    this.render();
  }

  /**
   * Force the dashboard into the welcome/onboarding state and prevent
   * resolveWebviewView from self-restoring the saved session config.
   * Used when the candidate dismisses the activation-time "Reopen vs.
   * Start Fresh" dialog: the saved session stays in globalState (so the
   * next activation re-prompts), but the UI in this VS Code instance
   * stops pretending the session is active.
   */
  dismiss(): void {
    this._dismissed = true;
    this.clearConfig();
  }

  setConfig(config: SessionConfig): void {
    if (this.disposed) return;
    // An explicit setConfig means "session IS active now" — that overrides
    // any prior in-instance dismissal.
    this._dismissed = false;
    this.config = config;
    // Bug fix: do NOT clobber `submitted` if the session has already advanced
    // to DONE. The state machine is IDLE → ACTIVE → SUBMITTING → DONE — once
    // DONE the dashboard must stay locked even if a stray setConfig fires
    // (e.g. an extension-host reactivation that re-restores the config from
    // globalState before the session is cleared). Callers that genuinely want
    // to reset the dashboard for a brand-new session should call
    // resetForNewSession() instead.
    if (!this.submitted) {
      this._armRefresh();
    }
    this.render();
  }

  /**
   * Explicitly reset the dashboard for a fresh session — clears `submitted`
   * and re-arms the refresh interval. Use this when the candidate enters a
   * new session key after submitting (or when clearConfig() has run).
   */
  resetForNewSession(config: SessionConfig): void {
    if (this.disposed) return;
    this.config = config;
    this.submitted = false;
    this._armRefresh();
    this.render();
  }

  private _armRefresh(): void {
    this._stopRefresh();
    if (this.disposed) return;
    // Tick every second so the countdown decrements one second at a time
    // (the old 5s interval made the timer jump by 5). We deliberately do NOT
    // call render() on each tick — re-assigning webview.html reloads the
    // entire webview, which flickers at 1Hz and would lose focus / scroll
    // state. Instead, post a small 'tick' message and let the brief's
    // inline script patch the timer DOM in-place. render() still fires on
    // state changes (setConfig, markSubmitted) and once more when
    // the session expires to swap to the locked layout.
    this.refreshInterval = setInterval(() => {
      if (this._sessionExpired()) {
        this._stopRefresh();
        this.render();
        return;
      }
      this._postTimerTick();
    }, 1000);
  }

  /**
   * Compute the current timer text + urgency level and post it to the
   * webview. Mirrors the logic in renderBrief() so initial render and
   * subsequent ticks stay in sync. Safe to call when no config is set or
   * the webview hasn't resolved yet — it just no-ops.
   */
  private _postTimerTick(): void {
    if (!this.view || !this.config) return;
    const tick = this._computeTimerView(this.config);
    this.view.webview.postMessage({ command: "tick", ...tick });
  }

  private _computeTimerView(config: SessionConfig): {
    timeStr: string;
    urgent: "critical" | "warn" | "normal";
  } {
    const remaining = Math.max(
      0,
      config.startedAt + config.maxMinutes * 60_000 - Date.now(),
    );
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    const timeStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    const urgent =
      remaining < 2 * 60_000 ? "critical" : remaining < 10 * 60_000 ? "warn" : "normal";
    return { timeStr, urgent };
  }

  private _stopRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private _sessionExpired(): boolean {
    if (!this.config) return false;
    const deadline = this.config.startedAt + this.config.maxMinutes * 60_000;
    return Date.now() >= deadline;
  }

  private _runPrereqChecks(): void {
    try { execSync("git --version", { stdio: "pipe" }); this.prereqs.git = true; }
    catch { this.prereqs.git = false; }

    const finish = (ok: boolean) => {
      if (this.disposed) return;
      this.prereqs.internet = ok;
      this.render();
    };
    const req = https.request(
      { hostname: "api.github.com", path: "/", method: "HEAD", timeout: 4000 },
      (res) => { finish((res.statusCode ?? 0) < 500); }
    );
    this._prereqRequest = req;
    req.on("error", () => finish(false));
    req.on("timeout", () => { req.destroy(); finish(false); });
    req.end();
  }

  private handleMessage(msg: { command: string; sessionKey?: string }): void {
    // Bug fix: post-submit guard used to enumerate the BLOCKED commands, which
    // meant any new command (including "startTest" — which re-enters the
    // session-key prompt) silently bypassed the lock. Invert to an allowlist
    // and enumerate ONLY the commands that remain valid after submission.
    // joinMeet stays available so the candidate can rejoin the panel call
    // during a post-submission debrief with the interviewers. The video-link
    // commands are post-submit by construction — the link only exists after
    // submit — so they must also be on the allowlist.
    const POST_SUBMIT_ALLOWED = new Set<string>([
      "joinMeet",
      "openVideoLink",
      "copyVideoLink",
    ]);
    if (this.submitted && !POST_SUBMIT_ALLOWED.has(msg.command)) {
      vscode.window.showInformationMessage("Session already submitted. Further actions are disabled.");
      return;
    }
    switch (msg.command) {
      case "startTest":
        vscode.commands.executeCommand("vibe.enterSessionKey", msg.sessionKey);
        break;
      case "submit":
        vscode.commands.executeCommand("vibe.submit");
        break;
      case "joinMeet":
        vscode.commands.executeCommand("vibe.joinMeet");
        break;
      case "openVideoLink":
        if (this.videoLink) {
          void vscode.env.openExternal(vscode.Uri.parse(this.videoLink.url));
        }
        break;
      case "copyVideoLink":
        if (this.videoLink) {
          void vscode.env.clipboard.writeText(this.videoLink.url).then(() => {
            vscode.window.showInformationMessage(
              "Recording link copied. Paste it into a browser to record.",
            );
          });
        }
        break;
    }
  }

  private _toolkitUri(): string {
    if (!this.view) return "";
    return this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "toolkit.min.js")
    ).toString();
  }

  private _cspSource(): string {
    return this.view?.webview.cspSource ?? "";
  }

  render(): void {
    if (!this.view) return;
    // Bug fix: render decision must be based on session-config presence, not on
    // whether `workspaceFolders` is populated. When VS Code is reopening the
    // window after a crash/close, `workspaceFolders` is transiently empty —
    // gating on it caused the welcome page to flash even though a valid
    // session was already restored.
    this.view.webview.html = this.config ? this.renderBrief() : this.renderOnboarding();
  }

  /** Generate a cryptographically-random CSP nonce for inline scripts. */
  private _nonce(): string {
    return crypto.randomBytes(16).toString("base64");
  }

  private renderOnboarding(): string {
    const toolkitUri = this._toolkitUri();
    const cspSource = this._cspSource();
    const nonce = this._nonce();

    const prereqRow = (state: boolean | null, label: string, cmd: string) => {
      const icon = state === true
        ? `<span class="prereq-ok">&#10003;</span>`
        : state === false
        ? `<span class="prereq-fail">&#10007;</span>`
        : `<span class="prereq-pending">&#8226;</span>`;
      return `<div class="prereq-row">${icon}<span class="prereq-label">${label}</span><code class="prereq-cmd">${cmd}</code></div>`;
    };

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
<title>JivaHire — Welcome</title>
<script type="module" nonce="${nonce}" src="${toolkitUri}"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    margin: 0; padding: 0;
    font-size: 13px; line-height: 1.6;
  }
  .page { max-width: 620px; margin: 0 auto; padding: 16px 12px 40px; }

  .brand-header {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 16px;
  }
  .brand-logo {
    width: 32px; height: 32px; border-radius: 8px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    display: flex; align-items: center; justify-content: center;
    font-size: 17px; flex-shrink: 0;
  }
  .brand-text { display: flex; flex-direction: column; gap: 1px; }
  .brand-name { font-size: 14px; font-weight: 700; line-height: 1; }
  .brand-sub { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1; }

  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    background: var(--vscode-input-background);
    margin-bottom: 10px;
    overflow: hidden;
  }
  .card-header {
    display: flex; align-items: center; gap: 7px;
    padding: 8px 12px 7px;
    font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
  }
  .card-body { padding: 12px; }

  .session-card {
    border: 1px solid var(--vscode-focusBorder, var(--vscode-button-background));
    border-radius: 8px;
    background: var(--vscode-input-background);
    margin-bottom: 10px;
    overflow: hidden;
    box-shadow: 0 0 0 1px var(--vscode-focusBorder, var(--vscode-button-background)) inset,
                0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.15));
  }
  .session-card-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px 9px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .session-card-header .icon { font-size: 15px; }
  .session-card-header .title { font-size: 13px; font-weight: 700; }
  .session-card-body { padding: 12px; }
  .session-desc {
    font-size: 12px; color: var(--vscode-descriptionForeground);
    margin: 0 0 10px; line-height: 1.5;
  }
  .input-row { display: flex; gap: 6px; align-items: stretch; }
  .session-input {
    flex: 1; min-width: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 6px 9px;
    font-size: 12px; font-family: var(--vscode-font-family);
    outline: none;
    transition: border-color 0.1s;
  }
  .session-input:focus {
    border-color: var(--vscode-focusBorder, var(--vscode-button-background));
    outline: 1px solid var(--vscode-focusBorder, var(--vscode-button-background));
    outline-offset: -1px;
  }
  .session-input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .session-input.error { border-color: var(--vscode-inputValidation-errorBorder, #f44336); }
  .start-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px;
    padding: 6px 13px; font-size: 12px; font-weight: 600;
    font-family: var(--vscode-font-family);
    cursor: pointer; white-space: nowrap;
    transition: opacity 0.1s;
  }
  .start-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .start-btn:disabled { opacity: 0.6; cursor: default; }
  .input-hint {
    margin: 6px 0 0; font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .input-hint kbd {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 1px 4px;
  }

  .prereq-list { display: flex; flex-direction: column; gap: 2px; }
  .prereq-row {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 0; font-size: 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .prereq-row:last-child { border-bottom: none; }
  .prereq-ok   { color: #4caf50; font-size: 13px; width: 15px; text-align: center; flex-shrink: 0; }
  .prereq-fail { color: #f44336; font-size: 13px; width: 15px; text-align: center; flex-shrink: 0; }
  .prereq-pending { color: var(--vscode-descriptionForeground); font-size: 13px; width: 15px; text-align: center; flex-shrink: 0; }
  .prereq-label { flex: 1; }
  .prereq-cmd {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px; color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    padding: 1px 5px; border-radius: 3px;
  }

  .steps-list { display: flex; flex-direction: column; gap: 0; }
  .step {
    display: flex; gap: 10px; padding: 9px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    align-items: flex-start;
  }
  .step:last-child { border-bottom: none; }
  .step-num {
    width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; margin-top: 1px;
  }
  .step-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
  .step-desc { font-size: 11.5px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .step-desc strong { color: var(--vscode-foreground); font-weight: 600; }
  .step-desc code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    padding: 1px 4px; border-radius: 3px; font-size: 10.5px;
  }

  .tip-card {
    border-left: 3px solid var(--vscode-button-background);
    background: var(--vscode-input-background);
    border-radius: 0 6px 6px 0;
    padding: 10px 12px; margin-bottom: 10px;
    border-top: 1px solid var(--vscode-panel-border);
    border-right: 1px solid var(--vscode-panel-border);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .tip-title { font-weight: 600; font-size: 12px; margin-bottom: 5px; }
  .tip-body { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin: 0 0 7px; line-height: 1.5; }
  .tip-body strong { color: var(--vscode-foreground); }
  .tip-pre {
    margin: 0; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px; background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    padding: 7px 9px; white-space: pre; overflow-x: auto; line-height: 1.5;
    color: var(--vscode-foreground);
  }

  .record-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0; }
  .record-list li {
    display: flex; align-items: flex-start; gap: 8px;
    font-size: 11.5px; color: var(--vscode-descriptionForeground);
    padding: 5px 12px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .record-list li:last-child { border-bottom: none; }
  .record-list li::before {
    content: '·'; color: var(--vscode-button-background);
    font-size: 17px; line-height: 1; flex-shrink: 0; margin-top: -2px;
  }
</style>
</head>
<body>
<div class="page">

  <div class="brand-header">
    <div class="brand-logo">&#127381;</div>
    <div class="brand-text">
      <div class="brand-name">JivaHire</div>
      <div class="brand-sub">Technical Interview Platform</div>
    </div>
  </div>

  <div class="session-card">
    <div class="session-card-header">
      <span class="icon">&#128273;</span>
      <span class="title">Enter Your Session ID to Begin</span>
    </div>
    <div class="session-card-body">
      <p class="session-desc">
        Paste the session ID your recruiter sent you. Your challenge workspace
        will clone automatically and the timer will start once validated.
      </p>
      <div class="input-row">
        <input
          id="sessionKeyInput"
          type="text"
          class="session-input"
          placeholder="Session ID — e.g. ABC-123-XYZ"
          autofocus
          autocomplete="off"
          spellcheck="false"
        />
        <button class="start-btn" id="startBtn">
          Begin &#8594;
        </button>
      </div>
      <p class="input-hint">Press <kbd>Enter</kbd> to begin &nbsp;·&nbsp; Contact your recruiter if you don't have a session ID.</p>
    </div>
  </div>

  <div class="card">
    <div class="card-header">&#10004; System Requirements</div>
    <div class="card-body" style="padding:0;">
      <div class="prereq-list">
        ${prereqRow(this.prereqs.git, "Git installed", "git --version")}
        ${prereqRow(this.prereqs.internet, "Internet access", "api.github.com")}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">&#9432; How the Interview Works</div>
    <div class="steps-list">
      <div class="step">
        <div class="step-num">1</div>
        <div>
          <div class="step-title">Enter your session ID above</div>
          <div class="step-desc">VS Code clones your private challenge repo and reopens in that workspace automatically. No manual setup needed.</div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div>
          <div class="step-title">Read <strong>README.md</strong> first</div>
          <div class="step-desc">It contains the full problem statement, constraints, and build instructions. The starter code has intentional bugs and gaps to fix. Plan before you code.</div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div>
          <div class="step-title">Use the AI chat</div>
          <div class="step-desc">Click <strong>Open AI Chat</strong> in the session panel. <strong>Your prompts are evaluated as part of grading.</strong></div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">4</div>
        <div>
          <div class="step-title">Run tests and iterate</div>
          <div class="step-desc">Open a terminal and run the project's test command (e.g. <code>npm test</code>, <code>pytest</code>, <code>ctest</code>). Builds, installs, and test runs are detected automatically and contribute to your developer signal.</div>
        </div>
      </div>
      <div class="step">
        <div class="step-num">5</div>
        <div>
          <div class="step-title">Submit when ready</div>
          <div class="step-desc">Click <strong>Submit</strong> in this panel. Work is auto-submitted when the timer expires — don't wait for the last second.</div>
        </div>
      </div>
    </div>
  </div>

  <div class="tip-card">
    <div class="tip-title">&#9889; Applying AI Code Suggestions</div>
    <p class="tip-body">When the AI returns a code block, click <strong>[Apply]</strong> to open a diff view. Use the <strong>Accept AI changes</strong> / <strong>Reject</strong> CodeLens buttons at the top of the diff.</p>
    <pre class="tip-pre">AI response  ──────────────────────
\`\`\`cpp file=include/lru_cache.hpp
class LruCache { ... }
\`\`\`
[Apply]  [Copy]

Click Apply ──▶ Diff editor opens
&#10003; Accept AI changes   &#10007; Reject   ← CodeLens above diff</pre>
  </div>

  <div class="card">
    <div class="card-header">&#128247; What Gets Recorded</div>
    <ul class="record-list">
      <li>Typed vs pasted vs AI-applied character counts — the ratio matters for grading</li>
      <li>All AI chat exchanges committed to your branch, including prompt quality analysis</li>
      <li>Token usage per turn: input, output, cached, and reasoning tokens</li>
      <li>Automatic code snapshots committed every 3 minutes (tamper-evident timeline)</li>
      <li>Test results and final submission timestamp</li>
    </ul>
  </div>

</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  function startSession() {
    const input = document.getElementById('sessionKeyInput');
    const btn   = document.getElementById('startBtn');
    const key   = input.value.trim();
    if (!key) {
      input.classList.add('error');
      input.focus();
      input.placeholder = 'Please enter your session ID first';
      return;
    }
    btn.textContent = 'Connecting…';
    btn.disabled = true;
    input.disabled = true;
    vscode.postMessage({ command: 'startTest', sessionKey: key });
  }

  document.getElementById('sessionKeyInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { startSession(); }
    else { this.classList.remove('error'); this.placeholder = 'Session ID — e.g. ABC-123-XYZ'; }
  });
  // CSP forbids inline event handlers (script-src has no 'unsafe-inline');
  // wire the Begin button explicitly so a click — not just Enter — works.
  document.getElementById('startBtn').addEventListener('click', startSession);

  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.command === 'sessionError' || msg.command === 'resetEntry') {
      var btn = document.getElementById('startBtn');
      var input = document.getElementById('sessionKeyInput');
      btn.textContent = 'Begin →';
      btn.disabled = false;
      input.disabled = false;
      // Only the error path flags the input red; a plain reset (e.g. the
      // candidate dismissed the tooling dialog) just re-enables the form.
      if (msg.command === 'sessionError') { input.classList.add('error'); }
      input.focus();
      input.select();
    }
  });
</script>
</body>
</html>`;
  }

  private renderBrief(): string {
    const config = this.config!;
    const toolkitUri = this._toolkitUri();
    const cspSource = this._cspSource();
    const nonce = this._nonce();

    const { timeStr, urgent } = this._computeTimerView(config);
    const timerColor =
      urgent === "critical"
        ? "var(--vscode-errorForeground, #f44336)"
        : urgent === "warn"
        ? "#e8c000"
        : "var(--vscode-foreground)";
    const timerBg =
      urgent === "critical"
        ? "var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.1))"
        : urgent === "warn"
        ? "rgba(232,192,0,0.1)"
        : "var(--vscode-input-background)";

    // All values below are interpolated into HTML — every server-supplied
    // string must be HTML-escaped to prevent XSS via challenge metadata.
    const safeChallengeId = escapeHtml(config.challengeId ?? "");
    const safeChallengeDesc = escapeHtml(config.challengeDescription || config.challengeId || "");
    const safeLanguage = escapeHtml(
      config.language && config.language !== "unknown" ? config.language : ""
    );
    const submittedBanner = this.submitted
      ? `<div class="card" style="border-color:#4caf50;"><div class="card-header" style="color:#4caf50;">&#10003; Submitted</div><p class="desc">Session submitted. Grading is in progress — further edits are locked.</p></div>`
      : "";
    const actionDisabled = this.submitted ? "disabled" : "";

    // Panel-interview card: only rendered when the recruiter attached a
    // video-meeting link. The actual URL is never inlined into the HTML —
    // clicking the button posts a message back to the extension host, which
    // opens the URL via vscode.env.openExternal. Avoids any chance of HTML
    // injection from a hostile validate-session response.
    let scheduleLine = "";
    if (config.meetLink && typeof config.scheduledAt === "number") {
      const startMs = config.scheduledAt * 1000;
      const diffMin = Math.round((startMs - Date.now()) / 60_000);
      // Friendly local-time string. toLocaleString uses the candidate's
      // OS timezone, which is what they actually care about.
      const startLocal = escapeHtml(
        new Date(startMs).toLocaleString(undefined, {
          weekday: "short", month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
        }),
      );
      let label: string;
      if (diffMin > 60) {
        label = `Starts ${startLocal} (in ${Math.round(diffMin / 60)}h ${diffMin % 60}m)`;
      } else if (diffMin > 0) {
        label = `Starts in ${diffMin} min &mdash; ${startLocal}`;
      } else if (diffMin > -5) {
        label = `Starting now &mdash; ${startLocal}`;
      } else {
        label = `Scheduled ${startLocal}`;
      }
      scheduleLine = `<p class="desc" style="padding: 0; margin: 0 0 6px; font-weight: 600;">&#128197; ${label}</p>`;
    }

    const meetCard = config.meetLink
      ? `<div class="card" style="border-color: var(--vscode-button-background);">
          <div class="card-header" style="color: var(--vscode-button-foreground); background: var(--vscode-button-background);">
            &#128249; Panel Interview &mdash; Live Video Call
          </div>
          <div style="padding: 10px 11px;">
            ${scheduleLine}
            <p class="desc" style="padding: 0; margin: 0 0 8px;">
              Join the video call below and <strong>share your screen</strong> so the
              interviewer(s) can follow along while you code.
            </p>
            <button class="action-btn primary" data-action="joinMeet" style="margin: 0;">
              <span>&#128249;</span>
              <span class="btn-label">Join video call</span>
              <span class="btn-hint">opens in your browser</span>
            </button>
          </div>
        </div>`
      : "";

    // Upfront notice: warn the candidate before they submit that they will
    // need a webcam + microphone to record a short explainer. Hidden once the
    // recording link is actually live (videoLinkCard takes over) and once the
    // session is submitted (the live link supersedes this notice).
    const endVideoNoticeCard = (config.requireEndVideo && !this.videoLink && !this.submitted)
      ? `<div class="card" style="border-color: #4caf50;">
          <div class="card-header" style="color: #4caf50;">
            &#128247; After you submit: record a short explainer video
          </div>
          <div style="padding: 10px 11px;">
            <p class="desc" style="padding: 0; margin: 0;">
              When you click <strong>Submit</strong>, you'll be asked to record
              a brief solution-explainer video (30s&ndash;5min) in your browser
              &mdash; intro, key decision, one tradeoff. Have a working
              <strong>webcam &amp; microphone</strong> ready before you submit.
              You'll have <strong>10 minutes</strong> after submission to record.
            </p>
          </div>
        </div>`
      : "";

    // Browser-recording link: VS Code webviews cannot access camera/mic, so
    // we surface the link here for the candidate to open in a real browser.
    // The URL is server-supplied — escape before embedding.
    const videoLinkCard = this.videoLink
      ? `<div class="card" style="border-color: #4caf50;">
          <div class="card-header" style="color: #4caf50;">
            &#128247; Required: Record a short solution explainer
          </div>
          <div style="padding: 10px 11px;">
            <p class="desc" style="padding: 0; margin: 0 0 8px;">
              Open this link in <strong>any browser</strong> (Chrome, Edge, Firefox, Safari) or on your phone to record a brief explainer.
              This recording is <strong>required</strong> &mdash; the link expires soon, so use it now.
            </p>
            <input class="video-link-input" type="text" readonly value="${escapeHtml(this.videoLink.url)}" />
            <div style="display: flex; gap: 6px; margin-top: 8px;">
              <button class="action-btn primary" data-action="openVideoLink" style="margin: 0;">
                <span>&#8599;</span>
                <span class="btn-label">Open in browser</span>
              </button>
              <button class="action-btn secondary" data-action="copyVideoLink" style="margin: 0;">
                <span>&#128203;</span>
                <span class="btn-label">Copy link</span>
              </button>
            </div>
          </div>
        </div>`
      : "";

    // Normal coding interview (no AI): make the mode unmistakable on the brief
    // the candidate works from. The onboarding screen is mode-agnostic (the key
    // isn't entered yet), so this is the first place we know AI is off.
    const noAiCard = !config.aiAssistance
      ? `<div class="card" style="border-color:#e8c000;">
          <div class="card-header" style="color:#e8c000;">&#129302; Normal coding interview &mdash; no AI</div>
          <div style="padding:10px 11px;">
            <p class="desc" style="padding:0;margin:0;">
              This is a <strong>normal coding interview</strong>. The AI chat is
              <strong>disabled</strong> &mdash; solve the challenge using only your
              own knowledge and the starter code.
            </p>
          </div>
        </div>`
      : "";

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'nonce-${nonce}'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource};">
<title>JivaHire: Session</title>
<script type="module" nonce="${nonce}" src="${toolkitUri}"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    margin: 0; padding: 12px;
    font-size: 13px; line-height: 1.5;
  }

  .topbar {
    display: flex; align-items: center;
    justify-content: space-between; gap: 10px;
    margin-bottom: 10px;
  }
  .challenge-info { min-width: 0; }
  .challenge-name {
    font-size: 14px; font-weight: 700;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .challenge-lang {
    display: inline-block; margin-top: 3px;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-radius: 4px; padding: 1px 7px;
  }
  .timer-box {
    flex-shrink: 0; text-align: center;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 7px; padding: 6px 11px;
    background: ${timerBg};
  }
  .timer-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em;
    color: ${timerColor}; font-weight: 700; margin-bottom: 2px;
  }
  .timer-value {
    font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: ${timerColor}; line-height: 1;
  }

  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 7px; background: var(--vscode-input-background);
    margin-bottom: 8px; overflow: hidden;
  }
  .card-header {
    padding: 7px 11px;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--vscode-descriptionForeground);
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
  }

  .desc {
    font-size: 12px; color: var(--vscode-descriptionForeground);
    line-height: 1.5; padding: 9px 11px; margin: 0;
  }
  .desc strong { color: var(--vscode-foreground); }

  .actions { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
  .action-btn {
    width: 100%; padding: 8px 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; cursor: pointer;
    font-size: 12.5px; font-family: var(--vscode-font-family);
    font-weight: 600; text-align: left;
    display: flex; align-items: center; gap: 8px;
    transition: background 0.1s;
  }
  .action-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .action-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .action-btn.secondary {
    background: var(--vscode-input-background);
    color: var(--vscode-foreground);
  }
  .action-btn.secondary:hover { background: var(--vscode-list-hoverBackground); }
  .action-btn.danger {
    background: var(--vscode-input-background);
    color: var(--vscode-foreground);
    border-color: var(--vscode-panel-border);
  }
  .action-btn.danger:hover { background: var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.08)); border-color: #f44336; color: #f44336; }
  .btn-label { flex: 1; }
  .btn-hint { font-size: 10.5px; font-weight: 400; opacity: 0.75; }

  .video-link-input {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-editor-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 6px 9px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11.5px;
    outline: none;
  }
  .video-link-input:focus {
    border-color: var(--vscode-focusBorder, var(--vscode-button-background));
  }
</style>
</head>
<body>

  <div class="topbar">
    <div class="challenge-info">
      <div class="challenge-name">${safeChallengeId}</div>
      ${safeLanguage ? `<div class="challenge-lang">${safeLanguage}</div>` : ""}
    </div>
    <div class="timer-box">
      <div class="timer-label">Time left</div>
      <div class="timer-value">${timeStr}</div>
    </div>
  </div>

  ${submittedBanner}

  ${videoLinkCard}

  ${meetCard}

  ${noAiCard}

  <div class="card">
    <div class="card-header">Challenge</div>
    <p class="desc">${safeChallengeDesc}. See <strong>README.md</strong> for the full spec and build instructions. Run tests in your terminal &mdash; runs are detected automatically.</p>
  </div>

  <div class="actions">
    <button class="action-btn danger" data-action="submit" ${actionDisabled}>
      <span>&#10003;</span>
      <span class="btn-label">Submit Solution</span>
      <span class="btn-hint">finalises &amp; locks your branch</span>
    </button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  // CSP forbids inline event handlers; wire actions via data-action attributes.
  document.querySelectorAll('button[data-action]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.hasAttribute('disabled')) return;
      vscode.postMessage({ command: btn.getAttribute('data-action') });
    });
  });

  // Live countdown: the extension posts a 'tick' message every second. We
  // patch the timer DOM in place rather than re-rendering the whole panel
  // — re-assigning webview.html reloads the entire view and would flicker.
  var TIMER_PALETTE = {
    critical: {
      color: 'var(--vscode-errorForeground, #f44336)',
      bg: 'var(--vscode-inputValidation-errorBackground, rgba(244,67,54,0.1))'
    },
    warn: { color: '#e8c000', bg: 'rgba(232,192,0,0.1)' },
    normal: { color: 'var(--vscode-foreground)', bg: 'var(--vscode-input-background)' }
  };
  window.addEventListener('message', function(e) {
    var msg = e.data || {};
    if (msg.command !== 'tick') return;
    var value = document.querySelector('.timer-value');
    var label = document.querySelector('.timer-label');
    var box = document.querySelector('.timer-box');
    if (value) value.textContent = msg.timeStr;
    var palette = TIMER_PALETTE[msg.urgent] || TIMER_PALETTE.normal;
    if (value) value.style.color = palette.color;
    if (label) label.style.color = palette.color;
    if (box) box.style.background = palette.bg;
  });
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposed = true;
    this._stopRefresh();
    // Cancel the in-flight prereq HTTPS request so its callbacks don't fire on
    // a disposed provider (and so we don't leak the underlying socket).
    if (this._prereqRequest) {
      try { this._prereqRequest.destroy(); } catch { /* swallow */ }
      this._prereqRequest = undefined;
    }
  }
}
