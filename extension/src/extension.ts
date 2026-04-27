import * as vscode from "vscode";
import { validateSession, SessionConfig } from "./api";
import { Timer } from "./timer";
import { WelcomePanel } from "./welcome/panel";
import { ChatViewProvider } from "./chat/view";
import { runSubmit } from "./submit";

const SESSION_KEY = "vibe.session";
const SERVER_URL_KEY = "vibe.serverUrl";
const DEFAULT_SERVER_URL = "http://localhost:8080";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const timer = new Timer();
  const chatProvider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("vibe.chat", chatProvider)
  );

  // Restore session from previous run
  const savedSession = context.globalState.get<SessionConfig>(SESSION_KEY);
  if (savedSession) {
    timer.start(savedSession);
    chatProvider.setConfig(savedSession);
    WelcomePanel.show(savedSession, context);
  } else {
    promptForSession(context, timer, chatProvider);
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
    timer
  );
}

async function promptForSession(
  context: vscode.ExtensionContext,
  timer: Timer,
  chatProvider: ChatViewProvider
): Promise<void> {
  const serverUrl = await vscode.window.showInputBox({
    prompt: "Vibe server URL",
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
    timer.start(config);
    chatProvider.setConfig(config);
    WelcomePanel.show(config, context);
    vscode.window.showInformationMessage("Session started. Good luck!");
  } catch (err: any) {
    vscode.window.showErrorMessage(`Could not start session: ${err.message}`);
  }
}

export function deactivate(): void {}
