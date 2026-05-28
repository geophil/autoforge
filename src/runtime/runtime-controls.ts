import type { AgentTask } from "../executors/interface";
import { AgentRunGuardrails, type AgentRunGuardrailConfig } from "./agent-run-guardrails";
import { RunBudget } from "./run-budget";
import { ToolResultShaper } from "./tool-output-shaping";

export type RuntimeControlsConfig = AgentRunGuardrailConfig & {
  qmdTotalAllowanceSeconds?: number;
  qmdCallTimeoutSeconds?: number;
  modelCallTimeoutSeconds?: number;
  finalReserveSeconds?: number;
};

export class RuntimeControls {
  readonly budget: RunBudget;
  readonly guardrails: AgentRunGuardrails;
  readonly shaper: ToolResultShaper;

  constructor(task: AgentTask, config: RuntimeControlsConfig = {}) {
    this.budget = new RunBudget({
      budgetSeconds: task.budgetSeconds,
      qmdTotalAllowanceSeconds: config.qmdTotalAllowanceSeconds,
      qmdCallTimeoutSeconds: config.qmdCallTimeoutSeconds,
      modelCallTimeoutSeconds: config.modelCallTimeoutSeconds,
      finalReserveSeconds: config.finalReserveSeconds
    });
    this.guardrails = new AgentRunGuardrails(task, config);
    this.shaper = new ToolResultShaper();
  }
}
