import type { DbClient } from "../db/client";

export type VariantStatus = "baseline" | "candidate" | "active" | "demoted" | "retired";

export type AllocationReason =
  | "auto_graduation" | "auto_promote" | "auto_demote" | "auto_retire"
  | "meta_promote" | "meta_demote" | "meta_retire" | "meta_fork_approved"
  | "baseline_swap" | "dispatch_bootstrap";

export type AllocationOp =
  | { kind: "graduate"; newTrafficShare: number }
  | { kind: "promote"; delta: number }
  | { kind: "demote"; delta: number }
  | { kind: "set_status"; newStatus: VariantStatus; newTrafficShare?: number }
  | { kind: "baseline_swap"; newBaselineId: string };

export interface AllocationResult {
  ok: boolean;
  reason?: string;
}

interface VariantRow {
  id: string;
  skill_name: string;
  status: VariantStatus;
  traffic_share: number;
}

const ACTIVE_CAP_STATUSES = new Set<VariantStatus>(["baseline", "active"]);
const LIVE_STATUSES = new Set<VariantStatus>(["baseline", "active", "candidate"]);

export function adjustVariantAllocation(
  db: DbClient,
  variantId: string,
  op: AllocationOp,
  reason: AllocationReason,
  supportingMetric?: Record<string, unknown>
): AllocationResult {
  return db.transaction(() => {
    const current = getVariant(db, variantId);
    if (!current) {
      return { ok: false, reason: "variant_not_found" };
    }

    const population = getPopulation(db, current.skill_name);
    if (op.kind === "baseline_swap") {
      return applyBaselineSwap(db, current, population, op.newBaselineId, reason, supportingMetric);
    }

    const opValidation = validateOperationNumbers(op);
    if (!opValidation.ok) {
      return opValidation;
    }

    const next = nextVariantState(current, op);
    const validation = validatePopulation(
      population.map((variant) => variant.id === current.id ? next : variant),
      current,
      next,
      op
    );
    if (!validation.ok) {
      return validation;
    }

    updateVariant(db, next);
    db.appendTrafficAllocatedEvent({
      variantId: current.id,
      agentType: agentTypeForSkillName(current.skill_name),
      oldStatus: current.status,
      newStatus: next.status,
      oldTrafficShare: current.traffic_share,
      newTrafficShare: next.traffic_share,
      reason,
      supportingMetric
    });

    return { ok: true };
  });
}

function getVariant(db: DbClient, id: string): VariantRow | null {
  const row = db.sqlite
    .query("SELECT id, skill_name, status, traffic_share FROM skill_versions WHERE id = ?")
    .get(id) as VariantRow | undefined;
  return row ?? null;
}

function getPopulation(db: DbClient, skillName: string): VariantRow[] {
  return db.sqlite
    .query("SELECT id, skill_name, status, traffic_share FROM skill_versions WHERE skill_name = ?")
    .all(skillName) as VariantRow[];
}

function nextVariantState(current: VariantRow, op: Exclude<AllocationOp, { kind: "baseline_swap" }>): VariantRow {
  switch (op.kind) {
    case "graduate":
      return { ...current, status: "active", traffic_share: op.newTrafficShare };
    case "promote": {
      const trafficShare = current.traffic_share + op.delta;
      const status = current.status === "demoted" && trafficShare > 0 ? "active" : current.status;
      return { ...current, status, traffic_share: trafficShare };
    }
    case "demote": {
      const trafficShare = Math.max(0, current.traffic_share - op.delta);
      return { ...current, status: trafficShare === 0 ? "demoted" : current.status, traffic_share: trafficShare };
    }
    case "set_status":
      return {
        ...current,
        status: op.newStatus,
        traffic_share: zeroTrafficStatus(op.newStatus) ? 0.0 : op.newTrafficShare ?? current.traffic_share
      };
  }
}

function validateOperationNumbers(op: Exclude<AllocationOp, { kind: "baseline_swap" }>): AllocationResult {
  switch (op.kind) {
    case "graduate":
      return finiteNumberResult(op.newTrafficShare);
    case "promote":
    case "demote":
      return finiteNonnegativeDeltaResult(op.delta);
    case "set_status":
      return op.newTrafficShare === undefined ? { ok: true } : finiteNumberResult(op.newTrafficShare);
  }
}

function finiteNumberResult(value: number): AllocationResult {
  return Number.isFinite(value) ? { ok: true } : { ok: false, reason: "traffic_share_out_of_range" };
}

function finiteNonnegativeDeltaResult(value: number): AllocationResult {
  return Number.isFinite(value) && value >= 0 ? { ok: true } : { ok: false, reason: "traffic_delta_out_of_range" };
}

function validatePopulation(
  proposedPopulation: VariantRow[],
  current: VariantRow,
  next: VariantRow,
  op: AllocationOp
): AllocationResult {
  if (current.status === "retired" && (next.status !== "retired" || next.traffic_share !== 0)) {
    return { ok: false, reason: "retired_variant_immutable" };
  }

  if (current.status === "candidate" && op.kind !== "graduate" && next.traffic_share > 0) {
    return { ok: false, reason: "candidate_requires_graduation" };
  }

  if (current.status === "baseline" && next.status === "retired" && baselineCount(proposedPopulation) === 0) {
    return { ok: false, reason: "sole_baseline_retirement" };
  }

  if (!Number.isFinite(next.traffic_share) || next.traffic_share < 0 || next.traffic_share > 1) {
    return { ok: false, reason: "traffic_share_out_of_range" };
  }

  if (baselineCount(proposedPopulation) !== 1) {
    return { ok: false, reason: "exactly_one_baseline_required" };
  }

  const baseline = proposedPopulation.find((variant) => variant.status === "baseline");
  if (!baseline) {
    return { ok: false, reason: "exactly_one_baseline_required" };
  }
  if (baseline.traffic_share < 0.5) {
    return { ok: false, reason: "baseline_minimum_share" };
  }
  if (liveCount(proposedPopulation) > 1 && baseline.traffic_share > 0.9) {
    return { ok: false, reason: "baseline_exploration_reserved" };
  }

  const wasActiveForCap = ACTIVE_CAP_STATUSES.has(current.status);
  const isActiveForCap = ACTIVE_CAP_STATUSES.has(next.status);
  if (!wasActiveForCap && isActiveForCap && activeCount(proposedPopulation) > 5) {
    return { ok: false, reason: "population_cap_exceeded" };
  }

  return { ok: true };
}

function applyBaselineSwap(
  db: DbClient,
  requestedVariant: VariantRow,
  population: VariantRow[],
  newBaselineId: string,
  reason: AllocationReason,
  supportingMetric?: Record<string, unknown>
): AllocationResult {
  const oldBaseline = population.find((variant) => variant.status === "baseline");
  if (!oldBaseline) {
    return { ok: false, reason: "exactly_one_baseline_required" };
  }
  if (requestedVariant.id !== oldBaseline.id) {
    return { ok: false, reason: "baseline_swap_requires_current_baseline" };
  }

  const newBaseline = population.find((variant) => variant.id === newBaselineId);
  if (!newBaseline) {
    return { ok: false, reason: "new_baseline_not_found" };
  }
  if (newBaseline.status === "retired") {
    return { ok: false, reason: "retired_variant_immutable" };
  }
  if (newBaseline.status === "candidate") {
    return { ok: false, reason: "candidate_requires_graduation" };
  }

  const nextOldBaseline: VariantRow = { ...oldBaseline, status: "active", traffic_share: 0.4 };
  const nextNewBaseline: VariantRow = {
    ...newBaseline,
    status: "baseline",
    traffic_share: Math.max(newBaseline.traffic_share, 0.5)
  };
  const proposedPopulation = population.map((variant) => {
    if (variant.id === nextOldBaseline.id) {
      return nextOldBaseline;
    }
    if (variant.id === nextNewBaseline.id) {
      return nextNewBaseline;
    }
    return variant;
  });

  const validation = validateSwapPopulation(proposedPopulation);
  if (!validation.ok) {
    return validation;
  }

  updateVariant(db, nextOldBaseline);
  updateVariant(db, nextNewBaseline);
  db.appendTrafficAllocatedEvent({
    variantId: oldBaseline.id,
    agentType: agentTypeForSkillName(oldBaseline.skill_name),
    oldStatus: oldBaseline.status,
    newStatus: nextOldBaseline.status,
    oldTrafficShare: oldBaseline.traffic_share,
    newTrafficShare: nextOldBaseline.traffic_share,
    reason,
    supportingMetric
  });
  db.appendTrafficAllocatedEvent({
    variantId: newBaseline.id,
    agentType: agentTypeForSkillName(newBaseline.skill_name),
    oldStatus: newBaseline.status,
    newStatus: nextNewBaseline.status,
    oldTrafficShare: newBaseline.traffic_share,
    newTrafficShare: nextNewBaseline.traffic_share,
    reason,
    supportingMetric
  });

  return { ok: true };
}

function validateSwapPopulation(proposedPopulation: VariantRow[]): AllocationResult {
  if (proposedPopulation.some((variant) => variant.traffic_share < 0 || variant.traffic_share > 1)) {
    return { ok: false, reason: "traffic_share_out_of_range" };
  }
  if (baselineCount(proposedPopulation) !== 1) {
    return { ok: false, reason: "exactly_one_baseline_required" };
  }
  const baseline = proposedPopulation.find((variant) => variant.status === "baseline");
  if (!baseline || baseline.traffic_share < 0.5) {
    return { ok: false, reason: "baseline_minimum_share" };
  }
  if (liveCount(proposedPopulation) > 1 && baseline.traffic_share > 0.9) {
    return { ok: false, reason: "baseline_exploration_reserved" };
  }
  if (activeCount(proposedPopulation) > 5) {
    return { ok: false, reason: "population_cap_exceeded" };
  }
  return { ok: true };
}

function updateVariant(db: DbClient, variant: VariantRow): void {
  db.sqlite
    .query("UPDATE skill_versions SET status = ?, traffic_share = ? WHERE id = ?")
    .run(variant.status, variant.traffic_share, variant.id);
}

function agentTypeForSkillName(skillName: string): string {
  return skillName.startsWith("persona:") ? skillName.slice("persona:".length) : skillName;
}

function zeroTrafficStatus(status: VariantStatus): boolean {
  return status === "candidate" || status === "demoted" || status === "retired";
}

function baselineCount(population: VariantRow[]): number {
  return population.filter((variant) => variant.status === "baseline").length;
}

function activeCount(population: VariantRow[]): number {
  return population.filter((variant) => ACTIVE_CAP_STATUSES.has(variant.status)).length;
}

function liveCount(population: VariantRow[]): number {
  return population.filter((variant) => LIVE_STATUSES.has(variant.status)).length;
}
