import { execFile, ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface TestChecklist {
  basic: boolean | null;
  thread: boolean | null;
  edge: boolean | null;
}

export type ChallengeLanguage = 'python' | 'cpp' | 'typescript' | 'unknown';

/**
 * Rejection type for test-runner errors that are *user-actionable instructions*
 * (e.g. "run npm install", "build the C++ binary first", "open the challenge
 * folder, not its parent"). The panel error handler shows these messages
 * verbatim; generic Error instances are passed through `_friendlyErrorMessage`
 * which collapses them to "Tests failed. Contact your recruiter".
 */
export class TestRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestRunnerError';
  }
}

/**
 * Detect the challenge language from the workspace files. Each challenge has
 * exactly one of pyproject.toml (Python / pytest), CMakeLists.txt (C++ /
 * Catch2), or package.json (TypeScript / vitest). When the candidate's branch
 * contains multiple challenge folders (challenges-monorepo layout), the
 * optional `subdir` lets the caller scope detection to the active challenge.
 */
export function detectLanguage(workspaceRoot: string, subdir = ''): ChallengeLanguage {
  const root = subdir ? path.join(workspaceRoot, subdir) : workspaceRoot;
  if (fs.existsSync(path.join(root, 'pyproject.toml'))) return 'python';
  if (fs.existsSync(path.join(root, 'CMakeLists.txt'))) return 'cpp';
  // package.json alone is enough — every TS challenge ships one with vitest in
  // devDependencies, and the extension's own package.json sits in a different
  // tree so a false positive here is harmless.
  if (fs.existsSync(path.join(root, 'package.json'))) return 'typescript';
  return 'unknown';
}

/**
 * Resolve which directory inside the workspace holds the active challenge.
 * Prefers `<workspaceRoot>/<challengeId>` when that subdir exists (monorepo
 * layout), falling back to the workspace root (per-challenge clone layout).
 */
function resolveChallengeRoot(workspaceRoot: string, challengeId?: string): string {
  if (challengeId) {
    const candidate = path.join(workspaceRoot, challengeId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return workspaceRoot;
}

interface RunOneOk {
  ok: true;
  /** true = exit 0 (pass), false = recognised fail code, null = unknown code. */
  result: boolean | null;
}
interface RunOneSpawnFailed {
  ok: false;
  /** ENOENT / EACCES — the binary couldn't be spawned at all. */
  spawnCode: string;
}
type RunOneResult = RunOneOk | RunOneSpawnFailed;

function runOne(
  cmd: string,
  args: string[],
  cwd: string,
  passCodes: number[],
  failCodes: number[],
): Promise<RunOneResult> {
  return new Promise((resolve) => {
    const ok = (result: boolean | null): RunOneOk => ({ ok: true, result });
    const spawnFailed = (spawnCode: string): RunOneSpawnFailed => ({ ok: false, spawnCode });
    execFile(cmd, args, { cwd, timeout: 60_000 }, (err: ExecFileException | null) => {
      if (!err) { resolve(ok(true)); return; }
      const code = err.code;
      if (typeof code === 'number') {
        if (passCodes.includes(code)) { resolve(ok(true)); return; }
        if (failCodes.includes(code)) { resolve(ok(false)); return; }
        resolve(ok(null));
        return;
      }
      // String codes are spawn failures (ENOENT, EACCES, EPERM, ...). Surface
      // these as a distinct outcome so the caller can reject the whole run
      // with an actionable message instead of silently parking the UI on
      // three pending dots.
      if (typeof code === 'string') {
        resolve(spawnFailed(code));
        return;
      }
      resolve(ok(null));
    });
  });
}

/**
 * Run three tagged tests in sequence and collapse spawn failures into a single
 * rejection — if the *first* invocation can't even spawn the runtime, there's
 * no point firing two more identical failures at the user.
 */
async function runTags(
  cmd: string,
  argsFor: (tag: string) => string[],
  cwd: string,
  passCodes: number[],
  failCodes: number[],
  tags: { basic: string; thread: string; edge: string },
  spawnFailMessage: (spawnCode: string) => string,
): Promise<TestChecklist> {
  const results: Record<'basic' | 'thread' | 'edge', boolean | null> = {
    basic: null, thread: null, edge: null,
  };
  for (const key of ['basic', 'thread', 'edge'] as const) {
    const r = await runOne(cmd, argsFor(tags[key]), cwd, passCodes, failCodes);
    if (r.ok === false) {
      throw new TestRunnerError(spawnFailMessage(r.spawnCode));
    }
    results[key] = r.result;
  }
  return results;
}

function runCpp(challengeRoot: string): Promise<TestChecklist> {
  const testBin = path.join(challengeRoot, 'build', 'tests');
  if (!fs.existsSync(testBin)) {
    // Without a pre-check, execFile would fail with ENOENT (a string code),
    // runOne would surface that as a spawn failure, and the candidate would
    // get the generic message. Reject with the exact commands they need.
    return Promise.reject(
      new TestRunnerError(
        `C++ test binary not built. Expected ${testBin}.\n` +
          `Build first in a terminal:\n` +
          `  cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo\n` +
          `  cmake --build build -j\n` +
          `Then click Run Tests again.`,
      ),
    );
  }
  return runTags(
    testBin,
    (tag) => [tag],
    challengeRoot,
    [0],
    [1],
    { basic: '[basic]', thread: '[thread]', edge: '[edge]' },
    (code) =>
      `Couldn't run the C++ test binary (${code}). Rebuild it:\n` +
      `  cmake --build build -j\n` +
      `Then click Run Tests again.`,
  );
}

function runPython(challengeRoot: string): Promise<TestChecklist> {
  // Prefer the in-repo venv (which has pytest from `pip install -e ".[dev]"`),
  // falling back to system python3 if it isn't there yet.
  const venvPy = path.join(challengeRoot, '.venv', 'bin', 'python');
  const py = fs.existsSync(venvPy) ? venvPy : 'python3';
  // pytest exit codes: 0 = all passed, 1 = some failed, 5 = no tests collected.
  // Treat 5 as null (the marker may not exist yet) so we don't claim a fail.
  return runTags(
    py,
    (marker) => ['-m', 'pytest', '-q', '-m', marker],
    challengeRoot,
    [0],
    [1],
    { basic: 'basic', thread: 'thread', edge: 'edge' },
    (code) =>
      `Couldn't start Python (${code}: ${py} not found).\n` +
      `Install Python 3.11+ and pytest, then click Run Tests again. ` +
      `If the challenge ships a .venv, run\n` +
      `  python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"\n` +
      `from the challenge folder first.`,
  );
}

function runTypescript(challengeRoot: string): Promise<TestChecklist> {
  // vitest is the standard runner for the TS challenges. After `npm install`
  // it lives at <root>/node_modules/vitest/vitest.mjs — invoking it via `node`
  // avoids the cross-platform .bin-shim vs .cmd dance and works whether the
  // candidate is on macOS, Linux, or Windows.
  const vitestEntry = path.join(challengeRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!fs.existsSync(vitestEntry)) {
    return Promise.reject(
      new TestRunnerError(
        `TypeScript dependencies not installed.\n` +
          `Open a terminal in the challenge folder and run:\n` +
          `  npm install\n` +
          `Then click Run Tests again.`,
      ),
    );
  }
  // The TS challenges tag tests with @basic / @concurrent / @edge in the test
  // name; vitest's `-t` flag does a substring match on test names. The UI
  // labels the middle row "Concurrent get/put" → map `thread` → `@concurrent`.
  return runTags(
    'node',
    (tag) => [vitestEntry, 'run', '-t', tag, '--reporter=default'],
    challengeRoot,
    [0],
    [1],
    { basic: '@basic', thread: '@concurrent', edge: '@edge' },
    (code) =>
      `Couldn't start Node (${code}). Install Node 18+ and run\n` +
      `  npm install\n` +
      `in the challenge folder, then click Run Tests again.`,
  );
}

export function runChecklist(workspaceRoot: string, challengeId?: string): Promise<TestChecklist> {
  const challengeRoot = resolveChallengeRoot(workspaceRoot, challengeId);
  const lang = detectLanguage(challengeRoot);
  if (lang === 'python') return runPython(challengeRoot);
  if (lang === 'cpp') return runCpp(challengeRoot);
  if (lang === 'typescript') return runTypescript(challengeRoot);
  // Reject with a concrete hint instead of resolving to all-null — the UI can't
  // distinguish "tests pending" from "wrong folder open" without this.
  return Promise.reject(
    new TestRunnerError(
      `No challenge detected at ${challengeRoot}. Expected pyproject.toml ` +
        `(Python), CMakeLists.txt (C++), or package.json (TypeScript) at the ` +
        `workspace root. Open the challenge folder itself, not a parent or ` +
        `subdirectory.`,
    ),
  );
}
