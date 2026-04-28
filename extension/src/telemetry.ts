import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { SessionConfig } from "./api";

interface TelemetryEvent {
  ts: number;
  event_type: string;
  payload: Record<string, unknown>;
}

const BUFFER_KEY = "vibe.telemetry.buffer";
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_THRESHOLD = 500;

// Tracks per-file typed-char aggregates flushed every ~1s
const _typedAgg: Map<string, { chars: number; timer: ReturnType<typeof setTimeout> }> = new Map();

// Flag set by apply.ts before WorkspaceEdit so the change-listener skips it
let _suppressNextApply = false;

export function suppressNextApplyEvent(): void {
  _suppressNextApply = true;
}

export class TelemetryTracker implements vscode.Disposable {
  private _buffer: TelemetryEvent[] = [];
  private _flushTimer: ReturnType<typeof setInterval> | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _config: SessionConfig;
  private _context: vscode.ExtensionContext;

  constructor(config: SessionConfig, context: vscode.ExtensionContext) {
    this._config = config;
    this._context = context;

    // Restore any buffered events from previous session
    const saved = context.globalState.get<TelemetryEvent[]>(BUFFER_KEY, []);
    this._buffer = saved;

    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this._onDocChange(e))
    );

    this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
  }

  emit(event_type: string, payload: Record<string, unknown>): void {
    this._buffer.push({ ts: Date.now(), event_type, payload });
    if (this._buffer.length >= FLUSH_THRESHOLD) {
      this._flush();
    }
  }

  private _onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const rel = path.relative(ws, e.document.uri.fsPath);
    if (rel.startsWith("..")) return; // outside workspace

    for (const change of e.contentChanges) {
      // Ignore undo/redo (no reliable way in VS Code API without tracking history)
      // Classify: large insertions with no selection = paste
      if (
        change.text.length >= 30 &&
        change.rangeLength === 0
      ) {
        if (_suppressNextApply) {
          _suppressNextApply = false;
          this.emit("edit_ai_applied", { file: rel, chars: change.text.length });
          continue;
        }
        this.emit("edit_pasted", { file: rel, chars: change.text.length });
      } else if (change.text.length > 0 || change.rangeLength > 0) {
        if (_suppressNextApply) {
          _suppressNextApply = false;
          this.emit("edit_ai_applied", { file: rel, chars: change.text.length });
          continue;
        }
        // Aggregate per-file to avoid one event per keystroke
        this._aggregateTyped(rel, change.text.length || change.rangeLength);
      }
    }
  }

  private _aggregateTyped(file: string, chars: number): void {
    const existing = _typedAgg.get(file);
    if (existing) {
      existing.chars += chars;
    } else {
      const timer = setTimeout(() => {
        const agg = _typedAgg.get(file);
        if (agg) {
          this.emit("edit_typed", { file, chars: agg.chars });
          _typedAgg.delete(file);
        }
      }, 1000);
      _typedAgg.set(file, { chars, timer });
    }
  }

  private _flush(): void {
    if (this._buffer.length === 0) return;
    const batch = this._buffer.splice(0, this._buffer.length);
    // Persist remainder to globalState (offline safety)
    this._context.globalState.update(BUFFER_KEY, this._buffer);

    this._post(batch).catch(() => {
      // Put failed events back at front of buffer
      this._buffer.unshift(...batch);
      this._context.globalState.update(BUFFER_KEY, this._buffer);
    });
  }

  private _post(events: TelemetryEvent[]): Promise<void> {
    const config = this._config;
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ events });
      const url = new URL(`${config.llmProxyUrl}/api/v1/telemetry`);
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
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
            if (res.statusCode && res.statusCode < 300) {
              this._context.globalState.update(BUFFER_KEY, []);
              resolve();
            } else {
              reject(new Error(`Telemetry HTTP ${res.statusCode}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  dispose(): void {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flush();
    for (const d of this._disposables) d.dispose();
    for (const agg of _typedAgg.values()) clearTimeout(agg.timer);
    _typedAgg.clear();
  }
}
