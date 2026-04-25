import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { DbClient } from "../../src/db/client";
import { AutoTuner, evaluateActiveVariant, evaluateAutoRetire, evaluateCandidate } from "../../src/orchestrator/auto-tuner";
import { freshDb, seedVariant } from "../helpers/population-fixtures";

const REWARD_KEYS = [
  "r_correctness",
  "r_simplicity",
  "r_alignment",
  "r_fidelity",
  "r_efficiency"
] as const;

function seedExperiment(db: DbClient, id: string): void {
  db.sqlite.query(`
    INSERT INTO experiments (
      id, hypothesis, skill_modified, agent_affected, change_description,
      metric_name, metric_before, status
    )
    VALUES (?, 'candidate may improve coder quality', 'persona:coder', 'coder', 'try candidate',
      'composite_reward', 0.5, 'proposed')
  `).run(id);
}

function linkExperiment(db: DbClient, candidateId: string, experimentId: string): void {
  db.sqlite
    .query("UPDATE skill_versions SET experiment_id = ? WHERE id = ?")
    .run(experimentId, candidateId);
}

function seedPopulation(db: DbClient, experimentId = "exp-candidate"): void {
  seedVariant(db, { id: "baseline", skill: "persona:coder", status: "baseline", share: 0.9 });
  seedVariant(db, { id: "candidate", skill: "persona:coder", status: "candidate", share: 0.0 });
  seedExperiment(db, experimentId);
  linkExperiment(db, "candidate", experimentId);
}

function seedActivePopulation(
  db: DbClient,
  input: { baselineShare?: number; activeShare?: number } = {}
): void {
  seedVariant(db, { id: "baseline", skill: "persona:coder", status: "baseline", share: input.baselineShare ?? 0.8 });
  seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: input.activeShare ?? 0.1 });
}

function rewardComponents(score: number, overrides: Partial<Record<typeof REWARD_KEYS[number], number>> = {}): Record<string, number> {
  return Object.fromEntries(REWARD_KEYS.map((key) => [key, overrides[key] ?? score]));
}

function seedShadowPair(
  db: DbClient,
  input: {
    index: number;
    candidateId?: string;
    baselineComposite: number;
    candidateComposite: number | null;
    baselineComponents?: Record<string, unknown>;
    candidateComponents?: Record<string, unknown> | null;
    error?: string;
  }
): void {
  const candidateId = input.candidateId ?? "candidate";
  db.appendEvent({
    id: `shadow-${candidateId}-${input.index}`,
    taskId: `task-${input.index}`,
    projectId: "autoforge",
    timestamp: new Date(2026, 3, 24, 12, input.index).toISOString(),
    agent: "orchestrator",
    type: "shadow_run_completed",
    status: input.error ? "done_with_concerns" : "done",
    payload: {
      task_id: `task-${input.index}`,
      agent_type: "coder",
      baseline_variant_id: "baseline",
      candidate_variant_id: candidateId,
      baseline_score_components: input.baselineComponents ?? rewardComponents(input.baselineComposite),
      baseline_composite: input.baselineComposite,
      candidate_score_components: input.candidateComponents ?? (
        input.candidateComposite === null ? null : rewardComponents(input.candidateComposite)
      ),
      candidate_composite: input.candidateComposite,
      error: input.error
    },
    budgetSeconds: 0
  });
}

function seedSelectedScoredTask(
  db: DbClient,
  input: {
    taskId: string;
    variantId: string;
    quality: "high" | "low";
    createdAt?: string;
    tier?: string;
    projectId?: string;
    rationale?: "baseline" | "exploitation" | "exploration";
  }
): void {
  const createdAt = input.createdAt ?? "2026-04-24T12:00:00.000Z";
  const projectId = input.projectId ?? "autoforge";
  const tier = input.tier ?? "STANDARD";
  db.sqlite.query(`
    INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
    VALUES (?, ?, 'quality task', ?, ?, '{}', '[]', ?, ?, ?)
  `).run(
    input.taskId,
    projectId,
    input.quality === "high" ? "completed" : "failed",
    tier,
    input.quality === "high" ? 0 : 5,
    createdAt,
    createdAt
  );

  db.insertTaskDiffStats(input.taskId, {
    files_changed: 1,
    files_added: 0,
    files_modified: 1,
    files_deleted: 0,
    lines_added: input.quality === "high" ? 0 : 1000,
    lines_deleted: 0,
    test_files_changed: 0
  });

  if (input.quality === "low") {
    db.sqlite.query(`
      INSERT INTO review_findings (id, task_id, severity, category, description)
      VALUES (?, ?, 'CRITICAL', 'correctness', 'blocking issue')
    `).run(randomUUID(), input.taskId);
    db.sqlite.query(`
      INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, estimated_cost)
      VALUES (?, ?, ?, ?, 'planner', 'planned', 'done_with_concerns', '{"planner_fallback":true}', 60, 10.0)
    `).run(randomUUID(), input.taskId, createdAt, projectId);
  }

  db.sqlite.query(`
    INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
    VALUES (?, ?, ?, ?, 'orchestrator', 'variant_selected', 'done', ?, 60)
  `).run(
    randomUUID(),
    input.taskId,
    createdAt,
    projectId,
    JSON.stringify({
      agent_type: "coder",
      selected_variant_id: input.variantId,
      selected_variant_specialty: null,
      eligible_variant_ids: [input.variantId],
      selection_rationale: input.rationale ?? "exploitation",
      shadow_variant_ids: [],
      injected_lesson_ids: []
    })
  );
}

function seedScoreSamples(
  db: DbClient,
  input: {
    activeQualities: Array<"high" | "low">;
    baselineQualities: Array<"high" | "low">;
    createdAt?: string;
  }
): void {
  input.activeQualities.forEach((quality, index) => {
    seedSelectedScoredTask(db, {
      taskId: `active-score-${index}`,
      variantId: "active",
      quality,
      createdAt: input.createdAt
    });
  });
  input.baselineQualities.forEach((quality, index) => {
    seedSelectedScoredTask(db, {
      taskId: `baseline-score-${index}`,
      variantId: "baseline",
      quality,
      createdAt: input.createdAt,
      rationale: "baseline"
    });
  });
}

function qualitySamples(highCount: number, lowCount: number): Array<"high" | "low"> {
  return [
    ...Array.from({ length: highCount }, (): "high" => "high"),
    ...Array.from({ length: lowCount }, (): "low" => "low")
  ];
}

function variantState(db: DbClient, id = "candidate"): { status: string; traffic_share: number } {
  return db.sqlite
    .query("SELECT status, traffic_share FROM skill_versions WHERE id = ?")
    .get(id) as { status: string; traffic_share: number };
}

function experimentStatus(db: DbClient, id = "exp-candidate"): string {
  const row = db.sqlite.query("SELECT status FROM experiments WHERE id = ?").get(id) as { status: string };
  return row.status;
}

function allocationPayloads(db: DbClient): Array<Record<string, unknown>> {
  return (db.sqlite
    .query("SELECT payload FROM events WHERE event_type = 'traffic_allocated' ORDER BY rowid ASC")
    .all() as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

function seedTrafficAllocatedEvent(
  db: DbClient,
  input: {
    variantId: string;
    timestamp: string;
    oldStatus: string;
    newStatus: string;
    oldTrafficShare: number;
    newTrafficShare: number;
    reason: string;
  }
): void {
  db.sqlite.query(`
    INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
    VALUES (?, ?, ?, 'allocation', 'orchestrator', 'traffic_allocated', 'done', ?, 0)
  `).run(
    randomUUID(),
    input.variantId,
    input.timestamp,
    JSON.stringify({
      variant_id: input.variantId,
      agent_type: "coder",
      old_status: input.oldStatus,
      new_status: input.newStatus,
      old_traffic_share: input.oldTrafficShare,
      new_traffic_share: input.newTrafficShare,
      reason: input.reason
    })
  );
}

function failExperimentStatusUpdates(db: DbClient, status: "active" | "discard"): void {
  db.sqlite.exec(`
    CREATE TRIGGER fail_experiment_${status}_status
    BEFORE UPDATE OF status ON experiments
    WHEN NEW.status = '${status}'
    BEGIN
      SELECT RAISE(FAIL, 'experiment status update failed');
    END;
  `);
}

function seedRawShadowPayload(db: DbClient, id: string, payload: string): void {
  db.sqlite.query(`
    INSERT INTO events (
      id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds
    )
    VALUES (?, ?, ?, 'autoforge', 'orchestrator', 'shadow_run_completed', 'done', ?, 0)
  `).run(id, id, new Date(2026, 3, 24, 11, 0).toISOString(), payload);
}

describe("evaluateCandidate", () => {
  test("graduates strong positive candidate to active traffic and marks experiment active", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 10; index += 1) {
      seedShadowPair(db, { index, baselineComposite: 0.5, candidateComposite: 0.8 });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision.kind).toBe("graduated");
    expect(variantState(db)).toEqual({ status: "active", traffic_share: 0.1 });
    expect(experimentStatus(db)).toBe("active");
    expect(allocationPayloads(db)).toMatchObject([
      {
        variant_id: "candidate",
        reason: "auto_graduation",
        new_status: "active",
        new_traffic_share: 0.1
      }
    ]);
  });

  test("rolls back graduation allocation when experiment status update fails", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 10; index += 1) {
      seedShadowPair(db, { index, baselineComposite: 0.5, candidateComposite: 0.8 });
    }
    failExperimentStatusUpdates(db, "active");

    expect(() => evaluateCandidate(db, "candidate")).toThrow("experiment status update failed");
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("proposed");
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("continues without duplicate allocation when candidate is already active", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 10; index += 1) {
      seedShadowPair(db, { index, baselineComposite: 0.5, candidateComposite: 0.8 });
    }
    expect(evaluateCandidate(db, "candidate").kind).toBe("graduated");

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "candidate_status_active" });
    expect(variantState(db)).toEqual({ status: "active", traffic_share: 0.1 });
    expect(allocationPayloads(db)).toHaveLength(1);
  });

  test("continues when high composite has a critical correctness regression", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 10; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: 0.9,
        baselineComponents: rewardComponents(0.8),
        candidateComponents: rewardComponents(0.95, { r_correctness: 0.6 })
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "critical_regression:r_correctness" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("proposed");
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("demotes after twenty valid paired observations fail graduation predicate", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 20; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: index % 2 === 0 ? 0.74 : 0.64
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision.kind).toBe("demoted");
    expect(decision.reason).toContain("failed_graduation_predicate");
    expect(variantState(db)).toEqual({ status: "demoted", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("discard");
    expect(allocationPayloads(db)).toMatchObject([
      {
        variant_id: "candidate",
        reason: "auto_demote",
        new_status: "demoted",
        new_traffic_share: 0
      }
    ]);
    expect(allocationPayloads(db)[0].supporting_metric).toMatchObject({
      reason: "failed_graduation_predicate",
      valid_pairs: 20
    });
  });

  test("rolls back demotion allocation when experiment status update fails", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 20; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: index % 2 === 0 ? 0.74 : 0.64
      });
    }
    failExperimentStatusUpdates(db, "discard");

    expect(() => evaluateCandidate(db, "candidate")).toThrow("experiment status update failed");
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("proposed");
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("demotes after five consecutive errored shadow runs", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 5; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: null,
        candidateComponents: null,
        error: "shadow failed"
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "demoted", reason: "shadow_repeatedly_failed" });
    expect(variantState(db)).toEqual({ status: "demoted", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("discard");
    expect(allocationPayloads(db)[0]).toMatchObject({
      reason: "auto_demote",
      supporting_metric: { reason: "shadow_repeatedly_failed", consecutive_errors: 5 }
    });
  });

  test("continues after five shadow runner configuration gaps", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 5; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: null,
        candidateComponents: null,
        error: "shadow_runner_not_configured"
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("proposed");
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("continues after five baseline-not-live comparison gaps", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 5; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: null,
        candidateComponents: null,
        error: "baseline_not_live"
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("proposed");
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("actual candidate runner errors still demote after five consecutive events", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 5; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: null,
        candidateComponents: null,
        error: "candidate runner crashed"
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "demoted", reason: "shadow_repeatedly_failed" });
    expect(variantState(db)).toEqual({ status: "demoted", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("discard");
    expect(allocationPayloads(db)[0]).toMatchObject({
      reason: "auto_demote",
      supporting_metric: { reason: "shadow_repeatedly_failed", consecutive_errors: 5 }
    });
  });

  test("mixed system gaps and candidate errors count only candidate errors", () => {
    const db = freshDb();
    seedPopulation(db);
    const errors = [
      "candidate runner crashed",
      "baseline_not_live",
      "candidate runner crashed",
      "shadow_runner_not_configured",
      "candidate runner crashed"
    ];
    errors.forEach((error, index) => {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: null,
        candidateComponents: null,
        error
      });
    });

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(experimentStatus(db)).toBe("proposed");
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("continues without duplicate allocation when candidate is already demoted", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 5; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: null,
        candidateComponents: null,
        error: "shadow failed"
      });
    }
    expect(evaluateCandidate(db, "candidate").kind).toBe("demoted");

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "candidate_status_demoted" });
    expect(variantState(db)).toEqual({ status: "demoted", traffic_share: 0.0 });
    expect(allocationPayloads(db)).toHaveLength(1);
  });

  test("non-consecutive shadow errors do not trigger repeated failure demotion", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 4; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.7,
        candidateComposite: null,
        candidateComponents: null,
        error: "shadow failed"
      });
    }
    seedShadowPair(db, { index: 4, baselineComposite: 0.7, candidateComposite: 0.8 });
    seedShadowPair(db, {
      index: 5,
      baselineComposite: 0.7,
      candidateComposite: null,
      candidateComponents: null,
      error: "shadow failed"
    });

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("continues without allocation when fewer than ten valid pairs exist", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 9; index += 1) {
      seedShadowPair(db, { index, baselineComposite: 0.5, candidateComposite: 0.8 });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("does not count errored runs toward valid observation threshold", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 9; index += 1) {
      seedShadowPair(db, { index, baselineComposite: 0.5, candidateComposite: 0.8 });
    }
    seedShadowPair(db, {
      index: 9,
      baselineComposite: 0.5,
      candidateComposite: null,
      candidateComponents: null,
      error: "shadow failed"
    });

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("does not count baseline_not_live shadow runs as valid candidate evidence", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 9; index += 1) {
      seedShadowPair(db, { index, baselineComposite: 0.5, candidateComposite: 0.8 });
    }
    seedShadowPair(db, {
      index: 9,
      baselineComposite: 0.5,
      candidateComposite: null,
      candidateComponents: null,
      error: "baseline_not_live"
    });

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("does not graduate candidate from placeholder shadow evidence", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 10; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.5,
        candidateComposite: 0.8,
        candidateComponents: { placeholder: true }
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
    expect(variantState(db)).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("skips corrupt and non-object shadow payloads without throwing", () => {
    const db = freshDb();
    seedPopulation(db);
    seedRawShadowPayload(db, "shadow-null", "null");
    seedRawShadowPayload(db, "shadow-array", "[]");
    seedRawShadowPayload(db, "shadow-string", "\"candidate\"");
    seedRawShadowPayload(db, "shadow-invalid", "{");
    seedShadowPair(db, { index: 1, baselineComposite: 0.5, candidateComposite: 0.8 });

    expect(db.loadShadowPairs("candidate")).toHaveLength(1);
    expect(evaluateCandidate(db, "candidate")).toEqual({ kind: "continue", reason: "insufficient_valid_pairs" });
  });

  test("asymmetric missing reward terms do not create synthetic critical regressions", () => {
    const db = freshDb();
    seedPopulation(db);
    for (let index = 0; index < 10; index += 1) {
      seedShadowPair(db, {
        index,
        baselineComposite: 0.5,
        candidateComposite: 0.8,
        baselineComponents: rewardComponents(0.8),
        candidateComponents: {
          r_simplicity: 0.9,
          r_alignment: 0.9,
          r_fidelity: 0.9,
          r_efficiency: 0.9
        }
      });
    }

    const decision = evaluateCandidate(db, "candidate");

    expect(decision.kind).toBe("graduated");
    expect(variantState(db)).toEqual({ status: "active", traffic_share: 0.1 });
  });

  test("returns continue safely for an unknown candidate id", () => {
    const db = freshDb();

    expect(evaluateCandidate(db, "missing")).toEqual({ kind: "continue", reason: "candidate_not_found" });
  });
});

describe("evaluateActiveVariant", () => {
  test("strongly better active variant gets auto_promote and share plus 0.05", () => {
    const db = freshDb();
    seedActivePopulation(db);
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "high"),
      baselineQualities: Array.from({ length: 30 }, () => "low")
    });

    const decision = evaluateActiveVariant(db, "active");

    expect(decision.kind).toBe("promoted");
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.15 });
    expect(allocationPayloads(db)).toMatchObject([
      {
        variant_id: "active",
        reason: "auto_promote",
        old_traffic_share: 0.1,
        new_traffic_share: 0.15
      }
    ]);
  });

  test("ten strong active scores continue without allocation", () => {
    const db = freshDb();
    seedActivePopulation(db);
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 10 }, () => "high"),
      baselineQualities: Array.from({ length: 10 }, () => "low")
    });

    const decision = evaluateActiveVariant(db, "active");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_recent_scores" });
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.1 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("repeated promote over unchanged evidence continues without another allocation event", () => {
    const db = freshDb();
    seedActivePopulation(db);
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "high"),
      baselineQualities: Array.from({ length: 30 }, () => "low")
    });

    expect(evaluateActiveVariant(db, "active").kind).toBe("promoted");
    const decision = evaluateActiveVariant(db, "active");

    expect(decision).toEqual({ kind: "continue", reason: "no_new_evidence" });
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.15 });
    expect(allocationPayloads(db).filter((payload) => payload.reason === "auto_promote")).toHaveLength(1);
  });

  test("strongly worse active variant gets auto_demote and share minus 0.05", () => {
    const db = freshDb();
    seedActivePopulation(db);
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "low"),
      baselineQualities: Array.from({ length: 30 }, () => "high")
    });

    const decision = evaluateActiveVariant(db, "active");

    expect(decision.kind).toBe("demoted");
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.05 });
    expect(allocationPayloads(db)).toMatchObject([
      {
        variant_id: "active",
        reason: "auto_demote",
        old_traffic_share: 0.1,
        new_traffic_share: 0.05
      }
    ]);
  });

  test("repeated demote over unchanged evidence continues without another allocation event", () => {
    const db = freshDb();
    seedActivePopulation(db);
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "low"),
      baselineQualities: Array.from({ length: 30 }, () => "high")
    });

    expect(evaluateActiveVariant(db, "active").kind).toBe("demoted");
    const decision = evaluateActiveVariant(db, "active");

    expect(decision).toEqual({ kind: "continue", reason: "no_new_evidence" });
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.05 });
    expect(allocationPayloads(db).filter((payload) => payload.reason === "auto_demote")).toHaveLength(1);
  });

  test("demotion to zero transitions status to demoted", () => {
    const db = freshDb();
    seedActivePopulation(db, { activeShare: 0.05 });
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "low"),
      baselineQualities: Array.from({ length: 30 }, () => "high")
    });

    const decision = evaluateActiveVariant(db, "active");

    expect(decision.kind).toBe("demoted");
    expect(variantState(db, "active")).toEqual({ status: "demoted", traffic_share: 0 });
    expect(allocationPayloads(db)[0]).toMatchObject({
      reason: "auto_demote",
      new_status: "demoted",
      new_traffic_share: 0
    });
  });

  test("noisy no-effect active variant continues with no allocation event", () => {
    const db = freshDb();
    seedActivePopulation(db);
    seedScoreSamples(db, {
      activeQualities: qualitySamples(15, 15),
      baselineQualities: qualitySamples(15, 15)
    });

    const decision = evaluateActiveVariant(db, "active");

    expect(decision.kind).toBe("continue");
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.1 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("stale observations older than sixty days are ignored", () => {
    const db = freshDb();
    seedActivePopulation(db);
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "high"),
      baselineQualities: Array.from({ length: 30 }, () => "low"),
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    const decision = evaluateActiveVariant(db, "active");

    expect(decision).toEqual({ kind: "continue", reason: "insufficient_recent_scores" });
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.1 });
    expect(allocationPayloads(db)).toEqual([]);
  });

  test("baseline swap fires only after twenty consecutive dominance evaluations and emits baseline_swap events for both rows", () => {
    const db = freshDb();
    seedActivePopulation(db, { baselineShare: 0.5 });
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "high"),
      baselineQualities: Array.from({ length: 30 }, () => "low")
    });
    const tuner = new AutoTuner();

    for (let index = 0; index < 19; index += 1) {
      seedSelectedScoredTask(db, {
        taskId: `active-advancing-${index}`,
        variantId: "active",
        quality: "high",
        createdAt: new Date(Date.UTC(2026, 3, 24, 13, index)).toISOString()
      });
      tuner.evaluateActiveVariant(db, "active");
    }
    expect(allocationPayloads(db).filter((payload) => payload.reason === "baseline_swap")).toEqual([]);

    seedSelectedScoredTask(db, {
      taskId: "active-advancing-19",
      variantId: "active",
      quality: "high",
      createdAt: new Date(Date.UTC(2026, 3, 24, 13, 19)).toISOString()
    });
    const decision = tuner.evaluateActiveVariant(db, "active");

    expect(decision.kind).toBe("baseline_swapped");
    const swapPayloads = allocationPayloads(db).filter((payload) => payload.reason === "baseline_swap");
    expect(swapPayloads).toHaveLength(2);
    expect(swapPayloads).toMatchObject([
      { variant_id: "baseline", old_status: "baseline", new_status: "active" },
      { variant_id: "active", old_status: "active", new_status: "baseline" }
    ]);
  });

  test("exported evaluateActiveVariant preserves dominance state across advancing evidence", () => {
    const db = freshDb();
    seedVariant(db, { id: "baseline", skill: "persona:coder", status: "baseline", share: 0.5 });
    seedVariant(db, { id: "exported-active", skill: "persona:coder", status: "active", share: 0.1 });
    Array.from({ length: 30 }).forEach((_, index) => {
      seedSelectedScoredTask(db, {
        taskId: `exported-active-score-${index}`,
        variantId: "exported-active",
        quality: "high"
      });
      seedSelectedScoredTask(db, {
        taskId: `exported-baseline-score-${index}`,
        variantId: "baseline",
        quality: "low",
        rationale: "baseline"
      });
    });

    for (let index = 0; index < 19; index += 1) {
      seedSelectedScoredTask(db, {
        taskId: `exported-active-advancing-${index}`,
        variantId: "exported-active",
        quality: "high",
        createdAt: new Date(Date.UTC(2026, 3, 24, 14, index)).toISOString()
      });
      evaluateActiveVariant(db, "exported-active");
    }
    expect(allocationPayloads(db).filter((payload) => payload.reason === "baseline_swap")).toEqual([]);

    seedSelectedScoredTask(db, {
      taskId: "exported-active-advancing-19",
      variantId: "exported-active",
      quality: "high",
      createdAt: new Date(Date.UTC(2026, 3, 24, 14, 19)).toISOString()
    });
    const decision = evaluateActiveVariant(db, "exported-active");

    expect(decision.kind).toBe("baseline_swapped");
    expect(allocationPayloads(db).filter((payload) => payload.reason === "baseline_swap")).toHaveLength(2);
  });

  test("baseline swap does not fire before the twenty evaluation threshold", () => {
    const db = freshDb();
    seedActivePopulation(db, { baselineShare: 0.5 });
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "high"),
      baselineQualities: Array.from({ length: 30 }, () => "low")
    });
    const tuner = new AutoTuner();

    for (let index = 0; index < 19; index += 1) {
      seedSelectedScoredTask(db, {
        taskId: `active-pending-${index}`,
        variantId: "active",
        quality: "high",
        createdAt: new Date(Date.UTC(2026, 3, 24, 13, index)).toISOString()
      });
      tuner.evaluateActiveVariant(db, "active");
    }

    expect(allocationPayloads(db).filter((payload) => payload.reason === "baseline_swap")).toEqual([]);
    expect(variantState(db, "active").status).toBe("active");
  });

  test("baseline swap dominance does not advance on repeated unchanged evidence", () => {
    const db = freshDb();
    seedActivePopulation(db, { baselineShare: 0.5 });
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "high"),
      baselineQualities: Array.from({ length: 30 }, () => "low")
    });
    const tuner = new AutoTuner();

    for (let index = 0; index < 25; index += 1) {
      tuner.evaluateActiveVariant(db, "active");
    }

    expect(allocationPayloads(db).filter((payload) => payload.reason === "baseline_swap")).toEqual([]);
    expect(variantState(db, "active").status).toBe("active");
  });

  test("population cap allocation rejection is surfaced as continue without throwing", () => {
    const db = freshDb();
    seedActivePopulation(db, { baselineShare: 0.95, activeShare: 0.04 });
    seedScoreSamples(db, {
      activeQualities: Array.from({ length: 30 }, () => "high"),
      baselineQualities: Array.from({ length: 30 }, () => "low")
    });

    const decision = evaluateActiveVariant(db, "active");

    expect(decision).toEqual({ kind: "continue", reason: "baseline_exploration_reserved" });
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.04 });
    expect(allocationPayloads(db)).toEqual([]);
  });
});

describe("evaluateAutoRetire", () => {
  test("auto-retire transitions old demoted variant and preserves younger demoted variant", () => {
    const db = freshDb();
    seedVariant(db, { id: "baseline", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "old-demoted", skill: "persona:coder", status: "demoted", share: 0 });
    seedVariant(db, { id: "young-demoted", skill: "persona:coder", status: "demoted", share: 0 });
    db.sqlite.query("UPDATE skill_versions SET created_at = ? WHERE id = ?")
      .run("2025-12-01T00:00:00.000Z", "old-demoted");
    db.sqlite.query("UPDATE skill_versions SET created_at = ? WHERE id = ?")
      .run("2026-04-01T00:00:00.000Z", "young-demoted");
    seedTrafficAllocatedEvent(db, {
      variantId: "old-demoted",
      timestamp: "2025-12-01T00:00:00.000Z",
      oldStatus: "active",
      newStatus: "demoted",
      oldTrafficShare: 0.05,
      newTrafficShare: 0,
      reason: "auto_demote"
    });
    seedTrafficAllocatedEvent(db, {
      variantId: "young-demoted",
      timestamp: "2026-04-01T00:00:00.000Z",
      oldStatus: "active",
      newStatus: "demoted",
      oldTrafficShare: 0.05,
      newTrafficShare: 0,
      reason: "auto_demote"
    });

    const decisions = evaluateAutoRetire(db, new Date("2026-04-24T00:00:00.000Z"));

    expect(decisions).toEqual([{ kind: "retired", reason: "auto_retire:old-demoted" }]);
    expect(variantState(db, "old-demoted")).toEqual({ status: "retired", traffic_share: 0 });
    expect(variantState(db, "young-demoted")).toEqual({ status: "demoted", traffic_share: 0 });
    expect(allocationPayloads(db).filter((payload) => payload.reason === "auto_retire")).toMatchObject([
      {
        variant_id: "old-demoted",
        reason: "auto_retire",
        old_status: "demoted",
        new_status: "retired"
      }
    ]);
  });

  test("old variant demoted today is not retired", () => {
    const db = freshDb();
    seedVariant(db, { id: "baseline", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "old-demoted", skill: "persona:coder", status: "demoted", share: 0 });
    db.sqlite.query("UPDATE skill_versions SET created_at = ? WHERE id = ?")
      .run("2025-12-01T00:00:00.000Z", "old-demoted");
    seedTrafficAllocatedEvent(db, {
      variantId: "old-demoted",
      timestamp: "2026-04-24T00:00:00.000Z",
      oldStatus: "active",
      newStatus: "demoted",
      oldTrafficShare: 0.05,
      newTrafficShare: 0,
      reason: "auto_demote"
    });

    const decisions = evaluateAutoRetire(db, new Date("2026-04-24T00:00:00.000Z"));

    expect(decisions).toEqual([]);
    expect(variantState(db, "old-demoted")).toEqual({ status: "demoted", traffic_share: 0 });
  });

  test("old variant with demotion event older than ninety days is retired", () => {
    const db = freshDb();
    seedVariant(db, { id: "baseline", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "old-demoted", skill: "persona:coder", status: "demoted", share: 0 });
    db.sqlite.query("UPDATE skill_versions SET created_at = ? WHERE id = ?")
      .run("2026-04-01T00:00:00.000Z", "old-demoted");
    seedTrafficAllocatedEvent(db, {
      variantId: "old-demoted",
      timestamp: "2025-12-01T00:00:00.000Z",
      oldStatus: "active",
      newStatus: "demoted",
      oldTrafficShare: 0.05,
      newTrafficShare: 0,
      reason: "auto_demote"
    });

    const decisions = evaluateAutoRetire(db, new Date("2026-04-24T00:00:00.000Z"));

    expect(decisions).toEqual([{ kind: "retired", reason: "auto_retire:old-demoted" }]);
    expect(variantState(db, "old-demoted")).toEqual({ status: "retired", traffic_share: 0 });
  });

  test("demoted variant without demotion event is skipped", () => {
    const db = freshDb();
    seedVariant(db, { id: "baseline", skill: "persona:coder", status: "baseline", share: 0.8 });
    seedVariant(db, { id: "old-demoted", skill: "persona:coder", status: "demoted", share: 0 });
    db.sqlite.query("UPDATE skill_versions SET created_at = ? WHERE id = ?")
      .run("2025-12-01T00:00:00.000Z", "old-demoted");

    const decisions = evaluateAutoRetire(db, new Date("2026-04-24T00:00:00.000Z"));

    expect(decisions).toEqual([]);
    expect(variantState(db, "old-demoted")).toEqual({ status: "demoted", traffic_share: 0 });
  });
});
