import type { RuntimeFailureSubtype } from "./runtime-failure-classifier";
import type { ToolStatsBucket } from "./tool-registry";

export type ToolExecutionSource = "local" | "qmd" | "guardrail" | "error";

export interface ToolExecutionOutcome {
  toolName: string;
  input: Record<string, unknown>;
  source: ToolExecutionSource;
  status: "success" | "error";
  result: unknown;
  latencyMs: number;
  isQmdTool: boolean;
  statsBucket?: ToolStatsBucket | null;
  qmdElapsedMs?: number;
  qmdAllowanceUsedMs?: number;
  qmdAllowanceRemainingMs?: number;
  failureSubtype?: RuntimeFailureSubtype;
}

export function guardrailToolResult(message: string, failureSubtype: RuntimeFailureSubtype): Record<string, unknown> {
  return {
    status: "blocked",
    failureSubtype,
    message,
    instruction: "Do not call more exploratory tools for this phase. Write .autoforge-status.json with the best available result now."
  };
}
