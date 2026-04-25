import type { AgentResult, AgentTask } from "../executors/interface";
import type { AgentType } from "../types/core";
import type { SelectionResult } from "./dispatch";

export type ScoreComponents = Record<string, unknown>;

export interface ShadowRunnerInput {
  taskId: string;
  projectId: string;
  agentType: AgentType;
  baselineVariantId: string;
  candidateVariantId: string;
  liveTask: AgentTask;
  liveResult: AgentResult;
  candidateLessons: { ids: string[]; block: string };
}

export interface ShadowRunnerResult {
  scoreComponents: ScoreComponents;
  composite: number;
  executorUsed: string;
}

export type ShadowRunner = (input: ShadowRunnerInput) => Promise<ShadowRunnerResult>;

interface ShadowDispatchInput {
  taskId: string;
  projectId: string;
  agentType: AgentType;
  selection: SelectionResult;
  baselineVariantId: string | null;
  liveTask: AgentTask;
  liveResult: AgentResult;
  baselineExecutorUsed: string | null;
  baselineLessonIds: string[];
  loadCandidateLessons: (candidateVariantId: string) => Promise<{ ids: string[]; block: string }>;
  runner?: ShadowRunner;
  recordEvent: (event: {
    taskId: string;
    projectId: string;
    agent: "orchestrator";
    type: "shadow_run_completed";
    status: "done" | "done_with_concerns";
    payload: Record<string, unknown>;
    budgetSeconds: number;
  }) => void;
}

export async function runShadowDispatches(input: ShadowDispatchInput): Promise<void> {
  if (input.selection.shadowVariantIds.length === 0) return;

  const baselineVariantId = input.baselineVariantId;
  if (!baselineVariantId) {
    for (const candidateVariantId of input.selection.shadowVariantIds) {
      recordShadowRunCompleted(input, {
        task_id: input.taskId,
        agent_type: input.agentType,
        baseline_variant_id: null,
        candidate_variant_id: candidateVariantId,
        baseline_executor_used: input.baselineExecutorUsed,
        baseline_score_components: null,
        baseline_composite: null,
        baseline_lessons_injected: input.baselineLessonIds.length,
        candidate_score_components: null,
        candidate_composite: null,
        candidate_lessons_injected: 0,
        candidate_lesson_ids: [],
        candidate_executor_used: null,
        error: "baseline_variant_not_found"
      }, "done_with_concerns");
    }
    return;
  }
  const liveSelectedBaseline = input.selection.variantId === baselineVariantId;

  for (const candidateVariantId of input.selection.shadowVariantIds) {
    if (!liveSelectedBaseline) {
      recordShadowRunCompleted(input, {
        task_id: input.taskId,
        agent_type: input.agentType,
        baseline_variant_id: baselineVariantId,
        candidate_variant_id: candidateVariantId,
        baseline_executor_used: input.baselineExecutorUsed,
        baseline_score_components: null,
        baseline_composite: null,
        baseline_lessons_injected: 0,
        candidate_score_components: null,
        candidate_composite: null,
        candidate_lessons_injected: 0,
        candidate_lesson_ids: [],
        candidate_executor_used: null,
        error: "baseline_not_live"
      }, "done_with_concerns");
      continue;
    }

    const baselineScoreComponents = scoreComponentsFromLiveResult(input.liveResult);
    const baselineComposite = compositeFromStatus(input.liveResult.status);
    const payloadBase = {
      task_id: input.taskId,
      agent_type: input.agentType,
      baseline_variant_id: baselineVariantId,
      candidate_variant_id: candidateVariantId,
      baseline_executor_used: input.baselineExecutorUsed,
      baseline_score_components: baselineScoreComponents,
      baseline_composite: baselineComposite,
      baseline_lessons_injected: input.baselineLessonIds.length
    };

    let candidateLessons: { ids: string[]; block: string } = { ids: [], block: "" };
    try {
      candidateLessons = await input.loadCandidateLessons(candidateVariantId);
      const result = await (input.runner ?? defaultShadowRunner)({
        taskId: input.taskId,
        projectId: input.projectId,
        agentType: input.agentType,
        baselineVariantId,
        candidateVariantId,
        liveTask: input.liveTask,
        liveResult: input.liveResult,
        candidateLessons
      });

      recordShadowRunCompleted(input, {
        ...payloadBase,
        candidate_score_components: result.scoreComponents,
        candidate_composite: result.composite,
        candidate_lessons_injected: candidateLessons.ids.length,
        candidate_lesson_ids: candidateLessons.ids,
        candidate_executor_used: result.executorUsed
      });
    } catch (error) {
      recordShadowRunCompleted(input, {
        ...payloadBase,
        candidate_score_components: null,
        candidate_composite: null,
        candidate_lessons_injected: candidateLessons.ids.length,
        candidate_lesson_ids: candidateLessons.ids,
        candidate_executor_used: null,
        error: error instanceof Error ? error.message : String(error)
      }, "done_with_concerns");
    }
  }
}

export function recordShadowRunCompleted(
  input: Pick<ShadowDispatchInput, "taskId" | "projectId" | "recordEvent" | "liveTask">,
  payload: Record<string, unknown>,
  status: "done" | "done_with_concerns" = "done"
): void {
  input.recordEvent({
    taskId: input.taskId,
    projectId: input.projectId,
    agent: "orchestrator",
    type: "shadow_run_completed",
    status,
    payload,
    budgetSeconds: input.liveTask.budgetSeconds
  });
}

async function defaultShadowRunner(input: ShadowRunnerInput): Promise<ShadowRunnerResult> {
  void input;
  throw new Error("shadow_runner_not_configured");
}

function scoreComponentsFromLiveResult(result: AgentResult): ScoreComponents {
  return {
    status: result.status,
    elapsed_seconds: result.metrics.elapsedSeconds,
    concerns: result.concerns ?? null
  };
}

function compositeFromStatus(status: AgentResult["status"]): number {
  return status === "DONE" ? 1 : status === "DONE_WITH_CONCERNS" ? 0.75 : 0;
}
