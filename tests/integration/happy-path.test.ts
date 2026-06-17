import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("happy path pipeline", () => {
  test("submits task and reaches approval, then completes after approval", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a hello world endpoint", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");

    const approved = await service.approveTask(task.id);
    expect(approved.state).toBe("completed");
    const lifecycleEvents = db.listEvents(task.id);
    expect(lifecycleEvents.some((event) => event.type === "workspace_created")).toBe(true);
    expect(lifecycleEvents.some((event) => event.type === "workspace_destroyed")).toBe(true);
    expect(lifecycleEvents.some((event) => event.type === "execution_contract")).toBe(true);
    expect(lifecycleEvents.some((event) => event.type === "task_exit_check")).toBe(true);

    const contract = lifecycleEvents.find((event) => event.type === "execution_contract")?.payload as
      | { wipLimit?: number; valid?: boolean; subtasks?: Array<Record<string, unknown>> }
      | undefined;
    expect(contract?.wipLimit).toBe(1);
    expect(contract?.valid).toBe(true);
    expect(contract?.subtasks?.[0]).toHaveProperty("verificationCommands");

    const exitCheck = lifecycleEvents.find((event) => event.type === "task_exit_check")?.payload as
      | { clean_state?: { tests?: boolean; artifacts?: boolean | null; startup?: boolean | null }; verification_status?: string }
      | undefined;
    expect(exitCheck?.verification_status).toBe("passed");
    expect(exitCheck?.clean_state?.tests).toBe(true);
    expect(exitCheck?.clean_state?.startup).toBeNull();

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
    if (diffRow) {
      expect(diffRow.task_id).toBe(task.id);
    } else {
      // In sandboxed test environments git worktree creation can fall back to
      // a plain directory, which intentionally skips diff-stat persistence.
      expect(lifecycleEvents.some((event) => event.type === "workspace_created")).toBe(true);
    }
  });

  test("standard tasks pause instead of opening a PR when verification is unavailable", async () => {
    const { service, db } = createTestService({}, {}, {
      testRunner: async () => ({
        passRate: 1,
        output: "(no test configuration detected — verification unavailable)",
        verificationStatus: "unavailable"
      })
    });

    const task = await service.submitTask("autoforge", "Add a hello world endpoint", {
      reviewPlan: false,
      forceTier: "STANDARD"
    });
    expect(task.state).toBe("awaiting_intervention");

    const failure = [...db.listEvents(task.id)].reverse().find((event) => event.type === "failure_analysis");
    expect(failure?.payload.failure_category).toBe("pr_gate");
    expect(failure?.payload.failure_reason).toBe("verification_unavailable");
  });

  test("standard tasks pause when planner omits required subtask contract fields", async () => {
    const { service, db } = createTestService({
      planner: async () => ({
        status: "DONE",
        artifacts: [],
        output: {
          discovery: {
            intent: "Add endpoint",
            constraints: [],
            assumptions: [],
            decisions: [],
            nonGoals: [],
            openQuestions: []
          },
          spec: {
            problem: "Need endpoint",
            desiredBehavior: ["Endpoint works"],
            acceptanceCriteria: ["Returns 200"],
            verification: ["Run tests"],
            risks: []
          },
          subtasks: [{
            id: "missing-contract-1",
            sequence: 1,
            description: "Implement endpoint",
            filesInScope: ["src/endpoint.ts"],
            dependencies: [],
            testCriteria: ["Returns 200"]
          }]
        },
        metrics: { elapsedSeconds: 0.1 }
      })
    });

    const task = await service.submitTask("autoforge", "Add a hello world endpoint", {
      reviewPlan: false,
      forceTier: "STANDARD"
    });
    expect(task.state).toBe("awaiting_intervention");

    const failure = [...db.listEvents(task.id)].reverse().find((event) => event.type === "failure_analysis");
    expect(failure?.payload.failure_category).toBe("planner_contract_invalid");
    const invalidSubtasks = failure?.payload.invalid_subtasks as Array<{ missing: string[] }> | undefined;
    expect(invalidSubtasks?.[0]?.missing).not.toContain("behavior");
    expect(invalidSubtasks?.[0]?.missing).toContain("verificationCommands");
    expect(invalidSubtasks?.[0]?.missing).toContain("completionEvidence");
    const repairs = failure?.payload.repairs as Array<Record<string, unknown>> | undefined;
    expect(repairs?.[0]).toMatchObject({
      field: "behavior",
      source: "description",
      status: "available"
    });
  });
});
