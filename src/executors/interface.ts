import type { AgentType, SubtaskReportStatus } from "../types/core";

export interface AgentTask {
  id: string;
  type: AgentType;
  prompt: string;
  workingDirectory: string;
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  status: SubtaskReportStatus | "FAILED" | "TIMEOUT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
  output?: unknown;
  metrics: {
    elapsedSeconds: number;
    tokenInput?: number;
    tokenOutput?: number;
    estimatedCost?: number;
  };
}

export interface AgentExecutor {
  readonly name: string;
  execute(task: AgentTask): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
}
