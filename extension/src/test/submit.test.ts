/**
 * Tests for gitCommitAndPush (submit.ts).
 *
 * Mocks `child_process.execFileSync` so we can inspect the argv passed to git.
 * The shell-string variant was removed in favor of an argv form to close a
 * command-injection vector — these tests pin the new contract:
 *   - no argument is ever shell-interpreted
 *   - the GitHub token is always restored to an unauthenticated remote, even
 *     when `git push` throws (otherwise the next auto-commit leaks the token)
 *   - allowEmpty semantics still match the old behavior
 */
import {
  gitCommitAndPush,
  gitCommitAndPushAsync,
  buildAuthedRemoteUrl,
  buildUnauthedRemoteUrl,
  redactGitAuth,
  runSubmit,
  _acquireGitLock,
  _httpStatus,
} from '../submit';
import { execFileSync, execFile } from 'child_process';
import { makeConfig } from './helpers';
import * as vscode from 'vscode';
import * as api from '../api';

jest.mock('child_process', () => ({
  execFileSync: jest.fn().mockReturnValue(Buffer.from('')),
  execFile: jest.fn(),
}));

jest.mock('../api', () => {
  const actual = jest.requireActual('../api');
  return {
    ...actual,
    submitSession: jest.fn().mockResolvedValue(undefined),
  };
});

const mockExecFile = execFileSync as jest.Mock;
const mockExecFileAsync = execFile as unknown as jest.Mock;

interface GitCall {
  bin: string;
  args: string[];
  opts: { cwd?: string; shell?: boolean };
}

function gitCalls(): GitCall[] {
  return mockExecFile.mock.calls.map((c: unknown[]) => ({
    bin: c[0] as string,
    args: c[1] as string[],
    opts: c[2] as { cwd?: string; shell?: boolean },
  }));
}

function argvOf(calls: GitCall[], subcommand: string): string[] | undefined {
  return calls.find((c) => c.args[0] === subcommand)?.args;
}

describe('gitCommitAndPush', () => {
  const ws = '/tmp/fake-workspace';
  const config = makeConfig({
    repoUrl: 'https://github.com/org/repo',
    githubToken: 'ghstoken123',
    branch: 'interview/aabbccdd',
  });

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue(Buffer.from(''));
  });

  test('always invokes the "git" binary, never a shell command string', () => {
    gitCommitAndPush(ws, config, 'auto: 2024-01-01', true);
    for (const call of gitCalls()) {
      expect(call.bin).toBe('git');
      // The shell option must be false (or absent) so argv is not parsed.
      expect(call.opts.shell).toBe(false);
    }
  });

  test('sets git user config before committing', () => {
    gitCommitAndPush(ws, config, 'auto: 2024-01-01', true);
    const calls = gitCalls();
    const userEmail = calls.find(
      (c) => c.args[0] === 'config' && c.args[1] === 'user.email',
    );
    const userName = calls.find(
      (c) => c.args[0] === 'config' && c.args[1] === 'user.name',
    );
    expect(userEmail?.args[2]).toBe('candidate@vibe-interview.local');
    expect(userName?.args[2]).toBe('Candidate');
  });

  test('injects the github token into the authed remote URL but never into argv as a flag', () => {
    gitCommitAndPush(ws, config, 'auto: ts', true);
    const remoteSetUrls = gitCalls().filter(
      (c) => c.args[0] === 'remote' && c.args[1] === 'set-url' && c.args[2] === 'origin',
    );
    // We expect two set-url calls: authed (before commit), unauthed (cleanup).
    expect(remoteSetUrls).toHaveLength(2);
    const authed = remoteSetUrls[0].args[3];
    const unauthed = remoteSetUrls[1].args[3];
    expect(authed).toContain('x-access-token:ghstoken123');
    expect(authed).toContain('github.com/org/repo');
    expect(unauthed).not.toContain('ghstoken123');
    expect(unauthed).toBe('https://github.com/org/repo.git');
  });

  test('skips commit when allowEmpty=false and working tree is clean', () => {
    mockExecFile.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'status' && args[1] === '--porcelain') return Buffer.from('');
      return Buffer.from('');
    });
    gitCommitAndPush(ws, config, 'auto: ts', false);
    const calls = gitCalls();
    expect(calls.find((c) => c.args[0] === 'commit')).toBeUndefined();
    expect(calls.find((c) => c.args[0] === 'push')).toBeUndefined();
    // And no remote was rewritten (so we don't risk leaking the token at all)
    expect(calls.find((c) => c.args[0] === 'remote')).toBeUndefined();
  });

  test('commits when allowEmpty=false and there are changes', () => {
    mockExecFile.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return Buffer.from('M src/main.cpp');
      }
      return Buffer.from('');
    });
    gitCommitAndPush(ws, config, 'auto: ts', false);
    const calls = gitCalls();
    expect(argvOf(calls, 'commit')).toBeDefined();
    expect(argvOf(calls, 'push')).toBeDefined();
  });

  test('passes --allow-empty exactly when allowEmpty=true', () => {
    gitCommitAndPush(ws, config, 'submit: ts', true);
    const commit = argvOf(gitCalls(), 'commit');
    expect(commit).toContain('--allow-empty');
    expect(commit).toEqual(expect.arrayContaining(['commit', '-m', 'submit: ts', '--allow-empty']));
  });

  test('does NOT pass --allow-empty when allowEmpty=false', () => {
    mockExecFile.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'status' && args[1] === '--porcelain') return Buffer.from('M f');
      return Buffer.from('');
    });
    gitCommitAndPush(ws, config, 'auto: ts', false);
    const commit = argvOf(gitCalls(), 'commit');
    expect(commit).toBeDefined();
    expect(commit).not.toContain('--allow-empty');
  });

  test('the commit message is passed as an argv element, not interpolated', () => {
    const msg = 'auto: "weird" $(rm -rf ~) message';
    gitCommitAndPush(ws, config, msg, true);
    const commit = argvOf(gitCalls(), 'commit');
    expect(commit).toBeDefined();
    // Whole message is one argv entry — no shell parsing.
    expect(commit).toEqual(expect.arrayContaining(['-m', msg]));
  });

  test('uses the workspace as cwd for every git call', () => {
    gitCommitAndPush(ws, config, 'msg', true);
    for (const call of gitCalls()) {
      expect(call.opts.cwd).toBe(ws);
    }
  });

  test('Bug #5: token is restored to an unauthenticated remote even when push fails', () => {
    mockExecFile.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === 'push') throw new Error('network down');
      return Buffer.from('');
    });

    expect(() => gitCommitAndPush(ws, config, 'submit: ts', true)).toThrow('network down');

    const remoteSetUrls = gitCalls().filter(
      (c) => c.args[0] === 'remote' && c.args[1] === 'set-url' && c.args[2] === 'origin',
    );
    expect(remoteSetUrls.length).toBeGreaterThanOrEqual(2);
    const last = remoteSetUrls[remoteSetUrls.length - 1].args[3];
    // The LAST remote write must NOT contain the token (cleanup ran).
    expect(last).not.toContain('ghstoken123');
    expect(last).toBe('https://github.com/org/repo.git');
  });

  test('Bug #4: branch / repo URL containing shell metachars cannot escape into a shell', () => {
    // If args were ever interpolated into a shell string, this would execute.
    const hostileBranch = 'main"; rm -rf /tmp/foo; echo "';
    const hostileRepo = 'https://github.com/x"$(touch /tmp/pwned)"/repo';
    const hostileConfig = makeConfig({
      repoUrl: hostileRepo,
      githubToken: 'token',
      branch: hostileBranch,
    });
    gitCommitAndPush(ws, hostileConfig, 'msg', true);
    for (const call of gitCalls()) {
      // shell:false guarantees argv is passed as-is to execve(2). The hostile
      // strings show up *inside* an arg slot but are never interpreted.
      expect(call.opts.shell).toBe(false);
    }
    // And the hostile token never lands in an unrelated arg position.
    expect(gitCalls().every((c) => !c.args.includes('rm -rf /tmp/foo'))).toBe(true);
  });
});

describe('redactGitAuth (token must not leak through errors)', () => {
  test('scrubs x-access-token:<token>@ from a clone-failure message', () => {
    const raw =
      "Command failed: git clone -b interview/abc " +
      "https://x-access-token:ghp_FAKEPAT0000000000000000000000000000000@github.com/org/repo.git C:\\Users\\x\\vibe-abc\n" +
      "fatal: early EOF";
    const out = redactGitAuth(raw);
    expect(out).not.toContain('ghp_FAKEPAT0000000000000000000000000000000');
    expect(out).toContain('https://***:***@github.com/org/repo.git');
  });

  test('redacts on push errors that echo the authed remote', () => {
    const raw = "fatal: unable to access 'https://x-access-token:ghs_abcDEF123@github.com/o/r.git/': SSL error";
    expect(redactGitAuth(raw)).toBe(
      "fatal: unable to access 'https://***:***@github.com/o/r.git/': SSL error",
    );
  });

  test('leaves messages without embedded credentials untouched', () => {
    expect(redactGitAuth('fatal: not a git repository')).toBe('fatal: not a git repository');
  });

  test('synchronous git() throw is redacted before reaching callers', () => {
    mockExecFile.mockImplementationOnce(() => {
      const err = new Error(
        "Command failed: git clone https://x-access-token:ghp_LEAK@github.com/o/r.git\nfatal: early EOF",
      );
      (err as Error & { stderr?: string }).stderr =
        "Cloning into 'r'...\nfatal: unable to access 'https://x-access-token:ghp_LEAK@github.com/o/r.git/': bad record mac";
      throw err;
    });
    const config = makeConfig({ repoUrl: 'https://github.com/o/r', githubToken: 'ghp_LEAK' });
    try {
      gitCommitAndPush('/tmp/ws', config, 'msg', true);
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('ghp_LEAK');
      expect(msg).toContain('***:***@github.com/o/r');
      // Defense-in-depth: the original .stderr field is gone, so even a careless
      // logger that inspects err.stderr can't re-leak.
      expect((e as { stderr?: string }).stderr).toBeUndefined();
    }
  });
});

describe('_httpStatus', () => {
  test('extracts the status from an api.post() error message', () => {
    expect(_httpStatus(new Error('HTTP 409: Session is submitted'))).toBe(409);
    expect(_httpStatus(new Error('HTTP 401: unauthorized'))).toBe(401);
  });
  test('returns undefined for non-HTTP errors', () => {
    expect(_httpStatus(new Error('Command failed: git push'))).toBeUndefined();
    expect(_httpStatus('ECONNREFUSED')).toBeUndefined();
  });
});

describe('_acquireGitLock (serializes auto-commit vs. submit git work)', () => {
  test('a second acquirer cannot enter the critical section until the first releases', async () => {
    const order: string[] = [];

    const releaseA = await _acquireGitLock();
    order.push('A-enter');

    // B requests the lock while A holds it — it must NOT enter yet.
    let bEntered = false;
    const bDone = _acquireGitLock().then((releaseB) => {
      bEntered = true;
      order.push('B-enter');
      releaseB();
    });

    // Give the event loop a chance: B must still be blocked behind A.
    await Promise.resolve();
    await Promise.resolve();
    expect(bEntered).toBe(false);

    order.push('A-release');
    releaseA();
    await bDone;

    expect(order).toEqual(['A-enter', 'A-release', 'B-enter']);
  });
});

describe('buildAuthedRemoteUrl / buildUnauthedRemoteUrl', () => {
  test('strips a trailing .git before re-appending it', () => {
    expect(buildAuthedRemoteUrl('https://github.com/o/r.git', 't')).toBe(
      'https://x-access-token:t@github.com/o/r.git',
    );
    expect(buildAuthedRemoteUrl('https://github.com/o/r', 't')).toBe(
      'https://x-access-token:t@github.com/o/r.git',
    );
  });
  test('unauthed URL never contains a token even if input has one (defense-in-depth)', () => {
    expect(buildUnauthedRemoteUrl('https://github.com/o/r')).toBe('https://github.com/o/r.git');
  });
});

describe('gitCommitAndPushAsync (Bug #6: must not block main thread)', () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
    // Default: succeed and return empty stdout
    mockExecFileAsync.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );
  });

  test('returns a promise that resolves after async git calls complete', async () => {
    const config = makeConfig({
      repoUrl: 'https://github.com/org/repo',
      githubToken: 'tok',
    });
    await expect(gitCommitAndPushAsync('/tmp/ws', config, 'auto: ts', true)).resolves.toBeUndefined();
  });

  // ── Review-Bug 4: retry push when local commits are ahead of upstream ──

  test('Review-Bug 4: clean tree + commits ahead of upstream → push runs anyway, no commit', async () => {
    const config = makeConfig({
      repoUrl: 'https://github.com/org/repo',
      githubToken: 'tok',
    });
    let pushCount = 0;
    let commitCount = 0;
    mockExecFileAsync.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        if (args[0] === 'status' && args[1] === '--porcelain') {
          // Working tree is clean — pre-fix code returned here and never pushed.
          cb(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'rev-list') {
          // Two commits ahead of upstream → must push.
          cb(null, { stdout: '2\n', stderr: '' });
        } else if (args[0] === 'commit') {
          commitCount++;
          cb(null, { stdout: '', stderr: '' });
        } else if (args[0] === 'push') {
          pushCount++;
          cb(null, { stdout: '', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );
    await gitCommitAndPushAsync('/tmp/ws', config, 'auto: ts', false);
    // The unpushed commits get retried — push runs; commit does NOT (no new
    // changes to commit).
    expect(pushCount).toBe(1);
    expect(commitCount).toBe(0);
  });

  test('Review-Bug 4: clean tree + nothing ahead of upstream → no push, fast-path return', async () => {
    const config = makeConfig({
      repoUrl: 'https://github.com/org/repo',
      githubToken: 'tok',
    });
    let pushCount = 0;
    mockExecFileAsync.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        if (args[0] === 'status' && args[1] === '--porcelain') cb(null, { stdout: '', stderr: '' });
        else if (args[0] === 'rev-list') cb(null, { stdout: '0\n', stderr: '' });
        else if (args[0] === 'push') { pushCount++; cb(null, { stdout: '', stderr: '' }); }
        else cb(null, { stdout: '', stderr: '' });
      },
    );
    await gitCommitAndPushAsync('/tmp/ws', config, 'auto: ts', false);
    expect(pushCount).toBe(0);
  });

  test('Review-Bug 4: rev-list failure (no upstream) is treated as 0 ahead, fast-path return', async () => {
    const config = makeConfig({
      repoUrl: 'https://github.com/org/repo',
      githubToken: 'tok',
    });
    let pushCount = 0;
    mockExecFileAsync.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        if (args[0] === 'status' && args[1] === '--porcelain') cb(null, { stdout: '', stderr: '' });
        else if (args[0] === 'rev-list') cb(new Error('no upstream'), { stdout: '', stderr: '' });
        else if (args[0] === 'push') { pushCount++; cb(null, { stdout: '', stderr: '' }); }
        else cb(null, { stdout: '', stderr: '' });
      },
    );
    await gitCommitAndPushAsync('/tmp/ws', config, 'auto: ts', false);
    expect(pushCount).toBe(0);
  });

  test('restores unauthed URL even if push rejects', async () => {
    const config = makeConfig({
      repoUrl: 'https://github.com/org/repo',
      githubToken: 'tok',
    });
    mockExecFileAsync.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        if (args[0] === 'push') cb(new Error('push failed'), { stdout: '', stderr: '' });
        else cb(null, { stdout: '', stderr: '' });
      },
    );
    await expect(gitCommitAndPushAsync('/tmp/ws', config, 'msg', true)).rejects.toThrow('push failed');
    const setUrlCalls = mockExecFileAsync.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'remote',
    );
    expect(setUrlCalls.length).toBeGreaterThanOrEqual(2);
    const lastArg = (setUrlCalls[setUrlCalls.length - 1][1] as string[])[3];
    expect(lastArg).not.toContain('tok');
  });

  test('wipe guard: aborts (no commit, no push) when the only surviving file is the .jivahire/ marker', async () => {
    // Simulates a degraded workspace: `git add -A` has staged the deletion of
    // every challenge file and the index retains only the integrity marker.
    // The auto-commit must refuse to commit/push so it can't wipe the branch.
    const config = makeConfig({ repoUrl: 'https://github.com/org/repo', githubToken: 'tok' });
    let commitCount = 0;
    let pushCount = 0;
    mockExecFileAsync.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        if (args[0] === 'status' && args[1] === '--porcelain') cb(null, { stdout: ' D CMakeLists.txt\n', stderr: '' });
        else if (args[0] === 'diff' && args.includes('--diff-filter=D')) {
          cb(null, { stdout: 'CMakeLists.txt\nREADME.md\ninclude/lru_cache.hpp\n', stderr: '' });
        } else if (args[0] === 'ls-files') cb(null, { stdout: '.jivahire/telemetry.jsonl\n', stderr: '' });
        else if (args[0] === 'commit') { commitCount++; cb(null, { stdout: '', stderr: '' }); }
        else if (args[0] === 'push') { pushCount++; cb(null, { stdout: '', stderr: '' }); }
        else cb(null, { stdout: '', stderr: '' });
      },
    );
    await gitCommitAndPushAsync('/tmp/ws', config, 'auto: ts', false);
    expect(commitCount).toBe(0);
    expect(pushCount).toBe(0);
  });

  test('wipe guard: still commits when real challenge files survive alongside the marker', async () => {
    const config = makeConfig({ repoUrl: 'https://github.com/org/repo', githubToken: 'tok' });
    let commitCount = 0;
    let pushCount = 0;
    mockExecFileAsync.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
        if (args[0] === 'status' && args[1] === '--porcelain') cb(null, { stdout: ' M src/main.cpp\n', stderr: '' });
        else if (args[0] === 'diff' && args.includes('--diff-filter=D')) cb(null, { stdout: '', stderr: '' });
        else if (args[0] === 'ls-files') cb(null, { stdout: 'CMakeLists.txt\nsrc/main.cpp\n.jivahire/telemetry.jsonl\n', stderr: '' });
        else if (args[0] === 'commit') { commitCount++; cb(null, { stdout: '', stderr: '' }); }
        else if (args[0] === 'push') { pushCount++; cb(null, { stdout: '', stderr: '' }); }
        else cb(null, { stdout: '', stderr: '' });
      },
    );
    await gitCommitAndPushAsync('/tmp/ws', config, 'auto: ts', false);
    expect(commitCount).toBe(1);
    expect(pushCount).toBe(1);
  });
});

// ── Bug A: confirm modal must show time-remaining context and avoid
//          defaulting focus to "Submit" when the candidate clearly still has
//          time. ────────────────────────────────────────────────────────────

describe('runSubmit confirm modal (Bug A)', () => {
  const ws = '/tmp/fake-workspace';
  const showWarn = vscode.window.showWarningMessage as jest.Mock;
  const submitSession = api.submitSession as jest.Mock;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue(Buffer.from(''));
    showWarn.mockReset();
    submitSession.mockReset();
    submitSession.mockResolvedValue(undefined);
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: ws } },
    ];
  });

  function lastWarnCall() {
    return showWarn.mock.calls[showWarn.mock.calls.length - 1];
  }

  test('Bug A: 60 min remaining → detail mentions remaining time and Submit is NOT the first/default button', async () => {
    showWarn.mockResolvedValue(undefined); // user dismisses
    const config = makeConfig({ startedAt: Date.now() - 30 * 60_000, maxMinutes: 90 });
    await runSubmit(config);

    expect(showWarn).toHaveBeenCalled();
    const [, opts, ...buttons] = lastWarnCall();
    // Options object must include modal: true and a detail line.
    expect(opts).toEqual(expect.objectContaining({ modal: true }));
    expect(typeof opts.detail).toBe('string');
    expect(opts.detail).toMatch(/60\s*min/i);
    // Submit must not be the first button when the candidate has > 5 minutes
    // remaining (showWarningMessage focuses the FIRST item).
    expect(buttons[0]).not.toBe('Submit');
    // Cancel is always present.
    expect(buttons).toContain('Cancel');
    // Submit is still present as a non-default choice.
    expect(buttons).toContain('Submit');
  });

  test('Bug A: 2 min remaining → Submit can be first/default', async () => {
    showWarn.mockResolvedValue(undefined);
    const config = makeConfig({ startedAt: Date.now() - 88 * 60_000, maxMinutes: 90 });
    await runSubmit(config);

    const [, opts, ...buttons] = lastWarnCall();
    expect(opts).toEqual(expect.objectContaining({ modal: true }));
    expect(typeof opts.detail).toBe('string');
    expect(buttons[0]).toBe('Submit');
    expect(buttons).toContain('Cancel');
  });

  test('Bug A: expired session (negative time) → Submit can be first/default', async () => {
    showWarn.mockResolvedValue(undefined);
    const config = makeConfig({ startedAt: Date.now() - 120 * 60_000, maxMinutes: 90 });
    await runSubmit(config);

    const [, , ...buttons] = lastWarnCall();
    expect(buttons[0]).toBe('Submit');
    expect(buttons).toContain('Cancel');
  });

  test('Bug A: user picks Cancel → submitSession is NOT called', async () => {
    showWarn.mockResolvedValue('Cancel');
    const config = makeConfig({ startedAt: Date.now() - 30 * 60_000, maxMinutes: 90 });
    await runSubmit(config);
    expect(submitSession).not.toHaveBeenCalled();
  });
});

// ── Bug B: raw error strings (network/HTTP) must be presented as plain
//          English, never as raw `Error.message` text. ──────────────────────

describe('runSubmit friendly errors (Bug B)', () => {
  const ws = '/tmp/fake-workspace';
  const showWarn = vscode.window.showWarningMessage as jest.Mock;
  const showErr = vscode.window.showErrorMessage as jest.Mock;
  const submitSession = api.submitSession as jest.Mock;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue(Buffer.from(''));
    showWarn.mockReset();
    showWarn.mockResolvedValue('Submit'); // user confirms
    showErr.mockReset();
    submitSession.mockReset();
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: ws } },
    ];
  });

  test('Bug B: ECONNREFUSED is surfaced as plain English, not the raw message', async () => {
    submitSession.mockRejectedValue(new Error('ECONNREFUSED 192.168.1.1:8080'));
    const config = makeConfig({ startedAt: Date.now() - 88 * 60_000, maxMinutes: 90 });
    await runSubmit(config);

    expect(showErr).toHaveBeenCalled();
    const msg = (showErr.mock.calls[0][0] as string);
    expect(msg).not.toMatch(/ECONNREFUSED/);
    expect(msg).not.toMatch(/192\.168\.1\.1/);
    expect(msg.toLowerCase()).toMatch(/network|reach|jivahire/);
  });

  test('Bug B: HTTP 401 → "Session expired" guidance', async () => {
    submitSession.mockRejectedValue(new Error('HTTP 401: unauthorized'));
    const config = makeConfig({ startedAt: Date.now() - 88 * 60_000, maxMinutes: 90 });
    await runSubmit(config);

    const msg = (showErr.mock.calls[0][0] as string);
    expect(msg).not.toMatch(/HTTP 401/);
    expect(msg.toLowerCase()).toMatch(/session expired|re-enter/);
  });

  test('Bug B: HTTP 500 → "temporarily unavailable" guidance', async () => {
    submitSession.mockRejectedValue(new Error('HTTP 503: bad gateway'));
    const config = makeConfig({ startedAt: Date.now() - 88 * 60_000, maxMinutes: 90 });
    await runSubmit(config);

    const msg = (showErr.mock.calls[0][0] as string);
    expect(msg).not.toMatch(/HTTP 503/);
    expect(msg.toLowerCase()).toMatch(/temporar|unavailable|retry|wait/);
  });
});

// ── Time-up submit: the auto-submit sweep flips the session to `submitted`
//    server-side when the timer expires, so a manual submit afterwards gets a
//    409. That must read as a successful terminal transition, not a failure. ──

describe('runSubmit on an already-submitted session (HTTP 409)', () => {
  const ws = '/tmp/fake-workspace';
  const showWarn = vscode.window.showWarningMessage as jest.Mock;
  const showErr = vscode.window.showErrorMessage as jest.Mock;
  const showInfo = vscode.window.showInformationMessage as jest.Mock;
  const submitSession = api.submitSession as jest.Mock;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockExecFile.mockReturnValue(Buffer.from(''));
    showWarn.mockReset();
    showWarn.mockResolvedValue('Submit'); // user confirms
    showErr.mockReset();
    showInfo.mockReset();
    submitSession.mockReset();
    submitSession.mockRejectedValue(new Error('HTTP 409: Session is submitted'));
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: ws } },
    ];
  });

  test('409 → DONE-state cleanup runs and an informational (not error) toast is shown', async () => {
    const onSubmitted = jest.fn().mockResolvedValue(undefined);
    const onMarkSubmitted = jest.fn();
    const config = makeConfig({ startedAt: Date.now() - 91 * 60_000, maxMinutes: 90 });

    await runSubmit(config, { onSubmitted, onMarkSubmitted });

    // The session is transitioned to the submitted/DONE state...
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onMarkSubmitted).toHaveBeenCalledTimes(1);
    // ...the candidate sees a reassuring message, NOT the scary error toast.
    expect(showErr).not.toHaveBeenCalled();
    expect(showInfo).toHaveBeenCalled();
    const msg = (showInfo.mock.calls[0][0] as string);
    expect(msg.toLowerCase()).toMatch(/already submitted|submitted automatically|being graded/);
  });
});
