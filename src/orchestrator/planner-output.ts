import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type {
  PlanSubtask,
  PlannerRequestedPhase,
  PlanningQmdContext,
  PlannerSpecArtifacts,
  PlanningContext,
  ParsedPlannerOutput
} from "../types/core";

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normalizeSpecArtifacts(raw: Record<string, unknown> | null | undefined): PlannerSpecArtifacts | null {
  if (!raw || typeof raw !== "object") return null;
  const disc = (raw.discovery as Record<string, unknown> | undefined) ?? {};
  const spec = (raw.spec as Record<string, unknown> | undefined) ?? {};

  const intent = typeof disc.intent === "string" ? disc.intent : "";
  const problem = typeof spec.problem === "string" ? spec.problem : "";

  const decisionsRaw = Array.isArray(disc.decisions) ? disc.decisions : [];
  const decisions = decisionsRaw.map((d) => {
    const row = d && typeof d === "object" ? (d as Record<string, unknown>) : {};
    return {
      decision: typeof row.decision === "string" ? row.decision : "",
      reason: typeof row.reason === "string" ? row.reason : "",
      alternativesRejected: asStringArray(row.alternativesRejected),
      consequence: typeof row.consequence === "string" ? row.consequence : ""
    };
  });

  const artifacts: PlannerSpecArtifacts = {
    discovery: {
      intent,
      constraints: asStringArray(disc.constraints),
      assumptions: asStringArray(disc.assumptions),
      decisions,
      nonGoals: asStringArray(disc.nonGoals),
      openQuestions: asStringArray(disc.openQuestions)
    },
    spec: {
      problem,
      desiredBehavior: asStringArray(spec.desiredBehavior),
      acceptanceCriteria: asStringArray(spec.acceptanceCriteria),
      verification: asStringArray(spec.verification),
      risks: asStringArray(spec.risks)
    }
  };

  const hasBody = intent.trim().length > 0 || problem.trim().length > 0;
  return hasBody ? artifacts : null;
}

function normalizePlanningQmdContext(raw: unknown): PlanningQmdContext | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const status = row.status === "used" ? "used" : "fallback";
  const phase =
    row.phase === "spec" || row.phase === "execution_plan" || row.phase === "combined"
      ? row.phase
      : "execution_plan";
  const fallbackReason =
    typeof row.fallbackReason === "string" && row.fallbackReason.trim().length > 0
      ? row.fallbackReason.trim()
      : null;
  return {
    status,
    phase,
    queries: asStringArray(row.queries),
    documents: asStringArray(row.documents),
    fallbackReason
  };
}

export function extractBlockingQuestion(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const q = (output as { blockingQuestion?: unknown }).blockingQuestion;
  if (typeof q !== "string" || !q.trim()) return null;
  return q.trim();
}

function extractPlanSubtasksFromOutput(taskId: string, output: unknown, worktreePath?: string): PlanSubtask[] {
  if (
    output &&
    typeof output === "object" &&
    "subtasks" in output &&
    Array.isArray((output as { subtasks: unknown[] }).subtasks) &&
    (output as { subtasks: unknown[] }).subtasks.length > 0
  ) {
    const subtasks = (output as { subtasks: Array<Partial<PlanSubtask>> }).subtasks;
    return subtasks.map((subtask, index) => ({
      id: subtask.id ?? `${taskId}-subtask-${index + 1}`,
      sequence: subtask.sequence ?? index + 1,
      description: subtask.description ?? `Subtask ${index + 1}`,
      filesInScope: subtask.filesInScope ?? ["src/"],
      dependencies: subtask.dependencies ?? [],
      testCriteria: subtask.testCriteria ?? ["Tests pass."],
      agentType: subtask.agentType
    }));
  }

  if (worktreePath) {
    try {
      const subtasksPath = pathJoin(worktreePath, "subtasks.json");
      if (existsSync(subtasksPath)) {
        const parsed = JSON.parse(readFileSync(subtasksPath, "utf8"));
        const list = Array.isArray(parsed) ? parsed : parsed?.subtasks;
        if (Array.isArray(list) && list.length > 0) {
          return (list as Array<Partial<PlanSubtask>>).map((subtask, index) => ({
            id: subtask.id ?? `${taskId}-subtask-${index + 1}`,
            sequence: subtask.sequence ?? index + 1,
            description: subtask.description ?? `Subtask ${index + 1}`,
            filesInScope: subtask.filesInScope ?? ["src/"],
            dependencies: subtask.dependencies ?? [],
            testCriteria: subtask.testCriteria ?? ["Tests pass."],
            agentType: subtask.agentType
          }));
        }
      }
    } catch {
      // ignore
    }
  }

  return [];
}

function fallbackSubtasks(taskId: string): PlanSubtask[] {
  return [
    {
      id: `${taskId}-subtask-1`,
      sequence: 1,
      description: "Implement requested behavior with tests-first workflow.",
      filesInScope: ["src/"],
      dependencies: [],
      testCriteria: ["All tests pass."]
    }
  ];
}

/**
 * Parse planner JSON output into the orchestrator contract. Does not apply
 * requestedPhase mismatch rules — callers handle policy for phase skew.
 */
export function parsePlannerStructuredOutput(
  taskId: string,
  output: unknown,
  requestedPhase: PlannerRequestedPhase | undefined,
  worktreePath?: string
): ParsedPlannerOutput {
  const raw =
    output && typeof output === "object"
      ? (output as Record<string, unknown>)
      : undefined;
  const normalizedSpec =
    raw && (raw.discovery !== undefined || raw.spec !== undefined)
      ? normalizeSpecArtifacts(raw)
      : null;

  const planSubtasks = extractPlanSubtasksFromOutput(taskId, output, worktreePath);
  const blockingQ = extractBlockingQuestion(output);
  const pcRaw = raw?.planningContext as Record<string, unknown> | undefined;
  const planningContext: PlanningContext = {
    specRevision: typeof pcRaw?.specRevision === "number" ? pcRaw.specRevision : 0,
    planRevision: typeof pcRaw?.planRevision === "number" ? pcRaw.planRevision : 0,
    approvalMode:
      pcRaw?.approvalMode === "manual" || pcRaw?.approvalMode === "auto"
        ? pcRaw.approvalMode
        : null,
    reviewedAt: typeof pcRaw?.reviewedAt === "string" ? pcRaw.reviewedAt : null,
    qmdContext: normalizePlanningQmdContext(pcRaw?.qmdContext)
  };

  const hasSpec = normalizedSpec !== null;
  const hasTasks = planSubtasks.length > 0;

  if (hasSpec && hasTasks) {
    return {
      phase: "combined",
      specArtifacts: normalizedSpec,
      planningContext,
      blockingQuestion: null,
      planSubtasks
    };
  }

  if (hasSpec && !hasTasks) {
    return {
      phase: "spec",
      specArtifacts: normalizedSpec,
      planningContext,
      blockingQuestion: blockingQ,
      planSubtasks: []
    };
  }

  if (!hasSpec && hasTasks) {
    const phaseTag: "execution_plan" | "legacy_subtasks" =
      requestedPhase === undefined ? "legacy_subtasks" : "execution_plan";
    return {
      phase: phaseTag,
      planSubtasks,
      planningContext,
      blockingQuestion: null
    };
  }

  // Neither — generic fallback subtasks (legacy)
  return {
    phase: "legacy_subtasks",
    planSubtasks: fallbackSubtasks(taskId),
    planningContext,
    blockingQuestion: null
  };
}

export function isPlannerFallbackOutput(planSubtasks: PlanSubtask[]): boolean {
  return (
    planSubtasks.length === 1 &&
    planSubtasks[0].description === "Implement requested behavior with tests-first workflow."
  );
}
