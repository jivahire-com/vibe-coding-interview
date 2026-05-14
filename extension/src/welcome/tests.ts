import { execFile, ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface TestChecklist {
  basic: boolean | null;
  thread: boolean | null;
  edge: boolean | null;
}

export type ChallengeLanguage = 'python' | 'cpp' | 'unknown';

/**
 * Detect the challenge language from the workspace files. Each challenge has
 * exactly one of pyproject.toml (Python / pytest) or CMakeLists.txt (C++ /
 * Catch2). When the candidate's branch contains multiple challenge folders
 * (challenges-monorepo layout), the optional `subdir` lets the caller scope
 * detection to the active challenge.
 */
export function detectLanguage(workspaceRoot: string, subdir = ''): ChallengeLanguage {
  const root = subdir ? path.join(workspaceRoot, subdir) : workspaceRoot;
  if (fs.existsSync(path.join(root, 'pyproject.toml'))) return 'python';
  if (fs.existsSync(path.join(root, 'CMakeLists.txt'))) return 'cpp';
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

function runOne(
  cmd: string,
  args: string[],
  cwd: string,
  passCodes: number[],
  failCodes: number[],
): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 60_000 }, (err: ExecFileException | null) => {
      if (!err) { resolve(true); return; }
      const code = err.code;
      if (typeof code === 'number') {
        if (passCodes.includes(code)) { resolve(true); return; }
        if (failCodes.includes(code)) { resolve(false); return; }
      }
      resolve(null);
    });
  });
}

function runCpp(challengeRoot: string): Promise<TestChecklist> {
  const testBin = path.join(challengeRoot, 'build', 'tests');
  const runTag = (tag: string) => runOne(testBin, [tag], challengeRoot, [0], [1]);
  return Promise.all([runTag('[basic]'), runTag('[thread]'), runTag('[edge]')]).then(
    ([basic, thread, edge]) => ({ basic, thread, edge }),
  );
}

function runPython(challengeRoot: string): Promise<TestChecklist> {
  // Prefer the in-repo venv (which has pytest from `pip install -e ".[dev]"`),
  // falling back to system python3 if it isn't there yet.
  const venvPy = path.join(challengeRoot, '.venv', 'bin', 'python');
  const py = fs.existsSync(venvPy) ? venvPy : 'python3';
  // pytest exit codes: 0 = all passed, 1 = some failed, 5 = no tests collected.
  // Treat 5 as null (the marker may not exist yet) so we don't claim a fail.
  const runMarker = (marker: string) =>
    runOne(py, ['-m', 'pytest', '-q', '-m', marker], challengeRoot, [0], [1]);
  return Promise.all([runMarker('basic'), runMarker('thread'), runMarker('edge')]).then(
    ([basic, thread, edge]) => ({ basic, thread, edge }),
  );
}

export function runChecklist(workspaceRoot: string, challengeId?: string): Promise<TestChecklist> {
  const challengeRoot = resolveChallengeRoot(workspaceRoot, challengeId);
  const lang = detectLanguage(challengeRoot);
  if (lang === 'python') return runPython(challengeRoot);
  if (lang === 'cpp') return runCpp(challengeRoot);
  // Unknown layout: surface as "indeterminate" rather than reporting fakes.
  return Promise.resolve({ basic: null, thread: null, edge: null });
}
