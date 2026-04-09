import type { Database } from "bun:sqlite";
import type { AutoforgeMessage } from "../nats/messages";
import type { ComplexityAssessment, PlanSubtask, ReviewFinding, TaskStage, Tier } from "../types/core";

type TaskPayload = {
  description?: string;
  state?: TaskStage;
  tier?: Tier;
  assessment?: ComplexityAssessment;
  planSubtasks?: PlanSubtask[];
  iteration?: number;
  prUrl?: string;
  finding?: ReviewFinding;
  resolveAllFindings?: boolean;
};

export function applyEventProjection(sqlite: Database, message: AutoforgeMessage): void {
  const payload = message.payload as TaskPayload;
  const now = message.timestamp;
  const existing = sqlite.query("SELECT id FROM tasks WHERE id = ?").get(message.taskId) as { id: string } | null;

  if (existing === null) {
    sqlite
      .query(
        `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.taskId,
        message.projectId,
        payload.description ?? "unspecified task",
        payload.state ?? "received",
        payload.tier ?? "STANDARD",
        JSON.stringify(payload.assessment ?? defaultAssessment()),
        JSON.stringify(payload.planSubtasks ?? []),
        payload.iteration ?? 0,
        now,
        now
      );
  } else {
    sqlite
      .query(
        `UPDATE tasks
         SET description = COALESCE(?, description),
             state = COALESCE(?, state),
             tier = COALESCE(?, tier),
             assessment = COALESCE(?, assessment),
             plan = COALESCE(?, plan),
             iteration = COALESCE(?, iteration),
             pr_url = COALESCE(?, pr_url),
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        payload.description ?? null,
        payload.state ?? null,
        payload.tier ?? null,
        payload.assessment ? JSON.stringify(payload.assessment) : null,
        payload.planSubtasks ? JSON.stringify(payload.planSubtasks) : null,
        payload.iteration ?? null,
        payload.prUrl ?? null,
        now,
        message.taskId
      );
  }

  if (payload.planSubtasks?.length) {
    const upsert = sqlite.query(
      `INSERT OR REPLACE INTO subtasks (
         id, task_id, sequence, description, files_in_scope, dependencies, state, status, concerns, agent_type, budget_seconds
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const subtask of payload.planSubtasks) {
      upsert.run(
        subtask.id,
        message.taskId,
        subtask.sequence,
        subtask.description,
        JSON.stringify(subtask.filesInScope),
        JSON.stringify(subtask.dependencies),
        "pending",
        null,
        null,
        "coder",
        300
      );
    }
  }

  if (payload.finding) {
    sqlite
      .query(
        `INSERT OR REPLACE INTO review_findings (
           id, task_id, severity, category, description, file_path, resolved, resolved_in_iteration
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.finding.id,
        payload.finding.taskId,
        payload.finding.severity,
        payload.finding.category,
        payload.finding.description,
        payload.finding.filePath ?? null,
        payload.finding.resolved ? 1 : 0,
        payload.finding.resolvedInIteration ?? null
      );
  }

  if (payload.resolveAllFindings) {
    sqlite.query("UPDATE review_findings SET resolved = 1, resolved_in_iteration = ? WHERE task_id = ?").run(payload.iteration ?? 0, message.taskId);
  }
}

function defaultAssessment(): ComplexityAssessment {
  return {
    scope: "medium",
    novelty: "medium",
    risk: "medium",
    coupling: "medium",
    rationale: "default assessment before analysis",
    similarPastTasks: []
  };
}
