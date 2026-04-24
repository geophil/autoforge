import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join as pathJoin } from "node:path";
import type { AppEnv } from "../config/env";
import { assessComplexity, routeTier } from "../assessment/tier";
import { type AutoforgeMessage } from "../nats/messages";
import type { AgentExecutor, ToolStats } from "../executors/interface";
import type { DbClient } from "../db/client";
import type { NatsClient } from "../nats/client";
import type { AgentType, PipelineTask, PlanSubtask, RejectionFeedback, ReviewFinding, SubtaskReportStatus, TaskStage, Tier } from "../types/core";
import { assertTransition } from "./state-machine";
import { computeDiffStats, computeIterationDiff } from "./diff-stats";
import { WorktreeManager } from "../git/worktrees";
import { SkillRegistry } from "../skills/registry";
import { PersonaRegistry } from "../personas/registry";
import { createPullRequest, evaluatePrGate, mergePullRequest, closePullRequest } from "../privileged/pr";
import { runAuthenticatedTests } from "../privileged/tests";
import type { ExecutorSet } from "../executors/factory";

interface ServiceDeps {
  env: AppEnv;
  db: DbClient;
  executor: AgentExecutor;
  executors?: ExecutorSet;
  worktrees: WorktreeManager;
  nats?: NatsClient;
  testRunner?: (workingDirectory: string, projectId: string) => Promise<{ passRate: number; output: string }>;
  prCreator?: (payload: import("../privileged/pr").PrPayload) => Promise<string>;
}

/**
 * Thrown internally when a pipeline stage fails in a way the operator
 * needs to see. The task has already been transitioned to
 * `awaiting_intervention` with a `failure_analysis` event recorded before
 * this is thrown. Callers catch it and return the paused task rather than
 * propagating as a 500 — the point is to pause, not to crash the server.
 */
export class StageFailedError extends Error {
  readonly taskId: string;
  readonly stage: TaskStage;
  constructor(taskId: string, stage: TaskStage, message: string) {
    super(message);
    this.name = "StageFailedError";
    this.taskId = taskId;
    this.stage = stage;
  }
}

export class OrchestratorService {
  private readonly skills: SkillRegistry;
  private readonly personas: PersonaRegistry;

  constructor(private readonly deps: ServiceDeps) {
    this.skills = new SkillRegistry(resolve(process.cwd(), deps.env.SKILLS_DIR), deps.db);
    this.personas = new PersonaRegistry(deps.db, resolve(process.cwd(), "src/personas"));
  }

  listTasks(opts?: { includeArchived?: boolean; onlyArchived?: boolean }): PipelineTask[] {
    return this.deps.db.listTasks(opts);
  }

  getTask(taskId: string): PipelineTask | null {
    return this.deps.db.getTask(taskId);
  }

  async archiveTask(taskId: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    const terminalStates: TaskStage[] = ["completed", "failed"];
    if (!terminalStates.includes(task.state)) {
      throw new Error(`Cannot archive task ${taskId}: must be in a terminal state (completed or failed), current state: '${task.state}'`);
    }
    this.captureTaskDiffStats(taskId);
    this.cleanupWorktree(taskId);
    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "task_archived",
      status: "done",
      payload: { taskId },
      budgetSeconds: 60
    });
    this.deps.db.archiveTask(taskId);
    return this.requireTask(taskId);
  }

  async unarchiveTask(taskId: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "task_unarchived",
      status: "done",
      payload: { taskId },
      budgetSeconds: 60
    });
    this.deps.db.unarchiveTask(taskId);
    return this.requireTask(taskId);
  }

  async deleteTaskPermanently(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (!task.archivedAt) {
      throw new Error(`Cannot delete task ${taskId}: task must be archived before permanent deletion`);
    }
    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "task_deleted",
      status: "done",
      payload: { taskId },
      budgetSeconds: 60
    });
    this.deps.db.deleteTaskPermanently(taskId);
  }

  async submitTask(
    projectId: string,
    description: string,
    opts: { reviewPlan?: boolean; forceTier?: Tier } = {}
  ): Promise<PipelineTask> {
    const taskId = randomUUID();
    const assessment = assessComplexity(description);
    const tier = opts.forceTier ?? routeTier(assessment);
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

    let planSubtasks: PlanSubtask[];
    try {
      planSubtasks = await this.runPlannerAttempt(
        taskId,
        projectId,
        description,
        tier,
        worktree.path,
        0,
        null
      );
    } catch (err) {
      // Planner failure has already been surfaced (failure_analysis event +
      // awaiting_intervention transition inside runPlannerAttempt). Return
      // the paused task so the caller can show the operator what happened.
      if (err instanceof StageFailedError) {
        return this.requireTask(taskId);
      }
      throw err;
    }

    if (this.pausePolicy(tier, opts.reviewPlan)) {
      this.transition(taskId, projectId, "planning", "awaiting_plan_approval", { planSubtasks });
      return this.requireTask(taskId);
    }

    this.transition(taskId, projectId, "planning", "executing", { planSubtasks });

    try {
      await this.executeAndReview(taskId, projectId, description, tier, planSubtasks, 0, worktree.path, worktree.branch);
    } catch (err) {
      if (err instanceof StageFailedError) {
        // Leave worktree intact so the operator can inspect or retry.
        return this.requireTask(taskId);
      }
      this.captureTaskDiffStats(taskId);
      this.cleanupWorktree(taskId);
      throw err;
    }
    const task = this.deps.db.getTask(taskId);
    if (!task) {
      throw new Error("Task disappeared after orchestration.");
    }
    if (task.state === "awaiting_approval" || task.state === "awaiting_intervention") {
      return task;
    }
    throw new Error(`Task ${taskId} did not reach approval state; current state: ${task.state}`);
  }

  private pausePolicy(tier: Tier, reviewPlanOverride?: boolean): boolean {
    if (reviewPlanOverride !== undefined) return reviewPlanOverride;
    return tier === "STANDARD" || tier === "THOROUGH";
  }

  private plannerModel(tier: Tier): string {
    if (tier === "EXPRESS") return this.deps.env.PLANNER_MODEL_EXPRESS;
    return this.deps.env.PLANNER_MODEL_COMPLEX;
  }

  private async runPlannerAttempt(
    taskId: string,
    projectId: string,
    description: string,
    tier: Tier,
    worktreePath: string,
    attempt: number,
    critique: string | null,
    priorPlan?: PlanSubtask[]
  ): Promise<PlanSubtask[]> {
    const plannerExecutor = this.routeExecutor(tier, "planner");
    const userPrompt = this.buildPlannerPrompt(description, tier, attempt, priorPlan, critique);
    const plannerPersonaId = this.personas.snapshotId("planner");
    const plannerSkillIds = this.skills.snapshotIds("planner");

    this.emitVariantSelected({
      taskId,
      projectId,
      agentType: "planner",
      selectedVariantId: plannerPersonaId,
      budgetSeconds: this.budgetForTier(tier, "planner")
    });

    const plannerResult = await plannerExecutor.execute({
      id: taskId,
      type: "planner",
      systemPrompt: this.personas.resolve("planner"),
      prompt: userPrompt,
      workingDirectory: worktreePath,
      budgetSeconds: this.budgetForTier(tier, "planner"),
      environment: this.agentEnvironment(),
      skillFiles: this.skills.skillsForAgent("planner"),
      metadata: { description, tier, attempt },
      model: this.plannerModel(tier)
    });

    // Persist transcript before we do anything else — even on failure we want
    // the full I/O (including the `error` turn captured by the SDK executor)
    // so the operator can see WHY planning failed.
    const transcript = plannerResult.transcript;
    const turnsJsonl = transcript
      ? transcript.turns.map((t) => JSON.stringify(t)).join("\n")
      : "";

    const transcriptId = this.deps.db.insertTranscript({
      taskId,
      stage: "planner",
      attempt,
      personaVersionId: plannerPersonaId,
      executorUsed: plannerExecutor.name,
      model: this.plannerModel(tier),
      systemPrompt: transcript?.systemPrompt ?? this.personas.resolve("planner"),
      userPrompt: transcript?.userPrompt ?? userPrompt,
      transcript: turnsJsonl,
      output: plannerResult.output ? JSON.stringify(plannerResult.output) : null,
      critique,
      tokenInput: plannerResult.metrics.tokenInput ?? null,
      tokenOutput: plannerResult.metrics.tokenOutput ?? null,
      elapsedSeconds: plannerResult.metrics.elapsedSeconds
    });

    // Surface executor failures instead of silently falling back. Previously
    // a FAILED/TIMEOUT planner result was parsed into the generic fallback
    // subtask and the pipeline marched on — hiding a real API error under a
    // downstream coder TIMEOUT 12 minutes later.
    if (plannerResult.status === "FAILED" || plannerResult.status === "TIMEOUT") {
      // Use live task state so the pause emits a valid transition whether
      // the caller is submitTask (planning), critiquePlan (replanning), or
      // retryFromIntervention (planning, but with attempt > 0).
      const currentTask = this.requireTask(taskId);
      const currentStage = currentTask.state;
      this.pauseForIntervention({
        taskId,
        projectId,
        fromStage: currentStage,
        failureCategory: plannerResult.status === "TIMEOUT" ? "planner_timeout" : "planner_failed",
        failureReason: plannerResult.blockReason ?? `planner returned ${plannerResult.status}`,
        forensics: {
          agent: "planner",
          executor_used: plannerExecutor.name,
          model: this.plannerModel(tier),
          persona_version_id: plannerPersonaId,
          skill_version_ids: plannerSkillIds,
          tool_stats: plannerResult.metrics.toolStats ?? null,
          planner_fallback: false,
          transcript_id: transcriptId,
          attempt,
          iteration: currentTask.iteration,
          budget_seconds: this.budgetForTier(tier, "planner"),
          elapsed_seconds: plannerResult.metrics.elapsedSeconds,
          token_input: plannerResult.metrics.tokenInput ?? 0,
          token_output: plannerResult.metrics.tokenOutput ?? 0
        }
      });
    }

    const planSubtasks = parsePlanSubtasks(taskId, plannerResult.output, worktreePath);
    const plannerFallback =
      planSubtasks.length === 1 &&
      planSubtasks[0].description === "Implement requested behavior with tests-first workflow.";

    this.recordEvent({
      taskId,
      projectId,
      agent: "planner",
      type: "planned",
      status: plannerFallback ? "done_with_concerns" : "done",
      payload: {
        planSubtasks,
        planner_fallback: plannerFallback,
        attempt,
        transcript_id: transcriptId
      },
      budgetSeconds: this.budgetForTier(tier, "planner"),
      elapsedSeconds: plannerResult.metrics.elapsedSeconds,
      tokenUsage: plannerResult.metrics.tokenInput !== undefined ? {
        input: plannerResult.metrics.tokenInput,
        output: plannerResult.metrics.tokenOutput ?? 0,
        estimatedCost: plannerResult.metrics.estimatedCost
      } : undefined,
      executorUsed: plannerExecutor.name,
      personaVersionId: plannerPersonaId,
      skillVersionIds: plannerSkillIds
    });

    return planSubtasks;
  }

  private buildPlannerPrompt(
    description: string,
    tier: Tier,
    attempt: number,
    priorPlan: PlanSubtask[] | undefined,
    critique: string | null
  ): string {
    const assessment = assessComplexity(description);
    const base = `## Task\n${description}\n\n## Complexity signals\nTier: ${tier} | Scope: ${assessment.scope} | Risk: ${assessment.risk} | Coupling: ${assessment.coupling}`;
    if (attempt === 0 || !priorPlan || !critique) return base;

    return [
      base,
      `## Prior plan (attempt ${attempt - 1})`,
      JSON.stringify(priorPlan, null, 2),
      `## Human feedback on prior plan`,
      critique,
      `## Instructions`,
      "Revise the plan to address the feedback. Prefer minimal changes — keep subtasks that were not critiqued, unless the feedback implies they should change."
    ].join("\n\n");
  }

  async approvePlan(taskId: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_plan_approval") {
      throw new Error(`Cannot approve plan: task is in state '${task.state}'`);
    }

    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "plan_approved",
      status: "done",
      payload: { state: "executing" },
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, "awaiting_plan_approval", "executing", {});

    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (!worktreePath) throw new Error(`Worktree missing for task ${taskId}`);
    const branch = `autoforge/${taskId}`;

    try {
      await this.executeAndReview(
        taskId, task.projectId, task.description, task.tier,
        task.planSubtasks, 0, worktreePath, branch
      );
    } catch (err) {
      if (err instanceof StageFailedError) {
        return this.requireTask(taskId);
      }
      this.captureTaskDiffStats(taskId);
      this.cleanupWorktree(taskId);
      throw err;
    }

    return this.requireTask(taskId);
  }

  async critiquePlan(taskId: string, critique: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_plan_approval") {
      throw new Error(`Cannot critique plan: task is in state '${task.state}'`);
    }

    const transcripts = this.deps.db.listTranscriptsByTask(taskId);
    const lastAttempt = transcripts.length === 0 ? 0 : Math.max(...transcripts.map((t) => t.attempt));
    if (lastAttempt >= this.deps.env.PLANNER_MAX_ITERATIONS) {
      throw new Error(`Re-plan iteration limit (${this.deps.env.PLANNER_MAX_ITERATIONS}) reached for task ${taskId}`);
    }

    const nextAttempt = lastAttempt + 1;
    const priorPlan = task.planSubtasks;

    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "plan_critiqued",
      status: "in_progress",
      payload: {
        critique_text: critique,
        critiqued_attempt: lastAttempt,
        next_attempt: nextAttempt
      },
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, "awaiting_plan_approval", "replanning", {});

    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (!worktreePath) {
      this.transition(taskId, task.projectId, "replanning", "failed", { reason: "worktree missing" });
      throw new Error(`Worktree missing for task ${taskId}`);
    }

    let newPlan: PlanSubtask[];
    try {
      newPlan = await this.runPlannerAttempt(
        taskId, task.projectId, task.description, task.tier,
        worktreePath, nextAttempt, critique, priorPlan
      );
    } catch (err) {
      if (err instanceof StageFailedError) {
        // runPlannerAttempt already paused the task in awaiting_intervention
        // with full forensics. Return the paused task so the API surfaces it.
        return this.requireTask(taskId);
      }
      this.transition(taskId, task.projectId, "replanning", "failed", {
        reason: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }

    this.transition(taskId, task.projectId, "replanning", "awaiting_plan_approval", { planSubtasks: newPlan });
    return this.requireTask(taskId);
  }

  async approveTask(taskId: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_approval") {
      throw new Error("Task is not awaiting approval.");
    }
    this.transition(taskId, task.projectId, "awaiting_approval", "documenting", {});

    // Run doc agent in the task's worktree (if it still exists).
    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (worktreePath) {
      const docPersonaId = this.personas.snapshotId("doc");
      const docSkillIds = this.skills.snapshotIds("doc");

      const docExecutor = this.routeExecutor(task.tier, "doc");
      this.emitVariantSelected({
        taskId,
        projectId: task.projectId,
        agentType: "doc",
        selectedVariantId: docPersonaId,
        budgetSeconds: this.budgetForTier(task.tier, "doc")
      });
      const docResult = await docExecutor.execute({
        id: `${taskId}-doc`,
        type: "doc",
        systemPrompt: this.personas.resolve("doc"),
        prompt: buildDocPrompt(task.description, task.planSubtasks),
        workingDirectory: worktreePath,
        budgetSeconds: this.budgetForTier(task.tier, "doc"),
        environment: this.agentEnvironment(),
        skillFiles: this.skills.skillsForAgent("doc"),
        metadata: { taskId, description: task.description }
      });

      this.recordEvent({
        taskId,
        projectId: task.projectId,
        agent: "doc",
        type: "doc_done",
        status: docResult.status === "DONE" ? "done" : "done_with_concerns",
        payload: { artifacts: docResult.artifacts },
        budgetSeconds: this.budgetForTier(task.tier, "doc"),
        elapsedSeconds: docResult.metrics.elapsedSeconds,
        tokenUsage: docResult.metrics.tokenInput !== undefined ? {
          input: docResult.metrics.tokenInput,
          output: docResult.metrics.tokenOutput ?? 0,
          estimatedCost: docResult.metrics.estimatedCost
        } : undefined,
        executorUsed: docExecutor.name,
        personaVersionId: docPersonaId,
        skillVersionIds: docSkillIds
      });

      const worktreeBranch = `autoforge/${taskId}`;
      this.deps.worktrees.commit({ branch: worktreeBranch, path: worktreePath }, "autoforge: documentation");
    }

    // Merge the PR now that the task is approved.
    if (task.prUrl) {
      await mergePullRequest(task.prUrl);
    }

    this.transition(taskId, task.projectId, "documenting", "completed", {});
    this.captureTaskDiffStats(taskId);
    this.cleanupWorktree(taskId);
    return this.requireTask(taskId);
  }

  async rejectTask(taskId: string, feedback: RejectionFeedback): Promise<PipelineTask> {
    const oldTask = this.requireTask(taskId);
    if (oldTask.state !== "awaiting_approval") {
      throw new Error("Task is not awaiting approval.");
    }

    // Close the existing PR — best-effort so a GitHub outage doesn't block.
    if (oldTask.prUrl) {
      await closePullRequest(oldTask.prUrl).catch((err) => {
        console.warn(`[orchestrator] Failed to close PR ${oldTask.prUrl}: ${err}`);
      });
    }

    // Record structured rejection feedback in the event log for meta-loop analytics.
    this.recordEvent({
      taskId,
      projectId: oldTask.projectId,
      agent: "orchestrator",
      type: "failure_analysis",
      status: "failed",
      payload: this.failureAnalysisPayload({
        stage_failed: "awaiting_approval",
        failure_reason: `Rejected by reviewer: ${feedback.reason}`,
        failure_category: "rejected",
        rejection_categories: feedback.categories ?? [],
        rejection_guidance: feedback.guidance ?? null,
        planner_fallback: oldTask.planSubtasks.length === 1 &&
          oldTask.planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
        iteration: oldTask.iteration
      }, taskId),
      budgetSeconds: 60
    });
    this.transition(taskId, oldTask.projectId, "awaiting_approval", "failed", {
      reason: `rejected: ${feedback.reason}`,
      iteration: oldTask.iteration
    });
    this.captureTaskDiffStats(taskId);
    this.cleanupWorktree(taskId);

    // Spawn a fresh task from current HEAD with the operator's feedback
    // appended to the description so the new planner sees it.
    const newDescription = buildRestartDescription(oldTask.description, feedback, taskId);
    // Restart tasks already carry human feedback in the description, so skip
    // the plan-review pause — the operator has effectively pre-approved the
    // direction via their rejection guidance.
    const newTask = await this.submitTask(oldTask.projectId, newDescription, { reviewPlan: false });

    // Record lineage so analytics (and the meta agent) can join old -> new.
    this.recordEvent({
      taskId,
      projectId: oldTask.projectId,
      agent: "orchestrator",
      type: "restart_spawned",
      status: "done",
      payload: {
        restart_child_task_id: newTask.id,
        rejection_categories: feedback.categories ?? []
      },
      budgetSeconds: 60
    });

    return newTask;
  }

  async replayFromEvents(): Promise<void> {
    this.deps.db.rebuildProjectionsFromEvents();
  }

  /**
   * Cancel any non-terminal task, emit a failure_analysis event, and clean up.
   */
  async cancelTask(taskId: string, reason = "Cancelled by operator."): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    const terminalStates: TaskStage[] = ["completed", "failed"];
    if (terminalStates.includes(task.state)) {
      throw new Error(`Task ${taskId} is already in terminal state: ${task.state}`);
    }

    if (task.prUrl) {
      await closePullRequest(task.prUrl).catch(() => { /* best-effort */ });
    }

    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "failure_analysis",
      status: "failed",
      payload: this.failureAnalysisPayload({
        stage_failed: task.state,
        failure_reason: reason,
        failure_category: "cancelled",
        planner_fallback: task.planSubtasks.length === 1 &&
          task.planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
        budget_seconds: this.budgetForTier(task.tier, "coder"),
        iteration: task.iteration
      }, taskId),
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, task.state, "failed", { reason: `cancelled: ${reason}`, iteration: task.iteration });
    this.captureTaskDiffStats(taskId);
    this.cleanupWorktree(taskId);
    return this.requireTask(taskId);
  }

  /**
   * Retry a paused task from a prior stage. Only valid when the task is
   * currently in `awaiting_intervention`. Without `fromStage`, retries the
   * stage that failed. With `fromStage`, restarts from an earlier stage (e.g.
   * re-run the planner after a coder failure).
   *
   * Supported re-entry points:
   *   - "planning"  -> re-run planner (fresh attempt)
   *   - "executing" -> re-run coder with current plan
   */
  async retryFromIntervention(
    taskId: string,
    opts: { fromStage?: "planning" | "executing" } = {}
  ): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_intervention") {
      throw new Error(`Cannot retry: task is in state '${task.state}', expected 'awaiting_intervention'`);
    }

    const events = this.deps.db.listEvents(taskId);
    const lastFailure = [...events].reverse().find((e) => e.type === "failure_analysis");
    const failedStage = (lastFailure?.payload.stage_failed as TaskStage | undefined) ?? "planning";
    // `replanning` folds into `planning` for retry purposes — we re-run the
    // planner from scratch rather than trying to resume a partial revision.
    const targetStage = opts.fromStage ?? (failedStage === "replanning" ? "planning" : failedStage);

    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "retry_requested",
      status: "in_progress",
      payload: {
        from_stage: targetStage,
        previously_failed_stage: failedStage,
        iteration: task.iteration
      },
      budgetSeconds: 60
    });

    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (!worktreePath) {
      throw new Error(`Worktree missing for task ${taskId}; cannot retry`);
    }
    const branch = `autoforge/${taskId}`;

    if (targetStage === "planning") {
      this.transition(taskId, task.projectId, "awaiting_intervention", "planning", { retry: true });
      // Use the next attempt number so the failed transcript is preserved
      // for forensics and we don't collide with the UNIQUE(task_id, stage,
      // attempt) constraint.
      const existingTranscripts = this.deps.db.listTranscriptsByTask(taskId);
      const nextAttempt = existingTranscripts.filter((t) => t.stage === "planner").length;
      try {
        const planSubtasks = await this.runPlannerAttempt(
          taskId, task.projectId, task.description, task.tier,
          worktreePath, nextAttempt, null
        );
        // Same pause policy as submitTask so the operator reviews the new plan.
        if (this.pausePolicy(task.tier, undefined)) {
          this.transition(taskId, task.projectId, "planning", "awaiting_plan_approval", { planSubtasks });
          return this.requireTask(taskId);
        }
        this.transition(taskId, task.projectId, "planning", "executing", { planSubtasks });
        await this.executeAndReview(
          taskId, task.projectId, task.description, task.tier,
          planSubtasks, 0, worktreePath, branch
        );
      } catch (err) {
        if (err instanceof StageFailedError) {
          return this.requireTask(taskId);
        }
        throw err;
      }
      return this.requireTask(taskId);
    }

    if (targetStage === "executing") {
      this.transition(taskId, task.projectId, "awaiting_intervention", "executing", { retry: true });
      try {
        await this.executeAndReview(
          taskId, task.projectId, task.description, task.tier,
          task.planSubtasks, task.iteration, worktreePath, branch
        );
      } catch (err) {
        if (err instanceof StageFailedError) {
          return this.requireTask(taskId);
        }
        throw err;
      }
      return this.requireTask(taskId);
    }

    throw new Error(`Retry from stage '${targetStage}' is not supported. Supported: 'planning', 'executing'.`);
  }

  /**
   * On startup, find tasks stuck in non-terminal states beyond their staleness
   * threshold and auto-fail them with a failure_analysis event.
   */
  sweepStaleTasks(): void {
    const nonTerminalStates = [
      "received", "assessing", "planning", "replanning",
      "executing", "reviewing", "reworking", "pr_created", "documenting"
      // 'awaiting_plan_approval', 'awaiting_approval', and 'awaiting_intervention'
      // are intentionally excluded — all three are human gates with no in-flight
      // work and no staleness deadline.
    ];
    const thresholdsByTier: Record<string, number> = {
      EXPRESS: 20 * 60 * 1000,
      STANDARD: 40 * 60 * 1000,
      THOROUGH: 60 * 60 * 1000
    };

    const tasks = this.deps.db.listTasks().filter((t) => nonTerminalStates.includes(t.state));
    const now = Date.now();

    for (const task of tasks) {
      const threshold = thresholdsByTier[task.tier] ?? 40 * 60 * 1000;
      const updatedAt = new Date(task.updatedAt).getTime();
      if (now - updatedAt > threshold) {
        console.warn(`[sweeper] Task ${task.id} stuck in '${task.state}' for >${Math.round((now - updatedAt) / 60000)}min — marking as failed`);

        this.recordEvent({
          taskId: task.id,
          projectId: task.projectId,
          agent: "orchestrator",
          type: "failure_analysis",
          status: "failed",
          payload: this.failureAnalysisPayload({
            stage_failed: task.state,
            failure_reason: `Task stuck in '${task.state}' for more than ${Math.round((now - updatedAt) / 60000)} minutes`,
            failure_category: "stalled",
            planner_fallback: task.planSubtasks.length === 1 &&
              task.planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
            budget_seconds: this.budgetForTier(task.tier, "coder"),
            elapsed_ms: now - updatedAt,
            iteration: task.iteration
          }, task.id),
          budgetSeconds: 60
        });

        // Force through valid state transitions to reach failed.
        try {
          this.transition(task.id, task.projectId, task.state, "failed", {
            reason: `stalled: task stuck in '${task.state}' beyond staleness threshold`,
            iteration: task.iteration
          });
        } catch {
          // State machine may reject some transitions — update projection directly.
          this.deps.db.sqlite.query(
            "UPDATE tasks SET state = 'failed', updated_at = ? WHERE id = ?"
          ).run(new Date().toISOString(), task.id);
        }

        this.captureTaskDiffStats(task.id);
        this.cleanupWorktree(task.id);
      }
    }
  }

  /**
   * Run a meta agent session to analyze performance and propose an improvement
   * to a persona or skill. Returns an experiment id that can be used to track
   * and conclude the experiment after observing canary task outcomes.
   */
  async submitMetaTask(projectId: string, focus?: string): Promise<{ experimentId: string | null; status: string }> {
    const metaTaskId = randomUUID();
    const worktree = this.deps.worktrees.create(metaTaskId);
    const dbPath = this.deps.env.DATABASE_PATH;

    const focusHint = focus ? `\n\nFocus on improving: ${focus}` : "";
    const prompt = [
      `## Meta Task`,
      `Analyze agent performance and propose one targeted improvement to a persona or skill.`,
      `Database path: ${dbPath}`,
      `Working directory: ${worktree.path}${focusHint}`,
      `\nQuery agent_performance and experiments tables to identify the weakest asset and what has already been tried.`,
      `Propose a single targeted change. Write the proposed content to a file and report via .autoforge-status.json.`
    ].join("\n");

    this.recordEvent({
      taskId: metaTaskId,
      projectId,
      agent: "meta",
      type: "meta_started",
      status: "in_progress",
      payload: { focus: focus ?? "auto", dbPath },
      budgetSeconds: 600
    });

    const metaPersonaId = this.personas.snapshotId("meta");
    const metaSkillIds = this.skills.snapshotIds("meta");
    const metaExecutor = this.routeExecutor("STANDARD", "meta");

    this.emitVariantSelected({
      taskId: metaTaskId,
      projectId,
      agentType: "meta",
      selectedVariantId: metaPersonaId,
      budgetSeconds: 600
    });

    const metaResult = await metaExecutor.execute({
      id: metaTaskId,
      type: "meta",
      systemPrompt: this.personas.resolve("meta"),
      prompt,
      workingDirectory: worktree.path,
      budgetSeconds: 600,
      environment: {},
      skillFiles: this.skills.skillsForAgent("meta"),
      metadata: { projectId, focus }
    });

    this.recordEvent({
      taskId: metaTaskId,
      projectId,
      agent: "meta",
      type: "meta_done",
      status: metaResult.status === "DONE" ? "done" : "done_with_concerns",
      payload: { artifacts: metaResult.artifacts, concerns: metaResult.concerns },
      budgetSeconds: 600,
      elapsedSeconds: metaResult.metrics.elapsedSeconds,
      tokenUsage: metaResult.metrics.tokenInput !== undefined ? {
        input: metaResult.metrics.tokenInput,
        output: metaResult.metrics.tokenOutput ?? 0,
        estimatedCost: metaResult.metrics.estimatedCost
      } : undefined,
      executorUsed: metaExecutor.name,
      personaVersionId: metaPersonaId,
      skillVersionIds: metaSkillIds
    });

    if (!isSuccess(metaResult.status)) {
      this.captureTaskDiffStats(metaTaskId);
      this.cleanupWorktree(metaTaskId);
      return { experimentId: null, status: metaResult.status };
    }

    // Read the meta output — expects a "meta" key in the status file output.
    const metaOutput = metaResult.output as Record<string, unknown> | undefined;
    const metaMeta = metaOutput?.meta as Record<string, unknown> | undefined;

    if (!metaMeta?.target_asset || !metaMeta?.hypothesis) {
      this.captureTaskDiffStats(metaTaskId);
      this.cleanupWorktree(metaTaskId);
      return { experimentId: null, status: "DONE_WITH_CONCERNS" };
    }

    const targetAsset = String(metaMeta.target_asset);
    const hypothesis = String(metaMeta.hypothesis);
    const metricName = String(metaMeta.metric_name ?? "first_pass_rate");
    const metricBefore = Number(metaMeta.metric_before ?? 0);
    const changeDescription = String(metaMeta.hypothesis);
    const agentAffected = targetAsset.replace(/^(persona|skill):/, "");
    const proposedFile = String(metaMeta.proposed_content_file ?? "");

    // Read the proposed content from the working directory.
    let proposedContent = "";
    if (proposedFile) {
      const proposedPath = pathJoin(worktree.path, proposedFile);
      if (existsSync(proposedPath)) {
        proposedContent = readFileSync(proposedPath, "utf8").trim();
      }
    }

    if (!proposedContent) {
      this.captureTaskDiffStats(metaTaskId);
      this.cleanupWorktree(metaTaskId);
      return { experimentId: null, status: "DONE_WITH_CONCERNS" };
    }

    // Create experiment and activate the proposed version.
    const experimentId = this.deps.db.createExperiment({
      hypothesis,
      skillModified: targetAsset,
      agentAffected,
      changeDescription,
      metricName,
      metricBefore
    });

    this.deps.db.activateProposedVersion(experimentId, targetAsset, proposedContent);

    this.recordEvent({
      taskId: metaTaskId,
      projectId,
      agent: "meta",
      type: "experiment_activated",
      status: "done",
      payload: { experimentId, targetAsset, hypothesis, metricName, metricBefore },
      budgetSeconds: 60
    });

    this.captureTaskDiffStats(metaTaskId);
    this.cleanupWorktree(metaTaskId);
    return { experimentId, status: "DONE" };
  }

  /**
   * Conclude an active experiment by comparing metric_after against metric_before.
   * Pass keep=true to retain the new version, false to revert.
   */
  async concludeExperiment(experimentId: string, metricAfter: number, keep: boolean): Promise<void> {
    this.deps.db.concludeExperiment(experimentId, metricAfter, keep);
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
    let lastReviewerFailureForensics: {
      executor_used: string | null;
      persona_version_id: string | null;
      skill_version_ids: string[];
      tool_stats: ToolStats | null;
    } | null = null;

    while (true) {
      const currentState = this.requireTask(taskId).state;
      if (currentState !== "executing") {
        this.transition(taskId, projectId, currentState, "executing", { iteration });
      }

      this.captureIterationDiff(taskId, worktreePath, iteration);

      for (const subtask of planSubtasks) {
        const subtaskAgentType = subtask.agentType ?? "coder";
        const subtaskPersonaId = this.personas.snapshotId(subtaskAgentType);
        const subtaskSkillIds = this.skills.snapshotIds(subtaskAgentType);
        const coderExecutor = this.routeExecutor(tier, subtaskAgentType);

        this.emitVariantSelected({
          taskId,
          projectId,
          agentType: subtaskAgentType,
          selectedVariantId: subtaskPersonaId,
          budgetSeconds: this.budgetForTier(tier, "coder")
        });

        const coderResult = await coderExecutor.execute({
          id: subtask.id,
          type: subtaskAgentType,
          systemPrompt: this.personas.resolve(subtaskAgentType),
          prompt: buildCoderPrompt(description, subtask, iteration),
          workingDirectory: worktreePath,
          budgetSeconds: this.budgetForTier(tier, "coder"),
          environment: this.agentEnvironment(),
          skillFiles: this.skills.skillsForAgent(subtaskAgentType),
          metadata: { taskId, subtask, description }
        });

        if (!isSuccess(coderResult.status)) {
          const failureCategory = coderResult.status === "TIMEOUT" ? "executor_timeout" : "coder_failed";
          this.pauseForIntervention({
            taskId,
            projectId,
            fromStage: "executing",
            failureCategory,
            failureReason: coderResult.blockReason ?? `coder returned ${coderResult.status}`,
            forensics: {
              agent: subtaskAgentType,
              subtask_id: subtask.id,
              subtask_description: subtask.description,
              executor_used: coderExecutor.name,
              persona_version_id: subtaskPersonaId,
              skill_version_ids: subtaskSkillIds,
              tool_stats: coderResult.metrics.toolStats ?? null,
              planner_fallback: planSubtasks.length === 1 &&
                planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
              budget_seconds: this.budgetForTier(tier, "coder"),
              elapsed_seconds: coderResult.metrics.elapsedSeconds,
              token_input: coderResult.metrics.tokenInput ?? 0,
              token_output: coderResult.metrics.tokenOutput ?? 0,
              status: coderResult.status,
              iteration
            }
          });
        }

        this.recordEvent({
          taskId,
          projectId,
          agent: subtaskAgentType,
          type: "subtask_done",
          status: coderResult.status === "DONE" ? "done" : "done_with_concerns",
          payload: { subtaskId: subtask.id, artifacts: coderResult.artifacts, concerns: coderResult.concerns },
          budgetSeconds: this.budgetForTier(tier, "coder"),
          elapsedSeconds: coderResult.metrics.elapsedSeconds,
          tokenUsage: coderResult.metrics.tokenInput !== undefined ? {
            input: coderResult.metrics.tokenInput,
            output: coderResult.metrics.tokenOutput ?? 0,
            estimatedCost: coderResult.metrics.estimatedCost
          } : undefined,
          executorUsed: coderExecutor.name,
          personaVersionId: subtaskPersonaId,
          skillVersionIds: subtaskSkillIds
        });

        // Orchestrator commits agent output — agents never push directly.
        this.deps.worktrees.commit({ branch, path: worktreePath }, `autoforge: ${subtask.description}`);
      }

      this.transition(taskId, projectId, "executing", "reviewing", { iteration });

      // EXPRESS tier skips the reviewer — faster turnaround, lower risk tolerance.
      if (tier === "EXPRESS") {
        break;
      }

      const reviewerPersonaId = this.personas.snapshotId("reviewer");
      const reviewerSkillIds = this.skills.snapshotIds("reviewer");
      const reviewerExecutor = this.routeExecutor(tier, "reviewer");

      this.emitVariantSelected({
        taskId,
        projectId,
        agentType: "reviewer",
        selectedVariantId: reviewerPersonaId,
        budgetSeconds: this.budgetForTier(tier, "reviewer")
      });

      const reviewResult = await reviewerExecutor.execute({
        id: `${taskId}-review-${iteration}`,
        type: "reviewer",
        systemPrompt: this.personas.resolve("reviewer"),
        prompt: buildReviewerPrompt(description, planSubtasks),
        workingDirectory: worktreePath,
        budgetSeconds: this.budgetForTier(tier, "reviewer"),
        environment: this.agentEnvironment(),
        skillFiles: this.skills.skillsForAgent("reviewer"),
        metadata: { taskId, iteration, description }
      });

      const reviewerFailureForensics = {
        executor_used: reviewerExecutor.name,
        persona_version_id: reviewerPersonaId,
        skill_version_ids: reviewerSkillIds,
        tool_stats: reviewResult.metrics.toolStats ?? null
      };
      lastReviewerFailureForensics = reviewerFailureForensics;

      if (!isSuccess(reviewResult.status)) {
        const failureCategory = reviewResult.status === "TIMEOUT" ? "executor_timeout" : "reviewer_failed";
        this.pauseForIntervention({
          taskId,
          projectId,
          fromStage: "reviewing",
          failureCategory,
          failureReason: reviewResult.blockReason ?? `reviewer returned ${reviewResult.status}`,
          forensics: {
            agent: "reviewer",
            ...reviewerFailureForensics,
            planner_fallback: planSubtasks.length === 1 &&
              planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
            budget_seconds: this.budgetForTier(tier, "reviewer"),
            elapsed_seconds: reviewResult.metrics.elapsedSeconds,
            token_input: reviewResult.metrics.tokenInput ?? 0,
            token_output: reviewResult.metrics.tokenOutput ?? 0,
            status: reviewResult.status,
            iteration
          }
        });
      }

      unresolvedFindings = parseFindings(taskId, reviewResult.output);

      this.recordEvent({
        taskId,
        projectId,
        agent: "reviewer",
        type: "review_done",
        status: unresolvedFindings.length === 0 ? "done" : "done_with_concerns",
        payload: { findingCount: unresolvedFindings.length, iteration },
        budgetSeconds: this.budgetForTier(tier, "reviewer"),
        elapsedSeconds: reviewResult.metrics.elapsedSeconds,
        tokenUsage: reviewResult.metrics.tokenInput !== undefined ? {
          input: reviewResult.metrics.tokenInput,
          output: reviewResult.metrics.tokenOutput ?? 0,
          estimatedCost: reviewResult.metrics.estimatedCost
        } : undefined,
        executorUsed: reviewerExecutor.name,
        personaVersionId: reviewerPersonaId,
        skillVersionIds: reviewerSkillIds
      });

      for (const finding of unresolvedFindings) {
        this.recordEvent({
          taskId,
          projectId,
          agent: "reviewer",
          type: "review_finding",
          status: "done_with_concerns",
          payload: { finding },
          budgetSeconds: this.budgetForTier(tier, "reviewer")
        });
      }

      const mustRework = unresolvedFindings.some((finding) => finding.severity === "CRITICAL" || finding.severity === "MAJOR");
      if (!mustRework) {
        break;
      }

      iteration += 1;
      if (iteration > 3) {
        this.pauseForIntervention({
          taskId,
          projectId,
          fromStage: "reviewing",
          failureCategory: "rework_limit",
          failureReason: "Exceeded rework iteration limit (3 rounds of CRITICAL/MAJOR findings)",
          forensics: {
            executor_used: reviewerExecutor.name,
            persona_version_id: reviewerPersonaId,
            skill_version_ids: reviewerSkillIds,
            tool_stats: reviewResult.metrics.toolStats ?? null,
            planner_fallback: planSubtasks.length === 1 &&
              planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
            budget_seconds: this.budgetForTier(tier, "coder"),
            unresolved_findings: unresolvedFindings.length,
            iteration
          }
        });
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

    const runTests = this.deps.testRunner ?? runAuthenticatedTests;
    const testResult = await runTests(worktreePath, projectId);

    this.recordEvent({
      taskId,
      projectId,
      agent: "orchestrator",
      type: "test_results",
      status: testResult.passRate >= 1 ? "done" : "done_with_concerns",
      payload: { passRate: testResult.passRate, output: testResult.output.slice(0, 2000) },
      budgetSeconds: 60
    });

    const reviewScore = unresolvedFindings.length === 0 ? 1 : 0.5;
    const gate = evaluatePrGate({
      passRate: testResult.passRate,
      reviewScore,
      thresholdScore: this.deps.env.REVIEW_SCORE_THRESHOLD,
      findings: unresolvedFindings
    });

    if (!gate.accepted) {
      this.pauseForIntervention({
        taskId,
        projectId,
        fromStage: "reviewing",
        failureCategory: "pr_gate",
        failureReason: gate.reason ?? "PR gate rejected task",
        forensics: {
          ...(lastReviewerFailureForensics ?? {}),
          test_pass_rate: testResult.passRate,
          review_score: reviewScore,
          unresolved_findings: unresolvedFindings.length,
          planner_fallback: planSubtasks.length === 1 &&
            planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
          budget_seconds: this.budgetForTier(tier, "coder"),
          iteration
        }
      });
    }

    const createPr = this.deps.prCreator ?? createPullRequest;
    const prUrl = await createPr({
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

  /**
   * Centralized failure path: record full forensics, pause the task in
   * `awaiting_intervention`, and throw `StageFailedError`. While the system
   * is being built we want EVERY stage failure surfaced to a human rather
   * than silently swallowed or auto-retried. The operator decides whether
   * to retry the failed stage or cancel.
   */
  private pauseForIntervention(args: {
    taskId: string;
    projectId: string;
    fromStage: TaskStage;
    failureCategory: string;
    failureReason: string;
    forensics: Record<string, unknown>;
  }): never {
    const { taskId, projectId, fromStage, failureCategory, failureReason, forensics } = args;
    this.recordEvent({
      taskId,
      projectId,
      agent: "orchestrator",
      type: "failure_analysis",
      status: "failed",
      payload: this.failureAnalysisPayload({
        ...forensics,
        stage_failed: fromStage,
        failure_reason: failureReason,
        failure_category: failureCategory,
        awaiting_intervention: true
      }),
      budgetSeconds: 60
    });
    this.transition(taskId, projectId, fromStage, "awaiting_intervention", {
      stage_failed: fromStage,
      failure_category: failureCategory,
      failure_reason: failureReason
    });
    throw new StageFailedError(taskId, fromStage, failureReason);
  }

  /**
   * Build a failure_analysis payload with guaranteed provenance keys.
   *
   * When `taskId` is provided AND the caller did not pass explicit provenance
   * fields, the method looks up the most recent agent-attributed event for the
   * task (via DbClient.getLastAgentProvenance) and backfills executor_used,
   * persona_version_id, and skill_version_ids. Used by cancelTask / rejectTask /
   * sweepStaleTasks — all of which emit failure_analysis from the orchestrator
   * (not from an agent) and would otherwise carry null provenance (Spec A
   * review Mi1).
   */
  private failureAnalysisPayload(
    payload: Record<string, unknown>,
    taskId?: string
  ): Record<string, unknown> {
    let executorUsed = payload.executor_used ?? null;
    let personaVersionId = payload.persona_version_id ?? null;
    let skillVersionIds = Array.isArray(payload.skill_version_ids)
      ? (payload.skill_version_ids as string[])
      : [];

    const hasExplicitProvenance =
      payload.executor_used !== undefined ||
      payload.persona_version_id !== undefined ||
      Array.isArray(payload.skill_version_ids);

    if (taskId && !hasExplicitProvenance) {
      const last = this.deps.db.getLastAgentProvenance(taskId);
      if (last) {
        executorUsed = last.executorUsed ?? null;
        personaVersionId = last.personaVersionId ?? null;
        skillVersionIds = last.skillVersionIds;
      }
    }

    return {
      ...payload,
      executor_used: executorUsed,
      persona_version_id: personaVersionId,
      skill_version_ids: skillVersionIds,
      tool_stats: normalizeToolStats(payload.tool_stats as ToolStats | Record<string, unknown> | null | undefined)
    };
  }

  private emitVariantSelected(input: {
    taskId: string;
    projectId: string;
    agentType: AgentType;
    selectedVariantId: string;
    budgetSeconds: number;
  }): void {
    this.recordEvent({
      taskId: input.taskId,
      projectId: input.projectId,
      agent: "orchestrator",
      type: "variant_selected",
      status: "done",
      payload: {
        agent_type: input.agentType,
        selected_variant_id: input.selectedVariantId,
        selected_variant_specialty: null,
        eligible_variant_ids: [input.selectedVariantId],
        selection_rationale: "only_eligible",
        shadow_variant_ids: [],
        injected_lesson_ids: []
      },
      budgetSeconds: input.budgetSeconds
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
    tokenUsage?: { input: number; output: number; estimatedCost?: number };
    executorUsed?: string;
    personaVersionId?: string;
    skillVersionIds?: string[];
    resumable?: boolean;
  }): void {
    const provenance: Record<string, unknown> = {};
    if (input.personaVersionId) provenance.persona_version_id = input.personaVersionId;
    if (input.skillVersionIds?.length) provenance.skill_version_ids = input.skillVersionIds;

    const message: AutoforgeMessage = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      timestamp: new Date().toISOString(),
      agent: input.agent,
      type: input.type,
      status: input.status,
      payload: { ...input.payload, ...provenance },
      budgetSeconds: input.budgetSeconds,
      elapsedSeconds: input.elapsedSeconds,
      tokenUsage: input.tokenUsage
        ? { input: input.tokenUsage.input, output: input.tokenUsage.output, estimatedCost: input.tokenUsage.estimatedCost ?? 0 }
        : undefined
    };

    this.deps.db.transaction(() => {
      this.deps.db.appendEvent(message, { executorUsed: input.executorUsed });
      this.deps.db.applyEvent(message);
    });

    // Publish to NATS JetStream asynchronously (fire-and-forget; SQLite is the source of truth).
    this.deps.nats?.publishTaskEvent(message).catch((err) => {
      console.warn(`[orchestrator] NATS publish failed for ${message.type}: ${err}`);
    });
  }

  /**
   * Build the environment passed to agent executors. Currently exposes
   * QMD_MCP_URL when configured so agents can query the knowledge base
   * (planner for scoping, coder/reviewer/doc/doc-review for grounding
   * implementation and documentation against indexed architecture docs).
   * Secrets like GITHUB_TOKEN are deliberately never forwarded — privileged
   * operations run through dedicated helpers in src/privileged/.
   */
  private agentEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.deps.env.QMD_MCP_URL) {
      env.QMD_MCP_URL = this.deps.env.QMD_MCP_URL;
    }
    return env;
  }

  private budgetForTier(tier: PipelineTask["tier"], step: "planner" | "coder" | "reviewer" | "doc"): number {
    const budgets = {
      EXPRESS: { planner: 180, coder: 300, reviewer: 0, doc: 120 },
      STANDARD: { planner: 480, coder: 480, reviewer: 180, doc: 180 },
      THOROUGH: { planner: 900, coder: 720, reviewer: 480, doc: 300 }
    };
    return budgets[tier][step];
  }

  /**
   * Route to the most appropriate executor for a given tier and agent type.
   * SDK executor is used for EXPRESS tier simple tasks (cheaper, sufficient).
   * Claude Code is used for STANDARD/THOROUGH and for agents that need full filesystem access.
   * Falls back to the configured primary executor when routing is not available.
   */
  private routeExecutor(tier: Tier, agentType: AgentType): AgentExecutor {
    const set = this.deps.executors;
    if (!set) return this.deps.executor;

    // Planner always routed to SDK so we can capture transcripts and pick
    // the model per run (Opus for STANDARD/THOROUGH). Falls back to Claude
    // Code if no SDK executor is configured (e.g. local dev without API key).
    if (agentType === "planner") return set.sdk ?? set.claudeCode;

    // Reflector is an SDK-executor job so we can get structured JSON output
    // reliably. Claude Code fallback for local dev without SDK credentials.
    if (agentType === "reflector") return set.sdk ?? set.claudeCode;

    // Meta agent always gets Claude Code — needs broad exploration.
    if (agentType === "meta") return set.claudeCode;

    // SDK executor for EXPRESS tier (existing behavior).
    if (tier === "EXPRESS" && set.sdk) return set.sdk;

    return set.claudeCode;
  }

  private cleanupWorktree(taskId: string): void {
    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (worktreePath) {
      const branch = `autoforge/${taskId}`;
      this.deps.worktrees.remove({ branch, path: worktreePath });
    }
    this.cleanupIterationTags(taskId);
  }

  private captureTaskDiffStats(taskId: string): void {
    try {
      const worktree = this.deps.worktrees.get(taskId);
      if (!worktree?.baseRef) {
        return;
      }

      const stats = computeDiffStats(worktree.path, worktree.baseRef);
      if (!stats) {
        console.warn(`[diff-stats] Skipping diff stats for task ${taskId}: git diff failed`);
        return;
      }

      this.deps.db.insertTaskDiffStats(taskId, stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[diff-stats] Failed for task ${taskId}: ${message}`);
    }
  }

  private captureIterationDiff(taskId: string, worktreePath: string, iteration: number): void {
    try {
      this.ensureIterationTag(taskId, worktreePath, iteration);
      if (iteration === 0) {
        return;
      }

      const fromRef = this.iterationTagName(taskId, iteration - 1);
      const toRef = this.iterationTagName(taskId, iteration);
      const fromCommit = this.resolveGitRef(worktreePath, fromRef);
      const toCommit = this.resolveGitRef(worktreePath, toRef);
      if (!fromCommit || !toCommit || fromCommit === toCommit) {
        return;
      }

      const delta = computeIterationDiff(worktreePath, fromRef, toRef);
      if (!delta) {
        console.warn(
          `[iteration-diff] Skipping diff for task ${taskId} iteration ${iteration - 1}->${iteration}: git diff failed`
        );
        return;
      }

      this.deps.db.insertTaskIterationDiff(taskId, iteration - 1, iteration, delta);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[iteration-diff] Skipped for task ${taskId}: ${message}`);
    }
  }

  private ensureIterationTag(taskId: string, worktreePath: string, iteration: number): void {
    const tagName = this.iterationTagName(taskId, iteration);
    if (this.resolveGitRef(worktreePath, tagName)) {
      return;
    }
    execSync(`git tag ${tagName}`, {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"]
    });
  }

  private iterationTagName(taskId: string, iteration: number): string {
    return `autoforge/iter-${taskId}-${iteration}`;
  }

  private cleanupIterationTags(taskId: string): void {
    try {
      const tagPattern = `autoforge/iter-${taskId}-*`;
      const tags = execSync(`git tag --list "${tagPattern}"`, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const tag of tags) {
        try {
          execSync(`git tag -d ${tag}`, {
            cwd: process.cwd(),
            stdio: ["ignore", "ignore", "pipe"]
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[iteration-diff] Failed to delete tag ${tag}: ${message}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[iteration-diff] Failed to enumerate iteration tags for task ${taskId}: ${message}`);
    }
  }

  private resolveGitRef(worktreePath: string, ref: string): string | null {
    try {
      return execSync(`git rev-parse --verify ${ref}`, {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      return null;
    }
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

function parsePlanSubtasks(taskId: string, output: unknown, worktreePath?: string): PlanSubtask[] {
  // Primary: planner writes subtasks directly into the status file output.
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
      testCriteria: subtask.testCriteria ?? ["Tests pass."],
      agentType: subtask.agentType
    }));
  }

  // Fallback: look for a subtasks.json file the planner may have written separately.
  if (worktreePath) {
    try {
      const subtasksPath = pathJoin(worktreePath, "subtasks.json");
      if (existsSync(subtasksPath)) {
        const parsed = JSON.parse(readFileSync(subtasksPath, "utf8"));
        const list = Array.isArray(parsed) ? parsed : parsed?.subtasks;
        if (Array.isArray(list) && list.length > 0) {
          return (list as Array<Partial<PlanSubtask>>).map((subtask, index) => ({
            id: subtask.id ?? `${taskId}-subtask-${index + 1}`,
            sequence: subtask.sequence ?? index + 1,
            description: subtask.description ?? `Subtask ${index + 1}`,
            filesInScope: subtask.filesInScope ?? ["src/"],
            dependencies: subtask.dependencies ?? [],
            testCriteria: subtask.testCriteria ?? ["Tests pass."],
            agentType: subtask.agentType
          }));
        }
      }
    } catch {
      // subtasks.json unreadable or malformed — fall through to default
    }
  }

  // Last resort: generic single subtask. Signals planner output was unparseable.
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

function buildRestartDescription(
  original: string,
  feedback: RejectionFeedback,
  parentId: string
): string {
  const lines = [
    original,
    "",
    "## Reviewer feedback from previous attempt",
    `Previous task ${parentId} was rejected. Treat the notes below as binding guidance — do not repeat the same mistakes.`,
    "",
    `**Reason for rejection:** ${feedback.reason}`
  ];
  if (feedback.guidance) {
    lines.push("", `**Guidance for this attempt:** ${feedback.guidance}`);
  }
  return lines.join("\n");
}

function buildDocPrompt(description: string, subtasks: PlanSubtask[]): string {
  const subtaskList = subtasks.map((s, i) => `${i + 1}. ${s.description}`).join("\n");
  return [
    `## Feature\n${description}`,
    `## Subtasks completed\n${subtaskList}`,
    "## Instructions\nUpdate or create documentation for the changes made. Update README.md if it exists. Create or update relevant docs/ files. Focus on usage examples and public API changes. Keep docs concise and accurate."
  ].join("\n\n");
}

function isSuccess(status: SubtaskReportStatus | "FAILED" | "TIMEOUT"): boolean {
  return status === "DONE" || status === "DONE_WITH_CONCERNS";
}

function normalizeToolStats(
  toolStats: ToolStats | Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!toolStats || typeof toolStats !== "object") {
    return null;
  }

  const stats = toolStats as Partial<ToolStats> & Record<string, unknown>;
  return {
    read_count: Number(stats.readCount ?? stats.read_count ?? 0),
    write_count: Number(stats.writeCount ?? stats.write_count ?? 0),
    bash_count: Number(stats.bashCount ?? stats.bash_count ?? 0),
    search_count: Number(stats.searchCount ?? stats.search_count ?? 0),
    iterations: Number(stats.iterations ?? 0)
  };
}
