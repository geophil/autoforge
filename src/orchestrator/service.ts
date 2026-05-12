import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { AppEnv } from "../config/env";
import { assessComplexity, routeTier } from "../assessment/tier";
import { type AutoforgeMessage } from "../nats/messages";
import type { AgentExecutor, AgentResult, AgentTask, ToolStats } from "../executors/interface";
import type { DbClient } from "../db/client";
import type { NatsClient } from "../nats/client";
import type {
  AgentType,
  PipelineTask,
  PlanSubtask,
  PlannerRequestedPhase,
  PlannerSpecArtifacts,
  ParsedPlannerOutput,
  RejectionFeedback,
  ReviewFinding,
  SubtaskReportStatus,
  TaskStage,
  Tier
} from "../types/core";
import { emptyPlanningContext } from "../types/core";
import { assertTransition } from "./state-machine";
import { computeDiffStats, computeIterationDiff } from "./diff-stats";
import { reflectOnTask, type ReflectionResult } from "./reflection";
import { retrieveLessonsForDispatch } from "./lessons";
import { REFLECTION_CONFIG } from "../config/reflection";
import { WorktreeManager } from "../git/worktrees";
import { SkillRegistry } from "../skills/registry";
import { PersonaRegistry } from "../personas/registry";
import { createDispatcher, type SelectionResult } from "./dispatch";
import { createEmbeddingProvider, serializeEmbedding, type EmbeddingProvider } from "./embedding";
import { runShadowDispatches, type ShadowRunner } from "./shadow";
import { defaultDispatchConfig } from "../config/dispatch";
import { createPullRequest, evaluatePrGate, mergePullRequest, closePullRequest } from "../privileged/pr";
import { runAuthenticatedTests } from "../privileged/tests";
import { validateMetaOutput } from "../schemas/meta-output";
import { handleMetaOperation } from "./meta-operations";
import { AutoTuner, evaluateAutoRetire, evaluateCandidate } from "./auto-tuner";
import { runDiagnostic } from "./diagnostic";
import { checkpointStageOrder, parseCheckpointPayload, type TaskCheckpointPayload, type TaskCheckpointStage } from "./checkpoints";
import { collectPendingSteering, renderSteeringPrompt, type SteeringScope } from "./steering";
import { runLifecycleHooks, type LifecycleHookPhase, type LifecycleHookRun, type LifecycleHooksResult } from "./lifecycle-hooks";
import { LocalWorkspace } from "../runtime/local-workspace";
import type { Workspace } from "../runtime/workspace";
import { isPlannerFallbackOutput, parsePlannerStructuredOutput } from "./planner-output";
import type { AgentTranscriptMeta } from "../types/transcripts";
import { pendingWorkspaceDestroyPayloads, workspaceCreatedPayload } from "../runtime/workspace-cleanup";

const QMD_TOOL_NAMES = new Set(["query", "get", "multi_get", "status"]);
const ARTIFACT_VALIDATION_MISMATCH_THRESHOLD = 0.4;
const ARTIFACT_VALIDATION_IGNORED_PATHS = new Set([
  ".autoforge-status.json",
  ".autoforge-worktree.json"
]);

interface ServiceDeps {
  env: AppEnv;
  db: DbClient;
  executor: AgentExecutor;
  worktrees: WorktreeManager;
  nats?: NatsClient;
  testRunner?: (workingDirectory: string, projectId: string) => Promise<{ passRate: number; output: string }>;
  prCreator?: (payload: import("../privileged/pr").PrPayload) => Promise<string>;
  dispatcher?: ReturnType<typeof createDispatcher>;
  embeddingProvider?: EmbeddingProvider;
  shadowRunner?: ShadowRunner;
  /**
   * Override for the lifecycle-hook runner. Production omits this and gets
   * `runLifecycleHooks` (which actually invokes `bun run <script>` in the
   * task worktree). Tests inject a stub that returns a "skipped, completed"
   * result so the orchestrator pipeline doesn't recursively execute the
   * autoforge `lint` / `test` scripts inside the test fixture's worktree.
   */
  lifecycleHookRunner?: (input: {
    phase: LifecycleHookPhase;
    workingDirectory: string;
    timeoutSeconds: number;
  }) => LifecycleHooksResult;
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
  private readonly dispatcher: ReturnType<typeof createDispatcher>;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly autoTuner = new AutoTuner();
  private terminalTaskCount = 0;

  constructor(private readonly deps: ServiceDeps) {
    this.skills = new SkillRegistry(resolve(process.cwd(), deps.env.SKILLS_DIR), deps.db);
    this.personas = new PersonaRegistry(deps.db, resolve(process.cwd(), "src/personas"));
    this.embeddingProvider = deps.embeddingProvider ?? createEmbeddingProvider(deps.env);
    this.dispatcher = deps.dispatcher ?? createDispatcher(deps.db, {
      embeddingProvider: this.embeddingProvider
    });
  }

  private localWorkspace(rootPath: string, taskId: string, dispatchId: string, projectId?: string): LocalWorkspace {
    const workspace = new LocalWorkspace({ rootPath, taskId, dispatchId });
    if (projectId) {
      const alreadyCreated = this.deps.db.listEvents(taskId).some((event) => {
        return event.type === "workspace_created" && event.payload.workspace_id === workspace.id;
      });
      if (!alreadyCreated) {
        this.recordEvent({
          taskId,
          projectId,
          agent: "orchestrator",
          type: "workspace_created",
          status: "done",
          payload: workspaceCreatedPayload({
            workspaceId: workspace.id,
            provider: workspace.provider,
            taskId,
            dispatchId,
            rootPath: workspace.rootPath
          }),
          budgetSeconds: 0
        });
      }
    }
    return workspace;
  }

  async backfillSpecialtyEmbeddings(): Promise<number> {
    const rows = this.deps.db.sqlite.query(`
      SELECT id, specialty
        FROM skill_versions
       WHERE specialty IS NOT NULL
         AND specialty_embedding IS NULL
       ORDER BY created_at ASC, id ASC
    `).all() as Array<{ id: string; specialty: string }>;

    let updated = 0;
    for (const row of rows) {
      try {
        const vector = await this.embeddingProvider.embed(row.specialty);
        this.deps.db.updateSpecialtyEmbedding(row.id, serializeEmbedding(vector));
        updated += 1;
      } catch (err) {
        console.warn(
          `[embedding] Specialty embedding backfill failed for variant=${row.id}: ${(err as Error).message ?? err}`
        );
      }
    }
    return updated;
  }

  async runPopulationDiagnostic(
    agentType: AgentType,
    trigger: "task_count_50" | "nightly_cron" | "manual" = "manual"
  ): Promise<{ clustersProposed: number }> {
    const diagnosticExecutor = this.routeExecutor("STANDARD", "diagnostician");
    const clustersProposed = await runDiagnostic({
      db: this.deps.db,
      executor: diagnosticExecutor,
      recordEvent: (event) => this.recordEvent(event),
      agentType,
      trigger,
      workingDirectory: process.cwd()
    });
    return { clustersProposed };
  }

  startDiagnosticScheduler(): void {
    const dayMs = 24 * 60 * 60 * 1000;
    setInterval(() => {
      for (const agentType of ["planner", "coder", "reviewer", "doc"] as AgentType[]) {
        void this.runPopulationDiagnostic(agentType, "nightly_cron").catch((err) => {
          console.warn(`[diagnostic] nightly ${agentType} failed: ${(err as Error).message}`);
        });
      }
    }, dayMs).unref?.();
  }

  listTasks(opts?: { includeArchived?: boolean; onlyArchived?: boolean }): PipelineTask[] {
    return this.deps.db.listTasks(opts);
  }

  getTask(taskId: string): PipelineTask | null {
    return this.deps.db.getTask(taskId);
  }

  addSteeringMessage(
    taskId: string,
    message: string,
    scope: SteeringScope = "next_attempt",
    author = "operator"
  ): PipelineTask {
    const task = this.requireTask(taskId);
    if (task.state === "completed" || task.state === "failed") {
      throw new Error(`Cannot steer task ${taskId}: task is in terminal state '${task.state}'`);
    }
    if (scope !== "next_attempt") {
      throw new Error("unsupported_steering_scope");
    }
    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "steering_message",
      status: "done",
      payload: {
        message: message.trim(),
        scope,
        author,
        created_at: new Date().toISOString()
      },
      budgetSeconds: 60
    });
    return this.requireTask(taskId);
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
    const lessonCount = (this.deps.db.sqlite
      .query("SELECT COUNT(*) AS count FROM lessons WHERE source_task_id = ?")
      .get(taskId) as { count: number }).count;
    if (lessonCount > 0) {
      throw new Error(`Cannot permanently delete task ${taskId}: ${lessonCount} lesson(s) reference it`);
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

  private recordPlannerPhaseMismatch(taskId: string, projectId: string, detail: string): void {
    this.recordEvent({
      taskId,
      projectId,
      agent: "orchestrator",
      type: "planner_phase_mismatch",
      status: "done_with_concerns",
      payload: { detail },
      budgetSeconds: 60
    });
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
    const pauseReview = this.pausePolicySubmit(tier, opts.reviewPlan);

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
        iteration: 0,
        reviewPlan: opts.reviewPlan ?? null
      },
      budgetSeconds: 60
    });
    this.recordCheckpoint({
      taskId,
      projectId,
      iteration: 0,
      stage: "planning",
      worktreePath: worktree.path,
      label: "task-start",
      planningPhase: "spec"
    });

    this.transition(taskId, projectId, "received", "assessing", { assessment, tier });
    this.transition(taskId, projectId, "assessing", "planning", {});

    let planSubtasks: PlanSubtask[] = [];

    try {
      if (tier === "EXPRESS") {
        const parsed = await this.runPlannerAttempt({
          taskId,
          projectId,
          description,
          tier,
          worktreePath: worktree.path,
          transcriptStage: "planner:execution_plan",
          requestedPhase: "execution_plan",
          critique: null
        });
        const extra: Record<string, unknown> = {};
        const planningContext = {
          ...emptyPlanningContext(),
          planRevision: parsed.planSubtasks.length > 0 ? 1 : 0,
          qmdContext: parsed.planningContext.qmdContext ?? null
        };
        if (parsed.phase === "combined") {
          extra.specArtifacts = parsed.specArtifacts;
          planningContext.specRevision = Math.max(parsed.planningContext.specRevision, 1);
        }
        extra.planningContext = planningContext;
        this.transition(taskId, projectId, "planning", "executing", {
          planSubtasks: parsed.planSubtasks,
          ...extra
        });
        planSubtasks = parsed.planSubtasks;
      } else if (!pauseReview) {
        let preservedSpec: PlannerSpecArtifacts | null = null;
        let preservedQmdContext = null;
        let parsed = await this.runPlannerAttempt({
          taskId,
          projectId,
          description,
          tier,
          worktreePath: worktree.path,
          transcriptStage: "planner:execution_plan",
          requestedPhase: "combined",
          critique: null
        });

        if (parsed.phase === "spec") {
          preservedSpec = parsed.specArtifacts;
          preservedQmdContext = parsed.planningContext.qmdContext ?? null;
          this.recordEvent({
            taskId,
            projectId,
            agent: "orchestrator",
            type: "planner_phase_fallback_to_two_call",
            status: "done",
            payload: { reason: "combined_output_spec_only" },
            budgetSeconds: 60
          });
          parsed = await this.runPlannerAttempt({
            taskId,
            projectId,
            description,
            tier,
            worktreePath: worktree.path,
            transcriptStage: "planner:execution_plan",
            requestedPhase: "execution_plan",
            critique: null,
            approvedSpec: preservedSpec
          });
          if (parsed.planSubtasks.length === 0) {
            this.pauseForIntervention({
              taskId,
              projectId,
              fromStage: "planning",
              failureCategory: "planner_failed",
              failureReason: "execution plan missing after combined-phase fallback",
              forensics: { agent: "planner", transcript_stage: "planner:execution_plan" }
            });
          }
        } else if (parsed.phase === "combined") {
          preservedSpec = parsed.specArtifacts;
          preservedQmdContext = parsed.planningContext.qmdContext ?? null;
        } else if (parsed.phase === "execution_plan" || parsed.phase === "legacy_subtasks") {
          preservedQmdContext = parsed.planningContext.qmdContext ?? null;
          this.recordPlannerPhaseMismatch(taskId, projectId, "combined_requested_execution_shaped_only");
        }

        const reviewedAt = new Date().toISOString();
        const planningContext = {
          ...emptyPlanningContext(),
          approvalMode: "auto" as const,
          reviewedAt,
          specRevision: preservedSpec ? 1 : 0,
          planRevision: parsed.planSubtasks.length > 0 ? 1 : 0,
          qmdContext: parsed.planningContext.qmdContext ?? preservedQmdContext ?? null
        };

        this.transition(taskId, projectId, "planning", "executing", {
          planSubtasks: parsed.planSubtasks,
          specArtifacts: preservedSpec,
          planningContext,
          currentBlockingQuestion: null
        });
        planSubtasks = parsed.planSubtasks;
      } else {
        let parsed = await this.runPlannerAttempt({
          taskId,
          projectId,
          description,
          tier,
          worktreePath: worktree.path,
          transcriptStage: "planner:spec",
          requestedPhase: "spec",
          critique: null
        });

        if (parsed.phase === "execution_plan" || parsed.phase === "legacy_subtasks") {
          if (parsed.planSubtasks.length > 0 && !isPlannerFallbackOutput(parsed.planSubtasks)) {
            this.recordPlannerPhaseMismatch(taskId, projectId, "spec_requested_got_execution_plan");
            this.transition(taskId, projectId, "planning", "awaiting_spec_approval", {
              specArtifacts: null,
              planningContext: emptyPlanningContext(),
              currentBlockingQuestion:
                "planner returned execution plan when spec was requested — please clarify",
              planSubtasks: []
            });
            return this.requireTask(taskId);
          }
        }

        if (parsed.phase === "combined") {
          this.recordPlannerPhaseMismatch(taskId, projectId, "spec_phase_received_combined_execution_discarded");
          parsed = {
            phase: "spec",
            specArtifacts: parsed.specArtifacts,
            planningContext: parsed.planningContext,
            blockingQuestion: parsed.blockingQuestion,
            planSubtasks: []
          };
        }

        if (parsed.phase !== "spec") {
          this.pauseForIntervention({
            taskId,
            projectId,
            fromStage: "planning",
            failureCategory: "planner_failed",
            failureReason: `spec planner produced ${parsed.phase} without usable spec artifacts`,
            forensics: { agent: "planner", parsed_phase: parsed.phase }
          });
        }

        const specScoped = this.scopeFilteredPlannerTranscripts(taskId, "planner:spec");
        const planningContext = {
          ...parsed.planningContext,
          specRevision: specScoped.length,
          planRevision: 0
        };

        this.transition(taskId, projectId, "planning", "awaiting_spec_approval", {
          specArtifacts: parsed.specArtifacts,
          planningContext,
          currentBlockingQuestion: parsed.blockingQuestion,
          planSubtasks: []
        });
        return this.requireTask(taskId);
      }

      await this.executeAndReview(taskId, projectId, description, tier, planSubtasks, 0, worktree.path, worktree.branch);
    } catch (err) {
      // Planner failure has already been surfaced (failure_analysis event +
      // awaiting_intervention transition inside runPlannerAttempt). Return
      // the paused task so the caller can show the operator what happened.
      if (err instanceof StageFailedError) {
        return this.requireTask(taskId);
      }
      // Unexpected errors (e.g. PR creation failure while already in `reviewing`)
      // do not run finalizeTerminalTask; avoid leaking the task worktree.
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

  private effectivePauseReview(task: PipelineTask): boolean {
    if (task.reviewPlan === true) return true;
    if (task.reviewPlan === false) return false;
    return task.tier === "STANDARD" || task.tier === "THOROUGH";
  }

  /** Submit-time review preference before `PipelineTask` projection exists. */
  private pausePolicySubmit(tier: Tier, reviewPlan?: boolean): boolean {
    if (reviewPlan !== undefined) return reviewPlan;
    return tier === "STANDARD" || tier === "THOROUGH";
  }

  private latestRollbackEventId(taskId: string): string | null {
    const events = this.deps.db.listEvents(taskId);
    const rev = [...events].reverse().find((e) => e.type === "rollback_applied");
    return rev?.id ?? null;
  }

  private scopeFilteredPlannerTranscripts(taskId: string, stage: string): AgentTranscriptMeta[] {
    const scope = this.latestRollbackEventId(taskId);
    const rows = this.deps.db.listTranscriptsByTask(taskId).filter((t) => t.stage === stage);
    return rows.filter((t) => (scope === null ? !t.rollbackEventId : t.rollbackEventId === scope));
  }

  private nextTranscriptAttempt(taskId: string, stage: string): number {
    const rows = this.deps.db.listTranscriptsByTask(taskId).filter((t) => t.stage === stage);
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((r) => r.attempt)) + 1;
  }

  private plannerModel(tier: Tier): string {
    if (tier === "EXPRESS") return this.deps.env.PLANNER_MODEL_EXPRESS;
    return this.deps.env.PLANNER_MODEL_COMPLEX;
  }

  private observedQmdTools(result: AgentResult): string[] {
    const seen = new Set<string>();
    const turns = result.transcript?.turns ?? [];
    for (const turn of turns) {
      if (turn.kind !== "assistant" || !Array.isArray(turn.content)) continue;
      for (const block of turn.content) {
        if (!block || typeof block !== "object") continue;
        const row = block as { type?: unknown; name?: unknown };
        if (row.type !== "tool_use" || typeof row.name !== "string") continue;
        if (QMD_TOOL_NAMES.has(row.name)) {
          seen.add(row.name);
        }
      }
    }
    return Array.from(seen).sort();
  }

  private requireQmdEvidenceForPlanner(args: {
    taskId: string;
    projectId: string;
    transcriptStage: "planner:spec" | "planner:execution_plan";
    requestedPhase: PlannerRequestedPhase;
    parsed: ParsedPlannerOutput;
    transcriptId: string;
    attempt: number;
    plannerExecutorName: string;
    plannerPersonaId: string;
    plannerSkillIds: string[];
    plannerResult: AgentResult;
    observedQmdTools: string[];
  }): void {
    if (!this.deps.env.QMD_MCP_URL) return;
    const qmdContext = args.parsed.planningContext.qmdContext ?? null;
    const qmdEvidenceStatus = qmdContext?.status ?? "missing";
    const hasEvidence =
      qmdContext?.status === "used" &&
      ((qmdContext.queries?.length ?? 0) > 0 || (qmdContext.documents?.length ?? 0) > 0);
    if (hasEvidence) return;

    const currentTask = this.requireTask(args.taskId);
    this.pauseForIntervention({
      taskId: args.taskId,
      projectId: args.projectId,
      fromStage: currentTask.state,
      failureCategory: "planner_missing_qmd_context",
      failureReason: "planner output missing required QMD knowledgebase evidence",
      forensics: {
        agent: "planner",
        executor_used: args.plannerExecutorName,
        model: this.plannerModel(currentTask.tier),
        persona_version_id: args.plannerPersonaId,
        skill_version_ids: args.plannerSkillIds,
        tool_stats: args.plannerResult.metrics.toolStats ?? null,
        transcript_id: args.transcriptId,
        transcript_stage: args.transcriptStage,
        attempt: args.attempt,
        iteration: currentTask.iteration,
        requested_phase: args.requestedPhase,
        parsed_phase: args.parsed.phase,
        qmd_required: true,
        qmd_evidence_status: qmdEvidenceStatus,
        qmd_context: qmdContext,
        qmd_tools_observed: args.observedQmdTools
      }
    });
  }

  private async runPlannerAttempt(args: {
    taskId: string;
    projectId: string;
    description: string;
    tier: Tier;
    worktreePath: string;
    transcriptStage: "planner:spec" | "planner:execution_plan";
    requestedPhase: PlannerRequestedPhase;
    critique: string | null;
    priorPlan?: PlanSubtask[];
    approvedSpec?: PlannerSpecArtifacts | null;
    priorSpecArtifacts?: PlannerSpecArtifacts | null;
    currentBlockingQuestion?: string | null;
  }): Promise<ParsedPlannerOutput> {
    const {
      taskId,
      projectId,
      description,
      tier,
      worktreePath,
      transcriptStage,
      requestedPhase,
      critique,
      priorPlan,
      approvedSpec,
      priorSpecArtifacts,
      currentBlockingQuestion
    } = args;

    const attempt = this.nextTranscriptAttempt(taskId, transcriptStage);
    const plannerExecutor = this.routeExecutor(tier, "planner");
    const userPrompt = this.buildPlannerPrompt({
      description,
      tier,
      phase: requestedPhase,
      transcriptAttemptIndex: attempt,
      priorPlan,
      approvedSpec,
      priorSpecArtifacts,
      critique,
      currentBlockingQuestion
    });
    const plannerSteering = this.steeringForDispatch(taskId);
    const plannerPrompt = plannerSteering.prompt ? `${plannerSteering.prompt}\n\n${userPrompt}` : userPrompt;
    const plannerDispatch = await this.selectPersonaForDispatch("planner", { description, tier, projectId });
    const plannerPersonaId = plannerDispatch.selection.variantId;
    const plannerSkillIds = this.skills.snapshotIds("planner");

    const plannerLessons = await this.loadLessonsForDispatch(plannerPersonaId, "planner", description);

    this.emitVariantSelected({
      taskId,
      projectId,
      agentType: "planner",
      selection: plannerDispatch.selection,
      selectedVariantSpecialty: plannerDispatch.specialty,
      budgetSeconds: this.budgetForTier(tier, "planner"),
      injectedLessonIds: plannerLessons.ids
    });

    const plannerTask = {
      id: taskId,
      type: "planner",
      systemPrompt: plannerDispatch.content,
      prompt: plannerPrompt,
      workspace: this.localWorkspace(worktreePath, taskId, "planner", projectId),
      budgetSeconds: this.budgetForTier(tier, "planner"),
      environment: this.agentEnvironment(),
      skillFiles: this.skills.skillsForAgent("planner"),
      metadata: { description, tier, attempt },
      model: this.plannerModel(tier),
      lessons: plannerLessons.block || undefined
    } as const;
    const plannerResult = await plannerExecutor.execute(plannerTask);
    this.recordSteeringConsumed({
      taskId,
      projectId,
      steeringEventIds: plannerSteering.eventIds,
      agentType: "planner",
      iteration: attempt,
      personaVariantId: plannerPersonaId
    });

    await this.runShadowDispatchesSafely({
      taskId,
      projectId,
      agentType: "planner",
      selection: plannerDispatch.selection,
      liveTask: plannerTask,
      liveResult: plannerResult,
      baselineExecutorUsed: plannerExecutor.name,
      baselineLessonIds: plannerLessons.ids,
      baselineVariantId: plannerDispatch.baselineVariantId,
      loadCandidateLessons: (candidateVariantId) =>
        this.loadLessonsForDispatch(candidateVariantId, "planner", description)
    });

    const transcript = plannerResult.transcript;
    const turnsJsonl = transcript ? transcript.turns.map((t) => JSON.stringify(t)).join("\n") : "";

    const transcriptId = this.deps.db.insertTranscript({
      taskId,
      stage: transcriptStage,
      attempt,
      personaVersionId: plannerPersonaId,
      executorUsed: plannerExecutor.name,
      model: this.plannerModel(tier),
      systemPrompt: transcript?.systemPrompt ?? plannerDispatch.content,
      userPrompt: transcript?.userPrompt ?? plannerPrompt,
      transcript: turnsJsonl,
      output: plannerResult.output ? JSON.stringify(plannerResult.output) : null,
      critique,
      tokenInput: plannerResult.metrics.tokenInput ?? null,
      tokenOutput: plannerResult.metrics.tokenOutput ?? null,
      elapsedSeconds: plannerResult.metrics.elapsedSeconds,
      rollbackEventId: this.latestRollbackEventId(taskId)
    });

    if (plannerResult.status === "FAILED" || plannerResult.status === "TIMEOUT") {
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
          ...this.failureDiagnosticsForResult({
            taskId,
            result: plannerResult,
            workspace: plannerTask.workspace,
            executorMode: plannerExecutor.name
          }),
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
          token_output: plannerResult.metrics.tokenOutput ?? 0,
          transcript_stage: transcriptStage
        }
      });
    }

    const observedQmdTools = this.observedQmdTools(plannerResult);
    const parsed = parsePlannerStructuredOutput(taskId, plannerResult.output, requestedPhase, worktreePath);
    this.requireQmdEvidenceForPlanner({
      taskId,
      projectId,
      transcriptStage,
      requestedPhase,
      parsed,
      transcriptId,
      attempt,
      plannerExecutorName: plannerExecutor.name,
      plannerPersonaId,
      plannerSkillIds,
      plannerResult,
      observedQmdTools
    });
    const plannerFallback =
      (parsed.phase === "execution_plan" || parsed.phase === "legacy_subtasks") &&
      parsed.planSubtasks.length > 0 &&
      isPlannerFallbackOutput(parsed.planSubtasks);

    const plannedPayload: Record<string, unknown> = {
      parsed_phase: parsed.phase,
      requested_phase: requestedPhase,
      planSubtasks: parsed.planSubtasks,
      planner_fallback: plannerFallback,
      attempt,
      transcript_id: transcriptId,
      transcript_stage: transcriptStage,
      planningContext: parsed.planningContext,
      qmd_tools_observed: observedQmdTools
    };
    if (parsed.phase === "spec" || parsed.phase === "combined") {
      plannedPayload.specArtifacts = parsed.specArtifacts;
      plannedPayload.blockingQuestion = parsed.blockingQuestion;
    }

    this.recordEvent({
      taskId,
      projectId,
      agent: "planner",
      type: "planned",
      status: plannerFallback ? "done_with_concerns" : "done",
      payload: plannedPayload,
      budgetSeconds: this.budgetForTier(tier, "planner"),
      elapsedSeconds: plannerResult.metrics.elapsedSeconds,
      tokenUsage:
        plannerResult.metrics.tokenInput !== undefined
          ? {
              input: plannerResult.metrics.tokenInput,
              output: plannerResult.metrics.tokenOutput ?? 0,
              estimatedCost: plannerResult.metrics.estimatedCost
            }
          : undefined,
      executorUsed: plannerExecutor.name,
      personaVersionId: plannerPersonaId,
      skillVersionIds: plannerSkillIds
    });

    return parsed;
  }

  private buildPlannerPrompt(params: {
    description: string;
    tier: Tier;
    phase: PlannerRequestedPhase;
    transcriptAttemptIndex: number;
    priorPlan?: PlanSubtask[];
    approvedSpec?: PlannerSpecArtifacts | null;
    priorSpecArtifacts?: PlannerSpecArtifacts | null;
    critique: string | null;
    currentBlockingQuestion?: string | null;
  }): string {
    const assessment = assessComplexity(params.description);
    const lines: string[] = [];
    lines.push("## Phase");
    lines.push(params.phase);
    lines.push("");
    lines.push(`## Task`);
    lines.push(params.description);
    lines.push("");
    lines.push(`## Complexity signals`);
    lines.push(
      `Tier: ${params.tier} | Scope: ${assessment.scope} | Risk: ${assessment.risk} | Coupling: ${assessment.coupling}`
    );
    lines.push("");
    lines.push("## Knowledgebase requirement");
    lines.push(
      "If QMD is configured (QMD_MCP_URL present), you MUST build context from QMD first and emit planningContext.qmdContext evidence in .autoforge-status.json."
    );
    lines.push(
      "Outputs missing required QMD evidence are rejected and the task is paused for intervention."
    );

    if (params.phase === "execution_plan" && params.approvedSpec) {
      lines.push("");
      lines.push("## Approved Spec");
      lines.push(JSON.stringify(params.approvedSpec, null, 2));
    }

    const attempt = params.transcriptAttemptIndex;
    const crit = params.critique?.trim() ?? "";

    if (params.phase === "execution_plan" && attempt > 0 && params.priorPlan && crit.length > 0) {
      lines.push("");
      lines.push(`## Prior plan (attempt ${attempt - 1})`);
      lines.push(JSON.stringify(params.priorPlan, null, 2));
      if (params.approvedSpec) {
        lines.push("");
        lines.push("## Approved Spec (reference)");
        lines.push(JSON.stringify(params.approvedSpec, null, 2));
      }
      lines.push("");
      lines.push("## Human feedback on prior plan");
      lines.push(crit);
      lines.push("");
      lines.push("## Instructions");
      lines.push(
        "Revise the plan to address the feedback. Prefer minimal changes — keep subtasks that were not critiqued, unless the feedback implies they should change."
      );
      return lines.join("\n");
    }

    if (params.phase === "spec" && attempt > 0 && params.priorSpecArtifacts && crit.length > 0) {
      lines.push("");
      lines.push(`## Prior discovery/spec (attempt ${attempt - 1})`);
      lines.push(JSON.stringify(params.priorSpecArtifacts, null, 2));
      lines.push("");
      if (params.currentBlockingQuestion && params.currentBlockingQuestion.trim()) {
        lines.push("## Operator Answer To Question");
        lines.push(`> Q: ${params.currentBlockingQuestion}`);
        lines.push("");
        lines.push("A:");
        lines.push(crit);
      } else {
        lines.push("## Operator Critique");
        lines.push(crit);
      }
      lines.push("");
      lines.push("## Instructions");
      lines.push(
        "Revise discovery/spec to address the feedback. Prefer minimal edits — retain validated intent unless the critique explicitly challenges it."
      );
      return lines.join("\n");
    }

    return lines.join("\n");
  }

  async approveSpec(taskId: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_spec_approval") {
      throw new Error(`Cannot approve spec: task is in state '${task.state}'`);
    }

    const reviewedAt = new Date().toISOString();
    const prev = task.planningContext ?? emptyPlanningContext();
    const specAttempts = this.scopeFilteredPlannerTranscripts(taskId, "planner:spec").length;
    const planningContext = {
      ...prev,
      approvalMode: "manual" as const,
      reviewedAt,
      specRevision: Math.max(prev.specRevision, specAttempts),
      planRevision: prev.planRevision
    };

    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "spec_approved",
      status: "done",
      payload: { reviewedAt },
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, "awaiting_spec_approval", "planning", {
      planningContext,
      currentBlockingQuestion: null,
      specArtifacts: task.specArtifacts
    });

    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (!worktreePath) throw new Error(`Worktree missing for task ${taskId}`);

    let parsed: ParsedPlannerOutput;
    try {
      parsed = await this.runPlannerAttempt({
        taskId,
        projectId: task.projectId,
        description: task.description,
        tier: task.tier,
        worktreePath,
        transcriptStage: "planner:execution_plan",
        requestedPhase: "execution_plan",
        critique: null,
        approvedSpec: task.specArtifacts ?? undefined
      });
    } catch (err) {
      if (err instanceof StageFailedError) return this.requireTask(taskId);
      throw err;
    }

    if (parsed.phase === "spec") {
      this.recordPlannerPhaseMismatch(taskId, task.projectId, "execution_requested_got_spec");
      this.pauseForIntervention({
        taskId,
        projectId: task.projectId,
        fromStage: "planning",
        failureCategory: "planner_phase_mismatch",
        failureReason: "planner returned spec-shaped output during execution-plan phase",
        forensics: { agent: "planner", parsed_phase: parsed.phase }
      });
    }

    const execAttempts = this.scopeFilteredPlannerTranscripts(taskId, "planner:execution_plan").length;
    const pcNext = {
      ...planningContext,
      planRevision: execAttempts,
      qmdContext: parsed.planningContext.qmdContext ?? planningContext.qmdContext ?? null
    };

    this.transition(taskId, task.projectId, "planning", "awaiting_plan_approval", {
      planSubtasks: parsed.planSubtasks,
      planningContext: pcNext,
      currentBlockingQuestion: null,
      specArtifacts: task.specArtifacts
    });
    return this.requireTask(taskId);
  }

  async critiqueSpec(taskId: string, critique: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_spec_approval") {
      throw new Error(`Cannot critique spec: task is in state '${task.state}'`);
    }

    const scoped = this.scopeFilteredPlannerTranscripts(taskId, "planner:spec");
    const lastAttempt = scoped.length === 0 ? -1 : Math.max(...scoped.map((t) => t.attempt));
    if (lastAttempt >= this.deps.env.PLANNER_SPEC_MAX_ITERATIONS) {
      throw new Error(
        `Spec re-plan iteration limit (${this.deps.env.PLANNER_SPEC_MAX_ITERATIONS}) reached for task ${taskId}`
      );
    }

    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "spec_critiqued",
      status: "in_progress",
      payload: {
        critique_text: critique,
        critiqued_attempt: lastAttempt,
        next_attempt: lastAttempt + 1
      },
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, "awaiting_spec_approval", "replanning", {});

    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (!worktreePath) {
      this.transition(taskId, task.projectId, "replanning", "failed", { reason: "worktree missing" });
      await this.finalizeTerminalTask(taskId);
      throw new Error(`Worktree missing for task ${taskId}`);
    }

    let parsed: ParsedPlannerOutput;
    try {
      parsed = await this.runPlannerAttempt({
        taskId,
        projectId: task.projectId,
        description: task.description,
        tier: task.tier,
        worktreePath,
        transcriptStage: "planner:spec",
        requestedPhase: "spec",
        critique,
        priorSpecArtifacts: task.specArtifacts ?? undefined,
        currentBlockingQuestion: task.currentBlockingQuestion ?? undefined
      });
    } catch (err) {
      if (err instanceof StageFailedError) return this.requireTask(taskId);
      this.transition(taskId, task.projectId, "replanning", "failed", {
        reason: err instanceof Error ? err.message : String(err)
      });
      await this.finalizeTerminalTask(taskId);
      throw err;
    }

    if (parsed.phase !== "spec") {
      this.pauseForIntervention({
        taskId,
        projectId: task.projectId,
        fromStage: "replanning",
        failureCategory: "planner_phase_mismatch",
        failureReason: `spec critique produced ${parsed.phase} output`,
        forensics: { agent: "planner", parsed_phase: parsed.phase }
      });
    }

    const specScoped = this.scopeFilteredPlannerTranscripts(taskId, "planner:spec");
    const planningContext = {
      ...(task.planningContext ?? emptyPlanningContext()),
      specRevision: specScoped.length,
      qmdContext: parsed.planningContext.qmdContext ?? task.planningContext?.qmdContext ?? null
    };

    this.transition(taskId, task.projectId, "replanning", "awaiting_spec_approval", {
      specArtifacts: parsed.specArtifacts,
      planningContext,
      currentBlockingQuestion: parsed.blockingQuestion,
      planSubtasks: []
    });
    return this.requireTask(taskId);
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
      await this.finalizeTerminalTask(taskId);
      throw err;
    }

    return this.requireTask(taskId);
  }

  async critiquePlan(taskId: string, critique: string): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_plan_approval") {
      throw new Error(`Cannot critique plan: task is in state '${task.state}'`);
    }

    const scoped = this.scopeFilteredPlannerTranscripts(taskId, "planner:execution_plan");
    const lastAttempt = scoped.length === 0 ? -1 : Math.max(...scoped.map((t) => t.attempt));
    if (lastAttempt >= this.deps.env.PLANNER_MAX_ITERATIONS) {
      throw new Error(`Re-plan iteration limit (${this.deps.env.PLANNER_MAX_ITERATIONS}) reached for task ${taskId}`);
    }

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
        next_attempt: lastAttempt + 1
      },
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, "awaiting_plan_approval", "replanning", {});

    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (!worktreePath) {
      this.transition(taskId, task.projectId, "replanning", "failed", { reason: "worktree missing" });
      await this.finalizeTerminalTask(taskId);
      throw new Error(`Worktree missing for task ${taskId}`);
    }

    let parsed: ParsedPlannerOutput;
    try {
      parsed = await this.runPlannerAttempt({
        taskId,
        projectId: task.projectId,
        description: task.description,
        tier: task.tier,
        worktreePath,
        transcriptStage: "planner:execution_plan",
        requestedPhase: "execution_plan",
        critique,
        priorPlan,
        approvedSpec: task.specArtifacts ?? undefined
      });
    } catch (err) {
      if (err instanceof StageFailedError) {
        return this.requireTask(taskId);
      }
      this.transition(taskId, task.projectId, "replanning", "failed", {
        reason: err instanceof Error ? err.message : String(err)
      });
      await this.finalizeTerminalTask(taskId);
      throw err;
    }

    const newPlan = parsed.planSubtasks;
    const execAttempts = this.scopeFilteredPlannerTranscripts(taskId, "planner:execution_plan").length;
    const prevPc = task.planningContext ?? emptyPlanningContext();
    this.transition(taskId, task.projectId, "replanning", "awaiting_plan_approval", {
      planSubtasks: newPlan,
      planningContext: {
        ...prevPc,
        planRevision: execAttempts,
        qmdContext: parsed.planningContext.qmdContext ?? prevPc.qmdContext ?? null
      }
    });
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
      const docDispatch = await this.selectPersonaForDispatch("doc", {
        description: task.description,
        tier: task.tier,
        projectId: task.projectId
      });
      const docPersonaId = docDispatch.selection.variantId;
      const docSkillIds = this.skills.snapshotIds("doc");

      const docExecutor = this.routeExecutor(task.tier, "doc");
      const docLessons = await this.loadLessonsForDispatch(docPersonaId, "doc", task.description);
      this.emitVariantSelected({
        taskId,
        projectId: task.projectId,
        agentType: "doc",
        selection: docDispatch.selection,
        selectedVariantSpecialty: docDispatch.specialty,
        budgetSeconds: this.budgetForTier(task.tier, "doc"),
        injectedLessonIds: docLessons.ids
      });
      const docSteering = this.steeringForDispatch(taskId);
      const baseDocPrompt = buildDocPrompt(task.description, task.planSubtasks);
      const docPrompt = docSteering.prompt
        ? `${docSteering.prompt}\n\n${baseDocPrompt}`
        : baseDocPrompt;
      const docTask = {
        id: `${taskId}-doc`,
        type: "doc",
        systemPrompt: docDispatch.content,
        prompt: docPrompt,
        workspace: this.localWorkspace(worktreePath, taskId, "doc", task.projectId),
        budgetSeconds: this.budgetForTier(task.tier, "doc"),
        environment: this.agentEnvironment(),
        skillFiles: this.skills.skillsForAgent("doc"),
        metadata: { taskId, description: task.description },
        lessons: docLessons.block || undefined
      } as const;
      const docResult = await docExecutor.execute(docTask);
      this.recordSteeringConsumed({
        taskId,
        projectId: task.projectId,
        steeringEventIds: docSteering.eventIds,
        agentType: "doc",
        iteration: task.iteration,
        personaVariantId: docPersonaId
      });

      await this.runShadowDispatchesSafely({
        taskId,
        projectId: task.projectId,
        agentType: "doc",
        selection: docDispatch.selection,
        liveTask: docTask,
        liveResult: docResult,
        baselineExecutorUsed: docExecutor.name,
        baselineLessonIds: docLessons.ids,
        baselineVariantId: docDispatch.baselineVariantId,
        loadCandidateLessons: (candidateVariantId) =>
          this.loadLessonsForDispatch(candidateVariantId, "doc", task.description)
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
    await this.finalizeTerminalTask(taskId);
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
    await this.finalizeTerminalTask(taskId);

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
        cancel_reason: reason,
        planner_fallback: task.planSubtasks.length === 1 &&
          task.planSubtasks[0]?.description === "Implement requested behavior with tests-first workflow.",
        budget_seconds: this.budgetForTier(task.tier, "coder"),
        iteration: task.iteration
      }, taskId),
      budgetSeconds: 60
    });

    this.transition(taskId, task.projectId, task.state, "failed", { reason: `cancelled: ${reason}`, iteration: task.iteration });
    await this.finalizeTerminalTask(taskId);
    return this.requireTask(taskId);
  }

  /**
   * Run the reflector synchronously for a terminal task. Called by the
   * orchestrator immediately after captureTaskDiffStats on every non-meta
   * terminal transition. Also exposed publicly for tests and operators.
   */
  async reflectOnTask(taskId: string): Promise<ReflectionResult> {
    const worktree = this.deps.worktrees.get(taskId);
    return reflectOnTask(taskId, {
      db: this.deps.db,
      executor: this.routeExecutor("EXPRESS", "reflector"),
      personas: this.personas,
      skills: this.skills,
      workingDirectory: worktree?.path ?? process.cwd(),
      recordEvent: (e) =>
        this.recordEvent({
          taskId: e.taskId,
          projectId: e.projectId,
          agent: e.agent as AutoforgeMessage["agent"],
          type: e.type,
          status: e.status as AutoforgeMessage["status"],
          payload: e.payload,
          budgetSeconds: e.budgetSeconds
        })
    });
  }

  private async finalizeTerminalTask(taskId: string): Promise<void> {
    this.captureTaskDiffStats(taskId);
    try {
      await this.reflectOnTask(taskId);
    } catch (reflectErr) {
      console.warn(
        `[orchestrator] reflectOnTask threw for ${taskId}: ${(reflectErr as Error).message ?? reflectErr}`
      );
    }
    try {
      const processedTerminalTask = await this.runAutoTunerForTask(taskId);
      if (processedTerminalTask && !this.isMetaTask(taskId)) {
        this.terminalTaskCount += 1;
      }
      if (processedTerminalTask && !this.isMetaTask(taskId) && this.terminalTaskCount % defaultDispatchConfig.diagnosticTriggerTaskCount === 0) {
        for (const agentType of ["planner", "coder", "reviewer", "doc"] as AgentType[]) {
          void this.runPopulationDiagnostic(agentType, "task_count_50").catch((err) => {
            console.warn(`[diagnostic] ${agentType} failed: ${(err as Error).message}`);
          });
        }
      }
    } finally {
      this.cleanupWorktree(taskId);
    }
  }

  private async runAutoTunerForTask(taskId: string): Promise<boolean> {
    const task = this.deps.db.getTask(taskId);
    if (!task) return false;
    if (task.state !== "completed" && task.state !== "failed") return false;

    try {
      const candidateIds = new Set<string>();
      const activeVariantIds = new Set<string>();

      for (const event of this.deps.db.listEvents(taskId)) {
        if (event.type !== "variant_selected") continue;
        const payload = event.payload;
        const shadowVariantIds = Array.isArray(payload.shadow_variant_ids)
          ? payload.shadow_variant_ids.filter((id): id is string => typeof id === "string")
          : [];
        for (const candidateId of shadowVariantIds) {
          candidateIds.add(candidateId);
        }

        const selectedVariantId = payload.selected_variant_id;
        const rationale = payload.selection_rationale;
        if (
          typeof selectedVariantId === "string"
          && (rationale === "exploitation" || rationale === "exploration")
          && this.variantStatus(selectedVariantId) === "active"
        ) {
          activeVariantIds.add(selectedVariantId);
        }
      }

      for (const candidateId of candidateIds) {
        evaluateCandidate(this.deps.db, candidateId);
      }
      for (const variantId of activeVariantIds) {
        this.autoTuner.evaluateActiveVariant(this.deps.db, variantId);
      }
      evaluateAutoRetire(this.deps.db);
    } catch (err) {
      this.recordAutoTunerFailed(task, err);
    }
    return true;
  }

  private isMetaTask(taskId: string): boolean {
    return this.deps.db.listEvents(taskId).some((event) => event.agent === "meta");
  }

  private variantStatus(variantId: string): string | null {
    const row = this.deps.db.sqlite
      .query("SELECT status FROM skill_versions WHERE id = ?")
      .get(variantId) as { status: string } | null;
    return row?.status ?? null;
  }

  private recordAutoTunerFailed(task: PipelineTask, err: unknown): void {
    this.recordEvent({
      taskId: task.id,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "auto_tuner_failed",
      status: "done_with_concerns",
      payload: {
        reason: err instanceof Error ? err.message : String(err)
      },
      budgetSeconds: 60
    });
  }

  private inferLastPlannerTranscriptStage(taskId: string): "planner:spec" | "planner:execution_plan" | null {
    // `listTranscriptsByTask` returns rows in (created_at, rowid) order, so the
    // last planner row is the chronologically-most-recent attempt regardless of
    // millisecond collisions on created_at.
    const rows = this.deps.db
      .listTranscriptsByTask(taskId)
      .filter((t) => t.stage === "planner:spec" || t.stage === "planner:execution_plan");
    if (rows.length === 0) return null;
    return rows[rows.length - 1].stage as "planner:spec" | "planner:execution_plan";
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
    opts: {
      fromStage?: "planning" | "executing";
      checkpointId?: string;
      operatorNote?: string;
      planningPhase?: "spec" | "execution_plan";
      resumeSubtaskId?: string;
      forceFullReplay?: boolean;
      /**
       * Bypass the `cannot_rollback_to_approved_spec` guard.
       *
       * The guard exists so an operator cannot silently overwrite an already-approved
       * spec by requesting `planningPhase: "spec"` without explicitly rolling back to
       * a spec-phase checkpoint (which inherently invalidates the prior approval).
       * `force: true` says "yes, throw away my approved spec without a rollback".
       */
      force?: boolean;
    } = {}
  ): Promise<PipelineTask> {
    const task = this.requireTask(taskId);
    if (task.state !== "awaiting_intervention") {
      throw new Error(`Cannot retry: task is in state '${task.state}', expected 'awaiting_intervention'`);
    }

    const events = this.deps.db.listEvents(taskId);
    const lastFailure = [...events].reverse().find((e) => e.type === "failure_analysis");
    const failedStage = (lastFailure?.payload.stage_failed as TaskStage | undefined) ?? "planning";
    // `replanning` folds into `planning`; reviewer/rework failures retry from execution by default.
    const defaultStage: "planning" | "executing" =
      failedStage === "planning" || failedStage === "replanning"
        ? "planning"
        : "executing";
    const targetStage = opts.fromStage ?? defaultStage;

    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (!worktreePath) {
      throw new Error(`Worktree missing for task ${taskId}; cannot retry`);
    }
    const branch = `autoforge/${taskId}`;
    const checkpoints = events
      .filter((event) => event.type === "checkpoint_created")
      .map((event) => ({ eventId: event.id, payload: parseCheckpointPayload(event.payload) }))
      .filter((event): event is { eventId: string; payload: TaskCheckpointPayload } => event.payload !== null);

    const inferredPhase: "spec" | "execution_plan" = (() => {
      if (opts.planningPhase) return opts.planningPhase;
      const last = this.inferLastPlannerTranscriptStage(taskId);
      return last === "planner:execution_plan" ? "execution_plan" : "spec";
    })();

    // Resolve the requested checkpoint up front so we can apply the
    // rollback-to-spec policy before any side effects (worktree reset / events).
    let checkpoint: TaskCheckpointPayload | null = null;
    if (opts.checkpointId) {
      checkpoint = checkpoints.find((c) => c.payload.checkpoint_id === opts.checkpointId)?.payload ?? null;
      if (!checkpoint || checkpoint.task_id !== taskId) {
        throw new Error("checkpoint_not_found");
      }
      if (checkpointStageOrder(checkpoint.stage) > checkpointStageOrder(targetStage)) {
        throw new Error("checkpoint_stage_after_retry_stage");
      }
    }

    // Rollback-to-approved-spec guard (plan §Task 7).
    //
    // When the task has an already-approved spec (planningContext.reviewedAt set),
    // requesting `planningPhase: "spec"` without a corresponding spec-checkpoint
    // rollback would silently throw away validated intent with no audit trail.
    // Reject with 409 unless `force: true` is supplied. Rolling back to a
    // spec-phase checkpoint is the audit-trailed path: the rollback_applied
    // event names the checkpoint and invalidates planningContext below.
    const hasApprovedSpec =
      targetStage === "planning" &&
      task.planningContext?.reviewedAt !== null &&
      task.planningContext?.reviewedAt !== undefined;
    const rollingBackToSpecCheckpoint =
      checkpoint?.planning_phase === "spec";
    if (
      targetStage === "planning" &&
      inferredPhase === "spec" &&
      hasApprovedSpec &&
      !rollingBackToSpecCheckpoint &&
      !opts.force
    ) {
      throw new Error("cannot_rollback_to_approved_spec");
    }

    let retryIteration = task.iteration;
    let invalidateApprovedSpec = false;
    if (checkpoint) {
      const priorHeadSha = this.deps.worktrees.currentHead(worktreePath);
      this.deps.worktrees.resetToCommit(worktreePath, checkpoint.git_sha);
      retryIteration = checkpoint.iteration;
      // If the rollback target is a spec-phase checkpoint and the task had an
      // approved spec, invalidate the approval. The transcript rows are
      // preserved for forensics; subsequent planner attempts are scoped by
      // `rollback_event_id` (see `scopeFilteredPlannerTranscripts`) so the
      // critique budget effectively resets while the monotonic attempt counter
      // does not.
      invalidateApprovedSpec = rollingBackToSpecCheckpoint && hasApprovedSpec;
      this.recordEvent({
        taskId,
        projectId: task.projectId,
        agent: "orchestrator",
        type: "rollback_applied",
        status: "done",
        payload: {
          checkpoint_id: checkpoint.checkpoint_id,
          prior_iteration: task.iteration,
          target_iteration: checkpoint.iteration,
          operator_note: opts.operatorNote ?? null,
          prior_head_sha: priorHeadSha,
          checkpoint_git_sha: checkpoint.git_sha,
          checkpoint_planning_phase: checkpoint.planning_phase ?? null,
          invalidated_planning_context: invalidateApprovedSpec
        },
        budgetSeconds: 60
      });
    }

    this.recordCheckpoint({
      taskId,
      projectId: task.projectId,
      iteration: retryIteration,
      stage: "awaiting_intervention",
      worktreePath,
      label: "pre-retry"
    });

    this.recordEvent({
      taskId,
      projectId: task.projectId,
      agent: "orchestrator",
      type: "retry_requested",
      status: "in_progress",
      payload: {
        from_stage: targetStage,
        previously_failed_stage: failedStage,
        checkpoint_id: opts.checkpointId ?? null,
        planning_phase: opts.planningPhase ?? null,
        resume_subtask_id: opts.resumeSubtaskId ?? null,
        force_full_replay: opts.forceFullReplay === true,
        operator_note: opts.operatorNote ?? null,
        iteration: retryIteration,
        force: opts.force === true
      },
      budgetSeconds: 60
    });

    if (targetStage === "planning") {
      const transitionPayload: Record<string, unknown> = {
        retry: true,
        iteration: retryIteration
      };
      if (invalidateApprovedSpec) {
        // Reset the approval-mode metadata; preserve specRevision/planRevision
        // counters so downstream analytics keep historical context.
        const prev = task.planningContext ?? emptyPlanningContext();
        transitionPayload.planningContext = {
          ...prev,
          approvalMode: null,
          reviewedAt: null
        };
      }
      this.transition(taskId, task.projectId, "awaiting_intervention", "planning", transitionPayload);

      // Phase selection precedence:
      //   1. Explicit `opts.planningPhase` wins.
      //   2. A spec-checkpoint rollback that invalidated the approved spec
      //      always retries as `spec` (plan §Task 7 step 4) — the operator
      //      asked for a fresh spec gate.
      //   3. Otherwise infer from the most recent planner transcript stage.
      const lastPlannerStage = this.inferLastPlannerTranscriptStage(taskId);
      const phase: "spec" | "execution_plan" =
        opts.planningPhase
          ?? (invalidateApprovedSpec ? "spec" : null)
          ?? (lastPlannerStage === "planner:execution_plan" ? "execution_plan" : "spec");

      try {
        if (!this.effectivePauseReview(task)) {
          let preservedSpec: PlannerSpecArtifacts | null = task.specArtifacts ?? null;
          let parsed = await this.runPlannerAttempt({
            taskId,
            projectId: task.projectId,
            description: task.description,
            tier: task.tier,
            worktreePath,
            transcriptStage: "planner:execution_plan",
            requestedPhase: "combined",
            critique: null
          });
          if (parsed.phase === "spec") {
            preservedSpec = parsed.specArtifacts;
            this.recordEvent({
              taskId,
              projectId: task.projectId,
              agent: "orchestrator",
              type: "planner_phase_fallback_to_two_call",
              status: "done",
              payload: { reason: "retry_combined_spec_only" },
              budgetSeconds: 60
            });
            parsed = await this.runPlannerAttempt({
              taskId,
              projectId: task.projectId,
              description: task.description,
              tier: task.tier,
              worktreePath,
              transcriptStage: "planner:execution_plan",
              requestedPhase: "execution_plan",
              critique: null,
              approvedSpec: preservedSpec
            });
            if (parsed.planSubtasks.length === 0) {
              this.pauseForIntervention({
                taskId,
                projectId: task.projectId,
                fromStage: "planning",
                failureCategory: "planner_failed",
                failureReason: "execution plan missing after retry combined-phase fallback",
                forensics: { agent: "planner", transcript_stage: "planner:execution_plan" }
              });
            }
          } else if (parsed.phase === "combined") {
            preservedSpec = parsed.specArtifacts;
          }

          const reviewedAt = new Date().toISOString();
          const planningContext = {
            ...emptyPlanningContext(),
            approvalMode: "auto" as const,
            reviewedAt,
            specRevision: preservedSpec ? 1 : 0,
            planRevision: parsed.planSubtasks.length > 0 ? 1 : 0
          };
          this.transition(taskId, task.projectId, "planning", "executing", {
            planSubtasks: parsed.planSubtasks,
            specArtifacts: preservedSpec,
            planningContext,
            currentBlockingQuestion: null
          });
          await this.executeAndReview(
            taskId,
            task.projectId,
            task.description,
            task.tier,
            parsed.planSubtasks,
            0,
            worktreePath,
            branch
          );
          return this.requireTask(taskId);
        }

        if (phase === "spec") {
          let parsed = await this.runPlannerAttempt({
            taskId,
            projectId: task.projectId,
            description: task.description,
            tier: task.tier,
            worktreePath,
            transcriptStage: "planner:spec",
            requestedPhase: "spec",
            critique: null
          });

          if (parsed.phase === "execution_plan" || parsed.phase === "legacy_subtasks") {
            if (parsed.planSubtasks.length > 0 && !isPlannerFallbackOutput(parsed.planSubtasks)) {
              this.recordPlannerPhaseMismatch(taskId, task.projectId, "retry_spec_requested_got_execution_plan");
              this.transition(taskId, task.projectId, "planning", "awaiting_spec_approval", {
                specArtifacts: null,
                planningContext: emptyPlanningContext(),
                currentBlockingQuestion:
                  "planner returned execution plan when spec was requested — please clarify",
                planSubtasks: []
              });
              return this.requireTask(taskId);
            }
          }

          if (parsed.phase === "combined") {
            this.recordPlannerPhaseMismatch(taskId, task.projectId, "retry_spec_phase_received_combined");
            parsed = {
              phase: "spec",
              specArtifacts: parsed.specArtifacts,
              planningContext: parsed.planningContext,
              blockingQuestion: null,
              planSubtasks: []
            };
          }

          if (parsed.phase !== "spec") {
            this.pauseForIntervention({
              taskId,
              projectId: task.projectId,
              fromStage: "planning",
              failureCategory: "planner_failed",
              failureReason: `retry spec planner produced ${parsed.phase}`,
              forensics: { agent: "planner", parsed_phase: parsed.phase }
            });
          }

          const specScoped = this.scopeFilteredPlannerTranscripts(taskId, "planner:spec");
          this.transition(taskId, task.projectId, "planning", "awaiting_spec_approval", {
            specArtifacts: parsed.specArtifacts,
            planningContext: {
              ...(parsed.planningContext ?? emptyPlanningContext()),
              specRevision: specScoped.length,
              planRevision: 0
            },
            currentBlockingQuestion: parsed.blockingQuestion,
            planSubtasks: []
          });
          return this.requireTask(taskId);
        }

        const parsedExec = await this.runPlannerAttempt({
          taskId,
          projectId: task.projectId,
          description: task.description,
          tier: task.tier,
          worktreePath,
          transcriptStage: "planner:execution_plan",
          requestedPhase: "execution_plan",
          critique: null,
          approvedSpec: task.specArtifacts ?? undefined
        });

        if (this.effectivePauseReview(task)) {
          const execAttempts = this.scopeFilteredPlannerTranscripts(taskId, "planner:execution_plan").length;
          const prevPc = task.planningContext ?? emptyPlanningContext();
          this.transition(taskId, task.projectId, "planning", "awaiting_plan_approval", {
            planSubtasks: parsedExec.planSubtasks,
            planningContext: { ...prevPc, planRevision: execAttempts },
            specArtifacts: task.specArtifacts
          });
          return this.requireTask(taskId);
        }

        this.transition(taskId, task.projectId, "planning", "executing", {
          planSubtasks: parsedExec.planSubtasks,
          specArtifacts: task.specArtifacts ?? undefined,
          planningContext: task.planningContext ?? undefined
        });
        await this.executeAndReview(
          taskId,
          task.projectId,
          task.description,
          task.tier,
          parsedExec.planSubtasks,
          0,
          worktreePath,
          branch
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
      this.transition(taskId, task.projectId, "awaiting_intervention", "executing", { retry: true, iteration: retryIteration });
      const resumeEnabled = this.deps.env.AUTOFORGE_RESUME_SUBTASK_ENABLED === "1";
      const automaticResumeSubtaskId =
        typeof lastFailure?.payload?.subtask_id === "string" ? (lastFailure.payload.subtask_id as string) : null;
      const requestedResumeSubtaskId =
        opts.resumeSubtaskId ?? (resumeEnabled && !opts.forceFullReplay ? automaticResumeSubtaskId : null);
      let firstIterationSubtaskStartIndex = 0;
      if (resumeEnabled && !opts.forceFullReplay && requestedResumeSubtaskId) {
        const idx = task.planSubtasks.findIndex((subtask) => subtask.id === requestedResumeSubtaskId);
        if (idx >= 0) {
          firstIterationSubtaskStartIndex = idx;
        } else if (opts.resumeSubtaskId) {
          throw new Error("resume_subtask_not_found");
        }
      }
      try {
        await this.executeAndReview(
          taskId, task.projectId, task.description, task.tier,
          task.planSubtasks, retryIteration, worktreePath, branch,
          { firstIterationSubtaskStartIndex }
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
  async sweepStaleTasks(): Promise<void> {
    const nonTerminalStates = [
      "received", "assessing", "planning", "replanning",
      "executing", "reviewing", "reworking", "pr_created", "documenting"
      // 'awaiting_spec_approval', 'awaiting_plan_approval', 'awaiting_approval', and 'awaiting_intervention'
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

        this.transition(task.id, task.projectId, task.state, "failed", {
          reason: `stalled: task stuck in '${task.state}' beyond staleness threshold`,
          iteration: task.iteration
        });

        await this.finalizeTerminalTask(task.id);
      }
    }
  }

  /**
   * Run a meta agent session to analyze performance and propose a structured
   * improvement operation (edit/fork/merge/promote/demote/retire). The meta
   * output is Zod-validated against `MetaOutputSchema` and dispatched through
   * `handleMetaOperation`. Unlike the legacy path, edit candidates land with
   * status='candidate' and traffic_share=0 — Spec C's dispatch policy is
   * responsible for any subsequent activation. Meta tasks are excluded from
   * `reflectOnTask` per Spec B §4.1.
   */
  async submitMetaTask(
    projectId: string,
    focus?: string
  ): Promise<{ experimentId: string | null; status: string; reason?: string }> {
    const metaTaskId = randomUUID();
    const worktree = this.deps.worktrees.create(metaTaskId);

    try {
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

      const metaDispatch = await this.selectPersonaForDispatch("meta", {
        description: focus ?? "meta improvement",
        tier: "STANDARD",
        projectId
      });
      const metaPersonaId = metaDispatch.selection.variantId;
      const metaSkillIds = this.skills.snapshotIds("meta");
      const metaExecutor = this.routeExecutor("STANDARD", "meta");

      this.emitVariantSelected({
        taskId: metaTaskId,
        projectId,
        agentType: "meta",
        selection: metaDispatch.selection,
        selectedVariantSpecialty: metaDispatch.specialty,
        budgetSeconds: 600
      });

      const metaResult = await metaExecutor.execute({
        id: metaTaskId,
        type: "meta",
        systemPrompt: metaDispatch.content,
        prompt,
        workspace: this.localWorkspace(worktree.path, metaTaskId, "meta", projectId),
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

      if (metaResult.status !== "DONE") {
        return { experimentId: null, status: metaResult.status };
      }

      const validation = validateMetaOutput(metaResult.output);
      if (!validation.ok || !validation.value) {
        const reason = validation.error ?? "invalid";
        this.recordEvent({
          taskId: metaTaskId,
          projectId,
          agent: "orchestrator",
          type: "meta_rejected",
          status: "done_with_concerns",
          payload: { reason },
          budgetSeconds: 60
        });
        return { experimentId: null, status: "DONE_WITH_CONCERNS", reason };
      }

      const operation = validation.value.operation;
      const handleResult = handleMetaOperation({
        db: this.deps.db,
        recordEvent: (event) => this.recordEvent(event),
        operation,
        metaTaskId,
        worktreePath: worktree.path,
        projectId
      });

      if (!handleResult.ok) {
        const reason = handleResult.reason ?? "handler_failed";
        this.recordEvent({
          taskId: metaTaskId,
          projectId,
          agent: "orchestrator",
          type: "meta_rejected",
          status: "done_with_concerns",
          payload: { reason: `handler:${reason}`, operation_kind: operation.kind },
          budgetSeconds: 60
        });
        return { experimentId: null, status: "DONE_WITH_CONCERNS", reason };
      }

      this.recordEvent({
        taskId: metaTaskId,
        projectId,
        agent: "orchestrator",
        type: "experiment_proposed",
        status: "done",
        payload: {
          experiment_id: handleResult.experimentId,
          operation_kind: operation.kind,
          candidate_variant_id: handleResult.candidateVariantId ?? null
        },
        budgetSeconds: 60
      });

      return { experimentId: handleResult.experimentId ?? null, status: "DONE" };
    } finally {
      this.captureTaskDiffStats(metaTaskId);
      try {
        this.cleanupWorktree(metaTaskId);
      } catch (cleanupErr) {
        console.warn(
          `[meta] cleanupWorktree threw for ${metaTaskId}: ${(cleanupErr as Error).message ?? cleanupErr}`
        );
      }
    }
  }

  /**
   * Conclude an active experiment by comparing metric_after against metric_before.
   * Pass keep=true to retain the new version, false to revert.
   */
  async concludeExperiment(experimentId: string, metricAfter: number, keep: boolean): Promise<void> {
    this.deps.db.concludeExperiment(experimentId, metricAfter, keep);
  }

  /**
   * Materialize a candidate skill_versions row from a proposed fork experiment.
   * Copies proposed_content into the new candidate, carries over parent_version_id
   * and specialty from evidence, flips the experiment to 'active', and applies
   * any pending lesson retirements that were deferred by the propose_fork op
   * (see meta-operations.ts Task 7 §6.4).
   */
  listPendingForkExperiments(): Array<Record<string, unknown>> {
    return (this.deps.db.sqlite.query(`
      SELECT id, hypothesis, change_description, metric_name, metric_before,
             operation, evidence, status, proposed_content, created_at
        FROM experiments
       WHERE status = 'proposed'
         AND operation = 'fork'
       ORDER BY created_at DESC, id ASC
    `).all() as Array<Record<string, unknown>>).map((row) => {
      const evidence = typeof row.evidence === "string" && row.evidence.length > 0
        ? JSON.parse(row.evidence) as Record<string, unknown>
        : {};
      return {
        experiment_id: row.id,
        hypothesis: row.hypothesis,
        evidence,
        parent_variant_id: evidence.parent_variant_id ?? null,
        proposed_specialty: evidence.specialty ?? null,
        proposed_content_preview: typeof row.proposed_content === "string"
          ? row.proposed_content.slice(0, 500)
          : "",
        created_at: row.created_at
      };
    });
  }

  rejectFork(experimentId: string, reviewer?: string, reason?: string): void {
    const row = this.deps.db.sqlite.query(`
      SELECT id, operation, status
        FROM experiments
       WHERE id = ?
    `).get(experimentId) as { id: string; operation: string; status: string } | undefined;

    if (!row) throw new Error("experiment not found");
    if (row.operation !== "fork" || row.status !== "proposed") {
      throw new Error("experiment not a proposed fork");
    }

    this.deps.db.transaction(() => {
      this.deps.db.sqlite.query(`
        UPDATE experiments
           SET status = 'discard',
               human_notes = ?,
               completed_at = datetime('now')
         WHERE id = ?
      `).run(reason ?? null, experimentId);

      this.recordEvent({
        taskId: experimentId,
        projectId: "meta",
        agent: "orchestrator",
        type: "fork_rejected",
        status: "done",
        payload: {
          experiment_id: experimentId,
          reviewer: reviewer ?? null,
          reason: reason ?? null
        },
        budgetSeconds: 0,
        analyticsOnly: true
      });
    });
  }

  async approveFork(
    experimentId: string,
    opts: { approver?: string; notes?: string } = {}
  ): Promise<{ variantId: string }> {
    const row = this.deps.db.sqlite.query(`
      SELECT id, operation, status, proposed_content, evidence
        FROM experiments
       WHERE id = ?
    `).get(experimentId) as {
      id: string;
      operation: string;
      status: string;
      proposed_content: string | null;
      evidence: string | null;
    } | undefined;

    if (!row) throw new Error("experiment not found");
    if (row.operation !== "fork" || row.status !== "proposed") {
      throw new Error("experiment not a proposed fork");
    }
    if (!row.proposed_content || row.proposed_content.trim().length === 0) {
      throw new Error("proposed content missing");
    }

    const evidence = row.evidence
      ? JSON.parse(row.evidence) as Record<string, unknown>
      : {};
    const parentId = typeof evidence.parent_variant_id === "string" ? evidence.parent_variant_id : undefined;
    const specialty = typeof evidence.specialty === "string" ? evidence.specialty : undefined;
    if (!parentId || !specialty) throw new Error("evidence missing fields");

    const parent = this.deps.db.getSkillVersionById(parentId);
    if (!parent) throw new Error("parent variant not found");

    const pendingRetireIds = Array.isArray(evidence.pending_retire_lessons)
      ? (evidence.pending_retire_lessons as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const forkProposalId = typeof evidence.fork_proposal_id === "string" ? evidence.fork_proposal_id : null;

    const variantId = randomUUID();
    const proposedContent = row.proposed_content;
    const lineageRootId = this.deps.db.resolveLineageRoot(parentId) ?? parentId;
    let specialtyEmbedding: Buffer | null = null;
    try {
      specialtyEmbedding = serializeEmbedding(await this.embeddingProvider.embed(specialty));
    } catch {
      specialtyEmbedding = null;
    }

    this.deps.db.transaction(() => {
      if (forkProposalId) {
        const proposal = this.deps.db.getForkProposal(forkProposalId);
        if (!proposal || proposal.status !== "open") {
          throw new Error("fork proposal not open");
        }
      }

      const transition = this.deps.db.sqlite.query(
        "UPDATE experiments SET status = 'active' WHERE id = ? AND status = 'proposed'"
      ).run(experimentId);
      if (transition.changes !== 1) {
        throw new Error("experiment not a proposed fork");
      }

      this.deps.db.sqlite.query(`
        INSERT INTO skill_versions
          (id, skill_name, version, content, experiment_id,
           parent_version_id, specialty, status, traffic_share)
        VALUES
          ($id, $skill, $version, $content, $exp,
           $parent, $specialty, 'candidate', 0.0)
      `).run({
        $id: variantId,
        $skill: parent.skill_name,
        $version: String(Date.now()),
        $content: proposedContent,
        $exp: experimentId,
        $parent: parentId,
        $specialty: specialty
      });

      if (specialtyEmbedding) {
        this.deps.db.updateSpecialtyEmbedding(variantId, specialtyEmbedding);
      }

      this.deps.db.appendTrafficAllocatedEvent({
        variantId,
        agentType: parent.skill_name.startsWith("persona:")
          ? parent.skill_name.slice("persona:".length)
          : parent.skill_name,
        oldStatus: null,
        newStatus: "candidate",
        oldTrafficShare: null,
        newTrafficShare: 0.0,
        reason: "meta_fork_approved"
      });

      if (pendingRetireIds.length > 0) {
        this.deps.db.retireLessons(pendingRetireIds);
      }

      if (forkProposalId) {
        const marked = this.deps.db.markForkProposalActedOn(forkProposalId, experimentId);
        if (!marked) {
          throw new Error("fork proposal not open");
        }
      }

      this.recordEvent({
        taskId: experimentId,
        projectId: "meta",
        agent: "orchestrator",
        type: "fork_approved",
        status: "done",
        payload: {
          experiment_id: experimentId,
          variant_id: variantId,
          new_variant_id: variantId,
          parent_variant_id: parentId,
          parent_id: parentId,
          lineage_root_id: lineageRootId,
          specialty,
          approver: opts.approver ?? null,
          notes: opts.notes ?? null
        },
        budgetSeconds: 0,
        analyticsOnly: true
      });
    });

    return { variantId };
  }

  private async executeAndReview(
    taskId: string,
    projectId: string,
    description: string,
    tier: PipelineTask["tier"],
    planSubtasks: PlanSubtask[],
    startingIteration: number,
    worktreePath: string,
    branch: string,
    options: {
      firstIterationSubtaskStartIndex?: number;
    } = {}
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

      const firstIterationStart = options.firstIterationSubtaskStartIndex ?? 0;
      const subtasksForIteration =
        iteration === startingIteration
          ? planSubtasks.slice(Math.max(0, firstIterationStart))
          : planSubtasks;

      for (const subtask of subtasksForIteration) {
        const subtaskAgentType = subtask.agentType ?? "coder";
        const subtaskDispatch = await this.selectPersonaForDispatch(subtaskAgentType, { description, tier, projectId });
        const subtaskPersonaId = subtaskDispatch.selection.variantId;
        const subtaskSkillIds = this.skills.snapshotIds(subtaskAgentType);
        const coderExecutor = this.routeExecutor(tier, subtaskAgentType);

        // Lessons are scoped to task granularity (Spec B §5) — retrieve against
        // the top-level task description, not the per-subtask description.
        const coderLessons = await this.loadLessonsForDispatch(subtaskPersonaId, subtaskAgentType, description);

        this.emitVariantSelected({
          taskId,
          projectId,
          agentType: subtaskAgentType,
          selection: subtaskDispatch.selection,
          selectedVariantSpecialty: subtaskDispatch.specialty,
          budgetSeconds: this.budgetForTier(tier, "coder"),
          injectedLessonIds: coderLessons.ids
        });

        const coderSteering = this.steeringForDispatch(taskId);
        const baseCoderPrompt = buildCoderPrompt(description, subtask, iteration);
        const coderPrompt = coderSteering.prompt
          ? `${coderSteering.prompt}\n\n${baseCoderPrompt}`
          : baseCoderPrompt;
        const liveTask = {
          id: subtask.id,
          type: subtaskAgentType,
          systemPrompt: subtaskDispatch.content,
          prompt: coderPrompt,
          workspace: this.localWorkspace(worktreePath, taskId, subtask.id, projectId),
          budgetSeconds: this.budgetForTier(tier, "coder"),
          environment: this.agentEnvironment(),
          skillFiles: this.skills.skillsForAgent(subtaskAgentType),
          metadata: { taskId, subtask, description },
          lessons: coderLessons.block || undefined
        };
        this.recordEvent({
          taskId,
          projectId,
          agent: subtaskAgentType,
          type: "subtask_started",
          status: "running",
          payload: { subtaskId: subtask.id, iteration, sequence: subtask.sequence, agentType: subtaskAgentType },
          budgetSeconds: this.budgetForTier(tier, "coder")
        });
        const coderResult = await coderExecutor.execute(liveTask);
        this.recordSteeringConsumed({
          taskId,
          projectId,
          steeringEventIds: coderSteering.eventIds,
          agentType: subtaskAgentType,
          iteration,
          personaVariantId: subtaskPersonaId
        });

        await this.runShadowDispatchesSafely({
          taskId,
          projectId,
          agentType: subtaskAgentType,
          selection: subtaskDispatch.selection,
          liveTask,
          liveResult: coderResult,
          baselineExecutorUsed: coderExecutor.name,
          baselineLessonIds: coderLessons.ids,
          baselineVariantId: subtaskDispatch.baselineVariantId,
          loadCandidateLessons: (candidateVariantId) =>
            this.loadLessonsForDispatch(candidateVariantId, subtaskAgentType, description),
          subtaskId: subtask.id,
          iteration
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
              ...this.failureDiagnosticsForResult({
                taskId,
                result: coderResult,
                workspace: liveTask.workspace,
                executorMode: coderExecutor.name
              }),
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

        const artifactValidation = this.validateArtifactReport(worktreePath, coderResult.artifacts);
        const artifactMismatchConcern =
          artifactValidation.status === "mismatch"
            ? `reported artifacts diverge from changed files (ratio=${artifactValidation.mismatch_ratio})`
            : null;
        const subtaskConcerns = [coderResult.concerns, artifactMismatchConcern]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join(" | ");

        this.recordEvent({
          taskId,
          projectId,
          agent: subtaskAgentType,
          type: "subtask_done",
          status:
            coderResult.status === "DONE" && artifactValidation.status !== "mismatch"
              ? "done"
              : "done_with_concerns",
          payload: {
            subtaskId: subtask.id,
            artifacts: coderResult.artifacts,
            concerns: subtaskConcerns.length > 0 ? subtaskConcerns : undefined,
            artifact_validation: artifactValidation
          },
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
        this.recordCheckpoint({
          taskId,
          projectId,
          iteration,
          stage: "executing",
          worktreePath,
          label: `subtask-${subtask.sequence}`
        });
      }

      await this.runLifecyclePhase({
        taskId,
        projectId,
        fromStage: "executing",
        phase: "post_coder_pre_review",
        worktreePath,
        iteration
      });

      this.transition(taskId, projectId, "executing", "reviewing", { iteration });

      // EXPRESS tier skips the reviewer — faster turnaround, lower risk tolerance.
      if (tier === "EXPRESS") {
        break;
      }

      const reviewerDispatch = await this.selectPersonaForDispatch("reviewer", { description, tier, projectId });
      const reviewerPersonaId = reviewerDispatch.selection.variantId;
      const reviewerSkillIds = this.skills.snapshotIds("reviewer");
      const reviewerExecutor = this.routeExecutor(tier, "reviewer");

      const reviewerLessons = await this.loadLessonsForDispatch(reviewerPersonaId, "reviewer", description);

      this.emitVariantSelected({
        taskId,
        projectId,
        agentType: "reviewer",
        selection: reviewerDispatch.selection,
        selectedVariantSpecialty: reviewerDispatch.specialty,
        budgetSeconds: this.budgetForTier(tier, "reviewer"),
        injectedLessonIds: reviewerLessons.ids
      });

      const reviewerSteering = this.steeringForDispatch(taskId);
      const baseReviewerPrompt = buildReviewerPrompt(description, planSubtasks);
      const reviewerPrompt = reviewerSteering.prompt
        ? `${reviewerSteering.prompt}\n\n${baseReviewerPrompt}`
        : baseReviewerPrompt;
      const reviewerTask = {
        id: `${taskId}-review-${iteration}`,
        type: "reviewer",
        systemPrompt: reviewerDispatch.content,
        prompt: reviewerPrompt,
        workspace: this.localWorkspace(worktreePath, taskId, `reviewer-${iteration}`, projectId),
        budgetSeconds: this.budgetForTier(tier, "reviewer"),
        environment: this.agentEnvironment(),
        skillFiles: this.skills.skillsForAgent("reviewer"),
        metadata: { taskId, iteration, description },
        lessons: reviewerLessons.block || undefined
      } as const;
      const reviewResult = await reviewerExecutor.execute(reviewerTask);
      this.recordSteeringConsumed({
        taskId,
        projectId,
        steeringEventIds: reviewerSteering.eventIds,
        agentType: "reviewer",
        iteration,
        personaVariantId: reviewerPersonaId
      });

      await this.runShadowDispatchesSafely({
        taskId,
        projectId,
        agentType: "reviewer",
        selection: reviewerDispatch.selection,
        liveTask: reviewerTask,
        liveResult: reviewResult,
        baselineExecutorUsed: reviewerExecutor.name,
        baselineLessonIds: reviewerLessons.ids,
        baselineVariantId: reviewerDispatch.baselineVariantId,
        loadCandidateLessons: (candidateVariantId) =>
          this.loadLessonsForDispatch(candidateVariantId, "reviewer", description)
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
            ...this.failureDiagnosticsForResult({
              taskId,
              result: reviewResult,
              workspace: reviewerTask.workspace,
              executorMode: reviewerExecutor.name
            }),
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

    await this.runLifecyclePhase({
      taskId,
      projectId,
      fromStage: "reviewing",
      phase: "pre_pr_gate",
      worktreePath,
      iteration
    });

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
      }, taskId),
      budgetSeconds: 60
    });
    this.transition(taskId, projectId, fromStage, "awaiting_intervention", {
      stage_failed: fromStage,
      failure_category: failureCategory,
      failure_reason: failureReason
    });
    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (worktreePath) {
      this.recordCheckpoint({
        taskId,
        projectId,
        iteration: this.requireTask(taskId).iteration,
        stage: "awaiting_intervention",
        worktreePath,
        label: `${fromStage}:${failureCategory}`
      });
    }
    throw new StageFailedError(taskId, fromStage, failureReason);
  }

  private latestCheckpointContext(taskId: string): {
    checkpoint_id: string | null;
    checkpoint_stage: string | null;
  } {
    const events = this.deps.db.listEvents(taskId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== "checkpoint_created") continue;
      const payload = parseCheckpointPayload(event.payload);
      if (!payload) continue;
      return {
        checkpoint_id: payload.checkpoint_id,
        checkpoint_stage: payload.label.replaceAll("-", "_")
      };
    }
    return { checkpoint_id: null, checkpoint_stage: null };
  }

  private validateArtifactReport(worktreePath: string, reportedArtifacts: string[]): {
    status: "ok" | "mismatch" | "unavailable";
    reported_count: number;
    observed_count: number;
    overlap_count: number;
    mismatch_ratio: number;
    threshold: number;
    missing_reported: string[];
    unexpected_changed: string[];
  } {
    const observedFiles = this.listPendingChangedFiles(worktreePath);
    if (observedFiles === null) {
      return {
        status: "unavailable",
        reported_count: reportedArtifacts.length,
        observed_count: 0,
        overlap_count: 0,
        mismatch_ratio: 0,
        threshold: ARTIFACT_VALIDATION_MISMATCH_THRESHOLD,
        missing_reported: [],
        unexpected_changed: []
      };
    }

    const reported = new Set(
      reportedArtifacts
        .map((path) => normalizeArtifactPath(path))
        .filter((path): path is string => path.length > 0 && !ARTIFACT_VALIDATION_IGNORED_PATHS.has(path))
    );
    const observed = new Set(
      observedFiles
        .map((path) => normalizeArtifactPath(path))
        .filter((path): path is string => path.length > 0 && !ARTIFACT_VALIDATION_IGNORED_PATHS.has(path))
    );

    const missingReported = [...reported].filter((path) => !observed.has(path)).sort();
    const unexpectedChanged = [...observed].filter((path) => !reported.has(path)).sort();
    const overlapCount = [...reported].filter((path) => observed.has(path)).length;
    const unionSize = new Set([...reported, ...observed]).size;
    const mismatchRatio =
      unionSize === 0
        ? 0
        : Number(((missingReported.length + unexpectedChanged.length) / unionSize).toFixed(3));
    const status =
      mismatchRatio > ARTIFACT_VALIDATION_MISMATCH_THRESHOLD
        ? "mismatch"
        : "ok";

    return {
      status,
      reported_count: reported.size,
      observed_count: observed.size,
      overlap_count: overlapCount,
      mismatch_ratio: mismatchRatio,
      threshold: ARTIFACT_VALIDATION_MISMATCH_THRESHOLD,
      missing_reported: missingReported,
      unexpected_changed: unexpectedChanged
    };
  }

  private listPendingChangedFiles(worktreePath: string): string[] | null {
    try {
      const porcelain = execSync("git -c core.quotepath=false status --porcelain --untracked-files=all", {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      const rows = porcelain
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length >= 4);
      const paths: string[] = [];
      for (const row of rows) {
        const body = row.slice(3).trim();
        if (!body) continue;
        const renamed = body.includes(" -> ")
          ? body.slice(body.lastIndexOf(" -> ") + 4)
          : body;
        const normalized = normalizeArtifactPath(renamed);
        if (normalized.length > 0) paths.push(normalized);
      }
      return [...new Set(paths)].sort();
    } catch {
      return null;
    }
  }

  private failureDiagnosticsForResult(args: {
    taskId: string;
    result: AgentResult;
    workspace?: Workspace;
    executorMode: string;
  }): Record<string, unknown> {
    const checkpoint = this.latestCheckpointContext(args.taskId);
    return {
      exit_code: args.result.diagnostics?.exitCode ?? null,
      stderr_excerpt: (args.result.diagnostics?.stderrExcerpt ?? "").trim(),
      stdout_excerpt: (args.result.diagnostics?.stdoutExcerpt ?? "").trim(),
      command: args.result.diagnostics?.command ?? null,
      executor_mode: args.result.diagnostics?.executorMode ?? args.executorMode,
      workspace_id: args.workspace?.id ?? null,
      checkpoint_stage: checkpoint.checkpoint_stage,
      checkpoint_id: checkpoint.checkpoint_id
    };
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

    const exitCode =
      typeof payload.exit_code === "number" && Number.isFinite(payload.exit_code)
        ? payload.exit_code
        : null;
    const stderrExcerpt = typeof payload.stderr_excerpt === "string" ? payload.stderr_excerpt : "";
    const stdoutExcerpt = typeof payload.stdout_excerpt === "string" ? payload.stdout_excerpt : "";
    const command = typeof payload.command === "string" ? payload.command : null;
    const executorMode = typeof payload.executor_mode === "string" ? payload.executor_mode : null;
    const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id : null;
    const checkpointStage = typeof payload.checkpoint_stage === "string" ? payload.checkpoint_stage : null;
    const checkpointId = typeof payload.checkpoint_id === "string" ? payload.checkpoint_id : null;

    return {
      ...payload,
      exit_code: exitCode,
      stderr_excerpt: stderrExcerpt,
      stdout_excerpt: stdoutExcerpt,
      command,
      executor_mode: executorMode,
      workspace_id: workspaceId,
      checkpoint_stage: checkpointStage,
      checkpoint_id: checkpointId,
      executor_used: executorUsed,
      persona_version_id: personaVersionId,
      skill_version_ids: skillVersionIds,
      tool_stats: normalizeToolStats(payload.tool_stats as ToolStats | Record<string, unknown> | null | undefined)
    };
  }

  private async selectPersonaForDispatch(
    agentType: AgentType,
    taskContext: { description: string; tier: Tier; projectId: string }
  ): Promise<{ selection: SelectionResult; content: string; specialty: string | null; baselineVariantId: string | null }> {
    let population = this.deps.db.loadDispatchPopulation(agentType);
    if (population.length === 0) {
      this.personas.snapshotId(agentType);
      population = this.deps.db.loadDispatchPopulation(agentType);
    }
    this.personas.ensureDispatchBaseline(agentType);
    population = this.deps.db.loadDispatchPopulation(agentType);

    const selection = await this.dispatcher.selectVariant(agentType, taskContext);
    const selected = population.find((variant) => variant.id === selection.variantId) ?? null;
    const baseline = population.find((variant) => variant.status === "baseline") ?? null;
    return {
      selection,
      content: this.personas.resolveVariant(selection.variantId, agentType),
      specialty: selected?.specialty ?? null,
      baselineVariantId: baseline?.id ?? null
    };
  }

  private emitVariantSelected(input: {
    taskId: string;
    projectId: string;
    agentType: AgentType;
    selection: SelectionResult;
    selectedVariantSpecialty: string | null;
    budgetSeconds: number;
    injectedLessonIds?: string[];
  }): void {
    this.recordEvent({
      taskId: input.taskId,
      projectId: input.projectId,
      agent: "orchestrator",
      type: "variant_selected",
      status: "done",
      payload: {
        agent_type: input.agentType,
        selected_variant_id: input.selection.variantId,
        selected_variant_specialty: input.selectedVariantSpecialty,
        eligible_variant_ids: input.selection.eligibleVariantIds,
        selection_rationale: input.selection.rationale,
        shadow_variant_ids: input.selection.shadowVariantIds,
        injected_lesson_ids: input.injectedLessonIds ?? []
      },
      budgetSeconds: input.budgetSeconds
    });
  }

  private async runShadowDispatchesSafely(input: {
    taskId: string;
    projectId: string;
    agentType: AgentType;
    selection: SelectionResult;
    liveTask: AgentTask;
    liveResult: AgentResult;
    baselineExecutorUsed: string | null;
    baselineLessonIds: string[];
    baselineVariantId: string | null;
    loadCandidateLessons: (candidateVariantId: string) => Promise<{ ids: string[]; block: string }>;
    subtaskId?: string;
    iteration?: number;
  }): Promise<void> {
    try {
      await runShadowDispatches({
        ...input,
        runner: this.deps.shadowRunner,
        recordEvent: (event) => this.recordEvent(event)
      });
    } catch (err) {
      console.warn(`[shadow] dispatch recording failed for task=${input.taskId} agent=${input.agentType}: ${(err as Error).message ?? err}`);
    }
  }

  /**
   * Retrieve lineage lessons for a dispatch and render them into a system-prompt
   * block (Spec B §5). Returns both the pre-rendered block (for AgentTask.lessons)
   * and the selected ids (for `variant_selected.injected_lesson_ids`). Retrieval
   * failures degrade to an empty injection — per spec, a transient DB or retrieval
   * fault must never abort a dispatch.
   */
  private async loadLessonsForDispatch(
    variantId: string,
    agentType: AgentType,
    taskDescription: string
  ): Promise<{ block: string; ids: string[] }> {
    try {
      const { retrieval } = REFLECTION_CONFIG;
      const lessons = await retrieveLessonsForDispatch(
        this.deps.db,
        variantId,
        agentType,
        taskDescription,
        retrieval.maxLessons,
        retrieval.maxTokens
      );
      if (lessons.length === 0) return { block: "", ids: [] };
      const parts: string[] = ["# Lessons from past tasks in this lineage", ""];
      for (const l of lessons) {
        parts.push(`## Lesson ${l.id} (${l.outcome_kind})`);
        parts.push(`TRIGGER: ${l.trigger_pattern}`);
        parts.push(l.body);
        parts.push("");
      }
      return { block: parts.join("\n").trimEnd(), ids: lessons.map((l) => l.id) };
    } catch (err) {
      console.warn(
        `[lessons] retrieval failed for variant=${variantId} agent=${agentType}: ${(err as Error).message ?? err}`
      );
      return { block: "", ids: [] };
    }
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
    analyticsOnly?: boolean;
  }): void {
    const provenance: Record<string, unknown> = {};
    if (input.personaVersionId) provenance.persona_version_id = input.personaVersionId;
    if (input.skillVersionIds?.length) provenance.skill_version_ids = input.skillVersionIds;
    if (input.analyticsOnly) provenance.__analytics_only = true;

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
      if (!input.analyticsOnly) {
        this.deps.db.applyEvent(message);
      }
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
   * Route all real dispatches through the single configured executor.
   * Tier/agent type still affect budget, model, and prompt policy upstream.
   */
  private routeExecutor(tier: Tier, agentType: AgentType): AgentExecutor {
    void tier;
    void agentType;
    return this.deps.executor;
  }

  private recordCheckpoint(input: {
    taskId: string;
    projectId: string;
    iteration: number;
    stage: TaskCheckpointStage;
    worktreePath: string;
    label: string;
    planningPhase?: "spec" | "execution_plan" | "combined" | null;
  }): void {
    const gitSha = this.deps.worktrees.currentHead(input.worktreePath);
    if (!gitSha) return;
    const payload: Record<string, unknown> = {
      checkpoint_id: randomUUID(),
      task_id: input.taskId,
      iteration: input.iteration,
      stage: input.stage,
      git_sha: gitSha,
      label: input.label
    };
    if (input.planningPhase !== undefined) {
      payload.planning_phase = input.planningPhase;
    }
    this.recordEvent({
      taskId: input.taskId,
      projectId: input.projectId,
      agent: "orchestrator",
      type: "checkpoint_created",
      status: "done",
      payload,
      budgetSeconds: 60
    });
  }

  private steeringForDispatch(taskId: string): { prompt: string; eventIds: string[] } {
    const pending = collectPendingSteering(this.deps.db.listEvents(taskId));
    return {
      prompt: renderSteeringPrompt(pending),
      eventIds: pending.map((message) => message.eventId)
    };
  }

  // Call AFTER `executor.execute(...)` resolves. If execute throws (synchronous
  // dispatch error), the steering remains pending and will be re-injected on
  // the next attempt instead of being silently marked consumed.
  private recordSteeringConsumed(input: {
    taskId: string;
    projectId: string;
    steeringEventIds: string[];
    agentType: AgentType;
    iteration: number;
    personaVariantId: string;
  }): void {
    if (input.steeringEventIds.length === 0) return;
    if (!["planner", "coder", "reviewer", "doc"].includes(input.agentType)) return;
    this.recordEvent({
      taskId: input.taskId,
      projectId: input.projectId,
      agent: "orchestrator",
      type: "steering_consumed",
      status: "done",
      payload: {
        steering_event_ids: input.steeringEventIds,
        agent_type: input.agentType,
        iteration: input.iteration,
        persona_variant_id: input.personaVariantId
      },
      budgetSeconds: 60
    });
  }

  private async runLifecyclePhase(input: {
    taskId: string;
    projectId: string;
    fromStage: TaskStage;
    phase: LifecycleHookPhase;
    worktreePath: string;
    iteration: number;
  }): Promise<void> {
    if (this.deps.env.NODE_ENV === "test" && this.deps.env.AUTOFORGE_ENABLE_TEST_HOOKS !== "1") {
      return;
    }
    const runHooks = this.deps.lifecycleHookRunner ?? runLifecycleHooks;
    const hookResults = runHooks({
      phase: input.phase,
      workingDirectory: input.worktreePath,
      timeoutSeconds: this.deps.env.AUTOFORGE_HOOK_TIMEOUT_SECONDS
    });
    for (const run of hookResults.runs) {
      this.recordLifecycleHookEvent(input, run);
      if (run.result === "failed") {
        this.pauseForIntervention({
          taskId: input.taskId,
          projectId: input.projectId,
          fromStage: input.fromStage,
          failureCategory: "lifecycle_hook_failed",
          failureReason: `Lifecycle hook failed (${run.phase}${run.script ? `:${run.script}` : ""})`,
          forensics: this.lifecycleHookForensics(input.iteration, run)
        });
      }
    }
  }

  private recordLifecycleHookEvent(
    context: {
      taskId: string;
      projectId: string;
      iteration: number;
    },
    run: LifecycleHookRun
  ): void {
    const payload = this.lifecycleHookForensics(context.iteration, run);

    if (run.result === "failed") {
      this.recordEvent({
        taskId: context.taskId,
        projectId: context.projectId,
        agent: "orchestrator",
        type: "lifecycle_hook_failed",
        status: "failed",
        payload,
        budgetSeconds: 60
      });
      return;
    }

    this.recordEvent({
      taskId: context.taskId,
      projectId: context.projectId,
      agent: "orchestrator",
      type: "lifecycle_hook_completed",
      status: run.skipped ? "done_with_concerns" : "done",
      payload,
      budgetSeconds: 60
    });
  }

  private lifecycleHookForensics(iteration: number, run: LifecycleHookRun): Record<string, unknown> {
    return {
      phase: run.phase,
      script: run.script,
      command: run.command,
      skipped: run.skipped,
      skip_reason: run.skipReason,
      result: run.result,
      failure_reason: run.failureReason,
      exit_code: run.exitCode,
      timed_out: run.timedOut,
      elapsed_seconds: run.elapsedSeconds,
      stdout_excerpt: run.stdoutExcerpt,
      stderr_excerpt: run.stderrExcerpt,
      log_path: run.logPath,
      changed_file_count: run.changedFileCount,
      lines_added: run.linesAdded,
      lines_deleted: run.linesDeleted,
      committed: run.committed,
      commit_sha: run.commitSha,
      iteration
    };
  }

  private cleanupWorktree(taskId: string): void {
    const task = this.deps.db.getTask(taskId);
    if (task) {
      this.emitPendingWorkspaceDestroyed(task.id, task.projectId, "terminal_task");
    }
    const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
    if (worktreePath) {
      const branch = `autoforge/${taskId}`;
      this.deps.worktrees.remove({ branch, path: worktreePath });
    }
    this.cleanupIterationTags(taskId);
  }

  private emitPendingWorkspaceDestroyed(taskId: string, projectId: string, reason: string): void {
    const events = this.deps.db.listEvents(taskId);
    for (const payload of pendingWorkspaceDestroyPayloads(events, reason)) {
      this.recordEvent({
        taskId,
        projectId,
        agent: "orchestrator",
        type: "workspace_destroyed",
        status: "done",
        payload,
        budgetSeconds: 0
      });
    }
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

function normalizeArtifactPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  return normalized;
}
