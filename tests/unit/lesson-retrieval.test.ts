import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { retrieveLessonsForDispatch, extractKeywords } from "../../src/orchestrator/lessons";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "lesson-retrieval-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function seedLesson(
  db: DbClient,
  lineage: string,
  agentType: string,
  keywords: string,
  body = "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE"
): string {
  db.sqlite.query(
    `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
     VALUES (?, ?, '1', 'c', 'baseline', 1.0)
     ON CONFLICT(id) DO NOTHING`
  ).run(lineage, "persona:" + agentType);
  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES ('src', 'p', 'd', 'completed', 'STANDARD', '{}', '[]', 0, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO NOTHING`
  ).run();
  return db.insertLesson({
    agentType,
    lineageRootId: lineage,
    sourceTaskId: "src",
    sourceVariantId: lineage,
    triggerPattern: "p",
    body,
    outcomeKind: "corrective",
    retrievalKeywords: keywords
  });
}

describe("extractKeywords", () => {
  test("lowercases, strips punctuation, removes stopwords", () => {
    const out = extractKeywords("Refactor the User-Auth service for clarity and speed.");
    expect(out).toEqual(
      expect.arrayContaining(["refactor", "user", "auth", "service", "clarity", "speed"])
    );
    expect(out).not.toContain("the");
    expect(out).not.toContain("for");
    expect(out).not.toContain("and");
  });

  test("caps at 20 terms by frequency", () => {
    const text = Array.from({ length: 25 }, (_, i) => `term${i}`).join(" ");
    expect(extractKeywords(text)).toHaveLength(20);
  });
});

describe("retrieveLessonsForDispatch", () => {
  test("returns only lineage+agent matches, ordered by keyword overlap", async () => {
    const db = freshDb();
    const a = seedLesson(db, "vCoder", "coder", "react css styling");
    const b = seedLesson(db, "vCoder", "coder", "database migration");
    const c = seedLesson(db, "vCoder", "coder", "react hooks");

    const lessons = await retrieveLessonsForDispatch(
      db, "vCoder", "coder", "Styling a React component with CSS modules", 5, 2000
    );
    // 'a' matches 3 keywords, 'c' matches 1, 'b' matches 0.
    expect(lessons.map((l) => l.id)).toEqual([a, c]);
  });

  test("respects maxLessons", async () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) seedLesson(db, "vCoder", "coder", "react styling css");
    const lessons = await retrieveLessonsForDispatch(
      db, "vCoder", "coder", "react styling", 2, 9999
    );
    expect(lessons).toHaveLength(2);
  });

  test("returns [] when no lesson has overlapping keywords", async () => {
    const db = freshDb();
    seedLesson(db, "vCoder", "coder", "database migration");
    const lessons = await retrieveLessonsForDispatch(
      db, "vCoder", "coder", "Add a dark-mode toggle", 5, 9999
    );
    expect(lessons).toEqual([]);
  });

  test("can use bounded recent-lesson fallback when overlap is zero", async () => {
    const db = freshDb();
    const oldId = seedLesson(db, "vCoder", "coder", "database migration", "x".repeat(160));
    const recentId = seedLesson(db, "vCoder", "coder", "backend schema", "x".repeat(40));

    const lessons = await retrieveLessonsForDispatch(
      db,
      "vCoder",
      "coder",
      "Add a dark-mode toggle",
      5,
      9999,
      {
        zeroOverlapFallback: {
          enabled: true,
          maxLessons: 1,
          maxTokens: 15
        }
      }
    );

    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.id).toBe(recentId);
    expect(lessons[0]?.id).not.toBe(oldId);
  });

  test("truncates tail to respect maxTokens (approx 4 chars = 1 token)", async () => {
    const db = freshDb();
    const bigBody = "word ".repeat(500);  // ~2500 chars ≈ 625 tokens
    seedLesson(db, "vCoder", "coder", "react", bigBody);
    seedLesson(db, "vCoder", "coder", "react", bigBody);
    seedLesson(db, "vCoder", "coder", "react", bigBody);
    const lessons = await retrieveLessonsForDispatch(
      db, "vCoder", "coder", "react styling", 5, 800
    );
    expect(lessons).toHaveLength(1);
  });

  test("returns [] when variantId is unknown (lineage root null)", async () => {
    const db = freshDb();
    const lessons = await retrieveLessonsForDispatch(
      db, "nonexistent-variant", "coder", "any description", 5, 1500
    );
    expect(lessons).toEqual([]);
  });

  test("returns [] for an empty task description", async () => {
    const db = freshDb();
    seedLesson(db, "vCoder", "coder", "react styling");
    const lessons = await retrieveLessonsForDispatch(
      db, "vCoder", "coder", "", 5, 1500
    );
    expect(lessons).toEqual([]);
  });

  test("lessons with null retrieval_keywords score zero overlap and are excluded", async () => {
    const db = freshDb();
    // Seed a variant + task manually (can't use seedLesson because it always passes keywords).
    db.sqlite.query(
      `INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
       VALUES ('vK', 'persona:coder', '1', 'c', 'baseline', 1.0)`
    ).run();
    db.sqlite.query(
      `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
       VALUES ('tk', 'p', 'd', 'completed', 'STANDARD', '{}', '[]', 0, datetime('now'), datetime('now'))`
    ).run();
    db.insertLesson({
      agentType: "coder",
      lineageRootId: "vK",
      sourceTaskId: "tk",
      sourceVariantId: "vK",
      triggerPattern: "p",
      body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
      outcomeKind: "corrective"
      // retrievalKeywords omitted => null
    });
    const lessons = await retrieveLessonsForDispatch(
      db, "vK", "coder", "any keywords here", 5, 1500
    );
    expect(lessons).toEqual([]);
  });

  test("lesson whose token cost exactly equals remaining budget is admitted (strict > guard)", async () => {
    const db = freshDb();
    // approxTokens = ceil(length / 4). A body of length 40 costs 10 tokens.
    // Seed two such lessons; with budget 20 both fit exactly.
    const bodyLen40 = "x".repeat(40);
    seedLesson(db, "vE", "coder", "react", bodyLen40);
    seedLesson(db, "vE", "coder", "react", bodyLen40);
    const lessons = await retrieveLessonsForDispatch(
      db, "vE", "coder", "react", 5, 20
    );
    expect(lessons).toHaveLength(2);
  });
});
