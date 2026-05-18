import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestService } from "../helpers/create-service";
import { PersonaRegistry } from "../../src/personas/registry";
import { DbClient } from "../../src/db/client";
import { loadEnv } from "../../src/config/env";
import { WorktreeManager } from "../../src/git/worktrees";
import { OrchestratorService } from "../../src/orchestrator/service";
import { MockExecutor } from "../../src/executors/mock";
import type { AgentTask, AgentResult } from "../../src/executors/interface";
import { createDispatcher } from "../../src/orchestrator/dispatch";
import { serializeEmbedding, type EmbeddingProvider } from "../../src/orchestrator/embedding";

type Handlers = Partial<Record<AgentTask["type"], (task: AgentTask) => AgentResult | Promise<AgentResult>>>;

function createDispatchTestService(
  randomValues: number[],
  handlers: Handlers = {},
  options: { embeddingProvider?: EmbeddingProvider; useServiceConstructedDispatcher?: boolean } = {}
): { service: OrchestratorService; db: DbClient; cleanup: () => void } {
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "autoforge-dispatch-test-")));
  const dbPath = join(baseDir, `${randomUUID()}.sqlite`);
  const db = new DbClient(dbPath);
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );

  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_PATH: dbPath,
    EXECUTOR_DEFAULT: "mock",
    REVIEW_SCORE_THRESHOLD: "0.7",
    TEST_PASS_THRESHOLD: "1"
  });
  let randomIndex = 0;
  const dispatcher = createDispatcher(db, {
    random: () => randomValues[randomIndex++] ?? 0
  });
  const worktrees = new WorktreeManager(join(baseDir, "worktrees"));
  const service = new OrchestratorService({
    env,
    db,
    executor: new MockExecutor(handlers),
    worktrees,
    ...(options.useServiceConstructedDispatcher ? {} : { dispatcher }),
    embeddingProvider: options.embeddingProvider,
    testRunner: async () => ({ passRate: 1, output: "mock test runner", verificationStatus: "passed", runner: "mock" }),
    prCreator: async (payload) => `https://github.com/local/autoforge/pull/mock?branch=${encodeURIComponent(payload.branch)}`
  });

  return {
    service,
    db,
    cleanup: () => {
      try {
        const porcelain = execSync("git worktree list --porcelain", { encoding: "utf8" });
        const branchesToDelete: string[] = [];
        for (const block of porcelain.split("\n\n")) {
          const wtLine = block.split("\n").find((l) => l.startsWith("worktree "));
          const brLine = block.split("\n").find((l) => l.startsWith("branch "));
          if (!wtLine) continue;
          const wtPath = wtLine.slice("worktree ".length);
          if (!wtPath.startsWith(baseDir)) continue;
          spawnSync("git", ["worktree", "remove", "--force", wtPath], { stdio: "ignore" });
          if (brLine) {
            const branch = brLine.slice("branch refs/heads/".length);
            if (branch.startsWith("autoforge/")) branchesToDelete.push(branch);
          }
        }
        spawnSync("git", ["worktree", "prune"], { stdio: "ignore" });
        for (const branch of branchesToDelete) {
          spawnSync("git", ["branch", "-D", branch], { stdio: "ignore" });
        }
      } catch {
        // No git worktrees to clean up.
      }
      try {
        (db.sqlite as unknown as { close?: () => void }).close?.();
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }
  };
}

function seedPersonaVariant(
  db: DbClient,
  input: {
    id: string;
    agentType: string;
    content: string;
    status: "baseline" | "active" | "candidate";
    share: number;
    specialty?: string | null;
    parent?: string | null;
  }
): void {
  db.sqlite.query(`
    INSERT INTO skill_versions
      (id, skill_name, version, content, status, traffic_share, specialty, parent_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `persona:${input.agentType}`,
    input.id,
    input.content,
    input.status,
    input.share,
    input.specialty ?? null,
    input.parent ?? null
  );
}

function payloadsFor(db: DbClient, taskId: string, agentType: string): Array<Record<string, unknown>> {
  return db.sqlite.query(
    `SELECT payload FROM events
      WHERE task_id = ?
        AND event_type = 'variant_selected'
        AND json_extract(payload, '$.agent_type') = ?
      ORDER BY timestamp ASC`
  ).all(taskId, agentType).map((row) => JSON.parse((row as { payload: string }).payload) as Record<string, unknown>);
}

describe("lesson injection at dispatch", () => {
  test("variant_selected for coder carries non-empty injected_lesson_ids when a matching lesson exists", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      // Snapshot the coder persona into skill_versions so we have an id to root the lineage on.
      const personas = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
      const coderVariantId = personas.snapshotId("coder");

      // Seed a task + a coder lesson that overlaps with the keywords in the description.
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('seed-task','autoforge','seed','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.insertLesson({
        agentType: "coder",
        lineageRootId: db.resolveLineageRoot(coderVariantId) ?? coderVariantId,
        sourceTaskId: "seed-task",
        sourceVariantId: coderVariantId,
        triggerPattern: "react styling",
        body: "TRIGGER: react\nOBSERVATION: use css modules\nPRINCIPLE: scope styles per component\nEVIDENCE: prior task",
        outcomeKind: "corrective",
        retrievalKeywords: "react styling component"
      });

      const task = await service.submitTask(
        "autoforge",
        "Style a React component with CSS modules",
        { reviewPlan: false }
      );
      expect(task.state).toBe("awaiting_approval");

      const coderEvent = db.sqlite.query(
        `SELECT payload FROM events
          WHERE task_id = ?
            AND event_type = 'variant_selected'
            AND json_extract(payload, '$.agent_type') = 'coder'
          ORDER BY timestamp ASC LIMIT 1`
      ).get(task.id) as { payload: string };

      const payload = JSON.parse(coderEvent.payload) as Record<string, unknown>;
      expect(Array.isArray(payload.injected_lesson_ids)).toBe(true);
      expect((payload.injected_lesson_ids as string[]).length).toBeGreaterThanOrEqual(1);
      expect(payload.selection_rationale).toBe("only_eligible");
      expect(payload.eligible_variant_ids).toEqual([payload.selected_variant_id]);
      expect(payload.shadow_variant_ids).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("active exploitation dispatch records full selection payload and uses selected persona content", async () => {
    const observedPrompts: string[] = [];
    const { service, db, cleanup } = createDispatchTestService([0.8, 0], {
      coder: (task) => {
        observedPrompts.push(task.systemPrompt);
        return { status: "DONE", artifacts: [], metrics: { elapsedSeconds: 0.1 } };
      }
    });

    try {
      seedPersonaVariant(db, {
        id: "planner-base",
        agentType: "planner",
        content: "BASE PLANNER PERSONA",
        status: "baseline",
        share: 1
      });
      seedPersonaVariant(db, {
        id: "coder-base",
        agentType: "coder",
        content: "BASE CODER PERSONA",
        status: "baseline",
        share: 0.5,
        specialty: "general"
      });
      seedPersonaVariant(db, {
        id: "coder-active",
        agentType: "coder",
        content: "ACTIVE CODER PERSONA",
        status: "active",
        share: 0.4,
        specialty: "React UI"
      });
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('seed-active','autoforge','seed','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      const activeLessonId = db.insertLesson({
        agentType: "coder",
        lineageRootId: "coder-active",
        sourceTaskId: "seed-active",
        sourceVariantId: "coder-active",
        triggerPattern: "react ui",
        body: "TRIGGER: react\nOBSERVATION: selected active content\nPRINCIPLE: retrieve from selected lineage\nEVIDENCE: seeded active lesson",
        outcomeKind: "reinforcing",
        retrievalKeywords: "react ui component"
      });

      const task = await service.submitTask(
        "autoforge",
        "Build a React UI component",
        { reviewPlan: false, forceTier: "EXPRESS" }
      );

      const [coderPayload] = payloadsFor(db, task.id, "coder");
      expect(coderPayload.selection_rationale).toBe("exploitation");
      expect(coderPayload.selected_variant_id).toBe("coder-active");
      expect(coderPayload.selected_variant_specialty).toBe("React UI");
      expect(coderPayload.eligible_variant_ids).toEqual(expect.arrayContaining(["coder-base", "coder-active"]));
      expect(coderPayload.shadow_variant_ids).toEqual([]);
      expect(coderPayload.injected_lesson_ids).toContain(activeLessonId);
      expect(observedPrompts).toContain("ACTIVE CODER PERSONA");
      expect(observedPrompts).not.toContain("BASE CODER PERSONA");
    } finally {
      cleanup();
    }
  });

  test("service-constructed dispatcher uses injected embedding provider for eligibility", async () => {
    let embedCalls = 0;
    const embeddingProvider: EmbeddingProvider = {
      async embed(): Promise<number[]> {
        embedCalls += 1;
        return [1, 0];
      }
    };
    const { service, db, cleanup } = createDispatchTestService([], {}, {
      embeddingProvider,
      useServiceConstructedDispatcher: true
    });

    try {
      seedPersonaVariant(db, {
        id: "planner-base",
        agentType: "planner",
        content: "BASE PLANNER PERSONA",
        status: "baseline",
        share: 1
      });
      seedPersonaVariant(db, {
        id: "coder-base",
        agentType: "coder",
        content: "BASE CODER PERSONA",
        status: "baseline",
        share: 0.5
      });
      seedPersonaVariant(db, {
        id: "coder-active-embedding",
        agentType: "coder",
        content: "ACTIVE EMBEDDING CODER PERSONA",
        status: "active",
        share: 0.5,
        specialty: "watercolor illustration"
      });
      db.sqlite.query("UPDATE skill_versions SET specialty_embedding = ? WHERE id = ?")
        .run(serializeEmbedding([1, 0]), "coder-active-embedding");

      const task = await service.submitTask(
        "autoforge",
        "fix React button styling",
        { reviewPlan: false, forceTier: "EXPRESS" }
      );

      const [coderPayload] = payloadsFor(db, task.id, "coder");
      expect(embedCalls).toBeGreaterThanOrEqual(1);
      expect(coderPayload.eligible_variant_ids).toEqual(
        expect.arrayContaining(["coder-base", "coder-active-embedding"])
      );
    } finally {
      cleanup();
    }
  });

  test("candidate variants are carried as shadows and emit shadow evaluation events", async () => {
    const executedTypes: string[] = [];
    const { service, db, cleanup } = createDispatchTestService([0.2], {
      coder: (task) => {
        executedTypes.push(task.type);
        return { status: "DONE", artifacts: [], metrics: { elapsedSeconds: 0.1 } };
      }
    });

    try {
      seedPersonaVariant(db, {
        id: "planner-base",
        agentType: "planner",
        content: "BASE PLANNER PERSONA",
        status: "baseline",
        share: 1
      });
      seedPersonaVariant(db, {
        id: "coder-base",
        agentType: "coder",
        content: "BASE CODER PERSONA",
        status: "baseline",
        share: 0.5
      });
      seedPersonaVariant(db, {
        id: "coder-active",
        agentType: "coder",
        content: "ACTIVE CODER PERSONA",
        status: "active",
        share: 0.4
      });
      seedPersonaVariant(db, {
        id: "coder-candidate",
        agentType: "coder",
        content: "CANDIDATE CODER PERSONA",
        status: "candidate",
        share: 0
      });

      const task = await service.submitTask(
        "autoforge",
        "Implement a small feature",
        { reviewPlan: false, forceTier: "EXPRESS" }
      );

      const [coderPayload] = payloadsFor(db, task.id, "coder");
      expect(coderPayload.selected_variant_id).toBe("coder-base");
      expect(coderPayload.shadow_variant_ids).toEqual(["coder-candidate"]);
      expect(executedTypes).toEqual(["coder"]);
      const shadowEvent = db.sqlite.query(
        "SELECT payload FROM events WHERE task_id = ? AND event_type = 'shadow_run_completed'"
      ).get(task.id) as { payload: string };
      const shadowPayload = JSON.parse(shadowEvent.payload) as Record<string, unknown>;
      expect(shadowPayload.candidate_variant_id).toBe("coder-candidate");
    } finally {
      cleanup();
    }
  });

  test("candidate-only exploration traffic stays on baseline while candidate shadows", async () => {
    const observedPrompts: string[] = [];
    const { service, db, cleanup } = createDispatchTestService([0.55], {
      coder: (task) => {
        observedPrompts.push(task.systemPrompt);
        return { status: "DONE", artifacts: [], metrics: { elapsedSeconds: 0.1 } };
      }
    });

    try {
      seedPersonaVariant(db, {
        id: "planner-base",
        agentType: "planner",
        content: "BASE PLANNER PERSONA",
        status: "baseline",
        share: 1
      });
      seedPersonaVariant(db, {
        id: "coder-base",
        agentType: "coder",
        content: "BASE CODER PERSONA",
        status: "baseline",
        share: 0.5
      });
      seedPersonaVariant(db, {
        id: "coder-candidate",
        agentType: "coder",
        content: "CANDIDATE CODER PERSONA",
        status: "candidate",
        share: 0
      });

      const task = await service.submitTask(
        "autoforge",
        "Implement a candidate-shadowed feature",
        { reviewPlan: false, forceTier: "EXPRESS" }
      );

      const [coderPayload] = payloadsFor(db, task.id, "coder");
      expect(coderPayload.selected_variant_id).toBe("coder-base");
      expect(coderPayload.selection_rationale).toBe("baseline");
      expect(coderPayload.shadow_variant_ids).toEqual(["coder-candidate"]);
      expect(observedPrompts).toContain("BASE CODER PERSONA");
      expect(observedPrompts).not.toContain("CANDIDATE CODER PERSONA");
    } finally {
      cleanup();
    }
  });

  test("bootstrapped persona row becomes baseline before candidate dispatch", async () => {
    const { service, db, cleanup } = createDispatchTestService([0.2]);

    try {
      const firstTask = await service.submitTask(
        "autoforge",
        "Bootstrap the coder persona",
        { reviewPlan: false, forceTier: "EXPRESS" }
      );
      expect(firstTask.state).toBe("awaiting_approval");

      const bootstrapped = db.sqlite.query(
        "SELECT id FROM skill_versions WHERE skill_name = 'persona:coder' LIMIT 1"
      ).get() as { id: string };
      seedPersonaVariant(db, {
        id: "boot-candidate",
        agentType: "coder",
        content: "BOOTSTRAPPED CANDIDATE CODER PERSONA",
        status: "candidate",
        share: 0,
        parent: bootstrapped.id
      });

      const secondTask = await service.submitTask(
        "autoforge",
        "Dispatch after candidate exists",
        { reviewPlan: false, forceTier: "EXPRESS" }
      );

      const [coderPayload] = payloadsFor(db, secondTask.id, "coder");
      expect(coderPayload.selection_rationale).toBe("baseline");
      expect(coderPayload.selected_variant_id).toBe(bootstrapped.id);
      expect(coderPayload.eligible_variant_ids).toEqual(expect.arrayContaining([bootstrapped.id, "boot-candidate"]));
      expect(coderPayload.shadow_variant_ids).toEqual(["boot-candidate"]);
      const bootstrappedStatus = db.sqlite.query(
        "SELECT status, traffic_share FROM skill_versions WHERE id = ?"
      ).get(bootstrapped.id) as { status: string; traffic_share: number };
      expect(bootstrappedStatus.status).toBe("baseline");
      expect(bootstrappedStatus.traffic_share).toBe(0.9);
      const normalizationEvent = db.sqlite.query(
        `SELECT payload FROM events
          WHERE event_type = 'traffic_allocated'
            AND json_extract(payload, '$.variant_id') = ?
            AND json_extract(payload, '$.reason') = 'dispatch_bootstrap'
            AND json_extract(payload, '$.new_status') = 'baseline'
            AND json_extract(payload, '$.new_traffic_share') = 0.9`
      ).get(bootstrapped.id);
      expect(normalizationEvent).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("variant_selected for meta carries empty injected_lesson_ids (meta bypasses retrieval)", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      // Seed a lesson that would match if retrieval ran, just to prove it doesn't.
      const personas = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
      const metaVariantId = personas.snapshotId("meta");
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('seed-meta','autoforge','seed','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.insertLesson({
        agentType: "meta",
        lineageRootId: db.resolveLineageRoot(metaVariantId) ?? metaVariantId,
        sourceTaskId: "seed-meta",
        sourceVariantId: metaVariantId,
        triggerPattern: "meta review tasks",
        body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
        outcomeKind: "corrective",
        retrievalKeywords: "meta review tone"
      });

      await service.submitMetaTask("autoforge", "meta review tone");

      const metaEvent = db.sqlite.query(
        `SELECT payload FROM events
          WHERE event_type = 'variant_selected'
            AND json_extract(payload, '$.agent_type') = 'meta'
          ORDER BY timestamp DESC LIMIT 1`
      ).get() as { payload: string };

      const payload = JSON.parse(metaEvent.payload) as Record<string, unknown>;
      expect(payload.injected_lesson_ids).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
