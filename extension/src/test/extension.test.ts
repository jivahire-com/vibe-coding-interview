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
  'vibe.runTests',
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
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);

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
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Reopen');

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
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Resume'),
      'Reopen',
    );
  });

  test('no Reopen dialog when already in correct workspace', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: CLONE_DIR } },
    ];

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  test('does not call openFolder when user dismisses Reopen dialog', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue(undefined);

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

describe('activate() – cloneDir missing (clone + openFolder)', () => {
  test('clones repo and opens folder when cloneDir does not exist on disk', async () => {
    // cloneDir does NOT exist → existsSync returns false (default)
    mockedFs.existsSync.mockReturnValue(false);

    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);

    // Bug #4: clone uses execFileSync with an argv (no shell interpolation).
    // The first argv element is always the literal "git" binary.
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

describe('Reopen dialog → next activation does not re-prompt (Bug #3)', () => {
  test('once the user has accepted Reopen, OPENED_WS_KEY shortcut prevents the dialog from re-firing', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    // First run: workspace mismatch → dialog → Reopen accepted → persist marker
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/some/other/folder' } },
    ];
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Reopen');
    const ctx = makeMockContext({ 'vibe.session': makeConfig() });
    await activate(ctx);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
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
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
