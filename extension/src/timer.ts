import * as vscode from "vscode";
import { SessionConfig } from "./api";

export class Timer {
  private bar: vscode.StatusBarItem;
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.bar.command = "vibe.showBrief";
  }

  start(config: SessionConfig): void {
    this.stop();
    const deadlineMs = config.startedAt + config.maxMinutes * 60 * 1000;
    this.interval = setInterval(() => this.tick(deadlineMs), 1000);
    this.tick(deadlineMs);
    this.bar.show();
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = undefined; }
    this.bar.hide();
  }

  dispose(): void {
    this.stop();
    this.bar.dispose();
  }

  private tick(deadlineMs: number): void {
    const remaining = Math.max(0, deadlineMs - Date.now());
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    const label = `$(clock) ${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")} remaining`;
    this.bar.text = label;
    this.bar.backgroundColor =
      remaining < 2 * 60_000
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : remaining < 10 * 60_000
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    if (remaining === 0) this.stop();
  }
}
