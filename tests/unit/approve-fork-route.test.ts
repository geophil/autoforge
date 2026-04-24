import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { createWebServer } from "../../src/web/server";

describe("POST /api/experiments/:id/approve-fork", () => {
  test("creates a candidate skill_versions row, applies pending retires, flips experiment to active", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vParent','persona:coder','1','seed','baseline',1.0)"
      ).run();
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();

      const lessonId = db.insertLesson({
        agentType: "coder",
        lineageRootId: "vParent",
        sourceTaskId: "metaT",
        sourceVariantId: "vParent",
        triggerPattern: "p",
        body: "b",
        outcomeKind: "corrective"
      });

      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before,
                                 operation, evidence, status, proposed_content)
        VALUES ('exp1','h','d','task_quality_score',0.5,'fork',
                json_object('parent_variant_id','vParent','specialty','frontend','pending_retire_lessons',json_array(?)),
                'proposed','# Forked content')
      `).run(lessonId);

      const resp = await app.request("/api/experiments/exp1/approve-fork", { method: "POST" });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { ok: boolean; variantId: string };
      expect(body.ok).toBe(true);
      expect(typeof body.variantId).toBe("string");

      const variant = db.sqlite.query(
        "SELECT status, parent_version_id, specialty, content, skill_name, traffic_share FROM skill_versions WHERE id = ?"
      ).get(body.variantId) as { status: string; parent_version_id: string; specialty: string; content: string; skill_name: string; traffic_share: number };
      expect(variant.status).toBe("candidate");
      expect(variant.parent_version_id).toBe("vParent");
      expect(variant.specialty).toBe("frontend");
      expect(variant.content).toBe("# Forked content");
      expect(variant.skill_name).toBe("persona:coder");
      expect(variant.traffic_share).toBe(0.0);

      const exp = db.sqlite.query("SELECT status FROM experiments WHERE id='exp1'").get() as { status: string };
      expect(exp.status).toBe("active");

      const lesson = db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(lessonId) as { status: string };
      expect(lesson.status).toBe("retired");
    } finally {
      cleanup();
    }
  });

  test("returns 404 for unknown experiment", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      const resp = await app.request("/api/experiments/missing/approve-fork", { method: "POST" });
      expect(resp.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  test("returns 409 when experiment is not a proposed fork (e.g., already-active edit)", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT2','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before, operation, status)
        VALUES ('exp2','h','d','task_quality_score',0,'edit','active')
      `).run();
      const resp = await app.request("/api/experiments/exp2/approve-fork", { method: "POST" });
      expect(resp.status).toBe(409);
    } finally {
      cleanup();
    }
  });

  test("returns 409 when proposed fork has no proposed_content", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vParent2','persona:coder','1','seed','baseline',1.0)"
      ).run();
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT3','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before, operation, evidence, status)
        VALUES ('exp3','h','d','task_quality_score',0.5,'fork',
                json_object('parent_variant_id','vParent2','specialty','x'),
                'proposed')
      `).run();
      const resp = await app.request("/api/experiments/exp3/approve-fork", { method: "POST" });
      expect(resp.status).toBe(409);
    } finally {
      cleanup();
    }
  });
});
