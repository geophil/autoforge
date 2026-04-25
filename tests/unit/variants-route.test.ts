import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { DbClient } from "../../src/db/client";
import { createVariantsRoutes } from "../../src/web/routes/variants";
import { seedVariant } from "../helpers/population-fixtures";

const schemaPath = resolve(process.cwd(), "src/db/schema.sql");
const migrationsPath = resolve(process.cwd(), "src/db/migrations");

function buildApp(db: DbClient): Hono {
  const app = new Hono();
  app.route("/api/variants", createVariantsRoutes(db));
  return app;
}

function seedCompletedTask(db: DbClient, input: { taskId: string; projectId?: string; createdAt?: string }): void {
  const projectId = input.projectId ?? "autoforge";
  const createdAt = input.createdAt ?? "2026-04-24T00:00:00Z";

  db.sqlite.query(`
    INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
    VALUES (?, ?, 'quality task', 'completed', 'STANDARD', '{}', '[]', 0, ?, ?)
  `).run(input.taskId, projectId, createdAt, createdAt);

  db.insertTaskDiffStats(input.taskId, {
    files_changed: 1,
    files_added: 0,
    files_modified: 1,
    files_deleted: 0,
    lines_added: 20,
    lines_deleted: 0,
    test_files_changed: 1
  });
}

function seedSelectedScoredTask(
  db: DbClient,
  input: { taskId: string; variantId: string; projectId?: string; selectedAt?: string }
): void {
  const projectId = input.projectId ?? "autoforge";
  const selectedAt = input.selectedAt ?? "2026-04-24T00:01:00Z";
  seedCompletedTask(db, { taskId: input.taskId, projectId, createdAt: selectedAt });

  db.sqlite.query(`
    INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
    VALUES (?, ?, ?, ?, 'orchestrator', 'variant_selected', 'done', ?, 60)
  `).run(
    randomUUID(),
    input.taskId,
    selectedAt,
    projectId,
    JSON.stringify({
      agent_type: "coder",
      selected_variant_id: input.variantId,
      selected_variant_specialty: null,
      eligible_variant_ids: [input.variantId],
      selection_rationale: "exploitation",
      shadow_variant_ids: [],
      injected_lesson_ids: []
    })
  );
}

function seedShadowRun(
  db: DbClient,
  input: { eventId: string; taskId: string; candidateId: string; timestamp?: string }
): void {
  db.sqlite.query(`
    INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
    VALUES (?, ?, ?, 'autoforge', 'orchestrator', 'shadow_run_completed', 'done', ?, 0)
  `).run(
    input.eventId,
    input.taskId,
    input.timestamp ?? "2026-04-24T00:02:00Z",
    JSON.stringify({
      baseline_variant_id: "coder-base",
      candidate_variant_id: input.candidateId,
      baseline_composite: 0.6,
      candidate_composite: 0.8,
      baseline_score_components: { correctness: 0.6 },
      candidate_score_components: { correctness: 0.8 }
    })
  );
}

describe("GET /api/variants/:agentType", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-variants-route-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(schemaPath, migrationsPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns the seeded baseline allocation row for coder", async () => {
    seedVariant(db, { id: "coder-base", skill: "persona:coder", status: "baseline", share: 0.8 });
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      agentType: "coder",
      variants: [
        {
          id: "coder-base",
          agentType: "coder",
          status: "baseline",
          trafficShare: 0.8
        }
      ]
    });
  });

  test("includes active and candidate allocation rows when seeded", async () => {
    seedVariant(db, { id: "coder-base", skill: "persona:coder", status: "baseline", share: 0.7 });
    seedVariant(db, { id: "coder-active", skill: "persona:coder", status: "active", share: 0.2, specialty: "frontend" });
    seedVariant(db, { id: "coder-candidate", skill: "persona:coder", status: "candidate", share: 0, parent: "coder-base" });
    seedVariant(db, { id: "planner-base", skill: "persona:planner", status: "baseline", share: 1 });
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.variants).toMatchObject([
      { id: "coder-base", status: "baseline", trafficShare: 0.7 },
      { id: "coder-active", status: "active", trafficShare: 0.2, specialty: "frontend" },
      { id: "coder-candidate", status: "candidate", trafficShare: 0, parentVersionId: "coder-base" }
    ]);
  });

  test("returns an empty array for an agent type with no variants", async () => {
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ agentType: "coder", variants: [] });
  });
});

describe("GET /api/variants/:id/scores", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-variant-scores-route-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(schemaPath, migrationsPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns recent score rows where the variant was selected and excludes other variants", async () => {
    seedSelectedScoredTask(db, { taskId: "task-selected", variantId: "coder-active", selectedAt: "2026-04-24T00:03:00Z" });
    seedSelectedScoredTask(db, { taskId: "task-other", variantId: "coder-other", selectedAt: "2026-04-24T00:04:00Z" });
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder-active/scores");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.variantId).toBe("coder-active");
    expect(body.scores).toHaveLength(1);
    expect(body.scores[0]).toMatchObject({
      taskId: "task-selected",
      projectId: "autoforge",
      tier: "STANDARD",
      selectedAt: "2026-04-24T00:03:00Z"
    });
    expect(body.scores[0].composite).toBeNumber();
  });

  test("ignores malformed variant_selected payloads instead of returning 500", async () => {
    seedSelectedScoredTask(db, { taskId: "task-selected", variantId: "coder-active", selectedAt: "2026-04-24T00:03:00Z" });
    seedCompletedTask(db, { taskId: "task-malformed", createdAt: "2026-04-24T00:04:00Z" });
    db.sqlite.query(`
      INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
      VALUES (?, 'task-malformed', '2026-04-24T00:04:00Z', 'autoforge', 'orchestrator', 'variant_selected', 'done', ?, 60)
    `).run(randomUUID(), "{not-json");
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder-active/scores");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scores).toHaveLength(1);
    expect(body.scores[0].taskId).toBe("task-selected");
  });

  test("returns an empty scores array when no tasks selected the variant", async () => {
    const app = buildApp(db);

    const res = await app.request("/api/variants/missing/scores");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ variantId: "missing", scores: [] });
  });
});

describe("GET /api/variants/:id/shadow", () => {
  let db: DbClient;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "autoforge-variant-shadow-route-"));
    db = new DbClient(join(tempDir, "test.db"));
    db.initSchema(schemaPath, migrationsPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns shadow events for the candidate id newest-first and excludes other candidates", async () => {
    seedShadowRun(db, {
      eventId: "shadow-older",
      taskId: "task-shadow-older",
      candidateId: "coder-candidate",
      timestamp: "2026-04-24T00:01:00Z"
    });
    seedShadowRun(db, {
      eventId: "shadow-newer",
      taskId: "task-shadow-newer",
      candidateId: "coder-candidate",
      timestamp: "2026-04-24T00:02:00Z"
    });
    seedShadowRun(db, { eventId: "shadow-other", taskId: "task-shadow-other", candidateId: "coder-other" });
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder-candidate/shadow");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.variantId).toBe("coder-candidate");
    expect(body.shadowRuns).toMatchObject([
      {
        id: "shadow-newer",
        taskId: "task-shadow-newer",
        status: "done",
        candidateVariantId: "coder-candidate",
        baselineVariantId: "coder-base",
        baselineComposite: 0.6,
        candidateComposite: 0.8
      },
      {
        id: "shadow-older",
        taskId: "task-shadow-older"
      }
    ]);
  });

  test("returns at most fifty recent shadow events", async () => {
    for (let index = 0; index < 52; index += 1) {
      seedShadowRun(db, {
        eventId: `shadow-${index.toString().padStart(2, "0")}`,
        taskId: `task-shadow-${index.toString().padStart(2, "0")}`,
        candidateId: "coder-candidate",
        timestamp: `2026-04-24T00:${index.toString().padStart(2, "0")}:00Z`
      });
    }
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder-candidate/shadow");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.shadowRuns).toHaveLength(50);
    expect(body.shadowRuns[0].id).toBe("shadow-51");
    expect(body.shadowRuns.at(-1).id).toBe("shadow-02");
  });

  test("ignores malformed shadow payloads instead of returning 500", async () => {
    seedShadowRun(db, {
      eventId: "shadow-valid",
      taskId: "task-shadow-valid",
      candidateId: "coder-candidate",
      timestamp: "2026-04-24T00:01:00Z"
    });
    db.sqlite.query(`
      INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
      VALUES ('shadow-malformed', 'task-shadow-malformed', '2026-04-24T00:02:00Z', 'autoforge', 'orchestrator', 'shadow_run_completed', 'done', ?, 0)
    `).run("{not-json");
    const app = buildApp(db);

    const res = await app.request("/api/variants/coder-candidate/shadow");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.shadowRuns).toMatchObject([
      {
        id: "shadow-valid",
        taskId: "task-shadow-valid"
      }
    ]);
  });

  test("returns an empty shadow run array when no shadow events match", async () => {
    const app = buildApp(db);

    const res = await app.request("/api/variants/missing/shadow");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ variantId: "missing", shadowRuns: [] });
  });
});
