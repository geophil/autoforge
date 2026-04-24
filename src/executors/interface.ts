import type { AgentType, SubtaskReportStatus } from "../types/core";

export interface AgentTask {
  id: string;
  type: AgentType;
  systemPrompt: string;
  prompt: string;
  workingDirectory: string;
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
  metadata?: Record<string, unknown>;
  /** Per-run model override. When unset, executor uses its configured default. */
  model?: string;
  /**
   * Optional pre-rendered lessons block to inject between the persona and the
   * `# Skills` section (Spec B §5.4). When present and non-empty, executors
   * splice it verbatim into the system prompt; when absent, empty, or
   * whitespace-only, no lesson section is emitted. The orchestrator is
   * responsible for assembly and token-budgeting via
   * `retrieveLessonsForDispatch`.
   */
  lessons?: string;
}

export interface ToolStats {
  readCount: number;
  writeCount: number;
  bashCount: number;
  searchCount: number;
  iterations: number;
}

export type AgentTranscriptTurn =
  | { kind: "assistant"; content: unknown[] }
  | { kind: "tool_result"; toolUseId: string; content: string }
  | { kind: "compaction"; droppedTurns: number }
  | { kind: "error"; name: string; message: string; stack?: string };

export interface AgentTranscript {
  systemPrompt: string;
  userPrompt: string;
  turns: AgentTranscriptTurn[];
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
    toolStats?: ToolStats;
  };
  /** Captured by SDK executor. Claude Code returns undefined. */
  transcript?: AgentTranscript;
}

export interface AgentExecutor {
  readonly name: string;
  execute(task: AgentTask): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
}
