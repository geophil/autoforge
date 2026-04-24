import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("happy path pipeline", () => {
  test("submits task and reaches approval, then completes after approval", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a hello world endpoint", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");

    const approved = await service.approveTask(task.id);
    expect(approved.state).toBe("completed");

    const variantEvents = db.sqlite
      .query(
        "SELECT json_extract(payload, '$.agent_type') AS agent_type FROM events WHERE event_type = 'variant_selected' AND task_id = ?"
      )
      .all(task.id) as Array<{ agent_type: string }>;

    const agentTypes = variantEvents.map((event) => event.agent_type);
    expect(agentTypes).toContain("planner");
    expect(agentTypes).toContain("coder");
    expect(agentTypes).toContain("reviewer");

    expect(agentTypes).toContain("doc");

    const plannerVariantEvent = db.sqlite
      .query(
        "SELECT payload FROM events WHERE event_type = 'variant_selected' AND task_id = ? ORDER BY timestamp ASC LIMIT 1"
      )
      .get(task.id) as { payload: string };

    const payload = JSON.parse(plannerVariantEvent.payload) as Record<string, unknown>;
    expect(payload.agent_type).toBe("planner");
    expect(payload.selected_variant_id).toBeString();
    expect(payload.selected_variant_specialty).toBeNull();
    expect(payload.eligible_variant_ids).toEqual([payload.selected_variant_id]);
    expect(payload.selection_rationale).toBe("only_eligible");
    expect(payload.shadow_variant_ids).toEqual([]);
    expect(payload.injected_lesson_ids).toEqual([]);
    expect(payload).not.toHaveProperty("persona_version_id");
    expect(payload).not.toHaveProperty("skill_version_ids");

    // Spec A review Mi3: every terminal task writes one task_diff_stats row,
    // so the task_quality_score view has the simplicity component to work with.
    const diffRow = db.sqlite
      .query("SELECT task_id, files_changed, lines_added, lines_deleted FROM task_diff_stats WHERE task_id = ?")
      .get(task.id) as { task_id: string; files_changed: number; lines_added: number; lines_deleted: number } | null;
    expect(diffRow).not.toBeNull();
    expect(diffRow!.task_id).toBe(task.id);
  });
});
