import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWebServer } from "../../src/web/server";
import { DbClient } from "../../src/db/client";

describe("GET /api/tasks/:id/events", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-events-test-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns 200 with empty array when no events exist for task", async () => {
    const app = createWebServer({} as any, db);
    const res = await app.request("/api/tasks/nonexistent/events");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  test("returns events ordered by timestamp ASC", async () => {
    db.sqlite.query(`
      INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, resumable)
      VALUES
        ('evt-2', 'task-1', '2024-01-01T00:00:02.000Z', 'proj-1', 'planner', 'planned', 'done', '{}', 60, 1),
        ('evt-1', 'task-1', '2024-01-01T00:00:01.000Z', 'proj-1', 'orchestrator', 'created', 'done', '{}', 60, 1)
    `).run();

    const app = createWebServer({} as any, db);
    const res = await app.request("/api/tasks/task-1/events");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].timestamp).toBe("2024-01-01T00:00:01.000Z");
    expect(body[1].timestamp).toBe("2024-01-01T00:00:02.000Z");
  });

  test("returns correct shape for each event", async () => {
    db.sqlite.query(`
      INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, elapsed_seconds, token_input, token_output, resumable)
      VALUES ('evt-3', 'task-2', '2024-01-01T00:01:00.000Z', 'proj-1', 'coder', 'executed', 'done', '{}', 120, 30.5, 1000, 2000, 1)
    `).run();

    const app = createWebServer({} as any, db);
    const res = await app.request("/api/tasks/task-2/events");
    const body = await res.json();
    expect(body).toHaveLength(1);
    const event = body[0];
    expect(event.id).toBe("evt-3");
    expect(event.type).toBe("executed");
    expect(event.agent).toBe("coder");
    expect(event.status).toBe("done");
    expect(event.timestamp).toBe("2024-01-01T00:01:00.000Z");
    expect(event.elapsedSeconds).toBe(30.5);
    expect(event.tokenUsage).toEqual({ input: 1000, output: 2000 });
  });

  test("only returns events for the requested task", async () => {
    db.sqlite.query(`
      INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, resumable)
      VALUES
        ('evt-a1', 'task-a', '2024-01-01T00:00:01.000Z', 'proj-1', 'orchestrator', 'created', 'done', '{}', 60, 1),
        ('evt-b1', 'task-b', '2024-01-01T00:00:01.000Z', 'proj-1', 'orchestrator', 'created', 'done', '{}', 60, 1)
    `).run();

    const app = createWebServer({} as any, db);
    const res = await app.request("/api/tasks/task-a/events");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("evt-a1");
  });

  test("elapsedSeconds and tokenUsage are null when not set", async () => {
    db.sqlite.query(`
      INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds, resumable)
      VALUES ('evt-4', 'task-3', '2024-01-01T00:00:01.000Z', 'proj-1', 'orchestrator', 'created', 'done', '{}', 60, 1)
    `).run();

    const app = createWebServer({} as any, db);
    const res = await app.request("/api/tasks/task-3/events");
    const body = await res.json();
    const event = body[0];
    expect(event.elapsedSeconds).toBeNull();
    expect(event.tokenUsage).toBeNull();
  });
});
