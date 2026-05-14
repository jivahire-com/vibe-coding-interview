import * as vscode from "vscode";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { SessionConfig, submitSession } from "./api";

const execFileAsync = promisify(execFile);

const GIT_EXEC_OPTS = (cwd: string) => ({
  cwd,
  stdio: "pipe" as const,
  // shell:false is the execFile default. We pin it explicitly to document the
  // security invariant: arguments must NOT be shell-interpreted, otherwise a
  // hostile server response (branch / repoUrl / token) becomes RCE.
  shell: false,
});

/**
 * Stub-able execFile so tests can mock it via jest.mock('child_process'). We
 * keep this separate from execFileAsync so synchronous flows (post-success
 * cleanup) and the existing test surface both work.
 */
function git(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, GIT_EXEC_OPTS(cwd));
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
  /** Clears the persisted session on successful submit. */
  onSubmitted?: () => Promise<void> | void;
  /** Stops the status-bar countdown timer. */
  onStopTimer?: () => void;
  /** Tells the dashboard to swap to read-only "Submitted" state. */
  onMarkSubmitted?: () => void;
}

export async function runSubmit(
  config: SessionConfig,
  deps: SubmitDeps = {}
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    "Submit your final answer? You won't be able to edit after.",
    { modal: true },
    "Submit"
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
      try {
        const ts = new Date().toISOString();
        gitCommitAndPush(ws, config, `submit: ${ts}`, true);
        await submitSession(config);
        // Bug fix: advance the IDLE → SUBMITTING → DONE state machine. Without
        // this, the candidate can keep using AI chat budget and resubmit after
        // the server has already marked the session DONE.
        deps.onStopTimer?.();
        await deps.onSubmitted?.();
        deps.onMarkSubmitted?.();
        vscode.window.showInformationMessage(
          "Submitted! Grading will appear in the recruiter dashboard shortly."
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Submit failed: ${msg}`);
      }
    }
  );
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
  const run = (args: string[]) => execFileAsync("git", args, GIT_EXEC_OPTS(ws));

  await run(["config", "user.email", "candidate@vibe-interview.local"]);
  await run(["config", "user.name", "Candidate"]);

  const authedUrl = buildAuthedRemoteUrl(config.repoUrl, config.githubToken);
  const unauthedUrl = buildUnauthedRemoteUrl(config.repoUrl);

  if (!allowEmpty) {
    const { stdout } = await run(["status", "--porcelain"]);
    if (!stdout.trim()) return;
  }

  await run(["remote", "set-url", "origin", authedUrl]);
  try {
    const commitArgs = ["commit", "-m", message];
    if (allowEmpty) commitArgs.push("--allow-empty");
    await run(["add", "-A"]);
    await run(commitArgs);
    await run(["push"]);
  } finally {
    try { await run(["remote", "set-url", "origin", unauthedUrl]); }
    catch { /* swallow */ }
  }
}
