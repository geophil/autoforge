import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join as pathJoin } from "node:path";
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
import { PersonaRegistry } from "../personas/registry";
import { createPullRequest, evaluatePrGate, mergePullRequest, closePullRequest } from "../privileged/pr";
import { runAuthenticatedTests } from "../privileged/tests";

interface ServiceDeps {
  env: AppEnv;
  db: DbClient;
  executor: AgentExecutor;
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
      systemPrompt: this.personas.resolve("planner"),
      prompt: `## Task\n${description}\n\n## Complexity signals\nTier: ${tier} | Scope: ${assessment.scope} | Risk: ${assessment.risk} | Coupling: ${assessment.coupling}`,
      workingDirectory: worktree.path,
      budgetSeconds: this.budgetForTier(tier, "planner"),
      environment: this.deps.env.QMD_MCP_URL ? { QMD_MCP_URL: this.deps.env.QMD_MCP_URL } : {},
      skillFiles: this.skills.skillsForAgent("planner"),
      metadata: { description, tier }
    });

    const plannerPersonaId = this.personas.snapshotId("planner");
    const plannerSkillIds = this.skills.snapshotIds("planner");
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
      elapsedSeconds: plannerResult.metrics.elapsedSeconds,
      tokenUsage: plannerResult.metrics.tokenInput !== undefined ? {
        input: plannerResult.metrics.tokenInput,
        output: plannerResult.metrics.tokenOutput ?? 0,
        estimatedCost: plannerResult.metrics.estimatedCost
      } : undefined,
      executorUsed: this.deps.executor.name,
      personaVersionId: plannerPersonaId,
      skillVersionIds: plannerSkillIds
    });

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

      const docResult = await this.deps.executor.execute({
        id: `${taskId}-doc`,
        type: "doc",
        systemPrompt: this.personas.resolve("doc"),
        prompt: buildDocPrompt(task.description, task.planSubtasks),
        workingDirectory: worktreePath,
        budgetSeconds: this.budgetForTier(task.tier, "doc"),
        environment: {},
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
        executorUsed: this.deps.executor.name,
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

  async rejectTask(taskId: string, reason: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_approval") {
      throw new Error("Task is not awaiting approval.");
    }

    // Close the PR if one was created.
    if (task.prUrl) {
      await closePullRequest(task.prUrl);
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

    const metaResult = await this.deps.executor.execute({
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
      executorUsed: this.deps.executor.name,
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

        const coderResult = await this.deps.executor.execute({
          id: subtask.id,
          type: subtaskAgentType,
          systemPrompt: this.personas.resolve(subtaskAgentType),
          prompt: buildCoderPrompt(description, subtask, iteration),
          workingDirectory: worktreePath,
          budgetSeconds: this.budgetForTier(tier, "coder"),
          environment: {},
          skillFiles: this.skills.skillsForAgent(subtaskAgentType),
          metadata: { taskId, subtask, description }
        });

        if (!isSuccess(coderResult.status)) {
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
          executorUsed: this.deps.executor.name,
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

      const reviewResult = await this.deps.executor.execute({
        id: `${taskId}-review-${iteration}`,
        type: "reviewer",
        systemPrompt: this.personas.resolve("reviewer"),
        prompt: buildReviewerPrompt(description, planSubtasks),
        workingDirectory: worktreePath,
        budgetSeconds: this.budgetForTier(tier, "reviewer"),
        environment: {},
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
        executorUsed: this.deps.executor.name,
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

  private budgetForTier(tier: PipelineTask["tier"], step: "planner" | "coder" | "reviewer" | "doc"): number {
    const budgets = {
      EXPRESS: { planner: 180, coder: 300, reviewer: 0, doc: 120 },
      STANDARD: { planner: 480, coder: 480, reviewer: 180, doc: 180 },
      THOROUGH: { planner: 900, coder: 720, reviewer: 480, doc: 300 }
    };
    return budgets[tier][step];
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
