import { describe, expect, test } from "bun:test";
import type { AgentTask, AgentResult } from "../../src/executors/interface";
import { createTestService } from "../helpers/create-service";

describe("review and rejection rework loops", () => {
  test("automatically reworks major review findings", async () => {
    let reviewerCalls = 0;
    const handlers: Partial<Record<AgentTask["type"], (task: AgentTask) => AgentResult>> = {
      reviewer: () => {
        reviewerCalls += 1;
        if (reviewerCalls === 1) {
          return {
            status: "DONE_WITH_CONCERNS",
            artifacts: [],
            output: {
              findings: [
                {
                  id: "finding-1",
                  severity: "MAJOR",
                  category: "correctness",
                  description: "Need additional null handling.",
                  resolved: false
                }
              ]
            },
            metrics: { elapsedSeconds: 0.1 }
          };
        }
        return {
          status: "DONE",
          artifacts: [],
          output: { findings: [] },
          metrics: { elapsedSeconds: 0.1 }
        };
      }
    };

    const { service } = createTestService(handlers);
    const task = await service.submitTask("autoforge", "Implement API input validation", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");
    expect(task.iteration).toBe(1);
  });

  test("human rejection fails old task and spawns a fresh restart task", async () => {
    const { service, db } = createTestService();
    const oldTask = await service.submitTask("autoforge", "Add request tracing", { reviewPlan: false });
    expect(oldTask.state).toBe("awaiting_approval");

    const feedback = {
      reason: "broaden coverage",
      guidance: "include edge cases for empty input",
      categories: ["incomplete", "wrong_scope"] as Array<import("../../src/types/core").RejectionCategory>
    };
    const newTask = await service.rejectTask(oldTask.id, feedback);

    // Old task must be failed.
    const oldTaskNow = db.getTask(oldTask.id);
    expect(oldTaskNow?.state).toBe("failed");

    // New task is a fresh attempt that reaches awaiting_approval.
    expect(newTask.id).not.toBe(oldTask.id);
    expect(newTask.state).toBe("awaiting_approval");

    // New task description carries the human feedback.
    expect(newTask.description).toContain("Reviewer feedback from previous attempt");
    expect(newTask.description).toContain(feedback.reason);
    expect(newTask.description).toContain(feedback.guidance);

    // failure_analysis event on the old task has the structured payload.
    const events = db.listEvents(oldTask.id);
    const failureEvent = events.find((e) => e.type === "failure_analysis");
    expect(failureEvent).toBeDefined();
    const payload = failureEvent?.payload as Record<string, unknown>;
    expect(payload.failure_category).toBe("rejected");
    expect(payload.rejection_categories).toEqual(["incomplete", "wrong_scope"]);
    expect(payload.rejection_guidance).toBe("include edge cases for empty input");
    expect(payload.executor_used).toBeDefined();
    expect(payload.persona_version_id).toBeDefined();
    expect(payload.skill_version_ids).toBeDefined();
    expect("tool_stats" in payload).toBe(true);

    // restart_spawned event links old task to new task.
    const restartEvent = events.find((e) => e.type === "restart_spawned");
    expect(restartEvent).toBeDefined();
    const restartPayload = restartEvent?.payload as Record<string, unknown>;
    expect(restartPayload.restart_child_task_id).toBe(newTask.id);
  }, 15_000);
});
