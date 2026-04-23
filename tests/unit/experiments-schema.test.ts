import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "experiments-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function baseSchemaOnlyDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "experiments-schema-base-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  return db;
}

describe("experiments schema — operation and evidence columns", () => {
  test("columns exist with correct types and defaults", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(experiments)")
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>;

    const operation = cols.find((col) => col.name === "operation");
    expect(operation).toBeDefined();
    expect(operation?.type).toBe("TEXT");
    expect(operation?.notnull).toBe(1);
    expect(operation?.dflt_value).toContain("edit");

    const evidence = cols.find((col) => col.name === "evidence");
    expect(evidence).toBeDefined();
    expect(evidence?.type).toBe("TEXT");
    expect(evidence?.notnull).toBe(0);
    expect(evidence?.dflt_value).toBeNull();
  });

  test("inserting without operation defaults it to edit", () => {
    const db = freshDb();

    db.sqlite
      .query(`
        INSERT INTO experiments (
          id,
          hypothesis,
          skill_modified,
          agent_affected,
          change_description,
          metric_name,
          metric_before
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "exp-default-operation",
        "measure whether edits improve quality",
        "persona:coder",
        "coder",
        "tighten reviewer instructions",
        "reward",
        0.5
      );

    const row = db.sqlite
      .query("SELECT operation, evidence FROM experiments WHERE id = ?")
      .get("exp-default-operation") as { operation: string; evidence: string | null };

    expect(row.operation).toBe("edit");
    expect(row.evidence).toBeNull();
  });

  test("applying migration 004 backfills pre-existing rows to operation=edit and evidence=NULL", () => {
    const db = baseSchemaOnlyDb();

    db.sqlite
      .query(`
        INSERT INTO experiments (
          id,
          hypothesis,
          skill_modified,
          agent_affected,
          change_description,
          metric_name,
          metric_before
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "exp-preexisting-row",
        "measure whether edits improve quality",
        "persona:coder",
        "coder",
        "tighten reviewer instructions",
        "reward",
        0.4
      );

    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const row = db.sqlite
      .query("SELECT operation, evidence FROM experiments WHERE id = ?")
      .get("exp-preexisting-row") as { operation: string; evidence: string | null };

    expect(row.operation).toBe("edit");
    expect(row.evidence).toBeNull();
  });
});
