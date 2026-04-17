import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join as pathJoin } from "node:path";
import type { AppEnv } from "../config/env";
import { assessComplexity, routeTier } from "../assessment/tier";
import { type AutoforgeMessage } from "../nats/messages";
import type { AgentExecutor } from "../executors/interface";
import type { DbClient } from "../db/client";
import type { NatsClient } from "../nats/client";
import type { AgentType, PipelineTask, PlanSubtask, RejectionFeedback, ReviewFinding, SubtaskReportStatus, TaskStage, Tier } from "../types/core";
import { assertTransition } from "./state-machine";
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

export class OrchestratorService {
  private readonly skills: SkillRegistry;
  private readonly personas: PersonaRegistry;

  constructor(private readonly deps: ServiceDeps) {
    this.skills = new SkillRegistry(resolve(process.cwd(), deps.env.SKILLS_DIR), deps.db);
    this.personas = new PersonaRegistry(deps.db, resolve(process.cwd(), "src/personas"));
  }

  listTasks(): PipelineTask[] {
    return this.deps.db.listTasks();
  }

  getTask(taskId: string): PipelineTask | null {
    return this.deps.db.getTask(taskId);
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

    const planSubtasks = await this.runPlannerAttempt(
      taskId,
      projectId,
      description,
      tier,
      worktree.path,
      0,
      null
    );

    if (this.pausePolicy(tier, opts.reviewPlan)) {
      this.transition(taskId, projectId, "planning", "awaiting_plan_approval", { planSubtasks });
      return this.requireTask(taskId);
    }

    this.transition(taskId, projectId, "planning", "executing", { planSubtasks });

    try {
      await this.executeAndReview(taskId, projectId, description, tier, planSubtasks, 0, worktree.path, worktree.branch);
    } catch (err) {
      this.cleanupWorktree(taskId);
      throw err;
    }
    const task = this.deps.db.getTask(taskId);
    if (!task) {
      throw new Error("Task disappeared after orchestration.");
    }
    if (task.state === "awaiting_approval") {
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

    const plannerPersonaId = this.personas.snapshotId("planner");
    const plannerSkillIds = this.skills.snapshotIds("planner");
    const planSubtasks = parsePlanSubtasks(taskId, plannerResult.output, worktreePath);
    const plannerFallback =
      planSubtasks.length === 1 &&
      planSubtasks[0].description === "Implement requested behavior with tests-first workflow.";

    // Persist transcript before emitting `planned` so the event payload pointer
    // is always valid.
    const transcript = plannerResult.transcript;
    const turnsJsonl = transcript
      ? transcript.turns.map((t) => JSON.stringify(t)).join("\n")
      : "";

    const transcriptId = this.deps.db.insertTranscript({
      taskId,
      stage: "planner",
      attempt,
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
      payload: {
        stage_failed: "awaiting_approval",
        failure_reason: `Rejected by reviewer: ${feedback.reason}`,
        failure_category: "rejected",
        rejection_categories: feedback.categories ?? [],
        rejection_guidance: feedback.guidance ?? null,
        planner_fallback: oldTask.planSubtasks.length === 1 &&
          oldTask.planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
        iteration: oldTask.iteration
      },
      budgetSeconds: 60
    });
    this.transition(taskId, oldTask.projectId, "awaiting_approval", "failed", {
      reason: `rejected: ${feedback.reason}`,
      iteration: oldTask.iteration
    });
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
      payload: {
        stage_failed: task.state,
        failure_reason: reason,
        failure_category: "cancelled",
        planner_fallback: task.planSubtasks.length === 1 &&
          task.planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
        budget_seconds: this.budgetForTier(task.tier, "coder"),
        iteration: task.iteration
      },
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, task.state, "failed", { reason: `cancelled: ${reason}`, iteration: task.iteration });
    this.cleanupWorktree(taskId);
    return this.requireTask(taskId);
  }

  /**
   * On startup, find tasks stuck in non-terminal states beyond their staleness
   * threshold and auto-fail them with a failure_analysis event.
   */
  sweepStaleTasks(): void {
    const nonTerminalStates = ["received", "assessing", "planning", "executing", "reviewing", "reworking", "pr_created", "documenting"];
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
          payload: {
            stage_failed: task.state,
            failure_reason: `Task stuck in '${task.state}' for more than ${Math.round((now - updatedAt) / 60000)} minutes`,
            failure_category: "stalled",
            planner_fallback: task.planSubtasks.length === 1 &&
              task.planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
            budget_seconds: this.budgetForTier(task.tier, "coder"),
            elapsed_ms: now - updatedAt,
            iteration: task.iteration
          },
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
      this.cleanupWorktree(metaTaskId);
      return { experimentId: null, status: metaResult.status };
    }

    // Read the meta output — expects a "meta" key in the status file output.
    const metaOutput = metaResult.output as Record<string, unknown> | undefined;
    const metaMeta = metaOutput?.meta as Record<string, unknown> | undefined;

    if (!metaMeta?.target_asset || !metaMeta?.hypothesis) {
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

    while (true) {
      const currentState = this.requireTask(taskId).state;
      if (currentState !== "executing") {
        this.transition(taskId, projectId, currentState, "executing", { iteration });
      }

      for (const subtask of planSubtasks) {
        const subtaskAgentType = subtask.agentType ?? "coder";
        const subtaskPersonaId = this.personas.snapshotId(subtaskAgentType);
        const subtaskSkillIds = this.skills.snapshotIds(subtaskAgentType);
        const coderExecutor = this.routeExecutor(tier, subtaskAgentType);

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
          this.recordEvent({
            taskId,
            projectId,
            agent: "orchestrator",
            type: "failure_analysis",
            status: "failed",
            payload: {
              stage_failed: "executing",
              failure_reason: coderResult.blockReason ?? `coder returned ${coderResult.status}`,
              failure_category: failureCategory,
              executor_used: coderExecutor.name,
              persona_version_id: subtaskPersonaId,
              skill_version_ids: subtaskSkillIds,
              tool_stats: coderResult.metrics.toolStats ?? null,
              planner_fallback: planSubtasks.length === 1 &&
                planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
              budget_seconds: this.budgetForTier(tier, "coder"),
              elapsed_seconds: coderResult.metrics.elapsedSeconds,
              iteration
            },
            budgetSeconds: 60
          });
          this.transition(taskId, projectId, "executing", "failed", {
            reason: coderResult.blockReason ?? "coder failed",
            iteration
          });
          throw new Error(`Coder failed with status ${coderResult.status}`);
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
        this.recordEvent({
          taskId,
          projectId,
          agent: "orchestrator",
          type: "failure_analysis",
          status: "failed",
          payload: {
            stage_failed: "reviewing",
            failure_reason: "Exceeded rework iteration limit (3 rounds of CRITICAL/MAJOR findings)",
            failure_category: "rework_limit",
            planner_fallback: planSubtasks.length === 1 &&
              planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
            budget_seconds: this.budgetForTier(tier, "coder"),
            iteration
          },
          budgetSeconds: 60
        });
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
      this.recordEvent({
        taskId,
        projectId,
        agent: "orchestrator",
        type: "failure_analysis",
        status: "failed",
        payload: {
          stage_failed: "reviewing",
          failure_reason: gate.reason ?? "PR gate rejected task",
          failure_category: "pr_gate",
          planner_fallback: planSubtasks.length === 1 &&
            planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
          budget_seconds: this.budgetForTier(tier, "coder"),
          iteration
        },
        budgetSeconds: 60
      });
      this.transition(taskId, projectId, "reviewing", "failed", { reason: gate.reason, iteration });
      throw new Error(gate.reason ?? "PR gate rejected task");
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
