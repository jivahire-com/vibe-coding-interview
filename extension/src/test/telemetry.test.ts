/**
 * Tests for TelemetryTracker (telemetry.ts).
 *
 * Covers:
 *  – emit() writes a JSONL line to .jivahire/telemetry.jsonl
 *  – doc change → paste classification (size, multi-line, or command-hook signal)
 *  – doc change → typed classification (small edits, aggregated)
 *  – _suppressNextApply flag → entire event silenced (apply.ts owns edit_ai_applied)
 *  – window focus/unfocus events
 *  – developer-signal events (file_open, debug, test_run)
 *  – dispose() clears timers
 *  – no-workspace-folder → emit is a no-op, never throws
 *  – stranded globalState buffer is migrated to JSONL on first construct
 */
import {
  TelemetryTracker,
  suppressNextApplyForUri,
} from '../telemetry';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { makeConfig, makeMockContext } from './helpers';

const TARGET_URI = { fsPath: '/ws/src/main.cpp' };
const OTHER_URI = { fsPath: '/ws/src/other.cpp' };

// Prevent real filesystem writes
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  appendFileSync: jest.fn(),
  // Used by _appendToJsonl to lazy-init the expected-length tracker from an
  // existing telemetry.jsonl (resumed session). Throw by default → tracker
  // treats it as a fresh file (length 0). Individual tests can override.
  readFileSync: jest.fn(() => { throw new Error('ENOENT'); }),
}));

const mockMkdirSync = fs.mkdirSync as jest.Mock;
const mockAppendFileSync = fs.appendFileSync as jest.Mock;

describe('TelemetryTracker', () => {
  let context: ReturnType<typeof makeMockContext>;
  let tracker: TelemetryTracker;

  const JSONL_PATH = '/ws/.jivahire/telemetry.jsonl';

  const getDocChangeCb = () => (vscode.workspace as any)._docChangeCallback as
    ((e: any) => void) | null;
  const getWindowStateCb = () => (vscode.window as any)._windowStateCallback as
    ((s: { focused: boolean }) => void) | null;

  beforeEach(() => {
    jest.useFakeTimers();
    mockMkdirSync.mockClear();
    mockAppendFileSync.mockClear();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    context = makeMockContext();
    tracker = new TelemetryTracker(makeConfig(), context);
  });

  afterEach(() => {
    tracker.dispose();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── JSONL writer ──────────────────────────────────────────────────────────

  test('emit() appends a valid JSON line to the JSONL file', () => {
    tracker.emit('test_event', { x: 1 });
    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [filePath, line] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(filePath).toBe(JSONL_PATH);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.event_type).toBe('test_event');
    expect(parsed.payload).toEqual({ x: 1 });
    expect(typeof parsed.ts).toBe('number');
    expect(typeof parsed.id).toBe('string');
  });

  test('emit() creates the .jivahire directory on first call (lazy mkdir)', () => {
    tracker.emit('e1', {});
    expect(mockMkdirSync).toHaveBeenCalledWith('/ws/.jivahire', { recursive: true });
    // Second emit must NOT call mkdirSync again
    tracker.emit('e2', {});
    expect(mockMkdirSync).toHaveBeenCalledTimes(1);
  });

  test('emit() does not throw when appendFileSync throws (EIO, ENOSPC)', () => {
    mockAppendFileSync.mockImplementationOnce(() => { throw new Error('ENOSPC'); });
    expect(() => tracker.emit('x', {})).not.toThrow();
  });

  test('no workspace folder → emit is a silent no-op (no fs calls, no throw)', () => {
    (vscode.workspace as any).workspaceFolders = [];
    const noWsTracker = new TelemetryTracker(makeConfig(), makeMockContext());
    expect(() => noWsTracker.emit('x', {})).not.toThrow();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    noWsTracker.dispose();
  });

  test('stranded globalState buffer is migrated to JSONL on construction', () => {
    const strandedEvents = [
      { ts: 1, event_type: 'edit_typed', payload: { chars: 5 }, id: 'old-1' },
      { ts: 2, event_type: 'file_open', payload: { file: 'a.cpp' }, id: 'old-2' },
    ];
    const ctx = makeMockContext({ 'vibe.telemetry.buffer': strandedEvents });
    mockAppendFileSync.mockClear();
    const t = new TelemetryTracker(makeConfig(), ctx);
    // Both events written to disk
    expect(mockAppendFileSync).toHaveBeenCalledTimes(2);
    // globalState buffer cleared
    expect(ctx.globalState.update).toHaveBeenCalledWith('vibe.telemetry.buffer', []);
    t.dispose();
  });

  // ── Doc change classification ─────────────────────────────────────────────

  function fireDocChange(
    changes: Array<{ text: string; rangeLength: number }>,
    file = 'src/main.cpp',
    opts: { isDirty?: boolean; fullText?: string } = {},
  ) {
    const cb = getDocChangeCb();
    if (!cb) throw new Error('onDidChangeTextDocument callback not registered');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    cb({
      document: {
        uri: { scheme: 'file', fsPath: `/ws/${file}` },
        isDirty: opts.isDirty ?? true, // most events come from in-editor edits
        getText: () => opts.fullText ?? '',
      },
      contentChanges: changes,
    });
  }

  function lastEmittedEvent(): { event_type: string; payload: Record<string, unknown> } | null {
    if (mockAppendFileSync.mock.calls.length === 0) return null;
    const last = mockAppendFileSync.mock.calls[mockAppendFileSync.mock.calls.length - 1];
    return JSON.parse((last[1] as string).trimEnd());
  }

  function emittedEventTypes(): string[] {
    return mockAppendFileSync.mock.calls.map((c) => JSON.parse((c[1] as string).trimEnd()).event_type);
  }

  test('large insertion (≥20 chars, rangeLength=0) classified as edit_pasted', () => {
    fireDocChange([{ text: 'a'.repeat(30), rangeLength: 0 }]);
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(30);
  });

  // ── Bug 6 regression: IntelliSense completions are NOT pastes ─────────────
  // `console.log` (11), `addEventListener` (16), `setTimeout` (10) are the
  // single most common IDE inserts that crossed the OLD 10-char threshold.
  // Bumped to 20 so they aggregate into edit_typed instead.
  test('autocomplete-sized single-line insert (11 chars) is NOT classified as edit_pasted', () => {
    fireDocChange([{ text: 'console.log', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).not.toContain('edit_pasted');
    expect(types).toContain('edit_typed');
  });

  test('autocomplete-sized single-line insert (16 chars: addEventListener) is NOT classified as edit_pasted', () => {
    fireDocChange([{ text: 'addEventListener', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).not.toContain('edit_pasted');
    expect(types).toContain('edit_typed');
  });

  test('insert exactly at the 20-char threshold IS classified as edit_pasted', () => {
    fireDocChange([{ text: 'a'.repeat(20), rangeLength: 0 }]);
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(20);
  });

  test('insert just under threshold (19 chars) is NOT classified as edit_pasted', () => {
    fireDocChange([{ text: 'a'.repeat(19), rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).not.toContain('edit_pasted');
    expect(types).toContain('edit_typed');
  });

  test('small single-line insertion classified as edit_typed (after aggregation timer)', () => {
    fireDocChange([{ text: 'abc', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).toContain('edit_typed');
    const typed = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .find((e) => e.event_type === 'edit_typed')!;
    expect(typed.payload.chars).toBe(3);
  });

  test('paste-over-selection (rangeLength>0, large insert) classified as edit_pasted', () => {
    fireDocChange([{ text: 'x'.repeat(40), rangeLength: 12 }]);
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(40);
  });

  test('multi-line insert under size threshold still classified as edit_pasted', () => {
    fireDocChange([{ text: 'a\nb', rangeLength: 0 }]);
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(3);
  });

  // Regression: production session RAH-147 reported `edit_pasted chars:2` for
  // every Enter keystroke on Windows (text="\r\n"). Pure-whitespace newline
  // inserts (Enter / auto-indent) are typing, not paste.
  test('lone Enter keystroke ("\\n") is NOT classified as edit_pasted', () => {
    fireDocChange([{ text: '\n', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).not.toContain('edit_pasted');
    expect(types).toContain('edit_typed');
  });

  test('Windows Enter keystroke ("\\r\\n") is NOT classified as edit_pasted', () => {
    fireDocChange([{ text: '\r\n', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).not.toContain('edit_pasted');
    expect(types).toContain('edit_typed');
  });

  test('auto-indent on newline ("\\n    ") is NOT classified as edit_pasted', () => {
    fireDocChange([{ text: '\n    ', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).not.toContain('edit_pasted');
    expect(types).toContain('edit_typed');
  });

  test('paste-command hook flags the next change as edit_pasted regardless of size', async () => {
    await vscode.commands.executeCommand('vibe.interceptPaste');
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'hi', rangeLength: 0 }]);
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(2);
  });

  // ── Tamper detection (.jivahire/) ─────────────────────────────────────────

  // Helper: figure out how long telemetry.jsonl SHOULD be after a list of
  // tracker.emit() calls, mirroring _appendToJsonl's "JSON.stringify(evt) + \n"
  // and bumping for the integer id counter so the synthetic fullText length
  // matches _expectedJsonlChars exactly.
  function currentJsonlLen(): number {
    return mockAppendFileSync.mock.calls.reduce((n, c) => n + (c[1] as string).length, 0);
  }

  test('our own disk-reload echo of telemetry.jsonl (isDirty=false, length matches) is suppressed', () => {
    // Drive at least one emit so _expectedJsonlChars is initialised.
    tracker.emit('file_open', { file: 'src/main.cpp' });
    const len = currentJsonlLen();
    mockAppendFileSync.mockClear();
    fireDocChange(
      [{ text: 'x'.repeat(200) + '\n', rangeLength: 0 }],
      '.jivahire/telemetry.jsonl',
      { isDirty: false, fullText: 'a'.repeat(len) }, // length matches expected
    );
    jest.advanceTimersByTime(1001);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('echo suppression works on Windows-style paths', () => {
    tracker.emit('file_open', { file: 'src/main.cpp' });
    const len = currentJsonlLen();
    mockAppendFileSync.mockClear();
    fireDocChange(
      [{ text: 'x'.repeat(200) + '\n', rangeLength: 0 }],
      '.jivahire\\telemetry.jsonl',
      { isDirty: false, fullText: 'a'.repeat(len) },
    );
    jest.advanceTimersByTime(1001);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('candidate edits telemetry.jsonl in the editor (isDirty=true) → protected_file_edit{source:editor}', () => {
    mockAppendFileSync.mockClear();
    fireDocChange(
      [{ text: 'fake', rangeLength: 0 }],
      '.jivahire/telemetry.jsonl',
      { isDirty: true, fullText: 'whatever' },
    );
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('protected_file_edit');
    expect(ev.payload.file).toBe('.jivahire/telemetry.jsonl');
    expect(ev.payload.source).toBe('editor');
  });

  test('external tamper to telemetry.jsonl (isDirty=false, length mismatch) → protected_file_edit{source:external}', () => {
    tracker.emit('file_open', { file: 'src/main.cpp' });
    mockAppendFileSync.mockClear();
    // Mismatched length: simulate `echo … >> file` from a shell adding bytes
    // we didn't account for.
    fireDocChange(
      [{ text: 'malicious', rangeLength: 0 }],
      '.jivahire/telemetry.jsonl',
      { isDirty: false, fullText: 'extra-content-not-in-our-counter' },
    );
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('protected_file_edit');
    expect(ev.payload.source).toBe('external');
  });

  test('any change to a .jivahire/ file we never write (rubric.json) is tamper', () => {
    mockAppendFileSync.mockClear();
    fireDocChange(
      [{ text: 'tampered', rangeLength: 0 }],
      '.jivahire/rubric.json',
      { isDirty: false, fullText: 'whatever' }, // even isDirty=false → still tamper
    );
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('protected_file_edit');
    expect(ev.payload.file).toBe('.jivahire/rubric.json');
    expect(ev.payload.source).toBe('external');
  });

  test('protected_file_edit is deduped per file per session', () => {
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'first', rangeLength: 0 }], '.jivahire/rubric.json', { isDirty: true });
    fireDocChange([{ text: 'second', rangeLength: 0 }], '.jivahire/rubric.json', { isDirty: true });
    fireDocChange([{ text: 'third', rangeLength: 0 }], '.jivahire/rubric.json', { isDirty: true });
    const tamperEvents = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .filter((e) => e.event_type === 'protected_file_edit');
    expect(tamperEvents).toHaveLength(1);
  });

  test('different .jivahire/ files each get their own tamper signal', () => {
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'a', rangeLength: 0 }], '.jivahire/rubric.json', { isDirty: true });
    fireDocChange([{ text: 'b', rangeLength: 0 }], '.jivahire/traps.json', { isDirty: true });
    const tamperEvents = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .filter((e) => e.event_type === 'protected_file_edit');
    expect(tamperEvents.map((e) => e.payload.file).sort()).toEqual([
      '.jivahire/rubric.json',
      '.jivahire/traps.json',
    ]);
  });

  test('deletion (text="" rangeLength>0) does NOT emit edit_typed', () => {
    fireDocChange([{ text: '', rangeLength: 5 }]);
    jest.advanceTimersByTime(1001);
    const types = emittedEventTypes();
    expect(types).not.toContain('edit_typed');
  });

  test('suppressNextApplyForUri silences the change listener; apply.ts owns the edit_ai_applied emit', () => {
    // The change listener must not emit anything for the AI-driven apply.
    suppressNextApplyForUri(TARGET_URI);
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'a'.repeat(50), rangeLength: 0 }]);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('suppressNextApplyForUri is consumed after one event', () => {
    suppressNextApplyForUri(TARGET_URI);
    fireDocChange([{ text: 'a'.repeat(50), rangeLength: 0 }]); // consumed
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'b'.repeat(50), rangeLength: 0 }]); // normal paste
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(50);
  });

  test('suppressNextApplyForUri silences ALL contentChanges in the next event, not just the first', () => {
    suppressNextApplyForUri(TARGET_URI);
    mockAppendFileSync.mockClear();
    fireDocChange([
      { text: 'a'.repeat(46), rangeLength: 0 },
      { text: 'b'.repeat(87), rangeLength: 0 },
      { text: 'c'.repeat(110), rangeLength: 0 },
      { text: 'd'.repeat(17), rangeLength: 0 },
    ]);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  // ── Bug 5 regression: cross-file suppression leak ─────────────────────────
  test('suppress for file A does NOT eat an edit in file B (per-URI scoping)', () => {
    suppressNextApplyForUri(TARGET_URI); // arm for src/main.cpp
    mockAppendFileSync.mockClear();
    // User types in a different file in the window between arm and apply
    fireDocChange([{ text: 'q'.repeat(50), rangeLength: 0 }], 'src/other.cpp');
    // The other-file edit MUST land as a paste — not be silently eaten.
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.file).toBe('src/other.cpp');
    // And the original arm is still in effect for the target file:
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'z'.repeat(50), rangeLength: 0 }], 'src/main.cpp');
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('suppression for file A is unaffected by other.cpp event in between', () => {
    suppressNextApplyForUri(OTHER_URI);
    mockAppendFileSync.mockClear();
    // An unrelated edit on a third file should not consume the OTHER_URI arm.
    fireDocChange([{ text: 'a'.repeat(30), rangeLength: 0 }], 'src/third.cpp');
    mockAppendFileSync.mockClear();
    // Now the OTHER_URI edit lands and is properly suppressed.
    fireDocChange([{ text: 'b'.repeat(30), rangeLength: 0 }], 'src/other.cpp');
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('typed edits within 90s of edit_ai_applied carry post_apply_of=<block_id>', () => {
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-7', chars: 100 });
    mockAppendFileSync.mockClear();

    fireDocChange([{ text: 'extra', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);

    const typedEvt = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .find((e) => e.event_type === 'edit_typed')!;
    expect(typedEvt).toBeDefined();
    expect(typedEvt.payload.post_apply_of).toBe('blk-7');
    expect(typedEvt.payload.chars).toBe(5);
  });

  test('paste within 90s of edit_ai_applied carries post_apply_of=<block_id>', () => {
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-8', chars: 200 });
    mockAppendFileSync.mockClear();

    fireDocChange([{ text: 'x'.repeat(40), rangeLength: 0 }]);
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.post_apply_of).toBe('blk-8');
  });

  test('edits past the 90s window do NOT carry post_apply_of', () => {
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-9', chars: 50 });
    mockAppendFileSync.mockClear();

    jest.advanceTimersByTime(90_001);
    fireDocChange([{ text: 'late', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);

    const typedEvt = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .find((e) => e.event_type === 'edit_typed')!;
    expect(typedEvt).toBeDefined();
    expect(typedEvt.payload.post_apply_of).toBeUndefined();
  });

  test('edits in a different file do NOT inherit post_apply_of from another file', () => {
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-10', chars: 50 });
    mockAppendFileSync.mockClear();

    fireDocChange([{ text: 'hi', rangeLength: 0 }], 'src/other.cpp');
    jest.advanceTimersByTime(1001);

    const typedEvt = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .find((e) => e.event_type === 'edit_typed')!;
    expect(typedEvt).toBeDefined();
    expect(typedEvt.payload.post_apply_of).toBeUndefined();
  });

  test('changes outside the workspace are ignored', () => {
    const cb = getDocChangeCb()!;
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    mockAppendFileSync.mockClear();
    cb({
      document: { uri: { scheme: 'file', fsPath: '/other/dir/file.cpp' } },
      contentChanges: [{ text: 'a'.repeat(50), rangeLength: 0 }],
    });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('non-file URI scheme changes are ignored', () => {
    const cb = getDocChangeCb()!;
    mockAppendFileSync.mockClear();
    cb({
      document: { uri: { scheme: 'git', fsPath: '/ws/file.cpp' } },
      contentChanges: [{ text: 'a'.repeat(50), rangeLength: 0 }],
    });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  // ── Window focus / unfocus ────────────────────────────────────────────────

  test('emits app_unfocused when window loses focus', () => {
    mockAppendFileSync.mockClear();
    getWindowStateCb()?.({ focused: false });
    expect(emittedEventTypes()).toContain('app_unfocused');
  });

  test('emits app_focused with time_away_seconds when window regains focus', () => {
    getWindowStateCb()?.({ focused: false });
    jest.advanceTimersByTime(5000);
    mockAppendFileSync.mockClear();
    getWindowStateCb()?.({ focused: true });
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('app_focused');
    expect(typeof ev.payload.time_away_seconds).toBe('number');
  });

  test('does not emit app_focused if there was no prior unfocus', () => {
    mockAppendFileSync.mockClear();
    getWindowStateCb()?.({ focused: true });
    expect(emittedEventTypes()).not.toContain('app_focused');
  });

  // ── Developer-signal events ───────────────────────────────────────────────

  const getActiveEditorCb = () => (vscode.window as any)._activeEditorCallback as
    ((e: any) => void) | null;
  const getDebugStartCb = () => (vscode.debug as any)._debugStartCallback as
    ((s: any) => void) | null;
  const getTestRunCb = () => (vscode.tests as any)._testRunCallback as
    ((r: any) => void) | null;

  test('emits file_open when active editor changes to a workspace file', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    mockAppendFileSync.mockClear();
    getActiveEditorCb()?.({
      document: { uri: { scheme: 'file', fsPath: '/ws/src/main.cpp' } },
    });
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('file_open');
    expect(ev.payload.file).toBe('src/main.cpp');
  });

  test('file_open is deduped — reopening the same file emits once', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    const cb = getActiveEditorCb()!;
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    const opens = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .filter((e) => e.event_type === 'file_open');
    expect(opens).toHaveLength(1);
  });

  test('file_open ignores non-file URIs and files outside workspace', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    const cb = getActiveEditorCb()!;
    mockAppendFileSync.mockClear();
    cb({ document: { uri: { scheme: 'git', fsPath: '/ws/a.ts' } } });
    cb({ document: { uri: { scheme: 'file', fsPath: '/elsewhere/a.ts' } } });
    expect(emittedEventTypes()).not.toContain('file_open');
  });

  test('emits debug_session when a debug session starts', () => {
    mockAppendFileSync.mockClear();
    getDebugStartCb()?.({ type: 'node', name: 'Launch test' });
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('debug_session');
    expect(ev.payload).toEqual({ type: 'node', name: 'Launch test' });
  });

  test('emits test_run when a test run starts', () => {
    mockAppendFileSync.mockClear();
    getTestRunCb()?.({ name: 'pytest -k foo' });
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('test_run');
    expect(ev.payload.profile).toBe('pytest -k foo');
  });

  test('test_run defaults profile to "default" when name is missing', () => {
    mockAppendFileSync.mockClear();
    getTestRunCb()?.({});
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('test_run');
    expect(ev.payload.profile).toBe('default');
  });

  // ── Terminal shell-integration events ────────────────────────────────────

  const getShellExecCb = () => (vscode.window as any)._terminalShellExecCallback as
    ((e: any) => void) | null;

  const fireShell = (cmd: string) =>
    getShellExecCb()?.({ execution: { commandLine: { value: cmd } } });

  const allEvents = () => mockAppendFileSync.mock.calls
    .map((c) => JSON.parse((c[1] as string).trimEnd())) as Array<{
      event_type: string;
      payload: Record<string, unknown>;
    }>;

  test('npm test triggers a test_run event plus a terminal_command event', () => {
    mockAppendFileSync.mockClear();
    fireShell('npm test');
    const events = allEvents();
    const terminal = events.find((e) => e.event_type === 'terminal_command');
    const testRun = events.find((e) => e.event_type === 'test_run');
    expect(terminal).toBeDefined();
    expect(terminal!.payload.kind).toBe('test');
    expect(terminal!.payload.command_line).toBe('npm test');
    expect(testRun).toBeDefined();
    expect(testRun!.payload.profile).toBe('terminal');
  });

  test.each([
    ['pytest -q'],
    ['python3 -m pytest tests/'],
    ['ctest --output-on-failure'],
    ['cargo test'],
    ['go test ./...'],
    ['npx vitest run'],
    ['cmake --build build && ctest'],
  ])('classifies %s as a test run', (cmd) => {
    mockAppendFileSync.mockClear();
    fireShell(cmd);
    const events = allEvents();
    expect(events.find((e) => e.event_type === 'test_run')).toBeDefined();
  });

  test('npm install emits terminal_command with kind=install but no test_run', () => {
    mockAppendFileSync.mockClear();
    fireShell('npm install');
    const events = allEvents();
    const terminal = events.find((e) => e.event_type === 'terminal_command');
    expect(terminal).toBeDefined();
    expect(terminal!.payload.kind).toBe('install');
    expect(events.find((e) => e.event_type === 'test_run')).toBeUndefined();
  });

  test('cmake --build emits terminal_command with kind=build', () => {
    mockAppendFileSync.mockClear();
    fireShell('cmake --build build -j');
    const events = allEvents();
    const terminal = events.find((e) => e.event_type === 'terminal_command');
    expect(terminal).toBeDefined();
    expect(terminal!.payload.kind).toBe('build');
  });

  test('unrecognised commands (echo, ls, cat) emit no telemetry', () => {
    mockAppendFileSync.mockClear();
    fireShell('echo hello');
    fireShell('ls -la');
    fireShell('cat README.md');
    expect(allEvents()).toHaveLength(0);
  });

  test('blank command lines are ignored', () => {
    mockAppendFileSync.mockClear();
    fireShell('');
    fireShell('   ');
    expect(allEvents()).toHaveLength(0);
  });

  test('command_line is truncated to 500 chars to bound telemetry rows', () => {
    mockAppendFileSync.mockClear();
    fireShell('pytest ' + 'a'.repeat(1000));
    const terminal = allEvents().find((e) => e.event_type === 'terminal_command');
    expect(terminal).toBeDefined();
    expect((terminal!.payload.command_line as string).length).toBe(500);
  });

  // ── file_focus duration ──────────────────────────────────────────────────

  function emittedFocusEvents(): Array<{ file: string; ms: number }> {
    return mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .filter((e) => e.event_type === 'file_focus')
      .map((e) => e.payload as { file: string; ms: number });
  }

  test('switching editors emits file_focus with elapsed ms for the previous file', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    const cb = getActiveEditorCb()!;
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    jest.advanceTimersByTime(3000);
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/b.ts' } } });
    const focuses = emittedFocusEvents();
    expect(focuses).toHaveLength(1);
    expect(focuses[0].file).toBe('a.ts');
    expect(focuses[0].ms).toBeGreaterThanOrEqual(3000);
  });

  test('window unfocus flushes file_focus for the currently-active file', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    getActiveEditorCb()!({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    jest.advanceTimersByTime(2500);
    getWindowStateCb()!({ focused: false });
    const focuses = emittedFocusEvents();
    expect(focuses).toHaveLength(1);
    expect(focuses[0].file).toBe('a.ts');
    expect(focuses[0].ms).toBeGreaterThanOrEqual(2500);
  });

  test('window refocus resumes timing for the active editor', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    getActiveEditorCb()!({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    jest.advanceTimersByTime(1000);
    getWindowStateCb()!({ focused: false });
    // While the app is in the background the active editor in VS Code is still
    // pointing at a.ts — the refocus handler reads it and resumes timing.
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } },
    };
    jest.advanceTimersByTime(10_000); // time away — must NOT count
    getWindowStateCb()!({ focused: true });
    jest.advanceTimersByTime(2000);
    tracker.dispose();
    const total = emittedFocusEvents()
      .filter((f) => f.file === 'a.ts')
      .reduce((a, f) => a + f.ms, 0);
    // 1000ms before unfocus + 2000ms after refocus = ~3000ms; the 10s away
    // must not be included.
    expect(total).toBeGreaterThanOrEqual(3000);
    expect(total).toBeLessThan(10_000);
  });

  test('dispose flushes the in-flight file_focus duration', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    getActiveEditorCb()!({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    jest.advanceTimersByTime(1500);
    tracker.dispose();
    const focuses = emittedFocusEvents();
    expect(focuses).toHaveLength(1);
    expect(focuses[0].file).toBe('a.ts');
  });

  test('switching to a non-file editor flushes file_focus and stops timing', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    const cb = getActiveEditorCb()!;
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    jest.advanceTimersByTime(2000);
    cb({ document: { uri: { scheme: 'output', fsPath: '/ws/output' } } });
    expect(emittedFocusEvents()).toHaveLength(1);
    jest.advanceTimersByTime(5000);
    // No new focus events while sitting on a non-file editor.
    expect(emittedFocusEvents()).toHaveLength(1);
  });

  test('re-firing the same active editor does not emit a duplicate file_open or zero-ms focus', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    const cb = getActiveEditorCb()!;
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    jest.advanceTimersByTime(1000);
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    const types = emittedEventTypes();
    expect(types.filter((t) => t === 'file_open')).toHaveLength(1);
    expect(types.filter((t) => t === 'file_focus')).toHaveLength(0);
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  test('dispose() does not throw', () => {
    expect(() => tracker.dispose()).not.toThrow();
  });

  test('no fs activity after dispose (timers cleared)', () => {
    fireDocChange([{ text: 'abc', rangeLength: 0 }]); // starts typed aggregation timer
    // Drain the typed-agg flush BEFORE dispose so the dispose flush is a no-op
    // (this test guards the timer-cleared invariant, not the on-dispose flush).
    jest.advanceTimersByTime(1001);
    tracker.dispose();
    mockAppendFileSync.mockClear();
    jest.advanceTimersByTime(2000); // timer would have fired here
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  // ── Bug 2 regression: dispose flushes pending typed-char aggregations ─────
  test('dispose flushes in-progress typed-char aggregator (no data loss at session end)', () => {
    // User types 7 chars but the 1s flush timer hasn't fired yet.
    fireDocChange([{ text: 'abcdefg', rangeLength: 0 }]);
    // Do NOT advance timers — simulate VS Code shutting down mid-burst.
    mockAppendFileSync.mockClear();
    tracker.dispose();
    const typed = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .filter((e) => e.event_type === 'edit_typed');
    expect(typed).toHaveLength(1);
    expect(typed[0].payload.chars).toBe(7);
    expect(typed[0].payload.file).toBe('src/main.cpp');
  });

  test('dispose flushes typed aggregation for every file with pending chars', () => {
    fireDocChange([{ text: 'aa', rangeLength: 0 }], 'src/a.cpp');
    fireDocChange([{ text: 'bbbb', rangeLength: 0 }], 'src/b.cpp');
    mockAppendFileSync.mockClear();
    tracker.dispose();
    const typed = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .filter((e) => e.event_type === 'edit_typed');
    const byFile = Object.fromEntries(typed.map((e) => [e.payload.file, e.payload.chars]));
    expect(byFile).toEqual({ 'src/a.cpp': 2, 'src/b.cpp': 4 });
  });

  test('dispose flush attaches post_apply_of if the file is within the apply window', () => {
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-dispose', chars: 50 });
    fireDocChange([{ text: 'xyz', rangeLength: 0 }]);
    mockAppendFileSync.mockClear();
    tracker.dispose();
    const typed = mockAppendFileSync.mock.calls
      .map((c) => JSON.parse((c[1] as string).trimEnd()))
      .find((e) => e.event_type === 'edit_typed')!;
    expect(typed).toBeDefined();
    expect(typed.payload.post_apply_of).toBe('blk-dispose');
  });

  // ── Bug 3 regression: undo/redo events MUST NOT inflate typed/pasted ─────
  test('undo event (reason=Undo) is silently ignored', () => {
    mockAppendFileSync.mockClear();
    const cb = getDocChangeCb()!;
    cb({
      document: {
        uri: { scheme: 'file', fsPath: '/ws/src/main.cpp' },
        isDirty: true,
        getText: () => '',
      },
      // Reason=1 matches vscode.TextDocumentChangeReason.Undo
      reason: 1,
      contentChanges: [{ text: '', rangeLength: 25 }],
    });
    jest.advanceTimersByTime(1001);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('redo of a typed insert (reason=Redo) is NOT counted as a paste', () => {
    mockAppendFileSync.mockClear();
    const cb = getDocChangeCb()!;
    // Redoing a 50-char insert would otherwise cross PASTE_SIZE_THRESHOLD and
    // get double-counted as a fresh paste. The reason guard prevents that.
    cb({
      document: {
        uri: { scheme: 'file', fsPath: '/ws/src/main.cpp' },
        isDirty: true,
        getText: () => '',
      },
      reason: 2, // vscode.TextDocumentChangeReason.Redo
      contentChanges: [{ text: 'a'.repeat(50), rangeLength: 0 }],
    });
    jest.advanceTimersByTime(1001);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('a normal user edit (no reason) is still counted', () => {
    mockAppendFileSync.mockClear();
    const cb = getDocChangeCb()!;
    cb({
      document: {
        uri: { scheme: 'file', fsPath: '/ws/src/main.cpp' },
        isDirty: true,
        getText: () => '',
      },
      // reason omitted on real typing
      contentChanges: [{ text: 'a'.repeat(50), rangeLength: 0 }],
    });
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(50);
  });
});

// ── Bug 4 regression: initial active editor must emit file_open ────────────
// Lives in its own describe so we can construct the tracker AFTER setting
// vscode.window.activeTextEditor — the outer beforeEach has already built one
// with no active editor.

describe('TelemetryTracker initial-active-editor bootstrap (Bug 4)', () => {
  const TARGET = '/ws/src/main.cpp';

  beforeEach(() => {
    jest.useFakeTimers();
    (fs.appendFileSync as jest.Mock).mockClear();
    (fs.mkdirSync as jest.Mock).mockClear();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    (vscode.window as any).activeTextEditor = undefined;
  });

  afterEach(() => {
    (vscode.window as any).activeTextEditor = undefined;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('emits file_open for the editor already focused when the tracker is constructed', () => {
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: 'file', fsPath: TARGET } },
    };
    const t = new TelemetryTracker(makeConfig(), makeMockContext());
    try {
      const opens = (fs.appendFileSync as jest.Mock).mock.calls
        .map((c) => JSON.parse((c[1] as string).trimEnd()))
        .filter((e) => e.event_type === 'file_open');
      expect(opens).toHaveLength(1);
      expect(opens[0].payload.file).toBe('src/main.cpp');
    } finally {
      t.dispose();
    }
  });

  test('does NOT emit file_open at construct when no active editor is set', () => {
    (vscode.window as any).activeTextEditor = undefined;
    const t = new TelemetryTracker(makeConfig(), makeMockContext());
    try {
      const opens = (fs.appendFileSync as jest.Mock).mock.calls
        .map((c) => JSON.parse((c[1] as string).trimEnd()))
        .filter((e) => e.event_type === 'file_open');
      expect(opens).toHaveLength(0);
    } finally {
      t.dispose();
    }
  });

  test('initial-emit dedupes against subsequent same-editor change events', () => {
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: 'file', fsPath: TARGET } },
    };
    const t = new TelemetryTracker(makeConfig(), makeMockContext());
    try {
      // Now fire the same editor through the change listener — must NOT emit again.
      const cb = (vscode.window as any)._activeEditorCallback;
      cb({ document: { uri: { scheme: 'file', fsPath: TARGET } } });
      const opens = (fs.appendFileSync as jest.Mock).mock.calls
        .map((c) => JSON.parse((c[1] as string).trimEnd()))
        .filter((e) => e.event_type === 'file_open');
      expect(opens).toHaveLength(1);
    } finally {
      t.dispose();
    }
  });
});

// ── Bug 8 regression: emitted file paths use forward slashes ──────────────
// We can't change `path.relative` to produce Windows separators inside the
// Linux Jest run, so we feed in a contrived doc fsPath that exercises the
// normalization. The production guarantee is: regardless of the OS, the
// payload `file` field MUST use `/` so the grader and dedup keys see a
// single canonical form.

describe('TelemetryTracker path normalization (Bug 8)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (fs.appendFileSync as jest.Mock).mockClear();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('paste event emits forward-slash file path even on a deep nested path', () => {
    const t = new TelemetryTracker(makeConfig(), makeMockContext());
    try {
      const cb = (vscode.workspace as any)._docChangeCallback as (e: any) => void;
      cb({
        document: {
          uri: { scheme: 'file', fsPath: '/ws/src/sub/main.cpp' },
          isDirty: true,
          getText: () => '',
        },
        contentChanges: [{ text: 'a'.repeat(50), rangeLength: 0 }],
      });
      const ev = JSON.parse(
        ((fs.appendFileSync as jest.Mock).mock.calls.at(-1)![1] as string).trimEnd(),
      );
      expect(ev.payload.file).toBe('src/sub/main.cpp');
      expect(ev.payload.file).not.toContain('\\');
    } finally {
      t.dispose();
    }
  });
});

// ── Tamper anchor (telemetry.jsonl deletion detection) ──────────────────────
//
// The first telemetry event's {ts, id} is recorded as an immutable anchor in
// globalState and shipped to the server, so the grader can prove the file was
// deleted/recreated if its first line later stops matching.
describe('TelemetryTracker tamper anchor', () => {
  const ANCHOR_KEY = 'vibe.telemetry.anchor';

  beforeEach(() => {
    jest.useFakeTimers();
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    (fs.readFileSync as jest.Mock).mockImplementation(() => { throw new Error('ENOENT'); });
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('first emit records the anchor (first event ts+id) to globalState', () => {
    const ctx = makeMockContext();
    const t = new TelemetryTracker(makeConfig(), ctx);
    try {
      t.emit('first', {});
      const line = (fs.appendFileSync as jest.Mock).mock.calls[0]![1] as string;
      const ev = JSON.parse(line.trimEnd());
      expect(ctx.globalState.update).toHaveBeenCalledWith(
        ANCHOR_KEY,
        { ts: ev.ts, id: ev.id },
      );
    } finally {
      t.dispose();
    }
  });

  test('a stored anchor is preserved — later events never overwrite it', () => {
    const stored = { ts: 1000, id: '1000.42.1' };
    const ctx = makeMockContext({ [ANCHOR_KEY]: stored });
    const t = new TelemetryTracker(makeConfig(), ctx);
    try {
      (ctx.globalState.update as jest.Mock).mockClear();
      t.emit('later', {});
      const anchorWrites = (ctx.globalState.update as jest.Mock).mock.calls
        .filter((c: unknown[]) => c[0] === ANCHOR_KEY);
      expect(anchorWrites).toHaveLength(0);
    } finally {
      t.dispose();
    }
  });

  test('adopts the existing first line as the anchor on a resumed session', () => {
    // No stored anchor, but telemetry.jsonl already has events on disk.
    const firstLine = JSON.stringify({ ts: 777, event_type: 'file_open', payload: {}, id: '777.9.1' });
    (fs.readFileSync as jest.Mock).mockReturnValue(firstLine + '\n' + 'second line\n');
    const ctx = makeMockContext();
    const t = new TelemetryTracker(makeConfig(), ctx);
    try {
      expect(ctx.globalState.update).toHaveBeenCalledWith(
        ANCHOR_KEY,
        { ts: 777, id: '777.9.1' },
      );
    } finally {
      t.dispose();
    }
  });
});
