import * as vscode from "vscode";
import { execSync } from "child_process";
import { SessionConfig, submitSession } from "./api";

export async function runSubmit(config: SessionConfig): Promise<void> {
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
        vscode.window.showInformationMessage(
          "Submitted! Grading will appear in the recruiter dashboard shortly."
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Submit failed: ${err.message}`);
      }
    }
  );
}

/**
 * Commit all changes and push to origin using the session's GitHub token.
 * @param allowEmpty - pass true for final submit, false for auto-commits (skip if nothing changed)
 */
export function gitCommitAndPush(
  ws: string,
  config: SessionConfig,
  message: string,
  allowEmpty: boolean
): void {
  execSync(`git config user.email "candidate@vibe-interview.local"`, { cwd: ws, stdio: "pipe" });
  execSync(`git config user.name "Candidate"`, { cwd: ws, stdio: "pipe" });
  const authedUrl =
    config.repoUrl.replace("https://", `https://x-access-token:${config.githubToken}@`) + ".git";
  execSync(`git remote set-url origin "${authedUrl}"`, { cwd: ws, stdio: "pipe" });

  if (!allowEmpty) {
    const status = execSync("git status --porcelain", { cwd: ws }).toString().trim();
    if (!status) return; // nothing to commit
  }

  execSync(
    `git add -A && git commit -m "${message}"${allowEmpty ? " --allow-empty" : ""}`,
    { cwd: ws, stdio: "pipe" }
  );
  execSync("git push", { cwd: ws, stdio: "pipe" });
}
