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
    { location: vscode.ProgressLocation.Notification, title: "Vibe: Submitting…" },
    async () => {
      try {
        const ts = new Date().toISOString();
        execSync(`git add -A && git commit -m "submit: ${ts}" --allow-empty`, {
          cwd: ws, stdio: "pipe",
        });
        execSync("git push", { cwd: ws, stdio: "pipe" });
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
