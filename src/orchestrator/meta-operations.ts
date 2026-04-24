import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DbClient } from "../db/client";
import type { MetaOperation } from "../schemas/meta-output";

const BASELINE_PROTECTION_MIN_SHARE = 0.5;
const MAX_TRAFFIC_SHARE = 1.0;

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
  const p = resolve(worktreePath, fileName);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function applyRetireLessons(ctx: MetaOperationContext): string[] {
  const list = (ctx.operation.retire_lessons ?? []).map((e) => e.id);
  return ctx.db.retireLessons(list);
}

function handleEdit(ctx: MetaOperationContext): MetaOperationResult {
  const op = ctx.operation as Extract<MetaOperation, { kind: "edit" }>;
  const target = ctx.db.getSkillVersionById(op.target_variant_id);
  if (!target) return { ok: false, reason: "target_not_found" };

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
      evidence: { ...op.evidence, retired_lessons: applyRetireLessons(ctx) },
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
        retired_lessons: applyRetireLessons(ctx)
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
        retired_lessons: applyRetireLessons(ctx)
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

  const newShare = op.traffic_share;
  if (newShare === undefined) return { ok: false, reason: "traffic_share_required" };
  if (newShare < 0 || newShare > MAX_TRAFFIC_SHARE) {
    return { ok: false, reason: "traffic_share_out_of_range" };
  }
  if (target.status === "baseline" && newShare < BASELINE_PROTECTION_MIN_SHARE) {
    return { ok: false, reason: "baseline_protected" };
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
        retired_lessons: applyRetireLessons(ctx)
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
      evidence: { ...op.evidence, retired_lessons: applyRetireLessons(ctx) },
      status: "active"
    });
  });

  return { ok: true, experimentId };
}
