import type { AgentTask } from "../executors/interface";
import type { RuntimeFailureSubtype } from "./runtime-failure-classifier";
import type { RunBudget } from "./run-budget";

export interface AgentRunGuardrailConfig {
  plannerSpecMaxQmdCalls?: number;
  plannerSpecMaxToolCalls?: number;
  contextMaxChars?: number;
}

export interface GuardrailBlock {
  failureSubtype: RuntimeFailureSubtype;
  message: string;
  shouldContinue: boolean;
}

const DEFAULT_PLANNER_SPEC_MAX_QMD_CALLS = 3;
const DEFAULT_PLANNER_SPEC_MAX_TOOL_CALLS = 8;
const DEFAULT_CONTEXT_MAX_CHARS = 120_000;

export class AgentRunGuardrails {
  private readonly plannerPhase: string | null;
  private readonly plannerSpecMaxQmdCalls: number;
  private readonly plannerSpecMaxToolCalls: number;
  private readonly contextMaxChars: number;
  private qmdToolCalls = 0;
  private totalToolCalls = 0;

  constructor(
    private readonly task: Pick<AgentTask, "type" | "prompt" | "metadata">,
    config: AgentRunGuardrailConfig = {}
  ) {
    this.plannerPhase = plannerPhase(task);
    this.plannerSpecMaxQmdCalls = config.plannerSpecMaxQmdCalls ?? DEFAULT_PLANNER_SPEC_MAX_QMD_CALLS;
    this.plannerSpecMaxToolCalls = config.plannerSpecMaxToolCalls ?? DEFAULT_PLANNER_SPEC_MAX_TOOL_CALLS;
    this.contextMaxChars = config.contextMaxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  }

  beforeTool(args: { toolName: string; isQmd: boolean; budget: RunBudget }): GuardrailBlock | null {
    if (!this.isPlannerSpec()) return null;
    if (isCompletionTool(args.toolName)) return null;

    if (args.budget.isInFinalReserve()) {
      return {
        failureSubtype: "planner_final_reserve_exhausted",
        shouldContinue: true,
        message: "Planner final reserve has started. Stop exploration and write the best available .autoforge-status.json now."
      };
    }

    const nextTotal = this.totalToolCalls + 1;
    const nextQmd = this.qmdToolCalls + (args.isQmd ? 1 : 0);
    if (nextQmd > this.plannerSpecMaxQmdCalls) {
      return {
        failureSubtype: "planner_qmd_call_cap_exceeded",
        shouldContinue: true,
        message: `Planner spec QMD call cap reached (${this.plannerSpecMaxQmdCalls}). Use existing QMD evidence and write the spec now.`
      };
    }
    if (nextTotal > this.plannerSpecMaxToolCalls) {
      return {
        failureSubtype: "max_tool_iterations",
        shouldContinue: true,
        message: `Planner spec tool-call cap reached (${this.plannerSpecMaxToolCalls}). Stop exploration and write the spec now.`
      };
    }
    return null;
  }

  recordTool(args: { isQmd: boolean }): void {
    this.totalToolCalls += 1;
    if (args.isQmd) this.qmdToolCalls += 1;
  }

  checkContextSize(chars: number): GuardrailBlock | null {
    if (chars <= this.contextMaxChars) return null;
    return {
      failureSubtype: "context_budget_exceeded",
      shouldContinue: false,
      message: `Serialized model history exceeded the configured context guardrail (${chars} > ${this.contextMaxChars} chars).`
    };
  }

  private isPlannerSpec(): boolean {
    return this.task.type === "planner" && this.plannerPhase === "spec";
  }
}

function isCompletionTool(toolName: string): boolean {
  return toolName === "done" || toolName === "write_file";
}

function plannerPhase(task: Pick<AgentTask, "prompt" | "metadata">): string | null {
  const metadataPhase = task.metadata?.phase;
  if (typeof metadataPhase === "string") return metadataPhase;
  const match = task.prompt.match(/## Phase\s*\n\s*([A-Za-z_]+)/);
  return match?.[1] ?? null;
}
