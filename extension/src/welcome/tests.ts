import { execSync } from "child_process";
import * as path from "path";

export interface TestChecklist {
  basic: boolean | null;   // null = not run yet
  thread: boolean | null;
  edge: boolean | null;
}

export function runChecklist(workspaceRoot: string): TestChecklist {
  const buildDir = path.join(workspaceRoot, "build");
  const testBin = path.join(buildDir, "tests");

  const runTag = (tag: string): boolean | null => {
    try {
      execSync(`"${testBin}" "${tag}"`, { stdio: "pipe", timeout: 15_000 });
      return true;
    } catch (e: any) {
      // exit code 1 = test failures; other errors = binary missing / build needed
      if (e.status === 1) return false;
      return null;
    }
  };

  return {
    basic: runTag("[basic]"),
    thread: runTag("[thread]"),
    edge: runTag("[edge]"),
  };
}
