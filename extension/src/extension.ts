import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { validateSession, SessionConfig } from "./api";
import { Timer } from "./timer";
import { DashboardViewProvider } from "./welcome/panel";
import { ChatViewProvider } from "./chat/view";
import { runSubmit, gitCommitAndPushAsync } from "./submit";
import { TelemetryTracker } from "./telemetry";
import { AiProposedContentProvider, AiApplyCodeLensProvider, AI_PROPOSED_SCHEME, registerCodeLensProvider, setTelemetryCallback, acceptAiChanges, rejectAiChanges } from "./chat/apply";

const SESSION_KEY = "vibe.session";
const SERVER_URL_KEY = "vibe.serverUrl";
// Persists the realpath of the workspace folder the user accepted via the
// Reopen dialog, so subsequent activations can match against it directly
// instead of relying on a fresh `_samePath` round-trip that can fail under
// symlink/case-normalization differences.
const OPENED_WS_KEY = "vibe.openedWs";
const DEFAULT_SERVER_URL = "http://34.193.116.47:8080";
const STALE_SERVER_URLS = ["http://18.209.171.199:8080", "http://localhost:8080", "http://34.193.116.47"];
const AUTO_COMMIT_INTERVAL_MS = 180_000; // 3 minutes
// Bounds the auto-commit push so a hung network can't pile up overlapping
// timers. Kept below the interval so each tick has a chance to finish before
// the next one fires.
const AUTO_COMMIT_TIMEOUT_MS = 120_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Clear stale server URLs from previous installs so the new default takes effect.
  // Also clear the saved session — its llmProxyUrl came from the old server and is wrong.
  const cachedUrl = context.globalState.get<string>(SERVER_URL_KEY);
  if (cachedUrl && STALE_SERVER_URLS.includes(cachedUrl)) {
    await context.globalState.update(SERVER_URL_KEY, undefined);
    await context.globalState.update(SESSION_KEY, undefined);
  }

  const savedSessionPrecheck = context.globalState.get<SessionConfig>(SESSION_KEY);
  if (savedSessionPrecheck) {
    const elapsed = Date.now() - savedSessionPrecheck.startedAt;
    if (elapsed > savedSessionPrecheck.maxMinutes * 60_000) {
      await context.globalState.update(SESSION_KEY, undefined);
    }
  }

  const timer = new Timer();
  const dashboardProvider = new DashboardViewProvider(context);
  const chatProvider = new ChatViewProvider(context);

  // Register the content provider for the diff editor (AI proposed side)
  const aiContentProvider = new AiProposedContentProvider();
  const aiCodeLensProvider = new AiApplyCodeLensProvider();
  registerCodeLensProvider(aiCodeLensProvider);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(AI_PROPOSED_SCHEME, aiContentProvider),
    vscode.languages.registerCodeLensProvider({ scheme: AI_PROPOSED_SCHEME }, aiCodeLensProvider),
    vscode.window.registerWebviewViewProvider("vibe.dashboard", dashboardProvider),
    vscode.window.registerWebviewViewProvider("vibe.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    dashboardProvider,
    chatProvider
  );

  // Commands are registered unconditionally so they are always available,
  // even when activate() needs to redirect to a different workspace.
  context.subscriptions.push(
    vscode.commands.registerCommand("vibe.enterSessionKey", (prefillKey?: string) =>
      promptForSession(context, timer, dashboardProvider, prefillKey)
    ),
    vscode.commands.registerCommand("vibe.showBrief", () => {
      vscode.commands.executeCommand("vibe.dashboard.focus");
    }),
    vscode.commands.registerCommand("vibe.runTests", () => {
      vscode.commands.executeCommand("vibe.dashboard.focus");
    }),
    vscode.commands.registerCommand("vibe.openChat", () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (!config) {
        vscode.window.showInformationMessage("Enter a session key to start the interview first.");
        return;
      }
      chatProvider.setConfig(config);
      vscode.commands.executeCommand("workbench.view.extension.vibe-chat-panel");
    }),
    vscode.commands.registerCommand("vibe.submit", async () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (!config) { vscode.window.showErrorMessage("No active session."); return; }
      await runSubmit(config, {
        onStopTimer: () => timer.stop(),
        onSubmitted: async () => {
          // Bug fix: clear the session AFTER a successful submit so the IDLE →
          // SUBMITTING → DONE state machine advances. Without this the
          // dashboard buttons stay live, the AI chat budget keeps draining,
          // and the candidate can resubmit.
          await context.globalState.update(SESSION_KEY, undefined);
          await context.globalState.update(OPENED_WS_KEY, undefined);
        },
        onMarkSubmitted: () => dashboardProvider.markSubmitted(),
      });
    }),
    vscode.commands.registerCommand("vibe.applyCodeBlock", (filePath: string, codeText: string, blockId: string) => {
      // Programmatic entry point for tests and external callers. The chat
      // webview normally invokes applyCodeBlock() directly via postMessage.
      return import("./chat/apply").then((m) => m.applyCodeBlock(filePath, codeText, blockId));
    }),
    vscode.commands.registerCommand("vibe.acceptAiChanges", (blockId: string) => {
      acceptAiChanges(blockId);
    }),
    vscode.commands.registerCommand("vibe.rejectAiChanges", (blockId: string) => {
      rejectAiChanges(blockId);
    }),
    timer
  );

  // Restore session from previous run
  const savedSession = context.globalState.get<SessionConfig>(SESSION_KEY);
  if (!savedSession) return;

  const cloneDir = path.join(os.homedir(), `vibe-${savedSession.sessionId.slice(0, 8)}`);
  if (!fs.existsSync(cloneDir)) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "JivaHire: Cloning challenge…", cancellable: false },
      async () => {
        _gitClone(savedSession, cloneDir);
      }
    );
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cloneDir), false);
    return;
  }

  const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const previouslyAccepted = context.globalState.get<string>(OPENED_WS_KEY);
  if (!_samePath(currentWs, cloneDir) && !_samePath(currentWs, previouslyAccepted)) {
    // Show session page so the panel doesn't spin while the dialog is up.
    dashboardProvider.setConfig(savedSession);
    // Bug fix: AWAIT focus so the dashboard webview has been resolved and the
    // brief HTML is in place before the modal-style information message is
    // shown. Without the await the dialog could appear over a still-blank
    // onboarding panel.
    await vscode.commands.executeCommand("vibe.dashboard.focus");
    const action = await vscode.window.showInformationMessage(
      `JivaHire: Resume your session "${savedSession.challengeId}" in its workspace?`,
      "Reopen"
    );
    if (action === "Reopen") {
      // Persist the *resolved* cloneDir we are about to open so the next
      // activation can match it without round-tripping through realpathSync
      // (which on macOS resolves /var → /private/var differently depending on
      // the path components passed in).
      try {
        const resolved = fs.realpathSync(cloneDir);
        await context.globalState.update(OPENED_WS_KEY, resolved);
      } catch {
        await context.globalState.update(OPENED_WS_KEY, cloneDir);
      }
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cloneDir), false);
    }
    return;
  }

  // We're in the right workspace. Record the realpath we're operating in so
  // subsequent reopens don't re-prompt due to symlink resolution differences.
  if (currentWs) {
    try { await context.globalState.update(OPENED_WS_KEY, fs.realpathSync(currentWs)); }
    catch { await context.globalState.update(OPENED_WS_KEY, currentWs); }
  }

  timer.start(savedSession);
  chatProvider.setConfig(savedSession);
  dashboardProvider.setConfig(savedSession);
  _startSessionServices(savedSession, context);
  vscode.commands.executeCommand("vibe.dashboard.focus");
}

function _gitClone(session: SessionConfig, cloneDir: string): void {
  // Argv form — no shell interpolation. A hostile validate-session response
  // (branch name with quotes / shell metachars / token with $(...)) cannot
  // escape the argv slot into a shell. shell:false is the execFile default
  // but we pin it for clarity.
  const baseUrl = session.repoUrl.replace(/\.git$/, "");
  const authedUrl =
    baseUrl.replace("https://", `https://x-access-token:${session.githubToken}@`) + ".git";
  execFileSync(
    "git",
    ["clone", "-b", session.branch, authedUrl, cloneDir],
    { stdio: "pipe", shell: false }
  );
}

/**
 * Normalise two paths to a comparable, OS-aware canonical form. Walks several
 * fallbacks so we don't re-prompt the Reopen dialog after the user has
 * already done what we asked.
 *
 * Edge cases this handles:
 *  - trailing path separators
 *  - macOS `/var` vs `/private/var` (realpathSync canonicalises one but not
 *    always the other depending on which segment is the symlink)
 *  - Windows drive-letter case differences
 *  - the file system reports the same inode/device for both paths (covers
 *    bind-mounts and exotic symlink chains)
 */
export function _samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => path.normalize(p).replace(/[\\/]+$/, "");
  try {
    const ra = norm(fs.realpathSync(path.resolve(a)));
    const rb = norm(fs.realpathSync(path.resolve(b)));
    if (ra === rb || ra.toLowerCase() === rb.toLowerCase()) return true;
  } catch { /* fall through */ }
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.ino && sa.dev && sa.ino === sb.ino && sa.dev === sb.dev) return true;
  } catch { /* fall through */ }
  const na = norm(path.resolve(a));
  const nb = norm(path.resolve(b));
  return na === nb || na.toLowerCase() === nb.toLowerCase();
}

function _startSessionServices(config: SessionConfig, context: vscode.ExtensionContext): void {
  const tracker = new TelemetryTracker(config, context);
  context.subscriptions.push(tracker);

  // Wire apply.ts telemetry back to the tracker
  setTelemetryCallback((event_type, payload) => {
    tracker.emit(event_type, payload as Record<string, unknown>);
  });

  // Auto-commit every 3 minutes.
  // Bug fix:
  //  - Use the ASYNC commit helper so a slow `git push` doesn't block the
  //    extension host main thread for many seconds.
  //  - Re-entry guard so two pushes can never overlap (a slow push would
  //    otherwise stack up and risk conflicting refs).
  //  - Per-push deadline so a hung connection times out rather than wedging
  //    the auto-commit cycle forever.
  let autoCommitInFlight = false;
  const autoCommitTimer = setInterval(() => {
    if (autoCommitInFlight) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    autoCommitInFlight = true;
    const ts = new Date().toISOString();
    const timeout = setTimeout(() => {
      // The deadline fires independently of the underlying git child, which
      // will continue. The guard is released so the next tick can try again.
      autoCommitInFlight = false;
    }, AUTO_COMMIT_TIMEOUT_MS);
    gitCommitAndPushAsync(ws, config, `auto: ${ts}`, false)
      .then(() => tracker.emit("auto_commit", { ts }))
      .catch(() => { /* silently skip — nothing to commit or push failed */ })
      .finally(() => {
        clearTimeout(timeout);
        autoCommitInFlight = false;
      });
  }, AUTO_COMMIT_INTERVAL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(autoCommitTimer) });
}

async function promptForSession(
  context: vscode.ExtensionContext,
  timer: Timer,
  dashboardProvider: DashboardViewProvider,
  prefillKey?: string
): Promise<void> {
  let serverUrl: string;
  let sessionKey: string | undefined;

  if (prefillKey) {
    serverUrl = context.globalState.get<string>(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL;
    sessionKey = prefillKey.trim();
  } else {
    const urlInput = await vscode.window.showInputBox({
      prompt: "JivaHire server URL",
      value: context.globalState.get<string>(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL,
    });
    if (!urlInput) return;
    serverUrl = urlInput;

    sessionKey = await vscode.window.showInputBox({
      prompt: "Enter your session key (provided by the recruiter)",
      placeHolder: "e.g. XYZ-123",
    });
  }
  if (!sessionKey) return;

  try {
    const config = await validateSession(serverUrl, sessionKey);
    await context.globalState.update(SESSION_KEY, config);
    await context.globalState.update(SERVER_URL_KEY, serverUrl);

    const cloneDir = path.join(os.homedir(), `vibe-${config.sessionId.slice(0, 8)}`);
    if (!fs.existsSync(cloneDir)) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "JivaHire: Cloning challenge…", cancellable: false },
        async () => {
          _gitClone(config, cloneDir);
        }
      );
    }

    // openFolder reloads the window; activate() will restore session from globalState
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cloneDir), false);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Could not start session: ${message}`);
    dashboardProvider.reportSessionError(message);
  }
}

export function deactivate(): void {}
