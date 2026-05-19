const API = "";

// --- State ---
let tasks = [];
let currentTaskId = null;
let plannerMaxIterations = 3;
let plannerSpecMaxIterations = 3;
let taskListTab = 'active'; // 'active' | 'archived'
let currentTask = null;
const pendingReviewSubmissions = new Map();

// --- DOM refs ---
const badge = document.getElementById("connection-badge");
const taskList = document.getElementById("task-list");
const detailContent = document.getElementById("task-detail-content");
const metricsGrid = document.getElementById("metrics-grid");

// --- Navigation ---
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

document.querySelectorAll(".tasks-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    taskListTab = btn.dataset.tab;
    document.querySelectorAll(".tasks-tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    refreshTasks();
  });
});

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  const view = document.getElementById(`view-${name}`);
  const btn = document.querySelector(`.nav-btn[data-view="${name}"]`);
  if (view) view.classList.add("active");
  if (btn) btn.classList.add("active");
}

document.getElementById("btn-back-to-tasks").addEventListener("click", () => {
  showView("tasks");
  currentTaskId = null;
});

// --- SSE ---
function connectSSE() {
  const es = new EventSource(`${API}/api/events`);

  // Flip the badge to "live" on any sign the stream is actually flowing:
  // - onopen fires when the HTTP connection is established.
  // - heartbeat fires every 15s from the server (primary liveness signal).
  // - task.updated arrives whenever a task event is published.
  // The legacy "connected" listener is kept for backwards compatibility with
  // any future server-sent hello event.
  const markLive = () => {
    badge.textContent = "live";
    badge.className = "connection-badge connected";
  };

  es.onopen = markLive;
  es.addEventListener("connected", markLive);
  es.addEventListener("heartbeat", markLive);

  es.addEventListener("task.updated", () => {
    markLive();
    refreshTasks();
    if (currentTaskId) refreshTaskDetail(currentTaskId);
  });

  es.addEventListener("task.deleted", () => {
    markLive();
    refreshTasks();
  });

  es.onerror = () => {
    badge.textContent = "disconnected";
    badge.className = "connection-badge disconnected";
  };
}

// --- Tasks ---
async function refreshTasks() {
  try {
    const url = taskListTab === 'archived'
      ? `${API}/api/tasks?archived=true`
      : `${API}/api/tasks`;
    const res = await fetch(url);
    tasks = await res.json();
    renderTaskList();
  } catch {
    taskList.innerHTML = `<div class="empty-state">Failed to load tasks.</div>`;
  }
}

// States that mean "server is actively doing something with this task right now"
const RUNNING_STATES = new Set([
  "assessing", "planning", "replanning", "executing", "reviewing", "reworking", "documenting"
]);

// States that display the Execution Progress header in the task detail view
const EXECUTION_STATES = new Set(["executing", "reviewing", "reworking", "documenting"]);

// Maximum rework iterations shown in the Execution Progress header
// (hardcoded rework cap; use server config if a dedicated setting is added later)
const REWORK_MAX = 3;

function renderTaskList() {
  if (tasks.length === 0) {
    const msg = taskListTab === 'archived'
      ? 'No archived tasks.'
      : 'No tasks yet. Submit one to get started.';
    taskList.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  // Update the global "N running" header badge
  const runningCount = tasks.filter((t) => RUNNING_STATES.has(t.state)).length;
  const runningBadge = document.getElementById("running-badge");
  const runningCountEl = document.getElementById("running-count");
  if (runningBadge && runningCountEl) {
    runningCountEl.textContent = String(runningCount);
    runningBadge.hidden = runningCount === 0;
  }

  const isArchivedView = taskListTab === 'archived';

  taskList.innerHTML = tasks
    .map(
      (t) => {
        const isRunning = RUNNING_STATES.has(t.state);
        const actionBtns = isArchivedView
          ? `<button class="task-card-action-btn" title="Restore task" onclick="unarchiveTask('${t.id}', event)">↩</button>
             <button class="task-card-action-btn task-card-delete-btn" title="Delete permanently" onclick="deleteTask('${t.id}', event)">⊗</button>`
          : `<button class="task-card-action-btn" title="Archive task" onclick="archiveTask('${t.id}', event)">⊡</button>`;
        return `
    <div class="task-card ${isRunning ? "running-pulse" : ""}" data-id="${t.id}">
      <div class="task-card-body">
        <div class="task-card-description">${esc(t.description)}</div>
        <div class="task-card-meta">
          <code>${t.id.slice(0, 8)}</code>
          <span>${timeAgo(t.createdAt)}</span>
          ${t.iteration > 0 ? `<span>iteration ${t.iteration}</span>` : ""}
          ${t.state === "awaiting_spec_approval" ? `<span class="card-pill card-pill-spec">spec review</span>` : ""}
          ${t.state === "awaiting_plan_approval" || t.state === "replanning" ? `<span class="card-pill card-pill-plan">plan review</span>` : ""}
          ${t.state === "awaiting_approval" ? `<span class="card-pill card-pill-pr">awaiting merge</span>` : ""}
        </div>
      </div>
      <div class="task-card-right">
        <span class="badge badge-tier">${t.tier}</span>
        <span class="badge badge-state" data-state="${t.state}">${formatState(t.state)}</span>
        ${actionBtns}
      </div>
    </div>`;
      }
    )
    .join("");

  taskList.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", () => {
      currentTaskId = card.dataset.id;
      refreshTaskDetail(currentTaskId);
      showView("task-detail");
    });
  });
}

// --- Task Detail ---
async function refreshTaskDetail(taskId) {
  try {
    const [taskRes, transcriptsRes, eventsRes] = await Promise.all([
      fetch(`${API}/api/tasks/${taskId}`),
      fetch(`${API}/api/transcripts/by-task/${taskId}`),
      fetch(`${API}/api/tasks/${taskId}/events`)
    ]);
    if (!taskRes.ok) {
      detailContent.innerHTML = `<div class="empty-state">Task not found.</div>`;
      return;
    }
    const task = await taskRes.json();
    const transcripts = transcriptsRes.ok ? await transcriptsRes.json() : [];
    const specTranscripts = transcripts.filter((row) => row.stage === "planner:spec");
    const planTranscripts = transcripts.filter((row) => row.stage === "planner:execution_plan");
    task.specTranscripts = specTranscripts;
    task.planTranscripts = planTranscripts;
    task.transcripts = transcripts;
    task.specAttempt =
      specTranscripts.length === 0 ? 0 : Math.max(...specTranscripts.map((row) => row.attempt));
    task.planAttempt =
      planTranscripts.length === 0 ? 0 : Math.max(...planTranscripts.map((row) => row.attempt));
    // Surface the most recent failure_analysis so the intervention card can
    // render forensics without a second round trip.
    if (eventsRes.ok) {
      const allEvents = await eventsRes.json();
      const checkpoints = [];
      for (let i = allEvents.length - 1; i >= 0; i--) {
        if (allEvents[i].type === "failure_analysis") {
          task.latestFailureAnalysis = allEvents[i];
          break;
        }
      }
      for (const event of allEvents) {
        if (event.type === "checkpoint_created") {
          checkpoints.push(event);
        }
      }
      task.checkpoints = checkpoints
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
        .slice(0, 10);
      task.pendingSteering = collectPendingSteeringEvents(allEvents);
      // Stash raw events so renderTaskDetail can pass them to loadEvents,
      // avoiding a duplicate fetch and the brief "pending" flicker on re-renders.
      task.preloadedEvents = allEvents;
    }
    reconcilePendingReviewSubmissions(task);
    renderTaskDetail(task);
  } catch {
    detailContent.innerHTML = `<div class="empty-state">Failed to load task.</div>`;
  }
}

function collectPendingSteeringEvents(events) {
  const consumed = new Set();
  for (const event of events) {
    if (event.type !== "steering_consumed") continue;
    const ids = event.payload?.steering_event_ids;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string") consumed.add(id);
      }
    }
  }

  return events
    .filter((event) => event.type === "steering_message")
    .filter((event) => !consumed.has(event.id))
    .map((event) => ({
      id: event.id,
      timestamp: event.timestamp,
      message: event.payload?.message || "",
      author: event.payload?.author || "operator"
    }));
}

function reviewSubmissionKey(taskId, phase) {
  return `${taskId}:${phase}`;
}

function getPendingReviewSubmission(taskId, phase) {
  return pendingReviewSubmissions.get(reviewSubmissionKey(taskId, phase)) ?? null;
}

function setPendingReviewSubmission(taskId, phase, payload) {
  pendingReviewSubmissions.set(reviewSubmissionKey(taskId, phase), payload);
}

function clearPendingReviewSubmission(taskId, phase) {
  pendingReviewSubmissions.delete(reviewSubmissionKey(taskId, phase));
}

function reconcilePendingReviewSubmissions(task) {
  const spec = getPendingReviewSubmission(task.id, "spec");
  if (spec) {
    if (task.state !== "awaiting_spec_approval" || (task.specAttempt ?? 0) !== spec.attempt) {
      clearPendingReviewSubmission(task.id, "spec");
    }
  }
  const plan = getPendingReviewSubmission(task.id, "plan");
  if (plan) {
    if (task.state !== "awaiting_plan_approval" || (task.planAttempt ?? 0) !== plan.attempt) {
      clearPendingReviewSubmission(task.id, "plan");
    }
  }
}

function renderTaskDetail(task) {
  currentTask = task;
  const assessment = task.assessment || {};
  const subtasks = task.planSubtasks || [];
  const detailEvents = normalizeEventPayloads(task.preloadedEvents ?? []);

  const terminalStates = ["completed", "failed"];
  const nonTerminalStates = [
    "received",
    "assessing",
    "planning",
    "awaiting_spec_approval",
    "awaiting_plan_approval",
    "replanning",
    "executing",
    "reviewing",
    "reworking",
    "pr_created",
    "awaiting_approval",
    "documenting",
    "awaiting_intervention"
  ];
  let actionsHtml = "";
  const pendingSteering = Array.isArray(task.pendingSteering) ? task.pendingSteering : [];
  const pendingSteeringHtml = pendingSteering.length > 0
    ? `<div class="forensic-row"><span class="forensic-label">Pending steering</span>
        <span class="forensic-value">${pendingSteering.map((item) =>
          `<div style="margin-bottom:0.35rem;"><code>${esc(item.author || "operator")}</code> · ${esc(timeAgo(item.timestamp))}<br>${esc(item.message)}</div>`
        ).join("")}</span></div>`
    : `<div class="forensic-row"><span class="forensic-label">Pending steering</span><span class="forensic-value">none</span></div>`;
  const steeringComposer = `
    <div class="intervention-rollback">
      <label for="steering-input" class="forensic-label">Steer next attempt</label>
      <textarea id="steering-input" class="critique-input" rows="2" maxlength="4000"
        placeholder="Guidance for the next agent attempt (not the currently running process)."></textarea>
      ${pendingSteeringHtml}
      <div style="margin-top:0.5rem;">
        <button class="btn btn-secondary" onclick="submitSteering('${task.id}', this)">Queue Steering</button>
      </div>
    </div>
  `;

  if (task.state === "awaiting_intervention") {
    const fa = task.latestFailureAnalysis?.payload ?? {};
    const stageFailed = fa.stage_failed ?? "unknown";
    const category = fa.failure_category ?? "unknown";
    const reason = fa.failure_reason ?? "Unknown failure";
    const executorUsed = fa.executor_used ?? "unknown";
    const model = fa.model ? `<div class="forensic-row"><span class="forensic-label">Model</span><span class="forensic-value">${esc(fa.model)}</span></div>` : "";
    const elapsed = fa.elapsed_seconds != null ? `${Number(fa.elapsed_seconds).toFixed(1)}s` : "—";
    const budget = fa.budget_seconds != null ? `${fa.budget_seconds}s` : "—";
    const tokens = fa.token_input != null ? `${fa.token_input} in / ${fa.token_output ?? 0} out` : "—";
    const transcriptLink = fa.transcript_id
      ? `<div class="forensic-row"><span class="forensic-label">Transcript</span><span class="forensic-value"><a href="#" onclick="openTranscript('${esc(fa.transcript_id)}'); return false;">View full transcript →</a></span></div>`
      : "";
    const toolStats = fa.tool_stats
      ? `<div class="forensic-row"><span class="forensic-label">Tool stats</span><span class="forensic-value"><code>${esc(JSON.stringify(fa.tool_stats))}</code></span></div>`
      : "";
    const recommendation = getInterventionRecommendation(category, reason);
    const recommendationHtml = renderInterventionRecommendation(recommendation);

    // Retry target: if planner failed, retrying "the failed stage" re-runs
    // planning. If coder failed, the operator can either re-run the coder
    // with the current plan, or go back and re-plan from scratch.
    const canRetryFromPlanning = stageFailed === "planning" || stageFailed === "replanning" || stageFailed === "executing" || stageFailed === "reviewing";
    const canRetryFromExecuting = stageFailed === "executing" || stageFailed === "reviewing";
    const checkpoints = Array.isArray(task.checkpoints) ? task.checkpoints : [];
    const checkpointOptions = checkpoints.length
      ? checkpoints.map((checkpoint) => {
        const cp = checkpoint.payload || {};
        const label = cp.label ?? "checkpoint";
        const stage = cp.stage ?? "unknown";
        const iterationLabel = cp.iteration != null ? `iter ${cp.iteration}` : "iter ?";
        const shortSha = typeof cp.git_sha === "string" ? cp.git_sha.slice(0, 10) : "sha?";
        return `<option value="${esc(cp.checkpoint_id)}">${esc(iterationLabel)} · ${esc(stage)} · ${esc(label)} · ${esc(shortSha)}</option>`;
      }).join("")
      : "";
    const retryButtons = [];
    if (canRetryFromPlanning) {
      retryButtons.push(`<button class="btn btn-approve" onclick="retryTask('${task.id}', 'planning', this)">Retry from Planning</button>`);
    }
    if (canRetryFromExecuting) {
      retryButtons.push(`<button class="btn btn-secondary" onclick="retryTask('${task.id}', 'executing', this)">Retry from Execution</button>`);
    }

    actionsHtml = `
      <div class="task-detail-actions intervention">
        <div class="intervention-header">
          <h3 class="intervention-title">⚠ Paused for Intervention</h3>
          <span class="badge badge-state" data-state="failed">${esc(category)}</span>
        </div>
        <div class="intervention-reason">${esc(reason)}</div>
        <div class="intervention-forensics">
          <div class="forensic-row"><span class="forensic-label">Failed stage</span><span class="forensic-value"><code>${esc(stageFailed)}</code></span></div>
          <div class="forensic-row"><span class="forensic-label">Executor</span><span class="forensic-value">${esc(executorUsed)}</span></div>
          ${model}
          <div class="forensic-row"><span class="forensic-label">Elapsed / budget</span><span class="forensic-value">${esc(elapsed)} / ${esc(budget)}</span></div>
          <div class="forensic-row"><span class="forensic-label">Tokens</span><span class="forensic-value">${esc(tokens)}</span></div>
          ${toolStats}
          ${transcriptLink}
        </div>
        ${recommendationHtml}
        <div class="intervention-rollback">
          <label for="retry-checkpoint-id" class="forensic-label">Rollback checkpoint (optional)</label>
          ${checkpoints.length > 0
            ? `<select id="retry-checkpoint-id" class="critique-input" style="min-height: 40px;">
                <option value="">No rollback (use current worktree state)</option>
                ${checkpointOptions}
              </select>`
            : `<div class="forensic-value" style="margin-bottom: 0.5rem;">No checkpoints available yet.</div>`}
          <textarea id="retry-operator-note" class="critique-input" rows="2" maxlength="4000"
            placeholder="Optional operator note (saved on rollback/retry events)"></textarea>
        </div>
        ${steeringComposer}
        <div class="intervention-buttons">
          ${retryButtons.join("")}
          <button class="btn btn-ghost btn-sm" onclick="cancelTask('${task.id}')" style="margin-left:auto">Cancel task</button>
        </div>
      </div>`;
  } else if (task.state === "awaiting_spec_approval") {
    const maxAttempts = plannerSpecMaxIterations + 1;
    const pendingSubmission = getPendingReviewSubmission(task.id, "spec");
    if (window.PlanningWizard?.renderSpecReviewPanel) {
      actionsHtml = window.PlanningWizard.renderSpecReviewPanel(task, {
        maxAttempts,
        pendingSubmission
      });
    } else {
      actionsHtml = `<div class="task-detail-actions"><span class="empty-state">Spec review UI module failed to load.</span></div>`;
    }
  } else if (task.state === "awaiting_plan_approval") {
    const maxAttempts = plannerMaxIterations + 1;
    const pendingSubmission = getPendingReviewSubmission(task.id, "plan");
    if (window.PlanningWizard?.renderPlanReviewPanel) {
      actionsHtml = window.PlanningWizard.renderPlanReviewPanel(task, {
        maxAttempts,
        pendingSubmission
      });
    } else {
      actionsHtml = `<div class="task-detail-actions"><span class="empty-state">Plan review UI module failed to load.</span></div>`;
    }
  } else if (task.state === "awaiting_approval") {
    actionsHtml = `
      <div class="task-detail-actions">
        <button class="btn btn-approve" onclick="approveTask('${task.id}', this)">Approve &amp; Merge</button>
        <button class="btn btn-reject" onclick="rejectTask('${task.id}')">Reject</button>
        <button class="btn btn-ghost btn-sm" onclick="cancelTask('${task.id}')" style="margin-left:auto">Cancel</button>
      </div>`;
  } else if (nonTerminalStates.includes(task.state)) {
    actionsHtml = `
      <div class="task-detail-actions">
        ${steeringComposer}
        <button class="btn btn-ghost btn-sm" onclick="cancelTask('${task.id}')">Cancel task</button>
      </div>`;
  }

  let prHtml = "";
  if (task.prUrl) {
    prHtml = `<a class="pr-link" href="${esc(task.prUrl)}" target="_blank">View Pull Request &rarr;</a>`;
  }

  const isRunning = RUNNING_STATES.has(task.state);
  const liveBanner = isRunning
    ? `<div class="live-state-banner">
         <span class="dot"></span>
         <span><strong>${formatState(task.state)}</strong> — the pipeline is actively working on this task right now. Updates stream in as they happen.</span>
       </div>`
    : "";

  detailContent.innerHTML = `
    <div class="task-detail-header">
      <h2>${esc(task.description)}</h2>
      <div class="meta-row">
        <span class="badge badge-state" data-state="${task.state}">${formatState(task.state)}</span>
        <span class="badge badge-tier">${task.tier}</span>
        <code style="font-size: 0.75rem; color: var(--text-dim);">${task.id}</code>
        ${prHtml}
      </div>
      ${liveBanner}
      ${actionsHtml}
    </div>

    <div class="detail-section">
      <h3>Complexity Assessment</h3>
      <div class="assessment-grid">
        <div class="assessment-item">
          <div class="assessment-label">Scope</div>
          <div class="assessment-value">${assessment.scope || "—"}</div>
        </div>
        <div class="assessment-item">
          <div class="assessment-label">Novelty</div>
          <div class="assessment-value">${assessment.novelty || "—"}</div>
        </div>
        <div class="assessment-item">
          <div class="assessment-label">Risk</div>
          <div class="assessment-value">${assessment.risk || "—"}</div>
        </div>
        <div class="assessment-item">
          <div class="assessment-label">Coupling</div>
          <div class="assessment-value">${assessment.coupling || "—"}</div>
        </div>
      </div>
      ${assessment.rationale ? `<p style="margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-muted);">${esc(assessment.rationale)}</p>` : ""}
    </div>

    ${EXECUTION_STATES.has(task.state) ? `
    <div class="detail-section exec-progress-section" id="exec-progress-header">
      ${renderExecProgressContent(task, [])}
    </div>` : ""}

    ${subtasks.length > 0 ? (() => {
      const subtaskCards = subtasks.map((s) => `
        <div class="subtask-item" data-subtask-id="${esc(s.id)}" data-subtask-status="pending">
          <div class="subtask-header">
            <span class="subtask-status-icon" aria-hidden="true"></span>
            <span class="subtask-seq">#${s.sequence}</span>
            <span class="subtask-agent">${esc(s.agentType ?? "coder")}</span>
            <span class="subtask-desc">${esc(s.description)}</span>
          </div>
          ${s.filesInScope?.length ? `<div class="subtask-files">files: ${s.filesInScope.join(", ")}</div>` : ""}
          ${s.testCriteria?.length ? `<div class="subtask-tests">
            <div class="subtask-tests-label">Test criteria:</div>
            <ul>${s.testCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
          </div>` : ""}
          <div class="subtask-runtime"></div>
          <div class="subtask-history-strip"></div>
          <div class="subtask-shadow-wrap"></div>
        </div>
      `).join("");
      const heading = `Plan (${subtasks.length} subtask${subtasks.length !== 1 ? "s" : ""})`;
      // When the markdown plan is shown above (awaiting_plan_approval state), collapse
      // the raw structured view to avoid duplication. Otherwise keep it expanded so the
      // live subtask-progress indicators remain visible during execution.
      if (task.state === "awaiting_plan_approval") {
        return `
    <div class="detail-section">
      <details class="raw-subtasks">
        <summary><h3 style="display:inline; margin:0;">${heading}</h3> <span class="raw-subtasks-hint">raw structured view</span></summary>
        ${subtaskCards}
      </details>
    </div>`;
      }
      return `
    <div class="detail-section">
      <h3>${heading}</h3>
      ${subtaskCards}
    </div>`;
    })() : ""}

    <div class="detail-section" id="findings-section">
      ${renderPrGateReport(task, detailEvents)}
      <div id="cost-summary" class="cost-summary"></div>
      <details class="event-log-details"${["completed", "failed", "awaiting_intervention"].includes(task.state) ? " open" : ""}>
        <summary class="event-log-summary">Event log (forensics)</summary>
        <input type="text" id="event-log-filter" class="event-log-filter" placeholder="Filter by type or agent…" autocomplete="off">
        <div id="findings-list"><span style="color: var(--text-dim); font-size: 0.85rem;">Loading...</span></div>
      </details>
    </div>
  `;

  wireCritiqueInput(task);
  wireSpecCritiqueInput(task);
  wireWizardPromptChips();
  loadEvents(task.id, task.preloadedEvents ?? null);
}

/**
 * Compute execution progress info from the event list for the current task.
 * Returns current iteration, how many subtasks are done in that iteration,
 * the active subtask object (if any), and elapsed seconds since it started.
 */
function computeExecProgressInfo(task, events) {
  const currentIteration = task.iteration ?? 1;
  const subtasks = task.planSubtasks || [];
  const totalSubtasks = subtasks.length;

  const hasStartedEvents = events.some(
    (ev) => ev.type === "subtask_started" && ev.payload?.iteration != null
  );

  let doneInCurrentIter = 0;
  let activeSubtask = null;
  let activeStartedEvent = null;

  if (hasStartedEvents) {
    const lastStartedIdx = {};
    const doneIndicesBySubtaskId = {};

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === "subtask_started" && ev.payload?.subtaskId) {
        if (ev.payload.iteration === currentIteration) {
          lastStartedIdx[ev.payload.subtaskId] = i;
        }
      }
      if (ev.type === "subtask_done" && ev.payload?.subtaskId) {
        const sid = ev.payload.subtaskId;
        if (!doneIndicesBySubtaskId[sid]) doneIndicesBySubtaskId[sid] = [];
        doneIndicesBySubtaskId[sid].push(i);
      }
    }

    let lastActiveIdx = -1;
    for (const [subtaskId, startIdx] of Object.entries(lastStartedIdx)) {
      const doneIndices = doneIndicesBySubtaskId[subtaskId] || [];
      const hasDoneAfterStart = doneIndices.some((di) => di > startIdx);
      if (hasDoneAfterStart) {
        doneInCurrentIter++;
      } else if (startIdx > lastActiveIdx) {
        lastActiveIdx = startIdx;
        activeSubtask = subtasks.find((s) => s.id === subtaskId) || null;
        activeStartedEvent = events[startIdx];
      }
    }
  } else {
    const doneIds = new Set();
    for (const ev of events) {
      if (ev.type === "subtask_done" && ev.payload?.subtaskId) {
        doneIds.add(ev.payload.subtaskId);
      }
    }
    doneInCurrentIter = doneIds.size;
    activeSubtask = subtasks.find((s) => !doneIds.has(s.id)) || null;
  }

  let elapsedSeconds = null;
  if (activeStartedEvent?.timestamp) {
    elapsedSeconds = (Date.now() - new Date(activeStartedEvent.timestamp).getTime()) / 1000;
  }

  return { currentIteration, doneInCurrentIter, totalSubtasks, activeSubtask, elapsedSeconds };
}

function renderExecProgressContent(task, events) {
  const { currentIteration, doneInCurrentIter, totalSubtasks, activeSubtask, elapsedSeconds } =
    computeExecProgressInfo(task, events);

  const hasEvents = events.length > 0;
  const { inputTokens, outputTokens, estimatedCostUsd } = summarizeTokenUsage(events);

  const stateBadge = `<span class="badge badge-state" data-state="${esc(task.state)}">${formatState(task.state)}</span>`;
  const iterLine = `<span class="exec-iter">Iteration ${currentIteration} of ${REWORK_MAX}</span>`;
  const subtaskNoun = totalSubtasks !== 1 ? "subtasks" : "subtask";
  const subtaskLine = hasEvents
    ? `<span class="exec-subtasks-done">${doneInCurrentIter} of ${totalSubtasks} ${subtaskNoun} done in iteration ${currentIteration}</span>`
    : `<span class="exec-subtasks-done exec-placeholder">— of ${totalSubtasks} ${subtaskNoun} done</span>`;

  let activeHtml;
  if (activeSubtask) {
    const desc = activeSubtask.description || "";
    const truncDesc = desc.length > 80 ? `${desc.slice(0, 77)}…` : desc;
    const agentType = activeSubtask.agentType ?? "coder";
    const elapsedSpan = elapsedSeconds != null
      ? `<span class="exec-active-elapsed">${formatElapsed(elapsedSeconds)}</span>`
      : "";
    activeHtml = `
      <div class="exec-active">
        <span class="exec-active-seq">#${activeSubtask.sequence}</span>
        <span class="exec-active-agent">${esc(agentType)}</span>
        <span class="exec-active-desc">${esc(truncDesc)}</span>
        ${elapsedSpan}
      </div>`;
  } else if (!hasEvents) {
    activeHtml = `<div class="exec-active exec-placeholder">Loading active subtask…</div>`;
  } else {
    activeHtml = `<div class="exec-active exec-placeholder">No active subtask</div>`;
  }

  const tokensHtml = hasEvents && (inputTokens > 0 || outputTokens > 0)
    ? `<div class="exec-tokens">
        <span class="exec-token-stat"><span class="exec-token-label">Input</span> ${inputTokens.toLocaleString()}</span>
        <span class="exec-token-stat"><span class="exec-token-label">Output</span> ${outputTokens.toLocaleString()}</span>
        <span class="exec-token-stat"><span class="exec-token-label">Est. cost</span> $${estimatedCostUsd.toFixed(4)}</span>
      </div>`
    : `<div class="exec-tokens exec-placeholder">Token usage will appear after the first agent event.</div>`;

  return `
    <div class="exec-progress-title-row">
      <h3 class="exec-progress-title">Execution Progress</h3>
      ${stateBadge}
    </div>
    <div class="exec-progress-meta">
      ${iterLine}
      ${subtaskLine}
    </div>
    ${activeHtml}
    ${tokensHtml}`;
}

function updateExecProgressHeader(events) {
  const header = document.getElementById("exec-progress-header");
  if (!header || !currentTask) return;
  header.innerHTML = renderExecProgressContent(currentTask, events);
}

function wireCritiqueInput(task) {
  const input = document.getElementById("critique-input");
  const counter = document.getElementById("critique-counter");
  if (!input || !counter) return;

  const update = () => {
    const len = input.value.length;
    counter.textContent = `${len} / 4000`;
    counter.classList.toggle("at-limit", len >= 4000);
  };
  input.addEventListener("input", update);
  update();

  // Cmd/Ctrl+Enter submits the critique
  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      const btn = document.getElementById("btn-critique");
      if (btn && !btn.disabled) critiquePlan(task.id, btn);
    }
  });
}

function wireSpecCritiqueInput(task) {
  const input = document.getElementById("critique-spec-input");
  const counter = document.getElementById("critique-spec-counter");
  if (!input || !counter) return;

  const update = () => {
    const len = input.value.length;
    counter.textContent = `${len} / 4000`;
    counter.classList.toggle("at-limit", len >= 4000);
  };
  input.addEventListener("input", update);
  update();

  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      const btn = document.getElementById("btn-critique-spec");
      if (btn && !btn.disabled) critiqueSpec(task.id, btn);
    }
  });
}

function wireWizardPromptChips() {
  const chipButtons = document.querySelectorAll(".wizard-suggest-chip");
  chipButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.getAttribute("data-chip-target");
      const chip = button.getAttribute("data-chip");
      if (!targetId || !chip) return;
      const input = document.getElementById(targetId);
      if (!input) return;
      const next = input.value.trim()
        ? `${input.value.trim()}\n- ${chip}`
        : chip;
      input.value = next;
      input.dispatchEvent(new Event("input"));
      input.focus();
    });
  });
}

function summarizeTokenUsage(events) {
  return window.DashboardHelpers?.summarizeTokenUsage
    ? window.DashboardHelpers.summarizeTokenUsage(events)
    : { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costSource: "unavailable" };
}

function normalizeEventPayloads(rawEvents) {
  return (rawEvents || []).map((ev) => ({
    ...ev,
    payload: typeof ev.payload === "string" ? safeJsonParse(ev.payload, {}) : ev.payload
  }));
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function getTimelineSummary(ev) {
  return window.DashboardHelpers?.eventTimelineSummary
    ? window.DashboardHelpers.eventTimelineSummary(ev)
    : { group: ev.agent ?? "event", label: ev.type, details: [] };
}

function getInterventionRecommendation(category, reason) {
  return window.DashboardHelpers?.interventionRecommendation
    ? window.DashboardHelpers.interventionRecommendation(category, reason)
    : {
      title: "Inspect transcript and retry from failed stage",
      body: reason || "Use the transcript and event log to choose a retry path.",
      primaryStage: null,
      secondaryStage: null,
      focus: "transcript"
    };
}

function renderInterventionRecommendation(recommendation) {
  const primary = recommendation.primaryStage
    ? `<span class="recommendation-chip">Primary: retry ${esc(recommendation.primaryStage)}</span>`
    : `<span class="recommendation-chip">Primary: inspect transcript</span>`;
  const secondary = recommendation.secondaryStage
    ? `<span class="recommendation-chip recommendation-chip-secondary">Also: retry ${esc(recommendation.secondaryStage)}</span>`
    : "";
  return `
    <div class="intervention-recommendation">
      <div class="recommendation-title">${esc(recommendation.title)}</div>
      <div class="recommendation-body">${esc(recommendation.body)}</div>
      <div class="recommendation-chips">${primary}${secondary}<span class="recommendation-chip recommendation-chip-secondary">Focus: ${esc(recommendation.focus)}</span></div>
    </div>`;
}

function renderPrGateReport(task, events) {
  const report = window.DashboardHelpers?.buildPrGateReport
    ? window.DashboardHelpers.buildPrGateReport(task, events)
    : { state: "unavailable", title: "PR gate report unavailable", reason: "", rows: [] };
  if (report.state === "unavailable") {
    return "";
  }
  const rows = report.rows.length
    ? report.rows.map(([label, value]) => {
      const isUrl = label === "PR" && /^https?:\/\//.test(String(value));
      return `<div class="pr-gate-row">
        <span class="pr-gate-label">${esc(label)}</span>
        <span class="pr-gate-value">${isUrl ? `<a href="${esc(value)}" target="_blank">${esc(value)}</a>` : esc(value)}</span>
      </div>`;
    }).join("")
    : `<div class="pr-gate-empty">${esc(report.reason || "No PR gate evidence recorded yet.")}</div>`;
  return `
    <section class="pr-gate-report pr-gate-${esc(report.state)}">
      <div class="pr-gate-header">
        <h3>PR Gate Report</h3>
        <span class="pr-gate-state">${esc(report.state)}</span>
      </div>
      <div class="pr-gate-title">${esc(report.title)}</div>
      ${report.reason ? `<div class="pr-gate-reason">${esc(report.reason)}</div>` : ""}
      <div class="pr-gate-grid">${rows}</div>
    </section>`;
}

const AGENT_COLORS = {
  orchestrator: "var(--accent)",
  planner: "var(--yellow)",
  coder: "var(--orange)",
  reviewer: "var(--green)",
  doc: "var(--text-muted)",
  pr: "var(--green)",
  meta: "var(--accent)",
};

function agentColor(agent) {
  return AGENT_COLORS[agent] || "var(--text-muted)";
}

function formatElapsed(seconds) {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

const STATUS_COLORS = {
  done: "var(--green)",
  in_progress: "var(--orange)",
  failed: "var(--red)",
  done_with_concerns: "var(--yellow)",
  pending: "var(--text-dim)",
};

function statusColor(status) {
  return STATUS_COLORS[status] || "var(--text-dim)";
}

async function loadEvents(taskId, preloadedRawEvents = null) {
  const container = document.getElementById("findings-list");
  const costSummary = document.getElementById("cost-summary");
  try {
    let rawEvents;
    if (preloadedRawEvents) {
      rawEvents = preloadedRawEvents;
    } else {
      const res = await fetch(`${API}/api/tasks/${taskId}/events`);
      rawEvents = await res.json();
    }
    const events = normalizeEventPayloads(rawEvents);
    if (events.length === 0) {
      container.innerHTML = `<span style="color: var(--text-dim); font-size: 0.85rem;">No events yet.</span>`;
      return;
    }
    container.innerHTML = events
      .map((ev) => {
        const summary = getTimelineSummary(ev);
        const agentCol = agentColor(ev.agent);
        const dotColor = statusColor(ev.status);
        const elapsed = ev.elapsedSeconds !== null ? `<span class="tl-meta">${formatElapsed(ev.elapsedSeconds)}</span>` : "";
        const tokens = ev.tokenUsage ? `<span class="tl-meta">${ev.tokenUsage.input + ev.tokenUsage.output} tok</span>` : "";
        const eventCost = window.DashboardHelpers?.summarizeTokenUsage
          ? window.DashboardHelpers.summarizeTokenUsage([ev])
          : null;
        const cost = eventCost && eventCost.estimatedCostUsd > 0
          ? `<span class="tl-meta">$${eventCost.estimatedCostUsd.toFixed(4)}${eventCost.costSource === "fallback_estimate" ? " est." : ""}</span>`
          : "";
        const details = summary.details.length
          ? `<div class="tl-details">${summary.details.map((item) => `<span>${esc(item)}</span>`).join("")}</div>`
          : "";
        const failureBadge = ev.failureCategory
          ? `<span class="tl-failure-badge">${esc(ev.failureCategory)}</span>`
          : "";
        const failureReason = ev.failureReason && ev.type === "failure_analysis"
          ? `<div class="tl-failure-reason">${esc(ev.failureReason)}</div>`
          : "";
        const rejectionCategories = ev.payload?.rejection_categories?.length
          ? `<div class="tl-rejection-categories">${ev.payload.rejection_categories.map((c) => `<span class="tl-cat">${esc(c)}</span>`).join("")}</div>`
          : "";
        const rejectionGuidance = ev.payload?.rejection_guidance
          ? `<div class="tl-rejection-guidance"><span class="tl-guidance-label">Guidance:</span> ${esc(ev.payload.rejection_guidance)}</div>`
          : "";
        const restartLink = ev.type === "restart_spawned" && ev.payload?.restart_child_task_id
          ? `<div class="tl-restart-link" style="cursor:pointer;color:var(--accent);font-size:0.8rem" onclick="window.openTask('${esc(ev.payload.restart_child_task_id)}')">New attempt: ${String(ev.payload.restart_child_task_id).slice(0, 8)} &rarr;</div>`
          : "";
        const transcriptId = ev.payload?.transcript_id;
        const clickAttr = transcriptId
          ? `style="cursor:pointer" onclick="openTranscript('${transcriptId}')" title="View transcript"`
          : "";
        return `
          <div class="tl-item" data-type="${esc(ev.type)}" data-agent="${esc(ev.agent ?? "")}" ${clickAttr}>
            <span class="tl-dot" style="background:${dotColor}"></span>
            <div class="tl-body">
              <span class="tl-group">${esc(summary.group)}</span>
              <span class="tl-agent" style="color:${agentCol}">${esc(ev.agent)}</span>
              <span class="tl-type">${esc(summary.label)}</span>
              ${failureBadge}${elapsed}${tokens}${cost}
              <span class="tl-time">${timeAgo(ev.timestamp)}</span>
              ${details}${failureReason}${rejectionCategories}${rejectionGuidance}${restartLink}
            </div>
          </div>`;
      })
      .join("");

    const { inputTokens, outputTokens, estimatedCostUsd, costSource } = summarizeTokenUsage(events);
    if (costSummary && (inputTokens > 0 || outputTokens > 0)) {
      costSummary.innerHTML = `
        <span class="cost-stat"><span class="cost-label">Input</span> ${inputTokens.toLocaleString()} tok</span>
        <span class="cost-stat"><span class="cost-label">Output</span> ${outputTokens.toLocaleString()} tok</span>
        <span class="cost-stat"><span class="cost-label">${costSource === "persisted" ? "Cost" : "Est. cost"}</span> $${estimatedCostUsd.toFixed(4)}</span>`;
    }

    updateSubtaskCards(events, currentTask);
    if (currentTask && currentTask.id === taskId) updateExecProgressHeader(events);
    wireEventLogFilter();
  } catch {
    container.innerHTML = `<span style="color: var(--text-dim); font-size: 0.85rem;">Could not load events.</span>`;
  }
}

function wireEventLogFilter() {
  const input = document.getElementById("event-log-filter");
  if (!input) return;
  let debounceTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const query = input.value.trim().toLowerCase();
      document.querySelectorAll(".tl-item").forEach((row) => {
        if (!query) {
          row.hidden = false;
          return;
        }
        const type = (row.dataset.type ?? "").toLowerCase();
        const agent = (row.dataset.agent ?? "").toLowerCase();
        row.hidden = !type.includes(query) && !agent.includes(query);
      });
    }, 80);
  });
}

/**
 * Walk event history and update each subtask card with enriched status,
 * runtime info (executor, elapsed, tokens), per-iteration history strip,
 * and review findings badges. Replaces the simpler markSubtaskProgress.
 */
function updateSubtaskCards(events, task) {
  if (!task) return;
  const currentIteration = task.iteration ?? 1;
  const subtasks = task.planSubtasks || [];

  // --- Pass 1: collect per-subtask, per-iteration run data ---
  // subtaskRuns[subtaskId][iteration] = { startedEvent, doneEvent }
  const subtaskRuns = {};
  const failedSubtaskIds = new Set();

  for (const ev of events) {
    if (ev.type === "subtask_started" && ev.payload?.subtaskId) {
      const sid = ev.payload.subtaskId;
      const iter = ev.payload.iteration ?? currentIteration;
      if (!subtaskRuns[sid]) subtaskRuns[sid] = {};
      if (!subtaskRuns[sid][iter]) subtaskRuns[sid][iter] = { startedEvent: null, doneEvent: null };
      subtaskRuns[sid][iter].startedEvent = ev;
    }
    if (ev.type === "subtask_done" && ev.payload?.subtaskId) {
      const sid = ev.payload.subtaskId;
      let iter = ev.payload?.iteration;
      // Older subtask_done payloads do not carry iteration. Infer from the
      // latest open started run for this subtask to avoid mis-attributing
      // completions to the task's current iteration during rework cycles.
      if (iter == null) {
        const runs = subtaskRuns[sid] || {};
        const knownIters = Object.keys(runs).map(Number).sort((a, b) => b - a);
        const openIter = knownIters.find((i) => runs[i].startedEvent && !runs[i].doneEvent);
        iter = openIter ?? knownIters[0] ?? 1;
      }
      if (!subtaskRuns[sid]) subtaskRuns[sid] = {};
      if (!subtaskRuns[sid][iter]) subtaskRuns[sid][iter] = { startedEvent: null, doneEvent: null };
      subtaskRuns[sid][iter].doneEvent = ev;
    }
    if (ev.type === "failure_analysis" && ev.payload?.subtask_id) {
      failedSubtaskIds.add(ev.payload.subtask_id);
    }
  }

  // --- Pass 2: collect review findings per iteration ---
  const reviewByIteration = {};
  for (const ev of events) {
    if (ev.type === "review_finding") {
      const iter = ev.payload?.iteration ?? currentIteration;
      if (!reviewByIteration[iter]) reviewByIteration[iter] = { findings: [], hasDone: false };
      reviewByIteration[iter].findings.push({
        severity: ev.payload?.severity ?? "MINOR",
        title: ev.payload?.title ?? ev.payload?.description ?? ev.payload?.finding ?? "",
        location: ev.payload?.location ?? ev.payload?.file_path ?? ev.payload?.path ?? ""
      });
    }
    if (ev.type === "review_done") {
      const iter = ev.payload?.iteration ?? currentIteration;
      if (!reviewByIteration[iter]) reviewByIteration[iter] = { findings: [], hasDone: false };
      reviewByIteration[iter].hasDone = true;
    }
  }

  // --- Legacy path setup (no subtask_started events) ---
  const hasStartedEvents = events.some(
    (ev) => ev.type === "subtask_started" && ev.payload?.subtaskId
  );
  const legacyDoneIds = hasStartedEvents
    ? null
    : new Set(
        events
          .filter((ev) => ev.type === "subtask_done" && ev.payload?.subtaskId)
          .map((ev) => ev.payload.subtaskId)
      );
  let legacyRunningAssigned = false;

  // --- Compute shadow runs per subtask (for shadow variants strip) ---
  const shadowBySubtask = buildShadowRunsPerSubtask(events);

  // --- Update each card ---
  const items = document.querySelectorAll("[data-subtask-id]");
  items.forEach((el) => {
    const subtaskId = el.getAttribute("data-subtask-id");

    // Determine current status for this subtask
    let status = "pending";
    let latestDoneEvent = null;    // latest done event (any iteration) — for runtime display
    let latestStartedEvent = null; // latest started event (any iteration) — for history strip
    let currentIterStartedEvent = null; // current iteration started event — for live elapsed
    let latestIter = null;

    if (hasStartedEvents) {
      const runs = subtaskRuns[subtaskId] || {};
      const iters = Object.keys(runs).map(Number).sort((a, b) => a - b);

      // Latest run data across all iterations — for runtime display and history strip failure dot
      if (iters.length > 0) {
        latestIter = iters[iters.length - 1];
        const latestRun = runs[latestIter];
        latestStartedEvent = latestRun.startedEvent;
        latestDoneEvent = latestRun.doneEvent;
      }

      // Status is driven by the CURRENT iteration specifically:
      //   running = subtask_started exists in current iteration with no matching subtask_done
      //   done/done_with_concerns = from subtask_done status field in current iteration
      //   failed = failure_analysis whose payload.subtask_id matches (any iteration)
      const currentIterRun = runs[currentIteration];
      if (currentIterRun) {
        currentIterStartedEvent = currentIterRun.startedEvent;
        if (currentIterRun.doneEvent) {
          const s = currentIterRun.doneEvent.payload?.status ?? currentIterRun.doneEvent.status ?? "done";
          status = s === "done_with_concerns" ? "done_with_concerns" : "done";
        } else if (currentIterRun.startedEvent) {
          status = failedSubtaskIds.has(subtaskId) ? "failed" : "running";
        }
      } else if (failedSubtaskIds.has(subtaskId)) {
        status = "failed";
      }
    } else {
      // Legacy: first non-done subtask is "running" if task is actively running
      if (legacyDoneIds.has(subtaskId)) {
        status = "done";
      } else if (!legacyRunningAssigned && RUNNING_STATES.has(task.state)) {
        status = "running";
        legacyRunningAssigned = true;
      }
    }

    el.setAttribute("data-subtask-status", status);

    // --- Populate runtime div (executor, elapsed, tokens) ---
    const runtimeEl = el.querySelector(".subtask-runtime");
    if (runtimeEl) {
      // Show runtime info if there is a completed run (any iteration) or we are live-running
      if (latestDoneEvent || (currentIterStartedEvent && status === "running")) {
        const parts = [];

        let executorUsed = null;
        let elapsedDisplay = null;
        let tokenDisplay = null;

        if (latestDoneEvent) {
          // Executor/elapsed/tokens from most recent completed run
          executorUsed =
            latestDoneEvent.payload?.executorUsed ??
            latestDoneEvent.payload?.executor_used ??
            latestDoneEvent.executorUsed ??
            null;
          const elapsed =
            latestDoneEvent.elapsedSeconds ??
            latestDoneEvent.payload?.elapsedSeconds ??
            latestDoneEvent.payload?.elapsed_seconds ??
            null;
          if (elapsed != null) elapsedDisplay = formatElapsed(elapsed);
          const tu =
            latestDoneEvent.tokenUsage ?? latestDoneEvent.payload?.tokenUsage ?? null;
          if (tu && (tu.input > 0 || tu.output > 0)) {
            const summary = summarizeTokenUsage([{ ...latestDoneEvent, tokenUsage: tu }]);
            tokenDisplay = `${tu.input.toLocaleString()} in / ${tu.output.toLocaleString()} out · $${summary.estimatedCostUsd.toFixed(4)}`;
          }
        } else if (currentIterStartedEvent && status === "running") {
          // Live elapsed from the current iteration's started event (executor unknown until done)
          const elapsed =
            (Date.now() - new Date(currentIterStartedEvent.timestamp).getTime()) / 1000;
          elapsedDisplay = formatElapsed(elapsed);
        }

        parts.push(
          `<span class="subtask-executor">${esc(executorUsed || "—")}</span>`
        );
        if (elapsedDisplay) {
          parts.push(`<span class="subtask-elapsed">${esc(elapsedDisplay)}</span>`);
        }
        if (tokenDisplay) {
          parts.push(`<span class="subtask-tokens">${esc(tokenDisplay)}</span>`);
        }

        const newRuntimeHtml = `<div class="subtask-runtime-row">${parts.join(
          '<span class="subtask-runtime-sep"> · </span>'
        )}</div>`;
        if (runtimeEl.innerHTML !== newRuntimeHtml) {
          runtimeEl.innerHTML = newRuntimeHtml;
        }
      } else if (runtimeEl.innerHTML !== "") {
        runtimeEl.innerHTML = "";
      }
    }

    // --- Populate history strip (one dot per iteration the subtask ran) ---
    const historyEl = el.querySelector(".subtask-history-strip");
    if (historyEl) {
      const runs = subtaskRuns[subtaskId] || {};
      const iters = Object.keys(runs).map(Number).sort((a, b) => a - b);

      if (iters.length === 0) {
        if (historyEl.innerHTML !== "") historyEl.innerHTML = "";
      } else {
      const entriesHtml = iters.map((iter) => {
        const run = runs[iter];
        let dotClass = "subtask-history-dot";
        let dotTitle = `Iter ${iter}`;

        if (run.doneEvent) {
          const s = run.doneEvent.payload?.status ?? run.doneEvent.status ?? "done";
          if (s === "done_with_concerns") {
            dotClass += " subtask-history-dot--concerns";
            dotTitle += ": done with concerns";
          } else {
            dotClass += " subtask-history-dot--success";
            dotTitle += ": done";
          }
        } else if (run.startedEvent) {
          if (failedSubtaskIds.has(subtaskId) && iter === latestIter) {
            dotClass += " subtask-history-dot--failure";
            dotTitle += ": failed";
          } else {
            dotClass += " subtask-history-dot--running";
            dotTitle += ": running";
          }
        } else {
          dotClass += " subtask-history-dot--success";
          dotTitle += ": completed";
        }

        // Review findings badge for this iteration
        const review = reviewByIteration[iter];
        let badgeHtml = "";
        let panelId = null;
        let findingsPanelHtml = "";

        if (review) {
          const high = review.findings.filter(
            (f) => f.severity === "CRITICAL" || f.severity === "MAJOR"
          ).length;
          const low = review.findings.filter(
            (f) => f.severity === "MINOR" || f.severity === "NITPICK"
          ).length;

          if (high > 0 || low > 0) {
            const highBadge = high > 0
              ? `<span class="subtask-findings-count subtask-findings-count--high">${high}</span>`
              : "";
            const lowBadge = low > 0
              ? `<span class="subtask-findings-count subtask-findings-count--low">${low}</span>`
              : "";
            badgeHtml = `<span class="subtask-findings-badge" aria-hidden="true">${highBadge}${lowBadge}</span>`;
          }

          if (review.findings.length > 0 || review.hasDone) {
            panelId = `subtask-findings-${subtaskId}-iter-${iter}`;
            const findingsHtml =
              review.findings.length > 0
                ? review.findings
                    .map(
                      (f) => `
                  <div class="subtask-finding-item">
                    <span class="finding-severity" data-severity="${esc(f.severity)}">${esc(f.severity)}</span>
                    <div class="subtask-finding-body">
                      <div class="finding-text">${esc(f.title)}</div>
                      ${f.location ? `<div class="finding-path">${esc(f.location)}</div>` : ""}
                    </div>
                  </div>`
                    )
                    .join("")
                : `<div class="subtask-finding-empty">No findings recorded.</div>`;
            findingsPanelHtml = `
              <div class="subtask-findings-panel" id="${panelId}" hidden>
                <div class="subtask-findings-header">Review findings — iter ${iter}</div>
                ${findingsHtml}
              </div>`;
            dotTitle += ` · ${review.findings.length} finding${review.findings.length !== 1 ? "s" : ""}`;
          }
        }

        const clickAttr = panelId
          ? `onclick="toggleFindingsPanel('${panelId}', this)" tabindex="0" role="button"`
          : "";

        return `
          <div class="subtask-history-entry">
            <span class="${dotClass}" ${clickAttr} title="${esc(dotTitle)}">${badgeHtml}</span>
            ${findingsPanelHtml}
          </div>`;
      }).join("");

      const newHistoryHtml = `<div class="subtask-history-strip-inner">${entriesHtml}</div>`;
      if (historyEl.innerHTML !== newHistoryHtml) {
        historyEl.innerHTML = newHistoryHtml;
      }
      } // end else (iters.length > 0)
    }

    // --- Populate shadow variants strip ---
    const shadowWrapEl = el.querySelector(".subtask-shadow-wrap");
    if (shadowWrapEl) {
      const shadowEvents = shadowBySubtask[subtaskId] || [];
      const newShadowHtml = renderShadowVariantsStrip(shadowEvents);
      if (shadowWrapEl.innerHTML !== newShadowHtml) {
        shadowWrapEl.innerHTML = newShadowHtml;
      }
    }
  });
}

/**
 * Walk the event list and build a map of subtaskId → array of shadow_run_completed events.
 * Attachment rule:
 *   - event has payload.subtask_id → attach to that subtask
 *   - no payload.subtask_id (legacy) → attach to nearest preceding subtask_done on the same task
 */
function buildShadowRunsPerSubtask(events) {
  const shadowBySubtask = {};
  let lastSubtaskDoneId = null;

  for (const ev of events) {
    if (ev.type === "subtask_done" && ev.payload?.subtaskId) {
      lastSubtaskDoneId = ev.payload.subtaskId;
    }
    if (ev.type === "shadow_run_completed") {
      const sid = ev.payload?.subtask_id ?? lastSubtaskDoneId;
      // Legacy fallback attachment is only safe for coder shadow runs.
      // Reviewer/doc shadow events can be task-level and should not be
      // projected into a specific subtask without explicit subtask_id.
      const canAttachLegacy = ev.payload?.subtask_id != null || ev.agent === "coder";
      if (sid && canAttachLegacy) {
        if (!shadowBySubtask[sid]) shadowBySubtask[sid] = [];
        shadowBySubtask[sid].push(ev);
      }
    }
  }
  return shadowBySubtask;
}

const SHADOW_MAX_DISPLAY = 20;

/**
 * Render the collapsed-by-default Shadow variants <details> strip for a subtask card.
 * Returns an empty string when there are no matching shadow events (strip is hidden entirely).
 */
function renderShadowVariantsStrip(shadowEvents) {
  if (!shadowEvents || shadowEvents.length === 0) return "";

  const totalCount = shadowEvents.length;
  const displayEvents = shadowEvents.slice(-SHADOW_MAX_DISPLAY);
  const hasMore = totalCount > SHADOW_MAX_DISPLAY;

  const rowsHtml = displayEvents.map((ev) => {
    const p = ev.payload ?? {};
    const variantId = p.candidate_variant_id;
    const shortId = variantId ? String(variantId).slice(-8) : "—";
    const executor =
      p.candidate_executor_used ??
      p.candidate_executor ??
      p.executor ??
      null;
    const executorDisplay = executor ? esc(executor) : "—";

    const baselineComposite = p.baseline_composite != null ? Number(p.baseline_composite) : null;
    const candidateComposite = p.candidate_composite != null ? Number(p.candidate_composite) : null;
    let deltaHtml;
    if (baselineComposite != null && candidateComposite != null) {
      const delta = candidateComposite - baselineComposite;
      const sign = delta >= 0 ? "+" : "";
      const colorClass = delta >= 0 ? "shadow-delta--positive" : "shadow-delta--negative";
      deltaHtml = `<span class="shadow-delta ${colorClass}">${sign}${delta.toFixed(2)}</span>`;
    } else {
      deltaHtml = `<span class="shadow-delta shadow-delta--null">—</span>`;
    }

    const lessonsInjected = p.candidate_lessons_injected ?? 0;
    const errorBadge = p.error ? `<span class="shadow-error-badge">error</span>` : "";
    const iterLabel = p.iteration != null
      ? `<span class="shadow-iter-label">iter ${p.iteration}</span>`
      : "";

    const renderKV = (label, obj) => {
      if (!obj || typeof obj !== "object") return "";
      const entries = Object.entries(obj);
      if (entries.length === 0) return "";
      return `<div class="shadow-components-section">
        <div class="shadow-components-label">${esc(label)}</div>
        ${entries.map(([k, v]) =>
          `<div class="shadow-kv-row"><span class="shadow-kv-key">${esc(k)}</span><span class="shadow-kv-value">${esc(String(v))}</span></div>`
        ).join("")}
      </div>`;
    };

    const baseKV = renderKV("Baseline", p.baseline_score_components);
    const candidateKV = renderKV("Candidate", p.candidate_score_components);
    const expandContent = (baseKV || candidateKV)
      ? `<div class="shadow-components">${baseKV}${candidateKV}</div>`
      : `<div class="shadow-components"><span class="shadow-components-empty">No score components recorded.</span></div>`;

    return `<details class="shadow-row">
      <summary class="shadow-row-summary">
        <span class="shadow-variant-id" title="${esc(variantId ?? "")}">${esc(shortId)}</span>
        <span class="shadow-executor">${executorDisplay}</span>
        ${deltaHtml}
        <span class="shadow-lessons">${lessonsInjected}</span>
        ${errorBadge}
        ${iterLabel}
      </summary>
      ${expandContent}
    </details>`;
  }).join("");

  const viewAllLink = hasMore
    ? `<div class="shadow-view-all"><a href="#findings-section" onclick="document.getElementById('findings-section')?.scrollIntoView({behavior:'smooth'}); return false;">View all ${totalCount} in event log →</a></div>`
    : "";

  return `<details class="subtask-shadow-strip">
    <summary class="subtask-shadow-summary">Shadow variants (${totalCount})</summary>
    <div class="shadow-rows">${rowsHtml}${viewAllLink}</div>
  </details>`;
}

// --- Task Actions ---
async function approveTask(taskId, btnEl) {
  const button = btnEl ?? document.querySelector('.btn-approve');
  await runAction(button, "Merging…", null, async () => {
    try {
      const res = await fetch(`${API}/api/tasks/${taskId}/approve`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      toast("Task approved and merged.", "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Approval failed: ${err.message}`, "error");
    }
  });
}

// --- Rejection modal ---
const dialogReject = document.getElementById("dialog-reject");
const formReject = document.getElementById("form-reject");
let pendingRejectTaskId = null;

document.getElementById("btn-cancel-reject").addEventListener("click", () => {
  dialogReject.close();
  pendingRejectTaskId = null;
});

function rejectTask(taskId) {
  pendingRejectTaskId = taskId;
  formReject.reset();
  dialogReject.showModal();
}

formReject.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = formReject.querySelector('button[type="submit"]');
  if (submitBtn.disabled || !pendingRejectTaskId) return;

  const data = new FormData(formReject);
  const reason = data.get("reason")?.toString().trim();
  const guidance = data.get("guidance")?.toString().trim() || undefined;
  const categories = data.getAll("categories").map(String);

  if (!reason) return;

  const taskId = pendingRejectTaskId;
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Rejecting…";
  dialogReject.close();
  pendingRejectTaskId = null;

  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, guidance, categories: categories.length ? categories : undefined })
    });
    if (!res.ok) throw new Error(await res.text());
    const newTask = await res.json();
    toast(`Task rejected — new attempt ${newTask.id.slice(0, 8)} started.`, "success");
    refreshTasks();
    currentTaskId = newTask.id;
    refreshTaskDetail(newTask.id);
  } catch (err) {
    toast(`Rejection failed: ${err.message}`, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

const dialogCancel = document.getElementById("dialog-cancel");
let pendingCancelTaskId = null;

function cancelTask(taskId) {
  pendingCancelTaskId = taskId;
  const form = document.getElementById("form-cancel");
  form.reset();
  dialogCancel.showModal();
}

document.getElementById("btn-cancel-cancel").addEventListener("click", () => {
  dialogCancel.close();
  pendingCancelTaskId = null;
});

document.getElementById("form-cancel").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const reason = form.reason.value.trim() || "Cancelled by operator.";
  const taskId = pendingCancelTaskId;
  if (!taskId) return;

  const submitBtn = form.querySelector('button[type="submit"]');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Cancelling…";
  dialogCancel.close();
  pendingCancelTaskId = null;

  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error(await res.text());
    toast("Task cancelled.", "success");
    refreshTasks();
    refreshTaskDetail(taskId);
  } catch (err) {
    toast(`Cancel failed: ${err.message}`, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

/**
 * Wrap an async action to give immediate button feedback.
 * - Disables all action buttons in the container while in flight.
 * - Swaps the clicked button's label for a "working…" spinner variant.
 * - Restores state after completion (success or failure).
 *
 * buttonEl: the button that was clicked (its label is what gets swapped)
 * workingLabel: text shown while the action is running (e.g. "Approving…")
 * container: ancestor element whose buttons should ALL be disabled (defaults to the button's form / action block)
 */
async function runAction(buttonEl, workingLabel, container, fn) {
  const original = buttonEl.textContent;
  const btnContainer = container ?? buttonEl.closest(".task-detail-actions") ?? buttonEl.parentElement;
  const allButtons = btnContainer?.querySelectorAll("button, input[type=submit]") ?? [];

  const prevDisabled = [];
  allButtons.forEach((b, i) => { prevDisabled[i] = b.disabled; b.disabled = true; });
  buttonEl.innerHTML = `<span class="spinner" aria-hidden="true"></span>${workingLabel}`;
  buttonEl.classList.add("btn-working");

  try {
    await fn();
  } finally {
    allButtons.forEach((b, i) => { b.disabled = prevDisabled[i]; });
    buttonEl.innerHTML = original;
    buttonEl.classList.remove("btn-working");
  }
}

async function approvePlan(taskId, btnEl) {
  await runAction(btnEl, "Approving…", btnEl?.closest(".plan-review-buttons"), async () => {
    try {
      const res = await fetch(`${API}/api/tasks/${taskId}/approve-plan`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      clearPendingReviewSubmission(taskId, "plan");
      toast("Plan approved — execution starting…", "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Approve plan failed: ${err.message}`, "error");
    }
  });
}

async function approveSpec(taskId, btnEl) {
  await runAction(btnEl, "Approving…", btnEl?.closest(".plan-review-buttons"), async () => {
    try {
      const res = await fetch(`${API}/api/tasks/${taskId}/approve-spec`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      clearPendingReviewSubmission(taskId, "spec");
      toast("Spec approved — generating execution plan…", "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Approve spec failed: ${err.message}`, "error");
    }
  });
}

async function critiquePlan(taskId, btnEl) {
  const input = document.getElementById("critique-input");
  const critique = (input?.value ?? "").trim();
  if (!critique) {
    toast("Please enter a critique to revise the plan.", "error");
    return;
  }
  const button = btnEl ?? document.getElementById("btn-critique");
  const attempt = Number(input?.dataset?.attempt ?? 0);
  await runAction(button, "Re-planning… (up to a few minutes)", button.closest(".plan-review-buttons"), async () => {
    try {
      const res = await fetch(`${API}/api/tasks/${taskId}/critique-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ critique })
      });
      if (res.status === 409) {
        toast("Re-plan limit reached — approve or cancel.", "error");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      setPendingReviewSubmission(taskId, "plan", { text: critique, attempt, submittedAt: Date.now() });
      toast("Critique submitted — re-planning…", "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      clearPendingReviewSubmission(taskId, "plan");
      toast(`Critique failed: ${err.message}`, "error");
    }
  });
}

async function critiqueSpec(taskId, btnEl) {
  const input = document.getElementById("critique-spec-input");
  const critique = (input?.value ?? "").trim();
  const mode = input?.dataset?.mode === "blocking_question" ? "blocking_question" : "critique";
  if (!critique) {
    toast(
      mode === "blocking_question"
        ? "Please answer the blocking question before submitting."
        : "Please enter a critique to revise the spec.",
      "error"
    );
    return;
  }
  const button = btnEl ?? document.getElementById("btn-critique-spec");
  const attempt = Number(input?.dataset?.attempt ?? 0);
  await runAction(button, "Re-planning spec…", button.closest(".plan-review-buttons"), async () => {
    try {
      const res = await fetch(`${API}/api/tasks/${taskId}/critique-spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ critique })
      });
      if (res.status === 409) {
        toast("Spec revision limit reached — approve or cancel.", "error");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      setPendingReviewSubmission(taskId, "spec", { text: critique, attempt, submittedAt: Date.now(), mode });
      toast(
        mode === "blocking_question"
          ? "Answer submitted — revising spec…"
          : "Critique submitted — revising spec…",
        "success"
      );
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      clearPendingReviewSubmission(taskId, "spec");
      toast(`Critique failed: ${err.message}`, "error");
    }
  });
}

async function retryTask(taskId, fromStage, btnEl) {
  const label = fromStage === "planning" ? "Re-planning…" : "Retrying execution…";
  const checkpointSelect = document.getElementById("retry-checkpoint-id");
  const noteInput = document.getElementById("retry-operator-note");
  const checkpointId = checkpointSelect?.value?.trim();
  const operatorNote = noteInput?.value?.trim();
  await runAction(btnEl, label, btnEl?.closest(".intervention-buttons"), async () => {
    try {
      const payload = {
        fromStage,
        ...(checkpointId ? { checkpointId } : {}),
        ...(operatorNote ? { operatorNote } : {})
      };
      const res = await fetch(`${API}/api/tasks/${taskId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409) {
        if (body?.error === "checkpoint_unreachable") {
          toast("Rollback failed: checkpoint is unreachable from current HEAD.", "error");
          return;
        }
        if (body?.error === "checkpoint_not_found") {
          toast("Rollback failed: checkpoint not found.", "error");
          return;
        }
        if (body?.error === "invalid_worktree_path") {
          toast("Rollback failed: worktree path no longer matches this task.", "error");
          return;
        }
        if (body?.error === "cannot_rollback_to_approved_spec") {
          toast(
            "Retrying spec phase would overwrite an approved spec. Roll back to a spec checkpoint or resubmit with force.",
            "error"
          );
          return;
        }
        toast("Task is no longer paused for intervention.", "error");
        return;
      }
      if (res.status === 400 && body?.error === "checkpoint_stage_after_retry_stage") {
        toast("Checkpoint stage is later than the selected retry stage.", "error");
        return;
      }
      if (!res.ok) throw new Error(body?.message ?? JSON.stringify(body) ?? "Retry failed");
      toast(`Retry started from ${fromStage}.`, "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Retry failed: ${err.message}`, "error");
    }
  });
}

async function submitSteering(taskId, btnEl) {
  const input = document.getElementById("steering-input");
  const message = input?.value?.trim();
  if (!message) {
    toast("Enter steering guidance first.", "error");
    return;
  }
  await runAction(btnEl, "Queueing…", btnEl?.closest(".intervention-rollback"), async () => {
    try {
      const res = await fetch(`${API}/api/tasks/${taskId}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, scope: "next_attempt" })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.message ?? JSON.stringify(body) ?? "Failed to queue steering");
      }
      if (input) input.value = "";
      toast("Steering queued for the next agent attempt.", "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Steering failed: ${err.message}`, "error");
    }
  });
}

async function archiveTask(taskId, event) {
  event.stopPropagation();
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/archive`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    toast('Task archived.', 'success');
    refreshTasks();
  } catch (err) {
    toast(`Archive failed: ${err.message}`, 'error');
  }
}

async function unarchiveTask(taskId, event) {
  event.stopPropagation();
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/unarchive`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    toast('Task restored.', 'success');
    refreshTasks();
  } catch (err) {
    toast(`Restore failed: ${err.message}`, 'error');
  }
}

async function deleteTask(taskId, event) {
  event.stopPropagation();
  if (!confirm('Permanently delete this task? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    toast('Task deleted.', 'success');
    refreshTasks();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

window.toggleFindingsPanel = (panelId, dotEl) => {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.hidden = !panel.hidden;
  dotEl.classList.toggle("subtask-history-dot--expanded", !panel.hidden);
};

// Make actions available from inline onclick handlers
window.approveTask = approveTask;
window.rejectTask = rejectTask;
window.cancelTask = cancelTask;
window.approvePlan = approvePlan;
window.approveSpec = approveSpec;
window.critiquePlan = critiquePlan;
window.critiqueSpec = critiqueSpec;
window.retryTask = retryTask;
window.submitSteering = submitSteering;
window.archiveTask = archiveTask;
window.unarchiveTask = unarchiveTask;
window.deleteTask = deleteTask;
window.openTask = (taskId) => {
  currentTaskId = taskId;
  refreshTaskDetail(taskId);
  showView("task-detail");
};

// --- New Task Dialog ---
const dialogTask = document.getElementById("dialog-new-task");
document.getElementById("btn-new-task").addEventListener("click", () => dialogTask.showModal());
document.getElementById("btn-cancel-task").addEventListener("click", () => dialogTask.close());

document.getElementById("form-new-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn.disabled) return;

  const body = {
    projectId: form.projectId.value.trim(),
    description: form.description.value.trim(),
    reviewPlan: form.reviewPlan.checked,
  };
  const forceTierValue = form.forceTier.value;
  if (forceTierValue) body.forceTier = forceTierValue;

  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  // Close the dialog immediately so the user never sees a still-open
  // dialog after clicking submit. Backend kicks off the planner which
  // can run for minutes, and we don't want the user to double-click.
  dialogTask.close();
  form.reset();
  form.projectId.value = "autoforge";
  form.reviewPlan.checked = true;
  toast("Task submitted — planner starting…", "success");

  try {
    const res = await fetch(`${API}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const createdTask = await res.json();
    await refreshTasks();
    if (createdTask?.id) {
      currentTaskId = createdTask.id;
      await refreshTaskDetail(createdTask.id);
      showView("task-detail");
    }
  } catch (err) {
    toast(`Submit failed: ${err.message}`, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

// --- Metrics ---
document.getElementById("btn-load-metrics").addEventListener("click", loadMetrics);

async function loadMetrics() {
  const projectId = document.getElementById("metrics-project-id").value.trim();
  if (!projectId) return;
  try {
    const res = await fetch(`${API}/api/metrics/${projectId}`);
    const data = await res.json();
    metricsGrid.innerHTML = Object.entries(data)
      .map(
        ([key, value]) => `
      <div class="metric-card">
        <div class="metric-value">${value}</div>
        <div class="metric-label">${formatLabel(key)}</div>
      </div>`
      )
      .join("");
  } catch {
    metricsGrid.innerHTML = `<div class="empty-state">Failed to load metrics.</div>`;
  }
}

// --- Meta / Experiments ---
const dialogMeta = document.getElementById("dialog-meta");
document.getElementById("btn-trigger-meta").addEventListener("click", () => dialogMeta.showModal());
document.getElementById("btn-cancel-meta").addEventListener("click", () => dialogMeta.close());

document.getElementById("form-meta").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  if (submitBtn.disabled) return;

  const body = {
    projectId: form.projectId.value.trim(),
    focus: form.focus.value.trim() || undefined,
  };
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Running…";

  dialogMeta.close();
  form.reset();
  form.projectId.value = "autoforge";
  toast("Meta agent started…", "success");

  try {
    const res = await fetch(`${API}/api/meta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const result = await res.json();
    toast(
      result.experimentId
        ? `Experiment created: ${result.experimentId.slice(0, 8)}`
        : `Meta agent completed (${result.status})`,
      "success"
    );
  } catch (err) {
    toast(`Meta agent failed: ${err.message}`, "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalLabel;
  }
});

// --- Helpers ---
function esc(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatState(state) {
  return (state || "").replace(/_/g, " ");
}

function formatLabel(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function timeAgo(iso) {
  if (!iso) return "";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function toast(message, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// --- Transcript drill-down ---
const dialogTranscript = document.getElementById("dialog-transcript");
const transcriptMeta = document.getElementById("transcript-meta");
const transcriptPane = document.getElementById("transcript-pane");
let currentTranscript = null;
let currentTranscriptTask = null;
let currentTab = "plan";

document.getElementById("btn-close-transcript").addEventListener("click", () => dialogTranscript.close());

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderTranscriptTab();
  });
});

async function openTranscript(transcriptId) {
  try {
    const res = await fetch(`${API}/api/transcripts/${transcriptId}`);
    if (!res.ok) {
      toast("Transcript not found.", "error");
      return;
    }
    currentTranscript = await res.json();
    currentTranscriptTask = null;
    // Fetch the parent task so the Plan tab can render with full context
    // (description, tier, assessment). Non-fatal if it fails — the Plan tab
    // will fall back to showing just the subtasks from the transcript output.
    if (currentTranscript.taskId) {
      try {
        const taskRes = await fetch(`${API}/api/tasks/${currentTranscript.taskId}`);
        if (taskRes.ok) currentTranscriptTask = await taskRes.json();
      } catch { /* ignore */ }
      try {
        const txRes = await fetch(`${API}/api/transcripts/by-task/${currentTranscript.taskId}`);
        if (txRes.ok && currentTranscriptTask) currentTranscriptTask.transcripts = await txRes.json();
      } catch { /* ignore */ }
    }
    document.getElementById("transcript-title").textContent =
      `Planner — attempt ${currentTranscript.attempt} — ${currentTranscript.model ?? currentTranscript.executorUsed}`;
    transcriptMeta.innerHTML = `
      <span>tokens: ${currentTranscript.tokenInput ?? "?"} in / ${currentTranscript.tokenOutput ?? "?"} out</span>
      <span>elapsed: ${formatElapsed(currentTranscript.elapsedSeconds)}</span>
      <span>executor: ${esc(currentTranscript.executorUsed)}</span>
      ${renderCurrentTranscriptDiffSummary()}
    `;
    currentTab = "plan";
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === "plan")
    );
    renderTranscriptTab();
    dialogTranscript.showModal();
  } catch (err) {
    toast(`Failed to load transcript: ${err.message}`, "error");
  }
}
window.openTranscript = openTranscript;

function renderCurrentTranscriptDiffSummary() {
  const transcripts = currentTranscriptTask?.transcripts ?? currentTask?.transcripts ?? [];
  const diffs = window.DashboardHelpers?.transcriptAttemptDiffs
    ? window.DashboardHelpers.transcriptAttemptDiffs(transcripts)
    : [];
  const match = diffs.find((diff) =>
    diff.stage === currentTranscript?.stage &&
    Number(diff.toAttempt) === Number(currentTranscript?.attempt)
  );
  if (!match) {
    return `<span>attempt diff: unavailable</span>`;
  }
  const input = match.tokenInputDelta >= 0 ? `+${match.tokenInputDelta}` : String(match.tokenInputDelta);
  const output = match.tokenOutputDelta >= 0 ? `+${match.tokenOutputDelta}` : String(match.tokenOutputDelta);
  const elapsed = match.elapsedDelta == null
    ? "elapsed ?"
    : `${match.elapsedDelta >= 0 ? "+" : ""}${formatElapsed(Math.abs(match.elapsedDelta))}`;
  const changed = [
    match.promptChanged ? "prompt" : "",
    match.outputChanged ? "output" : "",
    match.critiqueChanged ? "critique" : ""
  ].filter(Boolean).join(", ") || "no content delta";
  return `<span title="${esc(changed)}">attempt diff: ${esc(input)} in / ${esc(output)} out · ${esc(elapsed)}</span>`;
}

// Map tool names to visual icons for the transcript viewer
const TOOL_ICONS = {
  read_file: "📄",
  write_file: "✏️",
  list_directory: "📁",
  search_files: "🔍",
  read_multiple_files: "📑",
  bash: "▶",
};
function toolIcon(name) { return TOOL_ICONS[name] || "🔧"; }

// Short preview of a tool_use argument set — first meaningful field value
function toolInputPreview(input) {
  if (!input || typeof input !== "object") return "";
  const key = input.path ?? input.command ?? input.pattern ?? input.paths ?? "";
  const str = typeof key === "string" ? key : JSON.stringify(key);
  return str.length > 80 ? str.slice(0, 77) + "…" : str;
}

// First N lines of tool_result content for the <summary>
function contentPreview(content, lines = 1) {
  const head = String(content ?? "").split("\n").slice(0, lines).join(" ↵ ");
  return head.length > 120 ? head.slice(0, 117) + "…" : head;
}

let transcriptFilter = "";

function copyBtn(value, label = "copy") {
  // Use a global helper wired below via window.copyToClipboard
  return `<button class="copy-btn" onclick="copyToClipboard(this, ${JSON.stringify(value).replace(/"/g, "&quot;")})">${label}</button>`;
}

window.copyToClipboard = async (btn, text) => {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "copied ✓";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = original; btn.classList.remove("copied"); }, 1500);
  } catch {
    toast("Copy failed.", "error");
  }
};

function renderTranscriptTab() {
  if (!currentTranscript) return;
  if (currentTab === "plan") {
    let parsedOutput = null;
    try { parsedOutput = JSON.parse(currentTranscript.output ?? "null"); } catch { parsedOutput = null; }
    const subtasks = Array.isArray(parsedOutput?.subtasks) ? parsedOutput.subtasks : [];
    const taskForRender = {
      description: currentTranscriptTask?.description ?? "",
      tier: currentTranscriptTask?.tier ?? "",
      assessment: currentTranscriptTask?.assessment ?? {},
      planSubtasks: subtasks
    };
    const md = typeof window.renderPlanMarkdown === "function"
      ? window.renderPlanMarkdown(taskForRender)
      : "";
    const html = typeof window.markdownToHtml === "function" && md
      ? window.markdownToHtml(md)
      : "";
    if (!html) {
      transcriptPane.innerHTML = `<div class="empty-state">No plan produced for this attempt.</div>`;
      return;
    }
    transcriptPane.innerHTML = `
      <div class="pane-toolbar">${copyBtn(md, "Copy as markdown")}</div>
      <section class="plan-review-markdown plan-tab-pane">${html}</section>`;
    return;
  }
  if (currentTab === "system") {
    transcriptPane.innerHTML = `
      <div class="pane-toolbar">${copyBtn(currentTranscript.systemPrompt, "Copy system prompt")}</div>
      <pre class="prompt-block">${esc(currentTranscript.systemPrompt)}</pre>`;
  } else if (currentTab === "user") {
    const critiquePart = currentTranscript.critique
      ? `<div class="critique-block"><strong>Critique that triggered this attempt:</strong><br>${esc(currentTranscript.critique)}</div>`
      : "";
    transcriptPane.innerHTML = `
      <div class="pane-toolbar">${copyBtn(currentTranscript.userPrompt, "Copy user prompt")}</div>
      <pre class="prompt-block">${esc(currentTranscript.userPrompt)}</pre>
      ${critiquePart}`;
  } else if (currentTab === "transcript") {
    renderTranscriptTurns();
  } else if (currentTab === "output") {
    let output;
    try { output = JSON.parse(currentTranscript.output ?? "null"); } catch { output = currentTranscript.output; }
    const pretty = JSON.stringify(output, null, 2);
    transcriptPane.innerHTML = `
      <div class="pane-toolbar">${copyBtn(pretty, "Copy output")}</div>
      <pre class="output-block">${esc(pretty)}</pre>`;
  }
}

function renderTranscriptTurns() {
  const lines = (currentTranscript.transcript || "").split("\n").filter(Boolean);
  if (lines.length === 0) {
    transcriptPane.innerHTML = `<div class="empty-state">No transcript captured (executor did not emit turns).</div>`;
    return;
  }

  const f = transcriptFilter.trim().toLowerCase();
  const matches = (hay) => !f || String(hay).toLowerCase().includes(f);

  const rendered = lines.map((line) => {
    let turn;
    try { turn = JSON.parse(line); } catch { return ""; }

    if (turn.kind === "compaction") {
      const show = !f; // compaction markers only shown when no filter
      return show ? `<div class="turn-compaction">— history compacted (${turn.droppedTurns} turns dropped) —</div>` : "";
    }

    if (turn.kind === "tool_result") {
      const preview = contentPreview(turn.content);
      if (!matches(turn.content) && !matches(turn.toolUseId)) return "";
      return `<details class="turn turn-tool-result">
        <summary><span class="turn-icon">⤴</span> <strong>tool_result</strong> <code>${esc(turn.toolUseId)}</code>
          <span class="turn-preview">${esc(preview)}</span>
          ${copyBtn(String(turn.content ?? ""))}
        </summary>
        <pre>${esc(turn.content)}</pre>
      </details>`;
    }

    // assistant turn
    const blocks = (turn.content || []).map((b) => {
      if (b.type === "text") {
        if (!matches(b.text)) return "";
        return `<div class="block-text">${esc(b.text)}</div>`;
      }
      if (b.type === "tool_use") {
        const preview = toolInputPreview(b.input);
        if (!matches(b.name) && !matches(preview) && !matches(JSON.stringify(b.input))) return "";
        const args = JSON.stringify(b.input, null, 2);
        return `<details class="turn turn-tool-use">
          <summary><span class="turn-icon">${toolIcon(b.name)}</span> <strong>${esc(b.name)}</strong>
            <span class="turn-preview">${esc(preview)}</span>
            ${copyBtn(args)}
          </summary>
          <pre>${esc(args)}</pre>
        </details>`;
      }
      if (b.type === "mcp_tool_use") {
        const preview = toolInputPreview(b.input);
        if (!matches(b.name) && !matches(preview)) return "";
        const args = JSON.stringify(b.input ?? {}, null, 2);
        return `<details class="turn turn-mcp">
          <summary><span class="mcp-badge">qmd</span> <strong>${esc(b.name)}</strong>
            <span class="turn-preview">${esc(preview)}</span>
            ${copyBtn(args)}
          </summary>
          <pre>${esc(args)}</pre>
        </details>`;
      }
      return `<div class="block-other">${esc(JSON.stringify(b))}</div>`;
    }).filter(Boolean).join("");

    return blocks ? `<div class="turn turn-assistant">${blocks}</div>` : "";
  }).filter(Boolean).join("");

  transcriptPane.innerHTML = `
    <div class="pane-toolbar">
      <input type="search" id="transcript-filter" class="transcript-filter"
        placeholder="Filter turns…" value="${esc(transcriptFilter)}" autocomplete="off" />
      <span class="transcript-filter-count">${lines.length} turn${lines.length !== 1 ? "s" : ""}</span>
    </div>
    <div id="transcript-turns">${rendered || `<div class="empty-state">No turns match the filter.</div>`}</div>
  `;

  const filterInput = document.getElementById("transcript-filter");
  if (filterInput) {
    filterInput.addEventListener("input", (e) => {
      transcriptFilter = e.target.value;
      // Re-render turns only (preserve focus on the input)
      const sel = filterInput.selectionStart;
      renderTranscriptTurns();
      const again = document.getElementById("transcript-filter");
      if (again) { again.focus(); again.setSelectionRange(sel, sel); }
    });
  }
}

// --- Config ---
async function loadConfig() {
  try {
    const res = await fetch(`${API}/api/config`);
    if (res.ok) {
      const cfg = await res.json();
      if (typeof cfg.plannerMaxIterations === "number") {
        plannerMaxIterations = cfg.plannerMaxIterations;
      }
      if (typeof cfg.plannerSpecMaxIterations === "number") {
        plannerSpecMaxIterations = cfg.plannerSpecMaxIterations;
      }
    }
  } catch {
    // best-effort; fall back to default
  }
}

// --- Init ---
loadConfig();
connectSSE();
refreshTasks();
