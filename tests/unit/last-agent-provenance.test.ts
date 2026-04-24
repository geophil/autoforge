import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "last-prov-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function seedTask(db: DbClient, id: string): void {
  db.sqlite.query(
    `INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
     VALUES (?, 'p', 'd', 'executing', 'STANDARD', '{}', '[]', 0, datetime('now'), datetime('now'))`
  ).run(id);
}

function insertEvent(
  db: DbClient,
  opts: {
    taskId: string;
    timestamp: string;
    agent: string;
    eventType: string;
    payload: Record<string, unknown>;
    executorUsed?: string;
  }
): void {
  db.sqlite.query(`
    INSERT INTO events
      (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, executor_used)
    VALUES
      (?, ?, ?, 'p', ?, ?, 'done', ?, 60, ?)
  `).run(
    randomUUID(),
    opts.taskId,
    opts.timestamp,
    opts.agent,
    opts.eventType,
    JSON.stringify(opts.payload),
    opts.executorUsed ?? null
  );
}

describe("DbClient.getLastAgentProvenance", () => {
  test("returns null when the task has no agent events", () => {
    const db = freshDb();
    seedTask(db, "t0");
    // Only orchestrator-authored events.
    insertEvent(db, {
      taskId: "t0", timestamp: "2026-04-24T00:00:00Z",
      agent: "orchestrator", eventType: "state.executing", payload: {}
    });
    expect(db.getLastAgentProvenance("t0")).toBeNull();
  });

  test("returns the most recent agent event's provenance", () => {
    const db = freshDb();
    seedTask(db, "t1");
    // Planner (older) with one provenance, coder (newer) with another — expect coder's.
    insertEvent(db, {
      taskId: "t1", timestamp: "2026-04-24T00:00:00Z", agent: "planner",
      eventType: "planner_done",
      payload: { persona_version_id: "pv_planner", skill_version_ids: ["sv_p"] },
      executorUsed: "anthropic-sdk"
    });
    insertEvent(db, {
      taskId: "t1", timestamp: "2026-04-24T00:10:00Z", agent: "coder",
      eventType: "coder_done",
      payload: { persona_version_id: "pv_coder", skill_version_ids: ["sv_c1", "sv_c2"] },
      executorUsed: "claude-code"
    });

    const out = db.getLastAgentProvenance("t1");
    expect(out).not.toBeNull();
    expect(out!.personaVersionId).toBe("pv_coder");
    expect(out!.skillVersionIds).toEqual(["sv_c1", "sv_c2"]);
    // executor_used lives on its own column, so it doesn't flow through the payload scan.
    // The helper also checks payload.executor_used, which our coder event doesn't carry.
    // Scanning stops on first-match — executor_used stays null in that case.
    // (payload-provided executor_used is exercised in the next test.)
  });

  test("reads executor_used from payload when present", () => {
    const db = freshDb();
    seedTask(db, "t2");
    insertEvent(db, {
      taskId: "t2", timestamp: "2026-04-24T00:00:00Z", agent: "coder",
      eventType: "coder_done",
      payload: {
        persona_version_id: "pv",
        skill_version_ids: ["sv"],
        executor_used: "anthropic-sdk"
      }
    });
    const out = db.getLastAgentProvenance("t2");
    expect(out!.executorUsed).toBe("anthropic-sdk");
  });

  test("skips events that carry neither personaVersionId nor skillVersionIds nor executorUsed", () => {
    const db = freshDb();
    seedTask(db, "t3");
    // Newer agent event with nothing useful.
    insertEvent(db, {
      taskId: "t3", timestamp: "2026-04-24T00:10:00Z", agent: "reviewer",
      eventType: "review_started", payload: {}
    });
    // Older agent event with provenance.
    insertEvent(db, {
      taskId: "t3", timestamp: "2026-04-24T00:00:00Z", agent: "planner",
      eventType: "planner_done",
      payload: { persona_version_id: "pv_old", skill_version_ids: ["sv_old"] }
    });
    const out = db.getLastAgentProvenance("t3");
    expect(out!.personaVersionId).toBe("pv_old");
  });
});
