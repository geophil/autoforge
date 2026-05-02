import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { DbClient } from "../db/client";
import type { AutoforgeMessage } from "../nats/messages";
import { adjustVariantAllocation } from "./allocation";
import type { MetaOperation } from "../schemas/meta-output";
import { kolmogorovSmirnovTwoSample } from "./sequential-test";

const MAX_TRAFFIC_SHARE = 1.0;

function agentTypeForSkillName(skillName: string): string {
  return skillName.startsWith("persona:")
    ? skillName.slice("persona:".length)
    : skillName;
}

export interface MetaOperationContext {
  db: DbClient;
  recordEvent?: (input: {
    taskId: string;
    projectId: string;
    agent: AutoforgeMessage["agent"];
    type: string;
    status: AutoforgeMessage["status"];
    payload: Record<string, unknown>;
    budgetSeconds: number;
    elapsedSeconds?: number;
    analyticsOnly?: boolean;
  }) => void;
  operation: MetaOperation;
  metaTaskId: string;
  worktreePath: string;
  projectId: string;
}

export interface MetaOperationResult {
  ok: boolean;
  experimentId?: string;
  candidateVariantId?: string;
  reason?: string;
}

export function handleMetaOperation(ctx: MetaOperationContext): MetaOperationResult {
  switch (ctx.operation.kind) {
    case "edit":    return handleEdit(ctx);
    case "fork":    return handleFork(ctx);
    case "merge":   return handleMerge(ctx);
    case "promote": return handleShareAdjust(ctx, "promote");
    case "demote":  return handleShareAdjust(ctx, "demote");
    case "retire":  return handleRetire(ctx);
  }
}

function recordMetaEvent(
  ctx: MetaOperationContext,
  input: {
    taskId: string;
    projectId: string;
    agent: AutoforgeMessage["agent"];
    type: string;
    status: AutoforgeMessage["status"];
    payload: Record<string, unknown>;
    budgetSeconds: number;
    elapsedSeconds?: number;
    analyticsOnly?: boolean;
  }
): void {
  if (ctx.recordEvent) {
    ctx.recordEvent(input);
    return;
  }

  const payload = input.analyticsOnly
    ? { ...input.payload, __analytics_only: true }
    : input.payload;

  const message: AutoforgeMessage = {
    id: randomUUID(),
    taskId: input.taskId,
    projectId: input.projectId,
    timestamp: new Date().toISOString(),
    agent: input.agent,
    type: input.type,
    status: input.status,
    payload,
    budgetSeconds: input.budgetSeconds,
    elapsedSeconds: input.elapsedSeconds
  };

  ctx.db.transaction(() => {
    ctx.db.appendEvent(message);
    if (!input.analyticsOnly) {
      ctx.db.applyEvent(message);
    }
  });
}

function readProposedContent(worktreePath: string, fileName: string): string | null {
  // Reject anything that's not already a basename (no slashes, no '..').
  // `proposed_content_file` originates from the meta persona's status JSON,
  // so treat it as adversarial — prevent path traversal / absolute escapes.
  const safe = basename(fileName);
  if (safe !== fileName || safe.length === 0) return null;

  const resolvedWorktree = resolve(worktreePath);
  const p = resolve(resolvedWorktree, safe);
  const rel = relative(resolvedWorktree, p);
  if (rel === "" || rel.startsWith("..") || rel.includes("/")) return null;

  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

interface RetireLessonValidation {
  ok: boolean;
  ids: string[];
  reason?: string;
}

interface MergeVariantRow {
  id: string;
  skill_name: string;
  status: string;
  traffic_share: number;
  parent_version_id: string | null;
  specialty: string | null;
  content: string;
  created_at: string;
}

function validateRetireLessons(ctx: MetaOperationContext, lineageVariantId: string): RetireLessonValidation {
  const ids = (ctx.operation.retire_lessons ?? []).map((e) => e.id);
  if (ids.length === 0) return { ok: true, ids };

  const expectedLineageRoot = ctx.db.resolveLineageRoot(lineageVariantId) ?? lineageVariantId;
  for (const id of ids) {
    const row = ctx.db.sqlite
      .query("SELECT id, status, lineage_root_id FROM lessons WHERE id = ?")
      .get(id) as { id: string; status: string; lineage_root_id: string } | null;
    if (!row) {
      return { ok: false, ids, reason: `lesson_not_found:${id}` };
    }
    if (row.status !== "active") {
      return { ok: false, ids, reason: `lesson_not_active:${id}` };
    }
    if (row.lineage_root_id !== expectedLineageRoot) {
      return { ok: false, ids, reason: `lesson_lineage_mismatch:${id}` };
    }
  }

  return { ok: true, ids };
}

function applyRetireLessons(ctx: MetaOperationContext, ids: string[]): string[] {
  return ctx.db.retireLessons(ids);
}

function pendingRetireLessonIds(ids: string[]): string[] {
  return ids;
}

export function mergeSpecialtyText(a: string | null | undefined, b: string | null | undefined): string {
  const parts = [a, b]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const uniqueParts = [...new Set(parts)];
  const merged = uniqueParts.length === 0 ? "merged variant" : uniqueParts.join(" + ");
  return merged.length <= 150 ? merged : merged.slice(0, 147).trimEnd() + "...";
}

function handleEdit(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "edit" }>;
  const target = ctx.db.getSkillVersionById(op.target_variant_id);
  if (!target) return { ok: false, reason: "target_not_found" };
  const retireLessons = validateRetireLessons(ctx, target.id);
  if (!retireLessons.ok) return { ok: false, reason: retireLessons.reason };

  const content = readProposedContent(ctx.worktreePath, op.proposed_content_file);
  if (!content || content.trim().length === 0) {
    return { ok: false, reason: "proposed_content_empty" };
  }

  const experimentId = randomUUID();
  const candidateId = randomUUID();

  ctx.db.transaction(() => {
    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "edit",
      hypothesis: op.hypothesis,
      changeDescription: op.hypothesis,
      metricName: op.evidence.metric_name,
      metricBefore: op.evidence.metric_before,
      evidence: { ...op.evidence, retired_lessons: applyRetireLessons(ctx, retireLessons.ids) },
      status: "active",
      proposedContent: content
    });

    ctx.db.sqlite.query(`
      INSERT INTO skill_versions
        (id, skill_name, version, content, experiment_id,
         parent_version_id, specialty, status, traffic_share)
      VALUES
        ($id, $skill, $version, $content, $exp,
         $parent, NULL, 'candidate', 0.0)
    `).run({
      $id: candidateId,
      $skill: target.skill_name,
      $version: String(Date.now()),
      $content: content,
      $exp: experimentId,
      $parent: target.id
    });
  });

  return { ok: true, experimentId, candidateVariantId: candidateId };
}

function handleFork(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "fork" }>;
  const parent = ctx.db.getSkillVersionById(op.parent_variant_id);
  if (!parent) return { ok: false, reason: "parent_not_found" };
  const retireLessons = validateRetireLessons(ctx, parent.id);
  if (!retireLessons.ok) return { ok: false, reason: retireLessons.reason };
  const proposalId = op.evidence.fork_proposal_id ?? null;
  if (ctx.db.isFirstForkForLineage(parent.id)) {
    if (!proposalId) return { ok: false, reason: "fork_proposal_required" };
    const proposal = ctx.db.getForkProposal(proposalId);
    if (!proposal || proposal.status !== "open") {
      return { ok: false, reason: "fork_proposal_not_open" };
    }
    if (proposal.agent_type !== agentTypeForSkillName(parent.skill_name)) {
      return { ok: false, reason: "fork_proposal_agent_mismatch" };
    }
  }
  const content = readProposedContent(ctx.worktreePath, op.proposed_content_file);
  if (!content || content.trim().length === 0) {
    return { ok: false, reason: "proposed_content_empty" };
  }

  const experimentId = randomUUID();
  ctx.db.transaction(() => {
    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "fork",
      hypothesis: op.hypothesis,
      changeDescription: `fork ${parent.id} → specialty="${op.specialty}"`,
      metricName: op.evidence.metric_name,
      metricBefore: op.evidence.metric_before,
      evidence: {
        ...op.evidence,
        specialty: op.specialty,
        parent_variant_id: parent.id,
        pending_retire_lessons: pendingRetireLessonIds(retireLessons.ids)
      },
      status: "proposed",
      proposedContent: content
    });
  });

  return { ok: true, experimentId };
}

function handleMerge(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "merge" }>;
  const target = getMergeVariant(ctx.db, op.target_variant_id);
  if (!target) {
    return { ok: false, reason: "target_not_found" };
  }
  if (op.target_variant_id === op.merge_source_variant_id) {
    return { ok: false, reason: "merge_requires_distinct_variants" };
  }
  const retireLessons = validateRetireLessons(ctx, target.id);
  if (!retireLessons.ok) return { ok: false, reason: retireLessons.reason };
  const source = getMergeVariant(ctx.db, op.merge_source_variant_id);
  if (!source) {
    return { ok: false, reason: "merge_source_not_found" };
  }
  if (target.skill_name !== source.skill_name) {
    return { ok: false, reason: "merge_agent_type_mismatch" };
  }
  if (target.status !== "active" || source.status !== "active") {
    return { ok: false, reason: "merge_requires_active_variants" };
  }

  const targetLineageRoot = ctx.db.resolveLineageRoot(target.id) ?? target.id;
  const sourceLineageRoot = ctx.db.resolveLineageRoot(source.id) ?? source.id;
  if (targetLineageRoot !== sourceLineageRoot) {
    return { ok: false, reason: "merge_lineage_mismatch" };
  }

  const targetScores = ctx.db.loadRecentCompositeScoresForVariant(target.id, 30);
  const sourceScores = ctx.db.loadRecentCompositeScoresForVariant(source.id, 30);
  if (targetScores.length < 30 || sourceScores.length < 30) {
    return { ok: false, reason: "merge_insufficient_observations" };
  }

  const ks = kolmogorovSmirnovTwoSample(targetScores, sourceScores);
  if (ks.pValue < 0.30 || Math.abs(ks.effect) >= 0.03) {
    return { ok: false, reason: "merge_not_indistinguishable" };
  }

  const selection = selectMergeSurvivor(target, source, mean(targetScores), mean(sourceScores));
  const survivor = selection.survivor;
  const loser = selection.loser;
  const mergedSpecialty = mergeSpecialtyText(target.specialty, source.specialty);

  const experimentId = randomUUID();
  const result = ctx.db.transaction<MetaOperationResult>(() => {
    const allocation = adjustVariantAllocation(
      ctx.db,
      loser.id,
      { kind: "set_status", newStatus: "retired", newTrafficShare: 0 },
      "meta_merge",
      { meta_task_id: ctx.metaTaskId, experiment_id: experimentId, kept_variant_id: survivor.id }
    );
    if (!allocation.ok) return { ok: false, reason: allocation.reason };

    ctx.db.sqlite.query(
      "UPDATE skill_versions SET specialty = ?, specialty_embedding = NULL WHERE id = ?"
    ).run(mergedSpecialty, survivor.id);

    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "merge",
      hypothesis: op.hypothesis,
      changeDescription: `merge ${loser.id} into ${survivor.id}`,
      metricName: op.evidence.metric_name,
      metricBefore: op.evidence.metric_before,
      evidence: {
        ...op.evidence,
        target_variant_id: target.id,
        merge_source_variant_id: op.merge_source_variant_id,
        kept_variant_id: survivor.id,
        retired_variant_id: loser.id,
        merged_specialty: mergedSpecialty,
        tie_breaker_used: selection.tieBreakerUsed,
        ks_p_value: ks.pValue,
        mean_difference: ks.effect,
        retired_lessons: applyRetireLessons(ctx, retireLessons.ids)
      },
      status: "active"
    });

    recordMetaEvent(ctx, {
      taskId: ctx.metaTaskId,
      projectId: ctx.projectId,
      agent: "orchestrator",
      type: "variants_merged",
      status: "done",
      payload: {
        experiment_id: experimentId,
        kept_variant_id: survivor.id,
        retired_variant_id: loser.id,
        merged_specialty: mergedSpecialty,
        tie_breaker_used: selection.tieBreakerUsed
      },
      budgetSeconds: 0,
      analyticsOnly: true
    });

    return { ok: true, experimentId };
  });

  return result;
}

function getMergeVariant(db: DbClient, id: string): MergeVariantRow | null {
  const row = db.sqlite
    .query(`
      SELECT id, skill_name, status, traffic_share, parent_version_id, specialty, content, created_at
        FROM skill_versions
       WHERE id = ?
    `)
    .get(id) as MergeVariantRow | undefined;
  return row ?? null;
}

function selectMergeSurvivor(
  target: MergeVariantRow,
  source: MergeVariantRow,
  targetMean: number,
  sourceMean: number
): { survivor: MergeVariantRow; loser: MergeVariantRow; tieBreakerUsed: string } {
  const meanTieWindow = 0.005;
  if (Math.abs(targetMean - sourceMean) > meanTieWindow) {
    return targetMean > sourceMean
      ? { survivor: target, loser: source, tieBreakerUsed: "composite_score" }
      : { survivor: source, loser: target, tieBreakerUsed: "composite_score" };
  }

  if (target.content.length !== source.content.length) {
    return target.content.length < source.content.length
      ? { survivor: target, loser: source, tieBreakerUsed: "text_size" }
      : { survivor: source, loser: target, tieBreakerUsed: "text_size" };
  }

  const targetCreated = Date.parse(target.created_at);
  const sourceCreated = Date.parse(source.created_at);
  if (Number.isFinite(targetCreated) && Number.isFinite(sourceCreated) && targetCreated !== sourceCreated) {
    return targetCreated < sourceCreated
      ? { survivor: target, loser: source, tieBreakerUsed: "created_at" }
      : { survivor: source, loser: target, tieBreakerUsed: "created_at" };
  }

  return { survivor: target, loser: source, tieBreakerUsed: "none" };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function handleShareAdjust(
  ctx: MetaOperationContext,
  kind: "promote" | "demote"
): MetaOperationResult {
  // NOTE: `PromoteDemoteRetireOp` uses a single z.enum for kind, so TypeScript's
  // Extract over a narrower subset returns `never`. Widen to the full enum; the
  // dispatcher guarantees `kind` is one of promote|demote at runtime.
  const op = ctx.operation as Extract<
    MetaOperation,
    { kind: "promote" | "demote" | "retire" }
  >;
  const target = ctx.db.getSkillVersionById(op.target_variant_id);
  if (!target) return { ok: false, reason: "target_not_found" };
  const retireLessons = validateRetireLessons(ctx, target.id);
  if (!retireLessons.ok) return { ok: false, reason: retireLessons.reason };

  const newShare = op.traffic_share;
  if (newShare === undefined) return { ok: false, reason: "traffic_share_required" };
  if (!Number.isFinite(newShare) || newShare < 0 || newShare > MAX_TRAFFIC_SHARE) {
    return { ok: false, reason: "traffic_share_out_of_range" };
  }
  const delta = kind === "promote"
    ? newShare - target.traffic_share
    : target.traffic_share - newShare;
  if (delta < 0) {
    return { ok: false, reason: `${kind}_requires_${kind === "promote" ? "increase" : "decrease"}` };
  }

  const experimentId = randomUUID();
  const result = ctx.db.transaction<MetaOperationResult>(() => {
    const allocation = adjustVariantAllocation(
      ctx.db,
      target.id,
      { kind, delta },
      kind === "promote" ? "meta_promote" : "meta_demote",
      { meta_task_id: ctx.metaTaskId }
    );
    if (!allocation.ok) return { ok: false, reason: allocation.reason };

    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: kind,
      hypothesis: op.hypothesis,
      changeDescription: `${kind} ${target.id} → ${newShare}`,
      evidence: {
        ...op.evidence,
        new_traffic_share: newShare,
        retired_lessons: applyRetireLessons(ctx, retireLessons.ids)
      },
      status: "active"
    });

    return { ok: true, experimentId };
  });

  return result;
}

function handleRetire(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<
    MetaOperation,
    { kind: "promote" | "demote" | "retire" }
  >;
  const target = ctx.db.getSkillVersionById(op.target_variant_id);
  if (!target) return { ok: false, reason: "target_not_found" };
  const retireLessons = validateRetireLessons(ctx, target.id);
  if (!retireLessons.ok) return { ok: false, reason: retireLessons.reason };

  const experimentId = randomUUID();
  const result = ctx.db.transaction<MetaOperationResult>(() => {
    const allocation = adjustVariantAllocation(
      ctx.db,
      target.id,
      { kind: "set_status", newStatus: "retired", newTrafficShare: 0 },
      "meta_retire",
      { meta_task_id: ctx.metaTaskId }
    );
    if (!allocation.ok) return { ok: false, reason: allocation.reason };

    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "retire",
      hypothesis: op.hypothesis,
      changeDescription: `retire ${target.id}`,
      evidence: { ...op.evidence, retired_lessons: applyRetireLessons(ctx, retireLessons.ids) },
      status: "active"
    });

    return { ok: true, experimentId };
  });

  return result;
}
