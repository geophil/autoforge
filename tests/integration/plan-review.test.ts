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
