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
// Tracks which session ids have already shown the "join the video call and
// share your screen" toast, so the candidate isn't pestered on every reload.
const MEET_TOAST_SHOWN_KEY = "vibe.meetToastShown";
// Persists the realpath of the workspace folder the user accepted via the
// Reopen dialog, so subsequent activations can match against it directly
// instead of relying on a fresh `_samePath` round-trip that can fail under
// symlink/case-normalization differences.
const OPENED_WS_KEY = "vibe.openedWs";
const DEFAULT_SERVER_URL = "https://interview.jivahire.com";
const STALE_SERVER_URLS = ["http://18.209.171.199:8080", "http://localhost:8080", "http://34.193.116.47", "http://34.193.116.47:8080"];
const AUTO_COMMIT_INTERVAL_MS = 180_000; // 3 minutes
// Bounds the auto-commit push so a hung network can't pile up overlapping
// timers. Kept below the interval so each tick has a chance to finish before
// the next one fires.
const AUTO_COMMIT_TIMEOUT_MS = 120_000;

/**
 * Hooks for stopping the per-session services (auto-commit interval) without
 * tearing down the entire extension host. Populated by _startSessionServices
 * and called from the submit success path so we don't keep pushing to a
 * cleared session with an expired GitHub token.
 */
let _stopAutoCommit: (() => void) | undefined;

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
      // Focus the dashboard so the candidate can SEE the checklist results
      // when they trigger this from the status bar (the dashboard webview is
      // hidden whenever the File Explorer / another activity bar view is up).
      vscode.commands.executeCommand("vibe.dashboard.focus");
      dashboardProvider.runTests();
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
          // Bug fix: also stop the auto-commit interval. The closure still
          // holds the old `config` (with a now-cleared globalState session),
          // so leaving the interval running keeps pushing with a token that
          // will silently expire ~1h later. Stop it cleanly on submit.
          _stopAutoCommit?.();
        },
        onMarkSubmitted: () => dashboardProvider.markSubmitted(),
      });
    }),
    vscode.commands.registerCommand("vibe.joinMeet", () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (!config?.meetLink) {
        vscode.window.showInformationMessage(
          "This interview has no video call attached. Ask your recruiter for the meeting link.",
        );
        return;
      }
      void vscode.env.openExternal(vscode.Uri.parse(config.meetLink));
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
  const cloneDirExists = fs.existsSync(cloneDir);
  const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const previouslyAccepted = context.globalState.get<string>(OPENED_WS_KEY);
  const inRightWorkspace =
    cloneDirExists &&
    (_samePath(currentWs, cloneDir) || _samePath(currentWs, previouslyAccepted));

  if (!inRightWorkspace) {
    // Bug fix: a stale saved session whose cloneDir is missing (candidate
    // wiped it, swapped machines, or got a fresh invite for a different
    // challenge) used to be silently re-cloned on activation. That meant a
    // candidate who received a new TypeScript invite would still see the old
    // C++ workspace clone because the leftover SessionConfig in globalState
    // pointed at the previous challenge's repo. Always require an explicit
    // candidate choice when the workspace is missing OR mismatched, so the
    // candidate can pick "Start Fresh" and enter the new session key.
    //
    // Show the session brief so the sidebar isn't stuck on the spinner /
    // onboarding page while we decide what to do. setConfig is safe even
    // when resolveWebviewView hasn't fired yet — the provider re-reads
    // globalState in resolveWebviewView when this.config is null.
    dashboardProvider.setConfig(savedSession);
    // AWAIT focus so the dashboard webview has been resolved and the
    // brief HTML is in place before the modal is shown.
    await vscode.commands.executeCommand("vibe.dashboard.focus");

    // Modal (never a toast) so the candidate MUST choose, and an explicit
    // "Start Fresh" so a stuck / abandoned session can be cleared without
    // manual intervention. Tailor the prompt to whether the workspace is
    // simply mismatched vs. missing entirely — the latter means "Reopen"
    // will re-clone, which the candidate should know before clicking.
    const remainingMin = Math.max(
      0,
      Math.ceil((savedSession.maxMinutes * 60_000 - (Date.now() - savedSession.startedAt)) / 60_000),
    );
    const promptBody = cloneDirExists
      ? `JivaHire: You have an active interview session for "${savedSession.challengeId}" with about ${remainingMin} min left. Reopen its workspace, or start fresh (this discards the active session)?`
      : `JivaHire: You have an active interview session for "${savedSession.challengeId}" with about ${remainingMin} min left. Its workspace is no longer on disk. Reopen (re-clones the challenge), or start fresh (this discards the active session)?`;
    const detail = cloneDirExists
      ? "Reopen returns you to the challenge folder. Start Fresh clears the session so you can enter a new key."
      : "Reopen re-clones the challenge folder. Start Fresh clears the session so you can enter a new key — pick this if the recruiter sent you a new invite.";
    const action = await vscode.window.showWarningMessage(
      promptBody,
      { modal: true, detail },
      "Reopen",
      "Start Fresh",
    );
    if (action === "Reopen") {
      if (!cloneDirExists) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "JivaHire: Cloning challenge…", cancellable: false },
          async () => {
            _gitClone(savedSession, cloneDir);
          },
        );
      }
      // Persist the *resolved* cloneDir we are about to open so the next
      // activation can match it without round-tripping through realpathSync.
      try {
        const resolved = fs.realpathSync(cloneDir);
        await context.globalState.update(OPENED_WS_KEY, resolved);
      } catch {
        await context.globalState.update(OPENED_WS_KEY, cloneDir);
      }
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cloneDir), false);
      return;
    }
    if (action === "Start Fresh") {
      // Clear the saved session and any workspace marker so the welcome
      // page renders on next render() cycle and a new session key can be
      // entered. We do NOT touch the on-disk cloneDir — the candidate may
      // still want to recover work from it manually.
      await context.globalState.update(SESSION_KEY, undefined);
      await context.globalState.update(OPENED_WS_KEY, undefined);
      dashboardProvider.clearConfig();
      void vscode.window
        .showInformationMessage(
          `Your previous work is still on disk at ${cloneDir}. Open it manually if you want to recover any files.`,
          "Reveal in OS",
        )
        .then((pick) => {
          if (pick === "Reveal in OS") {
            void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(cloneDir));
          }
        });
      return;
    }
    // Dismissed (Esc / X). Drop the brief and render the welcome page —
    // without a workspace match we are NOT in the active-session state,
    // and leaving the brief + ticking countdown on screen misleads the
    // candidate into thinking they can still use the dashboard buttons
    // (they can't — there's no workspace to run tests / submit in). The
    // saved session stays in globalState so the next activation
    // re-prompts the Reopen / Start Fresh choice.
    dashboardProvider.dismiss();
    void vscode.window.showInformationMessage(
      "Session paused. Open the challenge folder, or run 'JivaHire: Enter Session Key' from the Command Palette to resume.",
    );
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
  try {
    _startSessionServices(savedSession, context);
  } catch (err: unknown) {
    // Surface the failure instead of silently losing the auto-commit timer
    // and status bar buttons. activate() doesn't catch synchronous throws
    // here on its own, and VS Code only logs them to a place candidates
    // never look. With status bar items now created at the very top of
    // _startSessionServices this catch is mostly defensive against the
    // telemetry tracker / meet-link branch failing.
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `JivaHire session services failed to start: ${message}. Reload the window and try again.`,
    );
  }
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
  // Always-visible action buttons. The dashboard webview lives in the activity
  // bar sidebar, so it's hidden whenever the candidate switches to the File
  // Explorer or another activity bar view. Status bar items stay visible
  // regardless, so the candidate can always run tests, open AI chat, and
  // submit without first navigating back to the JivaHire sidebar.
  //
  // Created FIRST in this function so a downstream failure (telemetry,
  // meet-link toast, auto-commit setup) cannot prevent the buttons from
  // appearing. The earlier ordering had TelemetryTracker construction first;
  // any throw inside its event-listener registration would silently
  // suppress all subsequent setup including the status bar items.
  const runTestsStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  runTestsStatus.text = "$(beaker) Run tests";
  runTestsStatus.tooltip = "Run the challenge test checklist.";
  runTestsStatus.command = "vibe.runTests";
  runTestsStatus.show();

  const chatStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  chatStatus.text = "$(comment-discussion) AI chat";
  chatStatus.tooltip = "Open the JivaHire AI chat panel.";
  chatStatus.command = "vibe.openChat";
  chatStatus.show();

  const submitStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
  submitStatus.text = "$(cloud-upload) Submit";
  submitStatus.tooltip = "Submit your work for grading.";
  submitStatus.command = "vibe.submit";
  submitStatus.show();

  context.subscriptions.push(runTestsStatus, chatStatus, submitStatus);

  const tracker = new TelemetryTracker(config, context);
  context.subscriptions.push(tracker);

  // Wire apply.ts telemetry back to the tracker
  setTelemetryCallback((event_type, payload) => {
    tracker.emit(event_type, payload as Record<string, unknown>);
  });

  // Panel-interview surface: when the session has a video meeting link, expose
  // a persistent status-bar entry and show a one-time toast asking the
  // candidate to join and share their screen. Async sessions skip this.
  if (config.meetLink) {
    const meetStatus = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99,
    );
    meetStatus.text = "$(device-camera-video) Join interview call";
    meetStatus.tooltip = "Open your panel-interview video call and share your screen.";
    meetStatus.command = "vibe.joinMeet";
    meetStatus.show();
    context.subscriptions.push(meetStatus);

    const shownIds = context.globalState.get<string[]>(MEET_TOAST_SHOWN_KEY) ?? [];
    if (!shownIds.includes(config.sessionId)) {
      void context.globalState.update(
        MEET_TOAST_SHOWN_KEY,
        [...shownIds, config.sessionId].slice(-20),
      );
      let toast = "This is a panel interview. Join the video call and share your screen when you're ready.";
      if (typeof config.scheduledAt === "number") {
        const startLocal = new Date(config.scheduledAt * 1000).toLocaleString(undefined, {
          weekday: "short", month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit",
        });
        toast = `Panel interview scheduled for ${startLocal}. Join the call and share your screen at the start.`;
      }
      void vscode.window
        .showInformationMessage(toast, "Join video call")
        .then((pick) => {
          if (pick === "Join video call") {
            void vscode.commands.executeCommand("vibe.joinMeet");
          }
        });
    }
  }

  // Auto-commit every 3 minutes.
  // Bug fix:
  //  - Use the ASYNC commit helper so a slow `git push` doesn't block the
  //    extension host main thread for many seconds.
  //  - Re-entry guard so two pushes can never overlap (a slow push would
  //    otherwise stack up and risk conflicting refs).
  //  - Per-push deadline so a hung connection times out rather than wedging
  //    the auto-commit cycle forever.
  let autoCommitInFlight = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let lastSuccessAt = Date.now();
  let offlineStatus: vscode.StatusBarItem | undefined;
  const autoCommitTimer = setInterval(() => {
    if (stopped || autoCommitInFlight) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    autoCommitInFlight = true;
    const ts = new Date().toISOString();
    const timeout = setTimeout(() => {
      // The deadline fires independently of the underlying git child, which
      // will continue. The guard is released so the next tick can try again.
      autoCommitInFlight = false;
    }, AUTO_COMMIT_TIMEOUT_MS);
    // Wrap in Promise.resolve so a synchronous return from a (mocked or
    // monkey-patched) gitCommitAndPushAsync can't blow up the timer with a
    // "Cannot read properties of undefined (reading 'then')". The real
    // implementation always returns a Promise; the wrapper is cheap defense.
    Promise.resolve(gitCommitAndPushAsync(ws, config, `auto: ${ts}`, false))
      .then(() => {
        if (stopped) return;
        tracker.emit("auto_commit", { ts });
        consecutiveFailures = 0;
        lastSuccessAt = Date.now();
        if (offlineStatus) offlineStatus.hide();
      })
      .catch(() => {
        if (stopped) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 2) {
          if (!offlineStatus) {
            offlineStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
            context.subscriptions.push(offlineStatus);
          }
          const mins = Math.max(1, Math.round((Date.now() - lastSuccessAt) / 60_000));
          offlineStatus.text = "$(warning) Auto-save offline";
          offlineStatus.tooltip = `Last successful auto-save was ${mins} minutes ago — check your network.`;
          offlineStatus.show();
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        autoCommitInFlight = false;
      });
  }, AUTO_COMMIT_INTERVAL_MS);

  // Bug fix: expose a stop hook so the submit handler can halt the interval
  // the moment the session transitions to DONE. Without this, the closure
  // keeps the old `config` alive and the interval continues to call
  // `git push` against a (cleared) session — usually failing silently when
  // the GitHub installation token expires ~1 hour later.
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(autoCommitTimer);
    // After submit the action buttons must disappear — re-clicking them would
    // either no-op (post-submit guards) or worse, attempt to push with a
    // cleared session. Hide rather than dispose so the context.subscriptions
    // disposal on extension deactivate still fires cleanly.
    runTestsStatus.hide();
    chatStatus.hide();
    submitStatus.hide();
    if (_stopAutoCommit === stop) _stopAutoCommit = undefined;
  };
  _stopAutoCommit = stop;
  context.subscriptions.push({ dispose: stop });
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
