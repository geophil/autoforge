import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface TestRunResult {
  passRate: number;
  output: string;
}

/**
 * Detect the package manager and run the test suite in the given working directory.
 * Returns pass rate 1.0 if all tests pass, < 1.0 if some fail, 0 if the run errors.
 * Falls back to passRate: 1 if no test configuration is found.
 */
export async function runAuthenticatedTests(workingDirectory: string, _projectId: string): Promise<TestRunResult> {
  const runner = detectTestRunner(workingDirectory);
  if (!runner) {
    return { passRate: 1, output: "(no test configuration detected — skipping)" };
  }

  const result = spawnSync(runner.cmd, runner.args, {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000
  });

  const combined = [result.stdout ?? "", result.stderr ?? ""].join("\n").trim();

  if (result.signal === "SIGTERM" || result.error?.message?.includes("ETIMEDOUT")) {
    return { passRate: 0, output: "test run timed out after 120s" };
  }

  const passRate = parsePassRate(combined, result.status ?? 1);
  return { passRate, output: combined.slice(0, 4000) };
}

function detectTestRunner(cwd: string): { cmd: string; args: string[] } | null {
  // Bun: bun.lockb or bun.lock
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) {
    return { cmd: "bun", args: ["test"] };
  }

  // Node with package.json that has a test script
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf8"));
      if (pkg?.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1") {
        // Prefer npm test; use npx vitest / jest if referenced directly
        if (existsSync(join(cwd, "node_modules/.bin/vitest"))) {
          return { cmd: "npx", args: ["vitest", "run"] };
        }
        if (existsSync(join(cwd, "node_modules/.bin/jest"))) {
          return { cmd: "npx", args: ["jest", "--no-coverage"] };
        }
        return { cmd: "npm", args: ["test", "--", "--passWithNoTests"] };
      }
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Parse bun test / jest / vitest output to determine pass rate.
 * Falls back to exit-code heuristic: code 0 → 1.0, else 0.0.
 */
function parsePassRate(output: string, exitCode: number): number {
  // bun test: "X pass, Y fail" or "X tests passed"
  const bunMatch = output.match(/(\d+)\s+pass(?:ed)?.*?(\d+)\s+fail/i);
  if (bunMatch) {
    const passed = parseInt(bunMatch[1], 10);
    const failed = parseInt(bunMatch[2], 10);
    const total = passed + failed;
    return total === 0 ? 1 : passed / total;
  }

  // bun test: "X tests" with pass line only
  const bunPassOnly = output.match(/(\d+)\s+pass(?:ed)?/i);
  const bunFailOnly = output.match(/(\d+)\s+fail(?:ed)?/i);
  if (bunPassOnly && !bunFailOnly) {
    return 1;
  }

  // jest/vitest: "Tests: X failed, Y passed, Z total"
  const jestMatch = output.match(/Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed.*?(\d+)\s+total/i);
  if (jestMatch) {
    const failed = jestMatch[1] ? parseInt(jestMatch[1], 10) : 0;
    const passed = parseInt(jestMatch[2], 10);
    const total = parseInt(jestMatch[3], 10);
    return total === 0 ? 1 : (total - failed) / total;
  }

  // Fallback: trust exit code
  return exitCode === 0 ? 1 : 0;
}
