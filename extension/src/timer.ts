import { SessionConfig } from "./api";

export type TimerSeverity = "ok" | "warn" | "error";

export interface TimerTick {
  text: string;
  secondsLeft: number;
  severity: TimerSeverity;
  running: boolean;
}

export type TimerListener = (tick: TimerTick) => void;

const IDLE_TICK: TimerTick = { text: "--:--", secondsLeft: -1, severity: "ok", running: false };

export class Timer {
  private interval: ReturnType<typeof setInterval> | undefined;
  private listeners: TimerListener[] = [];
  private lastTick: TimerTick = IDLE_TICK;

  onTick(listener: TimerListener): void {
    this.listeners.push(listener);
    listener(this.lastTick);
  }

  start(config: SessionConfig): void {
    this.stop();
    const deadlineMs = config.startedAt + config.maxMinutes * 60 * 1000;
    this.interval = setInterval(() => this.tick(deadlineMs), 1000);
    this.tick(deadlineMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.lastTick.running) {
      this.lastTick = { ...this.lastTick, running: false };
      this.emit();
    }
  }

  dispose(): void {
    this.stop();
    this.listeners = [];
  }

  private tick(deadlineMs: number): void {
    const remaining = Math.max(0, deadlineMs - Date.now());
    const mins = Math.floor(remaining / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    const text = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    const severity: TimerSeverity =
      remaining < 2 * 60_000 ? "error" : remaining < 10 * 60_000 ? "warn" : "ok";
    this.lastTick = {
      text,
      secondsLeft: Math.floor(remaining / 1000),
      severity,
      running: remaining > 0,
    };
    this.emit();
    if (remaining === 0) this.stop();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.lastTick);
  }
}
