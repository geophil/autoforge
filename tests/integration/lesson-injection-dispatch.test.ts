import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createTestService } from "../helpers/create-service";
import { PersonaRegistry } from "../../src/personas/registry";

describe("lesson injection at dispatch", () => {
  test("variant_selected for coder carries non-empty injected_lesson_ids when a matching lesson exists", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      // Snapshot the coder persona into skill_versions so we have an id to root the lineage on.
      const personas = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
      const coderVariantId = personas.snapshotId("coder");

      // Seed a task + a coder lesson that overlaps with the keywords in the description.
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('seed-task','autoforge','seed','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.insertLesson({
        agentType: "coder",
        lineageRootId: db.resolveLineageRoot(coderVariantId) ?? coderVariantId,
        sourceTaskId: "seed-task",
        sourceVariantId: coderVariantId,
        triggerPattern: "react styling",
        body: "TRIGGER: react\nOBSERVATION: use css modules\nPRINCIPLE: scope styles per component\nEVIDENCE: prior task",
        outcomeKind: "corrective",
        retrievalKeywords: "react styling component"
      });

      const task = await service.submitTask(
        "autoforge",
        "Style a React component with CSS modules",
        { reviewPlan: false }
      );
      expect(task.state).toBe("awaiting_approval");

      const coderEvent = db.sqlite.query(
        `SELECT payload FROM events
          WHERE task_id = ?
            AND event_type = 'variant_selected'
            AND json_extract(payload, '$.agent_type') = 'coder'
          ORDER BY timestamp ASC LIMIT 1`
      ).get(task.id) as { payload: string };

      const payload = JSON.parse(coderEvent.payload) as Record<string, unknown>;
      expect(Array.isArray(payload.injected_lesson_ids)).toBe(true);
      expect((payload.injected_lesson_ids as string[]).length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  test("variant_selected for meta carries empty injected_lesson_ids (meta bypasses retrieval)", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      // Seed a lesson that would match if retrieval ran, just to prove it doesn't.
      const personas = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
      const metaVariantId = personas.snapshotId("meta");
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('seed-meta','autoforge','seed','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.insertLesson({
        agentType: "meta",
        lineageRootId: db.resolveLineageRoot(metaVariantId) ?? metaVariantId,
        sourceTaskId: "seed-meta",
        sourceVariantId: metaVariantId,
        triggerPattern: "meta review tasks",
        body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
        outcomeKind: "corrective",
        retrievalKeywords: "meta review tone"
      });

      await service.submitMetaTask("autoforge", "meta review tone");

      const metaEvent = db.sqlite.query(
        `SELECT payload FROM events
          WHERE event_type = 'variant_selected'
            AND json_extract(payload, '$.agent_type') = 'meta'
          ORDER BY timestamp DESC LIMIT 1`
      ).get() as { payload: string };

      const payload = JSON.parse(metaEvent.payload) as Record<string, unknown>;
      expect(payload.injected_lesson_ids).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
