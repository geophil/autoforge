import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "lessons-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("lessons table schema", () => {
  test("lessons table exists with required columns", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(lessons)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id", "agent_type", "lineage_root_id", "source_task_id", "source_variant_id",
        "trigger_pattern", "failure_category", "finding_categories", "body",
        "outcome_kind", "retrieval_keywords", "status", "superseded_by",
        "created_at", "retired_at"
      ])
    );
    const status = cols.find((c) => c.name === "status");
    expect(status?.notnull).toBe(1);
    expect(status?.dflt_value).toContain("active");
  });

  test("lineage + status index exists", () => {
    const db = freshDb();
    const idx = db.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lessons'")
      .all() as Array<{ name: string }>;
    const names = idx.map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining(["idx_lessons_lineage_active", "idx_lessons_keywords"])
    );
  });
});
