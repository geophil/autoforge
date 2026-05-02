import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "specialty-embedding-schema-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

describe("skill_versions specialty_embedding schema", () => {
  test("specialty_embedding exists as nullable BLOB", () => {
    const db = freshDb();
    const cols = db.sqlite.query("PRAGMA table_info(skill_versions)").all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((entry) => entry.name === "specialty_embedding");
    expect(col?.type).toBe("BLOB");
    expect(col?.notnull).toBe(0);
  });
});
