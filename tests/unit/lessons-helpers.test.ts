import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "lessons-helpers-test-"));
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
  skillName: string,
  parentId: string | null = null,
  status = "baseline"
): void {
  db.sqlite.query(
    `INSERT INTO skill_versions (id, skill_name, version, content, parent_version_id, status, traffic_share)
     VALUES (?, ?, '1', 'c', ?, ?, ?)`
  ).run(id, skillName, parentId, status, status === "baseline" ? 1.0 : 0.0);
}

function seedTask(db: DbClient, id: string, state = "completed"): void {
  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES (?, 'p', 'd', ?, 'STANDARD', '{}', '[]', 0, '2026-04-23T00:00:00Z', '2026-04-23T00:00:00Z')`
  ).run(id, state);
}

describe("DbClient.insertLesson", () => {
  test("persists a lesson row with required fields", () => {
    const db = freshDb();
    seedVariant(db, "vBase", "persona:coder");
    seedTask(db, "t1");

    const id = db.insertLesson({
      agentType: "coder",
      lineageRootId: "vBase",
      sourceTaskId: "t1",
      sourceVariantId: "vBase",
      triggerPattern: "React styling tasks",
      failureCategory: "rework_limit",
      findingCategories: ["styling"],
      body: "TRIGGER: x\nOBSERVATION: y\nPRINCIPLE: z\nEVIDENCE: e",
      outcomeKind: "corrective",
      retrievalKeywords: "react css styling"
    });

    expect(typeof id).toBe("string");
    const row = db.sqlite
      .query("SELECT * FROM lessons WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(row.agent_type).toBe("coder");
    expect(row.status).toBe("active");
    expect(JSON.parse(row.finding_categories as string)).toEqual(["styling"]);
  });
});

describe("DbClient.resolveLineageRoot", () => {
  test("returns self id when parent_version_id is NULL", () => {
    const db = freshDb();
    seedVariant(db, "vSeed", "persona:coder", null);
    expect(db.resolveLineageRoot("vSeed")).toBe("vSeed");
  });

  test("walks parent chain to root", () => {
    const db = freshDb();
    seedVariant(db, "vSeed", "persona:coder", null);
    seedVariant(db, "vMid", "persona:coder.x", "vSeed", "candidate");
    seedVariant(db, "vLeaf", "persona:coder.x.y", "vMid", "candidate");
    expect(db.resolveLineageRoot("vLeaf")).toBe("vSeed");
  });

  test("handles cycles defensively (returns last-seen id)", () => {
    const db = freshDb();
    seedVariant(db, "vA", "persona:coder", null);
    seedVariant(db, "vB", "persona:coder", "vA", "candidate");
    // Introduce a cycle by direct SQL (shouldn't happen in practice but we defend).
    db.sqlite.query("UPDATE skill_versions SET parent_version_id = 'vB' WHERE id = 'vA'").run();
    // Should terminate without stack overflow and return some id in the cycle.
    const root = db.resolveLineageRoot("vB");
    expect(root).not.toBeNull();
    expect(["vA", "vB"]).toContain(root as string);
  });

  test("returns null for unknown id", () => {
    const db = freshDb();
    expect(db.resolveLineageRoot("missing")).toBeNull();
  });
});

describe("DbClient.retrieveActiveLessonsByLineage", () => {
  test("filters by lineage_root_id, agent_type, status='active'", () => {
    const db = freshDb();
    seedVariant(db, "vRoot", "persona:coder", null);
    seedVariant(db, "vOther", "persona:planner", null);
    seedTask(db, "t1");

    const keep = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    // Wrong agent type.
    db.insertLesson({
      agentType: "planner", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    // Wrong lineage.
    db.insertLesson({
      agentType: "coder", lineageRootId: "vOther", sourceTaskId: "t1",
      sourceVariantId: "vOther", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    // Retired.
    const retired = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    db.sqlite.query("UPDATE lessons SET status='retired' WHERE id = ?").run(retired);

    const lessons = db.retrieveActiveLessonsByLineage("vRoot", "coder");
    expect(lessons.map((l) => l.id)).toEqual([keep]);
  });
});

describe("DbClient.supersedeLessons and retireLessons", () => {
  test("supersedeLessons sets status and superseded_by", () => {
    const db = freshDb();
    seedVariant(db, "vRoot", "persona:coder", null);
    seedTask(db, "t1");

    const oldId = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    const newId = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p2", body: "b2", outcomeKind: "corrective"
    });

    db.supersedeLessons([oldId], newId);
    const row = db.sqlite.query("SELECT status, superseded_by, retired_at FROM lessons WHERE id = ?")
      .get(oldId) as { status: string; superseded_by: string; retired_at: string };
    expect(row.status).toBe("superseded");
    expect(row.superseded_by).toBe(newId);
    expect(row.retired_at).not.toBeNull();
  });

  test("retireLessons only transitions active lessons", () => {
    const db = freshDb();
    seedVariant(db, "vRoot", "persona:coder", null);
    seedTask(db, "t1");

    const alive = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    const already = db.insertLesson({
      agentType: "coder", lineageRootId: "vRoot", sourceTaskId: "t1",
      sourceVariantId: "vRoot", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });
    db.sqlite.query("UPDATE lessons SET status='retired' WHERE id = ?").run(already);

    const transitioned = db.retireLessons([alive, already]);
    expect(transitioned).toEqual([alive]);
    const row = db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(alive) as { status: string };
    expect(row.status).toBe("retired");
  });
});
