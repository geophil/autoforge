import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("plan-review pause", () => {
  test("STANDARD task pauses at awaiting_plan_approval after planner", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");
    expect(task.planSubtasks.length).toBeGreaterThan(0);
  });

  test("EXPRESS task does not pause; runs through to awaiting_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "tiny tweak", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_approval");
  });
});

describe("approvePlan", () => {
  test("approves plan and runs to awaiting_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");

    const resumed = await service.approvePlan(task.id);
    expect(resumed.state).toBe("awaiting_approval");
  });

  test("rejects approve when task is not in awaiting_plan_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "x", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");
    await expect(service.approvePlan(task.id)).rejects.toThrow();
  });
});
