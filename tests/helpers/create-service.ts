import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { loadEnv } from "../../src/config/env";
import { WorktreeManager } from "../../src/git/worktrees";
import { OrchestratorService } from "../../src/orchestrator/service";
import { MockExecutor } from "../../src/executors/mock";
import type { AgentTask, AgentResult } from "../../src/executors/interface";

type Handlers = Partial<Record<AgentTask["type"], (task: AgentTask) => AgentResult | Promise<AgentResult>>>;

export function createTestService(handlers: Handlers = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "autoforge-test-"));
  const dbPath = join(baseDir, `${randomUUID()}.sqlite`);
  const db = new DbClient(dbPath);
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));

  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_PATH: dbPath,
    EXECUTOR_DEFAULT: "mock",
    REVIEW_SCORE_THRESHOLD: "0.7",
    TEST_PASS_THRESHOLD: "1"
  });

  const executor = new MockExecutor(handlers);
  const worktrees = new WorktreeManager(join(baseDir, "worktrees"));
  const service = new OrchestratorService({ env, db, executor, worktrees });

  return { service, db, dbPath };
}
