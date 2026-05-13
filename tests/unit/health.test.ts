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
