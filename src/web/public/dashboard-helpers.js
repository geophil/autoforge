(() => {
const { toObject, toArray, oneLine, asNumber } =
  typeof window !== "undefined" && window.UiHelpers
    ? window.UiHelpers
    : (typeof UiHelpers !== "undefined" ? UiHelpers : {});

function latestEvent(events, predicate) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (predicate(events[i])) return events[i];
  }
  return null;
}

// Fallback pricing is intentionally isolated here. Persisted event cost wins.
const FALLBACK_INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const FALLBACK_OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

function eventEstimatedCost(ev) {
  const direct = asNumber(ev?.estimatedCost);
  if (direct !== null) return direct;
  const payloadCost = asNumber(ev?.payload?.estimatedCost ?? ev?.payload?.estimated_cost);
  if (payloadCost !== null) return payloadCost;
  const tuCost = asNumber(ev?.tokenUsage?.estimatedCost ?? ev?.tokenUsage?.estimated_cost);
  if (tuCost !== null) return tuCost;
  return null;
}

function summarizeTokenUsage(events) {
  let inputTokens = 0;
  let outputTokens = 0;
  let persistedCostUsd = 0;
  let hasPersistedCost = false;

  for (const ev of events) {
    if (ev?.tokenUsage) {
      inputTokens += Number(ev.tokenUsage.input ?? 0);
      outputTokens += Number(ev.tokenUsage.output ?? 0);
    }
    const cost = eventEstimatedCost(ev);
    if (cost !== null) {
      persistedCostUsd += cost;
      hasPersistedCost = true;
    }
  }

  const fallbackCostUsd =
    inputTokens * FALLBACK_INPUT_COST_PER_TOKEN +
    outputTokens * FALLBACK_OUTPUT_COST_PER_TOKEN;

  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: hasPersistedCost ? persistedCostUsd : fallbackCostUsd,
    costSource: hasPersistedCost ? "persisted" : "fallback_estimate"
  };
}

function eventTimelineSummary(ev) {
  const payload = toObject(ev?.payload);
  const type = String(ev?.type ?? "");
  const agent = String(ev?.agent ?? "");
  const details = [];
  let group = agent || "orchestrator";
  let label = type.replace(/_/g, " ");

  if (type.startsWith("state.")) {
    group = "stage";
    label = `Stage: ${type.slice("state.".length).replace(/_/g, " ")}`;
  } else if (type === "variant_selected") {
    group = "dispatch";
    label = `Variant selected: ${payload.agent_type ?? agent ?? "agent"}`;
    if (payload.variant_id) details.push(`variant ${payload.variant_id}`);
    if (payload.persona_version_id) details.push(`persona ${payload.persona_version_id}`);
    const skillIds = toArray(payload.skill_version_ids);
    if (skillIds.length) details.push(`${skillIds.length} skill${skillIds.length === 1 ? "" : "s"}`);
    const lessonIds = toArray(payload.injected_lesson_ids);
    if (lessonIds.length) details.push(`${lessonIds.length} lesson${lessonIds.length === 1 ? "" : "s"}`);
  } else if (type === "execution_contract") {
    group = "planning";
    label = payload.valid === false ? "Execution contract incomplete" : "Execution contract ready";
    const invalid = toArray(payload.invalidSubtasks);
    if (invalid.length) details.push(`${invalid.length} invalid subtask${invalid.length === 1 ? "" : "s"}`);
  } else if (type === "test_results") {
    group = "verification";
    label = `Tests: ${payload.verificationStatus ?? "unknown"}`;
    if (payload.runner) details.push(`runner ${payload.runner}`);
    if (payload.passRate != null) details.push(`pass ${Number(payload.passRate).toFixed(2)}`);
  } else if (type === "task_exit_check") {
    group = "verification";
    label = ev.status === "done" ? "Task exit check passed" : "Task exit check has concerns";
    if (payload.verification_status) details.push(`verification ${payload.verification_status}`);
    if (payload.review_score != null) details.push(`review ${payload.review_score}`);
  } else if (type === "pre_review_checks") {
    group = "verification";
    label = payload.passed === false ? "Pre-review checks failed" : "Pre-review checks passed";
    if (payload.scope_check?.status) details.push(`scope ${payload.scope_check.status}`);
    if (payload.debug_code_scan?.status) details.push(`debug scan ${payload.debug_code_scan.status}`);
    const advisory = toArray(payload.debug_code_scan?.advisory_matches);
    if (advisory.length) details.push(`${advisory.length} advisory debug hint${advisory.length === 1 ? "" : "s"}`);
  } else if (type === "failure_analysis" && payload.failure_category === "pr_gate") {
    group = "intervention";
    label = "PR gate blocked";
    if (payload.failure_reason) details.push(String(payload.failure_reason));
  } else if (type === "failure_analysis") {
    group = "intervention";
    label = `Failure: ${payload.failure_category ?? "unknown"}`;
  } else if (type === "subtask_started") {
    group = "execution";
    label = `Subtask started${payload.subtaskId ? `: ${payload.subtaskId}` : ""}`;
  } else if (type === "subtask_done") {
    group = "execution";
    label = `Subtask done${payload.subtaskId ? `: ${payload.subtaskId}` : ""}`;
  } else if (type === "review_finding") {
    group = "review";
    label = `Review finding: ${payload.severity ?? payload.finding?.severity ?? "finding"}`;
  } else if (type === "review_done") {
    group = "review";
    label = "Review completed";
  }

  return { group, label, details: details.map(oneLine).filter(Boolean) };
}

function buildPrGateReport(task, events) {
  const taskObj = toObject(task);
  const rows = [];
  const exit = latestEvent(events, (ev) => ev.type === "task_exit_check");
  const tests = latestEvent(events, (ev) => ev.type === "test_results");
  const gateFailure = latestEvent(
    events,
    (ev) => ev.type === "failure_analysis" && ev.payload?.failure_category === "pr_gate"
  );

  const testPayload = toObject(tests?.payload);
  const exitPayload = toObject(exit?.payload);
  const failurePayload = toObject(gateFailure?.payload);
  const verificationStatus =
    exitPayload.verification_status ??
    testPayload.verificationStatus ??
    failurePayload.verification_status ??
    null;
  const passRate =
    exitPayload.test_pass_rate ??
    testPayload.passRate ??
    failurePayload.test_pass_rate ??
    null;
  const reviewScore = exitPayload.review_score ?? failurePayload.review_score ?? null;
  const unresolvedFindings =
    exitPayload.unresolved_findings ?? failurePayload.unresolved_findings ?? null;
  const artifactStatuses = toArray(exitPayload.artifact_validation_statuses);
  const runner = exitPayload.test_runner ?? testPayload.runner ?? null;

  if (!exit && !gateFailure && !tests) {
    return {
      state: "unavailable",
      title: "PR gate report unavailable",
      reason: "No test, gate, or task-exit events have been recorded yet.",
      rows: []
    };
  }

  const expressAllowsUnavailable =
    taskObj.tier === "EXPRESS" && verificationStatus === "unavailable";
  const blocked = Boolean(gateFailure);
  const state = blocked ? "blocked" : exit ? "ready" : expressAllowsUnavailable ? "allowed" : "pending";
  const title = blocked
    ? "PR gate blocked"
    : exit
      ? "PR gate ready"
      : expressAllowsUnavailable
        ? "Verification unavailable but allowed for EXPRESS"
        : "PR gate evidence";

  rows.push(["Verification", verificationStatus ?? "unknown"]);
  if (passRate != null) rows.push(["Pass rate", Number(passRate).toFixed(2)]);
  if (runner) rows.push(["Runner", runner]);
  if (reviewScore != null) rows.push(["Review score", String(reviewScore)]);
  if (unresolvedFindings != null) rows.push(["Unresolved findings", String(unresolvedFindings)]);
  if (artifactStatuses.length) rows.push(["Artifact validation", artifactStatuses.join(", ")]);
  if (taskObj.prUrl) rows.push(["PR", taskObj.prUrl]);
  if (blocked) rows.push(["Rejection reason", failurePayload.failure_reason ?? "PR gate rejected task"]);

  return {
    state,
    title,
    reason: blocked ? oneLine(failurePayload.failure_reason) : "",
    rows
  };
}

function interventionRecommendation(failureCategory, failureReason) {
  const category = oneLine(failureCategory) || "unknown";
  const reason = oneLine(failureReason);
  const base = {
    category,
    title: "Inspect transcript and retry from failed stage",
    body: reason || "Use the transcript and event log to decide whether to retry planning or execution.",
    primaryStage: null,
    secondaryStage: null,
    focus: "transcript"
  };

  const map = {
    planner_missing_qmd_context: {
      title: "Retry planning after checking QMD evidence",
      body: "Inspect the planner transcript and QMD evidence, then retry from planning.",
      primaryStage: "planning",
      focus: "qmd"
    },
    planner_contract_incomplete: {
      title: "Fix the execution contract through planning",
      body: "Use the plan contract warnings to steer or retry planning before execution resumes.",
      primaryStage: "planning",
      focus: "contract"
    },
    planner_prompt_budget_exceeded: {
      title: "Retry planning with narrower critique",
      body: "Reduce the retry objective or operator critique so the planner prompt stays under budget.",
      primaryStage: "planning",
      focus: "budget"
    },
    pr_gate: {
      title: "Inspect the PR gate report before retrying",
      body: "Use the readiness report to decide whether execution needs a retry or the plan needs revision.",
      primaryStage: "executing",
      secondaryStage: "planning",
      focus: "pr_gate"
    },
    lifecycle_hook_failed: {
      title: "Steer and retry execution after hook failure",
      body: "Inspect hook output, queue steering if needed, then retry execution.",
      primaryStage: "executing",
      focus: "hook"
    },
    pre_review_check_failed: {
      title: "Fix deterministic pre-review check failures",
      body: "Inspect the pre-review check payload, queue steering if needed, then retry execution before model review.",
      primaryStage: "executing",
      secondaryStage: "planning",
      focus: "pre_review_checks"
    },
    coder_failed: {
      title: "Retry execution, optionally from a checkpoint",
      body: "Use checkpoint rollback if the worktree should return to a known safe boundary.",
      primaryStage: "executing",
      secondaryStage: "planning",
      focus: "execution"
    },
    reviewer_failed: {
      title: "Retry execution or replan if findings imply scope drift",
      body: "Retry execution for transient reviewer/coder loops; replan if the contract is wrong.",
      primaryStage: "executing",
      secondaryStage: "planning",
      focus: "review"
    }
  };

  return { ...base, ...(map[category] ?? {}) };
}

function transcriptAttemptDiffs(transcripts) {
  const rows = toArray(transcripts)
    .filter((row) => row && typeof row === "object")
    .slice()
    .sort((a, b) => {
      const stageCmp = String(a.stage ?? "").localeCompare(String(b.stage ?? ""));
      if (stageCmp !== 0) return stageCmp;
      return Number(a.attempt ?? 0) - Number(b.attempt ?? 0);
    });

  const byStage = new Map();
  for (const row of rows) {
    const stage = String(row.stage ?? "unknown");
    if (!byStage.has(stage)) byStage.set(stage, []);
    byStage.get(stage).push(row);
  }

  const diffs = [];
  for (const [stage, stageRows] of byStage.entries()) {
    for (let i = 1; i < stageRows.length; i += 1) {
      const prev = stageRows[i - 1];
      const next = stageRows[i];
      const prevInput = Number(prev.tokenInput ?? 0);
      const nextInput = Number(next.tokenInput ?? 0);
      const prevOutput = Number(prev.tokenOutput ?? 0);
      const nextOutput = Number(next.tokenOutput ?? 0);
      const prevElapsed = asNumber(prev.elapsedSeconds);
      const nextElapsed = asNumber(next.elapsedSeconds);
      diffs.push({
        stage,
        fromAttempt: prev.attempt,
        toAttempt: next.attempt,
        tokenInputDelta: nextInput - prevInput,
        tokenOutputDelta: nextOutput - prevOutput,
        elapsedDelta: prevElapsed !== null && nextElapsed !== null ? nextElapsed - prevElapsed : null,
        promptChanged: String(prev.userPrompt ?? "") !== String(next.userPrompt ?? ""),
        systemPromptChanged: String(prev.systemPrompt ?? "") !== String(next.systemPrompt ?? ""),
        outputChanged: JSON.stringify(prev.output ?? null) !== JSON.stringify(next.output ?? null),
        critiqueChanged: String(prev.critique ?? "") !== String(next.critique ?? "")
      });
    }
  }
  return diffs;
}

const dashboardHelpersApi = {
  summarizeTokenUsage,
  eventTimelineSummary,
  buildPrGateReport,
  interventionRecommendation,
  transcriptAttemptDiffs
};

if (typeof window !== "undefined") {
  window.DashboardHelpers = dashboardHelpersApi;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = dashboardHelpersApi;
}
})();
