import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { loadEnv } from "./config/env";
import { DbClient } from "./db/client";
import { createExecutor } from "./executors/factory";
import { WorktreeManager } from "./git/worktrees";
import { RecoveryService } from "./orchestrator/recovery";
import { OrchestratorService } from "./orchestrator/service";
import { createWebServer } from "./web/server";

const env = loadEnv();
const db = new DbClient(env.DATABASE_PATH);
db.initSchema(resolve(import.meta.dir, "./db/schema.sql"));

const recovery = new RecoveryService(db);
recovery.recover();

const executor = createExecutor(env);
const worktrees = new WorktreeManager(resolve(process.cwd(), ".runtime-worktrees"));
const service = new OrchestratorService({
  env,
  db,
  executor,
  worktrees
});

const app = createWebServer(service, db);

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    hostname: env.HOST
  },
  (info) => {
    console.log(`Autoforge listening on http://${info.address}:${info.port}`);
  }
);
