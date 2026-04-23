import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "pop-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function insertSkillVersion(
  db: DbClient,
  id: string,
  skillName: string,
  isActive: 0 | 1 = 0
): void {
  db.sqlite
    .query(
      `INSERT INTO skill_versions (id, skill_name, version, content, is_active)
       VALUES (?, ?, '1', 'content', ?)`
    )
    .run(id, skillName, isActive);
}

describe("skill_versions — population schema", () => {
  test("new columns exist with expected defaults", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(skill_versions)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;

    expect(cols.find((c) => c.name === "parent_version_id")?.type).toBe("TEXT");
    expect(cols.find((c) => c.name === "specialty")?.type).toBe("TEXT");
    expect(cols.find((c) => c.name === "status")?.type).toBe("TEXT");
    expect(cols.find((c) => c.name === "status")?.dflt_value).toContain("candidate");
    expect(cols.find((c) => c.name === "traffic_share")?.type).toBe("REAL");
    expect(String(cols.find((c) => c.name === "traffic_share")?.dflt_value)).toContain("0");
  });

  test("backfill: exactly one baseline per skill_name when multiple is_active=1 rows exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pop-backfill-test-"));
    const dbPath = join(dir, `${randomUUID()}.sqlite`);
    const db = new DbClient(dbPath);

    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));

    insertSkillVersion(db, "v1", "persona:coder", 1);
    db.sqlite
      .query("UPDATE skill_versions SET created_at = '2025-01-01T00:00:00Z' WHERE id = 'v1'")
      .run();
    insertSkillVersion(db, "v2", "persona:coder", 1);
    db.sqlite
      .query("UPDATE skill_versions SET created_at = '2026-01-01T00:00:00Z' WHERE id = 'v2'")
      .run();
    insertSkillVersion(db, "v3", "persona:planner", 1);

    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const coderBaselines = db.sqlite
      .query(
        "SELECT id FROM skill_versions WHERE skill_name = 'persona:coder' AND status = 'baseline'"
      )
      .all() as Array<{ id: string }>;
    expect(coderBaselines).toHaveLength(1);
    expect(coderBaselines[0].id).toBe("v2");

    const v1 = db.sqlite
      .query("SELECT status, traffic_share FROM skill_versions WHERE id = 'v1'")
      .get() as { status: string; traffic_share: number };
    expect(v1.status).toBe("demoted");
    expect(v1.traffic_share).toBe(0.0);

    const v2 = db.sqlite
      .query("SELECT status, traffic_share FROM skill_versions WHERE id = 'v2'")
      .get() as { status: string; traffic_share: number };
    expect(v2.status).toBe("baseline");
    expect(v2.traffic_share).toBe(1.0);
  });

  test("trigger: updating status to baseline flips is_active=1; updating to demoted flips it to 0", () => {
    const db = freshDb();
    insertSkillVersion(db, "vA", "persona:coder", 0);

    db.sqlite
      .query("UPDATE skill_versions SET status = 'baseline' WHERE id = 'vA'")
      .run();
    let row = db.sqlite
      .query("SELECT is_active FROM skill_versions WHERE id = 'vA'")
      .get() as { is_active: number };
    expect(row.is_active).toBe(1);

    db.sqlite
      .query("UPDATE skill_versions SET status = 'demoted' WHERE id = 'vA'")
      .run();
    row = db.sqlite
      .query("SELECT is_active FROM skill_versions WHERE id = 'vA'")
      .get() as { is_active: number };
    expect(row.is_active).toBe(0);
  });

  test("trigger: INSERTing a row with status='active' sets is_active=1", () => {
    const db = freshDb();
    db.sqlite.exec(`
      INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
      VALUES ('vB', 'persona:reviewer', '1', 'content', 'active', 0.1)
    `);
    const row = db.sqlite
      .query("SELECT is_active FROM skill_versions WHERE id = 'vB'")
      .get() as { is_active: number };
    expect(row.is_active).toBe(1);
  });
});
