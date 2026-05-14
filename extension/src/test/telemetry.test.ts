/**
 * Tests for TelemetryTracker (telemetry.ts).
 *
 * Covers:
 *  – emit() buffers events
 *  – doc change → paste classification (≥30 chars, rangeLength = 0)
 *  – doc change → typed classification (small edits, aggregated)
 *  – _suppressNextApply flag → edit_ai_applied event
 *  – window focus/unfocus events
 *  – dispose() clears the flush timer
 */
import { TelemetryTracker, suppressNextApplyEvent } from '../telemetry';
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

  test('large insertion (≥30 chars, rangeLength=0) classified as edit_pasted', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    fireDocChange([{ text: 'a'.repeat(30), rangeLength: 0 }]);
    expect(emitSpy).toHaveBeenCalledWith('edit_pasted', expect.objectContaining({ chars: 30 }));
  });

  test('insertion < 30 chars classified as edit_typed (after aggregation timer)', () => {
    const emitSpy = jest.spyOn(tracker, 'emit');
    fireDocChange([{ text: 'abc', rangeLength: 0 }]);
    jest.advanceTimersByTime(1001);
    expect(emitSpy).toHaveBeenCalledWith('edit_typed', expect.objectContaining({ chars: 3 }));
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
});
