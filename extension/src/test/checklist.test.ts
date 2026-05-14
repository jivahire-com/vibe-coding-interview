/**
 * Tests for runChecklist + detectLanguage (welcome/tests.ts).
 *
 * Covers the language-aware dispatch added so Python challenges no longer
 * shell out to the C++ Catch2 binary (which doesn't exist on a Python repo).
 */
import * as path from 'path';

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('fs', () => ({ existsSync: jest.fn() }));

import { execFile } from 'child_process';
import * as fs from 'fs';
import { runChecklist, detectLanguage } from '../welcome/tests';

const mockExecFile = execFile as unknown as jest.Mock;
const mockExistsSync = fs.existsSync as unknown as jest.Mock;

/**
 * Configure the mocked fs to claim the listed paths exist; everything else
 * does not.
 */
function existsOnly(paths: string[]): void {
  const set = new Set(paths.map((p) => path.normalize(p)));
  mockExistsSync.mockImplementation((p: string) => set.has(path.normalize(p)));
}

describe('detectLanguage', () => {
  beforeEach(() => mockExistsSync.mockReset());

  test('detects Python by pyproject.toml', () => {
    existsOnly(['/ws/pyproject.toml']);
    expect(detectLanguage('/ws')).toBe('python');
  });

  test('detects C++ by CMakeLists.txt', () => {
    existsOnly(['/ws/CMakeLists.txt']);
    expect(detectLanguage('/ws')).toBe('cpp');
  });

  test('returns "unknown" when neither marker is present', () => {
    existsOnly([]);
    expect(detectLanguage('/ws')).toBe('unknown');
  });

  test('honours the optional subdir', () => {
    existsOnly(['/ws/python-ttl-cache/pyproject.toml']);
    expect(detectLanguage('/ws', 'python-ttl-cache')).toBe('python');
  });
});

describe('runChecklist (C++)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExistsSync.mockReset();
    existsOnly(['/ws/CMakeLists.txt']);
  });

  test('all tags pass when the binary exits 0', async () => {
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(null));
    const result = await runChecklist('/ws');
    expect(result).toEqual({ basic: true, thread: true, edge: true });
  });

  test('exit code 1 → all tags fail', async () => {
    const err = Object.assign(new Error('failures'), { code: 1 });
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(err));
    const result = await runChecklist('/ws');
    expect(result).toEqual({ basic: false, thread: false, edge: false });
  });

  test('missing binary → null (indeterminate)', async () => {
    const err = Object.assign(new Error('not found'), { code: 127 });
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(err));
    const result = await runChecklist('/ws');
    expect(result).toEqual({ basic: null, thread: null, edge: null });
  });

  test('passes [basic]/[thread]/[edge] Catch2 tags', async () => {
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(null));
    await runChecklist('/ws');
    const tagArgs: string[] = mockExecFile.mock.calls.map((c) => c[1][0]);
    expect(tagArgs.sort()).toEqual(['[basic]', '[edge]', '[thread]']);
  });

  test('runs the binary at <root>/build/tests', async () => {
    existsOnly(['/project/CMakeLists.txt']);
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(null));
    await runChecklist('/project');
    const bin: string = mockExecFile.mock.calls[0][0];
    expect(bin).toBe(path.join('/project', 'build', 'tests'));
  });
});

describe('runChecklist (Python)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExistsSync.mockReset();
  });

  test('uses pytest with -m <marker> when pyproject.toml is present', async () => {
    existsOnly(['/ws/pyproject.toml']); // no .venv → falls back to system python3
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(null));
    const result = await runChecklist('/ws');
    expect(result).toEqual({ basic: true, thread: true, edge: true });

    const calls = mockExecFile.mock.calls;
    expect(calls).toHaveLength(3);
    for (const [bin, args] of calls) {
      expect(bin).toBe('python3');
      expect(args.slice(0, 4)).toEqual(['-m', 'pytest', '-q', '-m']);
    }
    const markers = calls.map((c) => c[1][4]).sort();
    expect(markers).toEqual(['basic', 'edge', 'thread']);
  });

  test('prefers the in-repo .venv python when it exists', async () => {
    existsOnly(['/ws/pyproject.toml', '/ws/.venv/bin/python']);
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(null));
    await runChecklist('/ws');
    const bin: string = mockExecFile.mock.calls[0][0];
    expect(bin).toBe(path.join('/ws', '.venv', 'bin', 'python'));
  });

  test('pytest exit 1 → marker reported as failed', async () => {
    existsOnly(['/ws/pyproject.toml']);
    const err = Object.assign(new Error('failed'), { code: 1 });
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(err));
    const result = await runChecklist('/ws');
    expect(result).toEqual({ basic: false, thread: false, edge: false });
  });
});

describe('runChecklist (monorepo / unknown)', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockExistsSync.mockReset();
  });

  test('challengeId selects the right subfolder when the workspace has multiple challenges', async () => {
    existsOnly([
      '/ws/python-ttl-cache',
      '/ws/python-ttl-cache/pyproject.toml',
      '/ws/cpp-lru-cache',
      '/ws/cpp-lru-cache/CMakeLists.txt',
    ]);
    mockExecFile.mockImplementation((_b, _a, _o, cb: Function) => cb(null));

    await runChecklist('/ws', 'python-ttl-cache');
    const cwd = mockExecFile.mock.calls[0][2].cwd;
    expect(cwd).toBe(path.join('/ws', 'python-ttl-cache'));
    const bin = mockExecFile.mock.calls[0][0];
    expect(bin === 'python3' || bin.endsWith('/python')).toBe(true);
  });

  test('unknown layout returns all-null and skips execFile', async () => {
    existsOnly([]);
    const result = await runChecklist('/ws');
    expect(result).toEqual({ basic: null, thread: null, edge: null });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
