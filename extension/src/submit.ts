import * as vscode from "vscode";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { SessionConfig, submitSession, videoBrowserLink } from "./api";
import { getLogger } from "./logger";

const execFileAsync = promisify(execFile);

/**
 * Serializes every git operation in this module. The 3-minute auto-commit
 * (gitCommitAndPushAsync) and the manual submit (gitCommitAndPush, invoked
 * from runSubmit) both mutate the SAME working tree and the SAME `origin`
 * remote URL. Run concurrently they race two ways:
 *   1. Two git processes collide on `.git/index.lock` ("Unable to create
 *      '.git/index.lock': File exists"), so one of them dies.
 *   2. One path's `finally` restores the *unauthenticated* remote URL between
 *      the other path's `set-url <authed>` and its `git push`, so the push
 *      goes out unauthenticated and the server rejects it.
 * Either way the first submit that lands during an auto-commit throws, surfaces
 * the opaque "Submit failed" toast, and only succeeds on the retry once the
 * collision window has passed. The mutex makes the two paths take turns, so a
 * submit either runs before or strictly after any auto-commit — never atop it.
 */
let _gitLock: Promise<void> = Promise.resolve();
export function _acquireGitLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = _gitLock;
  // The next holder can't start until `next` resolves (i.e. release() is
  // called), which can't happen until `prior` has resolved and handed out this
  // release fn. That chaining is what enforces FIFO mutual exclusion.
  _gitLock = prior.then(() => next);
  return prior.then(() => release);
}

const GIT_EXEC_OPTS = (cwd: string) => ({
  cwd,
  stdio: "pipe" as const,
  // shell:false is the execFile default. We pin it explicitly to document the
  // security invariant: arguments must NOT be shell-interpreted, otherwise a
  // hostile server response (branch / repoUrl / token) becomes RCE.
  shell: false,
});

/**
 * Strip `user:token@host` credentials from any string. Applied to all git
 * error output before it reaches dialogs, logs, or telemetry — git embeds the
 * authenticated remote URL in its stderr on clone/push failure and the token
 * would otherwise leak to the candidate (who can screenshot it) and to any
 * downstream error sink.
 */
export function redactGitAuth(s: string): string {
  return s.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1***:***@");
}

function _redactedExecError(args: string[], err: unknown): Error {
  const raw = err instanceof Error ? (err.message ?? String(err)) : String(err);
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr;
  const stderrStr = stderr instanceof Buffer ? stderr.toString() : (stderr ?? "");
  const cleaned = redactGitAuth(`${raw}${stderrStr ? `\n${stderrStr}` : ""}`);
  // Rebuild Error so callers can't accidentally re-leak via err.stderr or err.cmd.
  const out = new Error(cleaned);
  (out as Error & { gitArgs?: string[] }).gitArgs = args;
  return out;
}

/**
 * Stub-able execFile so tests can mock it via jest.mock('child_process'). We
 * keep this separate from execFileAsync so synchronous flows (post-success
 * cleanup) and the existing test surface both work.
 */
function git(args: string[], cwd: string): Buffer {
  try {
    return execFileSync("git", args, GIT_EXEC_OPTS(cwd));
  } catch (err) {
    throw _redactedExecError(args, err);
  }
}

/** Build an authenticated clone URL without shell interpolation. */
export function buildAuthedRemoteUrl(repoUrl: string, token: string): string {
  const baseUrl = repoUrl.replace(/\.git$/, "");
  // GitHub accepts `https://x-access-token:<token>@github.com/...` for short-
  // lived installation tokens. The token is *embedded* in the URL but we never
  // shell-interpolate it, so a token containing shell metachars cannot escape.
  return baseUrl.replace("https://", `https://x-access-token:${token}@`) + ".git";
}

export function buildUnauthedRemoteUrl(repoUrl: string): string {
  return repoUrl.replace(/\.git$/, "") + ".git";
}

export interface SubmitDeps {
  /** Stops the countdown timer on successful submit. */
  onStopTimer?: () => void;
  /** Clears the persisted session on successful submit. */
  onSubmitted?: () => Promise<void> | void;
  /** Tells the dashboard to swap to read-only "Submitted" state. */
  onMarkSubmitted?: () => void;
  /**
   * Surface a browser-recording link in the dashboard. VS Code webviews can
   * not access camera/mic, so the only working recording path is for the
   * candidate to open the link in a real browser (or on a phone).
   */
  onShowVideoLink?: (url: string, expiresUnix: number) => void;
}

export async function runSubmit(
  config: SessionConfig,
  deps: SubmitDeps = {}
): Promise<void> {
  const remainingMs = config.startedAt + config.maxMinutes * 60_000 - Date.now();
  const remainingMin = Math.max(0, Math.round(remainingMs / 60_000));
  const detail = `${remainingMin} min remaining. Tests: status unknown.`;
  // Default focus goes to the FIRST item — keep "Submit" away from the front
  // unless the candidate is clearly out of time (<=5 min left).
  const submitFirst = remainingMs <= 5 * 60_000;
  const buttons = submitFirst ? ["Submit", "Cancel"] : ["Cancel", "Submit"];
  const confirm = await vscode.window.showWarningMessage(
    "Submit your final answer? You won't be able to edit after.",
    { modal: true, detail },
    ...buttons
  );
  if (confirm !== "Submit") return;

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "JivaHire: Submitting…" },
    async () => {
      const log = getLogger();
      log?.info("submit_started", { challengeId: config.challengeId });
      try {
        const ts = new Date().toISOString();
        // Take the git mutex so the final commit/push can't race an in-flight
        // auto-commit (which would collide on `.git/index.lock` or clobber the
        // authed remote URL mid-push). The lock is released before the network
        // submit so an auto-commit isn't blocked on a slow POST.
        const releaseLock = await _acquireGitLock();
        try {
          gitCommitAndPush(ws, config, `submit: ${ts}`, true);
        } finally {
          releaseLock();
        }
        const resp = await submitSession(config);
        log?.info("submit_succeeded", { hasVideoUpload: !!resp.video_upload });
        // Bug fix: advance the IDLE → SUBMITTING → DONE state machine. Without
        // this, the candidate can keep using AI chat budget and resubmit after
        // the server has already marked the session DONE.
        await deps.onSubmitted?.();
        deps.onMarkSubmitted?.();
        vscode.window.showInformationMessage(
          "Submitted! Grading will appear in the recruiter dashboard shortly."
        );
        // Post-submit identity-verification video. Server gates this behind a
        // config check and returns `video_upload` only when S3/CloudFront are
        // configured. Recording is optional and runs in parallel with grading.
        // We mint a browser-recording link and surface it in the dashboard —
        // the candidate opens it in a real browser (camera/mic do not work
        // inside VS Code webviews). Errors are swallowed: never block submit.
        if (resp.video_upload && deps.onShowVideoLink) {
          try {
            const link = await videoBrowserLink(config);
            deps.onShowVideoLink(link.url, link.expires_unix);
          } catch (e) {
            log?.errorFromException("video_link_mint_failed", e);
          }
        }
      } catch (err: unknown) {
        // A 409 means the server no longer considers the session `active` —
        // almost always because the auto-submit sweep already submitted it the
        // moment the timer expired (or the candidate double-submitted). The
        // work is captured and grading is queued, so this is a successful
        // terminal state, NOT a failure. Run the same DONE-state cleanup the
        // happy path runs and tell the candidate what actually happened,
        // instead of the opaque "Submit failed. Contact your recruiter" toast.
        if (_httpStatus(err) === 409) {
          log?.info("submit_already_submitted");
          await deps.onSubmitted?.();
          deps.onMarkSubmitted?.();
          vscode.window.showInformationMessage(
            "Your interview was already submitted — time ran out and it was " +
            "submitted automatically. Your work is being graded; results will " +
            "appear in the recruiter dashboard shortly."
          );
          return;
        }
        log?.errorFromException("submit_failed", err);
        vscode.window.showErrorMessage(_friendlyErrorMessage(err, "submit"));
      }
    }
  );
}

/**
 * Extract an `HTTP <nnn>` status code from an error raised by api.post(), which
 * formats network errors as `HTTP <status>: <detail>`. Returns undefined for
 * non-HTTP errors (e.g. a git failure, a timeout).
 */
export function _httpStatus(err: unknown): number | undefined {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/HTTP\s+(\d{3})/i);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Translate raw runtime errors into candidate-facing English. Used at the
 * submit POST site and the test-runner site so candidates never see
 * `ECONNREFUSED`, `Command failed: …`, or stack-trace fragments.
 */
export function _friendlyErrorMessage(
  err: unknown,
  context: "submit" | "tests"
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const contextLabel = context === "submit" ? "Submit" : "Tests";

  if (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET/i.test(raw) ||
    /timed out/i.test(lower)
  ) {
    return "Couldn't reach the JivaHire server — check your network and try again.";
  }

  const httpMatch = raw.match(/HTTP\s+(\d{3})/i);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    if (status === 401 || status === 403) {
      return "Session expired — re-enter your session key.";
    }
    if (status === 409) {
      // The session is no longer accepting submissions — typically it was
      // auto-submitted when the timer expired. Reassure rather than alarm.
      return "This interview was already submitted — your work is being graded. " +
        "Check the recruiter dashboard for results.";
    }
    if (status >= 500 && status < 600) {
      return "Server is temporarily unavailable — wait and retry.";
    }
    if (status >= 400 && status < 500) {
      return `${contextLabel} failed. Contact your recruiter if this persists.`;
    }
  }

  if (context === "tests" && /Command failed|spawn|ENOENT/i.test(raw)) {
    return "Tests didn't run — your environment may be missing a dependency.";
  }

  return `${contextLabel} failed. Contact your recruiter if this persists.`;
}

/**
 * Commit all changes and push to origin using the session's GitHub token.
 *
 * Security invariants:
 *  - Repo URL, branch, token, and commit message are passed as separate argv
 *    to execFileSync; no shell interpolation happens. A hostile server
 *    response cannot escape into the command line.
 *  - The authenticated remote URL is restored to its unauthenticated form in
 *    a finally block, so a `git push` failure cannot leave the GitHub token
 *    embedded in `.git/config` (which the next auto-commit would then push to
 *    the candidate's branch).
 *
 * @param allowEmpty - pass true for final submit, false for auto-commits.
 */
export function gitCommitAndPush(
  ws: string,
  config: SessionConfig,
  message: string,
  allowEmpty: boolean
): void {
  git(["config", "user.email", "candidate@vibe-interview.local"], ws);
  git(["config", "user.name", "Candidate"], ws);

  const authedUrl = buildAuthedRemoteUrl(config.repoUrl, config.githubToken);
  const unauthedUrl = buildUnauthedRemoteUrl(config.repoUrl);

  if (!allowEmpty) {
    const status = git(["status", "--porcelain"], ws).toString().trim();
    if (!status) return;
  }

  git(["remote", "set-url", "origin", authedUrl], ws);
  try {
    const commitArgs = ["commit", "-m", message];
    if (allowEmpty) commitArgs.push("--allow-empty");
    git(["add", "-A"], ws);
    git(commitArgs, ws);
    git(["push"], ws);
  } finally {
    // ALWAYS restore the unauthenticated URL, even if commit/push throws.
    // Otherwise the token persists in `.git/config` and gets auto-committed
    // by the next 3-minute cycle, leaking it to the candidate's branch.
    try { git(["remote", "set-url", "origin", unauthedUrl], ws); }
    catch { /* swallow — best-effort cleanup */ }
  }
}

/**
 * Async variant of {@link gitCommitAndPush} for use from the auto-commit
 * interval. `git push` can take many seconds over slow networks; running it
 * synchronously on the extension host blocks every other UI interaction
 * (typing telemetry, timer ticks, webview updates) for the duration.
 */
export async function gitCommitAndPushAsync(
  ws: string,
  config: SessionConfig,
  message: string,
  allowEmpty: boolean
): Promise<void> {
  // Take the git mutex so this auto-commit can never interleave with a manual
  // submit (or another auto-commit) on the same repo. See `_acquireGitLock`.
  const releaseLock = await _acquireGitLock();
  try {
    const run = async (args: string[]) => {
      try {
        return await execFileAsync("git", args, GIT_EXEC_OPTS(ws));
      } catch (err) {
        throw _redactedExecError(args, err);
      }
    };

    await run(["config", "user.email", "candidate@vibe-interview.local"]);
    await run(["config", "user.name", "Candidate"]);

    const authedUrl = buildAuthedRemoteUrl(config.repoUrl, config.githubToken);
    const unauthedUrl = buildUnauthedRemoteUrl(config.repoUrl);

    // Bug fix: if a previous tick committed but failed to push (network blip,
    // token race), the working tree is clean on the next tick — the old code
    // returned early and the local commit was never pushed. The grader then
    // saw a stale remote branch. Detect "local ahead of upstream" and push
    // even when there are no working-tree changes to commit.
    let needPushOnly = false;
    if (!allowEmpty) {
      const { stdout } = await run(["status", "--porcelain"]);
      if (!stdout.trim()) {
        const aheadCount = await _countAheadOfUpstreamAsync(run);
        if (aheadCount > 0) {
          needPushOnly = true;
        } else {
          return;
        }
      }
    }

    await run(["remote", "set-url", "origin", authedUrl]);
    try {
      if (!needPushOnly) {
        const commitArgs = ["commit", "-m", message];
        if (allowEmpty) commitArgs.push("--allow-empty");
        await run(["add", "-A"]);
        await run(commitArgs);
      }
      await run(["push"]);
    } finally {
      try { await run(["remote", "set-url", "origin", unauthedUrl]); }
      catch { /* swallow */ }
    }
  } finally {
    releaseLock();
  }
}

/**
 * Returns the number of local commits ahead of the upstream tracking branch.
 * Returns 0 when there is no upstream configured (the call errors and we
 * conservatively report 0 — nothing to retry in that case).
 */
async function _countAheadOfUpstreamAsync(
  run: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<number> {
  try {
    const { stdout } = await run(["rev-list", "--count", "@{u}..HEAD"]);
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
