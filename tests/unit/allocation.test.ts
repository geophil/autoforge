import { describe, expect, test } from "bun:test";
import { adjustVariantAllocation } from "../../src/orchestrator/allocation";
import { freshDb, seedVariant } from "../helpers/population-fixtures";

function variantState(db: ReturnType<typeof freshDb>, id: string): { status: string; traffic_share: number } {
  return db.sqlite
    .query("SELECT status, traffic_share FROM skill_versions WHERE id = ?")
    .get(id) as { status: string; traffic_share: number };
}

function allocationEvents(db: ReturnType<typeof freshDb>): Array<{ task_id: string; payload: string }> {
  return db.sqlite
    .query("SELECT task_id, payload FROM events WHERE event_type = 'traffic_allocated' ORDER BY rowid ASC")
    .all() as Array<{ task_id: string; payload: string }>;
}

function stripAnalyticsMarker(payload: Record<string, unknown>): Record<string, unknown> {
  // `__analytics_only` is an internal hint to DbClient.applyEvent so reads of
  // event payloads in tests should compare the observable shape only.
  const { __analytics_only: _ignored, ...rest } = payload;
  return rest;
}

function parsedAllocationEvents(db: ReturnType<typeof freshDb>): Array<Record<string, unknown>> {
  return allocationEvents(db).map((event) => stripAnalyticsMarker(JSON.parse(event.payload) as Record<string, unknown>));
}

describe("adjustVariantAllocation", () => {
  test("rejects candidate promotion above zero outside graduation", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 1.0 });
    seedVariant(db, { id: "cand", skill: "persona:coder", status: "candidate", share: 0.0 });

    const result = adjustVariantAllocation(db, "cand", { kind: "promote", delta: 0.1 }, "meta_promote");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_requires_graduation");
    expect(variantState(db, "cand")).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationEvents(db)).toHaveLength(0);
  });

  test("graduates candidate to active with requested traffic share", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.9 });
    seedVariant(db, { id: "cand", skill: "persona:coder", status: "candidate", share: 0.0 });

    const result = adjustVariantAllocation(db, "cand", { kind: "graduate", newTrafficShare: 0.1 }, "auto_graduation");

    expect(result.ok).toBe(true);
    expect(variantState(db, "cand")).toEqual({ status: "active", traffic_share: 0.1 });
  });

  test("demotes active to zero and status demoted", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.2 });

    const result = adjustVariantAllocation(db, "active", { kind: "demote", delta: 0.2 }, "meta_demote");

    expect(result.ok).toBe(true);
    expect(variantState(db, "active")).toEqual({ status: "demoted", traffic_share: 0.0 });
  });

  test("promotes demoted variant with positive delta to active traffic", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "demoted", skill: "persona:coder", status: "demoted", share: 0.0 });

    const result = adjustVariantAllocation(db, "demoted", { kind: "promote", delta: 0.1 }, "meta_promote");

    expect(result.ok).toBe(true);
    expect(variantState(db, "demoted")).toEqual({ status: "active", traffic_share: 0.1 });
  });

  test("promoting demoted variant with zero delta keeps it demoted at zero traffic", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "demoted", skill: "persona:coder", status: "demoted", share: 0.0 });

    const result = adjustVariantAllocation(db, "demoted", { kind: "promote", delta: 0.0 }, "meta_promote");

    expect(result.ok).toBe(true);
    expect(variantState(db, "demoted")).toEqual({ status: "demoted", traffic_share: 0.0 });
  });

  test("rejects baseline below 0.5", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.6 });

    const result = adjustVariantAllocation(db, "base", { kind: "demote", delta: 0.2 }, "meta_demote");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("baseline_minimum_share");
    expect(variantState(db, "base")).toEqual({ status: "baseline", traffic_share: 0.6 });
  });

  test("rejects traffic shares below zero or above one", () => {
    const negativeDb = freshDb();
    seedVariant(negativeDb, { id: "base", skill: "persona:coder", status: "baseline", share: 0.9 });
    seedVariant(negativeDb, { id: "active", skill: "persona:coder", status: "active", share: 0.1 });

    const negative = adjustVariantAllocation(
      negativeDb,
      "active",
      { kind: "set_status", newStatus: "active", newTrafficShare: -0.1 },
      "meta_demote"
    );

    expect(negative.ok).toBe(false);
    expect(negative.reason).toBe("traffic_share_out_of_range");
    expect(variantState(negativeDb, "active")).toEqual({ status: "active", traffic_share: 0.1 });

    const aboveOneDb = freshDb();
    seedVariant(aboveOneDb, { id: "base", skill: "persona:coder", status: "baseline", share: 0.9 });

    const aboveOne = adjustVariantAllocation(aboveOneDb, "base", { kind: "promote", delta: 0.2 }, "meta_promote");

    expect(aboveOne.ok).toBe(false);
    expect(aboveOne.reason).toBe("traffic_share_out_of_range");
    expect(variantState(aboveOneDb, "base")).toEqual({ status: "baseline", traffic_share: 0.9 });
  });

  test("rejects non-finite allocation inputs", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.2 });

    const promoteResult = adjustVariantAllocation(
      db,
      "active",
      { kind: "promote", delta: Number.POSITIVE_INFINITY },
      "meta_promote"
    );
    const setStatusResult = adjustVariantAllocation(
      db,
      "active",
      { kind: "set_status", newStatus: "active", newTrafficShare: Number.NaN },
      "meta_promote"
    );

    expect(promoteResult.ok).toBe(false);
    expect(promoteResult.reason).toBe("traffic_delta_out_of_range");
    expect(setStatusResult.ok).toBe(false);
    expect(setStatusResult.reason).toBe("traffic_share_out_of_range");
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.2 });
  });

  test("rejects negative promote and demote deltas", () => {
    const promoteDb = freshDb();
    seedVariant(promoteDb, { id: "base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(promoteDb, { id: "active", skill: "persona:coder", status: "active", share: 0.2 });

    const promote = adjustVariantAllocation(
      promoteDb,
      "active",
      { kind: "promote", delta: -0.1 },
      "meta_promote"
    );

    expect(promote.ok).toBe(false);
    expect(promote.reason).toBe("traffic_delta_out_of_range");
    expect(variantState(promoteDb, "active")).toEqual({ status: "active", traffic_share: 0.2 });

    const demoteDb = freshDb();
    seedVariant(demoteDb, { id: "base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(demoteDb, { id: "active", skill: "persona:coder", status: "active", share: 0.2 });

    const demote = adjustVariantAllocation(
      demoteDb,
      "active",
      { kind: "demote", delta: -0.1 },
      "meta_demote"
    );

    expect(demote.ok).toBe(false);
    expect(demote.reason).toBe("traffic_delta_out_of_range");
    expect(variantState(demoteDb, "active")).toEqual({ status: "active", traffic_share: 0.2 });
  });

  test("rejects baseline above 0.9 when population reserves exploration traffic", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.85 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.15 });

    const result = adjustVariantAllocation(db, "base", { kind: "promote", delta: 0.1 }, "meta_promote");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("baseline_exploration_reserved");
    expect(variantState(db, "base")).toEqual({ status: "baseline", traffic_share: 0.85 });
  });

  test("rejects retiring sole baseline", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 1.0 });

    const result = adjustVariantAllocation(db, "base", { kind: "set_status", newStatus: "retired" }, "meta_retire");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sole_baseline_retirement");
    expect(variantState(db, "base")).toEqual({ status: "baseline", traffic_share: 1.0 });
  });

  test("rejects creating a second baseline through set_status", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.7 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.3 });

    const result = adjustVariantAllocation(
      db,
      "active",
      { kind: "set_status", newStatus: "baseline", newTrafficShare: 0.5 },
      "meta_promote"
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exactly_one_baseline_required");
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.3 });
  });

  test("set_status to candidate normalizes retained and explicit traffic to zero", () => {
    const retainDb = freshDb();
    seedVariant(retainDb, { id: "base", skill: "persona:coder", status: "baseline", share: 0.7 });
    seedVariant(retainDb, { id: "active", skill: "persona:coder", status: "active", share: 0.3 });

    const retained = adjustVariantAllocation(
      retainDb,
      "active",
      { kind: "set_status", newStatus: "candidate" },
      "meta_demote"
    );

    expect(retained.ok).toBe(true);
    expect(variantState(retainDb, "active")).toEqual({ status: "candidate", traffic_share: 0.0 });

    const explicitDb = freshDb();
    seedVariant(explicitDb, { id: "base", skill: "persona:coder", status: "baseline", share: 0.7 });
    seedVariant(explicitDb, { id: "active", skill: "persona:coder", status: "active", share: 0.3 });

    const explicit = adjustVariantAllocation(
      explicitDb,
      "active",
      { kind: "set_status", newStatus: "candidate", newTrafficShare: 0.2 },
      "meta_demote"
    );

    expect(explicit.ok).toBe(true);
    expect(variantState(explicitDb, "active")).toEqual({ status: "candidate", traffic_share: 0.0 });
  });

  test("set_status to demoted results in zero traffic", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.7 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.3 });

    const result = adjustVariantAllocation(db, "active", { kind: "set_status", newStatus: "demoted" }, "meta_demote");

    expect(result.ok).toBe(true);
    expect(variantState(db, "active")).toEqual({ status: "demoted", traffic_share: 0.0 });
  });

  test("set_status to retired results in zero traffic even when a share is supplied", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.7 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.3 });

    const result = adjustVariantAllocation(
      db,
      "active",
      { kind: "set_status", newStatus: "retired", newTrafficShare: 0.2 },
      "meta_retire"
    );

    expect(result.ok).toBe(true);
    expect(variantState(db, "active")).toEqual({ status: "retired", traffic_share: 0.0 });
  });

  test("rejects resurrecting retired variant", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 1.0 });
    seedVariant(db, { id: "old", skill: "persona:coder", status: "retired", share: 0.0 });

    const result = adjustVariantAllocation(
      db,
      "old",
      { kind: "set_status", newStatus: "active", newTrafficShare: 0.1 },
      "meta_promote"
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("retired_variant_immutable");
    expect(variantState(db, "old")).toEqual({ status: "retired", traffic_share: 0.0 });
  });

  test("rejects activating beyond population cap of 5 active or baseline variants per skill", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.5 });
    for (let i = 1; i <= 4; i += 1) {
      seedVariant(db, { id: `active-${i}`, skill: "persona:coder", status: "active", share: 0.1 });
    }
    seedVariant(db, { id: "cand", skill: "persona:coder", status: "candidate", share: 0.0 });

    const result = adjustVariantAllocation(db, "cand", { kind: "graduate", newTrafficShare: 0.1 }, "auto_graduation");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("population_cap_exceeded");
    expect(variantState(db, "cand")).toEqual({ status: "candidate", traffic_share: 0.0 });
  });

  test("does not count candidates toward active or baseline population cap", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.7 });
    for (let i = 1; i <= 3; i += 1) {
      seedVariant(db, { id: `active-${i}`, skill: "persona:coder", status: "active", share: 0.1 });
    }
    seedVariant(db, { id: "cand", skill: "persona:coder", status: "candidate", share: 0.0 });
    seedVariant(db, { id: "other-cand-1", skill: "persona:coder", status: "candidate", share: 0.0 });
    seedVariant(db, { id: "other-cand-2", skill: "persona:coder", status: "candidate", share: 0.0 });

    const result = adjustVariantAllocation(db, "cand", { kind: "graduate", newTrafficShare: 0.1 }, "auto_graduation");

    expect(result.ok).toBe(true);
    expect(variantState(db, "cand")).toEqual({ status: "active", traffic_share: 0.1 });
  });

  test("rejects baseline_swap when the new baseline is still a candidate", () => {
    const db = freshDb();
    seedVariant(db, { id: "old-base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "candidate", skill: "persona:coder", status: "candidate", share: 0.0 });

    const result = adjustVariantAllocation(
      db,
      "old-base",
      { kind: "baseline_swap", newBaselineId: "candidate" },
      "baseline_swap"
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_requires_graduation");
    expect(variantState(db, "old-base")).toEqual({ status: "baseline", traffic_share: 0.8 });
    expect(variantState(db, "candidate")).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationEvents(db)).toHaveLength(0);
  });

  test("baseline_swap atomically makes the new baseline and old baseline active at share 0.4", () => {
    const db = freshDb();
    seedVariant(db, { id: "old-base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "new-base", skill: "persona:coder", status: "active", share: 0.3 });

    const result = adjustVariantAllocation(db, "old-base", { kind: "baseline_swap", newBaselineId: "new-base" }, "baseline_swap");

    expect(result.ok).toBe(true);
    expect(variantState(db, "old-base")).toEqual({ status: "active", traffic_share: 0.4 });
    expect(variantState(db, "new-base")).toEqual({ status: "baseline", traffic_share: 0.5 });
    const baselineCount = db.sqlite
      .query("SELECT COUNT(*) AS n FROM skill_versions WHERE skill_name = 'persona:coder' AND status = 'baseline'")
      .get() as { n: number };
    expect(baselineCount.n).toBe(1);
  });

  test("baseline_swap emits traffic_allocated events for both changed variants", () => {
    const db = freshDb();
    seedVariant(db, { id: "old-base", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "new-base", skill: "persona:coder", status: "active", share: 0.3 });

    const result = adjustVariantAllocation(
      db,
      "old-base",
      { kind: "baseline_swap", newBaselineId: "new-base" },
      "baseline_swap",
      { dominance_window: 20 }
    );

    expect(result.ok).toBe(true);
    expect(parsedAllocationEvents(db)).toEqual([
      {
        variant_id: "old-base",
        agent_type: "coder",
        old_status: "baseline",
        new_status: "active",
        old_traffic_share: 0.8,
        new_traffic_share: 0.4,
        reason: "baseline_swap",
        supporting_metric: { dominance_window: 20 }
      },
      {
        variant_id: "new-base",
        agent_type: "coder",
        old_status: "active",
        new_status: "baseline",
        old_traffic_share: 0.3,
        new_traffic_share: 0.5,
        reason: "baseline_swap",
        supporting_metric: { dominance_window: 20 }
      }
    ]);
  });

  test("emits traffic_allocated event with old and new allocation details when a write succeeds", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.9 });
    seedVariant(db, { id: "cand", skill: "persona:coder", status: "candidate", share: 0.0 });

    const result = adjustVariantAllocation(
      db,
      "cand",
      { kind: "graduate", newTrafficShare: 0.1 },
      "auto_graduation",
      { test: "wilcoxon_paired", p_value: 0.03 }
    );

    expect(result.ok).toBe(true);
    const events = allocationEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].task_id).toBe("cand");
    expect(stripAnalyticsMarker(JSON.parse(events[0].payload) as Record<string, unknown>)).toEqual({
      variant_id: "cand",
      agent_type: "coder",
      old_status: "candidate",
      new_status: "active",
      old_traffic_share: 0.0,
      new_traffic_share: 0.1,
      reason: "auto_graduation",
      supporting_metric: { test: "wilcoxon_paired", p_value: 0.03 }
    });
  });
});
