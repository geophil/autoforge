import { streamSSE } from "hono/streaming";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createTaskRoutes } from "./routes/tasks";
import { createApprovalRoutes } from "./routes/approvals";
import { createMetricsRoutes } from "./routes/metrics";
import { createMetaRoutes } from "./routes/meta";
import { createTranscriptsRoutes } from "./routes/transcripts";
import { createExperimentsRoutes } from "./routes/experiments";
import type { OrchestratorService } from "../orchestrator/service";
import type { DbClient } from "../db/client";
import { LiveEventHub } from "./events";
import { loadEnv, type AppEnv } from "../config/env";

export function createWebServer(
  service: OrchestratorService,
  db: DbClient,
  env: AppEnv = loadEnv()
): Hono {
  const app = new Hono();
  const events = new LiveEventHub();

  app.route("/api/tasks", createTaskRoutes(service, events, db));
  app.route("/api/tasks", createApprovalRoutes(service, events));
  app.route("/api/metrics", createMetricsRoutes(db));
  app.route("/api/meta", createMetaRoutes(service));
  app.route("/api/transcripts", createTranscriptsRoutes(db));
  app.route("/api/experiments", createExperimentsRoutes(service));

  app.get("/api/health", (ctx) => {
    return ctx.json({ status: "ok", uptime: process.uptime() });
  });

  app.get("/api/config", (ctx) => {
    return ctx.json({
      plannerMaxIterations: env.PLANNER_MAX_ITERATIONS
    });
  });

  app.get("/api/events", (ctx) => {
    return streamSSE(ctx, async (stream) => {
      const unsubscribe = events.subscribe((payload) => {
        void stream.write(payload);
      });
      await stream.write(`event: connected\ndata: {"ok":true}\n\n`);
      try {
        while (true) {
          await Bun.sleep(15_000);
          await stream.write(`event: heartbeat\ndata: {"ts":"${new Date().toISOString()}"}\n\n`);
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.use("/static/*", serveStatic({ root: "./src/web/public", rewriteRequestPath: (path) => path.replace("/static", "") }));
  app.get("/", serveStatic({ path: "./src/web/public/index.html" }));

  return app;
}
