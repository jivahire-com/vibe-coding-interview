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
  suppressNextApplyEvent,
} from '../telemetry';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { makeConfig, makeMockContext } from './helpers';

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

  test('large insertion (≥10 chars, rangeLength=0) classified as edit_pasted', () => {
    fireDocChange([{ text: 'a'.repeat(30), rangeLength: 0 }]);
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(30);
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

  test('suppressNextApplyEvent silences the change listener; apply.ts owns the edit_ai_applied emit', () => {
    // The change listener must not emit anything for the AI-driven apply.
    suppressNextApplyEvent();
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'a'.repeat(50), rangeLength: 0 }]);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  test('suppressNextApplyEvent is consumed after one event', () => {
    suppressNextApplyEvent();
    fireDocChange([{ text: 'a'.repeat(50), rangeLength: 0 }]); // consumed
    mockAppendFileSync.mockClear();
    fireDocChange([{ text: 'b'.repeat(50), rangeLength: 0 }]); // normal paste
    const ev = lastEmittedEvent()!;
    expect(ev.event_type).toBe('edit_pasted');
    expect(ev.payload.chars).toBe(50);
  });

  test('suppressNextApplyEvent silences ALL contentChanges in the next event, not just the first', () => {
    suppressNextApplyEvent();
    mockAppendFileSync.mockClear();
    fireDocChange([
      { text: 'a'.repeat(46), rangeLength: 0 },
      { text: 'b'.repeat(87), rangeLength: 0 },
      { text: 'c'.repeat(110), rangeLength: 0 },
      { text: 'd'.repeat(17), rangeLength: 0 },
    ]);
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

  // ── dispose ───────────────────────────────────────────────────────────────

  test('dispose() does not throw', () => {
    expect(() => tracker.dispose()).not.toThrow();
  });

  test('no fs activity after dispose (timers cleared)', () => {
    fireDocChange([{ text: 'abc', rangeLength: 0 }]); // starts typed aggregation timer
    tracker.dispose();
    mockAppendFileSync.mockClear();
    jest.advanceTimersByTime(2000); // timer would have fired here
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});
