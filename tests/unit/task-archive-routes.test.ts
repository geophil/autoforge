import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { createTaskRoutes } from "../../src/web/routes/tasks";
import { LiveEventHub } from "../../src/web/events";
import { DbClient } from "../../src/db/client";
import type { OrchestratorService } from "../../src/orchestrator/service";
import type { PipelineTask } from "../../src/types/core";

function makeTask(overrides: Partial<PipelineTask> = {}): PipelineTask {
  return {
    id: "task-1",
    projectId: "proj-1",
    description: "a task",
    state: "completed",
    tier: "STANDARD",
    assessment: {} as any,
    plan: [],
    iteration: 0,
    createdAt: "2026-04-19T00:00:00Z",
    updatedAt: "2026-04-19T00:00:00Z",
    ...overrides
  };
}

function makeStubService(overrides: Partial<OrchestratorService> = {}): OrchestratorService {
  return {
    listTasks: () => [],
    getTask: () => null,
    archiveTask: async () => { throw new Error("not implemented"); },
    unarchiveTask: async () => { throw new Error("not implemented"); },
    deleteTaskPermanently: async () => { throw new Error("not implemented"); },
    ...overrides
  } as unknown as OrchestratorService;
}

function buildApp(service: OrchestratorService, db: DbClient): Hono {
  const events = new LiveEventHub();
  const app = new Hono();
  app.route("/tasks", createTaskRoutes(service, events, db));
  return app;
}

describe("POST /tasks/:id/archive", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-archive-routes-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns 200 with updated task containing archivedAt", async () => {
    const archived = makeTask({ archivedAt: "2026-04-19T01:00:00Z" });
    const service = makeStubService({ archiveTask: async () => archived });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/task-1/archive", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archivedAt).toBe("2026-04-19T01:00:00Z");
  });

  test("returns 409 when archiving an active task", async () => {
    const service = makeStubService({
      archiveTask: async () => {
        throw new Error("Cannot archive task task-1: must be in a terminal state (completed or failed), current state: 'executing'");
      }
    });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/task-1/archive", { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("returns 404 for unknown task id", async () => {
    const service = makeStubService({
      archiveTask: async () => {
        throw new Error("Task not found: unknown-id");
      }
    });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/unknown-id/archive", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("publishes task.updated event on success", async () => {
    const archived = makeTask({ archivedAt: "2026-04-19T01:00:00Z" });
    const service = makeStubService({ archiveTask: async () => archived });
    const events = new LiveEventHub();
    const app = new Hono();
    app.route("/tasks", createTaskRoutes(service, events, db));

    const published: Array<{ type: string; data: unknown }> = [];
    events.subscribe((payload) => {
      const lines = payload.trim().split("\n");
      const eventType = lines[0].replace("event: ", "");
      const data = JSON.parse(lines[1].replace("data: ", ""));
      published.push({ type: eventType, data });
    });

    await app.request("/tasks/task-1/archive", { method: "POST" });
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe("task.updated");
  });
});

describe("POST /tasks/:id/unarchive", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-unarchive-routes-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns 200 with archivedAt cleared", async () => {
    const unarchived = makeTask();
    const service = makeStubService({ unarchiveTask: async () => unarchived });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/task-1/unarchive", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archivedAt).toBeUndefined();
  });

  test("returns 404 for unknown task id", async () => {
    const service = makeStubService({
      unarchiveTask: async () => {
        throw new Error("Task not found: unknown-id");
      }
    });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/unknown-id/unarchive", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("publishes task.updated event on success", async () => {
    const unarchived = makeTask();
    const service = makeStubService({ unarchiveTask: async () => unarchived });
    const events = new LiveEventHub();
    const app = new Hono();
    app.route("/tasks", createTaskRoutes(service, events, db));

    const published: Array<{ type: string; data: unknown }> = [];
    events.subscribe((payload) => {
      const lines = payload.trim().split("\n");
      const eventType = lines[0].replace("event: ", "");
      const data = JSON.parse(lines[1].replace("data: ", ""));
      published.push({ type: eventType, data });
    });

    await app.request("/tasks/task-1/unarchive", { method: "POST" });
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe("task.updated");
  });
});

describe("DELETE /tasks/:id", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-delete-routes-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns 200 {ok:true} for an archived task", async () => {
    const service = makeStubService({ deleteTaskPermanently: async () => undefined });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/task-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("returns 409 for non-archived task", async () => {
    const service = makeStubService({
      deleteTaskPermanently: async () => {
        throw new Error("Cannot delete task task-1: task must be archived before permanent deletion");
      }
    });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/task-1", { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  test("returns 404 for unknown task id", async () => {
    const service = makeStubService({
      deleteTaskPermanently: async () => {
        throw new Error("Task not found: unknown-id");
      }
    });
    const app = buildApp(service, db);

    const res = await app.request("/tasks/unknown-id", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("publishes task.deleted event with taskId on success", async () => {
    const service = makeStubService({ deleteTaskPermanently: async () => undefined });
    const events = new LiveEventHub();
    const app = new Hono();
    app.route("/tasks", createTaskRoutes(service, events, db));

    const published: Array<{ type: string; data: unknown }> = [];
    events.subscribe((payload) => {
      const lines = payload.trim().split("\n");
      const eventType = lines[0].replace("event: ", "");
      const data = JSON.parse(lines[1].replace("data: ", ""));
      published.push({ type: eventType, data });
    });

    await app.request("/tasks/task-1", { method: "DELETE" });
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe("task.deleted");
    expect((published[0].data as any).taskId).toBe("task-1");
  });
});

describe("GET /tasks — archive filtering", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-list-routes-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("defaults to active only (no archived)", async () => {
    let capturedOpts: unknown;
    const service = makeStubService({
      listTasks: (opts) => { capturedOpts = opts; return []; }
    });
    const app = buildApp(service, db);

    await app.request("/tasks");
    expect(capturedOpts).toBeUndefined();
  });

  test("?archived=true returns only archived tasks", async () => {
    let capturedOpts: unknown;
    const service = makeStubService({
      listTasks: (opts) => { capturedOpts = opts; return []; }
    });
    const app = buildApp(service, db);

    await app.request("/tasks?archived=true");
    expect(capturedOpts).toEqual({ onlyArchived: true });
  });

  test("?includeArchived=true returns all tasks", async () => {
    let capturedOpts: unknown;
    const service = makeStubService({
      listTasks: (opts) => { capturedOpts = opts; return []; }
    });
    const app = buildApp(service, db);

    await app.request("/tasks?includeArchived=true");
    expect(capturedOpts).toEqual({ includeArchived: true });
  });
});
