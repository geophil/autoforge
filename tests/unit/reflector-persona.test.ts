import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { PersonaRegistry } from "../../src/personas/registry";

describe("reflector persona", () => {
  test("PersonaRegistry.resolve returns the reflector persona file content", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflector-persona-test-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    const reg = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
    const text = reg.resolve("reflector");
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain("Reflector");
    expect(text).toContain("outcome_kind");
  });
});
