import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";

function freshDb(): { db: DbClient; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reward-views-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );

  return {
    db,
    cleanup: () => {
      try {
        (db.sqlite as unknown as { close?: () => void }).close?.();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

function seedTerminalTask(db: DbClient, opts: {
  taskId: string;
  state: "completed" | "failed";
  tier: string;
  iteration: number;
  projectId?: string;
  findingCount?: number;
  blockingFindingCount?: number;
  diffLines?: number;
  totalCost?: number;
  plannerFallback?: boolean;
  planSubtaskCount?: number;
  actualSubtaskCount?: number;
  findingCategory?: string;
}): void {
  const projectId = opts.projectId ?? "p";
  const plan = opts.planSubtaskCount === undefined
    ? "[]"
    : JSON.stringify({ subtask_count: opts.planSubtaskCount });

  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES (?, ?, 'd', ?, ?, '{}', ?, ?, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
  ).run(opts.taskId, projectId, opts.state, opts.tier, plan, opts.iteration);

  if (opts.totalCost !== undefined) {
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, estimated_cost)
       VALUES (?, ?, '2026-04-19T00:01:00Z', ?, 'coder', 'subtask_done', 'done', '{}', 600, ?)`
    ).run(randomUUID(), opts.taskId, projectId, opts.totalCost);
  }

  for (let i = 0; i < (opts.findingCount ?? 0); i++) {
    const isBlocking = i < (opts.blockingFindingCount ?? 0);
    db.sqlite.query(
      `INSERT INTO review_findings (id, task_id, severity, category, description)
       VALUES (?, ?, ?, ?, 'y')`
    ).run(
      randomUUID(),
      opts.taskId,
      isBlocking ? "CRITICAL" : "MINOR",
      opts.findingCategory ?? "x"
    );
  }

  if (opts.diffLines !== undefined) {
    db.insertTaskDiffStats(opts.taskId, {
      files_changed: 1,
      files_added: 1,
      files_modified: 0,
      files_deleted: 0,
      lines_added: opts.diffLines,
      lines_deleted: 0,
      test_files_changed: 0
    });
  }

  for (let i = 0; i < (opts.actualSubtaskCount ?? 0); i++) {
    db.sqlite.query(
      `INSERT INTO subtasks (
         id, task_id, sequence, description, files_in_scope, dependencies, state, agent_type, budget_seconds
       ) VALUES (?, ?, ?, 'subtask', '[]', '[]', 'pending', 'coder', 600)`
    ).run(randomUUID(), opts.taskId, i);
  }

  if (opts.plannerFallback) {
    db.sqlite.query(
      `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
       VALUES (?, ?, '2026-04-19T00:02:00Z', ?, 'orchestrator', 'failure_analysis', 'failed',
               '{"planner_fallback":true}', 60)`
    ).run(randomUUID(), opts.taskId, projectId);
  }
}

function insertSkillVersion(
  db: DbClient,
  id: string,
  skillName: string,
  status: string,
  trafficShare: number,
  specialty: string | null = null
): void {
  db.sqlite.query(
    `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share, specialty)
     VALUES (?, ?, '1', 'content', ?, ?, ?)`
  ).run(id, skillName, status, trafficShare, specialty);
}

function insertVariantSelectedEvent(
  db: DbClient,
  taskId: string,
  projectId: string,
  agentType: string,
  variantId: string
): void {
  db.sqlite.query(
    `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
     VALUES (?, ?, '2026-04-19T00:03:00Z', ?, 'orchestrator', 'variant_selected', 'done',
             ?, 60)`
  ).run(
    randomUUID(),
    taskId,
    projectId,
    JSON.stringify({
      agent_type: agentType,
      selected_variant_id: variantId,
      selection_rationale: "only_eligible",
      shadow_variant_ids: []
    })
  );
}

function insertPlannedEvent(
  db: DbClient,
  taskId: string,
  projectId: string,
  plannerFallback: boolean
): void {
  db.sqlite.query(
    `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
     VALUES (?, ?, '2026-04-19T00:02:30Z', ?, 'planner', 'planned', ?, ?, 60)`
  ).run(
    randomUUID(),
    taskId,
    projectId,
    plannerFallback ? "done_with_concerns" : "done",
    JSON.stringify({
      planSubtasks: [],
      planner_fallback: plannerFallback,
      attempt: 0
    })
  );
}

describe("task_quality_score view", () => {
  test("a clean completed EXPRESS task scores max on correctness, efficiency", () => {
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t1",
        state: "completed",
        tier: "EXPRESS",
        iteration: 0,
        findingCount: 0,
        diffLines: 10,
        totalCost: 0.01
      });

      const row = db.sqlite
        .query("SELECT * FROM task_quality_score WHERE task_id = 't1'")
        .get() as {
          r_correctness: number;
          r_simplicity: number;
          r_alignment: number;
          r_fidelity: number;
          r_efficiency: number;
        };

      expect(row.r_correctness).toBeCloseTo(1.0);
      expect(row.r_simplicity).toBeCloseTo(0.833, 2);
      expect(row.r_alignment).toBeCloseTo(1.0);
      expect(row.r_fidelity).toBeCloseTo(1.0);
      expect(row.r_efficiency).toBeGreaterThan(0.5);
    } finally {
      cleanup();
    }
  });

  test("missing task_diff_stats row => r_simplicity = 0.5 (neutral)", () => {
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t2",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        findingCount: 0
      });

      const row = db.sqlite
        .query("SELECT r_simplicity FROM task_quality_score WHERE task_id = 't2'")
        .get() as { r_simplicity: number };

      expect(row.r_simplicity).toBeCloseTo(0.5);
    } finally {
      cleanup();
    }
  });

  test("blocking finding => r_correctness = 0 and r_alignment < 1", () => {
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t3",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        findingCount: 2,
        blockingFindingCount: 1,
        diffLines: 50,
        totalCost: 0.05
      });

      const row = db.sqlite
        .query("SELECT r_correctness, r_alignment FROM task_quality_score WHERE task_id = 't3'")
        .get() as { r_correctness: number; r_alignment: number };

      expect(row.r_correctness).toBe(0);
      expect(row.r_alignment).toBeCloseTo(0.5);
    } finally {
      cleanup();
    }
  });

  test("planner_fallback => r_fidelity decreases", () => {
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t4",
        state: "failed",
        tier: "STANDARD",
        iteration: 0,
        plannerFallback: true,
        diffLines: 30,
        totalCost: 0.03
      });

      const row = db.sqlite
        .query("SELECT r_fidelity FROM task_quality_score WHERE task_id = 't4'")
        .get() as { r_fidelity: number };

      expect(row.r_fidelity).toBeCloseTo(0.5);
    } finally {
      cleanup();
    }
  });

  test("planner_fallback from planned event reduces fidelity even on successful task", () => {
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t4b",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        diffLines: 30,
        totalCost: 0.03
      });
      insertPlannedEvent(db, "t4b", "p", true);

      const row = db.sqlite
        .query("SELECT r_fidelity FROM task_quality_score WHERE task_id = 't4b'")
        .get() as { r_fidelity: number };

      expect(row.r_fidelity).toBeCloseTo(0.5);
    } finally {
      cleanup();
    }
  });

  test("planner_fallback from off-list event types is ignored (Spec A review M1)", () => {
    // Regression guard for migration 006: only `failure_analysis` and `planned`
    // events should contribute to the planner_fallback fidelity penalty. If a
    // future event type happens to carry the key, it must not degrade fidelity.
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t4c",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        diffLines: 30,
        totalCost: 0.03
      });
      // Inject a bogus event carrying planner_fallback: true on a non-whitelisted type.
      db.sqlite.query(
        `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
         VALUES (?, 't4c', '2026-04-24T00:00:00Z', 'p', 'orchestrator', 'variant_selected', 'done',
                 '{"planner_fallback":true,"agent_type":"coder","selected_variant_id":"v"}', 60)`
      ).run(randomUUID());

      const row = db.sqlite
        .query("SELECT r_fidelity FROM task_quality_score WHERE task_id = 't4c'")
        .get() as { r_fidelity: number };

      expect(row.r_fidelity).toBeCloseTo(1.0);
    } finally {
      cleanup();
    }
  });

  test("checkpoint, steering, rollback, and lifecycle hook events do not affect fidelity", () => {
    const { db, cleanup } = freshDb();
    const ignoredTypes = [
      "checkpoint_created",
      "rollback_applied",
      "steering_message",
      "steering_consumed",
      "lifecycle_hook_completed",
      "lifecycle_hook_failed"
    ];

    try {
      seedTerminalTask(db, {
        taskId: "t4d",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        diffLines: 30,
        totalCost: 0.03
      });
      for (const type of ignoredTypes) {
        db.sqlite.query(
          `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
           VALUES (?, 't4d', '2026-04-24T00:00:00Z', 'p', 'orchestrator', ?, 'done', '{"planner_fallback":true}', 60)`
        ).run(randomUUID(), type);
      }

      const row = db.sqlite
        .query("SELECT r_fidelity FROM task_quality_score WHERE task_id = 't4d'")
        .get() as { r_fidelity: number };

      expect(row.r_fidelity).toBeCloseTo(1.0);
    } finally {
      cleanup();
    }
  });

  test("array-shaped persisted plan with matching subtasks does not count as scope drift", () => {
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t5",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        diffLines: 25,
        totalCost: 0.02,
        actualSubtaskCount: 2
      });
      db.sqlite.query(
        `UPDATE tasks
         SET plan = ?
         WHERE id = 't5'`
      ).run(JSON.stringify([
        { id: "p1", description: "first planned step" },
        { id: "p2", description: "second planned step" }
      ]));

      const row = db.sqlite
        .query("SELECT r_fidelity FROM task_quality_score WHERE task_id = 't5'")
        .get() as { r_fidelity: number };

      expect(row.r_fidelity).toBeCloseTo(1.0);
    } finally {
      cleanup();
    }
  });

  test("non-array persisted plan with subtasks remains neutral for scope drift", () => {
    const { db, cleanup } = freshDb();

    try {
      seedTerminalTask(db, {
        taskId: "t6",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        diffLines: 25,
        totalCost: 0.02,
        actualSubtaskCount: 2
      });
      db.sqlite.query(
        `UPDATE tasks
         SET plan = '{"subtask_count":2}'
         WHERE id = 't6'`
      ).run();

      const row = db.sqlite
        .query("SELECT r_fidelity FROM task_quality_score WHERE task_id = 't6'")
        .get() as { r_fidelity: number };

      expect(row.r_fidelity).toBeCloseTo(1.0);
    } finally {
      cleanup();
    }
  });
});

describe("variant_performance view", () => {
  test("returns per-variant aggregates", () => {
    const { db, cleanup } = freshDb();

    try {
      insertSkillVersion(db, "vCoder", "persona:coder", "baseline", 1.0, "backend");

      for (const taskId of ["qa1", "qa2"]) {
        seedTerminalTask(db, {
          taskId,
          state: "completed",
          tier: "STANDARD",
          iteration: 0,
          findingCount: 0,
          diffLines: 30,
          totalCost: 0.05
        });
        insertVariantSelectedEvent(db, taskId, "p", "coder", "vCoder");
      }

      const row = db.sqlite
        .query(
          "SELECT variant_name, specialty, status, agent_type, task_count, avg_correctness FROM variant_performance WHERE variant_id = 'vCoder'"
        )
        .get() as {
          variant_name: string;
          specialty: string | null;
          status: string;
          agent_type: string;
          task_count: number;
          avg_correctness: number;
        };

      expect(row.variant_name).toBe("persona:coder");
      expect(row.specialty).toBe("backend");
      expect(row.status).toBe("baseline");
      expect(row.agent_type).toBe("coder");
      expect(row.task_count).toBe(2);
      expect(row.avg_correctness).toBeCloseTo(1.0);
    } finally {
      cleanup();
    }
  });

  test("deduplicates repeated variant_selected events by task, variant, and agent", () => {
    const { db, cleanup } = freshDb();

    try {
      insertSkillVersion(db, "vCoderDedup", "persona:coder", "baseline", 1.0);

      seedTerminalTask(db, {
        taskId: "vd-success",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        diffLines: 20,
        totalCost: 0.02
      });
      seedTerminalTask(db, {
        taskId: "vd-fail",
        state: "failed",
        tier: "STANDARD",
        iteration: 0,
        findingCount: 1,
        blockingFindingCount: 1,
        diffLines: 20,
        totalCost: 0.02
      });

      insertVariantSelectedEvent(db, "vd-success", "p", "coder", "vCoderDedup");
      insertVariantSelectedEvent(db, "vd-success", "p", "coder", "vCoderDedup");
      insertVariantSelectedEvent(db, "vd-fail", "p", "coder", "vCoderDedup");

      const row = db.sqlite
        .query(
          "SELECT task_count, avg_correctness FROM variant_performance WHERE variant_id = 'vCoderDedup'"
        )
        .get() as {
          task_count: number;
          avg_correctness: number;
        };

      expect(row.task_count).toBe(2);
      expect(row.avg_correctness).toBeCloseTo(0.5);
    } finally {
      cleanup();
    }
  });
});

describe("niche_performance view", () => {
  test("returns rows grouped by tier, project, and finding category", () => {
    const { db, cleanup } = freshDb();

    try {
      insertSkillVersion(db, "vCoderNich", "persona:coder", "baseline", 1.0);
      seedTerminalTask(db, {
        taskId: "n1",
        state: "completed",
        tier: "EXPRESS",
        iteration: 0,
        projectId: "proj-niche",
        findingCount: 1,
        findingCategory: "logic",
        diffLines: 20,
        totalCost: 0.01
      });
      insertVariantSelectedEvent(db, "n1", "proj-niche", "coder", "vCoderNich");

      const rows = db.sqlite
        .query(
          "SELECT dimension, dimension_value FROM niche_performance WHERE variant_id = 'vCoderNich' ORDER BY dimension ASC"
        )
        .all() as Array<{ dimension: string; dimension_value: string }>;

      expect(rows).toEqual([
        { dimension: "finding_category", dimension_value: "logic" },
        { dimension: "project", dimension_value: "proj-niche" },
        { dimension: "tier", dimension_value: "EXPRESS" }
      ]);
    } finally {
      cleanup();
    }
  });
});

describe("population_health view", () => {
  test("returns a row per agent type with variant counts and aggregate columns", () => {
    const { db, cleanup } = freshDb();

    try {
      insertSkillVersion(db, "vBase", "persona:coder", "baseline", 1.0);
      insertSkillVersion(db, "vCand", "persona:coder", "candidate", 0.0);
      insertSkillVersion(db, "vRet", "persona:coder", "retired", 0.0);

      seedTerminalTask(db, {
        taskId: "ph1",
        state: "completed",
        tier: "STANDARD",
        iteration: 0,
        diffLines: 30,
        totalCost: 0.05
      });
      insertVariantSelectedEvent(db, "ph1", "p", "coder", "vBase");

      const row = db.sqlite
        .query(
          `SELECT
             active_variant_count,
             candidate_variant_count,
             retired_variant_count,
             total_allocated_share,
             ensemble_avg_correctness,
             ensemble_avg_simplicity,
             ensemble_avg_alignment,
             ensemble_avg_fidelity,
             ensemble_avg_efficiency
           FROM population_health
           WHERE agent_type = 'coder'`
        )
        .get() as {
          active_variant_count: number;
          candidate_variant_count: number;
          retired_variant_count: number;
          total_allocated_share: number;
          ensemble_avg_correctness: number;
          ensemble_avg_simplicity: number;
          ensemble_avg_alignment: number;
          ensemble_avg_fidelity: number;
          ensemble_avg_efficiency: number;
        };

      expect(row.active_variant_count).toBe(1);
      expect(row.candidate_variant_count).toBe(1);
      expect(row.retired_variant_count).toBe(1);
      expect(row.total_allocated_share).toBeCloseTo(1.0);
      expect(row.ensemble_avg_correctness).toBeCloseTo(1.0);
      expect(row.ensemble_avg_simplicity).toBeGreaterThan(0);
      expect(row.ensemble_avg_alignment).toBeCloseTo(1.0);
      expect(row.ensemble_avg_fidelity).toBeCloseTo(1.0);
      expect(row.ensemble_avg_efficiency).toBeGreaterThan(0.5);
    } finally {
      cleanup();
    }
  });
});

describe("agent_performance (existing view) unchanged", () => {
  test("view still returns rows after all migrations", () => {
    const { db, cleanup } = freshDb();

    try {
      insertSkillVersion(db, "vAP", "persona:coder", "baseline", 1.0);
      db.sqlite.query(
        `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
         VALUES ('tAP', 'p', 'd', 'completed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
      ).run();
      db.sqlite.query(
        `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, estimated_cost)
         VALUES ('eAP', 'tAP', '2026-04-19T00:01:00Z', 'p', 'coder', 'subtask_done', 'done',
                 '{"persona_version_id":"vAP"}', 600, 0.02)`
      ).run();

      const rows = db.sqlite
        .query("SELECT * FROM agent_performance WHERE persona_version_id = 'vAP'")
        .all();

      expect(rows).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
