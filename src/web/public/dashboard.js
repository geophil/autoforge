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

  es.addEventListener("connected", () => {
    badge.textContent = "live";
    badge.className = "connection-badge connected";
  });

  es.addEventListener("task.updated", () => {
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
    const res = await fetch(`${API}/api/tasks/${taskId}`);
    if (!res.ok) {
      detailContent.innerHTML = `<div class="empty-state">Task not found.</div>`;
      return;
    }
    const task = await res.json();
    renderTaskDetail(task);
  } catch {
    detailContent.innerHTML = `<div class="empty-state">Failed to load task.</div>`;
  }
}

function renderTaskDetail(task) {
  const assessment = task.assessment || {};
  const subtasks = task.planSubtasks || [];

  let actionsHtml = "";
  if (task.state === "awaiting_approval") {
    actionsHtml = `
      <div class="task-detail-actions">
        <button class="btn btn-approve" onclick="approveTask('${task.id}')">Approve &amp; Merge</button>
        <button class="btn btn-reject" onclick="rejectTask('${task.id}')">Reject</button>
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
          <span class="subtask-seq">#${s.sequence}</span>
          ${esc(s.description)}
          ${s.filesInScope?.length ? `<div class="subtask-files">${s.filesInScope.join(", ")}</div>` : ""}
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

async function loadEvents(taskId) {
  const container = document.getElementById("findings-list");
  const costSummary = document.getElementById("cost-summary");
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/events`);
    const events = await res.json();
    if (events.length === 0) {
      container.innerHTML = `<span style="color: var(--text-dim); font-size: 0.85rem;">No events yet.</span>`;
      return;
    }
    container.innerHTML = events
      .map((ev) => {
        const color = agentColor(ev.agent);
        const elapsed = ev.elapsedSeconds !== null ? `<span class="tl-meta">${formatElapsed(ev.elapsedSeconds)}</span>` : "";
        const tokens = ev.tokenUsage ? `<span class="tl-meta">${ev.tokenUsage.input + ev.tokenUsage.output} tok</span>` : "";
        return `
          <div class="tl-item">
            <span class="tl-dot" style="background:${color}"></span>
            <div class="tl-body">
              <span class="tl-agent" style="color:${color}">${esc(ev.agent)}</span>
              <span class="tl-type">${esc(ev.type)}</span>
              ${elapsed}${tokens}
              <span class="tl-time">${timeAgo(ev.timestamp)}</span>
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

async function rejectTask(taskId) {
  const reason = prompt("Rejection reason:");
  if (!reason) return;
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error(await res.text());
    toast("Task rejected — rework queued.", "success");
    refreshTasks();
    refreshTaskDetail(taskId);
  } catch (err) {
    toast(`Rejection failed: ${err.message}`, "error");
  }
}

// Make actions available from inline onclick handlers
window.approveTask = approveTask;
window.rejectTask = rejectTask;

// --- New Task Dialog ---
const dialogTask = document.getElementById("dialog-new-task");
document.getElementById("btn-new-task").addEventListener("click", () => dialogTask.showModal());
document.getElementById("btn-cancel-task").addEventListener("click", () => dialogTask.close());

document.getElementById("form-new-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    projectId: form.projectId.value.trim(),
    description: form.description.value.trim(),
  };
  try {
    const res = await fetch(`${API}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    toast("Task submitted.", "success");
    form.reset();
    form.projectId.value = "autoforge";
    dialogTask.close();
    refreshTasks();
  } catch (err) {
    toast(`Submit failed: ${err.message}`, "error");
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
  const body = {
    projectId: form.projectId.value.trim(),
    focus: form.focus.value.trim() || undefined,
  };
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
    dialogMeta.close();
    form.reset();
    form.projectId.value = "autoforge";
  } catch (err) {
    toast(`Meta agent failed: ${err.message}`, "error");
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

// --- Init ---
connectSSE();
refreshTasks();
