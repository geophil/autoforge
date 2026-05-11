import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { DbClient } from "../../src/db/client";
import { loadEnv } from "../../src/config/env";
import { WorktreeManager } from "../../src/git/worktrees";
import { OrchestratorService } from "../../src/orchestrator/service";
import { MockExecutor } from "../../src/executors/mock";
import type { AgentTask, AgentResult } from "../../src/executors/interface";

type Handlers = Partial<Record<AgentTask["type"], (task: AgentTask) => AgentResult | Promise<AgentResult>>>;
type EnvOverrides = Partial<Record<string, string>>;

export interface TestService {
  service: OrchestratorService;
  db: DbClient;
  dbPath: string;
  cleanup: () => void;
}

const pendingCleanups = new Set<() => void>();

export function createTestService(handlers: Handlers = {}, envOverrides: EnvOverrides = {}): TestService {
  // realpathSync resolves macOS's /var -> /private/var symlink so that
  // prefix comparisons against paths reported by `git worktree list`
  // (which always report the resolved form) succeed.
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "autoforge-test-")));
  const dbPath = join(baseDir, `${randomUUID()}.sqlite`);
  const db = new DbClient(dbPath);
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );

  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_PATH: dbPath,
    EXECUTOR_DEFAULT: "mock",
    REVIEW_SCORE_THRESHOLD: "0.7",
    TEST_PASS_THRESHOLD: "1",
    ...envOverrides
  });

  const executor = new MockExecutor(handlers);
  const worktreeRoot = join(baseDir, "worktrees");
  const worktrees = new WorktreeManager(worktreeRoot);
  const service = new OrchestratorService({
    env,
    db,
    executor,
    worktrees,
    testRunner: async () => ({ passRate: 1, output: "mock test runner" }),
    prCreator: async (payload) => `https://github.com/local/autoforge/pull/mock?branch=${encodeURIComponent(payload.branch)}`
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    pendingCleanups.delete(cleanup);

    // Remove any git worktrees still registered under this baseDir, plus
    // their autoforge/* branches. We iterate the live worktree list rather
    // than relying on the service having called remove() — tests that reach
    // awaiting_approval without approving/rejecting leave worktrees behind
    // by design, and worktree adds that fell through to plain directories
    // still need cleaning up too.
    try {
      const porcelain = execSync("git worktree list --porcelain", { encoding: "utf8" });
      const branchesToDelete: string[] = [];
      for (const block of porcelain.split("\n\n")) {
        const wtLine = block.split("\n").find((l) => l.startsWith("worktree "));
        const brLine = block.split("\n").find((l) => l.startsWith("branch "));
        if (!wtLine) continue;
        const wtPath = wtLine.slice("worktree ".length);
        if (!wtPath.startsWith(baseDir)) continue;
        spawnSync("git", ["worktree", "remove", "--force", wtPath], { stdio: "ignore" });
        if (brLine) {
          const branch = brLine.slice("branch refs/heads/".length);
          if (branch.startsWith("autoforge/")) {
            branchesToDelete.push(branch);
          }
        }
      }
      // Prune any stale metadata before deleting branches — belt-and-braces
      // in case a worktree dir disappeared out from under git.
      spawnSync("git", ["worktree", "prune"], { stdio: "ignore" });
      for (const branch of branchesToDelete) {
        spawnSync("git", ["branch", "-D", branch], { stdio: "ignore" });
      }
    } catch {
      // best-effort — not being in a git repo just means there's nothing to do.
    }

    try {
      (db.sqlite as unknown as { close?: () => void }).close?.();
    } catch {
      // ignore — sqlite close errors shouldn't fail cleanup.
    }

    rmSync(baseDir, { recursive: true, force: true });
  };

  pendingCleanups.add(cleanup);

  return { service, db, dbPath, cleanup };
}

/**
 * Clean up any TestService instances that didn't have cleanup() called
 * explicitly. Wired up as a global afterEach via tests/helpers/setup.ts so
 * a forgotten cleanup call never leaks worktrees, branches, or temp dirs.
 */
export function cleanupAllTestServices(): void {
  for (const cleanup of Array.from(pendingCleanups)) {
    try {
      cleanup();
    } catch (err) {
      console.warn(`[test-cleanup] cleanup threw: ${err}`);
    }
  }
}
