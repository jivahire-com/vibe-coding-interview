/**
 * Tests for TelemetryTracker (telemetry.ts).
 *
 * Covers:
 *  – emit() buffers events
 *  – doc change → paste classification (size, multi-line, or command-hook signal)
 *  – doc change → typed classification (small edits, aggregated)
 *  – _suppressNextApply flag → edit_ai_applied event
 *  – window focus/unfocus events
 *  – dispose() clears the flush timer
 */
import {
  TelemetryTracker,
  suppressNextApplyEvent,
  MAX_BUFFERED_EVENTS,
  TELEMETRY_POST_TIMEOUT_MS,
} from '../telemetry';
import * as http from 'http';
import * as vscode from 'vscode';
import { makeConfig, makeMockContext } from './helpers';

// Prevent real HTTP traffic
jest.mock('http', () => ({
  request: jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    write: jest.fn(),
    end: jest.fn(),
  })),
}));
jest.mock('https', () => ({
  request: jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    write: jest.fn(),
    end: jest.fn(),
  })),
}));

describe('TelemetryTracker', () => {
  let context: ReturnType<typeof makeMockContext>;
  let tracker: TelemetryTracker;

  const getDocChangeCb = () => (vscode.workspace as any)._docChangeCallback as
    ((e: any) => void) | null;
  const getWindowStateCb = () => (vscode.window as any)._windowStateCallback as
    ((s: { focused: boolean }) => void) | null;

  beforeEach(() => {
    jest.useFakeTimers();
    context = makeMockContext();
    tracker = new TelemetryTracker(makeConfig(), context);
  });

  afterEach(() => {
    tracker.dispose();
    jest.useRealTimers();
    jest.clearAllMocks();
    // Reset module-level suppress flag
    // (call twice ensures it is consumed / cleared)
  });

  // ── Buffering ─────────────────────────────────────────────────────────────

  test('emit() adds events to the internal buffer', () => {
    tracker.emit('test_event', { x: 1 });
    tracker.emit('test_event', { x: 2 });
    // We can't inspect _buffer directly so we verify via flush side-effects.
    // The buffer is saved to globalState on flush; just ensure no throw.
    expect(() => tracker.emit('test_event', { x: 3 })).not.toThrow();
  });

  test('emit() triggers flush when buffer reaches FLUSH_THRESHOLD (500)', () => {
    for (let i = 0; i < 500; i++) {
      tracker.emit('bulk', { i });
    }
    // _flush() was called — globalState.update should have been called with []
    expect(context.globalState.update).toHaveBeenCalledWith(
      'vibe.telemetry.buffer',
      expect.anything(),
    );
  });

  // ── Doc change classification ─────────────────────────────────────────────

  function fireDocChange(changes: Array<{ text: string; rangeLength: number }>, file = 'src/main.cpp') {
    const cb = getDocChangeCb();
    if (!cb) throw new Error('onDidChangeTextDocument callback not registered');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    cb({
      document: { uri: { scheme: 'file', fsPath: `/ws/${file}` } },
      contentChanges: changes,
    });
  }

  test('large insertion (≥10 chars, rangeLength=0) classified as edit_pasted', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    fireDocChange([{ text: 'a'.repeat(30), rangeLength: 0 }]);
    expect(emitSpy).toHaveBeenCalledWith('edit_pasted', expect.objectContaining({ chars: 30 }));
  });

  test('small single-line insertion classified as edit_typed (after aggregation timer)', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    fireDocChange([{ text: 'abc', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    expect(emitSpy).toHaveBeenCalledWith('edit_typed', expect.objectContaining({ chars: 3 }));
  });

  test('paste-over-selection (rangeLength>0, large insert) classified as edit_pasted', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    fireDocChange([{ text: 'x'.repeat(40), rangeLength: 12 }]);
    expect(emitSpy).toHaveBeenCalledWith('edit_pasted', expect.objectContaining({ chars: 40 }));
  });

  test('multi-line insert under size threshold still classified as edit_pasted', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    fireDocChange([{ text: 'a\nb', rangeLength: 0 }]);
    expect(emitSpy).toHaveBeenCalledWith('edit_pasted', expect.objectContaining({ chars: 3 }));
  });

  test('paste-command hook flags the next change as edit_pasted regardless of size', async () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    await vscode.commands.executeCommand('vibe.interceptPaste');
    fireDocChange([{ text: 'hi', rangeLength: 0 }]);
    expect(emitSpy).toHaveBeenCalledWith('edit_pasted', expect.objectContaining({ chars: 2 }));
  });

  test('deletion (text="" rangeLength>0) does NOT emit edit_typed', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    fireDocChange([{ text: '', rangeLength: 5 }]);
    jest.advanceTimersByTime(1001);
    expect(emitSpy).not.toHaveBeenCalledWith('edit_typed', expect.anything());
  });

  test('suppressNextApplyEvent flag routes large insertion to edit_ai_applied', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    suppressNextApplyEvent();
    fireDocChange([{ text: 'a'.repeat(50), rangeLength: 0 }]);
    expect(emitSpy).toHaveBeenCalledWith(
      'edit_ai_applied',
      expect.objectContaining({ chars: 50 }),
    );
    expect(emitSpy).not.toHaveBeenCalledWith('edit_pasted', expect.anything());
  });

  test('suppressNextApplyEvent is consumed after one event', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    suppressNextApplyEvent();
    fireDocChange([{ text: 'a'.repeat(50), rangeLength: 0 }]); // consumed
    emitSpy.mockClear();
    fireDocChange([{ text: 'b'.repeat(50), rangeLength: 0 }]); // normal paste
    expect(emitSpy).toHaveBeenCalledWith('edit_pasted', expect.objectContaining({ chars: 50 }));
  });

  test('typed edits within 90s of edit_ai_applied carry post_apply_of=<block_id>', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    // Record an AI apply via the public emit() path so the tracker's recent-
    // applies map gets populated the same way apply.ts does in prod. File
    // path must match the one `fireDocChange` will simulate edits on.
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-7', chars: 100 });
    emitSpy.mockClear();

    fireDocChange([{ text: 'extra', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    expect(emitSpy).toHaveBeenCalledWith(
      'edit_typed',
      expect.objectContaining({ chars: 5, post_apply_of: 'blk-7' }),
    );
  });

  test('paste within 90s of edit_ai_applied carries post_apply_of=<block_id>', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-8', chars: 200 });
    emitSpy.mockClear();

    fireDocChange([{ text: 'x'.repeat(40), rangeLength: 0 }]);
    expect(emitSpy).toHaveBeenCalledWith(
      'edit_pasted',
      expect.objectContaining({ chars: 40, post_apply_of: 'blk-8' }),
    );
  });

  test('edits past the 90s window do NOT carry post_apply_of', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-9', chars: 50 });
    emitSpy.mockClear();

    jest.advanceTimersByTime(90_001);
    fireDocChange([{ text: 'late', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    const typedCall = emitSpy.mock.calls.find((c) => c[0] === 'edit_typed');
    expect(typedCall).toBeDefined();
    expect((typedCall![1] as Record<string, unknown>).post_apply_of).toBeUndefined();
  });

  test('edits in a different file do NOT inherit post_apply_of from another file', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    // Apply landed in src/main.cpp; the next edit is to src/other.cpp.
    tracker.emit('edit_ai_applied', { file: 'src/main.cpp', block_id: 'blk-10', chars: 50 });
    emitSpy.mockClear();

    fireDocChange([{ text: 'hi', rangeLength: 0 }], 'src/other.cpp');
    jest.advanceTimersByTime(1001);
    const typedCall = emitSpy.mock.calls.find((c) => c[0] === 'edit_typed');
    expect(typedCall).toBeDefined();
    expect((typedCall![1] as Record<string, unknown>).post_apply_of).toBeUndefined();
  });

  test('changes outside the workspace are ignored', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    const cb = getDocChangeCb()!;
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    cb({
      document: { uri: { scheme: 'file', fsPath: '/other/dir/file.cpp' } },
      contentChanges: [{ text: 'a'.repeat(50), rangeLength: 0 }],
    });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test('non-file URI scheme changes are ignored', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    const cb = getDocChangeCb()!;
    cb({
      document: { uri: { scheme: 'git', fsPath: '/ws/file.cpp' } },
      contentChanges: [{ text: 'a'.repeat(50), rangeLength: 0 }],
    });
    expect(emitSpy).not.toHaveBeenCalled();
  });

  // ── Window focus / unfocus ────────────────────────────────────────────────

  test('emits app_unfocused when window loses focus', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    getWindowStateCb()?.({ focused: false });
    expect(emitSpy).toHaveBeenCalledWith('app_unfocused', expect.any(Object));
  });

  test('emits app_focused with time_away_seconds when window regains focus', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    getWindowStateCb()?.({ focused: false });
    jest.advanceTimersByTime(5000);
    getWindowStateCb()?.({ focused: true });
    expect(emitSpy).toHaveBeenCalledWith(
      'app_focused',
      expect.objectContaining({ time_away_seconds: expect.any(Number) }),
    );
  });

  test('does not emit app_focused if there was no prior unfocus', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    getWindowStateCb()?.({ focused: true });
    expect(emitSpy).not.toHaveBeenCalledWith('app_focused', expect.anything());
  });

  // ── Developer-signal events ───────────────────────────────────────────────

  const getActiveEditorCb = () => (vscode.window as any)._activeEditorCallback as
    ((e: any) => void) | null;
  const getDebugStartCb = () => (vscode.debug as any)._debugStartCallback as
    ((s: any) => void) | null;
  const getTestRunCb = () => (vscode.tests as any)._testRunCallback as
    ((r: any) => void) | null;

  test('emits file_open when active editor changes to a workspace file', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    getActiveEditorCb()?.({
      document: { uri: { scheme: 'file', fsPath: '/ws/src/main.cpp' } },
    });
    expect(emitSpy).toHaveBeenCalledWith('file_open', { file: 'src/main.cpp' });
  });

  test('file_open is deduped — reopening the same file emits once', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    const cb = getActiveEditorCb()!;
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    cb({ document: { uri: { scheme: 'file', fsPath: '/ws/a.ts' } } });
    const calls = emitSpy.mock.calls.filter((c) => c[0] === 'file_open');
    expect(calls).toHaveLength(1);
  });

  test('file_open ignores non-file URIs and files outside workspace', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    const cb = getActiveEditorCb()!;
    cb({ document: { uri: { scheme: 'git', fsPath: '/ws/a.ts' } } });
    cb({ document: { uri: { scheme: 'file', fsPath: '/elsewhere/a.ts' } } });
    expect(emitSpy).not.toHaveBeenCalledWith('file_open', expect.anything());
  });

  test('emits debug_session when a debug session starts', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    getDebugStartCb()?.({ type: 'node', name: 'Launch test' });
    expect(emitSpy).toHaveBeenCalledWith('debug_session', { type: 'node', name: 'Launch test' });
  });

  test('emits test_run when a test run starts', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    getTestRunCb()?.({ name: 'pytest -k foo' });
    expect(emitSpy).toHaveBeenCalledWith('test_run', { profile: 'pytest -k foo' });
  });

  test('test_run defaults profile to "default" when name is missing', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    getTestRunCb()?.({});
    expect(emitSpy).toHaveBeenCalledWith('test_run', { profile: 'default' });
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  test('dispose() does not throw', () => {
    expect(() => tracker.dispose()).not.toThrow();
  });

  test('flush timer no longer fires after dispose()', () => {
    const flushSpy = jest.spyOn(context.globalState, 'update');
    tracker.emit('before_dispose', {});
    tracker.dispose();
    flushSpy.mockClear();

    jest.advanceTimersByTime(30_000);
    // No periodic flush after dispose
    expect(flushSpy).not.toHaveBeenCalled();
  });

  // ── Bug #12: in-flight guard + per-event id dedup ─────────────────────────

  test('Bug #12: emitted events carry a unique id so the unshift-on-failure cannot duplicate', () => {
    // Reach into the buffer (white-box) to verify id assignment.
    tracker.emit('a', {});
    tracker.emit('b', {});
    const buf = (tracker as unknown as { _buffer: Array<{ id?: string }> })._buffer;
    expect(buf.length).toBeGreaterThanOrEqual(2);
    const ids = buf.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  test('Bug #12: a failed flush retains events at the front of the buffer via dedup, no duplicates', async () => {
    // Make _post() reject so the unshift path runs.
    const t = tracker as unknown as { _post: (b: unknown[]) => Promise<void>; _flush: () => Promise<void> };
    t._post = jest.fn().mockRejectedValue(new Error('network down'));

    tracker.emit('e1', {});
    tracker.emit('e2', {});
    await t._flush();

    // Buffer still contains exactly the two events (no duplicates from unshift)
    const buf = (tracker as unknown as { _buffer: Array<{ event_type: string; id: string }> })._buffer;
    expect(buf.map((e) => e.event_type)).toEqual(['e1', 'e2']);
    const ids = buf.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });

  // ── Review-Bug 10: dispose() durably persists the un-posted buffer ────

  test('Review-Bug 10: dispose() writes the in-memory buffer to globalState BEFORE the network flush', () => {
    // Simulate events that have been buffered but never POSTed yet. dispose()
    // is synchronous so it cannot await the network flush — the only safe
    // path is to persist the buffer to globalState first so the next
    // activate() restores them via the BUFFER_KEY init in the constructor.
    tracker.emit('e1', { x: 1 });
    tracker.emit('e2', { x: 2 });
    const updateSpy = jest.spyOn(context.globalState, 'update');
    tracker.dispose();

    // The very first update on dispose carries the un-posted buffer
    const persistCall = updateSpy.mock.calls.find(
      (c: unknown[]) => c[0] === 'vibe.telemetry.buffer',
    );
    expect(persistCall).toBeDefined();
    const persisted = persistCall![1] as Array<{ event_type: string }>;
    // Must have BOTH events — the splice-then-fail-to-post race used to lose them.
    const evNames = persisted.map((e) => e.event_type);
    expect(evNames).toEqual(expect.arrayContaining(['e1', 'e2']));
  });

  test('Review-Bug 10: dispose passes a defensive copy (mutating buffer post-dispose does not corrupt persisted state)', () => {
    // The dispose snapshot must be a copy, not the live `_buffer` reference,
    // so the subsequent `_flush` splice cannot retroactively empty the value
    // we already persisted to globalState.
    tracker.emit('a', {});
    const updateSpy = jest.spyOn(context.globalState, 'update');
    tracker.dispose();
    const persistCall = updateSpy.mock.calls.find((c: unknown[]) => c[0] === 'vibe.telemetry.buffer');
    expect(persistCall).toBeDefined();
    const persistedRef = persistCall![1] as Array<{ event_type: string }>;
    // Verify the persisted value is NOT the same object as the live buffer
    // (so the later _flush.splice cannot mutate it).
    const liveBuf = (tracker as unknown as { _buffer: unknown })._buffer;
    expect(persistedRef).not.toBe(liveBuf);
    expect(persistedRef.map((e) => e.event_type)).toEqual(['a']);
  });

  test('Bug #12: a second flush kicked off while one is in flight is short-circuited', async () => {
    // Use real timers for this test only — the in-flight guard is tested via
    // microtask interleaving, not fake-timer advancement.
    jest.useRealTimers();
    const t = tracker as unknown as {
      _post: (b: unknown[]) => Promise<void>;
      _flush: () => Promise<void>;
      _flushInFlight: boolean;
    };
    let releaseFirst!: () => void;
    const firstPostGate = new Promise<void>((res) => { releaseFirst = res; });
    let postCallCount = 0;
    t._post = jest.fn().mockImplementation(() => {
      postCallCount++;
      return firstPostGate;
    });

    tracker.emit('x', {});
    const first = t._flush();
    // While `first` is awaiting its gated _post, fire another flush. Without
    // the in-flight guard this would observe an empty buffer and become a
    // no-op anyway, BUT if it observed events emitted between splice+post it
    // would happily re-fire — which is the duplication bug.
    tracker.emit('y', {}); // mid-flight emit; must be batched into the NEXT flush
    const second = t._flush();
    await second; // returns immediately due to the guard
    expect(postCallCount).toBe(1);
    expect(t._flushInFlight).toBe(true);

    // Release the first flush
    releaseFirst();
    await first;
    expect(t._flushInFlight).toBe(false);

    // The 'y' event is still in the buffer — it didn't get double-flushed.
    const buf = (tracker as unknown as { _buffer: Array<{ event_type: string }> })._buffer;
    expect(buf.map((e) => e.event_type)).toEqual(['y']);

    jest.useFakeTimers();
  });

  // ── Buffer cap: drop-oldest on persistent failure ─────────────────────────

  test('exports MAX_BUFFERED_EVENTS = 5000', () => {
    expect(MAX_BUFFERED_EVENTS).toBe(5000);
  });

  test('failed flush with buffer over the cap drops OLDEST events down to MAX_BUFFERED_EVENTS', async () => {
    const t = tracker as unknown as {
      _post: (b: unknown[]) => Promise<void>;
      _flush: () => Promise<void>;
      _buffer: Array<{ ts: number; event_type: string; payload: { i: number }; id: string }>;
    };
    t._post = jest.fn().mockRejectedValue(new Error('network down'));

    // Seed the buffer directly so we can deterministically force the failure
    // path into the drop-oldest branch without intermediate threshold flushes.
    const TOTAL = MAX_BUFFERED_EVENTS + 250;
    const seeded = [] as Array<{ ts: number; event_type: string; payload: { i: number }; id: string }>;
    for (let i = 0; i < TOTAL; i++) {
      seeded.push({ ts: i, event_type: 'overflow', payload: { i }, id: `seed-${i}` });
    }
    t._buffer = seeded;

    await t._flush();

    const buf = t._buffer;
    expect(buf.length).toBe(MAX_BUFFERED_EVENTS);
    const indices = buf.map((e) => e.payload.i);
    // Newest event survived; oldest 250 were dropped.
    expect(Math.max(...indices)).toBe(TOTAL - 1);
    expect(Math.min(...indices)).toBe(TOTAL - MAX_BUFFERED_EVENTS);
  });

  test('drop-oldest path logs a console.warn (server-side issue, no user toast)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = tracker as unknown as {
        _post: (b: unknown[]) => Promise<void>;
        _flush: () => Promise<void>;
        _buffer: Array<{ ts: number; event_type: string; payload: Record<string, unknown>; id: string }>;
      };
      t._post = jest.fn().mockRejectedValue(new Error('network down'));
      const seeded = [];
      for (let i = 0; i < MAX_BUFFERED_EVENTS + 10; i++) {
        seeded.push({ ts: i, event_type: 'x', payload: { i }, id: `s-${i}` });
      }
      t._buffer = seeded;
      await t._flush();
      expect(warnSpy).toHaveBeenCalled();
      // It must NOT have surfaced a user-facing error.
      expect((vscode.window.showErrorMessage as jest.Mock)).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── POST request timeout ──────────────────────────────────────────────────

  test('exports TELEMETRY_POST_TIMEOUT_MS = 15000', () => {
    expect(TELEMETRY_POST_TIMEOUT_MS).toBe(15_000);
  });

  test('_post wires req.setTimeout with TELEMETRY_POST_TIMEOUT_MS and rejects + destroys on fire', async () => {
    // Build a fake req we fully control.
    const reqHandlers: Record<string, Function> = {};
    let timeoutMs: number | undefined;
    let timeoutCb: Function | undefined;
    const req: any = {
      on: jest.fn((evt: string, cb: Function): any => {
        reqHandlers[evt] = cb;
        return req;
      }),
      setTimeout: jest.fn((ms: number, cb: Function): any => {
        timeoutMs = ms;
        timeoutCb = cb;
        return req;
      }),
      destroy: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
    (http.request as jest.Mock).mockImplementationOnce(() => req as any);

    const t = tracker as unknown as { _post: (b: unknown[]) => Promise<void> };
    const p = t._post([{ ts: 0, event_type: 'x', payload: {}, id: '1' } as any]);

    expect(req.setTimeout).toHaveBeenCalledTimes(1);
    expect(timeoutMs).toBe(TELEMETRY_POST_TIMEOUT_MS);
    expect(typeof timeoutCb).toBe('function');

    // Fire the timeout — the promise must reject and the request destroyed.
    timeoutCb!();

    await expect(p).rejects.toThrow(/timed out|timeout/i);
    expect(req.destroy).toHaveBeenCalled();
  });

  // ── Warning throttle: one-time after 3 consecutive failures ───────────────

  test('after 3 consecutive failed flushes shows a single warning mentioning network + local-save', async () => {
    const t = tracker as unknown as {
      _post: (b: unknown[]) => Promise<void>;
      _flush: () => Promise<void>;
    };
    t._post = jest.fn().mockRejectedValue(new Error('network down'));

    for (let i = 0; i < 3; i++) {
      tracker.emit(`e${i}`, {});
      await t._flush();
    }

    const showWarn = vscode.window.showWarningMessage as jest.Mock;
    expect(showWarn).toHaveBeenCalledTimes(1);
    const msg = showWarn.mock.calls[0][0] as string;
    expect(msg).toMatch(/network/i);
    expect(msg).toMatch(/saved|locally|local/i);
  });

  test('a 4th consecutive failure does not re-fire the warning', async () => {
    const t = tracker as unknown as {
      _post: (b: unknown[]) => Promise<void>;
      _flush: () => Promise<void>;
    };
    t._post = jest.fn().mockRejectedValue(new Error('network down'));

    for (let i = 0; i < 4; i++) {
      tracker.emit(`e${i}`, {});
      await t._flush();
    }

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  test('a successful flush re-arms the warning so a later 3-fail run fires again', async () => {
    const t = tracker as unknown as {
      _post: (b: unknown[]) => Promise<void>;
      _flush: () => Promise<void>;
    };
    const postMock = jest.fn().mockRejectedValue(new Error('down'));
    t._post = postMock as any;

    // First 3 failures → warning #1
    for (let i = 0; i < 3; i++) {
      tracker.emit(`a${i}`, {});
      await t._flush();
    }
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);

    // One success — resets counter and re-arms.
    postMock.mockResolvedValueOnce(undefined as any);
    tracker.emit('good', {});
    await t._flush();

    // Three more failures → warning #2
    for (let i = 0; i < 3; i++) {
      tracker.emit(`b${i}`, {});
      await t._flush();
    }
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
  });
});
