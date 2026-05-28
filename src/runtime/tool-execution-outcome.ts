import type { RuntimeFailureSubtype } from "./runtime-failure-classifier";

export type ToolExecutionSource = "local" | "qmd" | "guardrail" | "error";

export interface ToolExecutionOutcome {
  source: ToolExecutionSource;
  status: "success" | "error";
  result: unknown;
  isQmdTool: boolean;
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
