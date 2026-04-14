import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type { AutoforgeMessage } from "../nats/messages";
import type { AgentType, PipelineTask, PlanSubtask, ReviewFinding, TaskStage, Tier } from "../types/core";
import { applyEventProjection } from "./projections";

export class DbClient {
  readonly sqlite: Database;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath, { create: true });
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
  }

  initSchema(schemaPath: string): void {
    const schema = readFileSync(schemaPath, "utf8");
    this.sqlite.exec(schema);
  }

  appendEvent(message: AutoforgeMessage, opts?: { resumable?: boolean; executorUsed?: string; contextEnvelopeHash?: string }): void {
    const statement = this.sqlite.query(`
      INSERT INTO events (
        id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload,
        budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost,
        resumable, executor_used, context_envelope_hash
      ) VALUES (
        $id, $task_id, $subtask_id, $timestamp, $project_id, $agent, $event_type, $status, $payload,
        $budget_seconds, $elapsed_seconds, $token_input, $token_output, $estimated_cost,
        $resumable, $executor_used, $context_envelope_hash
      )
    `);

    statement.run({
      $id: message.id,
      $task_id: message.taskId,
      $subtask_id: (message.payload as { subtaskId?: string }).subtaskId ?? null,
      $timestamp: message.timestamp,
      $project_id: message.projectId,
      $agent: message.agent,
      $event_type: message.type,
      $status: message.status,
      $payload: JSON.stringify(message.payload ?? {}),
      $budget_seconds: message.budgetSeconds,
      $elapsed_seconds: message.elapsedSeconds ?? null,
      $token_input: message.tokenUsage?.input ?? null,
      $token_output: message.tokenUsage?.output ?? null,
      $estimated_cost: message.tokenUsage?.estimatedCost ?? null,
      $resumable: opts?.resumable !== false ? 1 : 0,
      $executor_used: opts?.executorUsed ?? null,
      $context_envelope_hash: opts?.contextEnvelopeHash ?? null
    });
  }

  applyEvent(message: AutoforgeMessage): void {
    applyEventProjection(this.sqlite, message);
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  rebuildProjectionsFromEvents(): void {
    this.sqlite.exec("DELETE FROM review_findings; DELETE FROM subtasks; DELETE FROM tasks;");
    const events = this.sqlite
      .query("SELECT payload, id, task_id, project_id, timestamp, agent, event_type, status, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost FROM events ORDER BY timestamp ASC")
      .all() as Array<Record<string, unknown>>;

    for (const event of events) {
      const payload = JSON.parse(String(event.payload));
      this.applyEvent({
        id: String(event.id),
        taskId: String(event.task_id),
        projectId: String(event.project_id),
        timestamp: String(event.timestamp),
        agent: event.agent as AutoforgeMessage["agent"],
        type: String(event.event_type),
        status: event.status as AutoforgeMessage["status"],
        payload,
        budgetSeconds: Number(event.budget_seconds),
        elapsedSeconds: event.elapsed_seconds ? Number(event.elapsed_seconds) : undefined,
        tokenUsage:
          event.token_input !== null && event.token_output !== null && event.estimated_cost !== null
            ? {
                input: Number(event.token_input),
                output: Number(event.token_output),
                estimatedCost: Number(event.estimated_cost)
              }
            : undefined
      });
    }
  }

  listTasks(): PipelineTask[] {
    const rows = this.sqlite.query("SELECT * FROM tasks ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      description: String(row.description),
      state: row.state as TaskStage,
      tier: row.tier as Tier,
      assessment: JSON.parse(String(row.assessment)),
      planSubtasks: JSON.parse(String(row.plan)),
      iteration: Number(row.iteration),
      prUrl: row.pr_url ? String(row.pr_url) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  getTask(taskId: string): PipelineTask | null {
    const row = this.sqlite.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | null;
    if (row === null) {
      return null;
    }
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      description: String(row.description),
      state: row.state as TaskStage,
      tier: row.tier as Tier,
      assessment: JSON.parse(String(row.assessment)),
      planSubtasks: JSON.parse(String(row.plan)) as PlanSubtask[],
      iteration: Number(row.iteration),
      prUrl: row.pr_url ? String(row.pr_url) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  listFindings(taskId: string): ReviewFinding[] {
    const rows = this.sqlite.query("SELECT * FROM review_findings WHERE task_id = ? ORDER BY id").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      severity: row.severity as ReviewFinding["severity"],
      category: String(row.category),
      description: String(row.description),
      filePath: row.file_path ? String(row.file_path) : undefined,
      resolved: Number(row.resolved) === 1,
      resolvedInIteration: row.resolved_in_iteration !== null ? Number(row.resolved_in_iteration) : undefined
    }));
  }

  getActivePersona(agentType: AgentType): string | null {
    const row = this.sqlite
      .query("SELECT content FROM skill_versions WHERE skill_name = ? AND is_active = 1 LIMIT 1")
      .get(`persona:${agentType}`) as { content: string } | null;
    return row?.content ?? null;
  }

  /**
   * Upsert a prompt asset (persona or skill) into skill_versions by content hash.
   * If a row with the same skill_name and version (hash) already exists, return its id.
   * Otherwise insert a new row and mark it active (deactivating previous active rows).
   * Returns the id of the canonical row for this content.
   */
  upsertPromptAsset(skillName: string, content: string): string {
    const version = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const existing = this.sqlite
      .query("SELECT id FROM skill_versions WHERE skill_name = ? AND version = ? LIMIT 1")
      .get(skillName, version) as { id: string } | null;

    if (existing) return existing.id;

    const id = createHash("sha256").update(`${skillName}:${version}:${Date.now()}`).digest("hex").slice(0, 32);
    const now = new Date().toISOString();

    this.sqlite.transaction(() => {
      // Deactivate previous active versions for this asset.
      this.sqlite.query("UPDATE skill_versions SET is_active = 0 WHERE skill_name = ? AND is_active = 1").run(skillName);
      this.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
      ).run(id, skillName, version, content, now);
    })();

    return id;
  }

  getActivePersonaId(agentType: AgentType): string | null {
    const row = this.sqlite
      .query("SELECT id FROM skill_versions WHERE skill_name = ? AND is_active = 1 LIMIT 1")
      .get(`persona:${agentType}`) as { id: string } | null;
    return row?.id ?? null;
  }

  getActiveSkillId(skillName: string): string | null {
    const row = this.sqlite
      .query("SELECT id FROM skill_versions WHERE skill_name = ? AND is_active = 1 LIMIT 1")
      .get(skillName) as { id: string } | null;
    return row?.id ?? null;
  }

  /**
   * Create a new experiment row in proposed state.
   * Returns the new experiment id.
   */
  createExperiment(input: {
    hypothesis: string;
    skillModified: string;
    agentAffected: string;
    changeDescription: string;
    metricName: string;
    metricBefore: number;
  }): string {
    const id = createHash("sha256")
      .update(`${input.skillModified}:${input.hypothesis}:${Date.now()}`)
      .digest("hex")
      .slice(0, 32);
    this.sqlite.query(`
      INSERT INTO experiments (id, hypothesis, skill_modified, agent_affected, change_description, metric_name, metric_before, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')
    `).run(id, input.hypothesis, input.skillModified, input.agentAffected, input.changeDescription, input.metricName, input.metricBefore);
    return id;
  }

  /**
   * Activate a proposed skill version for a given asset, deactivating the previous active version.
   * Links the version to the experiment. Returns the version id.
   */
  activateProposedVersion(experimentId: string, skillName: string, content: string): string {
    const versionId = this.upsertPromptAsset(skillName, content);
    this.sqlite.query(
      "UPDATE skill_versions SET experiment_id = ? WHERE id = ?"
    ).run(experimentId, versionId);
    this.sqlite.query(
      "UPDATE experiments SET status = 'active' WHERE id = ?"
    ).run(experimentId);
    return versionId;
  }

  /**
   * Conclude an experiment: record metric_after and set status to keep or discard.
   * If discarding, reactivate the previous version for the asset.
   */
  concludeExperiment(experimentId: string, metricAfter: number, keep: boolean): void {
    const status = keep ? "keep" : "discard";
    const now = new Date().toISOString();
    this.sqlite.query(
      "UPDATE experiments SET metric_after = ?, status = ?, completed_at = ? WHERE id = ?"
    ).run(metricAfter, status, now, experimentId);

    if (!keep) {
      // Deactivate the experimental version and reactivate the most recent seed/kept version.
      const exp = this.sqlite.query(
        "SELECT skill_modified FROM experiments WHERE id = ?"
      ).get(experimentId) as { skill_modified: string } | null;

      if (exp) {
        const skillName = exp.skill_modified;
        // Deactivate the experimental version.
        this.sqlite.query(
          "UPDATE skill_versions SET is_active = 0 WHERE skill_name = ? AND experiment_id = ?"
        ).run(skillName, experimentId);
        // Reactivate the most recent non-experimental or kept version.
        const prev = this.sqlite.query(`
          SELECT id FROM skill_versions
          WHERE skill_name = ? AND (experiment_id IS NULL OR experiment_id IN (
            SELECT id FROM experiments WHERE skill_modified = ? AND status = 'keep'
          ))
          ORDER BY created_at DESC LIMIT 1
        `).get(skillName, skillName) as { id: string } | null;
        if (prev) {
          this.sqlite.query("UPDATE skill_versions SET is_active = 1 WHERE id = ?").run(prev.id);
        }
      }
    }
  }

  metricsForProject(projectId: string): Record<string, number> {
    const totals = this.sqlite
      .query(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed FROM tasks WHERE project_id = ?"
      )
      .get(projectId) as { total: number; completed: number | null };
    const findings = this.sqlite
      .query("SELECT COUNT(*) AS unresolved FROM review_findings WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?) AND resolved = 0")
      .get(projectId) as { unresolved: number };

    return {
      totalTasks: totals.total ?? 0,
      completedTasks: totals.completed ?? 0,
      unresolvedFindings: findings.unresolved ?? 0
    };
  }
}
