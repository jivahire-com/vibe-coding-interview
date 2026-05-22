import { Timer, TimerTick } from '../timer';
import { makeConfig } from './helpers';

describe('Timer', () => {
  let timer: Timer;
  let ticks: TimerTick[];

  beforeEach(() => {
    jest.useFakeTimers();
    ticks = [];
    timer = new Timer();
    timer.onTick((t) => ticks.push(t));
  });

  afterEach(() => {
    timer.dispose();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('onTick fires immediately with the idle value before start()', () => {
    // beforeEach already attached the listener — it should have received the
    // initial "--:--" idle tick so the chat toolbar isn't blank on render.
    expect(ticks.length).toBe(1);
    expect(ticks[0].text).toBe('--:--');
    expect(ticks[0].running).toBe(false);
  });

  test('start() emits a running tick formatted MM:SS', () => {
    timer.start(makeConfig({ startedAt: Date.now(), maxMinutes: 60 }));
    const last = ticks[ticks.length - 1];
    expect(last.text).toMatch(/^\d{2}:\d{2}$/);
    expect(last.running).toBe(true);
  });

  test('start() formats minutes correctly', () => {
    const now = Date.now();
    // 45 min 30 sec remaining: startedAt = now - (60 - 45) min + 30s
    timer.start(makeConfig({ startedAt: now - (60 - 45) * 60_000 + 30_000, maxMinutes: 60 }));
    const last = ticks[ticks.length - 1];
    expect(last.text.startsWith('45:')).toBe(true);
  });

  test('stop() emits a final non-running tick', () => {
    timer.start(makeConfig());
    const beforeStop = ticks.length;
    timer.stop();
    expect(ticks.length).toBeGreaterThan(beforeStop);
    expect(ticks[ticks.length - 1].running).toBe(false);
  });

  test('stop() is safe to call when not started', () => {
    expect(() => timer.stop()).not.toThrow();
  });

  test('dispose() stops the interval and clears listeners', () => {
    timer.start(makeConfig());
    timer.dispose();
    const lenAfterDispose = ticks.length;
    jest.advanceTimersByTime(5000);
    // No more ticks should fire after dispose.
    expect(ticks.length).toBe(lenAfterDispose);
  });

  test('start() called twice replaces the interval without leaking', () => {
    const config = makeConfig({ startedAt: Date.now(), maxMinutes: 60 });
    timer.start(config);
    const after1 = ticks.length;
    timer.start(config); // second start should stop the first and emit again
    expect(ticks.length).toBeGreaterThan(after1);
  });

  test('severity is "error" when < 2 min remaining', () => {
    const startedAt = Date.now() - 58.5 * 60_000; // 1m30s remaining on 60min session
    timer.start(makeConfig({ startedAt, maxMinutes: 60 }));
    expect(ticks[ticks.length - 1].severity).toBe('error');
  });

  test('severity is "warn" when < 10 min remaining', () => {
    const startedAt = Date.now() - 52 * 60_000; // 8 min remaining
    timer.start(makeConfig({ startedAt, maxMinutes: 60 }));
    expect(ticks[ticks.length - 1].severity).toBe('warn');
  });

  test('severity is "ok" when plenty of time remains', () => {
    timer.start(makeConfig({ startedAt: Date.now(), maxMinutes: 60 }));
    expect(ticks[ticks.length - 1].severity).toBe('ok');
  });

  test('emits 00:00 and stops when session is expired', () => {
    const startedAt = Date.now() - 120 * 60_000; // 2h ago, 60min session
    timer.start(makeConfig({ startedAt, maxMinutes: 60 }));
    const last = ticks[ticks.length - 1];
    expect(last.text).toBe('00:00');
    expect(last.running).toBe(false);
  });

  test('tick fires every second via setInterval', () => {
    const config = makeConfig({ startedAt: Date.now(), maxMinutes: 60 });
    timer.start(config);
    const before = ticks.length;
    jest.advanceTimersByTime(1000);
    expect(ticks.length).toBeGreaterThan(before);
  });

  test('newly attached listener receives the most recent tick', () => {
    timer.start(makeConfig({ startedAt: Date.now(), maxMinutes: 60 }));
    const second: TimerTick[] = [];
    timer.onTick((t) => second.push(t));
    // Should be primed with the current running tick, not the idle one.
    expect(second.length).toBe(1);
    expect(second[0].running).toBe(true);
  });
});
