const API = "";

// --- State ---
let tasks = [];
let currentTaskId = null;
let plannerMaxIterations = 3;

// --- DOM refs ---
const badge = document.getElementById("connection-badge");
const taskList = document.getElementById("task-list");
const detailContent = document.getElementById("task-detail-content");
const metricsGrid = document.getElementById("metrics-grid");

// --- Navigation ---
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
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

  es.onerror = () => {
    badge.textContent = "disconnected";
    badge.className = "connection-badge disconnected";
  };
}

// --- Tasks ---
async function refreshTasks() {
  try {
    const res = await fetch(`${API}/api/tasks`);
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

function renderTaskList() {
  if (tasks.length === 0) {
    taskList.innerHTML = `<div class="empty-state">No tasks yet. Submit one to get started.</div>`;
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

  taskList.innerHTML = tasks
    .map(
      (t) => {
        const isRunning = RUNNING_STATES.has(t.state);
        return `
    <div class="task-card ${isRunning ? "running-pulse" : ""}" data-id="${t.id}">
      <div class="task-card-body">
        <div class="task-card-description">${esc(t.description)}</div>
        <div class="task-card-meta">
          <code>${t.id.slice(0, 8)}</code>
          <span>${timeAgo(t.createdAt)}</span>
          ${t.iteration > 0 ? `<span>iteration ${t.iteration}</span>` : ""}
          ${t.state === "awaiting_plan_approval" || t.state === "replanning" ? `<span class="card-pill card-pill-plan">plan review</span>` : ""}
          ${t.state === "awaiting_approval" ? `<span class="card-pill card-pill-pr">awaiting merge</span>` : ""}
        </div>
      </div>
      <div class="task-card-right">
        <span class="badge badge-tier">${t.tier}</span>
        <span class="badge badge-state" data-state="${t.state}">${formatState(t.state)}</span>
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
    task.planAttempt = transcripts.length === 0 ? 0 : Math.max(...transcripts.map((t) => t.attempt));
    task.transcripts = transcripts;
    // Surface the most recent failure_analysis so the intervention card can
    // render forensics without a second round trip.
    if (eventsRes.ok) {
      const allEvents = await eventsRes.json();
      for (let i = allEvents.length - 1; i >= 0; i--) {
        if (allEvents[i].type === "failure_analysis") {
          task.latestFailureAnalysis = allEvents[i];
          break;
        }
      }
    }
    renderTaskDetail(task);
  } catch {
    detailContent.innerHTML = `<div class="empty-state">Failed to load task.</div>`;
  }
}

function renderTaskDetail(task) {
  const assessment = task.assessment || {};
  const subtasks = task.planSubtasks || [];

  const terminalStates = ["completed", "failed"];
  const nonTerminalStates = ["received", "assessing", "planning", "awaiting_plan_approval", "replanning", "executing", "reviewing", "reworking", "pr_created", "awaiting_approval", "documenting", "awaiting_intervention"];
  let actionsHtml = "";

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

    // Retry target: if planner failed, retrying "the failed stage" re-runs
    // planning. If coder failed, the operator can either re-run the coder
    // with the current plan, or go back and re-plan from scratch.
    const canRetryFromPlanning = stageFailed === "planning" || stageFailed === "replanning" || stageFailed === "executing" || stageFailed === "reviewing";
    const canRetryFromExecuting = stageFailed === "executing" || stageFailed === "reviewing";
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
        <div class="intervention-buttons">
          ${retryButtons.join("")}
          <button class="btn btn-ghost btn-sm" onclick="cancelTask('${task.id}')" style="margin-left:auto">Cancel task</button>
        </div>
      </div>`;
  } else if (task.state === "awaiting_plan_approval") {
    const attemptCount = task.planAttempt ?? 0;
    const maxAttempts = plannerMaxIterations + 1;
    const planNum = attemptCount + 1;
    const reviseDisabled = attemptCount >= (maxAttempts - 1);
    const transcripts = task.transcripts ?? [];
    const latestTranscript = transcripts.slice(-1)[0];
    const viewLink = latestTranscript
      ? `<a href="#" onclick="openTranscript('${latestTranscript.id}'); return false;" class="view-transcript-link">View transcript →</a>`
      : "";

    // Attempt stepper: one dot per attempt (so far), clickable to open that attempt's transcript
    const stepper = transcripts.map((t, idx) => `
      <button class="step-dot ${idx === transcripts.length - 1 ? "current" : ""}"
        onclick="openTranscript('${t.id}')"
        title="View transcript for plan #${idx + 1}">
        ${idx + 1}
      </button>
    `).join("");
    // Fill remaining dots up to maxAttempts as disabled "future" slots
    const futureDots = Array.from({ length: maxAttempts - transcripts.length }, (_, i) => `
      <span class="step-dot future" title="Plan #${transcripts.length + i + 1} (not attempted)">${transcripts.length + i + 1}</span>
    `).join("");

    // Prior critique callout — show the critique that triggered this attempt (if any)
    const priorCritique = latestTranscript?.critique;
    const critiqueCallout = priorCritique
      ? `<div class="prior-critique">
          <div class="prior-critique-label">Your critique from plan #${planNum - 1}:</div>
          <div class="prior-critique-body">${esc(priorCritique)}</div>
        </div>`
      : "";

    const planMarkdown = typeof window.renderPlanMarkdown === "function"
      ? window.renderPlanMarkdown(task)
      : "";
    const planHtml = typeof window.markdownToHtml === "function" && planMarkdown
      ? window.markdownToHtml(planMarkdown)
      : "";
    const planDocBlock = planHtml
      ? `<section class="plan-review-markdown" aria-label="Proposed plan">${planHtml}</section>`
      : "";

    actionsHtml = `
      <div class="task-detail-actions plan-review">
        <div class="plan-review-header">
          <h3 class="plan-review-title">Plan Review — plan #${planNum} of ${maxAttempts}</h3>
          ${viewLink}
        </div>
        <div class="plan-review-stepper">${stepper}${futureDots}</div>
        ${planDocBlock}
        ${critiqueCallout}
        <div class="critique-wrapper">
          <textarea id="critique-input" class="critique-input" rows="4"
            placeholder="Optional: leave a natural-language critique to revise the plan. Cmd/Ctrl+Enter to submit."
            maxlength="4000"></textarea>
          <div class="critique-counter" id="critique-counter">0 / 4000</div>
        </div>
        <div class="plan-review-buttons">
          <button class="btn btn-approve" onclick="approvePlan('${task.id}', this)">Approve &amp; Continue</button>
          <button class="btn btn-secondary" id="btn-critique"
            onclick="critiquePlan('${task.id}', this)" ${reviseDisabled ? "disabled" : ""}>
            Revise Plan${reviseDisabled ? " (limit reached)" : ""}
          </button>
          <button class="btn btn-ghost btn-sm" onclick="cancelTask('${task.id}')" style="margin-left:auto">Cancel</button>
        </div>
      </div>`;
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
      <h3>Pipeline Event Log</h3>
      <div id="cost-summary" class="cost-summary"></div>
      <div id="findings-list"><span style="color: var(--text-dim); font-size: 0.85rem;">Loading...</span></div>
    </div>
  `;

  wireCritiqueInput(task);
  loadEvents(task.id);
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

// Per-token pricing (Claude Sonnet-class): $3/1M input, $15/1M output
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

function summarizeTokenUsage(events) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const ev of events) {
    if (ev.tokenUsage) {
      inputTokens += ev.tokenUsage.input;
      outputTokens += ev.tokenUsage.output;
    }
  }
  const estimatedCostUsd =
    inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
  return { inputTokens, outputTokens, estimatedCostUsd };
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

async function loadEvents(taskId) {
  const container = document.getElementById("findings-list");
  const costSummary = document.getElementById("cost-summary");
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/events`);
    const events = (await res.json()).map((ev) => ({
      ...ev,
      payload: typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload
    }));
    if (events.length === 0) {
      container.innerHTML = `<span style="color: var(--text-dim); font-size: 0.85rem;">No events yet.</span>`;
      return;
    }
    container.innerHTML = events
      .map((ev) => {
        const agentCol = agentColor(ev.agent);
        const dotColor = statusColor(ev.status);
        const elapsed = ev.elapsedSeconds !== null ? `<span class="tl-meta">${formatElapsed(ev.elapsedSeconds)}</span>` : "";
        const tokens = ev.tokenUsage ? `<span class="tl-meta">${ev.tokenUsage.input + ev.tokenUsage.output} tok</span>` : "";
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
          <div class="tl-item" ${clickAttr}>
            <span class="tl-dot" style="background:${dotColor}"></span>
            <div class="tl-body">
              <span class="tl-agent" style="color:${agentCol}">${esc(ev.agent)}</span>
              <span class="tl-type">${esc(ev.type)}</span>
              ${failureBadge}${elapsed}${tokens}
              <span class="tl-time">${timeAgo(ev.timestamp)}</span>
              ${failureReason}${rejectionCategories}${rejectionGuidance}${restartLink}
            </div>
          </div>`;
      })
      .join("");

    const { inputTokens, outputTokens, estimatedCostUsd } = summarizeTokenUsage(events);
    if (costSummary && (inputTokens > 0 || outputTokens > 0)) {
      costSummary.innerHTML = `
        <span class="cost-stat"><span class="cost-label">Input</span> ${inputTokens.toLocaleString()} tok</span>
        <span class="cost-stat"><span class="cost-label">Output</span> ${outputTokens.toLocaleString()} tok</span>
        <span class="cost-stat"><span class="cost-label">Est. cost</span> $${estimatedCostUsd.toFixed(4)}</span>`;
    }

    markSubtaskProgress(events);
  } catch {
    container.innerHTML = `<span style="color: var(--text-dim); font-size: 0.85rem;">Could not load events.</span>`;
  }
}

/**
 * Walk event history and mark each subtask card with its current status.
 * - subtask_done → done (green check)
 * - if a subtask_done fired for subtask N but not yet for N+1, and the task
 *   is in a running state, mark N+1 as "running" (pulse)
 * - otherwise pending (dim)
 */
function markSubtaskProgress(events) {
  const doneIds = new Set();
  for (const ev of events) {
    if (ev.type === "subtask_done" && ev.payload?.subtaskId) {
      doneIds.add(ev.payload.subtaskId);
    }
  }

  const items = document.querySelectorAll("[data-subtask-id]");
  let runningAssigned = false;
  items.forEach((el) => {
    const id = el.getAttribute("data-subtask-id");
    if (doneIds.has(id)) {
      el.setAttribute("data-subtask-status", "done");
    } else if (!runningAssigned) {
      el.setAttribute("data-subtask-status", "running");
      runningAssigned = true;
    } else {
      el.setAttribute("data-subtask-status", "pending");
    }
  });
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
      toast("Plan approved — execution starting…", "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Approve plan failed: ${err.message}`, "error");
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
      toast("Critique submitted — re-planning…", "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Critique failed: ${err.message}`, "error");
    }
  });
}

async function retryTask(taskId, fromStage, btnEl) {
  const label = fromStage === "planning" ? "Re-planning…" : "Retrying execution…";
  await runAction(btnEl, label, btnEl?.closest(".intervention-buttons"), async () => {
    try {
      const res = await fetch(`${API}/api/tasks/${taskId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromStage })
      });
      if (res.status === 409) {
        toast("Task is no longer paused for intervention.", "error");
        return;
      }
      if (!res.ok) throw new Error(await res.text());
      toast(`Retry started from ${fromStage}.`, "success");
      refreshTasks();
      refreshTaskDetail(taskId);
    } catch (err) {
      toast(`Retry failed: ${err.message}`, "error");
    }
  });
}

// Make actions available from inline onclick handlers
window.approveTask = approveTask;
window.rejectTask = rejectTask;
window.cancelTask = cancelTask;
window.approvePlan = approvePlan;
window.critiquePlan = critiquePlan;
window.retryTask = retryTask;
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
    refreshTasks();
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
    }
    document.getElementById("transcript-title").textContent =
      `Planner — attempt ${currentTranscript.attempt} — ${currentTranscript.model ?? currentTranscript.executorUsed}`;
    transcriptMeta.innerHTML = `
      <span>tokens: ${currentTranscript.tokenInput ?? "?"} in / ${currentTranscript.tokenOutput ?? "?"} out</span>
      <span>elapsed: ${formatElapsed(currentTranscript.elapsedSeconds)}</span>
      <span>executor: ${esc(currentTranscript.executorUsed)}</span>
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
    }
  } catch {
    // best-effort; fall back to default
  }
}

// --- Init ---
loadConfig();
connectSSE();
refreshTasks();
