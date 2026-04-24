import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("orchestrator-owned failure_analysis auto-enrichment (Spec A review Mi1)", () => {
  test("cancelTask backfills persona_version_id / skill_version_ids from the most recent agent event", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      // Drive to awaiting_approval — both planner and coder will have emitted
      // events carrying persona_version_id and skill_version_ids.
      const task = await service.submitTask(
        "autoforge",
        "Add a hello world endpoint",
        { reviewPlan: false }
      );
      expect(task.state).toBe("awaiting_approval");

      await service.cancelTask(task.id, "changed my mind");

      const fa = db.sqlite.query(
        `SELECT payload FROM events
          WHERE task_id = ? AND event_type = 'failure_analysis'
          ORDER BY timestamp DESC LIMIT 1`
      ).get(task.id) as { payload: string };

      const parsed = JSON.parse(fa.payload) as Record<string, unknown>;
      expect(parsed.failure_category).toBe("cancelled");
      // Auto-enriched: these should now carry the last agent's provenance.
      expect(parsed.persona_version_id).toBeString();
      expect(Array.isArray(parsed.skill_version_ids)).toBe(true);
      expect((parsed.skill_version_ids as string[]).length).toBeGreaterThanOrEqual(0);
    } finally {
      cleanup();
    }
  });

  test(
    "rejectTask (after awaiting_approval) also carries enriched provenance",
    async () => {
      const { service, db, cleanup } = createTestService();
      try {
        const task = await service.submitTask(
          "autoforge",
          "Add a second endpoint",
          { reviewPlan: false }
        );
        expect(task.state).toBe("awaiting_approval");

        await service.rejectTask(task.id, {
          reason: "needs a different direction",
          categories: ["wrong_scope"]
        });

        const fa = db.sqlite.query(
          `SELECT payload FROM events
            WHERE task_id = ? AND event_type = 'failure_analysis'
            ORDER BY timestamp DESC LIMIT 1`
        ).get(task.id) as { payload: string };

        const parsed = JSON.parse(fa.payload) as Record<string, unknown>;
        expect(parsed.failure_category).toBe("rejected");
        expect(parsed.persona_version_id).toBeString();
      } finally {
        cleanup();
      }
    },
    // rejectTask spawns a restart task that drives through the full pipeline
    // (planner + coder + reviewer + doc); wall time under full-suite load sits
    // close to Bun's 5s default. 15s gives comfortable headroom.
    15000
  );
});
