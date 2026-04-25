import type { DbClient, ShadowPair, VariantScore } from "../db/client";
import { adjustVariantAllocation } from "./allocation";
import { mannWhitneyUGreater, mannWhitneyULess, wilcoxonSignedRankGreaterOrEqual } from "./sequential-test";

export interface AutoTuneDecision {
  kind: "continue" | "graduated" | "demoted" | "promoted" | "baseline_swapped" | "retired";
  reason?: string;
}

interface CandidateRow {
  id: string;
  status: string;
  traffic_share: number;
  experiment_id: string | null;
}

interface VariantRow {
  id: string;
  skill_name: string;
  status: string;
  traffic_share: number;
  created_at: string;
}

interface ValidShadowPair {
  baselineComposite: number;
  candidateComposite: number;
  baselineScoreComponents: Record<string, unknown> | null;
  candidateScoreComponents: Record<string, unknown> | null;
}

const MIN_GRADUATION_PAIRS = 10;
const FAILED_GRADUATION_TIMEOUT_PAIRS = 20;
const CONSECUTIVE_ERROR_LIMIT = 5;
const GRADUATED_TRAFFIC_SHARE = 0.10;
const CRITICAL_REGRESSION_FLOOR = -0.15;
const WILCOXON_P_VALUE_THRESHOLD = 0.10;
const ACTIVE_SCORE_WINDOW = { limit: 30, maxAgeDays: 60 } as const;
const MIN_ACTIVE_SCORES = 30;
const TRAFFIC_ADJUSTMENT_STEP = 0.05;
const PROMOTION_P_VALUE_THRESHOLD = 0.05;
const PROMOTION_MEAN_DIFF = 0.05;
const BASELINE_SWAP_P_VALUE_THRESHOLD = 0.01;
const BASELINE_SWAP_MEAN_DIFF = 0.10;
const BASELINE_SWAP_DOMINANCE_EVALUATIONS = 20;
const AUTO_RETIRE_AGE_DAYS = 90;
const REWARD_KEYS = [
  "r_correctness",
  "r_simplicity",
  "r_alignment",
  "r_fidelity",
  "r_efficiency"
] as const;
const SYSTEM_SHADOW_ERRORS = new Set([
  "baseline_not_live",
  "baseline_variant_not_found",
  "shadow_runner_not_configured"
]);

type RewardKey = typeof REWARD_KEYS[number];

export function evaluateCandidate(db: DbClient, candidateId: string): AutoTuneDecision {
  const candidate = loadCandidate(db, candidateId);
  if (!candidate) {
    return { kind: "continue", reason: "candidate_not_found" };
  }
  if (candidate.status !== "candidate") {
    return { kind: "continue", reason: `candidate_status_${candidate.status}` };
  }

  const shadowPairs = db.loadShadowPairs(candidateId);
  const consecutiveErrors = trailingConsecutiveErrors(shadowPairs);
  if (consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
    return demoteCandidate(db, candidate, {
      reason: "shadow_repeatedly_failed",
      supportingMetric: {
        reason: "shadow_repeatedly_failed",
        consecutive_errors: consecutiveErrors
      }
    });
  }

  const validPairs = shadowPairs.filter(isValidShadowPair);
  if (validPairs.length < MIN_GRADUATION_PAIRS) {
    return { kind: "continue", reason: "insufficient_valid_pairs" };
  }

  const evaluation = evaluateGraduationPredicate(validPairs);
  if (evaluation.ok) {
    return db.transaction(() => {
      const result = adjustVariantAllocation(
        db,
        candidate.id,
        { kind: "graduate", newTrafficShare: GRADUATED_TRAFFIC_SHARE },
        "auto_graduation",
        evaluation.supportingMetric
      );
      if (!result.ok) {
        return { kind: "continue", reason: result.reason ?? "allocation_rejected" };
      }
      updateExperimentStatus(db, candidate.experiment_id, "active");
      return { kind: "graduated" };
    });
  }

  if (validPairs.length >= FAILED_GRADUATION_TIMEOUT_PAIRS) {
    return demoteCandidate(db, candidate, {
      reason: `failed_graduation_predicate:${evaluation.reason}`,
      supportingMetric: {
        ...evaluation.supportingMetric,
        reason: "failed_graduation_predicate",
        failed_predicate: evaluation.reason,
        valid_pairs: validPairs.length
      }
    });
  }

  return { kind: "continue", reason: evaluation.reason };
}

export function evaluateActiveVariant(db: DbClient, variantId: string): AutoTuneDecision {
  return defaultAutoTuner.evaluateActiveVariant(db, variantId);
}

export function evaluateAutoRetire(db: DbClient, now = new Date()): AutoTuneDecision[] {
  const cutoff = new Date(now.getTime() - AUTO_RETIRE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.sqlite
    .query(`
      SELECT
        sv.id,
        MAX(e.timestamp) AS demotedAt
      FROM skill_versions sv
      JOIN events e
        ON e.event_type = 'traffic_allocated'
       AND json_extract(e.payload, '$.variant_id') = sv.id
       AND json_extract(e.payload, '$.new_status') = 'demoted'
      WHERE sv.status = 'demoted'
      GROUP BY sv.id
      HAVING demotedAt <= ?
      ORDER BY demotedAt ASC, sv.id ASC
    `)
    .all(cutoff) as Array<{ id: string }>;
  const decisions: AutoTuneDecision[] = [];

  for (const row of rows) {
    const result = adjustVariantAllocation(
      db,
      row.id,
      { kind: "set_status", newStatus: "retired", newTrafficShare: 0 },
      "auto_retire",
      { age_days: AUTO_RETIRE_AGE_DAYS }
    );
    decisions.push(result.ok
      ? { kind: "retired", reason: `auto_retire:${row.id}` }
      : { kind: "continue", reason: result.reason ?? "allocation_rejected" });
  }

  return decisions;
}

export class AutoTuner {
  private readonly dominanceCounts = new Map<string, { count: number; watermark: string }>();

  evaluateActiveVariant(db: DbClient, variantId: string): AutoTuneDecision {
    const variant = loadVariant(db, variantId);
    if (!variant) {
      return { kind: "continue", reason: "variant_not_found" };
    }
    if (variant.status !== "active") {
      return { kind: "continue", reason: `variant_status_${variant.status}` };
    }

    const baseline = loadBaselineForSkill(db, variant.skill_name);
    if (!baseline) {
      return { kind: "continue", reason: "baseline_not_found" };
    }

    const comparison = loadActiveComparison(db, variant.id, baseline.id);
    if (!comparison) {
      this.dominanceCounts.delete(variant.id);
      return { kind: "continue", reason: "insufficient_recent_scores" };
    }

    const variantSamples = comparison.variantScores.map((score) => score.composite);
    const baselineSamples = comparison.baselineScores.map((score) => score.composite);
    const evidenceWatermark = scoreWindowWatermark(comparison);
    const variantMean = mean(variantSamples);
    const baselineMean = mean(baselineSamples);
    const meanDiff = variantMean - baselineMean;
    const variantGreater = mannWhitneyUGreater(variantSamples, baselineSamples);
    const variantLess = mannWhitneyULess(variantSamples, baselineSamples);
    const supportingMetric = {
      test: "mann_whitney_u",
      variant_samples: variantSamples.length,
      baseline_samples: baselineSamples.length,
      mean_variant_composite: variantMean,
      mean_baseline_composite: baselineMean,
      mean_diff: meanDiff,
      p_value_variant_greater: variantGreater.pValue,
      p_value_variant_less: variantLess.pValue,
      evidence_watermark: evidenceWatermark
    };

    if (
      meanDiff >= BASELINE_SWAP_MEAN_DIFF
      && variantGreater.pValue <= BASELINE_SWAP_P_VALUE_THRESHOLD
      && isHighestActiveVariant(db, variant, variantMean)
    ) {
      const previousDominance = this.dominanceCounts.get(variant.id);
      const dominanceCount = previousDominance?.watermark === evidenceWatermark
        ? previousDominance.count
        : (previousDominance?.count ?? 0) + 1;
      this.dominanceCounts.set(variant.id, { count: dominanceCount, watermark: evidenceWatermark });
      if (dominanceCount >= BASELINE_SWAP_DOMINANCE_EVALUATIONS) {
        if (!hasNewEvidenceForAllocation(db, variant.id, ["baseline_swap"], evidenceWatermark)) {
          return { kind: "continue", reason: "no_new_evidence" };
        }
        const result = adjustVariantAllocation(
          db,
          baseline.id,
          { kind: "baseline_swap", newBaselineId: variant.id },
          "baseline_swap",
          { ...supportingMetric, dominance_evaluations: dominanceCount }
        );
        return result.ok
          ? { kind: "baseline_swapped" }
          : { kind: "continue", reason: result.reason ?? "allocation_rejected" };
      }
      if (dominanceCount > 1) {
        return { kind: "continue", reason: "baseline_swap_dominance_pending" };
      }
    } else {
      this.dominanceCounts.delete(variant.id);
    }

    if (variantGreater.pValue <= PROMOTION_P_VALUE_THRESHOLD && meanDiff >= PROMOTION_MEAN_DIFF) {
      if (!hasNewEvidenceForAllocation(db, variant.id, ["auto_promote"], evidenceWatermark)) {
        return { kind: "continue", reason: "no_new_evidence" };
      }
      const result = adjustVariantAllocation(
        db,
        variant.id,
        { kind: "promote", delta: roundShare(variant.traffic_share + TRAFFIC_ADJUSTMENT_STEP) - variant.traffic_share },
        "auto_promote",
        supportingMetric
      );
      return result.ok
        ? { kind: "promoted" }
        : { kind: "continue", reason: result.reason ?? "allocation_rejected" };
    }

    if (variantLess.pValue <= PROMOTION_P_VALUE_THRESHOLD) {
      if (!hasNewEvidenceForAllocation(db, variant.id, ["auto_demote"], evidenceWatermark)) {
        return { kind: "continue", reason: "no_new_evidence" };
      }
      const result = adjustVariantAllocation(
        db,
        variant.id,
        { kind: "demote", delta: TRAFFIC_ADJUSTMENT_STEP },
        "auto_demote",
        supportingMetric
      );
      return result.ok
        ? { kind: "demoted" }
        : { kind: "continue", reason: result.reason ?? "allocation_rejected" };
    }

    return { kind: "continue", reason: "no_significant_effect" };
  }
}

const defaultAutoTuner = new AutoTuner();

function loadCandidate(db: DbClient, candidateId: string): CandidateRow | null {
  return db.sqlite
    .query("SELECT id, status, traffic_share, experiment_id FROM skill_versions WHERE id = ?")
    .get(candidateId) as CandidateRow | null;
}

function loadVariant(db: DbClient, variantId: string): VariantRow | null {
  return db.sqlite
    .query("SELECT id, skill_name, status, traffic_share, created_at FROM skill_versions WHERE id = ?")
    .get(variantId) as VariantRow | null;
}

function loadBaselineForSkill(db: DbClient, skillName: string): VariantRow | null {
  return db.sqlite
    .query("SELECT id, skill_name, status, traffic_share, created_at FROM skill_versions WHERE skill_name = ? AND status = 'baseline'")
    .get(skillName) as VariantRow | null;
}

function loadActiveComparison(
  db: DbClient,
  variantId: string,
  baselineId: string
): { variantScores: VariantScore[]; baselineScores: VariantScore[] } | null {
  const variantScores = db.loadRecentTaskScores(variantId, ACTIVE_SCORE_WINDOW);
  const baselineScores = sameBucketScores(
    db.loadRecentBaselineTaskScores(baselineId, ACTIVE_SCORE_WINDOW),
    variantScores
  );
  if (variantScores.length < MIN_ACTIVE_SCORES || baselineScores.length < MIN_ACTIVE_SCORES) {
    return null;
  }
  return { variantScores, baselineScores };
}

function sameBucketScores(scores: VariantScore[], referenceScores: VariantScore[]): VariantScore[] {
  const buckets = new Set(referenceScores.map((score) => scoreBucket(score)));
  const filtered = scores.filter((score) => buckets.has(scoreBucket(score)));
  return filtered.length > 0 ? filtered : scores;
}

function scoreBucket(score: VariantScore): string {
  return `${score.projectId}\u0000${score.tier}`;
}

function isHighestActiveVariant(db: DbClient, variant: VariantRow, variantMean: number): boolean {
  const activeRows = db.sqlite
    .query("SELECT id, skill_name, status, traffic_share, created_at FROM skill_versions WHERE skill_name = ? AND status = 'active'")
    .all(variant.skill_name) as VariantRow[];

  for (const active of activeRows) {
    if (active.id === variant.id) {
      continue;
    }
    const scores = db.loadRecentTaskScores(active.id, ACTIVE_SCORE_WINDOW);
    if (scores.length < MIN_ACTIVE_SCORES) {
      continue;
    }
    if (mean(scores.map((score) => score.composite)) > variantMean) {
      return false;
    }
  }
  return true;
}

function scoreWindowWatermark(input: { variantScores: VariantScore[]; baselineScores: VariantScore[] }): string {
  const timestamps = [...input.variantScores, ...input.baselineScores]
    .map((score) => score.selectedAt || score.createdAt)
    .sort();
  return timestamps.length === 0 ? "" : timestamps[timestamps.length - 1];
}

function hasNewEvidenceForAllocation(
  db: DbClient,
  variantId: string,
  reasons: string[],
  evidenceWatermark: string
): boolean {
  const reasonPlaceholders = reasons.map((_, index) => `$reason_${index}`).join(", ");
  const params: Record<string, string> = { $variant_id: variantId };
  reasons.forEach((reason, index) => {
    params[`$reason_${index}`] = reason;
  });
  const row = db.sqlite
    .query(`
      SELECT json_extract(payload, '$.supporting_metric.evidence_watermark') AS evidenceWatermark
      FROM events
      WHERE event_type = 'traffic_allocated'
        AND json_extract(payload, '$.variant_id') = $variant_id
        AND json_extract(payload, '$.reason') IN (${reasonPlaceholders})
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `)
    .get(params) as { evidenceWatermark: string | null } | null;

  return !row?.evidenceWatermark || row.evidenceWatermark < evidenceWatermark;
}

function updateExperimentStatus(db: DbClient, experimentId: string | null, status: "active" | "discard"): void {
  if (!experimentId) {
    return;
  }
  db.sqlite.query("UPDATE experiments SET status = ? WHERE id = ?").run(status, experimentId);
}

function demoteCandidate(
  db: DbClient,
  candidate: CandidateRow,
  input: { reason: string; supportingMetric: Record<string, unknown> }
): AutoTuneDecision {
  return db.transaction(() => {
    const result = adjustVariantAllocation(
      db,
      candidate.id,
      { kind: "set_status", newStatus: "demoted" },
      "auto_demote",
      input.supportingMetric
    );
    if (!result.ok) {
      return { kind: "continue", reason: result.reason ?? "allocation_rejected" };
    }
    updateExperimentStatus(db, candidate.experiment_id, "discard");
    return { kind: "demoted", reason: input.reason };
  });
}

function isValidShadowPair(pair: ShadowPair): pair is ShadowPair & ValidShadowPair {
  return pair.error === null
    && pair.baselineComposite !== null
    && pair.candidateComposite !== null
    && pair.candidateScoreComponents !== null
    && pair.candidateScoreComponents.placeholder !== true;
}

function trailingConsecutiveErrors(pairs: ShadowPair[]): number {
  let count = 0;
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index];
    if (isSystemShadowError(pair)) {
      continue;
    }
    if (!isCandidateRunnerError(pair)) {
      break;
    }
    count += 1;
  }
  return count;
}

function isCandidateRunnerError(pair: ShadowPair): boolean {
  return pair.error !== null || pair.status === "done_with_concerns";
}

function isSystemShadowError(pair: ShadowPair): boolean {
  return pair.error !== null && SYSTEM_SHADOW_ERRORS.has(pair.error);
}

function evaluateGraduationPredicate(validPairs: ValidShadowPair[]): {
  ok: boolean;
  reason?: string;
  supportingMetric: Record<string, unknown>;
} {
  const meanCandidateComposite = mean(validPairs.map((pair) => pair.candidateComposite));
  const meanBaselineComposite = mean(validPairs.map((pair) => pair.baselineComposite));
  const rewardDiffs = Object.fromEntries(
    REWARD_KEYS.map((key) => [key, meanRewardDifference(validPairs, key)])
  ) as Record<RewardKey, number>;
  const regression = REWARD_KEYS.find((key) => rewardDiffs[key] < CRITICAL_REGRESSION_FLOOR);
  const wilcoxon = wilcoxonSignedRankGreaterOrEqual(
    validPairs.map((pair) => [pair.candidateComposite, pair.baselineComposite])
  );
  const supportingMetric = {
    test: "wilcoxon_paired",
    p_value: wilcoxon.pValue,
    effect: wilcoxon.effect,
    valid_pairs: validPairs.length,
    mean_candidate_composite: meanCandidateComposite,
    mean_baseline_composite: meanBaselineComposite,
    reward_diffs: rewardDiffs
  };

  if (regression) {
    return {
      ok: false,
      reason: `critical_regression:${regression}`,
      supportingMetric
    };
  }
  if (meanCandidateComposite < meanBaselineComposite) {
    return {
      ok: false,
      reason: "candidate_composite_below_baseline",
      supportingMetric
    };
  }
  if (wilcoxon.pValue > WILCOXON_P_VALUE_THRESHOLD) {
    return {
      ok: false,
      reason: "wilcoxon_not_significant",
      supportingMetric
    };
  }

  return { ok: true, supportingMetric };
}

function meanRewardDifference(pairs: ValidShadowPair[], key: RewardKey): number {
  const completeDifferences = pairs.flatMap((pair) => {
    const candidate = rewardValue(pair.candidateScoreComponents, key);
    const baseline = rewardValue(pair.baselineScoreComponents, key);
    return candidate === null || baseline === null ? [] : [candidate - baseline];
  });
  // Task 6 placeholders may not include full reward terms yet. Missing terms are
  // skipped pairwise; if no complete comparisons exist, the term is neutral.
  return completeDifferences.length === 0 ? 0 : mean(completeDifferences);
}

function rewardValue(components: Record<string, unknown> | null, key: RewardKey): number | null {
  const value = components?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundShare(value: number): number {
  return Math.round(value * 100) / 100;
}
