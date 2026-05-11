export type Tier = "EXPRESS" | "STANDARD" | "THOROUGH";
export type AgentType = "planner" | "coder" | "reviewer" | "doc" | "doc-review" | "pr" | "orchestrator" | "meta" | "reflector" | "diagnostician";
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
  | "awaiting_spec_approval"
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

/** Parser-facing planner phases (excludes legacy bucket used only in ParsedPlannerOutput). */
export type PlannerRequestedPhase = "spec" | "execution_plan" | "combined";

export type PlannerParserPhase = "legacy_subtasks" | "spec" | "execution_plan" | "combined";

export interface PlanningQmdContext {
  status: "used" | "fallback";
  phase: PlannerRequestedPhase;
  queries: string[];
  documents: string[];
  fallbackReason: string | null;
}

export interface PlanningContext {
  specRevision: number;
  planRevision: number;
  approvalMode: "manual" | "auto" | null;
  reviewedAt: string | null;
  qmdContext?: PlanningQmdContext | null;
}

export interface PlannerDecisionEntry {
  decision: string;
  reason: string;
  alternativesRejected: string[];
  consequence: string;
}

export interface PlannerSpecArtifacts {
  discovery: {
    intent: string;
    constraints: string[];
    assumptions: string[];
    decisions: PlannerDecisionEntry[];
    nonGoals: string[];
    openQuestions: string[];
  };
  spec: {
    problem: string;
    desiredBehavior: string[];
    acceptanceCriteria: string[];
    verification: string[];
    risks: string[];
  };
}

export type ParsedPlannerOutput =
  | {
      phase: "spec";
      specArtifacts: PlannerSpecArtifacts;
      planningContext: PlanningContext;
      blockingQuestion: string | null;
      planSubtasks: [];
    }
  | {
      phase: "execution_plan" | "legacy_subtasks";
      specArtifacts?: PlannerSpecArtifacts;
      planningContext: PlanningContext;
      blockingQuestion: string | null;
      planSubtasks: PlanSubtask[];
    }
  | {
      phase: "combined";
      specArtifacts: PlannerSpecArtifacts;
      planningContext: PlanningContext;
      blockingQuestion: string | null;
      planSubtasks: PlanSubtask[];
    };

export function emptyPlanningContext(): PlanningContext {
  return {
    specRevision: 0,
    planRevision: 0,
    approvalMode: null,
    reviewedAt: null,
    qmdContext: null
  };
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
  /** Persisted from submitTask; when undefined/null on legacy rows, pause policy uses tier default only. */
  reviewPlan?: boolean | null;
  specArtifacts?: PlannerSpecArtifacts | null;
  planningContext?: PlanningContext | null;
  currentBlockingQuestion?: string | null;
}
