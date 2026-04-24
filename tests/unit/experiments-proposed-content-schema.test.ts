import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

describe("experiments.proposed_content column", () => {
  test("column exists as nullable TEXT after migration 008", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-content-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    const cols = db.sqlite.query("PRAGMA table_info(experiments)")
      .all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((c) => c.name === "proposed_content");
    expect(col?.type).toBe("TEXT");
    expect(col?.notnull).toBe(0);
  });
});
