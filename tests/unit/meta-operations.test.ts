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
  status: "baseline" | "candidate" | "active" = "baseline",
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
    expect(res.reason).toMatch(/baseline_protected/);
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
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('t1','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))`
    ).run();

    const l1 = db.insertLesson({
      agentType: "coder", lineageRootId: "vBase", sourceTaskId: "t1",
      sourceVariantId: "vBase", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });

    seedVariant(db, "vCand", "persona:coder", "candidate", 0.0);
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
