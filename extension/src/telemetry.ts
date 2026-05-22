import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { SessionConfig } from "./api";

interface TelemetryEvent {
  ts: number;
  event_type: string;
  payload: Record<string, unknown>;
  // Bug #12: a per-event identity so an unshift-on-failure cannot duplicate
  // an event that was already accepted by the server in a concurrent flush.
  id: string;
}

const BUFFER_KEY = "vibe.telemetry.buffer";
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_THRESHOLD = 500;
export const MAX_BUFFERED_EVENTS = 5000;
export const TELEMETRY_POST_TIMEOUT_MS = 15_000;
const CONSECUTIVE_FAIL_WARN_THRESHOLD = 3;

let _idCounter = 0;
function _nextId(): string {
  _idCounter += 1;
  return `${Date.now()}.${process.pid}.${_idCounter}`;
}

// Flag set by apply.ts before WorkspaceEdit so the change-listener skips it
let _suppressNextApply = false;

export function suppressNextApplyEvent(): void {
  _suppressNextApply = true;
}

// Set when the user invokes the paste command, consumed by the next doc change.
// The flag has a short freshness window so a stale paste signal (e.g. a paste
// into a non-editor input) can't get attributed to an unrelated later edit.
let _pasteImminentUntil = 0;
const PASTE_IMMINENT_WINDOW_MS = 500;
// Minimum insert size, after dropping the rangeLength===0 requirement, that we
// still treat as a paste based purely on size (covers pastes that bypass the
// command hook — e.g. middle-click paste on Linux).
const PASTE_SIZE_THRESHOLD = 10;

export class TelemetryTracker implements vscode.Disposable {
  private _buffer: TelemetryEvent[] = [];
  private _flushTimer: ReturnType<typeof setInterval> | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _config: SessionConfig;
  private _context: vscode.ExtensionContext;
  private _lastUnfocusedAt: number | null = null;
  private _justRefocusedUntil: number = 0;
  private _typedAgg: Map<string, { chars: number; timer: ReturnType<typeof setTimeout> }> = new Map();
  /** Bug #12: prevents overlapping flushes from double-sending the same batch. */
  private _flushInFlight = false;
  /** Dedup file_open events: emit once per file path per session. */
  private _openedFiles: Set<string> = new Set();
  private _consecutiveFailures = 0;
  private _networkWarningShown = false;

  constructor(config: SessionConfig, context: vscode.ExtensionContext) {
    this._config = config;
    this._context = context;

    // Restore any buffered events from previous session
    const saved = context.globalState.get<TelemetryEvent[]>(BUFFER_KEY, []);
    // Migration: older buffers may not have `id`. Assign synthetic ids so the
    // dedup logic still works for old events.
    this._buffer = saved.map((e) => (e.id ? e : { ...e, id: _nextId() }));

    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this._onDocChange(e)),
      vscode.window.onDidChangeWindowState((state) => this._onWindowState(state))
    );

    // Developer-signal telemetry: file navigation, debugger usage, test runs.
    // Each API is guarded so the tracker still works in environments where
    // they're absent (older VS Code, tests that don't stub them).
    if (vscode.window.onDidChangeActiveTextEditor) {
      this._disposables.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => this._onActiveEditor(editor))
      );
    }
    if (vscode.debug?.onDidStartDebugSession) {
      this._disposables.push(
        vscode.debug.onDidStartDebugSession((session) => this._onDebugSession(session))
      );
    }
    if ((vscode as any).tests?.onDidStartTestRun) {
      this._disposables.push(
        (vscode as any).tests.onDidStartTestRun((run: { name?: string }) => this._onTestRun(run))
      );
    }

    // Intercept the paste command so we get a deterministic paste signal —
    // VS Code's onDidChangeTextDocument otherwise can't distinguish paste from
    // type. We re-dispatch the original command immediately so paste still
    // happens; the flag is consumed by the next _onDocChange.
    if (vscode.commands?.registerCommand) {
      try {
        this._disposables.push(
          vscode.commands.registerCommand("vibe.interceptPaste", async () => {
            _pasteImminentUntil = Date.now() + PASTE_IMMINENT_WINDOW_MS;
            await vscode.commands.executeCommand("default:paste");
          })
        );
      } catch { /* command may already be registered in test harness */ }
    }

    this._flushTimer = setInterval(() => { void this._flush(); }, FLUSH_INTERVAL_MS);
  }

  emit(event_type: string, payload: Record<string, unknown>): void {
    this._buffer.push({ ts: Date.now(), event_type, payload, id: _nextId() });
    if (this._buffer.length >= FLUSH_THRESHOLD) {
      void this._flush();
    }
  }

  private _onActiveEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) return;
    if (editor.document.uri.scheme !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const rel = path.relative(ws, editor.document.uri.fsPath);
    if (rel.startsWith("..")) return; // outside workspace
    if (this._openedFiles.has(rel)) return;
    this._openedFiles.add(rel);
    this.emit("file_open", { file: rel });
  }

  private _onDebugSession(session: vscode.DebugSession): void {
    this.emit("debug_session", { type: session.type, name: session.name });
  }

  private _onTestRun(run: { name?: string }): void {
    this.emit("test_run", { profile: run?.name ?? "default" });
  }

  private _onWindowState(state: vscode.WindowState): void {
    if (!state.focused) {
      this._lastUnfocusedAt = Date.now();
      this.emit("app_unfocused", { ts: this._lastUnfocusedAt });
    } else if (this._lastUnfocusedAt !== null) {
      const time_away_seconds = (Date.now() - this._lastUnfocusedAt) / 1000;
      this._justRefocusedUntil = Date.now() + 3000;
      this._lastUnfocusedAt = null;
      this.emit("app_focused", { time_away_seconds });
    }
  }

  private _onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== "file") return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const rel = path.relative(ws, e.document.uri.fsPath);
    if (rel.startsWith("..")) return; // outside workspace

    for (const change of e.contentChanges) {
      // AI applies are flagged by apply.ts and take priority over paste/type.
      if (_suppressNextApply) {
        _suppressNextApply = false;
        this.emit("edit_ai_applied", { file: rel, chars: change.text.length });
        continue;
      }

      if (change.text.length === 0 && change.rangeLength === 0) continue;

      // Paste classification, in order of confidence:
      //  (a) the paste-command interceptor just fired — deterministic signal.
      //  (b) the insert spans multiple lines — typing produces one change per
      //      character, so multi-line inserts in a single change are virtually
      //      always paste, snippet expansion, or autocomplete.
      //  (c) the insert is at/above the size threshold — covers pastes that
      //      bypass the command hook (middle-click paste, drag-drop, etc.)
      //      AND pastes that replaced a selection (rangeLength > 0).
      const pasteImminent = Date.now() < _pasteImminentUntil;
      if (pasteImminent) _pasteImminentUntil = 0;
      const multiLineInsert = change.text.length > 0 && /\r?\n/.test(change.text);
      const isPaste =
        change.text.length > 0 &&
        (pasteImminent || multiLineInsert || change.text.length >= PASTE_SIZE_THRESHOLD);

      if (isPaste) {
        const suspicious_paste = Date.now() < this._justRefocusedUntil;
        this.emit("edit_pasted", { file: rel, chars: change.text.length, suspicious_paste });
      } else if (change.text.length > 0) {
        this._aggregateTyped(rel, change.text.length);
      }
    }
  }

  private _aggregateTyped(file: string, chars: number): void {
    const existing = this._typedAgg.get(file);
    if (existing) {
      existing.chars += chars;
    } else {
      const timer = setTimeout(() => {
        const agg = this._typedAgg.get(file);
        if (agg) {
          this.emit("edit_typed", { file, chars: agg.chars });
          this._typedAgg.delete(file);
        }
      }, 1000);
      this._typedAgg.set(file, { chars, timer });
    }
  }

  private async _flush(): Promise<void> {
    if (this._flushInFlight) return;
    if (this._buffer.length === 0) return;
    this._flushInFlight = true;
    const batch = this._buffer.splice(0, this._buffer.length);
    try {
      // Bug fix: AWAIT globalState.update so an extension-host crash mid-post
      // doesn't lose events that we'd already removed from in-memory state.
      await this._context.globalState.update(BUFFER_KEY, this._buffer);
      try {
        await this._post(batch);
        this._consecutiveFailures = 0;
        this._networkWarningShown = false;
      } catch {
        // Put failed events back at the front, but dedup against anything that
        // came in during the in-flight POST so we don't double-count.
        const seen = new Set(this._buffer.map((e) => e.id));
        const restored = batch.filter((e) => !seen.has(e.id));
        this._buffer = restored.concat(this._buffer);
        if (this._buffer.length > MAX_BUFFERED_EVENTS) {
          const dropped = this._buffer.length - MAX_BUFFERED_EVENTS;
          this._buffer.splice(0, dropped);
          console.warn(
            `[telemetry] buffer cap reached (${MAX_BUFFERED_EVENTS}); dropped ${dropped} oldest event(s)`
          );
        }
        await this._context.globalState.update(BUFFER_KEY, this._buffer);
        this._consecutiveFailures += 1;
        if (
          this._consecutiveFailures >= CONSECUTIVE_FAIL_WARN_THRESHOLD &&
          !this._networkWarningShown
        ) {
          this._networkWarningShown = true;
          void vscode.window.showWarningMessage(
            "JivaHire: your telemetry isn't reaching the server — check your network. Your work is still saved locally."
          );
        }
      }
    } finally {
      this._flushInFlight = false;
    }
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
            if (res.statusCode && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Telemetry HTTP ${res.statusCode}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(TELEMETRY_POST_TIMEOUT_MS, () => {
        try { req.destroy(); } catch { /* swallow */ }
        reject(new Error(`Telemetry POST timed out after ${TELEMETRY_POST_TIMEOUT_MS}ms`));
      });
      req.write(body);
      req.end();
    });
  }

  dispose(): void {
    if (this._flushTimer) clearInterval(this._flushTimer);
    // Bug fix: dispose() is synchronous so we cannot await the network flush.
    // Persist the un-posted buffer to globalState first so the next activate()
    // restore (telemetry.ts:50) picks it up — without this, events removed
    // from in-memory state during a final flush were lost when the host
    // exited mid-POST.
    //
    // Critical: we must snapshot the buffer before passing it to update(),
    // because the subsequent _flush() splices the in-memory buffer to zero.
    // Passing the live reference would defeat the persistence — the value
    // observed by the next activate() (or a test spy) would be the empty
    // post-splice array.
    try {
      const snapshot = this._buffer.slice();
      const result = this._context.globalState.update(BUFFER_KEY, snapshot);
      void Promise.resolve(result).catch(() => { /* swallow */ });
    } catch { /* swallow — best effort on shutdown */ }
    void this._flush().catch(() => { /* swallow */ });
    for (const d of this._disposables) d.dispose();
    for (const agg of this._typedAgg.values()) clearTimeout(agg.timer);
    this._typedAgg.clear();
  }
}
