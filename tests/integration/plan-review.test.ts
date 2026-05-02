import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("plan-review pause", () => {
  test("STANDARD task pauses at awaiting_plan_approval after planner", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");
    expect(task.planSubtasks.length).toBeGreaterThan(0);

    const transcripts = db.listTranscriptsByTask(task.id);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].personaVersionId).toBeTruthy();
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

  test("queued steering is consumed on next coder dispatch", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");

    service.addSteeringMessage(task.id, "Prefer the v2 endpoint and avoid legacy adapters.");
    const resumed = await service.approvePlan(task.id);
    expect(resumed.state).toBe("awaiting_approval");

    const events = db.listEvents(task.id);
    const steeringMessage = events.find((event) => event.type === "steering_message");
    const consumed = events.find((event) => event.type === "steering_consumed");
    expect(steeringMessage).toBeDefined();
    expect(consumed).toBeDefined();
    expect(consumed!.payload.agent_type).toBe("coder");
    expect(consumed!.payload.steering_event_ids).toContain(steeringMessage!.id);
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

describe("end-to-end critique loop", () => {
  test("submit -> critique -> approve -> awaiting_approval", async () => {
    const { service, db } = createTestService();
    const created = await service.submitTask("autoforge", "Build a STANDARD-tier widget");
    expect(created.state).toBe("awaiting_plan_approval");

    await service.critiquePlan(created.id, "be more specific about file paths");
    const afterCritique = service.getTask(created.id)!;
    expect(afterCritique.state).toBe("awaiting_plan_approval");

    const approved = await service.approvePlan(created.id);
    expect(approved.state).toBe("awaiting_approval");

    const transcripts = db.listTranscriptsByTask(created.id);
    expect(transcripts.length).toBe(2);
    expect(transcripts[0].attempt).toBe(0);
    expect(transcripts[1].attempt).toBe(1);

    const completed = await service.approveTask(created.id);
    expect(completed.state).toBe("completed");
  });
});
