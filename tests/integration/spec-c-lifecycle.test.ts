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
import { AutoTuner } from "../../src/orchestrator/auto-tuner";
import { PersonaRegistry } from "../../src/personas/registry";
import type { AgentResult, AgentTask } from "../../src/executors/interface";
import type { LifecycleHookPhase, LifecycleHooksResult } from "../../src/orchestrator/lifecycle-hooks";

type Handlers = Partial<Record<AgentTask["type"], (task: AgentTask) => AgentResult | Promise<AgentResult>>>;
type HookRunner = (input: { phase: LifecycleHookPhase; workingDirectory: string; timeoutSeconds: number }) => LifecycleHooksResult;

const skipAllHooks: HookRunner = ({ phase }) => ({ phase, runs: [], failedRun: null });

const REWARD_KEYS = [
  "r_correctness",
  "r_simplicity",
  "r_alignment",
  "r_fidelity",
  "r_efficiency"
] as const;

function createLifecycleService(input: {
  randomValues?: number[];
  handlers?: Handlers;
  prCreator?: (payload: { branch: string }) => Promise<string>;
  enableTestHooks?: boolean;
  /**
   * When omitted, lifecycle hooks are stubbed to a no-op so test fixtures
   * don't recursively run autoforge's own `bun run lint` / `bun run test`
   * inside their worktree. Set explicitly to `undefined` (or pass a custom
   * runner) when a test needs the real hook runner to fire.
   */
  lifecycleHookRunner?: HookRunner | null;
} = {}): { service: OrchestratorService; db: DbClient; cleanup: () => void } {
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "autoforge-spec-c-lifecycle-")));
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
    TEST_PASS_THRESHOLD: "1",
    AUTOFORGE_ENABLE_TEST_HOOKS: input.enableTestHooks ? "1" : "0"
  });
  let randomIndex = 0;
  const dispatcher = createDispatcher(db, {
    random: () => input.randomValues?.[randomIndex++] ?? 0
  });
  const worktrees = new WorktreeManager(join(baseDir, "worktrees"));
  const hookRunner: HookRunner | undefined = input.lifecycleHookRunner === null
    ? undefined // null = use real runner (production default)
    : (input.lifecycleHookRunner ?? skipAllHooks);
  const service = new OrchestratorService({
    env,
    db,
    executor: new MockExecutor(input.handlers ?? {}),
    worktrees,
    dispatcher,
    testRunner: async () => ({ passRate: 1, output: "mock test runner", verificationStatus: "passed", runner: "mock" }),
    prCreator: input.prCreator ?? (async (payload) =>
      `https://github.com/local/autoforge/pull/mock?branch=${encodeURIComponent(payload.branch)}`),
    lifecycleHookRunner: hookRunner
  });

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

function seedVariant(
  db: DbClient,
  input: {
    id: string;
    agentType: string;
    status: "baseline" | "active" | "candidate";
    share: number;
    experimentId?: string | null;
  }
): void {
  db.sqlite.query(`
    INSERT INTO skill_versions
      (id, skill_name, version, content, status, traffic_share, experiment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `persona:${input.agentType}`,
    input.id,
    `${input.agentType} ${input.id}`,
    input.status,
    input.share,
    input.experimentId ?? null
  );
}

function seedExperiment(db: DbClient, id: string, agentType = "coder"): void {
  db.sqlite.query(`
    INSERT INTO experiments (
      id, hypothesis, skill_modified, agent_affected, change_description,
      metric_name, metric_before, status
    )
    VALUES (?, 'candidate may improve quality', ?, ?, 'try candidate',
      'composite_reward', 0.5, 'proposed')
  `).run(id, `persona:${agentType}`, agentType);
}

function ensureBaseline(db: DbClient, agentType: string, share: number): string {
  const personas = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
  const baselineId = personas.snapshotId(agentType as Parameters<PersonaRegistry["snapshotId"]>[0]);
  personas.ensureDispatchBaseline(agentType as Parameters<PersonaRegistry["ensureDispatchBaseline"]>[0]);
  db.sqlite.query("UPDATE skill_versions SET traffic_share = ? WHERE id = ?").run(share, baselineId);
  return baselineId;
}

function rewardComponents(score: number): Record<string, number> {
  return Object.fromEntries(REWARD_KEYS.map((key) => [key, score]));
}

function seedStrongShadowPair(
  db: DbClient,
  input: { index: number; candidateId: string; baselineId: string; taskId?: string }
): void {
  db.appendEvent({
    id: `synthetic-shadow-${input.candidateId}-${input.index}`,
    taskId: input.taskId ?? `synthetic-shadow-task-${input.index}`,
    projectId: "autoforge",
    timestamp: new Date(2026, 3, 24, 12, input.index).toISOString(),
    agent: "orchestrator",
    type: "shadow_run_completed",
    status: "done",
    payload: {
      task_id: input.taskId ?? `synthetic-shadow-task-${input.index}`,
      agent_type: "coder",
      baseline_variant_id: input.baselineId,
      candidate_variant_id: input.candidateId,
      baseline_score_components: rewardComponents(0.5),
      baseline_composite: 0.5,
      candidate_score_components: rewardComponents(0.8),
      candidate_composite: 0.8,
      candidate_executor_used: "synthetic"
    },
    budgetSeconds: 0
  });
}

function variantState(db: DbClient, id: string): { status: string; traffic_share: number } {
  return db.sqlite
    .query("SELECT status, traffic_share FROM skill_versions WHERE id = ?")
    .get(id) as { status: string; traffic_share: number };
}

describe("Spec C lifecycle auto-tuner hook", () => {
  test("post_coder_pre_review hook failure pauses task in awaiting_intervention", async () => {
    const { service, db, cleanup } = createLifecycleService({
      randomValues: [0],
      enableTestHooks: true,
      // null = use the real lifecycle hook runner so the failing `lint`
      // script the coder writes actually fails the post_coder_pre_review hook.
      lifecycleHookRunner: null,
      handlers: {
        coder: async (agentTask) => {
          const pkg = JSON.parse(await agentTask.workspace.readFile("package.json")) as {
            scripts?: Record<string, string>;
          };
          pkg.scripts = {
            ...(pkg.scripts ?? {}),
            lint: "node -e \"process.stderr.write('hook-failed'); process.exit(1)\""
          };
          await agentTask.workspace.writeFile("package.json", JSON.stringify(pkg, null, 2));
          return {
            status: "DONE",
            artifacts: [],
            output: {},
            metrics: { elapsedSeconds: 0.1 }
          };
        }
      }
    });
    try {
      const task = await service.submitTask("autoforge", "trigger hook failure", {
        forceTier: "EXPRESS",
        reviewPlan: false
      });
      expect(task.state).toBe("awaiting_intervention");

      const events = db.listEvents(task.id);
      const hookFailure = events.find((event) => event.type === "lifecycle_hook_failed");
      expect(hookFailure).toBeDefined();
      expect(hookFailure?.payload.phase).toBe("post_coder_pre_review");
      expect(hookFailure?.payload.script).toBe("lint");
      expect(hookFailure?.payload.exit_code).toBe(1);
      expect(typeof hookFailure?.payload.log_path).toBe("string");

      const failureAnalysis = [...events].reverse().find((event) => event.type === "failure_analysis");
      expect(failureAnalysis).toBeDefined();
      expect(failureAnalysis?.payload.failure_category).toBe("lifecycle_hook_failed");
      expect(failureAnalysis?.payload.stage_failed).toBe("executing");
    } finally {
      cleanup();
    }
  });

  test("terminal completion evaluates shadow candidates and graduates a candidate with enough evidence", async () => {
    const { service, db, cleanup } = createLifecycleService({ randomValues: [0] });
    try {
      const experimentId = "exp-coder-candidate";
      seedExperiment(db, experimentId);
      const baselineId = ensureBaseline(db, "coder", 0.9);
      seedVariant(db, {
        id: "coder-candidate",
        agentType: "coder",
        status: "candidate",
        share: 0,
        experimentId
      });

      const task = await service.submitTask("autoforge", "frontend lifecycle candidate", { forceTier: "EXPRESS" });
      expect(task.state).toBe("awaiting_approval");
      for (let index = 0; index < 10; index += 1) {
        seedStrongShadowPair(db, { index, candidateId: "coder-candidate", baselineId, taskId: task.id });
      }

      const approved = await service.approveTask(task.id);

      expect(approved.state).toBe("completed");
      expect(variantState(db, "coder-candidate")).toEqual({ status: "active", traffic_share: 0.1 });
      const allocation = db.sqlite
        .query("SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE event_type = 'traffic_allocated' AND json_extract(payload, '$.reason') = 'auto_graduation'")
        .get() as { reason: string } | null;
      expect(allocation?.reason).toBe("auto_graduation");
    } finally {
      cleanup();
    }
  });

  test("auto-tuner failure is recorded and does not prevent task completion or cleanup", async () => {
    const original = AutoTuner.prototype.evaluateActiveVariant;
    AutoTuner.prototype.evaluateActiveVariant = () => {
      throw new Error("synthetic auto-tuner failure");
    };
    const { service, db, cleanup } = createLifecycleService({ randomValues: [0.96, 0] });
    try {
      ensureBaseline(db, "coder", 0.5);
      seedVariant(db, { id: "coder-active", agentType: "coder", status: "active", share: 0.8 });

      const task = await service.submitTask("autoforge", "frontend active lifecycle", { forceTier: "EXPRESS" });
      expect(task.state).toBe("awaiting_approval");

      const approved = await service.approveTask(task.id);

      expect(approved.state).toBe("completed");
      expect((service as unknown as { deps: { worktrees: WorktreeManager } }).deps.worktrees.findWorktreePath(task.id)).toBeNull();
      const failure = db.listEvents(task.id).find((event) => event.type === "auto_tuner_failed");
      expect(failure?.status).toBe("done_with_concerns");
      expect(failure?.payload.reason).toBe("synthetic auto-tuner failure");
    } finally {
      AutoTuner.prototype.evaluateActiveVariant = original;
      cleanup();
    }
  });

  test("non-terminal finalize path does not run auto-tuner before terminal rewards are ready", async () => {
    const original = AutoTuner.prototype.evaluateActiveVariant;
    AutoTuner.prototype.evaluateActiveVariant = () => {
      throw new Error("auto-tuner should wait for terminal state");
    };
    const { service, db, cleanup } = createLifecycleService({
      randomValues: [0.96, 0],
      prCreator: async () => {
        throw new Error("synthetic PR creation failure");
      }
    });
    try {
      ensureBaseline(db, "coder", 0.5);
      seedVariant(db, { id: "coder-active", agentType: "coder", status: "active", share: 0.8 });
      (service as unknown as { terminalTaskCount: number }).terminalTaskCount = 49;

      await expect(
        service.submitTask("autoforge", "frontend non-terminal crash", { forceTier: "EXPRESS" })
      ).rejects.toThrow("synthetic PR creation failure");
      await Bun.sleep(10);

      const task = db.listTasks().find((candidate) => candidate.description === "frontend non-terminal crash");
      // EXPRESS skips reviewer dispatch; PR creation fails while still executing.
      expect(task?.state).toBe("executing");
      expect((service as unknown as { deps: { worktrees: WorktreeManager } }).deps.worktrees.findWorktreePath(task!.id)).toBeNull();
      expect(db.listEvents(task!.id).some((event) => event.type === "auto_tuner_failed")).toBe(false);
      expect(db.sqlite.query("SELECT id FROM events WHERE event_type = 'diagnostic_run_completed'").all()).toHaveLength(0);
      const allocations = db.sqlite
        .query(`SELECT id FROM events
          WHERE event_type = 'traffic_allocated'
            AND json_extract(payload, '$.reason') IN ('auto_graduation', 'auto_promote', 'auto_demote', 'baseline_swap')`)
        .all() as Array<{ id: string }>;
      expect(allocations).toHaveLength(0);
    } finally {
      AutoTuner.prototype.evaluateActiveVariant = original;
      cleanup();
    }
  });

  test("meta task variant selections do not run auto-tuner evaluation", async () => {
    const { service, db, cleanup } = createLifecycleService({ randomValues: [0] });
    try {
      seedExperiment(db, "exp-meta-candidate", "meta");
      ensureBaseline(db, "meta", 0.9);
      seedVariant(db, {
        id: "meta-candidate",
        agentType: "meta",
        status: "candidate",
        share: 0,
        experimentId: "exp-meta-candidate"
      });

      const result = await service.submitMetaTask("autoforge", "improve meta persona");

      expect(result.status).toBe("DONE_WITH_CONCERNS");
      const failures = db.sqlite
        .query("SELECT id FROM events WHERE event_type = 'auto_tuner_failed'")
        .all() as Array<{ id: string }>;
      expect(failures).toHaveLength(0);
      expect(variantState(db, "meta-candidate")).toEqual({ status: "candidate", traffic_share: 0 });
    } finally {
      cleanup();
    }
  });
});
