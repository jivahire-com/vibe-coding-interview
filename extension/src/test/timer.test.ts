import { Timer } from '../timer';
import * as vscode from 'vscode';
import { makeConfig } from './helpers';

describe('Timer', () => {
  let timer: Timer;
  let mockBar: ReturnType<typeof makeMockBar>;

  function makeMockBar() {
    return {
      command: undefined as string | undefined,
      text: '',
      backgroundColor: undefined as vscode.ThemeColor | undefined,
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    mockBar = makeMockBar();
    (vscode.window.createStatusBarItem as jest.Mock).mockReturnValue(mockBar);
    timer = new Timer();
  });

  afterEach(() => {
    timer.dispose();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('start() shows the status bar and ticks immediately', () => {
    timer.start(makeConfig({ startedAt: Date.now(), maxMinutes: 60 }));
    expect(mockBar.show).toHaveBeenCalledTimes(1);
    expect(mockBar.text).toMatch(/\d{2}:\d{2} remaining/);
  });

  test('start() formats MM:SS correctly', () => {
    const now = Date.now();
    // 45 min 30 sec remaining
    timer.start(makeConfig({ startedAt: now - (60 - 45) * 60_000 + 30_000, maxMinutes: 60 }));
    expect(mockBar.text).toContain('45:');
  });

  test('stop() hides the status bar', () => {
    timer.start(makeConfig());
    timer.stop();
    expect(mockBar.hide).toHaveBeenCalled();
  });

  test('stop() is safe to call when not started', () => {
    expect(() => timer.stop()).not.toThrow();
  });

  test('dispose() stops the interval and disposes the bar', () => {
    timer.start(makeConfig());
    timer.dispose();
    expect(mockBar.dispose).toHaveBeenCalled();
  });

  test('start() called twice replaces the interval without leaking (Bug #16)', () => {
    const config = makeConfig({ startedAt: Date.now(), maxMinutes: 60 });
    timer.start(config);
    const firstHideCount = mockBar.hide.mock.calls.length;
    timer.start(config); // second start should stop the first
    // stop() was called once to cancel the previous interval
    expect(mockBar.hide.mock.calls.length).toBeGreaterThan(firstHideCount);
  });

  test('uses error background color when < 2 min remaining', () => {
    const startedAt = Date.now() - 58.5 * 60_000; // 1m30s remaining on 60min session
    timer.start(makeConfig({ startedAt, maxMinutes: 60 }));
    expect(mockBar.backgroundColor).toBeInstanceOf(vscode.ThemeColor);
    expect((mockBar.backgroundColor as vscode.ThemeColor).id).toBe('statusBarItem.errorBackground');
  });

  test('uses warning background color when < 10 min remaining', () => {
    const startedAt = Date.now() - 52 * 60_000; // 8 min remaining
    timer.start(makeConfig({ startedAt, maxMinutes: 60 }));
    expect(mockBar.backgroundColor).toBeInstanceOf(vscode.ThemeColor);
    expect((mockBar.backgroundColor as vscode.ThemeColor).id).toBe('statusBarItem.warningBackground');
  });

  test('no special color when plenty of time remains', () => {
    timer.start(makeConfig({ startedAt: Date.now(), maxMinutes: 60 }));
    expect(mockBar.backgroundColor).toBeUndefined();
  });

  test('shows 00:00 and stops when session is expired', () => {
    const startedAt = Date.now() - 120 * 60_000; // 2h ago, 60min session
    timer.start(makeConfig({ startedAt, maxMinutes: 60 }));
    expect(mockBar.text).toContain('00:00');
    // stop() hides bar on expiry
    expect(mockBar.hide).toHaveBeenCalled();
  });

  test('tick fires every second via setInterval', () => {
    const config = makeConfig({ startedAt: Date.now(), maxMinutes: 60 });
    timer.start(config);
    mockBar.text = ''; // reset
    jest.advanceTimersByTime(1000);
    expect(mockBar.text).toMatch(/\d{2}:\d{2} remaining/);
  });
});
