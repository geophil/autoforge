import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "../db/client";
import type { AgentExecutor } from "../executors/interface";
import type { AgentType } from "../types/core";

export interface DiagnosticCluster {
  label: string;
  keywords: string;
  representative_task_ids: string[];
  baseline_score_mean: number;
  population_score_mean: number;
  score_gap: number;
  recommendation_strength: "weak" | "moderate" | "strong";
  suggested_specialty: string;
}

export interface DiagnosticOutput {
  clusters: DiagnosticCluster[];
}

export interface RunDiagnosticInput {
  db: DbClient;
  executor: AgentExecutor;
  agentType: AgentType;
  trigger?: string;
  workingDirectory?: string;
  now?: Date;
  systemPrompt?: string;
}

const DIAGNOSTIC_BUDGET_SECONDS = 90;
const DIAGNOSTIC_HISTORY_LIMIT = 100;
const STALE_PROPOSAL_DAYS = 14;
const MIN_HISTORY_TASKS = 30;
const MAX_CLUSTERS = 3;

export function parseDiagnosticOutput(output: unknown): DiagnosticOutput {
  const parsed = typeof output === "string" ? safeJsonParse(output) : output;
  if (!isRecord(parsed) || !Array.isArray(parsed.clusters)) {
    return { clusters: [] };
  }

  return {
    clusters: parsed.clusters
      .map(toDiagnosticCluster)
      .filter((cluster): cluster is DiagnosticCluster => cluster !== null)
      .slice(0, MAX_CLUSTERS)
  };
}

export function proposalIdForCluster(agentType: string, keywords: string, generatedAt: string): string {
  const day = dayKey(generatedAt);
  const digest = createHash("sha256")
    .update(`${agentType}|${keywords}|${day}`)
    .digest("hex")
    .slice(0, 24);
  return `fp_${digest}`;
}

export function runDiagnosticStalenessSweep(db: DbClient, daysOld: number): number {
  return db.markStaleForkProposals(daysOld);
}

export async function runDiagnostic(input: RunDiagnosticInput): Promise<number> {
  const startedAt = input.now ?? new Date();
  const generatedAt = startedAt.toISOString();
  const tasks = input.db.loadDiagnosticTaskHistory(input.agentType, DIAGNOSTIC_HISTORY_LIMIT);

  if (tasks.length < MIN_HISTORY_TASKS) {
    appendDiagnosticEvent(input.db, {
      taskId: diagnosticTaskId(input.agentType, generatedAt),
      type: "diagnostic_run_completed",
      status: "done",
      payload: completionPayload(input.trigger, tasks.length, 0, 0, "insufficient_history")
    });
    return 0;
  }

  const baselineScoreMean = meanCompositeFromHistory(tasks);
  const prompt = JSON.stringify({ agent_type: input.agentType, baseline_score_mean: baselineScoreMean, tasks });
  try {
    const result = await input.executor.execute({
      id: `${diagnosticTaskId(input.agentType, generatedAt)}-run`,
      type: "diagnostician",
      systemPrompt: input.systemPrompt ?? resolveDiagnosticianPrompt(input.workingDirectory),
      prompt,
      workingDirectory: input.workingDirectory ?? process.cwd(),
      budgetSeconds: DIAGNOSTIC_BUDGET_SECONDS,
      environment: {},
      skillFiles: [],
      metadata: {
        agentType: input.agentType,
        trigger: input.trigger ?? "manual",
        tasksAnalyzed: tasks.length
      }
    });

    if (result.status !== "DONE") {
      appendDiagnosticEvent(input.db, {
        taskId: diagnosticTaskId(input.agentType, generatedAt),
        type: "diagnostic_run_completed",
        status: "done",
        payload: completionPayload(input.trigger, tasks.length, 0, elapsedSeconds(startedAt), `diagnostician_returned_${result.status}`)
      });
      return 0;
    }

    const parsed = parseDiagnosticOutput(result.output);
    let clustersProposed = 0;
    for (const cluster of parsed.clusters) {
      const proposalId = proposalIdForCluster(input.agentType, cluster.keywords, generatedAt);
      const inserted = input.db.insertForkProposal({
        id: proposalId,
        agentType: input.agentType,
        label: cluster.label,
        keywords: cluster.keywords,
        suggestedSpecialty: cluster.suggested_specialty,
        representativeTaskIds: cluster.representative_task_ids,
        baselineScoreMean: cluster.baseline_score_mean,
        populationScoreMean: cluster.population_score_mean,
        scoreGap: cluster.score_gap,
        recommendationStrength: cluster.recommendation_strength
      });
      if (!inserted) {
        continue;
      }
      clustersProposed += 1;
      appendDiagnosticEvent(input.db, {
        taskId: diagnosticTaskId(input.agentType, generatedAt),
        type: "diagnostic_cluster_detected",
        status: "done",
        payload: {
          fork_proposal_id: proposalId,
          agent_type: input.agentType,
          label: cluster.label,
          score_gap: cluster.score_gap,
          recommendation_strength: cluster.recommendation_strength
        }
      });
    }
    runDiagnosticStalenessSweep(input.db, STALE_PROPOSAL_DAYS);

    appendDiagnosticEvent(input.db, {
      taskId: diagnosticTaskId(input.agentType, generatedAt),
      type: "diagnostic_run_completed",
      status: "done",
      payload: completionPayload(input.trigger, tasks.length, clustersProposed, result.metrics.elapsedSeconds ?? elapsedSeconds(startedAt), null)
    });
    return clustersProposed;
  } catch (error) {
    appendDiagnosticEvent(input.db, {
      taskId: diagnosticTaskId(input.agentType, generatedAt),
      type: "diagnostic_run_completed",
      status: "done",
      payload: completionPayload(input.trigger, tasks.length, 0, elapsedSeconds(startedAt), error instanceof Error ? error.message : String(error))
    });
    return 0;
  }
}

function toDiagnosticCluster(value: unknown): DiagnosticCluster | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.label !== "string" ||
    typeof value.keywords !== "string" ||
    !Array.isArray(value.representative_task_ids) ||
    typeof value.suggested_specialty !== "string" ||
    !isFiniteNumber(value.baseline_score_mean) ||
    !isFiniteNumber(value.population_score_mean) ||
    !isFiniteNumber(value.score_gap) ||
    !isRecommendationStrength(value.recommendation_strength)
  ) {
    return null;
  }
  const representativeTaskIds = value.representative_task_ids.filter((id): id is string => typeof id === "string");
  if (representativeTaskIds.length === 0) return null;

  return {
    label: value.label,
    keywords: value.keywords,
    representative_task_ids: representativeTaskIds,
    baseline_score_mean: value.baseline_score_mean,
    population_score_mean: value.population_score_mean,
    score_gap: value.score_gap,
    recommendation_strength: value.recommendation_strength,
    suggested_specialty: value.suggested_specialty
  };
}

function meanCompositeFromHistory(rows: Array<Record<string, unknown>>): number | null {
  const composites = rows
    .map(compositeFromHistoryRow)
    .filter((score): score is number => score !== null);
  if (composites.length === 0) {
    return null;
  }
  return composites.reduce((sum, score) => sum + score, 0) / composites.length;
}

function compositeFromHistoryRow(row: Record<string, unknown>): number | null {
  const components = [
    row.r_correctness,
    row.r_simplicity,
    row.r_alignment,
    row.r_fidelity,
    row.r_efficiency
  ];
  if (!components.every(isFiniteNumber)) {
    return null;
  }
  return components.reduce((sum, score) => sum + score, 0) / components.length;
}

function completionPayload(
  trigger: string | undefined,
  tasksAnalyzed: number,
  clustersProposed: number,
  elapsedSecondsValue: number,
  error: string | null
): Record<string, unknown> {
  return {
    trigger: trigger ?? "manual",
    tasks_analyzed: tasksAnalyzed,
    clusters_proposed: clustersProposed,
    elapsed_seconds: elapsedSecondsValue,
    diagnostician_variant_id: null,
    error
  };
}

function appendDiagnosticEvent(
  db: DbClient,
  input: {
    taskId: string;
    type: string;
    status: "done" | "failed";
    payload: Record<string, unknown>;
  }
): void {
  db.appendEvent({
    id: randomUUID(),
    taskId: input.taskId,
    projectId: "diagnostic",
    timestamp: new Date().toISOString(),
    agent: "diagnostician",
    type: input.type,
    status: input.status,
    payload: input.payload,
    budgetSeconds: DIAGNOSTIC_BUDGET_SECONDS,
    elapsedSeconds: typeof input.payload.elapsed_seconds === "number" ? input.payload.elapsed_seconds : undefined
  });
}

function resolveDiagnosticianPrompt(workingDirectory: string | undefined): string {
  const filePath = join(workingDirectory ?? process.cwd(), "src/personas/diagnostician.md");
  if (existsSync(filePath)) {
    return readFileSync(filePath, "utf8").trim();
  }
  return "Analyze Autoforge task history and return only the requested diagnostic JSON.";
}

function diagnosticTaskId(agentType: string, generatedAt: string): string {
  return `diagnostic-${agentType}-${dayKey(generatedAt)}`;
}

function dayKey(value: string): string {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function elapsedSeconds(startedAt: Date): number {
  return Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecommendationStrength(value: unknown): value is DiagnosticCluster["recommendation_strength"] {
  return value === "weak" || value === "moderate" || value === "strong";
}
