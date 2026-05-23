import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import { SessionConfig } from "./api";

/**
 * Structured client-side logger. Mirrors the TelemetryBuffer pattern:
 *
 *   1. Each call appends a record to an in-memory buffer AND writes a human
 *      readable line to a VS Code OutputChannel for local debugging.
 *   2. Every 10s — or immediately on hitting 500 records — the buffer is
 *      flushed to `POST /api/v1/logs` on the JivaHire server. Records are
 *      stored in `app_logs`, alongside the server/worker JSON log streams.
 *   3. The buffer persists to `globalState` so an extension-host crash mid
 *      flow does not lose records (matches telemetry.ts behaviour).
 *
 * Logging without a session is allowed — records keep buffering until
 * `setSession()` is called, then drain on the next tick.
 *
 * This module is intentionally a standalone utility. Wiring it into
 * extension.ts (constructing it on activate, swapping `console.*` calls,
 * binding it through chat / telemetry / submit, etc.) is deferred to a
 * follow-up so we don't collide with parallel edits in those files.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

interface LogRecord {
  ts: number;
  level: LogLevel;
  message: string;
  logger?: string;
  context?: Record<string, unknown>;
  id: string;
}

const BUFFER_KEY = "vibe.logger.buffer";
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_THRESHOLD = 500;
export const MAX_BUFFERED_RECORDS = 5000;
export const LOG_POST_TIMEOUT_MS = 15_000;
const CONSECUTIVE_FAIL_WARN_THRESHOLD = 5;

let _idCounter = 0;
function _nextId(): string {
  _idCounter += 1;
  return `${Date.now()}.${process.pid}.${_idCounter}`;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

export class Logger implements vscode.Disposable {
  private _buffer: LogRecord[] = [];
  private _flushTimer: ReturnType<typeof setInterval> | undefined;
  private _channel: vscode.OutputChannel;
  private _config: SessionConfig | undefined;
  private _context: vscode.ExtensionContext;
  private _flushInFlight = false;
  private _consecutiveFailures = 0;
  private _minLevel: LogLevel = "DEBUG";

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._channel = vscode.window.createOutputChannel("JivaHire");
    // Restore offline-buffered records so they survive a crash / reload.
    const saved = context.globalState.get<LogRecord[]>(BUFFER_KEY, []);
    this._buffer = saved.map((r) => (r.id ? r : { ...r, id: _nextId() }));
    this._flushTimer = setInterval(() => { void this._flush(); }, FLUSH_INTERVAL_MS);
  }

  /** Attach a session so flushes can authenticate. Drains any buffered logs immediately. */
  setSession(config: SessionConfig): void {
    this._config = config;
    void this._flush();
  }

  clearSession(): void {
    this._config = undefined;
  }

  /** Drop records below the given level. Default: emit everything. */
  setLevel(level: LogLevel): void {
    this._minLevel = level;
  }

  /** Local-only view — useful for tests or `Output: JivaHire` pane. */
  get channel(): vscode.OutputChannel {
    return this._channel;
  }

  debug(message: string, context?: Record<string, unknown>): void { this._log("DEBUG", message, context); }
  info(message: string, context?: Record<string, unknown>): void { this._log("INFO", message, context); }
  warn(message: string, context?: Record<string, unknown>): void { this._log("WARNING", message, context); }
  error(message: string, context?: Record<string, unknown>): void { this._log("ERROR", message, context); }

  /** Convenience: log an Error with stack as structured context. */
  errorFromException(message: string, err: unknown, context?: Record<string, unknown>): void {
    const errCtx: Record<string, unknown> = { ...(context ?? {}) };
    if (err instanceof Error) {
      errCtx.error_class = err.name;
      errCtx.error_message = err.message;
      if (err.stack) errCtx.stack = err.stack;
    } else {
      errCtx.error_message = String(err);
    }
    this._log("ERROR", message, errCtx);
  }

  private _log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this._minLevel]) return;
    const record: LogRecord = { ts: Date.now(), level, message, context, id: _nextId() };
    const ctxStr = context ? " " + this._safeJson(context) : "";
    this._channel.appendLine(`[${new Date(record.ts).toISOString()}] ${level} ${message}${ctxStr}`);
    this._buffer.push(record);
    if (this._buffer.length >= FLUSH_THRESHOLD) void this._flush();
  }

  private _safeJson(obj: unknown): string {
    try { return JSON.stringify(obj); } catch { return "[unserializable]"; }
  }

  private async _flush(): Promise<void> {
    if (this._flushInFlight) return;
    if (!this._config) return;             // pre-auth — keep buffering
    if (this._buffer.length === 0) return;
    this._flushInFlight = true;
    const batch = this._buffer.splice(0, this._buffer.length);
    try {
      // Persist the now-shorter buffer before the network call so an
      // extension-host crash mid-POST cannot lose records that were already
      // moved out of the in-memory buffer (same hazard the TelemetryBuffer
      // documents at length).
      await this._context.globalState.update(BUFFER_KEY, this._buffer);
      try {
        await this._post(batch);
        this._consecutiveFailures = 0;
      } catch {
        // Restore the batch at the front, dedup against any new records that
        // were appended during the in-flight POST.
        const seen = new Set(this._buffer.map((r) => r.id));
        const restored = batch.filter((r) => !seen.has(r.id));
        this._buffer = restored.concat(this._buffer);
        if (this._buffer.length > MAX_BUFFERED_RECORDS) {
          const dropped = this._buffer.length - MAX_BUFFERED_RECORDS;
          this._buffer.splice(0, dropped);
          this._channel.appendLine(
            `[logger] buffer cap reached (${MAX_BUFFERED_RECORDS}); dropped ${dropped} oldest record(s)`
          );
        }
        await this._context.globalState.update(BUFFER_KEY, this._buffer);
        this._consecutiveFailures += 1;
        if (this._consecutiveFailures === CONSECUTIVE_FAIL_WARN_THRESHOLD) {
          // Surface a single warning in the channel rather than nagging the
          // candidate with a toast — logs failing is rarely user-actionable
          // and the telemetry buffer already shows a network warning toast.
          this._channel.appendLine(
            `[logger] failed to flush ${this._consecutiveFailures} times in a row — check the server`
          );
        }
      }
    } finally {
      this._flushInFlight = false;
    }
  }

  private _post(records: LogRecord[]): Promise<void> {
    const config = this._config;
    if (!config) return Promise.reject(new Error("no session"));
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ records });
      const url = new URL(`${config.llmProxyUrl}/api/v1/logs`);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${config.sessionKey}`,
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => {
            if (res.statusCode && res.statusCode < 300) resolve();
            else reject(new Error(`Logs HTTP ${res.statusCode}`));
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(LOG_POST_TIMEOUT_MS, () => {
        try { req.destroy(); } catch { /* swallow */ }
        reject(new Error(`Logs POST timed out after ${LOG_POST_TIMEOUT_MS}ms`));
      });
      req.write(body);
      req.end();
    });
  }

  dispose(): void {
    if (this._flushTimer) clearInterval(this._flushTimer);
    // Snapshot the buffer to globalState before the (best-effort) async
    // flush — dispose() is synchronous, so we cannot await the network. If
    // the host exits mid-POST, the next activate() restores from this.
    try {
      const snapshot = this._buffer.slice();
      void Promise.resolve(this._context.globalState.update(BUFFER_KEY, snapshot)).catch(() => {});
    } catch { /* swallow */ }
    void this._flush().catch(() => {});
    this._channel.dispose();
  }
}
