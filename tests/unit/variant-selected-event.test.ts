import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";

function freshDb(): { db: DbClient; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "variant-selected-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );

  return {
    db,
    cleanup: () => {
      try {
        (db.sqlite as unknown as { close?: () => void }).close?.();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

describe("variant_selected event payload shape", () => {
  test("an emitted variant_selected event has all required fields", () => {
    const { db, cleanup } = freshDb();

    try {
      db.sqlite.query(
        `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
         VALUES ('t1', 'p1', 'd', 'completed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
      ).run();
      db.sqlite.query(
        `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
         VALUES ('e1', 't1', '2026-04-19T00:01:00Z', 'p1', 'orchestrator', 'variant_selected', 'done',
                 '{"agent_type":"coder","selected_variant_id":"v1","selected_variant_specialty":null,"eligible_variant_ids":["v1"],"selection_rationale":"only_eligible","shadow_variant_ids":[],"injected_lesson_ids":[]}', 600)`
      ).run();

      const row = db.sqlite
        .query(
          `SELECT
             json_extract(payload, '$.agent_type') AS agent_type,
             json_extract(payload, '$.selected_variant_id') AS selected_variant_id,
             json_extract(payload, '$.selected_variant_specialty') AS selected_variant_specialty,
             json_extract(payload, '$.eligible_variant_ids') AS eligible_variant_ids,
             json_extract(payload, '$.selection_rationale') AS selection_rationale,
             json_extract(payload, '$.shadow_variant_ids') AS shadow_variant_ids,
             json_extract(payload, '$.injected_lesson_ids') AS injected_lesson_ids
           FROM events WHERE event_type = 'variant_selected'`
        )
        .get() as {
          agent_type: string;
          selected_variant_id: string;
          selected_variant_specialty: string | null;
          eligible_variant_ids: string;
          selection_rationale: string;
          shadow_variant_ids: string;
          injected_lesson_ids: string;
        };

      expect(row.agent_type).toBe("coder");
      expect(row.selected_variant_id).toBe("v1");
      expect(row.selected_variant_specialty).toBeNull();
      expect(JSON.parse(row.eligible_variant_ids)).toEqual(["v1"]);
      expect(row.selection_rationale).toBe("only_eligible");
      expect(JSON.parse(row.shadow_variant_ids)).toEqual([]);
      expect(JSON.parse(row.injected_lesson_ids)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
