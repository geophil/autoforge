import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import type { AgentTranscriptRow } from "../../src/types/transcripts";
import { Hono } from "hono";
import { createTranscriptsRoutes } from "../../src/web/routes/transcripts";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "transcripts-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
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

  test("freshDb bootstraps the full runtime schema including numbered migrations", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(experiments)")
      .all() as Array<{ name: string }>;

    expect(cols.map((col) => col.name)).toContain("operation");
    expect(cols.map((col) => col.name)).toContain("evidence");
  });
});

describe("DbClient transcripts methods", () => {
  test("insertTranscript and getTranscript round-trip", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-1", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");

    const id = db.insertTranscript({
      taskId: "task-1",
      stage: "planner",
      attempt: 0,
      personaVersionId: "persona-planner-v1",
      executorUsed: "anthropic-sdk",
      model: "claude-opus-4",
      systemPrompt: "you are the planner",
      userPrompt: "## Task\nbuild a thing",
      transcript: '{"kind":"assistant","content":[]}',
      output: '{"status":"DONE","subtasks":[]}',
      critique: null,
      tokenInput: 1234,
      tokenOutput: 56,
      elapsedSeconds: 12.3
    });

    const row = db.getTranscript(id);
    expect(row).not.toBeNull();
    expect(row!.taskId).toBe("task-1");
    expect(row!.stage).toBe("planner");
    expect(row!.attempt).toBe(0);
    expect(row!.personaVersionId).toBe("persona-planner-v1");
    expect(row!.systemPrompt).toBe("you are the planner");
    expect(row!.tokenInput).toBe(1234);
  });

  test("listTranscriptsByTask returns metadata only, ordered by insertion (created_at, rowid)", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-2", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");

    // Insertion order matches attempt order in production (planner runs attempt
    // 0 before attempt 1). The ordering contract is "chronological by insertion"
    // — created_at is the primary key with rowid as the millisecond-collision
    // tie-break — so this list reflects the same order the orchestrator wrote.
    db.insertTranscript({
      taskId: "task-2", stage: "planner", attempt: 0,
      personaVersionId: "persona-planner-v1",
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });
    db.insertTranscript({
      taskId: "task-2", stage: "planner", attempt: 1,
      personaVersionId: "persona-planner-v2",
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: "fix it",
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });

    const list = db.listTranscriptsByTask("task-2");
    expect(list).toHaveLength(2);
    expect(list[0].attempt).toBe(0);
    expect(list[1].attempt).toBe(1);
    expect(list[0].personaVersionId).toBe("persona-planner-v1");
    expect((list[0] as Partial<AgentTranscriptRow>).systemPrompt).toBeUndefined();
    expect((list[0] as Partial<AgentTranscriptRow>).transcript).toBeUndefined();
  });

  test("UNIQUE(task_id, stage, attempt) prevents duplicates", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-3", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");

    db.insertTranscript({
      taskId: "task-3", stage: "planner", attempt: 0,
      personaVersionId: "persona-planner-v1",
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });
    expect(() => db.insertTranscript({
      taskId: "task-3", stage: "planner", attempt: 0,
      personaVersionId: "persona-planner-v1",
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    })).toThrow();
  });
});

describe("transcripts API", () => {
  test("GET /api/transcripts/by-task/:taskId returns metadata", async () => {
    const db = freshDb();
    db.sqlite.query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run("t-api", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");
    db.insertTranscript({
      taskId: "t-api", stage: "planner", attempt: 0,
      personaVersionId: "persona-planner-api",
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });

    const app = new Hono();
    app.route("/api/transcripts", createTranscriptsRoutes(db));
    const res = await app.request("/api/transcripts/by-task/t-api");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].attempt).toBe(0);
    expect(body[0].personaVersionId).toBe("persona-planner-api");
  });
});
