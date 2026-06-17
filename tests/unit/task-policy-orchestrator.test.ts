import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import type { AgentTask } from "../../src/executors/interface";
import type { PlanSubtask } from "../../src/types/core";

describe("orchestrator task policy", () => {
  test("emits task policy decision and scopes QMD environment by phase", async () => {
    const plannerEnvs: Array<Record<string, string>> = [];
    const coderEnvs: Array<Record<string, string>> = [];
    const { service, db, cleanup } = createTestService({
      planner: (task: AgentTask) => {
        plannerEnvs.push(task.environment);
        return {
          status: "DONE",
          artifacts: [],
          output: {
            subtasks: [subtask(task.id)],
            planningContext: {
              qmdContext: {
                status: "used",
                phase: "execution_plan",
                queries: ["task policy"],
                documents: ["docs/qmd/domain-agent-execution.md"],
                fallbackReason: null
              }
            }
          },
          metrics: { elapsedSeconds: 0.1 }
        };
      },
      coder: (task: AgentTask) => {
        coderEnvs.push(task.environment);
        return { status: "DONE", artifacts: [], metrics: { elapsedSeconds: 0.1 } };
      }
    }, {
      QMD_MCP_URL: "http://localhost:8181/mcp"
    });

    try {
      const task = await service.submitTask("autoforge", "Fix README typo", { reviewPlan: false });

      expect(task.state).toBe("awaiting_approval");
      const policyEvent = db.listEvents(task.id).find((event) => event.type === "task_policy_decision");
      expect(policyEvent?.payload).toMatchObject({
        task_type: "documentation",
        risk_level: "low",
        tier: "EXPRESS"
      });
      expect(plannerEnvs.some((env) => env.QMD_MCP_URL === "http://localhost:8181/mcp")).toBe(true);
      expect(coderEnvs.length).toBeGreaterThan(0);
      expect(coderEnvs.every((env) => env.QMD_MCP_URL === undefined)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

function subtask(taskId: string): PlanSubtask {
  return {
    id: `${taskId}-sub-1`,
    sequence: 1,
    behavior: "README typo is fixed.",
    description: "Fix README typo.",
    filesInScope: ["README.md"],
    dependencies: [],
    verificationCommands: ["bun test"],
    testCriteria: ["Relevant checks pass"],
    completionEvidence: ["Checks pass"]
  };
}
