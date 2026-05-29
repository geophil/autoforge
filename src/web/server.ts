import { streamSSE } from "hono/streaming";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTaskRoutes } from "./routes/tasks";
import { createApprovalRoutes } from "./routes/approvals";
import { createMetricsRoutes } from "./routes/metrics";
import { createMetaRoutes } from "./routes/meta";
import { createTranscriptsRoutes } from "./routes/transcripts";
import { createExperimentsRoutes } from "./routes/experiments";
import { createVariantsRoutes } from "./routes/variants";
import { createDiagnosticRoutes } from "./routes/diagnostic";
import type { OrchestratorService } from "../orchestrator/service";
import type { DbClient } from "../db/client";
import { LiveEventHub } from "./events";
import { loadEnv, type AppEnv } from "../config/env";
import { buildDockerPreflightChecks } from "../runtime/container-diagnostics";
import { spawnAsExecEvents } from "../runtime/spawn-streaming";
import type { ExecEvent } from "../runtime/workspace";
import type { NatsClient } from "../nats/client";

export function createWebServer(
  service: OrchestratorService,
  db: DbClient,
  env: AppEnv = loadEnv(),
  runtimeDeps: { nats?: NatsClient } = {}
): Hono {
  const app = new Hono();
  const events = new LiveEventHub();

  app.route("/api/tasks", createTaskRoutes(service, events, db));
  app.route("/api/tasks", createApprovalRoutes(service, events));
  app.route("/api/metrics", createMetricsRoutes(db));
  app.route("/api/meta", createMetaRoutes(service));
  app.route("/api/transcripts", createTranscriptsRoutes(db));
  app.route("/api/experiments", createExperimentsRoutes(service));
  app.route("/api/variants", createVariantsRoutes(db));
  app.route("/api/diagnostic", createDiagnosticRoutes(service));

  app.get("/api/health", (ctx) => {
    return ctx.json({ status: "ok", uptime: process.uptime() });
  });

  app.get("/api/config", (ctx) => {
    return ctx.json({
      plannerMaxIterations: env.PLANNER_MAX_ITERATIONS,
      plannerSpecMaxIterations: env.PLANNER_SPEC_MAX_ITERATIONS
    });
  });

  app.get("/api/runtime", async (ctx) => {
    const [qmd, nats, docker] = await Promise.all([
      probeQmdMcp(env.QMD_MCP_URL),
      probeNats(runtimeDeps.nats, env.NATS_URL),
      inspectDockerWorkspace(env)
    ]);
    return ctx.json({
      qmd,
      nats,
      workspace: {
        provider: env.WORKSPACE_PROVIDER,
        taskExecutionMode: env.WORKSPACE_PROVIDER === "docker" ? "docker_container" : "local_worktree",
        docker
      }
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

async function probeQmdMcp(url: string | undefined): Promise<{
  configured: boolean;
  available: boolean;
  status: "not_configured" | "available" | "unreachable";
  url: string | null;
  toolCount?: number;
  tools?: string[];
  error?: string;
}> {
  if (!url) {
    return { configured: false, available: false, status: "not_configured", url: null };
  }

  const client = new Client({ name: "autoforge-runtime-probe", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    const tools = await withTimeout((async () => {
      await client.connect(transport);
      return (await client.listTools()).tools;
    })(), 3_000, "MCP tools/list timed out");
    return {
      configured: true,
      available: true,
      status: "available",
      url,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name).sort()
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      status: "unreachable",
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function probeNats(nats: NatsClient | undefined, url: string): Promise<{
  configured: boolean;
  available: boolean;
  status: "available" | "unavailable" | "not_attached";
  url: string;
  error?: string;
}> {
  if (!nats) {
    return {
      configured: true,
      available: false,
      status: "not_attached",
      url,
      error: "NATS client was not attached to the web runtime probe"
    };
  }

  const result = await nats.healthCheck();
  return {
    configured: true,
    available: result.ok,
    status: result.ok ? "available" : "unavailable",
    url: nats.url,
    ...(result.ok ? {} : { error: result.error ?? "health check failed" })
  };
}

async function inspectDockerWorkspace(env: AppEnv): Promise<{
  enabled: boolean;
  image: string;
  network: string;
  cpus: string;
  memory: string;
  precheckEnabled: boolean;
  reapOnStart: boolean;
  status: "not_enabled" | "ready" | "unavailable" | "not_checked";
  checks: Array<{ name: string; ok: boolean; exitCode: number; error?: string }>;
}> {
  const base = {
    enabled: env.WORKSPACE_PROVIDER === "docker",
    image: env.WORKSPACE_DOCKER_IMAGE,
    network: env.WORKSPACE_DOCKER_NETWORK,
    cpus: env.WORKSPACE_DOCKER_CPUS,
    memory: env.WORKSPACE_DOCKER_MEMORY,
    precheckEnabled: env.WORKSPACE_DOCKER_PRECHECK === "1",
    reapOnStart: env.WORKSPACE_DOCKER_REAP_ON_START === "1"
  };

  if (!base.enabled) {
    return { ...base, status: "not_enabled", checks: [] };
  }

  if (!base.precheckEnabled) {
    return { ...base, status: "not_checked", checks: [] };
  }

  const checks = [];
  for (const check of buildDockerPreflightChecks(env.WORKSPACE_DOCKER_IMAGE)) {
    const result = await collectExec(spawnAsExecEvents(check.cmd, check.args, { timeoutSeconds: 2 }));
    checks.push({
      name: [check.cmd, ...check.args].join(" "),
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      ...(result.exitCode === 0 ? {} : { error: result.stderr.trim() || result.stdout.trim() || "check failed" })
    });
  }

  return {
    ...base,
    status: checks.every((check) => check.ok) ? "ready" : "unavailable",
    checks
  };
}

async function collectExec(events: AsyncIterable<ExecEvent>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for await (const event of events) {
    if (event.kind === "stdout") stdout += event.chunk;
    if (event.kind === "stderr") stderr += event.chunk;
    if (event.kind === "exit") exitCode = event.exitCode;
  }
  return { stdout, stderr, exitCode };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
