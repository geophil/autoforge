import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";

export function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "spec-c-population-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

export function seedVariant(
  db: DbClient,
  input: {
    id: string;
    skill: string;
    status: string;
    share: number;
    specialty?: string | null;
    parent?: string | null;
  }
): void {
  db.sqlite.query(`
    INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share, specialty, parent_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.skill,
    input.id,
    `${input.skill} ${input.id}`,
    input.status,
    input.share,
    input.specialty ?? null,
    input.parent ?? null
  );
}
