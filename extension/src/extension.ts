import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";
import { validateSession, preflightSession, refreshGithubToken, reportSessionStarted, invalidateSession, SessionConfig, Dependency, SessionPreflight } from "./api";
import { Timer } from "./timer";
import { DashboardViewProvider } from "./welcome/panel";
import { ChatViewProvider } from "./chat/view";
import { runSubmit, gitCommitAndPushAsync, redactGitAuth } from "./submit";
import { TelemetryTracker } from "./telemetry";
import { Logger, setSharedLogger, getLogger } from "./logger";
import { AiProposedContentProvider, AiApplyCodeLensProvider, AI_PROPOSED_SCHEME, registerCodeLensProvider, setTelemetryCallback, acceptAiChanges, rejectAiChanges, acceptHunk, rejectHunk, _getSessionForActiveEditor } from "./chat/apply";

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
const PRODUCTION_HOSTNAME = "interview.jivahire.com";
const AUTO_COMMIT_INTERVAL_MS = 180_000; // 3 minutes
// Bounds the auto-commit push so a hung network can't pile up overlapping
// timers. Kept below the interval so each tick has a chance to finish before
// the next one fires.
const AUTO_COMMIT_TIMEOUT_MS = 120_000;
// Refresh the GitHub installation token this many ms BEFORE it expires.
// GitHub mints tokens with a 1hr TTL; refreshing at T-5min leaves headroom
// for one retry on a flaky network without ever letting the in-use token
// expire in the middle of a push.
const TOKEN_REFRESH_LEAD_MS = 300_000;
// Fallback cadence when the server didn't ship an expires_at (older
// server, or 0 sentinel). Conservative: well under GitHub's 1hr ceiling.
const TOKEN_REFRESH_FALLBACK_MS = 45 * 60_000;
// Floor so a near-expired token (or a clock-skew anomaly that puts expiry
// "in the past") doesn't get us stuck in a tight refresh loop.
const TOKEN_REFRESH_MIN_DELAY_MS = 30_000;

/**
 * Returns true when `url` is a stale server URL that should be evicted from
 * globalState. Any URL that is not HTTPS or not pointing at the production
 * hostname is considered stale — this is intentionally broad so we don't
 * need to maintain a growing list of old IPs and localhost variants.
 */
function _isStaleServerUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol !== "https:" || parsed.hostname !== PRODUCTION_HOSTNAME;
  } catch {
    return true; // unparseable URL is always stale
  }
}

/**
 * Hooks for stopping the per-session services (auto-commit interval) without
 * tearing down the entire extension host. Populated by _startSessionServices
 * and called from the submit success path so we don't keep pushing to a
 * cleared session with an expired GitHub token.
 */
let _stopAutoCommit: (() => void) | undefined;
let _stopTokenRefresh: (() => void) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger(context);
  setSharedLogger(logger);
  context.subscriptions.push(logger);
  logger.info("extension_activated");

  // Clear stale server URLs from previous installs so the new default takes effect.
  // Also clear the saved session — its llmProxyUrl came from the old server and is wrong.
  // Match broadly: any non-HTTPS URL or any URL not pointing at the production hostname
  // is stale. The old exact-list approach missed variants with trailing slashes or
  // minor formatting differences.
  const cachedUrl = context.globalState.get<string>(SERVER_URL_KEY);
  if (_isStaleServerUrl(cachedUrl)) {
    await context.globalState.update(SERVER_URL_KEY, undefined);
    await context.globalState.update(SESSION_KEY, undefined);
  }

  const savedSessionPrecheck = context.globalState.get<SessionConfig>(SESSION_KEY);
  // Only expire a session whose clock has actually started. startedAt is 0
  // between clone and the first clone-workspace activation (the clock is
  // anchored later, by reportSessionStarted); treating that 0 as "elapsed since
  // 1970" here would wipe every freshly-cloned session before it ever begins.
  if (savedSessionPrecheck && savedSessionPrecheck.startedAt) {
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
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, aiCodeLensProvider),
    vscode.window.registerWebviewViewProvider("vibe.dashboard", dashboardProvider),
    vscode.window.registerWebviewViewProvider("vibe.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    dashboardProvider,
    chatProvider
  );

  // Deps shared by the manual `vibe.submit` command and the time-up auto-submit
  // below, so both paths run identical DONE-state cleanup and surface the video
  // link the same way.
  const buildSubmitDeps = () => ({
    onStopTimer: () => timer.stop(),
    onSubmitted: async () => {
      // Bug fix: clear the session AFTER a successful submit so the IDLE →
      // SUBMITTING → DONE state machine advances. Without this the dashboard
      // buttons stay live, the AI chat budget keeps draining, and the candidate
      // can resubmit.
      await context.globalState.update(SESSION_KEY, undefined);
      await context.globalState.update(OPENED_WS_KEY, undefined);
      // Hide the chat view (which gates on vibe.session.active) and drop the
      // meet-link flag so a post-submit reload renders the dashboard alone,
      // matching the IDLE/DONE state.
      await vscode.commands.executeCommand("setContext", "vibe.session.active", false);
      await vscode.commands.executeCommand("setContext", "vibe.session.hasMeet", false);
      // Bug fix: also stop the auto-commit interval. The closure still holds the
      // old `config` (with a now-cleared globalState session), so leaving the
      // interval running keeps pushing with a token that will silently expire
      // ~1h later. Stop it cleanly on submit.
      _stopAutoCommit?.();
      // And the token-refresh timer for the same reason — keeping it armed past
      // submit would burn a GitHub API call every ~55 min for a DONE session.
      _stopTokenRefresh?.();
    },
    onMarkSubmitted: () => dashboardProvider.markSubmitted(),
    onShowVideoLink: (url: string, expiresUnix: number) =>
      dashboardProvider.setVideoLink(url, expiresUnix),
  });

  // Auto-submit when the countdown hits zero. The server's sweep also submits
  // expired sessions, but if VS Code is open at 00:00 the candidate would
  // otherwise see nothing — no "submitted" confirmation and, when the session
  // records one, no identity-verification video link. Firing the submit
  // client-side closes that gap; the 409 branch inside runSubmit handles the
  // race where the server's sweep submitted first.
  let _autoSubmitInFlight = false;
  timer.onTick((tick) => {
    // Natural expiry emits exactly one tick with 0 seconds left and not
    // running. The idle tick reports -1, and a manual stop keeps the prior
    // secondsLeft, so neither trips this guard.
    if (tick.secondsLeft !== 0 || tick.running || _autoSubmitInFlight) return;
    const config = context.globalState.get<SessionConfig>(SESSION_KEY);
    if (!config) return; // already submitted / cleared — nothing to do
    _autoSubmitInFlight = true;
    void runSubmit(config, buildSubmitDeps(), { auto: true }).finally(() => {
      _autoSubmitInFlight = false;
    });
  });

  // Commands are registered unconditionally so they are always available,
  // even when activate() needs to redirect to a different workspace.
  context.subscriptions.push(
    vscode.commands.registerCommand("vibe.enterSessionKey", (prefillKey?: string) =>
      promptForSession(context, timer, dashboardProvider, prefillKey)
    ),
    vscode.commands.registerCommand("vibe.showBrief", () => {
      vscode.commands.executeCommand("vibe.dashboard.focus");
    }),
    vscode.commands.registerCommand("vibe.openChat", () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (!config) {
        vscode.window.showInformationMessage("Enter a session key to start the interview first.");
        return;
      }
      if (!config.aiAssistance) {
        vscode.window.showInformationMessage(
          "AI is not allowed for this interview — this is a normal coding interview. " +
          "Solve it using your own knowledge and the starter code.",
        );
        return;
      }
      chatProvider.setConfig(config);
      vscode.commands.executeCommand("workbench.view.extension.vibe-interview-panel");
    }),
    vscode.commands.registerCommand("vibe.submit", async () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (!config) { vscode.window.showErrorMessage("No active session."); return; }
      await runSubmit(config, buildSubmitDeps());
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
    vscode.commands.registerCommand("vibe.attachFileToChat", async (uri?: vscode.Uri) => {
      const cfg = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (cfg && !cfg.aiAssistance) {
        vscode.window.showInformationMessage(
          "AI is not allowed for this interview — this is a normal coding interview.",
        );
        return;
      }
      let target = uri;
      if (!target) {
        const editor = vscode.window.activeTextEditor;
        if (editor) target = editor.document.uri;
      }
      if (!target) return;
      const rel = vscode.workspace.asRelativePath(target, false);
      chatProvider.attachFile(rel);
      chatProvider.focus();
      void vscode.commands.executeCommand("workbench.view.extension.vibe-interview-panel");
      void vscode.commands.executeCommand("vibe.chat.focus");
    }),
    timer
  );

  // Inline hunk commands — file-level (accept/reject ALL) and per-hunk.
  // The line-0 CodeLens fires these with an explicit blockId string, but the
  // editor title-bar menu invokes the same command with the active editor's
  // vscode.Uri as the first argument (VS Code's default for `editor/title`
  // bindings). So we only treat the arg as a blockId when it is actually a
  // string — otherwise we fall back to whichever inline-diff session matches
  // the focused editor. Earlier versions used `arg ?? fallback`, which broke
  // because a Uri object is truthy and silently became the blockId.
  context.subscriptions.push(
    vscode.commands.registerCommand("vibe.acceptAllHunks", (arg?: unknown) => {
      const id = typeof arg === 'string' ? arg : _getSessionForActiveEditor()?.id;
      if (id) acceptAiChanges(id);
    }),
    vscode.commands.registerCommand("vibe.rejectAllHunks", (arg?: unknown) => {
      const id = typeof arg === 'string' ? arg : _getSessionForActiveEditor()?.id;
      if (id) rejectAiChanges(id);
    }),
    vscode.commands.registerCommand("vibe.acceptHunk", (blockId: string, hunkIndex: number) => {
      acceptHunk(blockId, hunkIndex);
    }),
    vscode.commands.registerCommand("vibe.rejectHunk", (blockId: string, hunkIndex: number) => {
      rejectHunk(blockId, hunkIndex);
    }),
  );

  // JivaHire dashboard toggle. The activity-bar approach was abandoned
  // because VS Code unconditionally opens the primary sidebar when an
  // activitybar viewsContainer icon is clicked, which clobbers the user's
  // File Explorer / Debug / Extensions panel. A status-bar button only
  // triggers a custom command, so we can toggle ONLY the secondary sidebar
  // and leave the primary sidebar exactly as the user left it.
  const dashboardToggleStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  dashboardToggleStatus.text = "$(jersey) JivaHire";
  dashboardToggleStatus.tooltip = "Toggle the JivaHire panel (secondary sidebar)";
  dashboardToggleStatus.command = "vibe.toggleDashboard";
  dashboardToggleStatus.show();
  context.subscriptions.push(
    dashboardToggleStatus,
    vscode.commands.registerCommand("vibe.toggleDashboard", async () => {
      const isOpen = dashboardProvider.isVisible() || chatProvider.isVisible();
      if (isOpen) {
        await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
      } else {
        await vscode.commands.executeCommand("workbench.view.extension.vibe-interview-panel");
      }
    }),
  );

  // Restore session from previous run
  const savedSession = context.globalState.get<SessionConfig>(SESSION_KEY);
  if (!savedSession) {
    logger.info("no_saved_session");
    return;
  }
  logger.setSession(savedSession);
  logger.info("session_restored", { sessionId: savedSession.sessionId, challengeId: savedSession.challengeId });

  // Full session id — must match the key used when the dir was first cloned in
  // promptForSession (previously both used `slice(0, 8)`, which risked cross-
  // session collisions).
  const cloneDir = path.join(os.homedir(), `vibe-${savedSession.sessionId}`);
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
    // startedAt is 0 until the clock is anchored (clone done + workspace
    // opened). Treat an unanchored session as "full time remaining" rather
    // than letting `Date.now() - 0` report it as already expired.
    const effectiveStart = savedSession.startedAt || Date.now();
    const remainingMin = Math.max(
      0,
      Math.ceil((savedSession.maxMinutes * 60_000 - (Date.now() - effectiveStart)) / 60_000),
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

  // Start the countdown here — in the opened clone workspace — NOT at
  // validate-session. The clone + window reload that got us here can take
  // minutes on a slow network, and the candidate shouldn't lose them. On the
  // first activation after a fresh clone, startedAt is still 0: report
  // clone-completion to the server, which anchors the authoritative start and
  // hands it back. The call is idempotent, so reopens just get the same value.
  let sessionForTimer = savedSession;
  if (!savedSession.startedAt) {
    const serverUrl = context.globalState.get<string>(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL;
    try {
      const startedAtMs = await reportSessionStarted(serverUrl, savedSession.sessionKey);
      savedSession.startedAt = startedAtMs;
      await context.globalState.update(SESSION_KEY, savedSession);
      dashboardProvider.setConfig(savedSession);
      logger.info("session_clock_started", { startedAt: startedAtMs });
    } catch (err) {
      // Transient network failure — don't block the candidate or burn their
      // time. Show a countdown anchored to now (display only — NOT persisted,
      // startedAt stays 0) and retry the anchor on the next activation. The
      // server clock is still unset, so no interview time is actually lost.
      getLogger()?.errorFromException("session_started_failed", err);
      sessionForTimer = { ...savedSession, startedAt: Date.now() };
    }
  }
  timer.start(sessionForTimer);
  // The previous on-branch chat log (.jivahire_chat_log.json) has been retired:
  // every chat exchange lives in `chat_exchanges` and every telemetry event in
  // `telemetry`, both authoritative on the server. Clean up any stale local
  // copy left over from older extension versions so it doesn't get swept into
  // an auto-commit.
  if (currentWs) {
    try { fs.unlinkSync(path.join(currentWs, ".jivahire_chat_log.json")); }
    catch { /* file not present — fine */ }
  }
  // Normal coding interview (no AI): leave the chat provider unconfigured so it
  // renders nothing, and don't set the AI-on context flag — the chat view stays
  // hidden (see the `when` clause on vibe.chat in package.json).
  if (savedSession.aiAssistance) {
    chatProvider.setConfig(savedSession);
  }
  dashboardProvider.setConfig(savedSession);
  // Drives the `when: vibe.session.active` clause on the vibe.chat view in
  // package.json — without this context flag, the chat view stays hidden
  // and the candidate sees only the dashboard in the secondary sidebar.
  void vscode.commands.executeCommand("setContext", "vibe.session.active", true);
  void vscode.commands.executeCommand("setContext", "vibe.aiAssistance", savedSession.aiAssistance === true);
  if (savedSession.meetLink) {
    void vscode.commands.executeCommand("setContext", "vibe.session.hasMeet", true);
  }
  try {
    _startSessionServices(savedSession, context, chatProvider);
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

/**
 * True iff `dir` is a healthy git checkout of `branch` that still has challenge
 * files on disk (not just the `.jivahire/` integrity marker). Decides whether an
 * existing `~/vibe-<id>` directory can be reused or must be re-cloned — adopting
 * a degraded/empty dir is how a candidate branch gets wiped by the next
 * `git add -A` auto-commit.
 */
function _isHealthyCheckout(dir: string, branch: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) return false;
    const onDisk = fs.readdirSync(dir).filter((n) => n !== ".git" && n !== ".jivahire");
    if (onDisk.length === 0) return false; // emptied checkout — only the marker remains
    const head = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdio: "pipe",
      shell: false,
    })
      .toString()
      .trim();
    return head === branch;
  } catch {
    return false;
  }
}

function _gitClone(session: SessionConfig, cloneDir: string): void {
  // Argv form — no shell interpolation. A hostile validate-session response
  // (branch name with quotes / shell metachars / token with $(...)) cannot
  // escape the argv slot into a shell. shell:false is the execFile default
  // but we pin it for clarity.
  const baseUrl = session.repoUrl.replace(/\.git$/, "");
  const authedUrl =
    baseUrl.replace("https://", `https://x-access-token:${session.githubToken}@`) + ".git";
  try {
    // Shallow, single-branch clone. The candidate branch is freshly created
    // server-side and they only ever work on its tip — full history is dead
    // weight that turns a slow-network clone into minutes. --depth 1 fetches
    // just the tip commit; --single-branch avoids pulling every other branch's
    // refs. Auto-commit's `git push` works fine from a shallow checkout.
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--single-branch", "-b", session.branch, authedUrl, cloneDir],
      { stdio: "pipe", shell: false }
    );
  } catch (err) {
    // git's stderr echoes the authenticated remote URL on failure ("Cloning
    // into 'https://x-access-token:<token>@github.com/...'"), so any error
    // surface — dialog, telemetry, support paste — would leak the token.
    // Rebuild the Error with the auth segment scrubbed before re-throwing.
    const raw = err instanceof Error ? (err.message ?? String(err)) : String(err);
    const stderr = (err as { stderr?: Buffer | string } | null)?.stderr;
    const stderrStr = stderr instanceof Buffer ? stderr.toString() : (stderr ?? "");
    throw new Error(redactGitAuth(`${raw}${stderrStr ? `\n${stderrStr}` : ""}`));
  }
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

function _startSessionServices(
  config: SessionConfig,
  context: vscode.ExtensionContext,
  chatProvider: ChatViewProvider,
): void {
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
  // (Run tests / AI chat / Submit status-bar buttons removed per UX request —
  // the dashboard panel exposes the same actions.)

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
        chatProvider.setOfflineState(false);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        consecutiveFailures += 1;
        getLogger()?.errorFromException("auto_commit_failed", err, { consecutiveFailures });
        if (consecutiveFailures >= 2) {
          const mins = Math.max(1, Math.round((Date.now() - lastSuccessAt) / 60_000));
          chatProvider.setOfflineState(
            true,
            `Auto-save offline — last successful save ${mins} minute${mins === 1 ? "" : "s"} ago. Check your network.`,
          );
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
    if (_stopAutoCommit === stop) _stopAutoCommit = undefined;
  };
  _stopAutoCommit = stop;
  context.subscriptions.push({ dispose: stop });

  // ── Interview-integrity canary ────────────────────────────────────────────
  // The candidate branch ships a `.jivahire/telemetry.jsonl` marker (planted by
  // the server at branch creation). Deleting it — or the whole `.jivahire`
  // folder — is a tamper signal: the session is FLAGGED as invalid (with a
  // stored reason the recruiter sees), but the candidate is allowed to keep
  // working. We also warn the candidate up front not to delete it.
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws) {
    const canaryAbs = path.join(ws, ".jivahire", "telemetry.jsonl");
    // Up-front warning: there's no OS hook to intercept the delete itself, so
    // we tell the candidate before it can happen what the consequence is.
    void vscode.window.showWarningMessage(
      "Do not delete the .jivahire/telemetry.jsonl file or the .jivahire folder — " +
      "doing so will mark your interview session as invalid (you can keep working, " +
      "but the recruiter will see it was flagged).",
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(ws, ".jivahire/**"),
      true,  // ignoreCreate
      true,  // ignoreChange
      false, // watch deletes
    );
    let flagged = false;
    watcher.onDidDelete(async () => {
      // Act only when the marker itself is actually gone — unrelated churn
      // inside `.jivahire/` must be ignored. Flag once; the server is
      // idempotent, but a re-fire shouldn't re-nag the candidate.
      if (flagged || fs.existsSync(canaryAbs)) return;
      flagged = true;
      tracker.emit("integrity_marker_deleted", {});
      await _flagSessionTampered(config);
    });
    context.subscriptions.push(watcher);
  }

  _scheduleTokenRefresh(config, context);
}

/**
 * Flag a session as integrity-violated after the candidate deleted the
 * `.jivahire/telemetry.jsonl` marker. Reports it to the server (best-effort)
 * so the recruiter dashboard shows the tamper with a stored reason, then tells
 * the candidate — but does NOT end the session: the timer, AI chat,
 * auto-commit and submit all keep running so the candidate can continue.
 */
async function _flagSessionTampered(config: SessionConfig): Promise<void> {
  try {
    await invalidateSession(
      config,
      "Candidate deleted the interview integrity file (.jivahire/telemetry.jsonl).",
    );
  } catch (e) {
    getLogger()?.errorFromException("invalidate_session_failed", e);
  }
  await vscode.window.showWarningMessage(
    "Interview session marked invalid",
    {
      modal: true,
      detail:
        "The interview integrity file (.jivahire/telemetry.jsonl) was deleted, so this " +
        "session has been marked invalid for the recruiter. You can keep working and " +
        "submit as normal.\n\nContact your recruiter if you believe this is a mistake.",
    },
    "OK",
  );
}

/**
 * Arm a self-rescheduling timer that swaps `config.githubToken` for a fresh
 * installation token shortly before expiry. The auto-commit closure and the
 * submit handler both read `config.githubToken` at call time, so mutating
 * the in-memory config object is sufficient — no need to rebuild them.
 *
 * Why a single setTimeout rather than setInterval: every refresh returns a
 * new `expiresAt`, and we want the next refresh anchored to THAT, not to a
 * fixed 50-minute drum that drifts away from GitHub's actual TTL over a
 * long session.
 */
function _scheduleTokenRefresh(
  config: SessionConfig,
  context: vscode.ExtensionContext,
): void {
  // Tear down any prior timer (e.g. window reload while a refresh was queued).
  _stopTokenRefresh?.();
  let stopped = false;
  let handle: NodeJS.Timeout | undefined;

  const computeDelay = (): number => {
    if (!config.githubTokenExpiresAt) return TOKEN_REFRESH_FALLBACK_MS;
    const ms = config.githubTokenExpiresAt - Date.now() - TOKEN_REFRESH_LEAD_MS;
    return Math.max(ms, TOKEN_REFRESH_MIN_DELAY_MS);
  };

  const tick = async () => {
    if (stopped) return;
    const serverUrl =
      context.globalState.get<string>(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL;
    try {
      const fresh = await refreshGithubToken(serverUrl, config.sessionKey);
      // Mutate in place — auto-commit / submit read this value fresh on every
      // git invocation, so they pick up the new token without any wiring.
      config.githubToken = fresh.token;
      config.githubTokenExpiresAt = fresh.expiresAt;
      // Persist so a window reload restores the fresh token, not the stale
      // one from the original validate-session response.
      await context.globalState.update(SESSION_KEY, config);
      getLogger()?.info("github_token_refreshed", {
        expiresAtUnix: Math.floor(fresh.expiresAt / 1000),
      });
    } catch (err) {
      // Don't block the session — the previous token is still valid for a
      // few more minutes (TOKEN_REFRESH_LEAD_MS), so an auto-commit can still
      // succeed. Try again sooner. Telemetry only; no candidate-facing dialog
      // (which would just confuse them — there's nothing for them to do).
      getLogger()?.errorFromException("github_token_refresh_failed", err);
    } finally {
      if (!stopped) {
        handle = setTimeout(tick, computeDelay());
      }
    }
  };

  handle = setTimeout(tick, computeDelay());

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (handle) clearTimeout(handle);
    if (_stopTokenRefresh === stop) _stopTokenRefresh = undefined;
  };
  _stopTokenRefresh = stop;
  context.subscriptions.push({ dispose: stop });
}

interface DepCheckResult {
  name: string;
  minVersion?: string;
  check: string;
  ok: boolean;
  install?: Dependency["install"];
}

// A dependency `check` is a server-supplied string from the challenge's
// metadata.json. Restrict it to a simple `<tool> <flag>...` shape (alnum, dot,
// plus, dash, underscore tokens separated by single spaces) and run it WITHOUT
// a shell, so a compromised metadata source can't inject arbitrary commands
// onto the candidate's machine.
const _SAFE_CHECK = /^[\w.+-]+( [\w.+-]+)*$/;

// Pick the install hint for the candidate's OS, if the challenge provides one.
function _installHint(install?: Dependency["install"]): string | undefined {
  if (!install) return undefined;
  if (process.platform === "darwin") return install.macos;
  if (process.platform === "win32") return install.windows;
  return install.debian;
}

function runDependencyChecks(deps: Dependency[]): DepCheckResult[] {
  return deps.map((dep) => {
    const check = (dep.check ?? "").trim();
    const base = {
      name: dep.name,
      minVersion: dep.minVersion,
      check,
      install: dep.install,
    };
    if (!_SAFE_CHECK.test(check)) {
      return { ...base, ok: false };
    }
    const [bin, ...args] = check.split(/\s+/);
    try {
      execFileSync(bin, args, { stdio: "pipe", shell: false, timeout: 5000 });
      return { ...base, ok: true };
    } catch {
      return { ...base, ok: false };
    }
  });
}

/**
 * Show the candidate the challenge's language + required tooling (with a live
 * ✓/✗ install check) BEFORE the session is activated. Returns true iff they
 * confirm — only then do we validate-session (which starts the timer) and clone.
 */
async function confirmToolingAndStart(info: SessionPreflight): Promise<boolean> {
  const results = runDependencyChecks(info.dependencies);
  const anyMissing = results.some((r) => !r.ok);
  const language = info.language && info.language !== "unknown" ? info.language : "unknown";

  const toolLines = results.length
    ? results
        .map((r) => {
          const ver = r.minVersion ? ` (≥ ${r.minVersion})` : "";
          let line = `${r.ok ? "✓" : "✗"}  ${r.name}${ver}   (${r.check})`;
          if (!r.ok) {
            const hint = _installHint(r.install);
            if (hint) line += `\n      install: ${hint}`;
          }
          return line;
        })
        .join("\n")
    : "No additional tooling required.";
  const autoLine = info.autoFetched.length
    ? `\n\nFetched automatically by the build (no install needed):\n${info.autoFetched
        .map((s) => `• ${s}`)
        .join("\n")}`
    : "";
  const footer = anyMissing
    ? "Some tools are missing. Install them now, then click Continue — the timer starts only when you continue."
    : "The timer starts when you click Continue.";
  const detail = `Challenge language: ${language}\n\n${toolLines}${autoLine}\n\n${footer}`;

  const message = anyMissing
    ? "Missing required tools for this challenge"
    : "Ready to start — your toolchain looks good";
  const picker = anyMissing
    ? vscode.window.showWarningMessage
    : vscode.window.showInformationMessage;
  const choice = await picker(message, { modal: true, detail }, "Continue & Start");
  return choice === "Continue & Start";
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
    // Preflight first: surface the challenge's language + required toolchain
    // (with a live install check) and let the candidate confirm BEFORE we
    // validate-session, which activates the session and starts the timer.
    const preflight = await preflightSession(serverUrl, sessionKey);
    const proceed = await confirmToolingAndStart(preflight);
    if (!proceed) {
      // Candidate dismissed the dialog — nothing started server-side. Re-enable
      // the welcome form so they can retry or fix their environment.
      dashboardProvider.resetWelcomeEntry();
      return;
    }

    const config = await validateSession(serverUrl, sessionKey);
    await context.globalState.update(SESSION_KEY, config);
    await context.globalState.update(SERVER_URL_KEY, serverUrl);

    // Key the clone dir on the FULL session id. The old `slice(0, 8)` risked two
    // sessions colliding on the same `~/vibe-<8hex>` path, and the existence
    // check below would then silently adopt the wrong session's directory.
    const cloneDir = path.join(os.homedir(), `vibe-${config.sessionId}`);
    // Only reuse an existing dir if it's a healthy checkout of this branch with
    // challenge files still on disk. A degraded leftover (emptied checkout,
    // wrong branch, not a repo) must NOT be opened: the auto-commit would push
    // its emptiness over the candidate branch. The path is namespaced to this
    // session id, so replacing it can't touch another session's work.
    if (!_isHealthyCheckout(cloneDir, config.branch)) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "JivaHire: Cloning challenge…", cancellable: false },
        async () => {
          if (fs.existsSync(cloneDir)) {
            fs.rmSync(cloneDir, { recursive: true, force: true });
          }
          _gitClone(config, cloneDir);
        }
      );
    }

    // openFolder reloads the window; activate() will restore session from globalState
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cloneDir), false);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    getLogger()?.errorFromException("validate_session_failed", err);
    const display = message.replace(/^HTTP \d+:\s*/, "");
    vscode.window.showErrorMessage(`Could not start session: ${display}`);
    dashboardProvider.reportSessionError(display);
  }
}

export function deactivate(): void {}
