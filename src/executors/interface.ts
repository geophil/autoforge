import type { AgentType, SubtaskReportStatus } from "../types/core";
import type { Workspace } from "../runtime/workspace";

export interface AgentTask {
  id: string;
  type: AgentType;
  systemPrompt: string;
  prompt: string;
  workspace: Workspace;
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
  | { kind: "loaded_skills"; skills: string[] }
  | {
      kind: "compaction";
      droppedTurns: number;
      retainedRecentTurns?: number;
      triggerInputTokens?: number;
      summaryInputCharCount?: number;
      summaryOutputCharCount?: number;
      summaryModel?: string | null;
      usedFallback?: boolean;
    }
  | { kind: "error"; name: string; message: string; stack?: string };

export interface AgentTranscript {
  systemPrompt: string;
  userPrompt: string;
  turns: AgentTranscriptTurn[];
  loadedSkills?: string[];
}

export interface AgentResult {
  status: SubtaskReportStatus | "FAILED" | "TIMEOUT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
  diagnostics?: {
    exitCode?: number | null;
    stderrExcerpt?: string;
    stdoutExcerpt?: string;
    command?: string | null;
    executorMode?: string | null;
  };
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
