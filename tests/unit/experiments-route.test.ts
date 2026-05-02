import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { createWebServer } from "../../src/web/server";

describe("GET /api/experiments", () => {
  test("lists proposed fork experiments when filtered by status and operation", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before,
                                 operation, evidence, status, proposed_content)
        VALUES
          ('exp-fork', 'h', 'fork', 'task_quality_score', 0, 'fork',
           json_object('parent_variant_id', 'vParent', 'specialty', 'frontend'), 'proposed', '# fork content'),
          ('exp-edit', 'h', 'edit', 'task_quality_score', 0, 'edit',
           json_object(), 'proposed', '# edit'),
          ('exp-active-fork', 'h', 'fork active', 'task_quality_score', 0, 'fork',
           json_object('parent_variant_id', 'vParent', 'specialty', 'backend'), 'active', '# active')
      `).run();

      const resp = await app.request("/api/experiments?status=proposed&operation=fork");
      expect(resp.status).toBe(200);
      const body = await resp.json() as { experiments: Array<Record<string, unknown>> };

      expect(body.experiments.map((exp) => exp.experiment_id)).toEqual(["exp-fork"]);
      expect(body.experiments[0]).toMatchObject({
        experiment_id: "exp-fork",
        hypothesis: "h",
        evidence: { parent_variant_id: "vParent", specialty: "frontend" },
        parent_variant_id: "vParent",
        proposed_specialty: "frontend",
        proposed_content_preview: "# fork content"
      });
      expect(typeof body.experiments[0].created_at).toBe("string");
    } finally {
      cleanup();
    }
  });
});

describe("POST /api/experiments/:id/reject-fork", () => {
  test("discards a proposed fork and emits fork_rejected", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before,
                                 operation, evidence, status, proposed_content)
        VALUES ('exp-reject', 'h', 'fork', 'task_quality_score', 0, 'fork',
                json_object('parent_variant_id', 'vParent', 'specialty', 'frontend'),
                'proposed', '# fork')
      `).run();

      const resp = await app.request("/api/experiments/exp-reject/reject-fork", {
        method: "POST",
        body: JSON.stringify({ reviewer: "ops", reason: "not enough evidence" }),
        headers: { "content-type": "application/json" }
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });

      const exp = db.sqlite.query("SELECT status, human_notes FROM experiments WHERE id = 'exp-reject'")
        .get() as { status: string; human_notes: string | null };
      expect(exp.status).toBe("discard");
      expect(exp.human_notes).toBe("not enough evidence");

      const event = db.sqlite.query(`
        SELECT payload
          FROM events
         WHERE event_type = 'fork_rejected'
      `).get() as { payload: string } | undefined;
      expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({
        experiment_id: "exp-reject",
        reviewer: "ops",
        reason: "not enough evidence"
      });
    } finally {
      cleanup();
    }
  });
});
