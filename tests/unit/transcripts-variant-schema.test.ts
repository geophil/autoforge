import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "transcripts-variant-schema-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function baseSchemaOnlyDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "transcripts-variant-schema-base-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  return db;
}

describe("agent_transcripts schema - persona_version_id migration", () => {
  test("column exists as nullable TEXT after numbered migrations run", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(agent_transcripts)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;

    const personaVersionId = cols.find((col) => col.name === "persona_version_id");
    expect(personaVersionId).toBeDefined();
    expect(personaVersionId?.type).toBe("TEXT");
    expect(personaVersionId?.notnull).toBe(0);
    expect(personaVersionId?.dflt_value).toBeNull();
  });

  test("migration backfills existing transcripts from the first matching stage event in each transcript time window", () => {
    const db = baseSchemaOnlyDb();

    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-variant", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z");

    db.sqlite
      .query(
        "INSERT INTO agent_transcripts (id, task_id, stage, attempt, created_at, executor_used, model, system_prompt, user_prompt, transcript, output, critique, token_input, token_output, elapsed_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "tx-0",
        "task-variant",
        "planner",
        0,
        "2026-04-19T00:00:10Z",
        "anthropic-sdk",
        "claude-opus-4",
        "system",
        "user",
        "[]",
        null,
        null,
        10,
        20,
        1.5
      );
    db.sqlite
      .query(
        "INSERT INTO agent_transcripts (id, task_id, stage, attempt, created_at, executor_used, model, system_prompt, user_prompt, transcript, output, critique, token_input, token_output, elapsed_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "tx-1",
        "task-variant",
        "planner",
        1,
        "2026-04-19T00:00:20Z",
        "anthropic-sdk",
        "claude-opus-4",
        "system",
        "user",
        "[]",
        null,
        null,
        11,
        21,
        1.6
      );

    db.sqlite
      .query(
        "INSERT INTO events (id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost, resumable, executor_used, context_envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "evt-planner-0",
        "task-variant",
        null,
        "2026-04-19T00:00:11Z",
        "proj",
        "planner",
        "agent_completed",
        "completed",
        JSON.stringify({ persona_version_id: "persona-v1" }),
        60,
        1.1,
        101,
        201,
        0.01,
        1,
        "anthropic-sdk",
        null
      );
    db.sqlite
      .query(
        "INSERT INTO events (id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost, resumable, executor_used, context_envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "evt-coder-0",
        "task-variant",
        null,
        "2026-04-19T00:00:12Z",
        "proj",
        "coder",
        "agent_completed",
        "completed",
        JSON.stringify({ persona_version_id: "persona-ignore-me" }),
        60,
        1.1,
        102,
        202,
        0.01,
        1,
        "anthropic-sdk",
        null
      );
    db.sqlite
      .query(
        "INSERT INTO events (id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost, resumable, executor_used, context_envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "evt-planner-1",
        "task-variant",
        null,
        "2026-04-19T00:00:21Z",
        "proj",
        "planner",
        "agent_completed",
        "completed",
        JSON.stringify({ persona_version_id: "persona-v2" }),
        60,
        1.1,
        103,
        203,
        0.01,
        1,
        "anthropic-sdk",
        null
      );

    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const rows = db.sqlite
      .query("SELECT attempt, persona_version_id FROM agent_transcripts WHERE task_id = ? AND stage = ? ORDER BY attempt ASC")
      .all("task-variant", "planner") as Array<{ attempt: number; persona_version_id: string | null }>;

    expect(rows).toEqual([
      { attempt: 0, persona_version_id: "persona-v1" },
      { attempt: 1, persona_version_id: "persona-v2" }
    ]);
  });

  test("migration leaves failed attempts unmapped and backfills the later retry from its own time window", () => {
    const db = baseSchemaOnlyDb();

    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-retry-window", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z");

    db.sqlite
      .query(
        "INSERT INTO agent_transcripts (id, task_id, stage, attempt, created_at, executor_used, model, system_prompt, user_prompt, transcript, output, critique, token_input, token_output, elapsed_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "tx-retry-0",
        "task-retry-window",
        "planner",
        0,
        "2026-04-19T00:01:00Z",
        "anthropic-sdk",
        "claude-opus-4",
        "system",
        "user",
        "[]",
        null,
        null,
        10,
        20,
        1.5
      );
    db.sqlite
      .query(
        "INSERT INTO agent_transcripts (id, task_id, stage, attempt, created_at, executor_used, model, system_prompt, user_prompt, transcript, output, critique, token_input, token_output, elapsed_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "tx-retry-1",
        "task-retry-window",
        "planner",
        1,
        "2026-04-19T00:02:00Z",
        "anthropic-sdk",
        "claude-opus-4",
        "system",
        "user",
        "[]",
        null,
        null,
        11,
        21,
        1.6
      );

    db.sqlite
      .query(
        "INSERT INTO events (id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost, resumable, executor_used, context_envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "evt-retry-nonpersona",
        "task-retry-window",
        null,
        "2026-04-19T00:01:10Z",
        "proj",
        "planner",
        "agent_failed",
        "failed",
        JSON.stringify({ reason: "timeout" }),
        60,
        1.1,
        101,
        201,
        0.01,
        1,
        "anthropic-sdk",
        null
      );
    db.sqlite
      .query(
        "INSERT INTO events (id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost, resumable, executor_used, context_envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "evt-retry-persona",
        "task-retry-window",
        null,
        "2026-04-19T00:02:10Z",
        "proj",
        "planner",
        "agent_completed",
        "completed",
        JSON.stringify({ persona_version_id: "persona-retry" }),
        60,
        1.1,
        102,
        202,
        0.01,
        1,
        "anthropic-sdk",
        null
      );

    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const rows = db.sqlite
      .query("SELECT attempt, persona_version_id FROM agent_transcripts WHERE task_id = ? AND stage = ? ORDER BY attempt ASC")
      .all("task-retry-window", "planner") as Array<{ attempt: number; persona_version_id: string | null }>;

    expect(rows).toEqual([
      { attempt: 0, persona_version_id: null },
      { attempt: 1, persona_version_id: "persona-retry" }
    ]);
  });

  test("migration tie-breaks same-timestamp persona-bearing events by id", () => {
    const db = baseSchemaOnlyDb();

    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-tie-break", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-19T00:00:00Z", "2026-04-19T00:00:00Z");

    db.sqlite
      .query(
        "INSERT INTO agent_transcripts (id, task_id, stage, attempt, created_at, executor_used, model, system_prompt, user_prompt, transcript, output, critique, token_input, token_output, elapsed_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "tx-tie-0",
        "task-tie-break",
        "planner",
        0,
        "2026-04-19T00:03:00Z",
        "anthropic-sdk",
        "claude-opus-4",
        "system",
        "user",
        "[]",
        null,
        null,
        10,
        20,
        1.5
      );

    db.sqlite
      .query(
        "INSERT INTO events (id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost, resumable, executor_used, context_envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "evt-b",
        "task-tie-break",
        null,
        "2026-04-19T00:03:10Z",
        "proj",
        "planner",
        "agent_completed",
        "completed",
        JSON.stringify({ persona_version_id: "persona-second-by-id" }),
        60,
        1.1,
        101,
        201,
        0.01,
        1,
        "anthropic-sdk",
        null
      );
    db.sqlite
      .query(
        "INSERT INTO events (id, task_id, subtask_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, estimated_cost, resumable, executor_used, context_envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        "evt-a",
        "task-tie-break",
        null,
        "2026-04-19T00:03:10Z",
        "proj",
        "planner",
        "agent_completed",
        "completed",
        JSON.stringify({ persona_version_id: "persona-first-by-id" }),
        60,
        1.1,
        102,
        202,
        0.01,
        1,
        "anthropic-sdk",
        null
      );

    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );

    const row = db.sqlite
      .query("SELECT persona_version_id FROM agent_transcripts WHERE id = ?")
      .get("tx-tie-0") as { persona_version_id: string | null };

    expect(row.persona_version_id).toBe("persona-first-by-id");
  });
});
