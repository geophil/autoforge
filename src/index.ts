import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { loadEnv } from "./config/env";
import { getRewardWeights } from "./config/reward";
import { DbClient } from "./db/client";
import { createExecutors } from "./executors/factory";
import { WorktreeManager } from "./git/worktrees";
import { NatsClient } from "./nats/client";
import { RecoveryService } from "./orchestrator/recovery";
import { OrchestratorService } from "./orchestrator/service";
import { WorkspaceFactory } from "./runtime/workspace-provider";
import { createWebServer } from "./web/server";

const env = loadEnv();
const db = new DbClient(env.DATABASE_PATH);
const schemaPath = resolve(import.meta.dir, "./db/schema.sql");
const migrationsPath = resolve(import.meta.dir, "./db/migrations");
db.initSchema(schemaPath, migrationsPath);
getRewardWeights();

// NATS connection is optional — system runs without it (SQLite-only mode).
const nats = new NatsClient(env.NATS_URL);
await nats.connect(); // logs a warning and continues if unavailable

const recovery = new RecoveryService(db, nats, (message) => {
  db.transaction(() => {
    db.appendEvent(message);
    db.applyEvent(message);
  });
});
await recovery.recover();

const executors = createExecutors(env);
const worktrees = new WorktreeManager(resolve(process.cwd(), ".runtime-worktrees"));
const workspaceFactory = new WorkspaceFactory(env);
const service = new OrchestratorService({
  env,
  db,
  executor: executors.primary,
  worktrees,
  nats,
  workspaceFactory
});
await service.backfillSpecialtyEmbeddings();
service.startDiagnosticScheduler();

// Mark any tasks that were stuck in non-terminal states (e.g. from a crashed
// previous run or a timed-out executor) as failed with a failure_analysis event.
await service.sweepStaleTasks();

const app = createWebServer(service, db, env);

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    hostname: env.HOST
  },
  (info) => {
    console.log(`Autoforge listening on http://${info.address}:${info.port}`);
    console.log(`NATS: ${nats.isConnected ? env.NATS_URL : "not connected (SQLite-only mode)"}`);
  }
);
