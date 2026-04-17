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

describe("critiquePlan", () => {
  test("critique re-runs planner and returns to awaiting_plan_approval", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");

    const after = await service.critiquePlan(task.id, "please split subtask 1");
    expect(after.state).toBe("awaiting_plan_approval");

    const transcripts = db.listTranscriptsByTask(task.id);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[1].attempt).toBe(1);
  });

  test("critique on a non-paused task is rejected", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "x", { reviewPlan: false });
    await expect(service.critiquePlan(task.id, "x")).rejects.toThrow();
  });

  test("4th critique exceeds limit and throws", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "STANDARD task");
    await service.critiquePlan(task.id, "feedback 1");
    await service.critiquePlan(task.id, "feedback 2");
    await service.critiquePlan(task.id, "feedback 3");
    await expect(service.critiquePlan(task.id, "feedback 4")).rejects.toThrow(/limit/i);
  });
});
