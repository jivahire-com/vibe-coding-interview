/**
 * Tests for the activate() function in src/extension.ts.
 *
 * Covers:
 *  Bug #1 – Commands registered unconditionally (before early-return paths)
 *  Bug #2 – vibe.dashboard.focus executed on happy path to trigger resolveWebviewView
 *  Bug #3 – _samePath uses fs.realpathSync for symlink-safe comparison
 */

// ─── Mock node modules before any imports ────────────────────────────────────

jest.mock('fs');
jest.mock('child_process');
jest.mock('os');
jest.mock('../api');
jest.mock('../timer');
jest.mock('../telemetry');
jest.mock('../submit');
jest.mock('../welcome/panel');
jest.mock('../chat/view');
jest.mock('../chat/apply');

import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { activate, _samePath } from '../extension';
import { makeMockContext, makeConfig } from './helpers';

// ─── Type helpers for mocked modules ─────────────────────────────────────────

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedOs = os as jest.Mocked<typeof os>;
const mockedExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>;

// ─── Constants ────────────────────────────────────────────────────────────────

const CLONE_DIR = '/home/testuser/vibe-aabbccdd';

const ALL_COMMANDS = [
  'vibe.enterSessionKey',
  'vibe.showBrief',
  'vibe.openChat',
  'vibe.submit',
  'vibe.applyCodeBlock',
  'vibe.acceptAiChanges',
  'vibe.rejectAiChanges',
];

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  // os.homedir() → predictable path
  mockedOs.homedir.mockReturnValue('/home/testuser');
  mockedOs.tmpdir.mockReturnValue('/tmp');

  // fs.realpathSync → identity (no real symlinks in tests)
  mockedFs.realpathSync.mockImplementation((p: fs.PathLike) => String(p));

  // Default: cloneDir does NOT exist on disk
  mockedFs.existsSync.mockReturnValue(false);

  // Reset workspace folders to undefined (no open workspace)
  (vscode.workspace as any).workspaceFolders = undefined;
});

// ─── Helper: collect registered command names ─────────────────────────────────

function registeredCommandNames(): string[] {
  return (vscode.commands.registerCommand as jest.Mock).mock.calls.map(
    (call: any[]) => call[0] as string,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('activate() – command registration', () => {
  test('registers all commands even when no saved session', async () => {
    const ctx = makeMockContext(); // no session in globalState
    await activate(ctx);

    const names = registeredCommandNames();
    for (const cmd of ALL_COMMANDS) {
      expect(names).toContain(cmd);
    }
  });

  test('registers all commands even when workspace mismatch triggers early return (user dismisses dialog)', async () => {
    // Session exists, cloneDir exists, but workspaceFolders points elsewhere
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    // User dismisses the dialog (returns undefined)
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    const names = registeredCommandNames();
    for (const cmd of ALL_COMMANDS) {
      expect(names).toContain(cmd);
    }
  });

  test('registers all commands even when user clicks Reopen', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Reopen');

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    const names = registeredCommandNames();
    for (const cmd of ALL_COMMANDS) {
      expect(names).toContain(cmd);
    }

    // Also verify openFolder was called
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({ fsPath: CLONE_DIR }),
      false,
    );
  });
});

describe('activate() – Reopen dialog behaviour', () => {
  test('shows Reopen dialog when workspace does not match cloneDir', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('active interview session'),
      expect.objectContaining({ modal: true }),
      'Reopen',
      'Start Fresh',
    );
  });

  test('no Reopen dialog when already in correct workspace', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: CLONE_DIR } },
    ];

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  test('does not call openFolder when user dismisses Reopen dialog', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    const openFolderCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls.filter(
      (call: any[]) => call[0] === 'vscode.openFolder',
    );
    expect(openFolderCalls).toHaveLength(0);
  });
});

describe('activate() – happy path (correct workspace)', () => {
  test('dashboard.focus is executed after successful session setup', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: CLONE_DIR } },
    ];

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vibe.dashboard.focus');
  });
});

describe('activate() – cloneDir missing (modal + clone-on-Reopen)', () => {
  test('cloneDir missing → modal appears (no silent clone) so a stale session cannot hijack a fresh invite', async () => {
    // Repro: candidate previously did a cpp interview, that session is still
    // in globalState, and now a new TypeScript invite was sent. If the
    // previous clone dir was wiped, activate() must NOT silently re-clone the
    // stale cpp session — the candidate needs the opportunity to pick
    // "Start Fresh" and enter the new TypeScript session key.
    mockedFs.existsSync.mockReturnValue(false);
    // No response yet — verifying that the modal fires and we do NOT clone.
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    // Modal was shown
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('no longer on disk'),
      expect.objectContaining({ modal: true }),
      'Reopen',
      'Start Fresh',
    );

    // CRITICAL: no clone happened, no folder opened
    const cloneCalls = mockedExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('clone'),
    );
    expect(cloneCalls).toHaveLength(0);
    const openFolderCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls.filter(
      (call: any[]) => call[0] === 'vscode.openFolder',
    );
    expect(openFolderCalls).toHaveLength(0);
  });

  test('cloneDir missing → Start Fresh clears the saved session so a new key can be entered', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Start Fresh');

    const ctx = makeMockContext({
      'vibe.session': makeConfig(),
      'vibe.openedWs': '/some/old/marker',
    });
    await activate(ctx);

    // Saved session and workspace marker are cleared.
    expect(ctx.globalState.get('vibe.session')).toBeUndefined();
    expect(ctx.globalState.get('vibe.openedWs')).toBeUndefined();

    // No clone, no openFolder.
    const cloneCalls = mockedExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('clone'),
    );
    expect(cloneCalls).toHaveLength(0);
    const openFolderCalls = (vscode.commands.executeCommand as jest.Mock).mock.calls.filter(
      (call: any[]) => call[0] === 'vscode.openFolder',
    );
    expect(openFolderCalls).toHaveLength(0);
  });

  test('cloneDir missing → Reopen clones the saved session and opens the folder', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Reopen');

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    // Clone uses execFileSync with an argv (no shell interpolation).
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '-b']),
      expect.objectContaining({ shell: false }),
    );

    // openFolder should have been called with the cloneDir URI
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({ fsPath: CLONE_DIR }),
      false,
    );
  });

  test('Bug #4: branch / repo URL with shell metachars are passed as argv slots, never shell-interpolated', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Reopen');
    const hostile = makeConfig({
      branch: 'main"; rm -rf ~; echo "',
      repoUrl: 'https://github.com/x$(touch /tmp/pwn)/r',
      githubToken: 'tok$(whoami)',
    });
    const ctx = makeMockContext({ 'vibe.session': hostile });
    await activate(ctx);

    const cloneCall = mockedExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('clone'),
    );
    expect(cloneCall).toBeDefined();
    const args = cloneCall![1] as string[];
    // The hostile branch lands in ONE argv slot — execve never re-parses it.
    expect(args).toContain('main"; rm -rf ~; echo "');
    // shell:false is what makes the above safe.
    const opts = cloneCall![2] as { shell?: boolean };
    expect(opts.shell).toBe(false);
  });
});

describe('_samePath robustness (Bug #3)', () => {
  beforeEach(() => {
    mockedFs.realpathSync.mockImplementation((p: fs.PathLike) => String(p));
    // Reset statSync to a benign "throws" so each test in this block opts in
    // to the inode path explicitly. Without this, an inode mock from one test
    // leaks into the next and makes _samePath return true for unrelated paths.
    (mockedFs.statSync as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('not mocked');
    });
  });

  afterAll(() => {
    // Make sure no leftover statSync mock leaks into later describe blocks.
    (mockedFs.statSync as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('not mocked');
    });
  });

  test('returns true for identical paths', () => {
    expect(_samePath('/a/b', '/a/b')).toBe(true);
  });

  test('strips trailing separators before comparing', () => {
    expect(_samePath('/a/b/', '/a/b')).toBe(true);
    expect(_samePath('/a/b', '/a/b/')).toBe(true);
  });

  test('returns true for case-equivalent paths on case-insensitive FS', () => {
    expect(_samePath('/A/B', '/a/b')).toBe(true);
  });

  test('returns true when realpath canonicalises macOS-style /private prefix', () => {
    mockedFs.realpathSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      if (s.startsWith('/var')) return '/private' + s;
      return s;
    });
    expect(_samePath('/var/foo', '/private/var/foo')).toBe(true);
  });

  test('returns true when device + inode match (covers exotic symlink chains)', () => {
    mockedFs.realpathSync.mockImplementation(() => { throw new Error('boom'); });
    (mockedFs.statSync as unknown as jest.Mock).mockImplementation(
      () => ({ ino: 42, dev: 1 }) as fs.Stats,
    );
    expect(_samePath('/a', '/b')).toBe(true);
  });

  test('returns false for undefined / empty paths', () => {
    expect(_samePath(undefined, '/a')).toBe(false);
    expect(_samePath('/a', undefined)).toBe(false);
  });

  test('returns false for genuinely different paths', () => {
    mockedFs.realpathSync.mockImplementation((p: fs.PathLike) => String(p));
    (mockedFs.statSync as unknown as jest.Mock).mockImplementation(
      (p: fs.PathLike) => ({ ino: p === '/a' ? 1 : 2, dev: 1 }) as fs.Stats,
    );
    expect(_samePath('/a', '/b')).toBe(false);
  });
});

// ── Review-Bug 14: auto-commit interval is stopped on submit ──────────────

describe('vibe.submit command (Review-Bug 14)', () => {
  test('Review-Bug 14: invoking vibe.submit clears the saved session and stops the auto-commit interval', async () => {
    // The submit module is mocked at the top of this file via
    // jest.mock('../submit'). Wire its runSubmit to behave like the real one:
    // call the deps hooks (onStopTimer → onSubmitted → onMarkSubmitted).
    const submitMod = require('../submit');
    submitMod.runSubmit = jest.fn(async (_cfg: unknown, deps: { onStopTimer?: () => void; onSubmitted?: () => Promise<void>; onMarkSubmitted?: () => void }) => {
      deps.onStopTimer?.();
      await deps.onSubmitted?.();
      deps.onMarkSubmitted?.();
    });
    // Auto-commit calls gitCommitAndPushAsync which is also auto-mocked.
    // Make it return a resolved promise so any timer callback that fires
    // before stop() runs doesn't throw on `.then(undefined)`.
    submitMod.gitCommitAndPushAsync = jest.fn().mockResolvedValue(undefined);

    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: CLONE_DIR } }];
    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    // Capture the auto-commit interval handles set up during activate().
    // Other long-lived intervals (e.g. the Logger's 10s log-flush timer) are
    // explicitly NOT in scope here — they outlive a session and are torn
    // down via context.subscriptions on deactivate, not on submit. Filter to
    // the 180s auto-commit cadence so this assertion stays meaningful as
    // more background timers get added.
    const AUTO_COMMIT_INTERVAL_MS = 180_000;
    const intervalHandles = setIntervalSpy.mock.results
      .filter((_r, i) => setIntervalSpy.mock.calls[i][1] === AUTO_COMMIT_INTERVAL_MS)
      .map((r) => r.value);
    expect(intervalHandles.length).toBeGreaterThanOrEqual(1);

    // Find the registered vibe.submit command handler and invoke it
    const submitReg = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
      (c) => c[0] === 'vibe.submit',
    );
    expect(submitReg).toBeDefined();
    const submitHandler = submitReg![1] as () => Promise<void>;
    await submitHandler();

    // After successful submit, every interval handle was cleared.
    for (const handle of intervalHandles) {
      const cleared = clearIntervalSpy.mock.calls.some((c) => c[0] === handle);
      expect(cleared).toBe(true);
    }

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});

describe('Reopen dialog → next activation does not re-prompt (Bug #3)', () => {
  test('once the user has accepted Reopen, OPENED_WS_KEY shortcut prevents the dialog from re-firing', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    // First run: workspace mismatch → dialog → Reopen accepted → persist marker
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Reopen');
    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    // Marker was persisted
    expect(ctx.globalState.get('vibe.openedWs')).toBe(CLONE_DIR);

    // Second run: workspaceFolders is the cloneDir but realpathSync resolves it
    // to a DIFFERENT canonical form. The marker rescues us.
    jest.clearAllMocks();
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: CLONE_DIR } },
    ];
    mockedFs.realpathSync.mockImplementation((p: fs.PathLike) => String(p));

    await activate(ctx);
    // No dialog this time
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});

// ── Bug A: silent auto-commit failures must surface in the chat panel ─────

describe('auto-commit failures surface in the chat panel (Bug A)', () => {
  test('after 2 consecutive push failures, chatProvider.setOfflineState is invoked; clears on next success', async () => {
    const submitMod = require('../submit');
    let nextResult: Promise<unknown> = Promise.resolve(undefined);
    submitMod.gitCommitAndPushAsync = jest.fn(() => nextResult);

    // Spy on ChatViewProvider's setOfflineState — the action buttons and the
    // offline banner now live inside the chat webview, so the production code
    // surfaces auto-commit health through that method.
    const chatMod = require('../chat/view');
    const setOfflineSpy = jest.fn();
    chatMod.ChatViewProvider.mockImplementation(() => ({
      attachTimer: jest.fn(),
      setConfig: jest.fn(),
      setOfflineState: setOfflineSpy,
      markEnded: jest.fn(),
      focus: jest.fn(),
      dispose: jest.fn(),
      resolveWebviewView: jest.fn(),
    }));

    jest.useFakeTimers();
    try {
      mockedFs.existsSync.mockReturnValue(true);
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: CLONE_DIR } }];
      const ctx = makeMockContext({ 'vibe.session': makeConfig() });
      await activate(ctx);

      // Helper: a rejected promise with a no-op .catch() pre-attached so Node
      // 20's unhandled-rejection check doesn't crash the worker before the
      // production code attaches its own .catch() inside the timer callback.
      const rejected = (msg: string): Promise<unknown> => {
        const p = Promise.reject(new Error(msg));
        p.catch(() => { /* observed */ });
        return p;
      };

      // Tick 1 — failure
      nextResult = rejected('push rejected');
      jest.advanceTimersByTime(180_000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      // After only 1 failure, no offline banner yet.
      const offlineCallsAfterOne = setOfflineSpy.mock.calls.filter(([on]) => on === true);
      expect(offlineCallsAfterOne.length).toBe(0);

      // Tick 2 — second consecutive failure
      nextResult = rejected('push rejected again');
      jest.advanceTimersByTime(180_000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      // Now setOfflineState(true, ...) must have been called with a
      // candidate-readable warning message.
      const offlineCallsAfterTwo = setOfflineSpy.mock.calls.filter(([on]) => on === true);
      expect(offlineCallsAfterTwo.length).toBeGreaterThanOrEqual(1);
      const [, message] = offlineCallsAfterTwo[offlineCallsAfterTwo.length - 1];
      expect(String(message)).toMatch(/auto-save offline/i);

      // Tick 3 — recovery
      nextResult = Promise.resolve(undefined);
      jest.advanceTimersByTime(180_000);
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

      // After success setOfflineState(false) must have been called.
      const clearCalls = setOfflineSpy.mock.calls.filter(([on]) => on === false);
      expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      jest.useRealTimers();
      chatMod.ChatViewProvider.mockReset();
    }
  });
});

// ── Bug B: Esc on the Reopen/Start Fresh modal must surface guidance ──────

describe('Reopen modal dismissal surfaces inline guidance (Bug B)', () => {
  test('dismissing the modal (undefined) drops the brief and surfaces a Command-Palette resume hint', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);

    // Spy on the auto-mocked DashboardViewProvider's dismiss() — the working
    // tree changed the dismissal branch to drop the brief via dismiss() and
    // raise a separate showInformationMessage toast with the resume hint,
    // rather than embedding the guidance in the dashboard error slot.
    const panelMod = require('../welcome/panel');
    const dismissSpy = jest.fn();
    panelMod.DashboardViewProvider.mockImplementation(() => ({
      setConfig: jest.fn(),
      clearConfig: jest.fn(),
      markSubmitted: jest.fn(),
      reportSessionError: jest.fn(),
      dismiss: dismissSpy,
      dispose: jest.fn(),
      resolveWebviewView: jest.fn(),
    }));

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    expect(dismissSpy).toHaveBeenCalledTimes(1);
    const infoCalls = (vscode.window.showInformationMessage as jest.Mock).mock.calls;
    const resumeToast = infoCalls.find((c) => typeof c[0] === 'string' && /Enter Session Key/i.test(c[0]));
    expect(resumeToast).toBeDefined();
    expect(resumeToast![0]).toMatch(/Command Palette/i);

    // Restore default auto-mock behaviour so subsequent tests aren't affected.
    panelMod.DashboardViewProvider.mockReset();
  });
});

// ── Bug C: Start Fresh must tell the user where their work went ───────────

describe('Start Fresh reveals abandoned clone directory (Bug C)', () => {
  test('Start Fresh shows the absolute cloneDir path and a "Reveal in OS" button; clicking it runs revealFileInOS', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Start Fresh');
    // The info message simulates the candidate clicking Reveal in OS.
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Reveal in OS');

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    // The message must contain the cloneDir path.
    const infoCalls = (vscode.window.showInformationMessage as jest.Mock).mock.calls;
    expect(infoCalls.length).toBeGreaterThanOrEqual(1);
    const matching = infoCalls.find((args) => {
      const text = String(args[0] ?? '');
      const buttons = args.slice(1).map(String);
      return text.includes(CLONE_DIR) && buttons.includes('Reveal in OS');
    });
    expect(matching).toBeDefined();

    // Allow the awaited promise chain for the click handler to run.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    // The click handler must have invoked revealFileInOS with a file URI.
    const revealCall = (vscode.commands.executeCommand as jest.Mock).mock.calls.find(
      (c) => c[0] === 'revealFileInOS',
    );
    expect(revealCall).toBeDefined();
    expect(revealCall![1]).toEqual(expect.objectContaining({ fsPath: CLONE_DIR }));
  });
});
