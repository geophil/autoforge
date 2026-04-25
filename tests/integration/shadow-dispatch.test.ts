import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";
import { loadEnv } from "../../src/config/env";
import { WorktreeManager } from "../../src/git/worktrees";
import { OrchestratorService } from "../../src/orchestrator/service";
import { MockExecutor } from "../../src/executors/mock";
import { createDispatcher } from "../../src/orchestrator/dispatch";
import type { AgentResult, AgentTask } from "../../src/executors/interface";

type Handlers = Partial<Record<AgentTask["type"], (task: AgentTask) => AgentResult | Promise<AgentResult>>>;

function createShadowTestService(input: {
  randomValues?: number[];
  handlers?: Handlers;
  shadowRunner?: unknown;
} = {}): { service: OrchestratorService; db: DbClient; cleanup: () => void } {
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "autoforge-shadow-test-")));
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
    random: () => input.randomValues?.[randomIndex++] ?? 0
  });
  const worktrees = new WorktreeManager(join(baseDir, "worktrees"));
  const deps = {
    env,
    db,
    executor: new MockExecutor(input.handlers ?? {}),
    worktrees,
    dispatcher,
    shadowRunner: input.shadowRunner,
    testRunner: async () => ({ passRate: 1, output: "mock test runner" }),
    prCreator: async (payload: { branch: string }) =>
      `https://github.com/local/autoforge/pull/mock?branch=${encodeURIComponent(payload.branch)}`
  };
  const service = new OrchestratorService(
    deps as unknown as ConstructorParameters<typeof OrchestratorService>[0]
  );

  return {
    service,
    db,
    cleanup: () => {
      try {
        const porcelain = execSync("git worktree list --porcelain", { encoding: "utf8" });
        const branchesToDelete: string[] = [];
        for (const block of porcelain.split("\n\n")) {
          const wtLine = block.split("\n").find((line) => line.startsWith("worktree "));
          const brLine = block.split("\n").find((line) => line.startsWith("branch "));
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
        // Nothing to clean up outside a git checkout.
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

function seedBaselineAndCandidate(db: DbClient): void {
  seedBaselineAndCandidateForAgent(db, "coder");
}

function seedBaselineAndCandidateForAgent(db: DbClient, agentType: string): void {
  seedPersonaVariant(db, {
    id: `${agentType}-base`,
    agentType,
    content: `BASE ${agentType.toUpperCase()} PERSONA`,
    status: "baseline",
    share: 0.5
  });
  seedPersonaVariant(db, {
    id: `${agentType}-candidate`,
    agentType,
    content: `CANDIDATE ${agentType.toUpperCase()} PERSONA`,
    status: "candidate",
    share: 0
  });
}

function seedCandidateLesson(db: DbClient): string {
  db.sqlite.query(
    "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('seed-shadow','autoforge','seed','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
  ).run();
  return db.insertLesson({
    agentType: "coder",
    lineageRootId: "coder-candidate",
    sourceTaskId: "seed-shadow",
    sourceVariantId: "coder-candidate",
    triggerPattern: "frontend bug",
    body: "TRIGGER: frontend bug\nOBSERVATION: candidate lesson\nPRINCIPLE: keep UI fixes focused\nEVIDENCE: seeded shadow lesson",
    outcomeKind: "reinforcing",
    retrievalKeywords: "frontend bug"
  });
}

function shadowEvents(db: DbClient, taskId: string): Array<Record<string, unknown>> {
  return db.listEvents(taskId)
    .filter((event) => event.type === "shadow_run_completed")
    .map((event) => event.payload);
}

const successfulShadowRunner = async () => ({
  scoreComponents: { mocked_shadow: true },
  composite: 0.8,
  executorUsed: "mock-shadow"
});

describe("shadow dispatch evaluation", () => {
  test("candidate in selection emits shadow_run_completed without changing live task output", async () => {
    const { service, db, cleanup } = createShadowTestService({
      shadowRunner: successfulShadowRunner,
      handlers: {
        coder: () => ({
          status: "DONE",
          artifacts: ["live-artifact"],
          metrics: { elapsedSeconds: 0.1 }
        })
      }
    });

    try {
      seedBaselineAndCandidate(db);

      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

      expect(task.state).toBe("awaiting_approval");
      const shadow = shadowEvents(db, task.id)[0];
      expect(shadow).toMatchObject({
        baseline_executor_used: "mock",
        candidate_executor_used: "mock-shadow",
        candidate_score_components: { mocked_shadow: true },
        candidate_composite: 0.8
      });

      const subtaskDone = db.listEvents(task.id).find((event) => event.type === "subtask_done");
      expect(subtaskDone?.payload.artifacts).toEqual(["live-artifact"]);
    } finally {
      cleanup();
    }
  });

  test("default shadow runner records not-configured evidence instead of placeholder candidate scores", async () => {
    const { service, db, cleanup } = createShadowTestService();

    try {
      seedBaselineAndCandidate(db);

      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

      const shadow = shadowEvents(db, task.id)[0];
      expect(shadow?.baseline_variant_id).toBe("coder-base");
      expect(shadow?.candidate_variant_id).toBe("coder-candidate");
      expect(shadow?.candidate_score_components).toBeNull();
      expect(shadow?.candidate_composite).toBeNull();
      expect(shadow?.candidate_executor_used).toBeNull();
      expect(shadow?.error).toBe("shadow_runner_not_configured");
    } finally {
      cleanup();
    }
  });

  test("shadow failure is recorded with error while live task still succeeds", async () => {
    const { service, db, cleanup } = createShadowTestService({
      shadowRunner: async () => {
        throw new Error("candidate scoring unavailable");
      }
    });

    try {
      seedBaselineAndCandidate(db);

      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

      expect(task.state).toBe("awaiting_approval");
      const shadow = shadowEvents(db, task.id)[0];
      expect(shadow?.baseline_executor_used).toBe("mock");
      expect(shadow?.candidate_score_components).toBeNull();
      expect(shadow?.error).toBe("candidate scoring unavailable");
    } finally {
      cleanup();
    }
  });

  test("no shadow_run_completed event is emitted when shadow_variant_ids is empty", async () => {
    const { service, db, cleanup } = createShadowTestService();

    try {
      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

      expect(task.state).toBe("awaiting_approval");
      expect(shadowEvents(db, task.id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("shadow event includes lesson counts and selected and candidate variant ids", async () => {
    const { service, db, cleanup } = createShadowTestService({
      shadowRunner: successfulShadowRunner
    });

    try {
      seedBaselineAndCandidate(db);
      const lessonId = seedCandidateLesson(db);

      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

      const shadow = shadowEvents(db, task.id)[0];
      expect(shadow).toMatchObject({
        task_id: task.id,
        agent_type: "coder",
        baseline_variant_id: "coder-base",
        candidate_variant_id: "coder-candidate",
        baseline_executor_used: "mock",
        baseline_lessons_injected: 0,
        candidate_lessons_injected: 1
      });
      expect(shadow?.candidate_lesson_ids).toEqual([lessonId]);
      expect(shadow?.candidate_executor_used).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("active live selection records actual baseline id for candidate shadow", async () => {
    const { service, db, cleanup } = createShadowTestService({
      randomValues: [0.8, 0],
      handlers: {
        coder: () => ({
          status: "DONE",
          artifacts: [],
          metrics: { elapsedSeconds: 0.1 }
        })
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

      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

      const selected = db.listEvents(task.id)
        .find((event) =>
          event.type === "variant_selected"
          && event.payload.agent_type === "coder"
        )?.payload;
      expect(selected?.selected_variant_id).toBe("coder-active");
      const shadow = shadowEvents(db, task.id)
        .find((event) => event.candidate_variant_id === "coder-candidate");
      expect(shadow?.baseline_variant_id).toBe("coder-base");
      expect(shadow?.baseline_variant_id).not.toBe("coder-active");
      expect(shadow?.candidate_score_components).toBeNull();
      expect(shadow?.candidate_composite).toBeNull();
      expect(shadow?.candidate_executor_used).toBeNull();
      expect(shadow?.error).toBe("baseline_not_live");
    } finally {
      cleanup();
    }
  });

  test("planner candidate in selection emits shadow_run_completed while live task succeeds", async () => {
    const { service, db, cleanup } = createShadowTestService();

    try {
      seedBaselineAndCandidateForAgent(db, "planner");

      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });

      expect(task.state).toBe("awaiting_approval");
      const shadow = shadowEvents(db, task.id).find((event) => event.agent_type === "planner");
      expect(shadow).toMatchObject({
        task_id: task.id,
        agent_type: "planner",
        baseline_variant_id: "planner-base",
        candidate_variant_id: "planner-candidate",
        baseline_executor_used: "mock"
      });
      expect(db.listEvents(task.id).some((event) => event.type === "planned")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("reviewer candidate in selection emits shadow_run_completed while live task succeeds", async () => {
    const { service, db, cleanup } = createShadowTestService();

    try {
      seedBaselineAndCandidateForAgent(db, "reviewer");

      const task = await service.submitTask(
        "autoforge",
        "frontend bug",
        { forceTier: "STANDARD", reviewPlan: false }
      );

      expect(task.state).toBe("awaiting_approval");
      const shadow = shadowEvents(db, task.id).find((event) => event.agent_type === "reviewer");
      expect(shadow).toMatchObject({
        task_id: task.id,
        agent_type: "reviewer",
        baseline_variant_id: "reviewer-base",
        candidate_variant_id: "reviewer-candidate",
        baseline_executor_used: "mock"
      });
      expect(db.listEvents(task.id).some((event) => event.type === "review_done")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("doc candidate in selection emits shadow_run_completed during approval documentation", async () => {
    const { service, db, cleanup } = createShadowTestService();

    try {
      seedBaselineAndCandidateForAgent(db, "doc");

      const task = await service.submitTask("autoforge", "frontend bug", { forceTier: "EXPRESS" });
      expect(task.state).toBe("awaiting_approval");

      const approved = await service.approveTask(task.id);
      expect(approved.state).toBe("completed");

      const shadow = shadowEvents(db, task.id).find((event) => event.agent_type === "doc");
      expect(shadow).toMatchObject({
        task_id: task.id,
        agent_type: "doc",
        baseline_variant_id: "doc-base",
        candidate_variant_id: "doc-candidate",
        baseline_executor_used: "mock"
      });
      expect(db.listEvents(task.id).some((event) => event.type === "doc_done")).toBe(true);
    } finally {
      cleanup();
    }
  });
});
