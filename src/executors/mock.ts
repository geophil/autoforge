import type { AgentExecutor, AgentResult, AgentTask } from "./interface";
import type { PlanSubtask, ReviewFinding } from "../types/core";

type Handler = (task: AgentTask) => Promise<AgentResult> | AgentResult;

export class MockExecutor implements AgentExecutor {
  readonly name = "mock";

  constructor(private readonly handlers: Partial<Record<AgentTask["type"], Handler>> = {}) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const handler = this.handlers[task.type];
    if (handler) {
      return await handler(task);
    }

    if (task.type === "planner") {
      const subtasks: PlanSubtask[] = [
        {
          id: `${task.id}-sub-1`,
          sequence: 1,
          description: "Implement requested change using TDD.",
          filesInScope: ["src/"],
          dependencies: [],
          testCriteria: ["All related tests pass."]
        }
      ];

      return this.result("DONE", { subtasks });
    }

    if (task.type === "reviewer") {
      return this.result("DONE", { findings: [] as ReviewFinding[] });
    }

    if (task.type === "doc") {
      return this.result("DONE", { artifacts: ["README.md"] });
    }

    if (task.type === "reflector") {
      return this.result("DONE", { lesson: { skip: true, reason: "mock-executor" } });
    }

    return this.result("DONE");
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  private result(status: AgentResult["status"], output?: unknown): AgentResult {
    return {
      status,
      artifacts: [],
      output,
      metrics: {
        elapsedSeconds: 0.1
      }
    };
  }
}
