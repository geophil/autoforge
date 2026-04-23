import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { AutoforgeMessage } from "../nats/messages";
import type { AgentType, PipelineTask, PlanSubtask, ReviewFinding, TaskStage, Tier } from "../types/core";
import type { AgentTranscriptInput, AgentTranscriptMeta, AgentTranscriptRow } from "../types/transcripts";
import { applyEventProjection } from "./projections";

export class DbClient {
  readonly sqlite: Database;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath, { create: true });
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
  }

  initSchema(schemaPath: string, migrationsDir?: string): void {
    const schema = readFileSync(schemaPath, "utf8");
    this.sqlite.exec(schema);
    // Idempotent migration: add archived_at to tasks if it was not yet present
    // (handles existing databases created before this column was added to schema.sql).
    const taskCols = this.sqlite.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === "archived_at")) {
      this.sqlite.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
    }
    this.applyPendingMigrations(migrationsDir);
  }

  private applyPendingMigrations(migrationsDir?: string): void {
    if (!migrationsDir || !existsSync(migrationsDir)) {
      return;
    }

    const appliedMigrations = new Set(
      (this.sqlite.query("SELECT migration_file FROM schema_migrations").all() as Array<{ migration_file: string }>)
        .map((row) => row.migration_file)
    );

    const migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const migrationFile of migrationFiles) {
      if (appliedMigrations.has(migrationFile)) {
        continue;
      }

      this.applyMigrationFile(migrationsDir, migrationFile);
      appliedMigrations.add(migrationFile);
    }
  }

  private applyMigrationFile(migrationsDir: string, migrationFile: string): void {
    const sql = readFileSync(join(migrationsDir, migrationFile), "utf8");
    try {
      this.sqlite.transaction(() => {
        this.sqlite.exec(sql);
        this.sqlite
          .query("INSERT INTO schema_migrations (migration_file) VALUES (?)")
          .run(migrationFile);
      })();
      this.runPostMigrationHooks(migrationFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to apply migration ${migrationFile}: ${message}`, { cause: error });
    }
  }

  private runPostMigrationHooks(migrationFile: string): void {
    if (migrationFile !== "003_transcripts_variant.sql") {
      return;
    }

    const row = this.sqlite
      .query("SELECT COUNT(*) AS count FROM agent_transcripts WHERE persona_version_id IS NULL")
      .get() as { count: number };

    if (row.count > 0) {
      console.warn(
        `[${migrationFile}] ${row.count} agent_transcripts rows remain unmapped with NULL persona_version_id after backfill`
      );
    }
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

  insertTaskDiffStats(taskId: string, stats: {
    files_changed: number;
    files_added: number;
    files_modified: number;
    files_deleted: number;
    lines_added: number;
    lines_deleted: number;
    test_files_changed: number;
  }): void {
    this.sqlite.query(`
      INSERT OR REPLACE INTO task_diff_stats
        (task_id, files_changed, files_added, files_modified, files_deleted,
         lines_added, lines_deleted, test_files_changed)
      VALUES
        ($task_id, $files_changed, $files_added, $files_modified, $files_deleted,
         $lines_added, $lines_deleted, $test_files_changed)
    `).run({
      $task_id: taskId,
      $files_changed: stats.files_changed,
      $files_added: stats.files_added,
      $files_modified: stats.files_modified,
      $files_deleted: stats.files_deleted,
      $lines_added: stats.lines_added,
      $lines_deleted: stats.lines_deleted,
      $test_files_changed: stats.test_files_changed
    });
  }

  rebuildProjectionsFromEvents(): void {
    this.sqlite.transaction(() => {
      this.sqlite.exec("PRAGMA defer_foreign_keys = ON;");
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
    })();
  }

  insertTranscript(input: AgentTranscriptInput): string {
    const id = randomUUID();
    this.sqlite.query(`
      INSERT INTO agent_transcripts (
        id, task_id, stage, attempt, persona_version_id, created_at, executor_used, model,
        system_prompt, user_prompt, transcript, output, critique,
        token_input, token_output, elapsed_seconds
      ) VALUES (
        $id, $task_id, $stage, $attempt, $persona_version_id, $created_at, $executor_used, $model,
        $system_prompt, $user_prompt, $transcript, $output, $critique,
        $token_input, $token_output, $elapsed_seconds
      )
    `).run({
      $id: id,
      $task_id: input.taskId,
      $stage: input.stage,
      $attempt: input.attempt,
      $persona_version_id: input.personaVersionId,
      $created_at: new Date().toISOString(),
      $executor_used: input.executorUsed,
      $model: input.model,
      $system_prompt: input.systemPrompt,
      $user_prompt: input.userPrompt,
      $transcript: input.transcript,
      $output: input.output,
      $critique: input.critique,
      $token_input: input.tokenInput,
      $token_output: input.tokenOutput,
      $elapsed_seconds: input.elapsedSeconds
    });
    return id;
  }

  listTranscriptsByTask(taskId: string): AgentTranscriptMeta[] {
    const rows = this.sqlite.query(`
      SELECT id, task_id, stage, attempt, persona_version_id, created_at, executor_used, model,
             token_input, token_output, elapsed_seconds
      FROM agent_transcripts
      WHERE task_id = ?
      ORDER BY attempt ASC
    `).all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      stage: String(r.stage),
      attempt: Number(r.attempt),
      personaVersionId: r.persona_version_id === null ? null : String(r.persona_version_id),
      createdAt: String(r.created_at),
      executorUsed: String(r.executor_used),
      model: r.model === null ? null : String(r.model),
      tokenInput: r.token_input === null ? null : Number(r.token_input),
      tokenOutput: r.token_output === null ? null : Number(r.token_output),
      elapsedSeconds: r.elapsed_seconds === null ? null : Number(r.elapsed_seconds)
    }));
  }

  getTranscript(id: string): AgentTranscriptRow | null {
    const row = this.sqlite.query(
      "SELECT * FROM agent_transcripts WHERE id = ?"
    ).get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      stage: String(row.stage),
      attempt: Number(row.attempt),
      personaVersionId: row.persona_version_id === null ? null : String(row.persona_version_id),
      createdAt: String(row.created_at),
      executorUsed: String(row.executor_used),
      model: row.model === null ? null : String(row.model),
      systemPrompt: String(row.system_prompt),
      userPrompt: String(row.user_prompt),
      transcript: String(row.transcript),
      output: row.output === null ? null : String(row.output),
      critique: row.critique === null ? null : String(row.critique),
      tokenInput: row.token_input === null ? null : Number(row.token_input),
      tokenOutput: row.token_output === null ? null : Number(row.token_output),
      elapsedSeconds: row.elapsed_seconds === null ? null : Number(row.elapsed_seconds)
    };
  }

  listTasks(opts?: { includeArchived?: boolean; onlyArchived?: boolean }): PipelineTask[] {
    let whereClause = " WHERE archived_at IS NULL";
    if (opts?.onlyArchived) {
      whereClause = " WHERE archived_at IS NOT NULL";
    } else if (opts?.includeArchived) {
      whereClause = "";
    }
    const rows = this.sqlite.query(`SELECT * FROM tasks${whereClause} ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>;
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
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at ? String(row.archived_at) : undefined
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
      updatedAt: String(row.updated_at),
      archivedAt: row.archived_at ? String(row.archived_at) : undefined
    };
  }

  listEvents(taskId: string): Array<{
    id: string;
    type: string;
    agent: string;
    status: string;
    timestamp: string;
    elapsedSeconds: number | null;
    tokenUsage: { input: number; output: number } | null;
    failureCategory: string | null;
    failureReason: string | null;
    payload: Record<string, unknown>;
  }> {
    const rows = this.sqlite
      .query(
        "SELECT id, event_type, agent, status, timestamp, elapsed_seconds, token_input, token_output, payload FROM events WHERE task_id = ? ORDER BY timestamp ASC"
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(String(row.payload)); } catch { /* ignore */ }
      return {
        id: String(row.id),
        type: String(row.event_type),
        agent: String(row.agent),
        status: String(row.status),
        timestamp: String(row.timestamp),
        elapsedSeconds: row.elapsed_seconds !== null ? Number(row.elapsed_seconds) : null,
        tokenUsage:
          row.token_input !== null && row.token_output !== null
            ? { input: Number(row.token_input), output: Number(row.token_output) }
            : null,
        failureCategory: (payload.failure_category as string) ?? null,
        failureReason: (payload.failure_reason as string) ?? (payload.reason as string) ?? null,
        payload
      };
    });
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

  // Post-migration, status/traffic_share are authoritative. Runtime write paths use
  // `active` for the currently live row; `baseline` remains reserved for legacy backfill.
  private demoteLiveSkillVersions(skillName: string, excludeId?: string): void {
    if (excludeId) {
      this.sqlite.query(`
        UPDATE skill_versions
        SET status = 'demoted', traffic_share = 0.0
        WHERE skill_name = ?
          AND (status IN ('baseline', 'active') OR is_active = 1)
          AND id != ?
      `).run(skillName, excludeId);
      return;
    }

    this.sqlite.query(`
      UPDATE skill_versions
      SET status = 'demoted', traffic_share = 0.0
      WHERE skill_name = ?
        AND (status IN ('baseline', 'active') OR is_active = 1)
    `).run(skillName);
  }

  private promoteSkillVersion(id: string, liveStatus: "active" | "baseline" = "active"): void {
    this.sqlite
      .query("UPDATE skill_versions SET status = ?, traffic_share = 1.0 WHERE id = ?")
      .run(liveStatus, id);
  }

  /**
   * Upsert a prompt asset (persona or skill) into skill_versions by content hash.
   * If a row with the same skill_name and version (hash) already exists, return its id.
   * Otherwise insert a new row and mark it live (demoting previous live rows).
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
      this.demoteLiveSkillVersions(skillName);
      this.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share, created_at) VALUES (?, ?, ?, ?, 'active', 1.0, ?)"
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
    this.sqlite.transaction(() => {
      this.sqlite.query(
        "UPDATE skill_versions SET experiment_id = ? WHERE id = ?"
      ).run(experimentId, versionId);
      this.demoteLiveSkillVersions(skillName, versionId);
      this.promoteSkillVersion(versionId, "active");
      this.sqlite.query(
        "UPDATE experiments SET status = 'active' WHERE id = ?"
      ).run(experimentId);
    })();
    return versionId;
  }

  /**
   * Conclude an experiment: record metric_after and set status to keep or discard.
   * If discarding, reactivate the previous version for the asset.
   */
  concludeExperiment(experimentId: string, metricAfter: number, keep: boolean): void {
    const status = keep ? "keep" : "discard";
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
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
          this.sqlite.query(
            "UPDATE skill_versions SET status = 'demoted', traffic_share = 0.0 WHERE skill_name = ? AND experiment_id = ?"
          ).run(skillName, experimentId);
          const prev = this.sqlite.query(`
            SELECT id FROM skill_versions
            WHERE skill_name = ? AND (experiment_id IS NULL OR experiment_id IN (
              SELECT id FROM experiments WHERE skill_modified = ? AND status = 'keep'
            ))
            ORDER BY created_at DESC, id DESC LIMIT 1
          `).get(skillName, skillName) as { id: string } | null;
          if (prev) {
            this.demoteLiveSkillVersions(skillName, prev.id);
            this.promoteSkillVersion(prev.id, "active");
          } else {
            this.demoteLiveSkillVersions(skillName);
          }
        }
      }
    })();
  }

  archiveTask(taskId: string): void {
    const row = this.sqlite.query("SELECT id FROM tasks WHERE id = ?").get(taskId);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    this.sqlite.query("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, taskId);
  }

  unarchiveTask(taskId: string): void {
    const row = this.sqlite.query("SELECT id FROM tasks WHERE id = ?").get(taskId);
    if (!row) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    this.sqlite.query("UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?").run(now, taskId);
  }

  deleteTaskPermanently(taskId: string): void {
    const row = this.sqlite.query("SELECT id, archived_at FROM tasks WHERE id = ?").get(taskId) as { id: string; archived_at: string | null } | null;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    if (!row.archived_at) throw new Error(`Task must be archived before permanent deletion: ${taskId}`);
    this.sqlite.transaction(() => {
      this.sqlite.query("DELETE FROM subtasks WHERE task_id = ?").run(taskId);
      this.sqlite.query("DELETE FROM review_findings WHERE task_id = ?").run(taskId);
      this.sqlite.query("DELETE FROM events WHERE task_id = ?").run(taskId);
      this.sqlite.query("DELETE FROM agent_transcripts WHERE task_id = ?").run(taskId);
      this.sqlite.query("DELETE FROM routing_calibration WHERE task_id = ?").run(taskId);
      this.sqlite.query("DELETE FROM task_iteration_diffs WHERE task_id = ?").run(taskId);
      this.sqlite.query("DELETE FROM task_diff_stats WHERE task_id = ?").run(taskId);
      this.sqlite.query("DELETE FROM tasks WHERE id = ?").run(taskId);
    })();
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
