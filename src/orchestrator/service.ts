import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AppEnv } from "../config/env";
import { assessComplexity, routeTier } from "../assessment/tier";
import { type AutoforgeMessage } from "../nats/messages";
import type { AgentExecutor } from "../executors/interface";
import type { DbClient } from "../db/client";
import type { NatsClient } from "../nats/client";
import type { PipelineTask, PlanSubtask, ReviewFinding, SubtaskReportStatus, TaskStage } from "../types/core";
import { assertTransition } from "./state-machine";
import { WorktreeManager } from "../git/worktrees";
import { SkillRegistry } from "../skills/registry";
import { createPullRequest, evaluatePrGate } from "../privileged/pr";
import { runAuthenticatedTests } from "../privileged/tests";

interface ServiceDeps {
  env: AppEnv;
  db: DbClient;
  executor: AgentExecutor;
  worktrees: WorktreeManager;
  nats?: NatsClient;
}

export class OrchestratorService {
  private readonly skills: SkillRegistry;

  constructor(private readonly deps: ServiceDeps) {
    this.skills = new SkillRegistry(resolve(process.cwd(), deps.env.SKILLS_DIR));
  }

  listTasks(): PipelineTask[] {
    return this.deps.db.listTasks();
  }

  getTask(taskId: string): PipelineTask | null {
    return this.deps.db.getTask(taskId);
  }

  async submitTask(projectId: string, description: string): Promise<PipelineTask> {
    const taskId = randomUUID();
    const now = new Date().toISOString();
    const assessment = assessComplexity(description);
    const tier = routeTier(assessment);
    const worktree = this.deps.worktrees.create(taskId);

    this.recordEvent({
      taskId,
      projectId,
      agent: "orchestrator",
      type: "created",
      status: "pending",
      payload: {
        description,
        state: "received",
        tier,
        assessment,
        planSubtasks: [],
        iteration: 0
      },
      budgetSeconds: 60
    });

    this.transition(taskId, projectId, "received", "assessing", { assessment, tier });
    this.transition(taskId, projectId, "assessing", "planning", {});

    const plannerResult = await this.deps.executor.execute({
      id: taskId,
      type: "planner",
      prompt: `Create implementation subtasks for: ${description}`,
      workingDirectory: worktree.path,
      budgetSeconds: this.budgetForTier(tier, "planner"),
      environment: {},
      skillFiles: this.skills.skillsForAgent("planner"),
      metadata: { description, tier }
    });

    const planSubtasks = parsePlanSubtasks(taskId, plannerResult.output);
    this.recordEvent({
      taskId,
      projectId,
      agent: "planner",
      type: "planned",
      status: "done",
      payload: {
        state: "executing",
        planSubtasks
      },
      budgetSeconds: this.budgetForTier(tier, "planner"),
      elapsedSeconds: plannerResult.metrics.elapsedSeconds
    });

    await this.executeAndReview(taskId, projectId, description, tier, planSubtasks, 0, worktree.path, worktree.branch);
    const task = this.deps.db.getTask(taskId);
    if (!task) {
      throw new Error("Task disappeared after orchestration.");
    }
    if (task.state === "awaiting_approval") {
      return task;
    }
    throw new Error(`Task ${taskId} did not reach approval state; current state: ${task.state}`);
  }

  async approveTask(taskId: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_approval") {
      throw new Error("Task is not awaiting approval.");
    }
    this.transition(taskId, task.projectId, "awaiting_approval", "documenting", {});
    this.transition(taskId, task.projectId, "documenting", "completed", {});
    return this.requireTask(taskId);
  }

  async rejectTask(taskId: string, reason: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_approval") {
      throw new Error("Task is not awaiting approval.");
    }

    const nextIteration = task.iteration + 1;
    this.transition(taskId, task.projectId, "awaiting_approval", "reworking", { iteration: nextIteration, reason });
    this.transition(taskId, task.projectId, "reworking", "executing", { iteration: nextIteration });
    this.transition(taskId, task.projectId, "executing", "reviewing", { iteration: nextIteration });
    this.transition(taskId, task.projectId, "reviewing", "pr_created", { iteration: nextIteration });
    this.transition(taskId, task.projectId, "pr_created", "awaiting_approval", { iteration: nextIteration });
    return this.requireTask(taskId);
  }

  async replayFromEvents(): Promise<void> {
    this.deps.db.rebuildProjectionsFromEvents();
  }

  private async executeAndReview(
    taskId: string,
    projectId: string,
    description: string,
    tier: PipelineTask["tier"],
    planSubtasks: PlanSubtask[],
    startingIteration: number,
    worktreePath: string,
    branch: string
  ): Promise<void> {
    let iteration = startingIteration;
    let unresolvedFindings: ReviewFinding[] = [];

    while (true) {
      const currentState = this.requireTask(taskId).state;
      if (currentState !== "executing") {
        this.transition(taskId, projectId, currentState, "executing", { iteration });
      }

      for (const subtask of planSubtasks) {
        const coderResult = await this.deps.executor.execute({
          id: subtask.id,
          type: "coder",
          prompt: buildCoderPrompt(description, subtask, iteration),
          workingDirectory: worktreePath,
          budgetSeconds: this.budgetForTier(tier, "coder"),
          environment: {},
          skillFiles: this.skills.skillsForAgent("coder"),
          metadata: { taskId, subtask, description }
        });

        if (!isSuccess(coderResult.status)) {
          this.transition(taskId, projectId, "executing", "failed", {
            reason: coderResult.blockReason ?? "coder failed",
            iteration
          });
          throw new Error(`Coder failed with status ${coderResult.status}`);
        }

        // Orchestrator commits agent output — agents never push directly.
        this.deps.worktrees.commit({ branch, path: worktreePath }, `autoforge: ${subtask.description}`);
      }

      this.transition(taskId, projectId, "executing", "reviewing", { iteration });

      const reviewResult = await this.deps.executor.execute({
        id: `${taskId}-review-${iteration}`,
        type: "reviewer",
        prompt: buildReviewerPrompt(description, planSubtasks),
        workingDirectory: worktreePath,
        budgetSeconds: this.budgetForTier(tier, "reviewer"),
        environment: {},
        skillFiles: this.skills.skillsForAgent("reviewer"),
        metadata: { taskId, iteration, description }
      });

      unresolvedFindings = parseFindings(taskId, reviewResult.output);
      for (const finding of unresolvedFindings) {
        this.recordEvent({
          taskId,
          projectId,
          agent: "reviewer",
          type: "review_finding",
          status: "done_with_concerns",
          payload: {
            finding
          },
          budgetSeconds: this.budgetForTier(tier, "reviewer")
        });
      }

      const mustRework = unresolvedFindings.some((finding) => finding.severity === "CRITICAL" || finding.severity === "MAJOR");
      if (!mustRework) {
        break;
      }

      iteration += 1;
      if (iteration > 3) {
        this.transition(taskId, projectId, "reviewing", "failed", {
          reason: "Exceeded rework iteration limit",
          iteration
        });
        throw new Error("Exceeded rework iteration limit");
      }

      this.transition(taskId, projectId, "reviewing", "reworking", { iteration });
      this.recordEvent({
        taskId,
        projectId,
        agent: "coder",
        type: "rework_done",
        status: "done",
        payload: {
          resolveAllFindings: true,
          iteration
        },
        budgetSeconds: this.budgetForTier(tier, "coder")
      });
    }

    const testResult = await runAuthenticatedTests(worktreePath, projectId);
    const reviewScore = unresolvedFindings.length === 0 ? 1 : 0.5;
    const gate = evaluatePrGate({
      passRate: testResult.passRate,
      reviewScore,
      thresholdScore: this.deps.env.REVIEW_SCORE_THRESHOLD,
      findings: unresolvedFindings
    });

    if (!gate.accepted) {
      this.transition(taskId, projectId, "reviewing", "failed", { reason: gate.reason, iteration });
      throw new Error(gate.reason ?? "PR gate rejected task");
    }

    const prUrl = await createPullRequest({
      title: `Autoforge task ${taskId}`,
      description,
      branch,
      findings: unresolvedFindings
    });

    this.transition(taskId, projectId, "reviewing", "pr_created", { prUrl, iteration });
    this.transition(taskId, projectId, "pr_created", "awaiting_approval", { prUrl, iteration });
  }

  private transition(
    taskId: string,
    projectId: string,
    from: TaskStage,
    to: TaskStage,
    payload: Record<string, unknown>
  ): void {
    assertTransition(from, to);
    this.recordEvent({
      taskId,
      projectId,
      agent: "orchestrator",
      type: `state.${to}`,
      status: to === "failed" ? "failed" : to === "completed" ? "done" : "in_progress",
      payload: {
        ...payload,
        state: to
      },
      budgetSeconds: 60
    });
  }

  private recordEvent(input: {
    taskId: string;
    projectId: string;
    agent: AutoforgeMessage["agent"];
    type: string;
    status: AutoforgeMessage["status"];
    payload: Record<string, unknown>;
    budgetSeconds: number;
    elapsedSeconds?: number;
    executorUsed?: string;
    resumable?: boolean;
  }): void {
    const message: AutoforgeMessage = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      timestamp: new Date().toISOString(),
      agent: input.agent,
      type: input.type,
      status: input.status,
      payload: input.payload,
      budgetSeconds: input.budgetSeconds,
      elapsedSeconds: input.elapsedSeconds
    };

    this.deps.db.transaction(() => {
      this.deps.db.appendEvent(message);
      this.deps.db.applyEvent(message);
    });

    // Publish to NATS JetStream asynchronously (fire-and-forget; SQLite is the source of truth).
    this.deps.nats?.publishTaskEvent(message).catch((err) => {
      console.warn(`[orchestrator] NATS publish failed for ${message.type}: ${err}`);
    });
  }

  private budgetForTier(tier: PipelineTask["tier"], step: "planner" | "coder" | "reviewer"): number {
    const budgets = {
      EXPRESS: { planner: 180, coder: 300, reviewer: 0 },
      STANDARD: { planner: 480, coder: 480, reviewer: 180 },
      THOROUGH: { planner: 900, coder: 720, reviewer: 480 }
    };
    return budgets[tier][step];
  }

  private requireTask(taskId: string): PipelineTask {
    const task = this.deps.db.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }
}

function buildCoderPrompt(description: string, subtask: PlanSubtask, iteration: number): string {
  const lines = [
    `## Feature\n${description}`,
    `## Subtask (${subtask.sequence})\n${subtask.description}`,
    `## Files in scope\n${subtask.filesInScope.join(", ")}`,
    `## Test criteria\n${subtask.testCriteria.map((c) => `- ${c}`).join("\n")}`
  ];
  if (iteration > 0) {
    lines.push(`## Note\nThis is rework iteration ${iteration}. Fix issues identified in the review, nothing else.`);
  }
  return lines.join("\n\n");
}

function buildReviewerPrompt(description: string, subtasks: PlanSubtask[]): string {
  const criteria = subtasks.flatMap((s) => s.testCriteria).map((c) => `- ${c}`).join("\n");
  return [
    `## Feature\n${description}`,
    `## Test criteria to verify\n${criteria}`,
    "## Instructions\nReview the code in this working directory. Conduct spec compliance review first, then code quality review. Output findings to .autoforge-status.json."
  ].join("\n\n");
}

function parsePlanSubtasks(taskId: string, output: unknown): PlanSubtask[] {
  if (
    output &&
    typeof output === "object" &&
    "subtasks" in output &&
    Array.isArray((output as { subtasks: unknown[] }).subtasks) &&
    (output as { subtasks: unknown[] }).subtasks.length > 0
  ) {
    const subtasks = (output as { subtasks: Array<Partial<PlanSubtask>> }).subtasks;
    return subtasks.map((subtask, index) => ({
      id: subtask.id ?? `${taskId}-subtask-${index + 1}`,
      sequence: subtask.sequence ?? index + 1,
      description: subtask.description ?? `Subtask ${index + 1}`,
      filesInScope: subtask.filesInScope ?? ["src/"],
      dependencies: subtask.dependencies ?? [],
      testCriteria: subtask.testCriteria ?? ["Tests pass."]
    }));
  }

  return [
    {
      id: `${taskId}-subtask-1`,
      sequence: 1,
      description: "Implement requested behavior with tests-first workflow.",
      filesInScope: ["src/"],
      dependencies: [],
      testCriteria: ["All tests pass."]
    }
  ];
}

function parseFindings(taskId: string, output: unknown): ReviewFinding[] {
  if (
    output &&
    typeof output === "object" &&
    "findings" in output &&
    Array.isArray((output as { findings: unknown[] }).findings)
  ) {
    return (output as { findings: Array<Partial<ReviewFinding>> }).findings.map((finding) => ({
      id: finding.id ?? randomUUID(),
      taskId,
      severity: finding.severity ?? "MINOR",
      category: finding.category ?? "general",
      description: finding.description ?? "unspecified finding",
      filePath: finding.filePath,
      resolved: finding.resolved ?? false,
      resolvedInIteration: finding.resolvedInIteration
    }));
  }
  return [];
}

function isSuccess(status: SubtaskReportStatus | "FAILED" | "TIMEOUT"): boolean {
  return status === "DONE" || status === "DONE_WITH_CONCERNS";
}
