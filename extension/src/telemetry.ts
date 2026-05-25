import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SessionConfig } from "./api";
import { getLogger } from "./logger";

interface TelemetryEvent {
  ts: number;
  event_type: string;
  payload: Record<string, unknown>;
  id: string;
}

// Kept for one-time migration of events stranded in globalState from the old
// HTTP-POST extension. Delete this key and the constructor migration block in
// a follow-up release once all active sessions have upgraded.
const _LEGACY_BUFFER_KEY = "vibe.telemetry.buffer";

// Rubric Verification-Discipline window: edits a candidate makes to a file
// within 90s of an AI apply count as "review" of that apply. Carrying the
// originating block_id on each follow-up edit lets the grader compute the
// apply-then-edit rate and semantic edit distance without re-running diffs.
const POST_APPLY_WINDOW_MS = 90_000;

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
  /** Absolute path to .jivahire/telemetry.jsonl in the workspace, or null if
   *  no workspace folder is open (events are dropped silently). */
  private _jsonlPath: string | null;
  /** Lazy-created on first write so we don't mkdir if nothing is emitted. */
  private _jsonlDirCreated = false;
  private _disposables: vscode.Disposable[] = [];
  private _context: vscode.ExtensionContext;
  private _lastUnfocusedAt: number | null = null;
  private _justRefocusedUntil: number = 0;
  private _typedAgg: Map<string, { chars: number; timer: ReturnType<typeof setTimeout> }> = new Map();
  /** Dedup file_open events: emit once per file path per session. */
  private _openedFiles: Set<string> = new Set();
  /** Dedup protected_file_edit events: one tamper signal per .jivahire/ file. */
  private _tamperedFiles: Set<string> = new Set();
  /** Running expected character length of telemetry.jsonl based on our own
   *  writes. Lazy-initialised from disk on first append. Used to decide whether
   *  a non-dirty doc-change is our echo (length matches) or external tamper
   *  (length differs). UTF-16 code units, to match document.getText().length. */
  private _expectedJsonlChars: number = 0;
  private _expectedJsonlInitialized: boolean = false;
  // file → { block_id, until } for the most recent AI apply per file. Drives
  // post_apply_of attachment on subsequent typed/pasted edits within the 90s
  // verification window. Cleared on emit when the entry expires.
  private _recentApplies: Map<string, { blockId: string; until: number }> = new Map();

  constructor(config: SessionConfig, context: vscode.ExtensionContext) {
    this._context = context;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._jsonlPath = ws ? path.join(ws, ".jivahire", "telemetry.jsonl") : null;

    // One-time migration: flush any events stranded in globalState from an old
    // extension version that used the HTTP-POST buffer. Append them to the new
    // JSONL file then clear the key so they aren't re-migrated on next activate.
    const stranded = context.globalState.get<TelemetryEvent[]>(_LEGACY_BUFFER_KEY, []);
    if (stranded.length > 0) {
      for (const evt of stranded) {
        this._appendToJsonl(evt);
      }
      void context.globalState.update(_LEGACY_BUFFER_KEY, []);
    }

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
  }

  private _appendToJsonl(evt: TelemetryEvent): void {
    if (!this._jsonlPath) return;
    try {
      if (!this._jsonlDirCreated) {
        fs.mkdirSync(path.dirname(this._jsonlPath), { recursive: true });
        this._jsonlDirCreated = true;
      }
      // Lazy-init the expected-length tracker from whatever's already on disk
      // (could be a resumed session). Read the file as utf8 text so the count
      // matches document.getText().length, which is also UTF-16 code units —
      // byte length from statSync would mismatch on non-ASCII content.
      if (!this._expectedJsonlInitialized) {
        try {
          this._expectedJsonlChars = fs.readFileSync(this._jsonlPath, "utf8").length;
        } catch {
          this._expectedJsonlChars = 0; // file doesn't exist yet
        }
        this._expectedJsonlInitialized = true;
      }
      const line = JSON.stringify(evt) + "\n";
      fs.appendFileSync(this._jsonlPath, line);
      this._expectedJsonlChars += line.length;
    } catch (err) {
      getLogger()?.warn("telemetry_write_failed", { error: String(err) });
    }
  }

  emit(event_type: string, payload: Record<string, unknown>): void {
    // Remember the most recent AI apply per file so subsequent typed/pasted
    // edits inside the 90s window can be attributed to it.
    if (event_type === "edit_ai_applied" || event_type === "edit_ai_rejected") {
      const file = typeof payload.file === "string" ? payload.file : undefined;
      const blockId = typeof payload.block_id === "string" ? payload.block_id : undefined;
      if (event_type === "edit_ai_applied" && file && blockId) {
        this._recentApplies.set(file, { blockId, until: Date.now() + POST_APPLY_WINDOW_MS });
      }
    }
    this._appendToJsonl({ ts: Date.now(), event_type, payload, id: _nextId() });
  }

  /**
   * Returns the `block_id` of the most recent AI apply to `file` if still
   * inside the 90s window, else undefined. Expired entries are removed lazily.
   */
  private _recentApplyFor(file: string): string | undefined {
    const entry = this._recentApplies.get(file);
    if (!entry) return undefined;
    if (Date.now() > entry.until) {
      this._recentApplies.delete(file);
      return undefined;
    }
    return entry.blockId;
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

    // AI applies are flagged by apply.ts. We consume the flag and skip the
    // WHOLE event — apply.ts emits the canonical `edit_ai_applied` at
    // lifecycle end with the correct chars/block_id. Per-change suppression
    // is unsafe: VS Code optimizes a single WorkspaceEdit.replace covering
    // the whole document into multiple smaller contentChanges via minimal-
    // diff computation, so the apply lands as N contentChanges in one event
    // and only the first would be skipped — the rest would leak through as
    // spurious paste/typed events totalling the size of the diff regions.
    if (_suppressNextApply) {
      _suppressNextApply = false;
      return;
    }

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const rel = path.relative(ws, e.document.uri.fsPath);
    if (rel.startsWith("..")) return; // outside workspace

    // .jivahire/ holds grader-owned artifacts (rubric.json, traps.json,
    // metadata.json, telemetry.jsonl). Doc changes there come from three
    // distinct sources, distinguished deterministically — no timing heuristic:
    //   (a) editor edit: the candidate typed/pasted in VS Code → document
    //       buffer diverges from disk → e.document.isDirty === true.
    //   (b) our own write echoing back via VS Code's disk-reload of an open
    //       telemetry.jsonl → buffer matches disk → isDirty === false AND
    //       document.getText().length matches our running _expectedJsonlChars.
    //   (c) external write (e.g. `echo … >> file` from a shell) → buffer
    //       matches disk → isDirty === false BUT length diverges from what
    //       we know we wrote.
    // (a) and (c) are tamper; (b) is suppressed. Normalize separators so the
    // prefix check holds on Windows.
    const normRel = rel.replace(/[/\\]/g, "/");
    if (normRel.startsWith(".jivahire/")) {
      const isTelemetryFile = normRel === ".jivahire/telemetry.jsonl";
      const dirty = (e.document as { isDirty?: boolean }).isDirty === true;
      if (!dirty) {
        // Disk-loaded. For telemetry.jsonl, we own writes, so a length match
        // means it's our echo. For other .jivahire/ files we never write, so
        // any disk-loaded change is necessarily external.
        if (isTelemetryFile && e.document.getText().length === this._expectedJsonlChars) {
          return; // (b) our own echo
        }
      }
      if (this._tamperedFiles.has(normRel)) return; // dedup like file_open
      this._tamperedFiles.add(normRel);
      this.emit("protected_file_edit", {
        file: normRel,
        source: dirty ? "editor" : "external",
      });
      return;
    }

    for (const change of e.contentChanges) {
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
      // Exclude pure-whitespace newlines (Enter keystroke = "\n" or "\r\n",
      // auto-indent on newline = "\n    ") — those are typing, not paste.
      // A real paste / snippet / multi-line insert always contains at least
      // one non-whitespace char alongside the newline.
      const multiLineInsert =
        change.text.length > 0 &&
        /\r?\n/.test(change.text) &&
        /\S/.test(change.text);
      const isPaste =
        change.text.length > 0 &&
        (pasteImminent || multiLineInsert || change.text.length >= PASTE_SIZE_THRESHOLD);

      if (isPaste) {
        const suspicious_paste = Date.now() < this._justRefocusedUntil;
        const payload: Record<string, unknown> = { file: rel, chars: change.text.length, suspicious_paste };
        const postApplyOf = this._recentApplyFor(rel);
        if (postApplyOf) payload.post_apply_of = postApplyOf;
        this.emit("edit_pasted", payload);
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
          const payload: Record<string, unknown> = { file, chars: agg.chars };
          // Check the apply window at flush time, not insert time — gives the
          // candidate the full 90s post-apply window even if they paused
          // mid-aggregation.
          const postApplyOf = this._recentApplyFor(file);
          if (postApplyOf) payload.post_apply_of = postApplyOf;
          this.emit("edit_typed", payload);
          this._typedAgg.delete(file);
        }
      }, 1000);
      this._typedAgg.set(file, { chars, timer });
    }
  }

  dispose(): void {
    for (const d of this._disposables) d.dispose();
    for (const agg of this._typedAgg.values()) clearTimeout(agg.timer);
    this._typedAgg.clear();
  }
}
