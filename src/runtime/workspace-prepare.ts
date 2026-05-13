import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Detect package manager from lock files and install dependencies in the
 * given workspace root. This runs on the host (the documented trust
 * boundary, see docs/qmd/domain-agent-execution.md): the lockfile is
 * human-committed and `--frozen-lockfile` prevents drift, so we don't
 * need to sandbox the install itself. The agent's later `bun run <script>`
 * calls do go through the container, which is what closes the realistic
 * threat (the agent rewriting `package.json` scripts at runtime).
 *
 * No-op when no recognised lock file is present.
 */
export function prepareTaskWorkspace(workspaceRoot: string, options: { timeoutMs?: number } = {}): void {
  const timeout = options.timeoutMs ?? 120_000;
  const strategies: Array<{ lockFile: string; cmd: string; args: string[] }> = [
    { lockFile: "bun.lockb", cmd: "bun", args: ["install", "--frozen-lockfile"] },
    { lockFile: "bun.lock", cmd: "bun", args: ["install", "--frozen-lockfile"] },
    { lockFile: "package-lock.json", cmd: "npm", args: ["ci"] },
    { lockFile: "yarn.lock", cmd: "yarn", args: ["install", "--frozen-lockfile"] },
    { lockFile: "pnpm-lock.yaml", cmd: "pnpm", args: ["install", "--frozen-lockfile"] }
  ];

  for (const strategy of strategies) {
    if (existsSync(join(workspaceRoot, strategy.lockFile))) {
      const result = spawnSync(strategy.cmd, strategy.args, {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout
      });
      if (result.status !== 0) {
        console.warn(
          `[workspace] ${strategy.cmd} install failed in ${workspaceRoot}: ${result.stderr?.trim()}`
        );
      }
      return;
    }
  }
}
