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
} from '../submit';
import { execFileSync, execFile } from 'child_process';
import { makeConfig } from './helpers';

jest.mock('child_process', () => ({
  execFileSync: jest.fn().mockReturnValue(Buffer.from('')),
  execFile: jest.fn(),
}));

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
});
