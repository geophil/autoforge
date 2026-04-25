import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { handleMetaOperation } from "../../src/orchestrator/meta-operations";
import type { MetaOperation } from "../../src/schemas/meta-output";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "meta-ops-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function seedVariant(
  db: DbClient,
  id: string,
  skill: string,
  status: "baseline" | "candidate" | "active" | "demoted" | "retired" = "baseline",
  share = 1.0
): void {
  db.sqlite.query(
    `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
     VALUES (?, ?, '1', 'seed-content', ?, ?)`
  ).run(id, skill, status, share);
}

function makeWorktreeWithProposal(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "meta-worktree-"));
  writeFileSync(join(dir, "proposed-persona.md"), content);
  return dir;
}

function variantState(db: DbClient, id: string): { status: string; traffic_share: number } {
  return db.sqlite
    .query("SELECT status, traffic_share FROM skill_versions WHERE id = ?")
    .get(id) as { status: string; traffic_share: number };
}

function experimentCount(db: DbClient): number {
  return (db.sqlite.query("SELECT COUNT(*) AS n FROM experiments").get() as { n: number }).n;
}

function allocationEventsFor(db: DbClient, variantId: string): Array<{
  type: string;
  payload: Record<string, unknown>;
}> {
  return db.listEvents(variantId).filter((event) => event.type === "traffic_allocated");
}

function seedTask(db: DbClient, id = "t1"): void {
  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES (?,'p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))`
  ).run(id);
}

function seedLesson(db: DbClient, variantId: string, taskId = "t1"): string {
  return db.insertLesson({
    agentType: "coder",
    lineageRootId: variantId,
    sourceTaskId: taskId,
    sourceVariantId: variantId,
    triggerPattern: "p",
    body: "b",
    outcomeKind: "corrective"
  });
}

function forceExperimentInsertionFailure(db: DbClient): void {
  db.insertMetaOperationExperiment = (() => {
    throw new Error("forced_experiment_insert_failure");
  }) as DbClient["insertMetaOperationExperiment"];
}

describe("handleMetaOperation — edit", () => {
  test("creates a candidate skill_versions row pointing at target", () => {
    const db = freshDb();
    seedVariant(db, "vOrig", "persona:coder");
    const worktree = makeWorktreeWithProposal("# New coder persona");

    const op: MetaOperation = {
      kind: "edit",
      target_variant_id: "vOrig",
      hypothesis: "clearer role statement",
      evidence: { task_ids: ["t1"] },
      proposed_content_file: "proposed-persona.md"
    };

    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt1", worktreePath: worktree, projectId: "p"
    });
    expect(res.ok).toBe(true);
    expect(res.experimentId).toBeDefined();
    const experimentId = res.experimentId as string;

    const exp = db.sqlite.query("SELECT operation, evidence, proposed_content, status FROM experiments WHERE id = ?")
      .get(experimentId) as { operation: string; evidence: string; proposed_content: string; status: string };
    expect(exp.operation).toBe("edit");
    expect(exp.proposed_content).toBe("# New coder persona");
    expect(exp.status).toBe("active");

    const cand = db.sqlite.query(
      "SELECT id, parent_version_id, status, traffic_share FROM skill_versions WHERE skill_name = 'persona:coder' AND content = '# New coder persona'"
    ).get() as { id: string; parent_version_id: string; status: string; traffic_share: number };
    expect(cand.parent_version_id).toBe("vOrig");
    expect(cand.status).toBe("candidate");
    expect(cand.traffic_share).toBe(0.0);
  });
});

describe("handleMetaOperation — promote/demote baseline protection", () => {
  test("demote below 0.5 on baseline fails", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);

    const op: MetaOperation = {
      kind: "demote",
      target_variant_id: "vBase",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      traffic_share: 0.2
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt2", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("baseline_minimum_share");
    const row = db.sqlite.query("SELECT traffic_share FROM skill_versions WHERE id='vBase'").get() as { traffic_share: number };
    expect(row.traffic_share).toBe(1.0);
  });

  test("promote candidate above 1.0 fails", () => {
    const db = freshDb();
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
    const op: MetaOperation = {
      kind: "promote",
      target_variant_id: "vCand",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      traffic_share: 1.5
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt3", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(false);
  });

  test("promote candidate to nonzero traffic fails before shadow graduation", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
    const op: MetaOperation = {
      kind: "promote",
      target_variant_id: "vCand",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      traffic_share: 0.1
    };

    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt-candidate-promote", worktreePath: "/tmp/nope", projectId: "p"
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/candidate/);
    const row = db.sqlite.query("SELECT traffic_share FROM skill_versions WHERE id='vCand'")
      .get() as { traffic_share: number };
    expect(row.traffic_share).toBe(0.0);
  });

  test("baseline promote cannot consume the exploration bucket once population exists", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 0.8);
    seedVariant(db, "vActive", "persona:coder", "active", 0.2);
    const op: MetaOperation = {
      kind: "promote",
      target_variant_id: "vBase",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      traffic_share: 1.0
    };

    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt-baseline-promote", worktreePath: "/tmp/nope", projectId: "p"
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/exploration/);
    const row = db.sqlite.query("SELECT traffic_share FROM skill_versions WHERE id='vBase'")
      .get() as { traffic_share: number };
    expect(row.traffic_share).toBe(0.8);
  });
});

describe("handleMetaOperation — allocation routing", () => {
  test("meta promote emits traffic_allocated through allocation path", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 0.8);
    seedVariant(db, "active", "persona:coder", "active", 0.2);

    const result = handleMetaOperation({
      db,
      operation: {
        kind: "promote",
        target_variant_id: "active",
        traffic_share: 0.25,
        hypothesis: "h",
        evidence: { task_ids: ["t1"] }
      },
      metaTaskId: "meta-promote",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(result.ok).toBe(true);
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.25 });
    const events = allocationEventsFor(db, "active");
    expect(events).toHaveLength(1);
    expect(events[0].payload.reason).toBe("meta_promote");
    expect(events[0].payload.supporting_metric).toEqual({ meta_task_id: "meta-promote" });
    expect(experimentCount(db)).toBe(1);
  });

  test("meta demote emits traffic_allocated and updates share/status through allocation", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 0.8);
    seedVariant(db, "active", "persona:coder", "active", 0.2);

    const result = handleMetaOperation({
      db,
      operation: {
        kind: "demote",
        target_variant_id: "active",
        traffic_share: 0,
        hypothesis: "h",
        evidence: { task_ids: ["t1"] }
      },
      metaTaskId: "meta-demote",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(result.ok).toBe(true);
    expect(variantState(db, "active")).toEqual({ status: "demoted", traffic_share: 0 });
    const events = allocationEventsFor(db, "active");
    expect(events).toHaveLength(1);
    expect(events[0].payload.reason).toBe("meta_demote");
    expect(events[0].payload.new_status).toBe("demoted");
    expect(experimentCount(db)).toBe(1);
  });

  test("meta retire emits traffic_allocated and retires through allocation", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 0.8);
    seedVariant(db, "active", "persona:coder", "active", 0.2);

    const result = handleMetaOperation({
      db,
      operation: {
        kind: "retire",
        target_variant_id: "active",
        hypothesis: "h",
        evidence: { task_ids: ["t1"] }
      },
      metaTaskId: "meta-retire",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(result.ok).toBe(true);
    expect(variantState(db, "active")).toEqual({ status: "retired", traffic_share: 0 });
    const events = allocationEventsFor(db, "active");
    expect(events).toHaveLength(1);
    expect(events[0].payload.reason).toBe("meta_retire");
    expect(events[0].payload.new_status).toBe("retired");
    expect(experimentCount(db)).toBe(1);
  });

  test("meta retire rejects sole baseline through allocation", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 1.0);

    const result = handleMetaOperation({
      db,
      operation: {
        kind: "retire",
        target_variant_id: "base",
        hypothesis: "h",
        evidence: { task_ids: ["t1"] }
      },
      metaTaskId: "meta-sole-baseline",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("sole_baseline_retirement");
    expect(variantState(db, "base")).toEqual({ status: "baseline", traffic_share: 1.0 });
    expect(allocationEventsFor(db, "base")).toHaveLength(0);
    expect(experimentCount(db)).toBe(0);
  });

  test("allocation rejection prevents experiment row insert", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 1.0);
    seedVariant(db, "candidate", "persona:coder", "candidate", 0.0);

    const result = handleMetaOperation({
      db,
      operation: {
        kind: "promote",
        target_variant_id: "candidate",
        traffic_share: 0.1,
        hypothesis: "h",
        evidence: { task_ids: ["t1"] }
      },
      metaTaskId: "meta-candidate-promote",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("candidate_requires_graduation");
    expect(variantState(db, "candidate")).toEqual({ status: "candidate", traffic_share: 0.0 });
    expect(allocationEventsFor(db, "candidate")).toHaveLength(0);
    expect(experimentCount(db)).toBe(0);
  });

  test("retire_lessons apply after successful promote and not when allocation rejects", () => {
    const successDb = freshDb();
    seedVariant(successDb, "base", "persona:coder", "baseline", 0.8);
    seedVariant(successDb, "active", "persona:coder", "active", 0.2);
    seedTask(successDb, "t-success");
    const successLesson = seedLesson(successDb, "active", "t-success");

    const success = handleMetaOperation({
      db: successDb,
      operation: {
        kind: "promote",
        target_variant_id: "active",
        traffic_share: 0.25,
        hypothesis: "h",
        evidence: { task_ids: ["t-success"] },
        retire_lessons: [{ id: successLesson, reason: "superseded" }]
      },
      metaTaskId: "meta-promote-lessons",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(success.ok).toBe(true);
    expect((successDb.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(successLesson) as { status: string }).status)
      .toBe("retired");

    const rejectedDb = freshDb();
    seedVariant(rejectedDb, "base", "persona:coder", "baseline", 1.0);
    seedVariant(rejectedDb, "candidate", "persona:coder", "candidate", 0.0);
    seedTask(rejectedDb, "t-rejected");
    const rejectedLesson = seedLesson(rejectedDb, "candidate", "t-rejected");

    const rejected = handleMetaOperation({
      db: rejectedDb,
      operation: {
        kind: "promote",
        target_variant_id: "candidate",
        traffic_share: 0.1,
        hypothesis: "h",
        evidence: { task_ids: ["t-rejected"] },
        retire_lessons: [{ id: rejectedLesson, reason: "superseded" }]
      },
      metaTaskId: "meta-rejected-lessons",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toBe("candidate_requires_graduation");
    expect((rejectedDb.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(rejectedLesson) as { status: string }).status)
      .toBe("active");
    expect(experimentCount(rejectedDb)).toBe(0);
  });

  test("retire_lessons apply after successful demote with allocation event and experiment", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 0.8);
    seedVariant(db, "active", "persona:coder", "active", 0.2);
    seedTask(db, "t-demote-lessons");
    const lessonId = seedLesson(db, "active", "t-demote-lessons");

    const result = handleMetaOperation({
      db,
      operation: {
        kind: "demote",
        target_variant_id: "active",
        traffic_share: 0.1,
        hypothesis: "h",
        evidence: { task_ids: ["t-demote-lessons"] },
        retire_lessons: [{ id: lessonId, reason: "superseded" }]
      },
      metaTaskId: "meta-demote-lessons",
      worktreePath: "/tmp/nope",
      projectId: "p"
    });

    expect(result.ok).toBe(true);
    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.1 });
    expect((db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(lessonId) as { status: string }).status)
      .toBe("retired");
    expect(experimentCount(db)).toBe(1);
    const events = allocationEventsFor(db, "active");
    expect(events).toHaveLength(1);
    expect(events[0].payload.reason).toBe("meta_demote");
  });

  test("rolls back promote allocation, event, experiment, and retire_lessons when experiment insertion fails", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 0.8);
    seedVariant(db, "active", "persona:coder", "active", 0.2);
    seedTask(db, "t-promote-rollback");
    const lessonId = seedLesson(db, "active", "t-promote-rollback");
    forceExperimentInsertionFailure(db);

    expect(() => handleMetaOperation({
      db,
      operation: {
        kind: "promote",
        target_variant_id: "active",
        traffic_share: 0.25,
        hypothesis: "h",
        evidence: { task_ids: ["t-promote-rollback"] },
        retire_lessons: [{ id: lessonId, reason: "superseded" }]
      },
      metaTaskId: "meta-promote-rollback",
      worktreePath: "/tmp/nope",
      projectId: "p"
    })).toThrow("forced_experiment_insert_failure");

    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.2 });
    expect(allocationEventsFor(db, "active")).toHaveLength(0);
    expect(experimentCount(db)).toBe(0);
    expect((db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(lessonId) as { status: string }).status)
      .toBe("active");
  });

  test("rolls back retire allocation, event, experiment, and retire_lessons when experiment insertion fails", () => {
    const db = freshDb();
    seedVariant(db, "base", "persona:coder", "baseline", 0.8);
    seedVariant(db, "active", "persona:coder", "active", 0.2);
    seedTask(db, "t-retire-rollback");
    const lessonId = seedLesson(db, "active", "t-retire-rollback");
    forceExperimentInsertionFailure(db);

    expect(() => handleMetaOperation({
      db,
      operation: {
        kind: "retire",
        target_variant_id: "active",
        hypothesis: "h",
        evidence: { task_ids: ["t-retire-rollback"] },
        retire_lessons: [{ id: lessonId, reason: "superseded" }]
      },
      metaTaskId: "meta-retire-rollback",
      worktreePath: "/tmp/nope",
      projectId: "p"
    })).toThrow("forced_experiment_insert_failure");

    expect(variantState(db, "active")).toEqual({ status: "active", traffic_share: 0.2 });
    expect(allocationEventsFor(db, "active")).toHaveLength(0);
    expect(experimentCount(db)).toBe(0);
    expect((db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(lessonId) as { status: string }).status)
      .toBe("active");
  });
});

describe("handleMetaOperation — retire", () => {
  test("retires a non-baseline variant", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);

    const op: MetaOperation = {
      kind: "retire", target_variant_id: "vCand",
      hypothesis: "h", evidence: { task_ids: ["t1"] }
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt4", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(true);
    const row = db.sqlite.query("SELECT status, traffic_share FROM skill_versions WHERE id='vCand'")
      .get() as { status: string; traffic_share: number };
    expect(row.status).toBe("retired");
    expect(row.traffic_share).toBe(0.0);
  });

  test("refuses to retire the sole baseline", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    const op: MetaOperation = {
      kind: "retire", target_variant_id: "vBase",
      hypothesis: "h", evidence: { task_ids: ["t1"] }
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt5", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/sole_baseline/);
  });
});

describe("handleMetaOperation — fork (stub)", () => {
  test("creates a proposed experiment with content stashed, no new skill_versions row", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    const worktree = makeWorktreeWithProposal("# Forked frontend variant");

    const op: MetaOperation = {
      kind: "fork",
      parent_variant_id: "vBase",
      specialty: "frontend React",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      proposed_content_file: "proposed-persona.md"
    };

    const before = (db.sqlite.query("SELECT COUNT(*) AS n FROM skill_versions").get() as { n: number }).n;
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt6", worktreePath: worktree, projectId: "p"
    });
    expect(res.ok).toBe(true);
    const after = (db.sqlite.query("SELECT COUNT(*) AS n FROM skill_versions").get() as { n: number }).n;
    expect(after).toBe(before);
    const experimentId = res.experimentId as string;

    const exp = db.sqlite.query("SELECT operation, status, proposed_content FROM experiments WHERE id = ?")
      .get(experimentId) as { operation: string; status: string; proposed_content: string };
    expect(exp.operation).toBe("fork");
    expect(exp.status).toBe("proposed");
    expect(exp.proposed_content).toBe("# Forked frontend variant");
  });
});

describe("handleMetaOperation — retire_lessons side effect", () => {
  test("retires listed lessons alongside the main operation", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))`
    ).run();

    const l1 = db.insertLesson({
      agentType: "coder", lineageRootId: "vCand", sourceTaskId: "t1",
      sourceVariantId: "vCand", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });

    const op2: MetaOperation = {
      kind: "retire",
      target_variant_id: "vCand",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      retire_lessons: [{ id: l1, reason: "superseded by new guidance" }]
    };

    const res = handleMetaOperation({
      db, operation: op2, metaTaskId: "mt7", worktreePath: "/tmp/nope", projectId: "p"
    });
    expect(res.ok).toBe(true);

    const row = db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(l1) as { status: string };
    expect(row.status).toBe("retired");
  });

  test("rejects inactive retire_lessons instead of silently ignoring them", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t-inactive','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))`
    ).run();
    const lessonId = db.insertLesson({
      agentType: "coder", lineageRootId: "vCand", sourceTaskId: "t-inactive",
      sourceVariantId: "vCand", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    db.retireLessons([lessonId]);

    const op: MetaOperation = {
      kind: "retire",
      target_variant_id: "vCand",
      hypothesis: "h",
      evidence: { task_ids: ["t-inactive"] },
      retire_lessons: [{ id: lessonId, reason: "already obsolete" }]
    };

    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt-inactive", worktreePath: "/tmp/nope", projectId: "p"
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/lesson.*active/i);
    const variant = db.sqlite.query("SELECT status FROM skill_versions WHERE id = 'vCand'")
      .get() as { status: string };
    expect(variant.status).toBe("candidate");
  });

  test("rejects retire_lessons outside the target variant lineage", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
    seedVariant(db, "vOther", "persona:coder", "active", 0.1);
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t-cross','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))`
    ).run();
    const lessonId = db.insertLesson({
      agentType: "coder", lineageRootId: "vOther", sourceTaskId: "t-cross",
      sourceVariantId: "vOther", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });

    const op: MetaOperation = {
      kind: "retire",
      target_variant_id: "vCand",
      hypothesis: "h",
      evidence: { task_ids: ["t-cross"] },
      retire_lessons: [{ id: lessonId, reason: "not this lineage" }]
    };

    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt-cross", worktreePath: "/tmp/nope", projectId: "p"
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/lineage/i);
    const lesson = db.sqlite.query("SELECT status FROM lessons WHERE id = ?")
      .get(lessonId) as { status: string };
    expect(lesson.status).toBe("active");
  });
});

describe("handleMetaOperation — proposed_content_file path traversal", () => {
  test("rejects edit with '../' in proposed_content_file", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder");
    const worktree = makeWorktreeWithProposal("# legit");
    const decoyDir = mkdtempSync(join(tmpdir(), "decoy-"));
    writeFileSync(join(decoyDir, "secret.md"), "# secret");
    const rel = relative(worktree, join(decoyDir, "secret.md"));

    const op: MetaOperation = {
      kind: "edit",
      target_variant_id: "vBase",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      proposed_content_file: rel
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt", worktreePath: worktree, projectId: "p"
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("proposed_content_empty");
  });

  test("rejects edit with absolute proposed_content_file", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder");
    const worktree = makeWorktreeWithProposal("# legit");

    const op: MetaOperation = {
      kind: "edit",
      target_variant_id: "vBase",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      proposed_content_file: "/etc/passwd"
    };
    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt", worktreePath: worktree, projectId: "p"
    });
    expect(res.ok).toBe(false);
  });
});

describe("handleMetaOperation — proposed ops defer retire_lessons", () => {
  test("fork stores retire_lessons as pending, does not retire them yet", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder", "baseline", 1.0);
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))`
    ).run();
    const lessonId = db.insertLesson({
      agentType: "coder", lineageRootId: "vBase", sourceTaskId: "t1",
      sourceVariantId: "vBase", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    const worktree = makeWorktreeWithProposal("# Forked");

    const op: MetaOperation = {
      kind: "fork",
      parent_variant_id: "vBase",
      specialty: "frontend",
      hypothesis: "h",
      evidence: { task_ids: ["t1"] },
      proposed_content_file: "proposed-persona.md",
      retire_lessons: [{ id: lessonId, reason: "superseded" }]
    };

    const res = handleMetaOperation({
      db, operation: op, metaTaskId: "mt", worktreePath: worktree, projectId: "p"
    });
    expect(res.ok).toBe(true);

    const lessonRow = db.sqlite.query("SELECT status FROM lessons WHERE id = ?")
      .get(lessonId) as { status: string };
    expect(lessonRow.status).toBe("active");

    const exp = db.sqlite.query("SELECT evidence FROM experiments WHERE id = ?")
      .get(res.experimentId as string) as { evidence: string };
    const parsed = JSON.parse(exp.evidence) as Record<string, unknown>;
    expect(parsed.pending_retire_lessons).toEqual([lessonId]);
  });
});
