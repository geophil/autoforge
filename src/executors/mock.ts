import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentExecutor, AgentResult, AgentTask } from "./interface";
import type { PlanSubtask, ReviewFinding } from "../types/core";

type Handler = (task: AgentTask) => Promise<AgentResult> | AgentResult;

let nextMetaResult: unknown = null;
let nextProposedContent: string | null = null;

/**
 * Stub the next meta-agent invocation's output for tests that exercise
 * `submitMetaTask`. The stored result is consumed exactly once and cleared.
 * When `proposedContent` is provided, the Mock writes it to the worktree at
 * `operation.proposed_content_file` (or `proposed.md` as a fallback) so
 * `handleEdit`/`handleFork` can read it back.
 */
export function setMockMetaResult(output: unknown, proposedContent?: string): void {
  nextMetaResult = output;
  nextProposedContent = proposedContent ?? null;
}

export class MockExecutor implements AgentExecutor {
  readonly name = "mock";

  constructor(private readonly handlers: Partial<Record<AgentTask["type"], Handler>> = {}) {}

  async execute(task: AgentTask): Promise<AgentResult> {
    const handler = this.handlers[task.type];
    if (handler) {
      return await handler(task);
    }

    if (task.type === "meta" && nextMetaResult !== null) {
      const output = nextMetaResult;
      const content = nextProposedContent;
      nextMetaResult = null;
      nextProposedContent = null;

      if (content !== null && task.workingDirectory) {
        const op = (output as Record<string, unknown> | null)?.operation as
          | Record<string, unknown>
          | undefined;
        const filename = typeof op?.proposed_content_file === "string"
          ? op.proposed_content_file
          : "proposed.md";
        writeFileSync(join(task.workingDirectory, filename), content);
      }

      return {
        status: "DONE",
        artifacts: [],
        output,
        metrics: { elapsedSeconds: 0.1 }
      };
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
