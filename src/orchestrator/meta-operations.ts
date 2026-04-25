import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import type { DbClient } from "../db/client";
import type { MetaOperation } from "../schemas/meta-output";

const BASELINE_PROTECTION_MIN_SHARE = 0.5;
const MAX_TRAFFIC_SHARE = 1.0;
const MVP_EXPLORATION_SHARE = 0.1;
const BASELINE_MAX_WITH_POPULATION = MAX_TRAFFIC_SHARE - MVP_EXPLORATION_SHARE;

export interface MetaOperationContext {
  db: DbClient;
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
  if (!ctx.db.getSkillVersionById(op.target_variant_id)) {
    return { ok: false, reason: "target_not_found" };
  }
  const retireLessons = validateRetireLessons(ctx, op.target_variant_id);
  if (!retireLessons.ok) return { ok: false, reason: retireLessons.reason };
  if (!ctx.db.getSkillVersionById(op.merge_source_variant_id)) {
    return { ok: false, reason: "merge_source_not_found" };
  }

  const experimentId = randomUUID();
  ctx.db.transaction(() => {
    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "merge",
      hypothesis: op.hypothesis,
      changeDescription: `merge proposal: ${op.merge_source_variant_id} into ${op.target_variant_id}`,
      metricName: op.evidence.metric_name,
      metricBefore: op.evidence.metric_before,
      evidence: {
        ...op.evidence,
        merge_source_variant_id: op.merge_source_variant_id,
        pending_retire_lessons: pendingRetireLessonIds(retireLessons.ids)
      },
      status: "proposed"
    });
  });

  return { ok: true, experimentId };
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
  if (!["baseline", "active"].includes(target.status)) {
    return { ok: false, reason: `cannot_${kind}_${target.status}_variant` };
  }

  const newShare = op.traffic_share;
  if (newShare === undefined) return { ok: false, reason: "traffic_share_required" };
  if (newShare < 0 || newShare > MAX_TRAFFIC_SHARE) {
    return { ok: false, reason: "traffic_share_out_of_range" };
  }
  if (target.status === "baseline" && newShare < BASELINE_PROTECTION_MIN_SHARE) {
    return { ok: false, reason: "baseline_protected" };
  }
  if (target.status === "baseline" && newShare > BASELINE_MAX_WITH_POPULATION) {
    const population = (ctx.db.sqlite
      .query(
        "SELECT COUNT(*) AS n FROM skill_versions WHERE skill_name = ? AND status IN ('baseline','active','candidate')"
      )
      .get(target.skill_name) as { n: number }).n;
    if (population > 1) {
      return { ok: false, reason: "baseline_exploration_reserved" };
    }
  }

  const experimentId = randomUUID();
  ctx.db.transaction(() => {
    ctx.db.updateTrafficShare(target.id, newShare);
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
  });

  return { ok: true, experimentId };
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

  if (target.status === "baseline") {
    const count = ctx.db.countBaselinesForSkillName(target.skill_name);
    if (count <= 1) return { ok: false, reason: "sole_baseline" };
  }

  const experimentId = randomUUID();
  ctx.db.transaction(() => {
    ctx.db.retireVariant(target.id);
    ctx.db.insertMetaOperationExperiment({
      experimentId,
      metaTaskId: ctx.metaTaskId,
      operation: "retire",
      hypothesis: op.hypothesis,
      changeDescription: `retire ${target.id}`,
      evidence: { ...op.evidence, retired_lessons: applyRetireLessons(ctx, retireLessons.ids) },
      status: "active"
    });
  });

  return { ok: true, experimentId };
}
