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

const TWO_SUBTASK_PLANNER: Handlers["planner"] = (task) => ({
  status: "DONE",
  artifacts: [],
  output: {
    subtasks: [
      {
        id: `${task.id}-sub-1`,
        sequence: 1,
        description: "First implementation subtask",
        filesInScope: ["src/"],
        dependencies: [],
        testCriteria: ["First test passes."]
      },
      {
        id: `${task.id}-sub-2`,
        sequence: 2,
        description: "Second implementation subtask",
        filesInScope: ["src/"],
        dependencies: [],
        testCriteria: ["Second test passes."]
      }
    ]
  },
  metrics: { elapsedSeconds: 0.1 }
});

const DONE_CODER: Handlers["coder"] = () => ({
  status: "DONE",
  artifacts: ["output.ts"],
  metrics: { elapsedSeconds: 0.1 }
});

const MOCK_SHADOW_RUNNER = async () => ({
  scoreComponents: { mocked_shadow: true },
  composite: 0.8,
  executorUsed: "mock-shadow"
});

function createSubtaskTestService(input: {
  handlers?: Handlers;
  shadowRunner?: unknown;
} = {}): { service: OrchestratorService; db: DbClient; cleanup: () => void } {
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "autoforge-subtask-test-")));
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

  const dispatcher = createDispatcher(db, { random: () => 0 });
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

function seedCandidatePersona(db: DbClient): void {
  db.sqlite.query(`
    INSERT INTO skill_versions
      (id, skill_name, version, content, status, traffic_share)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("coder-base", "persona:coder", "coder-base", "BASE CODER PERSONA", "baseline", 0.5);

  db.sqlite.query(`
    INSERT INTO skill_versions
      (id, skill_name, version, content, status, traffic_share)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "coder-candidate", "persona:coder", "coder-candidate",
    "CANDIDATE CODER PERSONA", "candidate", 0
  );
}

describe("subtask_started event emission", () => {
  test("subtask_started emitted before subtask_done for each subtask with correct payload fields", async () => {
    const { service, db, cleanup } = createSubtaskTestService({
      handlers: {
        planner: TWO_SUBTASK_PLANNER,
        coder: DONE_CODER
      }
    });

    try {
      const task = await service.submitTask("autoforge", "multi-subtask feature", {
        forceTier: "EXPRESS"
      });

      expect(task.state).toBe("awaiting_approval");

      const events = db.listEvents(task.id);
      const startedEvents = events.filter((e) => e.type === "subtask_started");
      const doneEvents = events.filter((e) => e.type === "subtask_done");

      // Two subtasks → two started and two done events
      expect(startedEvents).toHaveLength(2);
      expect(doneEvents).toHaveLength(2);

      // For each subtask: subtask_started appears before its matching subtask_done
      for (const started of startedEvents) {
        const matchingDone = doneEvents.find(
          (d) => d.payload.subtaskId === started.payload.subtaskId
        );
        expect(matchingDone).toBeDefined();
        const startedIdx = events.indexOf(started);
        const doneIdx = events.indexOf(matchingDone!);
        expect(startedIdx).toBeLessThan(doneIdx);
      }

      // Payload fields for the first subtask (sequence 1, iteration 0, agentType "coder")
      const firstStarted = startedEvents.find((e) => e.payload.sequence === 1);
      expect(firstStarted).toBeDefined();
      expect(typeof firstStarted!.payload.subtaskId).toBe("string");
      expect(firstStarted!.payload.iteration).toBe(0);
      expect(firstStarted!.payload.sequence).toBe(1);
      expect(firstStarted!.payload.agentType).toBe("coder");

      // Payload fields for the second subtask (sequence 2)
      const secondStarted = startedEvents.find((e) => e.payload.sequence === 2);
      expect(secondStarted).toBeDefined();
      expect(typeof secondStarted!.payload.subtaskId).toBe("string");
      expect(secondStarted!.payload.iteration).toBe(0);
      expect(secondStarted!.payload.sequence).toBe(2);
      expect(secondStarted!.payload.agentType).toBe("coder");
    } finally {
      cleanup();
    }
  });

  test("shadow_run_completed carries subtask_id and iteration matching the surrounding subtask", async () => {
    const { service, db, cleanup } = createSubtaskTestService({
      shadowRunner: MOCK_SHADOW_RUNNER,
      handlers: {
        planner: TWO_SUBTASK_PLANNER,
        coder: DONE_CODER
      }
    });

    try {
      seedCandidatePersona(db);

      const task = await service.submitTask("autoforge", "shadow subtask test", {
        forceTier: "EXPRESS"
      });

      expect(task.state).toBe("awaiting_approval");

      const events = db.listEvents(task.id);
      const startedEvents = events.filter((e) => e.type === "subtask_started");
      const shadowEvents = events
        .filter((e) => e.type === "shadow_run_completed")
        .filter((e) => e.payload.agent_type === "coder");

      // At least one coder shadow run occurred (one per subtask that had a candidate)
      expect(shadowEvents.length).toBeGreaterThanOrEqual(1);

      // Each shadow event must carry subtask_id and iteration matching the subtask under which it ran
      for (const shadow of shadowEvents) {
        const matchingStarted = startedEvents.find(
          (s) => s.payload.subtaskId === shadow.payload.subtask_id
        );
        expect(matchingStarted).toBeDefined();
        expect(shadow.payload.subtask_id).toBe(matchingStarted!.payload.subtaskId);
        expect(shadow.payload.iteration).toBe(matchingStarted!.payload.iteration);
      }
    } finally {
      cleanup();
    }
  });
});
