import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import type { AutoforgeMessage } from "../nats/messages";
import type { AgentType, PipelineTask, PlanSubtask, PlannerSpecArtifacts, PlanningContext, ReviewFinding, TaskStage, Tier } from "../types/core";
import { emptyPlanningContext } from "../types/core";
import type { AgentTranscriptInput, AgentTranscriptMeta, AgentTranscriptRow } from "../types/transcripts";
import { applyEventProjection } from "./projections";

function parseTaskJsonColumn<T>(row: Record<string, unknown>, column: string): T | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToPipelineTask(row: Record<string, unknown>): PipelineTask {
  const specArtifacts = parseTaskJsonColumn<PlannerSpecArtifacts>(row, "spec_artifacts");
  const planningContextRaw = parseTaskJsonColumn<PlanningContext>(row, "planning_context");
  const reviewRaw = row.review_plan;
  let reviewPlan: boolean | null | undefined;
  if (reviewRaw === null || reviewRaw === undefined) {
    reviewPlan = undefined;
  } else {
    reviewPlan = Number(reviewRaw) === 1;
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
    archivedAt: row.archived_at ? String(row.archived_at) : undefined,
    reviewPlan,
    specArtifacts: specArtifacts ?? null,
    planningContext: planningContextRaw ?? emptyPlanningContext(),
    currentBlockingQuestion:
      row.current_blocking_question === null || row.current_blocking_question === undefined
        ? null
        : String(row.current_blocking_question)
  };
}

export interface LessonInsert {
  agentType: string;
  lineageRootId: string;
  sourceTaskId: string;
  sourceVariantId: string;
  triggerPattern: string;
  failureCategory?: string | null;
  findingCategories?: string[] | null;
  body: string;
  outcomeKind: "corrective" | "reinforcing";
  retrievalKeywords?: string | null;
}

export interface LessonRow {
  id: string;
  agent_type: string;
  lineage_root_id: string;
  source_task_id: string;
  source_variant_id: string;
  trigger_pattern: string;
  failure_category: string | null;
  finding_categories: string | null;
  body: string;
  outcome_kind: "corrective" | "reinforcing";
  retrieval_keywords: string | null;
  status: "active" | "superseded" | "retired";
  superseded_by: string | null;
  created_at: string;
  retired_at: string | null;
}

export interface ForkProposalInsert {
  id: string;
  agentType: string;
  label: string;
  keywords: string;
  suggestedSpecialty: string;
  representativeTaskIds: string[];
  baselineScoreMean: number;
  populationScoreMean: number;
  scoreGap: number;
  recommendationStrength: "weak" | "moderate" | "strong";
}

export interface ForkProposalRow {
  id: string;
  agent_type: string;
  generated_at: string;
  generator: string;
  label: string;
  keywords: string;
  suggested_specialty: string;
  representative_task_ids: string;
  baseline_score_mean: number;
  population_score_mean: number;
  score_gap: number;
  recommendation_strength: "weak" | "moderate" | "strong";
  status: "open" | "acted_on" | "stale" | "dismissed";
  acted_on_experiment_id: string | null;
  closed_at: string | null;
}

export interface TrafficAllocatedEventInput {
  variantId: string;
  agentType: string;
  oldStatus: string | null;
  newStatus: string;
  oldTrafficShare: number | null;
  newTrafficShare: number;
  reason: string;
  supportingMetric?: Record<string, unknown>;
}

export interface DispatchVariantRow {
  id: string;
  skill_name: string;
  content: string;
  status: "baseline" | "active" | "candidate";
  traffic_share: number;
  parent_version_id: string | null;
  specialty: string | null;
  specialty_embedding: Buffer | null;
  created_at: string;
}

export interface ShadowPair {
  id: string;
  taskId: string;
  timestamp: string;
  status: string;
  payload: Record<string, unknown>;
  baselineVariantId: string | null;
  candidateVariantId: string;
  baselineComposite: number | null;
  candidateComposite: number | null;
  baselineScoreComponents: Record<string, unknown> | null;
  candidateScoreComponents: Record<string, unknown> | null;
  error: string | null;
}

export interface VariantScore {
  taskId: string;
  projectId: string;
  tier: string;
  createdAt: string;
  selectedAt: string;
  composite: number;
}

/** Defensive cap for resolveLineageRoot — chains deeper than this almost certainly
 *  indicate corrupt data. Paired with a visited-set for cycle detection. */
const MAX_LINEAGE_DEPTH = 50;

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

  appendTrafficAllocatedEvent(input: TrafficAllocatedEventInput): void {
    const payload: Record<string, unknown> = {
      variant_id: input.variantId,
      agent_type: input.agentType,
      old_status: input.oldStatus,
      new_status: input.newStatus,
      old_traffic_share: input.oldTrafficShare,
      new_traffic_share: input.newTrafficShare,
      reason: input.reason,
      __analytics_only: true
    };
    if (input.supportingMetric !== undefined) {
      payload.supporting_metric = input.supportingMetric;
    }

    this.appendEvent({
      id: randomUUID(),
      taskId: input.variantId,
      projectId: "allocation",
      timestamp: new Date().toISOString(),
      agent: "orchestrator",
      type: "traffic_allocated",
      status: "done",
      payload,
      budgetSeconds: 0
    });
  }

  applyEvent(message: AutoforgeMessage): void {
    const payload = message.payload as Record<string, unknown> | undefined;
    if (payload?.__analytics_only === true) {
      return;
    }
    applyEventProjection(this.sqlite, message);
  }

  transaction<T>(fn: () => T): T {
    return this.sqlite.transaction(fn)();
  }

  insertForkProposal(input: ForkProposalInsert): boolean {
    const result = this.sqlite.query(`
      INSERT INTO fork_proposals
        (id, agent_type, label, keywords, suggested_specialty, representative_task_ids,
         baseline_score_mean, population_score_mean, score_gap, recommendation_strength)
      VALUES
        ($id, $agent_type, $label, $keywords, $suggested_specialty, $representative_task_ids,
         $baseline_score_mean, $population_score_mean, $score_gap, $recommendation_strength)
      ON CONFLICT(id) DO NOTHING
    `).run({
      $id: input.id,
      $agent_type: input.agentType,
      $label: input.label,
      $keywords: input.keywords,
      $suggested_specialty: input.suggestedSpecialty,
      $representative_task_ids: JSON.stringify(input.representativeTaskIds),
      $baseline_score_mean: input.baselineScoreMean,
      $population_score_mean: input.populationScoreMean,
      $score_gap: input.scoreGap,
      $recommendation_strength: input.recommendationStrength
    });
    return result.changes === 1;
  }

  listOpenForkProposals(agentType?: string): ForkProposalRow[] {
    if (agentType) {
      return this.sqlite.query(`
        SELECT * FROM fork_proposals
         WHERE status = 'open' AND agent_type = ?
         ORDER BY generated_at DESC, id ASC
      `).all(agentType) as ForkProposalRow[];
    }
    return this.sqlite.query(`
      SELECT * FROM fork_proposals
       WHERE status = 'open'
       ORDER BY generated_at DESC, id ASC
    `).all() as ForkProposalRow[];
  }

  getForkProposal(id: string): ForkProposalRow | null {
    const row = this.sqlite.query("SELECT * FROM fork_proposals WHERE id = ?").get(id) as ForkProposalRow | undefined;
    return row ?? null;
  }

  markForkProposalActedOn(proposalId: string, experimentId: string): boolean {
    const result = this.sqlite.query(`
      UPDATE fork_proposals
         SET status = 'acted_on', acted_on_experiment_id = ?, closed_at = datetime('now')
       WHERE id = ? AND status = 'open'
    `).run(experimentId, proposalId);
    return result.changes === 1;
  }

  markStaleForkProposals(daysOld: number): number {
    const result = this.sqlite.query(`
      UPDATE fork_proposals
         SET status = 'stale', closed_at = datetime('now')
       WHERE status = 'open'
         AND generated_at < datetime('now', '-' || ? || ' days')
    `).run(daysOld);
    return result.changes;
  }

  isFirstForkForLineage(parentVariantId: string): boolean {
    const lineageRootId = this.resolveLineageRoot(parentVariantId) ?? parentVariantId;
    const row = this.sqlite.query(`
      WITH RECURSIVE lineage(id) AS (
        SELECT id
          FROM skill_versions
         WHERE id = ?
        UNION ALL
        SELECT child.id
          FROM skill_versions child
          JOIN lineage parent ON child.parent_version_id = parent.id
      )
      SELECT COUNT(*) AS n
        FROM skill_versions sv
        JOIN lineage ON lineage.id = sv.id
       WHERE sv.id != ?
         AND sv.specialty IS NOT NULL
         AND sv.status IN ('baseline', 'active')
    `).get(lineageRootId, lineageRootId) as { n: number };
    return row.n === 0;
  }

  loadDiagnosticTaskHistory(agentType: string, limit: number): Array<Record<string, unknown>> {
    return this.sqlite.query(`
      WITH latest_variant_selected AS (
        SELECT task_id, payload
        FROM (
          SELECT
            e.task_id,
            e.payload,
            ROW_NUMBER() OVER (
              PARTITION BY e.task_id
              ORDER BY e.timestamp DESC, e.rowid DESC
            ) AS rn
          FROM events e
          WHERE e.event_type = 'variant_selected'
            AND json_extract(e.payload, '$.agent_type') = ?
        )
        WHERE rn = 1
      )
      SELECT
        t.id AS task_id,
        t.description,
        t.tier,
        t.project_id,
        t.state,
        tqs.r_correctness,
        tqs.r_simplicity,
        tqs.r_alignment,
        tqs.r_fidelity,
        tqs.r_efficiency,
        tds.lines_added,
        tds.lines_deleted,
        e.payload AS selection_payload,
        COALESCE((
          SELECT json_group_array(json_object('category', rf.category, 'severity', rf.severity))
          FROM review_findings rf
          WHERE rf.task_id = t.id
        ), '[]') AS review_findings,
        (
          SELECT fa.payload
          FROM events fa
          WHERE fa.task_id = t.id
            AND fa.event_type = 'failure_analysis'
          ORDER BY fa.timestamp DESC, fa.rowid DESC
          LIMIT 1
        ) AS failure_analysis_payload
      FROM latest_variant_selected e
      JOIN tasks t ON t.id = e.task_id
      LEFT JOIN task_quality_score tqs ON tqs.task_id = t.id
      LEFT JOIN task_diff_stats tds ON tds.task_id = t.id
      WHERE t.state IN ('completed', 'failed')
      ORDER BY t.updated_at DESC
      LIMIT ?
    `).all(agentType, limit) as Array<Record<string, unknown>>;
  }

  updateSpecialtyEmbedding(variantId: string, embedding: Buffer): void {
    this.sqlite.query("UPDATE skill_versions SET specialty_embedding = ? WHERE id = ?").run(embedding, variantId);
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

  insertTaskIterationDiff(taskId: string, fromIter: number, toIter: number, stats: {
    files_changed: number;
    lines_added: number;
    lines_deleted: number;
    test_files_changed: number;
    diff_summary: string | null;
  }): void {
    this.sqlite.query(`
      INSERT OR REPLACE INTO task_iteration_diffs
        (task_id, from_iteration, to_iteration, files_changed, lines_added,
         lines_deleted, test_files_changed, diff_summary)
      VALUES
        ($task_id, $from_iter, $to_iter, $files_changed, $lines_added,
         $lines_deleted, $test_files_changed, $diff_summary)
    `).run({
      $task_id: taskId,
      $from_iter: fromIter,
      $to_iter: toIter,
      $files_changed: stats.files_changed,
      $lines_added: stats.lines_added,
      $lines_deleted: stats.lines_deleted,
      $test_files_changed: stats.test_files_changed,
      $diff_summary: stats.diff_summary
    });
  }

  insertLesson(input: LessonInsert): string {
    const id = randomUUID();
    this.sqlite.query(`
      INSERT INTO lessons
        (id, agent_type, lineage_root_id, source_task_id, source_variant_id,
         trigger_pattern, failure_category, finding_categories, body,
         outcome_kind, retrieval_keywords)
      VALUES
        ($id, $agent_type, $lineage_root_id, $source_task_id, $source_variant_id,
         $trigger_pattern, $failure_category, $finding_categories, $body,
         $outcome_kind, $retrieval_keywords)
    `).run({
      $id: id,
      $agent_type: input.agentType,
      $lineage_root_id: input.lineageRootId,
      $source_task_id: input.sourceTaskId,
      $source_variant_id: input.sourceVariantId,
      $trigger_pattern: input.triggerPattern,
      $failure_category: input.failureCategory ?? null,
      $finding_categories: input.findingCategories
        ? JSON.stringify(input.findingCategories)
        : null,
      $body: input.body,
      $outcome_kind: input.outcomeKind,
      $retrieval_keywords: input.retrievalKeywords ?? null
    });
    return id;
  }

  resolveLineageRoot(variantId: string): string | null {
    // Walk parent_version_id chain. Cycle-safe via a visited set with a depth cap.
    const seen = new Set<string>();
    let current: string | null = variantId;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH && current !== null; depth++) {
      if (seen.has(current)) {
        return current;
      }
      seen.add(current);
      const row = this.sqlite
        .query("SELECT parent_version_id FROM skill_versions WHERE id = ?")
        .get(current) as { parent_version_id: string | null } | undefined;
      if (!row) return depth === 0 ? null : current;
      if (row.parent_version_id === null) return current;
      current = row.parent_version_id;
    }
    return current;
  }

  retrieveActiveLessonsByLineage(
    lineageRootId: string,
    agentType: string,
    limit = 20
  ): LessonRow[] {
    return this.sqlite.query(`
      SELECT * FROM lessons
      WHERE lineage_root_id = $lineage_root_id
        AND agent_type = $agent_type
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT $limit
    `).all({
      $lineage_root_id: lineageRootId,
      $agent_type: agentType,
      $limit: limit
    }) as LessonRow[];
  }

  loadDispatchPopulation(agentType: AgentType): DispatchVariantRow[] {
    return this.sqlite.query(`
      SELECT id, skill_name, content, status, traffic_share, parent_version_id, specialty, specialty_embedding, created_at
        FROM skill_versions
       WHERE skill_name = ?
         AND status IN ('baseline', 'active', 'candidate')
       ORDER BY created_at ASC, id ASC
    `).all(`persona:${agentType}`) as DispatchVariantRow[];
  }

  loadShadowPairs(candidateId: string): ShadowPair[] {
    const rows = this.sqlite
      .query(`
        SELECT id, task_id, timestamp, status, payload
          FROM events
         WHERE event_type = 'shadow_run_completed'
         ORDER BY timestamp ASC, rowid ASC
      `)
      .all() as Array<{ id: string; task_id: string; timestamp: string; status: string; payload: string }>;

    const pairs: ShadowPair[] = [];
    for (const row of rows) {
      let parsedPayload: unknown;
      try {
        parsedPayload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const payload = recordOrNull(parsedPayload);
      if (!payload) {
        continue;
      }
      if (payload.candidate_variant_id !== candidateId) {
        continue;
      }

      pairs.push({
        id: row.id,
        taskId: row.task_id,
        timestamp: row.timestamp,
        status: row.status,
        payload,
        baselineVariantId: stringOrNull(payload.baseline_variant_id),
        candidateVariantId: candidateId,
        baselineComposite: finiteNumberOrNull(payload.baseline_composite),
        candidateComposite: finiteNumberOrNull(payload.candidate_composite),
        baselineScoreComponents: recordOrNull(payload.baseline_score_components),
        candidateScoreComponents: recordOrNull(payload.candidate_score_components),
        error: stringOrNull(payload.error)
      });
    }
    return pairs;
  }

  loadRecentShadowRuns(candidateId: string, window: { limit: number }): ShadowPair[] {
    const rows = this.sqlite
      .query(`
        SELECT id, task_id, timestamp, status, payload
          FROM events
         WHERE event_type = 'shadow_run_completed'
           AND json_valid(payload)
           AND json_extract(payload, '$.candidate_variant_id') = $candidate_id
         ORDER BY timestamp DESC, rowid DESC
         LIMIT $limit
      `)
      .all({
        $candidate_id: candidateId,
        $limit: Math.max(0, Math.floor(window.limit))
      }) as Array<{ id: string; task_id: string; timestamp: string; status: string; payload: string }>;

    const runs: ShadowPair[] = [];
    for (const row of rows) {
      const payload = recordOrNull(JSON.parse(row.payload));
      if (!payload) {
        continue;
      }
      runs.push({
        id: row.id,
        taskId: row.task_id,
        timestamp: row.timestamp,
        status: row.status,
        payload,
        baselineVariantId: stringOrNull(payload.baseline_variant_id),
        candidateVariantId: candidateId,
        baselineComposite: finiteNumberOrNull(payload.baseline_composite),
        candidateComposite: finiteNumberOrNull(payload.candidate_composite),
        baselineScoreComponents: recordOrNull(payload.baseline_score_components),
        candidateScoreComponents: recordOrNull(payload.candidate_score_components),
        error: stringOrNull(payload.error)
      });
    }
    return runs;
  }

  loadRecentTaskScores(variantId: string, window: { limit: number; maxAgeDays: number }): VariantScore[] {
    return this.loadRecentTaskScoresForRationales(variantId, window, ["exploitation", "exploration"]);
  }

  loadRecentSelectedTaskScores(variantId: string, window: { limit: number; maxAgeDays: number }): VariantScore[] {
    return this.loadRecentTaskScoresForRationales(variantId, window, ["baseline", "only_eligible", "exploitation", "exploration"]);
  }

  loadRecentCompositeScoresForVariant(variantId: string, limit: number): number[] {
    return this.loadRecentSelectedTaskScores(variantId, { limit, maxAgeDays: 60 })
      .map((score) => score.composite);
  }

  loadRecentBaselineTaskScores(variantId: string, window: { limit: number; maxAgeDays: number }): VariantScore[] {
    return this.loadRecentTaskScoresForRationales(variantId, window, ["baseline", "only_eligible"]);
  }

  private loadRecentTaskScoresForRationales(
    variantId: string,
    window: { limit: number; maxAgeDays: number },
    rationales: string[]
  ): VariantScore[] {
    const cutoff = new Date(Date.now() - window.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const rationalePlaceholders = rationales.map((_, index) => `$rationale_${index}`).join(", ");
    const params: Record<string, string | number> = {
      $variant_id: variantId,
      $cutoff: cutoff,
      $limit: Math.max(0, Math.floor(window.limit))
    };
    rationales.forEach((rationale, index) => {
      params[`$rationale_${index}`] = rationale;
    });
    const rows = this.sqlite
      .query(`
        SELECT
          tqs.task_id AS taskId,
          tqs.project_id AS projectId,
          tqs.tier AS tier,
          tqs.created_at AS createdAt,
          MAX(e.timestamp) AS selectedAt,
          (
            tqs.r_correctness
            + tqs.r_simplicity
            + tqs.r_alignment
            + tqs.r_fidelity
            + tqs.r_efficiency
          ) / 5.0 AS composite
        FROM task_quality_score tqs
        JOIN events e ON e.task_id = tqs.task_id
        WHERE e.event_type = 'variant_selected'
          AND json_valid(e.payload)
          AND json_extract(e.payload, '$.selected_variant_id') = $variant_id
          AND json_extract(e.payload, '$.selection_rationale') IN (${rationalePlaceholders})
          AND tqs.created_at >= $cutoff
        GROUP BY tqs.task_id
        ORDER BY selectedAt DESC, tqs.created_at DESC, tqs.task_id ASC
        LIMIT $limit
      `)
      .all(params) as Array<{
        taskId: string;
        projectId: string;
        tier: string;
        createdAt: string;
        selectedAt: string;
        composite: number;
      }>;

    return rows
      .filter((row) => Number.isFinite(row.composite))
      .map((row) => ({
        taskId: row.taskId,
        projectId: row.projectId,
        tier: row.tier,
        createdAt: row.createdAt,
        selectedAt: row.selectedAt,
        composite: row.composite
      }));
  }

  supersedeLessons(oldIds: string[], newLessonId: string): { transitioned: string[]; rejected: string[] } {
    if (oldIds.length === 0) return { transitioned: [], rejected: [] };
    const replacement = this.sqlite
      .query("SELECT agent_type, lineage_root_id FROM lessons WHERE id = ?")
      .get(newLessonId) as { agent_type: string; lineage_root_id: string } | null;
    if (!replacement) return { transitioned: [], rejected: oldIds };
    const transitioned: string[] = [];
    const rejected: string[] = [];
    const stmt = this.sqlite.query(`
      UPDATE lessons
         SET status = 'superseded',
             superseded_by = $new_id,
             retired_at = datetime('now')
       WHERE id = $id
         AND status = 'active'
         AND agent_type = $agent_type
         AND lineage_root_id = $lineage_root_id
    `);
    this.sqlite.transaction(() => {
      for (const id of oldIds) {
        const info = stmt.run({
          $new_id: newLessonId,
          $id: id,
          $agent_type: replacement.agent_type,
          $lineage_root_id: replacement.lineage_root_id
        });
        if (info.changes === 1) transitioned.push(id);
        else rejected.push(id);
      }
    })();
    return { transitioned, rejected };
  }

  updateTrafficShare(variantId: string, trafficShare: number): void {
    this.sqlite.query(
      "UPDATE skill_versions SET traffic_share = ? WHERE id = ?"
    ).run(trafficShare, variantId);
  }

  retireVariant(variantId: string): void {
    this.sqlite.query(
      "UPDATE skill_versions SET status = 'retired', traffic_share = 0.0 WHERE id = ?"
    ).run(variantId);
  }

  /**
   * Insert an experiment row created by a curator meta operation.
   *
   * Schema reconciliations applied vs. the Spec B plan sketch:
   *   - `experiments` has no `task_id` column; the originating meta task id is
   *     stashed into the `evidence` JSON blob under `meta_task_id` so
   *     provenance survives.
   *   - `metric_name` and `metric_before` are NOT NULL; when the caller has no
   *     concrete metric yet we default to the canonical composite
   *     `task_quality_score` and a before-value of 0 (Spec A §6).
   */
  insertMetaOperationExperiment(params: {
    experimentId: string;
    metaTaskId: string;
    operation: string;
    hypothesis: string;
    changeDescription: string;
    metricName?: string;
    metricBefore?: number;
    evidence: Record<string, unknown>;
    status: "active" | "proposed";
    proposedContent?: string | null;
  }): void {
    this.sqlite.query(`
      INSERT INTO experiments
        (id, hypothesis, change_description, metric_name, metric_before,
         operation, evidence, status, proposed_content)
      VALUES
        ($id, $hypothesis, $change, $metric_name, $metric_before,
         $operation, $evidence, $status, $proposed_content)
    `).run({
      $id: params.experimentId,
      $hypothesis: params.hypothesis,
      $change: params.changeDescription,
      $metric_name: params.metricName ?? "task_quality_score",
      $metric_before: params.metricBefore ?? 0,
      $operation: params.operation,
      $evidence: JSON.stringify({ ...params.evidence, meta_task_id: params.metaTaskId }),
      $status: params.status,
      $proposed_content: params.proposedContent ?? null
    });
  }

  countBaselinesForSkillName(skillName: string): number {
    const row = this.sqlite
      .query("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_name = ? AND status = 'baseline'")
      .get(skillName) as { n: number };
    return row.n;
  }

  getSkillVersionById(id: string): {
    id: string;
    skill_name: string;
    status: string;
    traffic_share: number;
    parent_version_id: string | null;
  } | null {
    const row = this.sqlite
      .query("SELECT id, skill_name, status, traffic_share, parent_version_id FROM skill_versions WHERE id = ?")
      .get(id) as {
        id: string;
        skill_name: string;
        status: string;
        traffic_share: number;
        parent_version_id: string | null;
      } | undefined;
    return row ?? null;
  }

  retireLessons(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const transitioned: string[] = [];
    const stmt = this.sqlite.query(`
      UPDATE lessons
         SET status = 'retired',
             retired_at = datetime('now')
       WHERE id = $id AND status = 'active'
    `);
    this.sqlite.transaction(() => {
      for (const id of ids) {
        const info = stmt.run({ $id: id });
        if (info.changes === 1) transitioned.push(id);
      }
    })();
    return transitioned;
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
        token_input, token_output, elapsed_seconds, rollback_event_id
      ) VALUES (
        $id, $task_id, $stage, $attempt, $persona_version_id, $created_at, $executor_used, $model,
        $system_prompt, $user_prompt, $transcript, $output, $critique,
        $token_input, $token_output, $elapsed_seconds, $rollback_event_id
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
      $elapsed_seconds: input.elapsedSeconds,
      $rollback_event_id: input.rollbackEventId ?? null
    });
    return id;
  }

  listTranscriptsByTask(taskId: string): AgentTranscriptMeta[] {
    // ORDER BY created_at, rowid — created_at has only millisecond resolution
    // so two transcripts inserted in the same millisecond can compare equal;
    // rowid is SQLite's monotonic insertion order and provides a deterministic
    // tie-break that matches the order the orchestrator actually persisted them.
    const rows = this.sqlite.query(`
      SELECT id, task_id, stage, attempt, persona_version_id, created_at, executor_used, model,
             token_input, token_output, elapsed_seconds, rollback_event_id
      FROM agent_transcripts
      WHERE task_id = ?
      ORDER BY created_at ASC, rowid ASC
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
      elapsedSeconds: r.elapsed_seconds === null ? null : Number(r.elapsed_seconds),
      rollbackEventId: r.rollback_event_id === null || r.rollback_event_id === undefined ? null : String(r.rollback_event_id)
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
      elapsedSeconds: row.elapsed_seconds === null ? null : Number(row.elapsed_seconds),
      rollbackEventId:
        row.rollback_event_id === null || row.rollback_event_id === undefined
          ? null
          : String(row.rollback_event_id)
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
    return rows.map((row) => rowToPipelineTask(row as Record<string, unknown>));
  }

  getTask(taskId: string): PipelineTask | null {
    const row = this.sqlite.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | null;
    if (row === null) {
      return null;
    }
    return rowToPipelineTask(row as Record<string, unknown>);
  }

  listEvents(taskId: string): Array<{
    id: string;
    type: string;
    agent: string;
    status: string;
    timestamp: string;
    elapsedSeconds: number | null;
    tokenUsage: { input: number; output: number } | null;
    estimatedCost: number | null;
    failureCategory: string | null;
    failureReason: string | null;
    payload: Record<string, unknown>;
  }> {
    const rows = this.sqlite
      .query(
        "SELECT id, event_type, agent, status, timestamp, elapsed_seconds, token_input, token_output, estimated_cost, payload FROM events WHERE task_id = ? ORDER BY timestamp ASC"
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
        estimatedCost: row.estimated_cost !== null ? Number(row.estimated_cost) : null,
        failureCategory: (payload.failure_category as string) ?? null,
        failureReason: (payload.failure_reason as string) ?? (payload.reason as string) ?? null,
        payload
      };
    });
  }

  /**
   * Returns the most recent agent-attributed provenance for a task by scanning
   * its event log in reverse chronological order. Spec A review follow-up Mi1:
   * cancelTask / rejectTask / sweepStaleTasks emit failure_analysis after the
   * task is in a non-agent state (awaiting_approval, stalled, etc.); the
   * provenance of the LAST real agent run is still the most informative for
   * the reflector and future meta analysis.
   *
   * Returns null when no event in the task's history carries the fields.
   */
  getLastAgentProvenance(taskId: string): {
    executorUsed: string | null;
    personaVersionId: string | null;
    skillVersionIds: string[];
  } | null {
    const rows = this.sqlite.query(
      `SELECT payload FROM events
        WHERE task_id = ?
          AND agent IN ('planner', 'coder', 'reviewer', 'doc')
        ORDER BY timestamp DESC`
    ).all(taskId) as Array<{ payload: string }>;
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(row.payload); } catch { /* ignore */ }
      const personaVersionId = (payload.persona_version_id as string | undefined) ?? null;
      const executorUsed = (payload.executor_used as string | undefined) ?? null;
      const skillVersionIds = Array.isArray(payload.skill_version_ids)
        ? (payload.skill_version_ids as string[])
        : [];
      if (personaVersionId !== null || executorUsed !== null || skillVersionIds.length > 0) {
        return { executorUsed, personaVersionId, skillVersionIds };
      }
    }
    return null;
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
    const lessonCount = (this.sqlite
      .query("SELECT COUNT(*) AS count FROM lessons WHERE source_task_id = ?")
      .get(taskId) as { count: number }).count;
    if (lessonCount > 0) {
      throw new Error(`Cannot permanently delete task ${taskId}: ${lessonCount} lesson(s) reference it`);
    }
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

  envelopeHashStats(projectId: string, contextEnvelopeHash: string): {
    occurrences: number;
    lastTokenInput: number | null;
  } {
    const row = this.sqlite.query(`
      SELECT
        COUNT(*) AS occurrences,
        (
          SELECT token_input
          FROM events
          WHERE project_id = $project_id
            AND context_envelope_hash = $context_envelope_hash
            AND token_input IS NOT NULL
          ORDER BY timestamp DESC, rowid DESC
          LIMIT 1
        ) AS last_token_input
      FROM events
      WHERE project_id = $project_id
        AND context_envelope_hash = $context_envelope_hash
    `).get({
      $project_id: projectId,
      $context_envelope_hash: contextEnvelopeHash
    }) as { occurrences: number; last_token_input: number | null };
    return {
      occurrences: row.occurrences ?? 0,
      lastTokenInput: row.last_token_input ?? null
    };
  }
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
