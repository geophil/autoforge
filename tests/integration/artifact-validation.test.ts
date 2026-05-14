import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("artifact-to-diff validation", () => {
  test("marks subtask_done as done_with_concerns when reported artifacts mismatch changed files", async () => {
    const { service, db } = createTestService({
      planner: async () => ({
        status: "DONE",
        artifacts: [],
        output: {
          subtasks: [
            {
              id: "sub-1",
              sequence: 1,
              description: "implement one file",
              filesInScope: ["src/"],
              dependencies: [],
              testCriteria: ["tests pass"]
            }
          ]
        },
        metrics: { elapsedSeconds: 0.1 }
      }),
      coder: async (task) => {
        await task.workspace.writeFile("src/actual.ts", "export const value = 1;\n");
        return {
          status: "DONE",
          artifacts: ["src/expected.ts"],
          metrics: { elapsedSeconds: 0.2 }
        };
      }
    });

    const task = await service.submitTask("autoforge", "artifact mismatch test", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_approval");

    const events = db.listEvents(task.id);
    const subtaskDone = events.find((e) => e.type === "subtask_done");
    expect(subtaskDone).toBeDefined();
    expect(subtaskDone!.status).toBe("done_with_concerns");
    const subtaskDonePayload = subtaskDone!.payload as any;
    expect(subtaskDonePayload.artifact_validation).toBeDefined();
    expect(subtaskDonePayload.artifact_validation.status).toBe("mismatch");
    expect(subtaskDonePayload.artifact_validation.missing_reported).toContain("src/expected.ts");
    expect(subtaskDonePayload.artifact_validation.unexpected_changed).toContain("src/actual.ts");
  });

  test("keeps subtask_done as done when artifacts match changed files", async () => {
    const { service, db } = createTestService({
      planner: async () => ({
        status: "DONE",
        artifacts: [],
        output: {
          subtasks: [
            {
              id: "sub-1",
              sequence: 1,
              description: "implement one file",
              filesInScope: ["src/"],
              dependencies: [],
              testCriteria: ["tests pass"]
            }
          ]
        },
        metrics: { elapsedSeconds: 0.1 }
      }),
      coder: async (task) => {
        await task.workspace.writeFile("src/match.ts", "export const match = true;\n");
        return {
          status: "DONE",
          artifacts: ["src/match.ts"],
          metrics: { elapsedSeconds: 0.2 }
        };
      }
    });

    const task = await service.submitTask("autoforge", "artifact match test", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_approval");

    const events = db.listEvents(task.id);
    const subtaskDone = events.find((e) => e.type === "subtask_done");
    expect(subtaskDone).toBeDefined();
    expect(subtaskDone!.status).toBe("done");
    const subtaskDonePayload2 = subtaskDone!.payload as any;
    expect(subtaskDonePayload2.artifact_validation).toBeDefined();
    expect(subtaskDonePayload2.artifact_validation.status).toBe("ok");
    expect(subtaskDonePayload2.artifact_validation.mismatch_ratio).toBe(0);
  });
});
