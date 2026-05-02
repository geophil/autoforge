import type { DbClient } from "../db/client";
import type { AgentExecutor } from "../executors/interface";
import type { PersonaRegistry } from "../personas/registry";
import type { SkillRegistry } from "../skills/registry";
import type { AgentType, PipelineTask } from "../types/core";
import type { AgentTranscriptRow } from "../types/transcripts";
import { REFLECTION_CONFIG } from "../config/reflection";

/**
 * Whitelist of agent types the reflector is allowed to emit lessons for.
 * Per `src/personas/reflector.md`, meta / doc / reflector are out of scope.
 * Anything else is rejected BEFORE calling `snapshotId` so a rogue reflector
 * cannot silently create `persona:<arbitrary>` rows via the generic fallback
 * in `PersonaRegistry.resolve`.
 */
const ALLOWED_LESSON_AGENT_TYPES: ReadonlySet<string> = new Set([
  "planner",
  "coder",
  "reviewer"
]);

/**
 * Structured event the reflection module asks the orchestrator to record.
 * `agent` is string-typed here so the module doesn't depend on the NATS
 * message union; the service boundary narrows it back to AutoforgeMessage's
 * agent type.
 */
export interface ReflectionDeps {
  db: DbClient;
  executor: AgentExecutor;
  personas: PersonaRegistry;
  skills: SkillRegistry;
  workingDirectory: string;
  recordEvent: (e: {
    taskId: string;
    projectId: string;
    type: string;
    agent: string;
    status: string;
    payload: Record<string, unknown>;
    budgetSeconds: number;
  }) => void;
}

export interface ReflectorOutput {
  lesson?:
    | {
        skip: false;
        agent_type: string;
        trigger_pattern: string;
        body: string;
        outcome_kind: "corrective" | "reinforcing";
        failure_category?: string | null;
        finding_categories?: string[] | null;
        keywords?: string | null;
      }
    | { skip: true; reason: string };
}

export interface ReflectionResult {
  lessonId: string | null;
  skipped: boolean;
  reason?: string;
}

/**
 * Runs the reflector sub-agent synchronously for a terminal task.
 *
 * Invoked from `OrchestratorService` after every non-meta terminal
 * transition (completed / failed / cancelled / rejected / stalled), always
 * AFTER `captureTaskDiffStats` and BEFORE `cleanupWorktree`. Returns
 * `{ lessonId }` on success, `{ skipped: true, reason }` for policy-based
 * or parse-failure skips.
 *
 * Policies (Spec B §4.5):
 *   - failed + stalled + elapsed < threshold  -> skip, no learning signal
 *   - cancelled + cancel_reason="noise"       -> skip
 */
export async function reflectOnTask(
  taskId: string,
  deps: ReflectionDeps
): Promise<ReflectionResult> {
  const task = deps.db.getTask(taskId);
  if (!task) {
    return { lessonId: null, skipped: true, reason: "task_not_found" };
  }

  // Idempotency guard: `reflectOnTask` is public and called from six code
  // paths. If any reflector event already exists for this task, the earlier
  // invocation has already emitted its outcome — short-circuit without
  // dispatching the sub-agent again or emitting a new event.
  const alreadyReflected = deps.db.sqlite
    .query(
      `SELECT 1 FROM events
        WHERE task_id = ?
          AND event_type IN ('lesson_inserted', 'reflector_skipped', 'reflector_failed')
        LIMIT 1`
    )
    .get(taskId);
  if (alreadyReflected) {
    return { lessonId: null, skipped: true, reason: "already_reflected" };
  }

  const fa = latestFailureAnalysisForReflection(deps.db.listEvents(taskId));

  if (fa) {
    if (
      task.state === "failed" &&
      fa.failure_category === "stalled" &&
      typeof fa.elapsed_seconds === "number" &&
      fa.elapsed_seconds < REFLECTION_CONFIG.skipFailedStalledBelowSeconds
    ) {
      emitSkipped(deps, task, "task stalled under threshold — no learning signal");
      return { lessonId: null, skipped: true, reason: "stalled" };
    }
    if (fa.failure_category === "cancelled" && fa.cancel_reason === "noise") {
      emitSkipped(deps, task, "cancel reason=noise");
      return { lessonId: null, skipped: true, reason: "cancelled_noise" };
    }
  }

  const coderVariantId = deps.personas.snapshotId("coder");
  const lineageRootId = deps.db.resolveLineageRoot(coderVariantId) ?? coderVariantId;
  const activeLessons = deps.db.retrieveActiveLessonsByLineage(
    lineageRootId,
    "coder",
    REFLECTION_CONFIG.maxActiveLessonsForContext
  );

  const userPrompt = buildReflectorPrompt(task, deps, activeLessons, fa);

  // Snapshot the reflector persona so its provenance is captured just like
  // any other agent dispatch. We don't use the id directly (no transcript
  // row), but snapshotting ensures upsertPromptAsset flows are exercised.
  deps.personas.snapshotId("reflector");

  try {
    const result = await deps.executor.execute({
      id: `${taskId}-reflector`,
      type: "reflector",
      systemPrompt: deps.personas.resolve("reflector"),
      prompt: userPrompt,
      workingDirectory: deps.workingDirectory,
      budgetSeconds: REFLECTION_CONFIG.budgetSeconds,
      environment: {},
      skillFiles: deps.skills.skillsForAgent("reflector"),
      metadata: { taskId }
    });

    if (result.status !== "DONE" || !result.output) {
      emitSkipped(deps, task, `reflector_returned_${result.status}`);
      return { lessonId: null, skipped: true, reason: "non_done_status" };
    }

    const parsed = parseReflectorOutput(result.output);
    if (!parsed.ok) {
      emitFailed(deps, task, `parse_error:${parsed.error}`, {
        output_preview: String(JSON.stringify(result.output)).slice(0, 500)
      });
      return { lessonId: null, skipped: true, reason: "parse_error" };
    }

    const { lesson } = parsed;
    if (!lesson || lesson.skip === true) {
      const reason = (lesson && lesson.skip === true ? lesson.reason : "reflector declined") ?? "reflector declined";
      emitSkipped(deps, task, reason);
      return { lessonId: null, skipped: true, reason };
    }

    const wordCount = lesson.body.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > REFLECTION_CONFIG.maxLessonBodyWords) {
      emitFailed(deps, task, `body_over_word_limit:${wordCount}`);
      return { lessonId: null, skipped: true, reason: "body_over_limit" };
    }

    // Reject free-form agent_type BEFORE any DB write so a rogue reflector
    // can't create a `persona:<arbitrary>` row via PersonaRegistry's generic
    // fallback, and can't insert a lesson row pointing at an unknown agent.
    if (!ALLOWED_LESSON_AGENT_TYPES.has(lesson.agent_type)) {
      emitFailed(deps, task, `invalid_agent_type:${lesson.agent_type}`);
      return { lessonId: null, skipped: true, reason: "invalid_agent_type" };
    }

    const agentVariantId = deps.personas.snapshotId(lesson.agent_type as AgentType);
    const agentLineageRoot = deps.db.resolveLineageRoot(agentVariantId) ?? agentVariantId;

    const id = deps.db.insertLesson({
      agentType: lesson.agent_type,
      lineageRootId: agentLineageRoot,
      sourceTaskId: taskId,
      sourceVariantId: agentVariantId,
      triggerPattern: lesson.trigger_pattern,
      failureCategory: lesson.failure_category ?? null,
      findingCategories: lesson.finding_categories ?? null,
      body: lesson.body,
      outcomeKind: lesson.outcome_kind,
      retrievalKeywords: lesson.keywords ?? null
    });

    deps.recordEvent({
      taskId,
      projectId: task.projectId,
      type: "lesson_inserted",
      agent: "reflector",
      status: "done",
      payload: {
        lesson_id: id,
        agent_type: lesson.agent_type,
        outcome_kind: lesson.outcome_kind
      },
      budgetSeconds: REFLECTION_CONFIG.budgetSeconds
    });

    // Supersession side-effect (Spec B §6.4 — reflector-owned transition).
    // If the reflector emitted `supersedes: [<id>, ...]` at the top level of
    // its output (alongside `lesson`, NOT inside it), transition those
    // existing active lessons to status='superseded' with superseded_by
    // pointing at the new lesson. This is distinct from the curator meta's
    // `retire_lessons` operation, which marks lessons retired without a
    // replacement.
    const supersedesRaw = (result.output as Record<string, unknown>).supersedes;
    if (Array.isArray(supersedesRaw) && supersedesRaw.length > 0) {
      const idList = supersedesRaw.filter((x): x is string => typeof x === "string");
      if (idList.length > 0) {
        const supersession = deps.db.supersedeLessons(idList, id);
        if (supersession.transitioned.length > 0) {
          deps.recordEvent({
            taskId,
            projectId: task.projectId,
            type: "lessons_superseded",
            agent: "reflector",
            status: "done",
            payload: { new_lesson_id: id, superseded_ids: supersession.transitioned },
            budgetSeconds: REFLECTION_CONFIG.budgetSeconds
          });
        }
        if (supersession.rejected.length > 0) {
          deps.recordEvent({
            taskId,
            projectId: task.projectId,
            type: "lessons_supersession_rejected",
            agent: "reflector",
            status: "blocked",
            payload: {
              new_lesson_id: id,
              requested_ids: idList,
              rejected_ids: supersession.rejected
            },
            budgetSeconds: REFLECTION_CONFIG.budgetSeconds
          });
        }
      }
    }

    return { lessonId: id, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitFailed(deps, task, `exception:${message}`);
    return { lessonId: null, skipped: true, reason: "exception" };
  }
}

function buildReflectorPrompt(
  task: PipelineTask,
  deps: ReflectionDeps,
  activeLessons: unknown[],
  fa: Record<string, unknown> | null
): string {
  const transcripts = deps.db.listTranscriptsByTask(task.id);
  const fullTranscripts = transcripts
    .map((meta) => {
      const full = deps.db.getTranscript(meta.id);
      return full
        ? { stage: meta.stage, attempt: meta.attempt, text: transcriptToText(full) }
        : null;
    })
    .filter((t): t is { stage: string; attempt: number; text: string } => t !== null);
  const findings = deps.db.listFindings(task.id);
  const diffStats = deps.db.sqlite
    .query("SELECT * FROM task_diff_stats WHERE task_id = ?")
    .get(task.id);
  const iterDiffs = deps.db.sqlite
    .query(
      "SELECT * FROM task_iteration_diffs WHERE task_id = ? ORDER BY from_iteration ASC"
    )
    .all(task.id);

  const TRUNCATE = 8000;
  const truncate = (s: string): string =>
    s.length > TRUNCATE ? s.slice(0, TRUNCATE) + "\n…[truncated]" : s;

  return [
    `# Task ${task.id}`,
    `state: ${task.state}   tier: ${task.tier}   iteration: ${task.iteration}`,
    ``,
    `## Description`,
    task.description,
    ``,
    `## Transcripts`,
    ...fullTranscripts.map(
      (t) => `### ${t.stage} (attempt ${t.attempt})\n${truncate(t.text)}`
    ),
    ``,
    `## Findings`,
    findings.length === 0
      ? "(none)"
      : findings
          .map((f) => `- [${f.severity}] ${f.category}: ${f.description}`)
          .join("\n"),
    ``,
    `## Diff stats (cumulative)`,
    diffStats ? JSON.stringify(diffStats) : "(none captured)",
    ``,
    `## Iteration diffs`,
    iterDiffs.length === 0 ? "(none)" : JSON.stringify(iterDiffs, null, 2),
    ``,
    `## Failure analysis`,
    fa ? JSON.stringify(fa, null, 2) : "(task did not fail)",
    ``,
    `## Active lessons in this lineage (for self-suppression)`,
    activeLessons.length === 0
      ? "(none — any extracted lesson is novel)"
      : JSON.stringify(activeLessons, null, 2),
    ``,
    `Now decide whether a generalizable lesson applies. Write .autoforge-status.json per the persona contract.`
  ].join("\n");
}

interface ParseOk {
  ok: true;
  lesson: ReflectorOutput["lesson"];
}
interface ParseErr {
  ok: false;
  error: string;
}

function parseReflectorOutput(output: unknown): ParseOk | ParseErr {
  if (typeof output !== "object" || output === null) {
    return { ok: false, error: "output_not_object" };
  }
  const lesson = (output as Record<string, unknown>).lesson;
  if (!lesson || typeof lesson !== "object") {
    return { ok: false, error: "missing_lesson_key" };
  }
  const l = lesson as Record<string, unknown>;
  if (l.skip === true) {
    const reason = typeof l.reason === "string" ? l.reason : "unspecified";
    return { ok: true, lesson: { skip: true, reason } };
  }
  for (const field of ["agent_type", "trigger_pattern", "body", "outcome_kind"] as const) {
    if (typeof l[field] !== "string") {
      return { ok: false, error: `missing_or_nonstring_${field}` };
    }
  }
  if (l.outcome_kind !== "corrective" && l.outcome_kind !== "reinforcing") {
    return { ok: false, error: "invalid_outcome_kind" };
  }
  return { ok: true, lesson: l as ReflectorOutput["lesson"] };
}

function emitSkipped(deps: ReflectionDeps, task: PipelineTask, reason: string): void {
  deps.recordEvent({
    taskId: task.id,
    projectId: task.projectId,
    type: "reflector_skipped",
    agent: "reflector",
    status: "done",
    payload: { reason, task_state: task.state },
    budgetSeconds: REFLECTION_CONFIG.budgetSeconds
  });
}

function emitFailed(
  deps: ReflectionDeps,
  task: PipelineTask,
  reason: string,
  extra: Record<string, unknown> = {}
): void {
  deps.recordEvent({
    taskId: task.id,
    projectId: task.projectId,
    type: "reflector_failed",
    agent: "reflector",
    status: "failed",
    payload: { reason, task_state: task.state, ...extra },
    budgetSeconds: REFLECTION_CONFIG.budgetSeconds
  });
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function latestFailureAnalysisForReflection(
  events: Array<{ type: string; payload: Record<string, unknown> }>
): Record<string, unknown> | null {
  let latest: Record<string, unknown> | null = null;
  for (const event of events) {
    if (event.type === "rollback_applied") {
      // A rollback marks the prior failure trajectory as superseded; reflection
      // should focus on the post-rollback outcome instead of double-counting.
      latest = null;
      continue;
    }
    if (event.type === "failure_analysis") {
      latest = event.payload;
    }
  }
  return latest;
}

/**
 * Render an AgentTranscriptRow into a human-readable string suitable for
 * passing to the reflector. The `transcript` column is stored as JSONL —
 * one JSON-encoded AgentTranscriptTurn per line (see service.ts where it is
 * produced, and executors/interface.ts for the turn union). We expand each
 * turn into a small readable block, including the initial user prompt for
 * context. Overall truncation is applied by the caller.
 */
function transcriptToText(row: AgentTranscriptRow): string {
  const parts: string[] = [];
  if (row.userPrompt) {
    parts.push(`[user]\n${row.userPrompt}`);
  }
  const lines = row.transcript ? row.transcript.split("\n").filter((l) => l.length > 0) : [];
  for (const line of lines) {
    const turn = safeJsonParse(line) as Record<string, unknown> | null;
    if (!turn || typeof turn.kind !== "string") continue;
    switch (turn.kind) {
      case "assistant": {
        const content = Array.isArray(turn.content) ? turn.content : [];
        const rendered: string[] = [];
        for (const block of content as Array<Record<string, unknown>>) {
          if (block && typeof block === "object") {
            if (block.type === "text" && typeof block.text === "string") {
              rendered.push(block.text);
            } else if (block.type === "tool_use") {
              const name = typeof block.name === "string" ? block.name : "?";
              const input = block.input ? JSON.stringify(block.input) : "";
              rendered.push(`[tool_use ${name}${input ? ` ${input}` : ""}]`);
            }
          }
        }
        if (rendered.length > 0) parts.push(`[assistant]\n${rendered.join("\n")}`);
        break;
      }
      case "tool_result": {
        const content = typeof turn.content === "string" ? turn.content : "";
        parts.push(`[tool_result]\n${content}`);
        break;
      }
      case "compaction": {
        parts.push(`[compaction dropped=${turn.droppedTurns ?? "?"}]`);
        break;
      }
      case "error": {
        const name = typeof turn.name === "string" ? turn.name : "Error";
        const message = typeof turn.message === "string" ? turn.message : "";
        parts.push(`[error ${name}]\n${message}`);
        break;
      }
    }
  }
  if (row.output) {
    parts.push(`[output]\n${row.output}`);
  }
  return parts.join("\n\n");
}
