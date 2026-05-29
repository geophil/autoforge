import { describe, expect, test } from "bun:test";
import { createWebServer } from "../../src/web/server";
import { testEnv } from "../helpers/test-env";

// Minimal stubs — we only need the server to mount the /api/health route.
const stubService = {} as any;
const stubDb = {} as any;

describe("GET /api/health", () => {
  test("returns 200", async () => {
    const app = createWebServer(stubService, stubDb, testEnv());
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });

  test("returns JSON with status ok", async () => {
    const app = createWebServer(stubService, stubDb, testEnv());
    const res = await app.request("/api/health");
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("returns JSON with numeric uptime", async () => {
    const app = createWebServer(stubService, stubDb, testEnv());
    const res = await app.request("/api/health");
    const body = await res.json();
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /api/runtime", () => {
  test("reports local workspace mode and unconfigured QMD by default", async () => {
    const app = createWebServer(stubService, stubDb, testEnv());
    const res = await app.request("/api/runtime");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.qmd).toMatchObject({
      configured: false,
      available: false,
      status: "not_configured",
      url: null
    });
    expect(body.workspace).toMatchObject({
      provider: "local",
      taskExecutionMode: "local_worktree"
    });
    expect(body.workspace.docker.status).toBe("not_enabled");
  });

  test("reports configured QMD MCP URL unreachable when MCP handshake fails", async () => {
    const app = createWebServer(stubService, stubDb, testEnv({ QMD_MCP_URL: "data:text/plain,ok" }));
    const res = await app.request("/api/runtime");
    const body = await res.json();

    expect(body.qmd.configured).toBe(true);
    expect(body.qmd.available).toBe(false);
    expect(body.qmd.status).toBe("unreachable");
    expect(typeof body.qmd.error).toBe("string");
  });

  test("reports NATS readiness from attached runtime dependency", async () => {
    const nats = {
      url: "nats://test:4222",
      healthCheck: async () => ({ ok: true })
    } as any;
    const app = createWebServer(stubService, stubDb, testEnv(), { nats });
    const res = await app.request("/api/runtime");
    const body = await res.json();

    expect(body.nats).toMatchObject({
      configured: true,
      available: true,
      status: "available",
      url: "nats://test:4222"
    });
  });

  test("reports docker workspace config without preflight when disabled", async () => {
    const app = createWebServer(
      stubService,
      stubDb,
      testEnv({ WORKSPACE_PROVIDER: "docker", WORKSPACE_DOCKER_PRECHECK: "0" })
    );
    const res = await app.request("/api/runtime");
    const body = await res.json();

    expect(body.workspace.provider).toBe("docker");
    expect(body.workspace.taskExecutionMode).toBe("docker_container");
    expect(body.workspace.docker.enabled).toBe(true);
    expect(body.workspace.docker.precheckEnabled).toBe(false);
    expect(body.workspace.docker.status).toBe("not_checked");
  });
});
