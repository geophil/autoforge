export type Tier = "EXPRESS" | "STANDARD" | "THOROUGH";
export type AgentType = "planner" | "coder" | "reviewer" | "doc" | "doc-review" | "pr" | "orchestrator" | "meta";
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "done_with_concerns"
  | "blocked"
  | "needs_context"
  | "failed"
  | "timeout";

export type SubtaskReportStatus = "DONE" | "DONE_WITH_CONCERNS" | "BLOCKED" | "NEEDS_CONTEXT";

export type TaskStage =
  | "received"
  | "assessing"
  | "planning"
  | "awaiting_plan_approval"
  | "replanning"
  | "executing"
  | "reviewing"
  | "reworking"
  | "pr_created"
  | "awaiting_approval"
  | "documenting"
  | "awaiting_intervention"
  | "completed"
  | "failed";

export interface ComplexityAssessment {
  scope: "small" | "medium" | "large";
  novelty: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  coupling: "low" | "medium" | "high";
  rationale: string;
  similarPastTasks: string[];
}

export interface ReviewFinding {
  id: string;
  taskId: string;
  severity: "CRITICAL" | "MAJOR" | "MINOR" | "NITPICK";
  category: string;
  description: string;
  filePath?: string;
  resolved: boolean;
  resolvedInIteration?: number;
}

export interface PlanSubtask {
  id: string;
  sequence: number;
  description: string;
  filesInScope: string[];
  dependencies: string[];
  testCriteria: string[];
  agentType?: AgentType;
}

export type RejectionCategory =
  | "stale_base"
  | "wrong_scope"
  | "incomplete"
  | "incorrect_output"
  | "quality_issues"
  | "other";

export interface RejectionFeedback {
  reason: string;
  guidance?: string;
  categories?: RejectionCategory[];
}

export interface PipelineTask {
  id: string;
  projectId: string;
  description: string;
  state: TaskStage;
  tier: Tier;
  assessment: ComplexityAssessment;
  planSubtasks: PlanSubtask[];
  iteration: number;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
