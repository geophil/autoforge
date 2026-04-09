import { describe, expect, test } from "bun:test";
import { AutoforgeMessageSchema, taskSubject } from "../../src/nats/messages";

describe("nats message contracts", () => {
  test("builds stable task subjects", () => {
    expect(taskSubject("autoforge", "task-1", "created")).toBe("autoforge.task.autoforge.task-1.created");
  });

  test("validates autoforge message envelope", () => {
    const parsed = AutoforgeMessageSchema.parse({
      id: "2f7d0c79-476e-4481-a6fa-7d414f1888d0",
      taskId: "task-1",
      projectId: "autoforge",
      timestamp: new Date().toISOString(),
      agent: "orchestrator",
      type: "created",
      status: "pending",
      payload: { ok: true },
      budgetSeconds: 60
    });

    expect(parsed.taskId).toBe("task-1");
  });
});
