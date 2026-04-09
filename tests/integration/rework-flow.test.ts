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
    const task = await service.submitTask("autoforge", "Implement API input validation");
    expect(task.state).toBe("awaiting_approval");
    expect(task.iteration).toBe(1);
  });

  test("human rejection returns task to rework and back to approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add request tracing");
    const rejected = await service.rejectTask(task.id, "Please improve naming.");

    expect(rejected.state).toBe("awaiting_approval");
    expect(rejected.iteration).toBe(1);
  });
});
