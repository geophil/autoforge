import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";
import { createTestService } from "../helpers/create-service";

function freshDb(): { db: DbClient; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "failure-analysis-test-"));
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

describe("failure_analysis payload contract", () => {
  test("payload includes persona_version_id, skill_version_ids, executor_used, tool_stats keys", () => {
    const { db, cleanup } = freshDb();

    try {
      db.sqlite.query(
        `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
         VALUES ('t1', 'p1', 'd', 'failed', 'STANDARD', '{}', '[]', 0, '2026-04-19T00:00:00Z', '2026-04-19T00:00:00Z')`
      ).run();

      db.sqlite.query(
        `INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
         VALUES ('e1', 't1', '2026-04-19T00:01:00Z', 'p1', 'orchestrator', 'failure_analysis', 'failed',
                 '{"stage_failed":"executing","failure_reason":"x","failure_category":"coder_failed","executor_used":"anthropic-sdk","persona_version_id":"pv1","skill_version_ids":["sv1"],"tool_stats":{"read_count":3,"write_count":1,"bash_count":0,"search_count":2,"iterations":4},"planner_fallback":false,"iteration":0}', 60)`
      ).run();

      const row = db.sqlite
        .query(
          `SELECT
             json_extract(payload, '$.executor_used') AS executor_used,
             json_extract(payload, '$.persona_version_id') AS persona_version_id,
             json_extract(payload, '$.skill_version_ids') AS skill_version_ids,
             json_extract(payload, '$.tool_stats.read_count') AS read_count
           FROM events WHERE event_type = 'failure_analysis'`
        )
        .get() as {
          executor_used: string;
          persona_version_id: string;
          skill_version_ids: string;
          read_count: number;
        };

      expect(row.executor_used).toBe("anthropic-sdk");
      expect(row.persona_version_id).toBe("pv1");
      expect(JSON.parse(row.skill_version_ids)).toEqual(["sv1"]);
      expect(row.read_count).toBe(3);
    } finally {
      cleanup();
    }
  });

  test("runtime ToolStats are normalized to snake_case in emitted payloads", async () => {
    const { service, db, cleanup } = createTestService({
      coder: async () => ({
        status: "TIMEOUT",
        artifacts: [],
        metrics: {
          elapsedSeconds: 42,
          toolStats: {
            readCount: 5,
            writeCount: 2,
            bashCount: 1,
            searchCount: 3,
            iterations: 7
          }
        }
      })
    });

    try {
      const task = await service.submitTask("autoforge", "tiny coder task", { forceTier: "EXPRESS" });
      expect(task.state).toBe("awaiting_intervention");

      const failure = db.listEvents(task.id).find((e) => e.type === "failure_analysis");
      expect(failure).toBeDefined();
      expect(failure!.payload.tool_stats).toEqual({
        read_count: 5,
        write_count: 2,
        bash_count: 1,
        search_count: 3,
        iterations: 7
      });
    } finally {
      cleanup();
    }
  });
});
