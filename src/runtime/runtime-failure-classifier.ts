export type RuntimeFailureSubtype =
  | "qmd_call_timeout"
  | "qmd_allowance_exceeded"
  | "planner_qmd_call_cap_exceeded"
  | "model_call_timeout"
  | "planner_final_reserve_exhausted"
  | "max_tool_iterations"
  | "context_budget_exceeded";

export class RuntimeFailureError extends Error {
  constructor(
    readonly failureSubtype: RuntimeFailureSubtype,
    message: string
  ) {
    super(message);
    this.name = "RuntimeFailureError";
  }
}

export function isRuntimeFailureError(error: unknown): error is RuntimeFailureError {
  return error instanceof RuntimeFailureError;
}

export function isTimeoutLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes("must be an integer")) return false;
  return (
    error.name === "AbortError" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted")
  );
}
