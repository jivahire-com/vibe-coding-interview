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

// Tamper-evidence anchor for .jivahire/telemetry.jsonl. The ts + id of the
// FIRST telemetry event of the session. Recorded once (the moment telemetry
// starts) and shipped to the server via the Logger → POST /api/v1/logs →
// app_logs channel, which the candidate cannot reach. The grader compares it
// against the first line of the telemetry.jsonl committed to the candidate's
// branch: if the candidate deletes the file mid-session, the extension
// recreates it on the next event with a brand-new first-event id and a later
// ts, so the recorded anchor no longer matches and the deletion is provable.
interface TelemetryAnchor {
  ts: number;
  id: string;
}

// What actually gets persisted under _ANCHOR_KEY. The owning `sessionId` scopes
// the anchor to the session that produced it: a later session must NOT adopt a
// previous session's anchor (globalState outlives a single interview), or it
// would re-report a stale first-event id under the new session and the grader
// would flag a false "telemetry tampered". sessionId is optional only so a
// pre-fix stored record (no sessionId) is treated as foreign and discarded.
interface StoredAnchor extends TelemetryAnchor {
  sessionId?: string;
}

// Kept for one-time migration of events stranded in globalState from the old
// HTTP-POST extension. Delete this key and the constructor migration block in
// a follow-up release once all active sessions have upgraded.
const _LEGACY_BUFFER_KEY = "vibe.telemetry.buffer";

// globalState key holding the session's TelemetryAnchor, so the anchor
// survives a window reload / extension-host crash and is re-reported to the
// server on every activation (a resumed session must still land it server-side
// even if the original report's flush never made it out).
const _ANCHOR_KEY = "vibe.telemetry.anchor";

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

// Set of URI fsPaths whose NEXT contentChange event should be skipped because
// apply.ts is about to write its own preview/accept/reject edit. Per-URI scope
// (was a single module boolean) so a flag set for file A can't silently eat an
// unrelated user edit in file B during the brief window between
// suppressNextApplyForUri() and applyEdit's contentChange firing.
const _suppressForUriPaths: Set<string> = new Set();

export function suppressNextApplyForUri(uri: vscode.Uri | { fsPath: string }): void {
  _suppressForUriPaths.add(uri.fsPath);
}

// Terminal command classification — used by the shell-integration listener to
// tag candidate-issued commands (npm test, pytest, cmake --build, pip install,
// etc.) so the developer-signal grader sees the same "test_run" events whether
// they come from VS Code's Testing UI or from a terminal invocation.
// Patterns are matched left-to-right, so the test list wins over build/install
// when a command happens to contain multiple kinds (e.g. `cmake --build &&
// ctest` is a test run — the test step is the candidate's intent).
const _TEST_RUNNER_PATTERNS: RegExp[] = [
  /\bpytest\b/,
  /python[0-9.]*\s+-m\s+(pytest|unittest)\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bnpm\s+(run\s+)?(test|t)\b/,
  /\byarn\s+(run\s+)?(test|t)\b/,
  /\bpnpm\s+(run\s+)?(test|t)\b/,
  /\bnpx\s+(vitest|jest|mocha|playwright|cypress)\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bctest\b/,
  /\bmake\s+(test|check)\b/,
  /\bmvn\s+(test|verify)\b/,
  /\bgradlew?\s+(test|check)\b/,
  /(^|\s|\/)build\/tests?\b/,
  /\bphpunit\b/,
  /\brspec\b/,
  /\brake\s+test\b/,
];
const _BUILD_PATTERNS: RegExp[] = [
  /\bnpm\s+(run\s+)?build\b/,
  /\byarn\s+(run\s+)?build\b/,
  /\bpnpm\s+(run\s+)?build\b/,
  /\bcmake\b/,
  /\bmake\b/,
  /\bcargo\s+(build|check)\b/,
  /\bgo\s+build\b/,
  /\btsc\b/,
  /\besbuild\b/,
  /\bwebpack\b/,
  /\bvite\s+build\b/,
  /\bmvn\s+(package|compile|install)\b/,
  /\bgradlew?\s+(build|assemble)\b/,
  /\bninja\b/,
];
const _INSTALL_PATTERNS: RegExp[] = [
  /\bnpm\s+(i|install|ci)\b/,
  /\byarn(\s+(install|add))?\s*$/,
  /\byarn\s+(install|add)\b/,
  /\bpnpm\s+(i|install|add)\b/,
  /\bpip[0-9]?\s+install\b/,
  /\bpoetry\s+(install|add)\b/,
  /\buv\s+(pip\s+install|add|sync)\b/,
  /\bcargo\s+(install|fetch|update)\b/,
  /\bgo\s+(get|mod\s+download)\b/,
  /\bbundle\s+install\b/,
];

export function _classifyTerminalCommand(
  cmd: string,
): "test" | "build" | "install" | "other" {
  const c = cmd.trim().toLowerCase();
  if (!c) return "other";
  for (const p of _TEST_RUNNER_PATTERNS) if (p.test(c)) return "test";
  for (const p of _INSTALL_PATTERNS) if (p.test(c)) return "install";
  for (const p of _BUILD_PATTERNS) if (p.test(c)) return "build";
  return "other";
}

// Set when the user invokes the paste command, consumed by the next doc change.
// The flag has a short freshness window so a stale paste signal (e.g. a paste
// into a non-editor input) can't get attributed to an unrelated later edit.
let _pasteImminentUntil = 0;
const PASTE_IMMINENT_WINDOW_MS = 500;
// Minimum insert size, after dropping the rangeLength===0 requirement, that we
// still treat as a paste based purely on size (covers pastes that bypass the
// command hook — e.g. middle-click paste on Linux). Bumped from 10 → 20 so
// IntelliSense completions like `console.log` (11), `addEventListener` (16)
// aren't misclassified as paste. Genuine candidate pastes are virtually always
// multi-line, command-hook-flagged, or > 20 chars.
const PASTE_SIZE_THRESHOLD = 20;

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
  /** Currently-focused workspace file and when focus started. Drives
   *  file_focus events emitted on editor switch, window unfocus, and dispose
   *  so the grader can compute time-spent per file. */
  private _activeFocus: { file: string; since: number } | null = null;
  /** Dedup protected_file_edit events: one tamper signal per .jivahire/ file. */
  private _tamperedFiles: Set<string> = new Set();
  /** Running expected character length of telemetry.jsonl based on our own
   *  writes. Lazy-initialised from disk on first append. Used to decide whether
   *  a non-dirty doc-change is our echo (length matches) or external tamper
   *  (length differs). UTF-16 code units, to match document.getText().length. */
  private _expectedJsonlChars: number = 0;
  private _expectedJsonlInitialized: boolean = false;
  /** First-event tamper anchor (see TelemetryAnchor). Captured once, then
   *  immutable for the life of the session; null until the first event is
   *  written or an existing/stored anchor is adopted on construction. */
  private _anchor: TelemetryAnchor | null = null;
  private _anchorInitialized: boolean = false;
  /** Session that owns this tracker's anchor. Persisted alongside the anchor so
   *  a different session never adopts it (see StoredAnchor). */
  private _sessionId: string;
  // file → { block_id, until } for the most recent AI apply per file. Drives
  // post_apply_of attachment on subsequent typed/pasted edits within the 90s
  // verification window. Cleared on emit when the entry expires.
  private _recentApplies: Map<string, { blockId: string; until: number }> = new Map();

  constructor(config: SessionConfig, context: vscode.ExtensionContext) {
    this._context = context;
    this._sessionId = config.sessionId;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._jsonlPath = ws ? path.join(ws, ".jivahire", "telemetry.jsonl") : null;

    // Establish the tamper anchor BEFORE the migration replay below, so a
    // stored/existing anchor wins over a migrated event becoming the "first".
    this._initAnchor();

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
      // onDidChangeActiveTextEditor only fires when the active editor CHANGES,
      // never for the editor already focused when we subscribe. Without this
      // bootstrap call, the candidate's first/only file (typically the one
      // the dashboard directed them to) never appears in `files_explored` and
      // contributes 0 ms of focus time — a systematic ~1-file undercount on
      // every session.
      try { this._onActiveEditor(vscode.window.activeTextEditor); } catch { /* tests may not stub it */ }
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

    // Shell-integration command capture. Candidate-issued commands in the
    // integrated terminal (npm test, pytest, cmake --build, pip install …)
    // surface here once the terminal has shell integration active. The API
    // landed stable in VS Code 1.93; the extension's engines floor is 1.85,
    // so we feature-detect and silently skip when unavailable.
    const onShellExec = (vscode.window as unknown as {
      onDidStartTerminalShellExecution?: (
        cb: (e: { execution?: { commandLine?: { value?: string } } }) => void,
      ) => vscode.Disposable;
    }).onDidStartTerminalShellExecution;
    if (typeof onShellExec === "function") {
      try {
        this._disposables.push(
          onShellExec((e) => this._onTerminalShellExecution(e))
        );
      } catch { /* feature not available on this VS Code build */ }
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
            await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
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
      // First event ever written this session → it is the tamper anchor.
      // (_initAnchor already adopted a stored/existing one on construction, so
      // this only fires when telemetry.jsonl genuinely starts empty.)
      if (!this._anchorInitialized) {
        this._anchorInitialized = true;
        this._anchor = { ts: evt.ts, id: evt.id };
        this._persistAnchor();
        this._reportAnchor("first_event");
      }
      const line = JSON.stringify(evt) + "\n";
      fs.appendFileSync(this._jsonlPath, line);
      this._expectedJsonlChars += line.length;
    } catch (err) {
      getLogger()?.warn("telemetry_write_failed", { error: String(err) });
    }
  }

  /**
   * Adopt the session's tamper anchor on construction (resumed session) and
   * re-report it to the server. Order of precedence:
   *   1. A stored anchor in globalState — the authoritative session start.
   *      If the file still exists but its first event no longer matches, the
   *      file was deleted/rewritten while the extension was down — flagged.
   *   2. Otherwise, the first event already on disk (e.g. an upgrade from a
   *      pre-anchor build mid-session) — adopted and persisted.
   *   3. Otherwise nothing: the anchor is captured on the first append.
   */
  private _initAnchor(): void {
    if (!this._jsonlPath) return;
    const stored = this._context.globalState.get<StoredAnchor>(_ANCHOR_KEY);
    const onDisk = this._readFirstEventFromDisk();
    // Only a stored anchor belonging to THIS session may be adopted. A record
    // left over from a previous session (or a pre-fix record with no sessionId)
    // is foreign — ignore it and capture a fresh anchor below, so we never
    // re-report a stale first-event id under a new session.
    const storedIsOurs =
      stored && typeof stored.ts === "number" && typeof stored.id === "string" &&
      stored.sessionId === this._sessionId;
    if (storedIsOurs) {
      this._anchor = { ts: stored.ts, id: stored.id };
      this._anchorInitialized = true;
      if (onDisk && onDisk.id !== stored.id) {
        getLogger()?.warn("telemetry_anchor_mismatch", {
          expected_id: stored.id, expected_ts: stored.ts,
          found_id: onDisk.id, found_ts: onDisk.ts,
        });
      }
      this._reportAnchor("resume");
    } else if (onDisk) {
      this._anchor = onDisk;
      this._anchorInitialized = true;
      this._persistAnchor();
      this._reportAnchor("adopted");
    }
  }

  /** Persist the current in-memory anchor to globalState, stamped with the
   *  owning session id so a later session won't adopt it (see StoredAnchor). */
  private _persistAnchor(): void {
    if (!this._anchor) return;
    const record: StoredAnchor = { ...this._anchor, sessionId: this._sessionId };
    void this._context.globalState.update(_ANCHOR_KEY, record);
  }

  /** Read and parse the first event of telemetry.jsonl off disk, or null when
   *  the file is absent, empty, or its first line isn't a valid event. */
  private _readFirstEventFromDisk(): TelemetryAnchor | null {
    if (!this._jsonlPath) return null;
    try {
      const content = fs.readFileSync(this._jsonlPath, "utf8");
      for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const evt = JSON.parse(line) as { ts?: unknown; id?: unknown; type?: unknown };
        // The branch is provisioned with a `session_init` integrity marker as
        // line 1 (server: sessions._integrity_marker). It carries no ts/id and
        // is NOT a telemetry event — skip it so we anchor to the first REAL
        // event, which is exactly what the grader compares against. Without
        // this skip the marker is read as "the first line", this returns null,
        // and a resumed session whose globalState anchor was lost re-captures a
        // LATER event as a brand-new anchor → the server flags a false tamper.
        if (evt.type === "session_init") continue;
        if (typeof evt.ts === "number" && typeof evt.id === "string") {
          return { ts: evt.ts, id: evt.id };
        }
        return null; // first real line isn't a valid event
      }
    } catch { /* missing / unreadable / malformed → no anchor on disk */ }
    return null;
  }

  /** Ship the anchor to the server via the Logger (→ app_logs, out of the
   *  candidate's reach). `origin` records how the anchor was established. */
  private _reportAnchor(origin: string): void {
    if (!this._anchor) return;
    getLogger()?.info("telemetry_anchor", {
      first_ts: this._anchor.ts,
      first_id: this._anchor.id,
      origin,
    });
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
    // Switching to a non-file editor (output panel, settings) or no editor at
    // all still ends the focus on whatever file was previously active.
    if (!editor || editor.document.uri.scheme !== "file") {
      this._flushFocus();
      return;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    // Normalize separators so Windows sessions don't emit `src\main.cpp` while
    // Linux sessions emit `src/main.cpp` — server-side intersections, grader
    // file lookups, and dedup keys all depend on a single canonical form.
    const rel = path.relative(ws, editor.document.uri.fsPath).replace(/\\/g, "/");
    if (rel.startsWith("..")) {
      this._flushFocus();
      return;
    }
    if (this._activeFocus?.file === rel) return; // same editor refocus, no-op
    this._flushFocus();
    if (!this._openedFiles.has(rel)) {
      this._openedFiles.add(rel);
      this.emit("file_open", { file: rel });
    }
    this._activeFocus = { file: rel, since: Date.now() };
  }

  /** Emit and clear the in-flight file_focus duration, if any. */
  private _flushFocus(): void {
    if (!this._activeFocus) return;
    const ms = Date.now() - this._activeFocus.since;
    const file = this._activeFocus.file;
    this._activeFocus = null;
    if (ms > 0) this.emit("file_focus", { file, ms });
  }

  private _onDebugSession(session: vscode.DebugSession): void {
    this.emit("debug_session", { type: session.type, name: session.name });
  }

  private _onTestRun(run: { name?: string }): void {
    this.emit("test_run", { profile: run?.name ?? "default" });
  }

  private _onTerminalShellExecution(e: {
    execution?: { commandLine?: { value?: string } };
  }): void {
    const raw = e?.execution?.commandLine?.value;
    if (typeof raw !== "string") return;
    const cmd = raw.trim();
    if (!cmd) return;
    const kind = _classifyTerminalCommand(cmd);
    // Skip unrecognised commands so the telemetry stays focused on the
    // build/install/test signals the grader cares about — and so we don't
    // capture incidental shell traffic (env-var exports, `cat secrets`, etc.).
    if (kind === "other") return;
    // Truncate so a pathological multi-line paste into the terminal can't
    // bloat the telemetry.jsonl row. The classification has already taken
    // place, so the full text isn't needed downstream.
    const command_line = cmd.length > 500 ? cmd.slice(0, 500) : cmd;
    this.emit("terminal_command", { command_line, kind });
    if (kind === "test") {
      this.emit("test_run", { profile: "terminal", command_line });
    }
  }

  private _onWindowState(state: vscode.WindowState): void {
    if (!state.focused) {
      this._lastUnfocusedAt = Date.now();
      // Stop counting file-focus time while the IDE is in the background — the
      // candidate isn't reading the file, they're in another app.
      this._flushFocus();
      this.emit("app_unfocused", { ts: this._lastUnfocusedAt });
    } else if (this._lastUnfocusedAt !== null) {
      const time_away_seconds = (Date.now() - this._lastUnfocusedAt) / 1000;
      this._justRefocusedUntil = Date.now() + 3000;
      this._lastUnfocusedAt = null;
      // Resume timing the editor that's now visible. Normalize to forward
      // slashes so this matches the `file` field used everywhere else.
      const active = vscode.window.activeTextEditor;
      if (active && active.document.uri.scheme === "file") {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const rel = path.relative(ws, active.document.uri.fsPath).replace(/\\/g, "/");
        if (!rel.startsWith("..")) {
          this._activeFocus = { file: rel, since: Date.now() };
        }
      }
      this.emit("app_focused", { time_away_seconds });
    }
  }

  private _onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== "file") return;

    // Undo / redo just shuffle existing text back into the buffer. Counting
    // them as typed (rare — text="" for undo) or pasted (common — a redo of a
    // previously-typed insert ≥ PASTE_SIZE_THRESHOLD looks identical to a
    // fresh paste) would double-credit the same characters. The candidate's
    // original action was already recorded; let undo/redo pass through silent.
    // Numeric literals match the stable vscode.TextDocumentChangeReason enum
    // (1=Undo, 2=Redo) and stay correct even in test mocks that don't expose
    // the enum object.
    const reason = (e as { reason?: number }).reason;
    if (reason === 1 || reason === 2) {
      return;
    }

    // AI applies are flagged by apply.ts with the specific URI being written.
    // We consume the flag and skip the WHOLE event — apply.ts emits the
    // canonical `edit_ai_applied` at lifecycle end with the correct
    // chars/block_id. Per-change suppression is unsafe: VS Code optimizes a
    // single WorkspaceEdit.replace covering the whole document into multiple
    // smaller contentChanges via minimal-diff computation, so the apply
    // lands as N contentChanges in one event and only the first would be
    // skipped — the rest would leak through as spurious paste/typed events
    // totalling the size of the diff regions.
    if (_suppressForUriPaths.has(e.document.uri.fsPath)) {
      _suppressForUriPaths.delete(e.document.uri.fsPath);
      return;
    }

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    // Forward-slash normalize for cross-platform consistency — see
    // _onActiveEditor for rationale. The .jivahire/ prefix check below also
    // depends on consistent separators.
    const rel = path.relative(ws, e.document.uri.fsPath).replace(/\\/g, "/");
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
    this._flushFocus();
    for (const d of this._disposables) d.dispose();
    // Flush any in-progress typed-char aggregations BEFORE clearing timers.
    // The aggregator only flushes on a 1-second timer tick, so a candidate
    // who types right before VS Code shuts down (window reload, post-submit
    // cleanup, OS kill) would otherwise lose up to a second of typing per
    // file — which silently lowers their `typed_chars` and skews
    // self_authored_ratio against them.
    for (const [file, agg] of this._typedAgg.entries()) {
      clearTimeout(agg.timer);
      if (agg.chars > 0) {
        const payload: Record<string, unknown> = { file, chars: agg.chars };
        const postApplyOf = this._recentApplyFor(file);
        if (postApplyOf) payload.post_apply_of = postApplyOf;
        this.emit("edit_typed", payload);
      }
    }
    this._typedAgg.clear();
    // Clear any URI-suppression flags that this tracker armed but apply.ts
    // never consumed (rare — happens if a WorkspaceEdit produced no
    // contentChange because the proposed text equalled current buffer). The
    // set is module-level so a leftover flag would leak across the next
    // session reload and silently eat an unrelated user edit.
    _suppressForUriPaths.clear();
  }
}
