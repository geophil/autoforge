import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "transcripts-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  return db;
}

describe("agent_transcripts schema", () => {
  test("table exists with required columns", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(agent_transcripts)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("task_id");
    expect(names).toContain("stage");
    expect(names).toContain("attempt");
    expect(names).toContain("created_at");
    expect(names).toContain("executor_used");
    expect(names).toContain("model");
    expect(names).toContain("system_prompt");
    expect(names).toContain("user_prompt");
    expect(names).toContain("transcript");
    expect(names).toContain("output");
    expect(names).toContain("critique");
    expect(names).toContain("token_input");
    expect(names).toContain("token_output");
    expect(names).toContain("elapsed_seconds");
  });
});
