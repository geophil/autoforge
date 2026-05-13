import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { testEnv } from "../helpers/test-env";
import { createWebServer } from "../../src/web/server";

describe("POST /api/diagnostic/run", () => {
  test("returns a diagnostic result for manual trigger", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db, testEnv());
    try {
      const resp = await app.request("/api/diagnostic/run", {
        method: "POST",
        body: JSON.stringify({ agentType: "coder" }),
        headers: { "content-type": "application/json" }
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({ ok: true, agentType: "coder" });
    } finally {
      cleanup();
    }
  });

  test("defaults missing body to coder and includes cluster count", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db, testEnv());
    try {
      const resp = await app.request("/api/diagnostic/run", { method: "POST" });
      const body = await resp.json();

      expect(resp.status).toBe(200);
      expect(body).toMatchObject({ ok: true, agentType: "coder" });
      expect(typeof body.clustersProposed).toBe("number");
    } finally {
      cleanup();
    }
  });

  test("defaults missing agentType to coder and includes cluster count", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db, testEnv());
    try {
      const resp = await app.request("/api/diagnostic/run", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" }
      });
      const body = await resp.json();

      expect(resp.status).toBe(200);
      expect(body).toMatchObject({ ok: true, agentType: "coder" });
      expect(typeof body.clustersProposed).toBe("number");
    } finally {
      cleanup();
    }
  });

  test("rejects invalid agentType values", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db, testEnv());
    try {
      for (const agentType of ["meta", "bogus"]) {
        const resp = await app.request("/api/diagnostic/run", {
          method: "POST",
          body: JSON.stringify({ agentType }),
          headers: { "content-type": "application/json" }
        });
        const body = await resp.json();

        expect(resp.status).toBe(400);
        expect(body.error).toContain("agentType");
      }
    } finally {
      cleanup();
    }
  });
});
