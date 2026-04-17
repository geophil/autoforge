const API = "";

// --- State ---
let tasks = [];
let currentTaskId = null;

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

function renderTaskList() {
  if (tasks.length === 0) {
    taskList.innerHTML = `<div class="empty-state">No tasks yet. Submit one to get started.</div>`;
    return;
  }

  taskList.innerHTML = tasks
    .map(
      (t) => `
    <div class="task-card" data-id="${t.id}">
      <div class="task-card-body">
        <div class="task-card-description">${esc(t.description)}</div>
        <div class="task-card-meta">
          <code>${t.id.slice(0, 8)}</code>
          <span>${timeAgo(t.createdAt)}</span>
          ${t.iteration > 0 ? `<span>iteration ${t.iteration}</span>` : ""}
        </div>
      </div>
      <div class="task-card-right">
        <span class="badge badge-tier">${t.tier}</span>
        <span class="badge badge-state" data-state="${t.state}">${formatState(t.state)}</span>
      </div>
    </div>`
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
    const [taskRes, transcriptsRes] = await Promise.all([
      fetch(`${API}/api/tasks/${taskId}`),
      fetch(`${API}/api/transcripts/by-task/${taskId}`)
    ]);
    if (!taskRes.ok) {
      detailContent.innerHTML = `<div class="empty-state">Task not found.</div>`;
      return;
    }
    const task = await taskRes.json();
    const transcripts = transcriptsRes.ok ? await transcriptsRes.json() : [];
    task.planAttempt = transcripts.length === 0 ? 0 : Math.max(...transcripts.map((t) => t.attempt));
    task.transcripts = transcripts;
    renderTaskDetail(task);
  } catch {
    detailContent.innerHTML = `<div class="empty-state">Failed to load task.</div>`;
  }
}

function renderTaskDetail(task) {
  const assessment = task.assessment || {};
  const subtasks = task.planSubtasks || [];

  const terminalStates = ["completed", "failed"];
  const nonTerminalStates = ["received", "assessing", "planning", "awaiting_plan_approval", "replanning", "executing", "reviewing", "reworking", "pr_created", "awaiting_approval", "documenting"];
  let actionsHtml = "";
  if (task.state === "awaiting_plan_approval") {
    const attemptCount = task.planAttempt ?? 0;
    const maxAttempts = (window.PLANNER_MAX_ITERATIONS ?? 3) + 1;
    const planNum = attemptCount + 1;
    const reviseDisabled = attemptCount >= (maxAttempts - 1);
    const latestTranscript = (task.transcripts ?? []).slice(-1)[0];
    const viewLink = latestTranscript
      ? `<a href="#" onclick="openTranscript('${latestTranscript.id}'); return false;" class="view-transcript-link">View transcript →</a>`
      : "";
    actionsHtml = `
      <div class="task-detail-actions plan-review">
        <h3 class="plan-review-title">Plan Review — plan #${planNum} of ${maxAttempts} ${viewLink}</h3>
        <textarea id="critique-input" class="critique-input" rows="4"
          placeholder="Optional: leave a natural-language critique to revise the plan."></textarea>
        <div class="plan-review-buttons">
          <button class="btn btn-approve" onclick="approvePlan('${task.id}')">Approve &amp; Continue</button>
          <button class="btn btn-secondary" id="btn-critique"
            onclick="critiquePlan('${task.id}')" ${reviseDisabled ? "disabled" : ""}>
            Revise Plan${reviseDisabled ? " (limit reached)" : ""}
          </button>
          <button class="btn btn-ghost btn-sm" onclick="cancelTask('${task.id}')" style="margin-left:auto">Cancel</button>
        </div>
      </div>`;
  } else if (task.state === "awaiting_approval") {
    actionsHtml = `
      <div class="task-detail-actions">
        <button class="btn btn-approve" onclick="approveTask('${task.id}')">Approve &amp; Merge</button>
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

  detailContent.innerHTML = `
    <div class="task-detail-header">
      <h2>${esc(task.description)}</h2>
      <div class="meta-row">
        <span class="badge badge-state" data-state="${task.state}">${formatState(task.state)}</span>
        <span class="badge badge-tier">${task.tier}</span>
        <code style="font-size: 0.75rem; color: var(--text-dim);">${task.id}</code>
        ${prHtml}
      </div>
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

    ${subtasks.length > 0 ? `
    <div class="detail-section">
      <h3>Plan (${subtasks.length} subtask${subtasks.length !== 1 ? "s" : ""})</h3>
      ${subtasks.map((s) => `
        <div class="subtask-item">
          <div class="subtask-header">
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
      `).join("")}
    </div>` : ""}

    <div class="detail-section" id="findings-section">
      <h3>Pipeline Event Log</h3>
      <div id="cost-summary" class="cost-summary"></div>
      <div id="findings-list"><span style="color: var(--text-dim); font-size: 0.85rem;">Loading...</span></div>
    </div>
  `;

  loadEvents(task.id);
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
  } catch {
    container.innerHTML = `<span style="color: var(--text-dim); font-size: 0.85rem;">Could not load events.</span>`;
  }
}

// --- Task Actions ---
async function approveTask(taskId) {
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/approve`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    toast("Task approved and merged.", "success");
    refreshTasks();
    refreshTaskDetail(taskId);
  } catch (err) {
    toast(`Approval failed: ${err.message}`, "error");
  }
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

async function cancelTask(taskId) {
  const reason = prompt("Cancel reason (optional):", "Cancelled by operator.") ?? "Cancelled by operator.";
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
  }
}

async function approvePlan(taskId) {
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/approve-plan`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    toast("Plan approved — execution starting…", "success");
    refreshTasks();
    refreshTaskDetail(taskId);
  } catch (err) {
    toast(`Approve plan failed: ${err.message}`, "error");
  }
}

async function critiquePlan(taskId) {
  const input = document.getElementById("critique-input");
  const critique = (input?.value ?? "").trim();
  if (!critique) {
    toast("Please enter a critique to revise the plan.", "error");
    return;
  }
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
}

// Make actions available from inline onclick handlers
window.approveTask = approveTask;
window.rejectTask = rejectTask;
window.cancelTask = cancelTask;
window.approvePlan = approvePlan;
window.critiquePlan = critiquePlan;
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
  };
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  // Close the dialog immediately so the user never sees a still-open
  // dialog after clicking submit. Backend kicks off the planner which
  // can run for minutes, and we don't want the user to double-click.
  dialogTask.close();
  form.reset();
  form.projectId.value = "autoforge";
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
let currentTab = "system";

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
    document.getElementById("transcript-title").textContent =
      `Planner — attempt ${currentTranscript.attempt} — ${currentTranscript.model ?? currentTranscript.executorUsed}`;
    transcriptMeta.innerHTML = `
      <span>tokens: ${currentTranscript.tokenInput ?? "?"} in / ${currentTranscript.tokenOutput ?? "?"} out</span>
      <span>elapsed: ${formatElapsed(currentTranscript.elapsedSeconds)}</span>
      <span>executor: ${esc(currentTranscript.executorUsed)}</span>
    `;
    currentTab = "system";
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === "system")
    );
    renderTranscriptTab();
    dialogTranscript.showModal();
  } catch (err) {
    toast(`Failed to load transcript: ${err.message}`, "error");
  }
}
window.openTranscript = openTranscript;

function renderTranscriptTab() {
  if (!currentTranscript) return;
  if (currentTab === "system") {
    transcriptPane.innerHTML = `<pre class="prompt-block">${esc(currentTranscript.systemPrompt)}</pre>`;
  } else if (currentTab === "user") {
    transcriptPane.innerHTML = `<pre class="prompt-block">${esc(currentTranscript.userPrompt)}</pre>`;
    if (currentTranscript.critique) {
      transcriptPane.innerHTML += `<div class="critique-block"><strong>Critique that triggered this attempt:</strong><br>${esc(currentTranscript.critique)}</div>`;
    }
  } else if (currentTab === "transcript") {
    const lines = (currentTranscript.transcript || "").split("\n").filter(Boolean);
    if (lines.length === 0) {
      transcriptPane.innerHTML = `<div class="empty-state">No transcript captured (executor did not emit turns).</div>`;
      return;
    }
    transcriptPane.innerHTML = lines.map((line) => {
      let turn;
      try { turn = JSON.parse(line); } catch { return ""; }
      if (turn.kind === "compaction") {
        return `<div class="turn-compaction">— history compacted (${turn.droppedTurns} turns dropped) —</div>`;
      }
      if (turn.kind === "tool_result") {
        return `<details class="turn turn-tool-result"><summary>tool_result <code>${esc(turn.toolUseId)}</code></summary><pre>${esc(turn.content)}</pre></details>`;
      }
      const blocks = (turn.content || []).map((b) => {
        if (b.type === "text") return `<div class="block-text">${esc(b.text)}</div>`;
        if (b.type === "tool_use") return `<details class="turn turn-tool-use"><summary>tool_use <strong>${esc(b.name)}</strong></summary><pre>${esc(JSON.stringify(b.input, null, 2))}</pre></details>`;
        if (b.type === "mcp_tool_use") return `<details class="turn turn-mcp"><summary><span class="mcp-badge">qmd</span> ${esc(b.name)}</summary><pre>${esc(JSON.stringify(b.input ?? {}, null, 2))}</pre></details>`;
        return `<div class="block-other">${esc(JSON.stringify(b))}</div>`;
      }).join("");
      return `<div class="turn turn-assistant">${blocks}</div>`;
    }).join("");
  } else if (currentTab === "output") {
    let output;
    try { output = JSON.parse(currentTranscript.output ?? "null"); } catch { output = currentTranscript.output; }
    transcriptPane.innerHTML = `<pre class="output-block">${esc(JSON.stringify(output, null, 2))}</pre>`;
  }
}

// --- Init ---
connectSSE();
refreshTasks();
