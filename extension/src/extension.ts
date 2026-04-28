import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";
import { validateSession, SessionConfig } from "./api";
import { Timer } from "./timer";
import { WelcomePanel } from "./welcome/panel";
import { ChatViewProvider } from "./chat/view";
import { runSubmit, gitCommitAndPush } from "./submit";
import { TelemetryTracker } from "./telemetry";
import { AiProposedContentProvider, AI_PROPOSED_SCHEME, applyCodeBlock, setTelemetryCallback } from "./chat/apply";

const SESSION_KEY = "vibe.session";
const SERVER_URL_KEY = "vibe.serverUrl";
const DEFAULT_SERVER_URL = "http://localhost:8080";
const AUTO_COMMIT_INTERVAL_MS = 180_000; // 3 minutes

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const timer = new Timer();
  const chatProvider = new ChatViewProvider(context);

  // Register the content provider for the diff editor (AI proposed side)
  const aiContentProvider = new AiProposedContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(AI_PROPOSED_SCHEME, aiContentProvider),
    vscode.window.registerWebviewViewProvider("vibe.chat", chatProvider)
  );

  // Restore session from previous run
  const savedSession = context.globalState.get<SessionConfig>(SESSION_KEY);
  if (savedSession) {
    const cloneDir = path.join(os.homedir(), `vibe-${savedSession.sessionId.slice(0, 8)}`);
    if (!fs.existsSync(cloneDir)) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "JivaHire: Cloning challenge…", cancellable: false },
        async () => {
          execSync(`git clone -b "${savedSession.branch}" "${savedSession.repoUrl}.git" "${cloneDir}"`, { stdio: "pipe" });
        }
      );
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cloneDir), false);
      return;
    }
    timer.start(savedSession);
    chatProvider.setConfig(savedSession);
    WelcomePanel.show(savedSession, context);
    _startSessionServices(savedSession, context);
  } else {
    WelcomePanel.showOnboarding(context);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("vibe.enterSessionKey", () =>
      promptForSession(context, timer, chatProvider)
    ),
    vscode.commands.registerCommand("vibe.showBrief", () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (config) WelcomePanel.show(config, context);
    }),
    vscode.commands.registerCommand("vibe.runTests", () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (config) WelcomePanel.show(config, context);
    }),
    vscode.commands.registerCommand("vibe.submit", async () => {
      const config = context.globalState.get<SessionConfig>(SESSION_KEY);
      if (!config) { vscode.window.showErrorMessage("No active session."); return; }
      await runSubmit(config);
    }),
    vscode.commands.registerCommand("vibe.applyCodeBlock", async (args: { filePath: string; codeText: string; blockId: string }) => {
      await applyCodeBlock(args.filePath, args.codeText, args.blockId);
    }),
    timer
  );
}

function _startSessionServices(config: SessionConfig, context: vscode.ExtensionContext): void {
  const tracker = new TelemetryTracker(config, context);
  context.subscriptions.push(tracker);

  // Wire apply.ts telemetry back to the tracker
  setTelemetryCallback((event_type, payload) => {
    tracker.emit(event_type, payload as Record<string, unknown>);
  });

  // Auto-commit every 3 minutes
  const autoCommitTimer = setInterval(() => {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) return;
    try {
      const ts = new Date().toISOString();
      gitCommitAndPush(ws, config, `auto: ${ts}`, false);
      tracker.emit("auto_commit", { ts });
    } catch {
      // Silently skip if nothing to commit or push fails
    }
  }, AUTO_COMMIT_INTERVAL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(autoCommitTimer) });
}

async function promptForSession(
  context: vscode.ExtensionContext,
  timer: Timer,
  chatProvider: ChatViewProvider
): Promise<void> {
  const serverUrl = await vscode.window.showInputBox({
    prompt: "JivaHire server URL",
    value: context.globalState.get<string>(SERVER_URL_KEY) ?? DEFAULT_SERVER_URL,
  });
  if (!serverUrl) return;

  const sessionKey = await vscode.window.showInputBox({
    prompt: "Enter your session key (provided by the recruiter)",
    placeHolder: "e.g. XYZ-123",
  });
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
          execSync(`git clone -b "${config.branch}" "${config.repoUrl}.git" "${cloneDir}"`, { stdio: "pipe" });
        }
      );
    }

    // openFolder reloads the window; activate() will restore session from globalState
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(cloneDir), false);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Could not start session: ${err.message}`);
  }
}

export function deactivate(): void {}
