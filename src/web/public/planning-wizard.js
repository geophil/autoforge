function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function oneLine(str) {
  return String(str ?? "").replace(/\s+/g, " ").trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function getWizardSteps() {
  return ["Describe", "Spec", "Plan", "Execute"];
}

function classifyWizardPhase(task) {
  const state = task?.state;
  if (state === "awaiting_spec_approval") {
    return { step: "Spec", status: "needs_operator" };
  }
  if (state === "awaiting_plan_approval") {
    return { step: "Plan", status: "needs_operator" };
  }
  if (state === "planning" || state === "assessing" || state === "received") {
    return { step: "Spec", status: "waiting_on_planner" };
  }
  if (state === "replanning") {
    const hasSubtasks = toArray(task?.planSubtasks).length > 0;
    return hasSubtasks
      ? { step: "Plan", status: "waiting_on_planner" }
      : { step: "Spec", status: "waiting_on_planner" };
  }
  if (
    state === "executing" ||
    state === "reviewing" ||
    state === "reworking" ||
    state === "awaiting_approval" ||
    state === "pr_created" ||
    state === "documenting" ||
    state === "awaiting_intervention" ||
    state === "completed" ||
    state === "failed"
  ) {
    return { step: "Execute", status: state === "failed" ? "blocked" : "running" };
  }
  return { step: "Describe", status: "idle" };
}

function getSpecReviewMode(task) {
  const question = oneLine(task?.currentBlockingQuestion);
  if (question) {
    return {
      mode: "blocking_question",
      promptLabel: "Answer the planner question",
      submitLabel: "Submit answer"
    };
  }
  return {
    mode: "critique",
    promptLabel: "Critique the spec",
    submitLabel: "Revise spec"
  };
}

function buildQmdEvidence(task) {
  const qmd = task?.planningContext?.qmdContext;
  if (!qmd || typeof qmd !== "object") {
    return { state: "none", chips: [], fallbackReason: null, queries: [], documents: [] };
  }
  const queries = toArray(qmd.queries).map((x) => oneLine(x)).filter(Boolean);
  const documents = toArray(qmd.documents).map((x) => oneLine(x)).filter(Boolean);
  if (qmd.status === "used") {
    return {
      state: "used",
      chips: [
        "QMD used",
        `Phase: ${qmd.phase || "unknown"}`,
        `${queries.length} quer${queries.length === 1 ? "y" : "ies"}`,
        `${documents.length} doc${documents.length === 1 ? "" : "s"}`
      ],
      fallbackReason: null,
      queries,
      documents
    };
  }
  return {
    state: "fallback",
    chips: [
      "QMD fallback",
      `Phase: ${qmd.phase || "unknown"}`
    ],
    fallbackReason: oneLine(qmd.fallbackReason) || "unknown",
    queries,
    documents
  };
}

function getPromptChips(kind, mode) {
  if (kind === "spec" && mode === "blocking_question") {
    return [
      "Answer explicitly with assumptions",
      "State what is out of scope",
      "Include acceptance impact"
    ];
  }
  if (kind === "spec") {
    return [
      "Tighten acceptance criteria",
      "Call out hidden constraints",
      "Reduce ambiguity in desired behavior"
    ];
  }
  return [
    "Split into smaller subtasks",
    "Add explicit dependencies",
    "Add concrete verification criteria"
  ];
}

function renderChips(targetId, chips) {
  if (!chips.length) return "";
  return `
    <div class="wizard-chip-row">
      ${chips.map((chip) => (
        `<button type="button" class="btn btn-ghost btn-sm wizard-suggest-chip"
          data-chip-target="${escHtml(targetId)}"
          data-chip="${escHtml(chip)}">${escHtml(chip)}</button>`
      )).join("")}
    </div>
  `;
}

function renderHistoryDrawer(label, transcripts, maxAttempts) {
  const rows = toArray(transcripts);
  const currentAttempt = rows.length;
  const dots = Array.from({ length: maxAttempts }, (_, idx) => {
    const n = idx + 1;
    const match = rows[idx];
    if (match) {
      return `<button class="step-dot ${idx === rows.length - 1 ? "current" : ""}" onclick="openTranscript('${escHtml(match.id)}')" title="View ${escHtml(label)} attempt #${n}">${n}</button>`;
    }
    return `<span class="step-dot future" title="${escHtml(label)} attempt #${n} (not attempted)">${n}</span>`;
  }).join("");
  const links = rows.length === 0
    ? `<div class="wizard-history-empty">No ${escHtml(label.toLowerCase())} attempts yet.</div>`
    : rows
      .map((row, idx) => (
        `<a href="#" class="wizard-history-link" onclick="openTranscript('${escHtml(row.id)}'); return false;">
          ${escHtml(label)} #${idx + 1}
        </a>`
      ))
      .join("");
  return `
    <details class="wizard-history">
      <summary>${escHtml(label)} history (${currentAttempt}/${maxAttempts})</summary>
      <div class="plan-review-stepper">${dots}</div>
      <div class="wizard-history-links">${links}</div>
    </details>
  `;
}

function renderListCard(title, items) {
  const values = toArray(items).map((x) => oneLine(x)).filter(Boolean);
  if (!values.length) return "";
  return `
    <section class="wizard-card">
      <h4>${escHtml(title)}</h4>
      <ul>
        ${values.map((value) => `<li>${escHtml(value)}</li>`).join("")}
      </ul>
    </section>
  `;
}

function renderTextCard(title, value) {
  const text = oneLine(value);
  if (!text) return "";
  return `
    <section class="wizard-card">
      <h4>${escHtml(title)}</h4>
      <p>${escHtml(text)}</p>
    </section>
  `;
}

function renderDecisionCard(decisions) {
  const rows = toArray(decisions).filter((x) => x && typeof x === "object");
  if (!rows.length) return "";
  return `
    <section class="wizard-card">
      <h4>Decisions</h4>
      <div class="wizard-decision-list">
        ${rows.map((row) => {
          const decision = oneLine(row.decision) || "(decision)";
          const reason = oneLine(row.reason);
          const consequence = oneLine(row.consequence);
          const alternatives = toArray(row.alternativesRejected).map((x) => oneLine(x)).filter(Boolean);
          return `
            <article class="wizard-decision-item">
              <div class="wizard-decision-title">${escHtml(decision)}</div>
              ${reason ? `<p>${escHtml(reason)}</p>` : ""}
              ${alternatives.length ? `<p><strong>Alternatives:</strong> ${escHtml(alternatives.join("; "))}</p>` : ""}
              ${consequence ? `<p><strong>Consequence:</strong> ${escHtml(consequence)}</p>` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderQmdEvidence(task) {
  const qmd = buildQmdEvidence(task);
  if (qmd.state === "none") return "";
  return `
    <section class="wizard-card wizard-qmd-card wizard-qmd-${escHtml(qmd.state)}">
      <h4>QMD Evidence</h4>
      <div class="wizard-chip-list">
        ${qmd.chips.map((chip) => `<span class="wizard-chip">${escHtml(chip)}</span>`).join("")}
      </div>
      ${qmd.fallbackReason ? `<p class="wizard-qmd-note"><strong>Fallback reason:</strong> ${escHtml(qmd.fallbackReason)}</p>` : ""}
      ${qmd.documents.length
        ? `<p class="wizard-qmd-note"><strong>Documents:</strong> ${escHtml(qmd.documents.join(", "))}</p>`
        : ""}
    </section>
  `;
}

function renderSpecCards(task) {
  const specArtifacts = task?.specArtifacts;
  if (!specArtifacts || typeof specArtifacts !== "object") {
    return `
      <section class="wizard-card">
        <h4>Spec not available yet</h4>
        <p>The planner has not returned a structured discovery/spec payload for this attempt.</p>
      </section>
    `;
  }
  const discovery = specArtifacts.discovery && typeof specArtifacts.discovery === "object"
    ? specArtifacts.discovery
    : {};
  const spec = specArtifacts.spec && typeof specArtifacts.spec === "object"
    ? specArtifacts.spec
    : {};
  return `
    ${renderTextCard("Intent", discovery.intent)}
    ${renderTextCard("Problem", spec.problem)}
    ${renderListCard("Constraints", discovery.constraints)}
    ${renderListCard("Assumptions", discovery.assumptions)}
    ${renderDecisionCard(discovery.decisions)}
    ${renderListCard("Rejected alternatives", discovery.rejectedAlternatives)}
    ${renderListCard("Non-goals", discovery.nonGoals)}
    ${renderListCard("Desired behavior", spec.desiredBehavior)}
    ${renderListCard("Acceptance criteria", spec.acceptanceCriteria)}
    ${renderListCard("Verification", spec.verification)}
    ${renderListCard("Risks", spec.risks)}
    ${renderListCard("Open questions", discovery.openQuestions)}
    ${renderQmdEvidence(task)}
  `;
}

function renderSharedUnderstanding(task) {
  const specArtifacts = task?.specArtifacts;
  if (!specArtifacts || typeof specArtifacts !== "object") return "";
  const discovery = specArtifacts.discovery && typeof specArtifacts.discovery === "object"
    ? specArtifacts.discovery
    : {};
  const spec = specArtifacts.spec && typeof specArtifacts.spec === "object"
    ? specArtifacts.spec
    : {};
  return `
    <details class="wizard-shared-understanding">
      <summary>Shared understanding</summary>
      <div class="wizard-shared-grid">
        ${renderTextCard("Intent", discovery.intent)}
        ${renderTextCard("Problem", spec.problem)}
        ${renderListCard("Desired behavior", spec.desiredBehavior)}
        ${renderListCard("Acceptance criteria", spec.acceptanceCriteria)}
      </div>
    </details>
  `;
}

function humanizeDependency(dep, subtasksById) {
  if (typeof dep !== "string" || !dep) return "";
  if (subtasksById.has(dep)) {
    return `#${subtasksById.get(dep)}`;
  }
  const match = dep.match(/subtask-(\d+)$/);
  if (match) return `#${match[1]}`;
  return dep;
}

function buildContractWarnings(subtask, options = {}) {
  const tier = oneLine(options.tier);
  const files = toArray(subtask?.filesInScope).map((x) => oneLine(x)).filter(Boolean);
  const verification = toArray(subtask?.verificationCommands).map((x) => oneLine(x)).filter(Boolean);
  const evidence = toArray(subtask?.completionEvidence).map((x) => oneLine(x)).filter(Boolean);
  const tests = toArray(subtask?.testCriteria).map((x) => oneLine(x)).filter(Boolean);
  const warnings = [];

  if (!oneLine(subtask?.behavior)) {
    warnings.push({ level: "blocking", message: "Missing behavior contract." });
  }
  if (!files.length) {
    warnings.push({ level: "blocking", message: "Missing files in scope." });
  }
  if (!verification.length) {
    warnings.push({ level: "blocking", message: "Missing verification commands." });
  }
  if (!tests.length) {
    warnings.push({ level: "blocking", message: "Missing test criteria." });
  }
  if (!evidence.length) {
    warnings.push({ level: "blocking", message: "Missing completion evidence." });
  }

  if (files.some((file) => file === "src" || file === "src/" || file === "." || file === "./")) {
    warnings.push({ level: "advisory", message: "Scope is broad; consider naming specific files or directories." });
  }

  const genericEvidence = new Set([
    "passes",
    "tests pass",
    "all tests pass",
    "run tests",
    "run the tests",
    "test output shows passing"
  ]);
  if (evidence.some((item) => genericEvidence.has(item.toLowerCase()))) {
    warnings.push({ level: "advisory", message: "Completion evidence is generic; ask for concrete output or artifact evidence." });
  }

  if (tier === "THOROUGH") {
    const joinedVerification = verification.join(" ").toLowerCase();
    const hasRuntimeCheck = /(runtime|integration|e2e|end-to-end|playwright|cypress|dev server|smoke)/.test(joinedVerification);
    if (!hasRuntimeCheck) {
      warnings.push({ level: "advisory", message: "THOROUGH work should include runtime, integration, or end-to-end verification." });
    }
  }

  return warnings;
}

function renderContractList(title, values) {
  const list = toArray(values).map((x) => oneLine(x)).filter(Boolean);
  return `
    <div class="wizard-contract-field">
      <div class="wizard-contract-label">${escHtml(title)}</div>
      ${list.length
        ? `<ul>${list.map((item) => `<li>${escHtml(item)}</li>`).join("")}</ul>`
        : `<p class="wizard-contract-empty">-</p>`}
    </div>
  `;
}

function renderContractWarnings(warnings) {
  if (!warnings.length) {
    return `<div class="wizard-contract-ok">Contract fields are present. Advisory warnings are absent.</div>`;
  }
  return `
    <div class="wizard-contract-warnings">
      <div class="wizard-contract-warning-note">Warnings are advisory unless marked blocking by the execution contract gate.</div>
      ${warnings.map((warning) => `
        <div class="wizard-contract-warning wizard-contract-warning-${escHtml(warning.level)}">
          <span>${escHtml(warning.level)}</span>
          ${escHtml(warning.message)}
        </div>
      `).join("")}
    </div>
  `;
}

function renderPlanSubtaskCards(subtasks, options = {}) {
  const list = toArray(subtasks);
  const map = new Map();
  list.forEach((subtask, idx) => {
    if (subtask && typeof subtask.id === "string") {
      map.set(subtask.id, subtask.sequence ?? idx + 1);
    }
  });
  return list.map((subtask, idx) => {
    const sequence = subtask?.sequence ?? idx + 1;
    const description = oneLine(subtask?.description) || `Subtask ${sequence}`;
    const behavior = oneLine(subtask?.behavior);
    const agent = oneLine(subtask?.agentType) || "coder";
    const files = toArray(subtask?.filesInScope).map((x) => oneLine(x)).filter(Boolean);
    const deps = toArray(subtask?.dependencies).map((x) => humanizeDependency(x, map)).filter(Boolean);
    const tests = toArray(subtask?.testCriteria).map((x) => oneLine(x)).filter(Boolean);
    const warnings = buildContractWarnings(subtask, options);
    return `
      <article class="wizard-subtask-card">
        <header>
          <span class="wizard-subtask-seq">#${sequence}</span>
          <span class="wizard-subtask-agent">${escHtml(agent)}</span>
          <span class="wizard-subtask-wip">WIP order ${sequence}</span>
        </header>
        <h4>${escHtml(description)}</h4>
        ${behavior ? `<p class="wizard-subtask-behavior">${escHtml(behavior)}</p>` : ""}
        <p><strong>Depends on:</strong> ${deps.length ? escHtml(deps.join(", ")) : "-"}</p>
        ${renderContractList("Files in scope", files)}
        ${renderContractList("Verification commands", subtask?.verificationCommands)}
        ${renderContractList("Test criteria", tests)}
        ${renderContractList("Completion evidence", subtask?.completionEvidence)}
        ${renderContractWarnings(warnings)}
      </article>
    `;
  }).join("");
}

function renderStepper(currentStep) {
  const steps = getWizardSteps();
  const currentIndex = steps.indexOf(currentStep);
  return `
    <div class="wizard-step-track" aria-label="Planning wizard progress">
      ${steps.map((step, idx) => {
        const state = idx < currentIndex ? "done" : idx === currentIndex ? "current" : "todo";
        return `
          <div class="wizard-step ${state}">
            <span class="wizard-step-dot">${idx + 1}</span>
            <span class="wizard-step-label">${escHtml(step)}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderSpecReviewPanel(task, options) {
  const maxAttempts = Number(options?.maxAttempts || 1);
  const attemptCount = Number(task?.specAttempt || 0);
  const mode = getSpecReviewMode(task);
  const reviewState = classifyWizardPhase(task);
  const pendingSubmission = options?.pendingSubmission || null;
  const reviseDisabled = attemptCount >= (maxAttempts - 1);
  const disableActions = reviseDisabled || Boolean(pendingSubmission);
  const blockingQuestion = oneLine(task?.currentBlockingQuestion);
  const chips = getPromptChips("spec", mode.mode);
  return `
    <div class="task-detail-actions wizard-panel">
      ${renderStepper(reviewState.step)}
      <div class="wizard-header-row">
        <h3 class="wizard-title">Spec review</h3>
        <span class="wizard-attempt">Attempt ${attemptCount + 1} / ${maxAttempts}</span>
      </div>
      ${renderHistoryDrawer("Spec", task?.specTranscripts, maxAttempts)}
      ${blockingQuestion ? `<div class="wizard-blocking-question"><strong>Blocking question:</strong> ${escHtml(blockingQuestion)}</div>` : ""}
      ${pendingSubmission
        ? `<div class="wizard-pending-note"><strong>Submitted:</strong> ${escHtml(pendingSubmission.text)}</div>`
        : ""}
      <div class="wizard-card-grid">
        ${renderSpecCards(task)}
      </div>
      <div class="critique-wrapper">
        <label class="wizard-input-label" for="critique-spec-input">${escHtml(mode.promptLabel)}</label>
        <textarea id="critique-spec-input" class="critique-input" rows="4"
          data-mode="${escHtml(mode.mode)}"
          data-attempt="${attemptCount}"
          placeholder="${mode.mode === "blocking_question"
            ? "Provide a direct answer so the planner can continue."
            : "Optional: critique the discovery/spec to request a revision."}"
          maxlength="4000"></textarea>
        <div class="critique-counter" id="critique-spec-counter">0 / 4000</div>
      </div>
      ${renderChips("critique-spec-input", chips)}
      <div class="plan-review-buttons">
        <button class="btn btn-approve" onclick="approveSpec('${escHtml(task.id)}', this)" ${pendingSubmission ? "disabled" : ""}>
          Approve spec &amp; plan next
        </button>
        <button class="btn btn-secondary" id="btn-critique-spec"
          onclick="critiqueSpec('${escHtml(task.id)}', this)" ${disableActions ? "disabled" : ""}>
          ${escHtml(mode.submitLabel)}${reviseDisabled ? " (limit reached)" : ""}
        </button>
        <button class="btn btn-ghost btn-sm" onclick="cancelTask('${escHtml(task.id)}')" style="margin-left:auto">Cancel</button>
      </div>
    </div>
  `;
}

function renderPlanReviewPanel(task, options) {
  const maxAttempts = Number(options?.maxAttempts || 1);
  const attemptCount = Number(task?.planAttempt || 0);
  const reviewState = classifyWizardPhase(task);
  const pendingSubmission = options?.pendingSubmission || null;
  const reviseDisabled = attemptCount >= (maxAttempts - 1);
  const disableActions = reviseDisabled || Boolean(pendingSubmission);
  const chips = getPromptChips("plan");
  return `
    <div class="task-detail-actions wizard-panel">
      ${renderStepper(reviewState.step)}
      <div class="wizard-header-row">
        <h3 class="wizard-title">Plan review</h3>
        <span class="wizard-attempt">Attempt ${attemptCount + 1} / ${maxAttempts}</span>
      </div>
      ${renderHistoryDrawer("Plan", task?.planTranscripts, maxAttempts)}
      ${pendingSubmission
        ? `<div class="wizard-pending-note"><strong>Submitted:</strong> ${escHtml(pendingSubmission.text)}</div>`
        : ""}
      ${renderSharedUnderstanding(task)}
      <section class="wizard-card wizard-plan-card">
        <h4>Execution subtasks</h4>
        <div class="wizard-subtask-grid">
          ${renderPlanSubtaskCards(task?.planSubtasks, { tier: task?.tier })}
        </div>
      </section>
      ${renderQmdEvidence(task)}
      <div class="critique-wrapper">
        <label class="wizard-input-label" for="critique-input">Critique the plan</label>
        <textarea id="critique-input" class="critique-input" rows="4"
          data-attempt="${attemptCount}"
          placeholder="Optional: describe what should change in the plan."
          maxlength="4000"></textarea>
        <div class="critique-counter" id="critique-counter">0 / 4000</div>
      </div>
      ${renderChips("critique-input", chips)}
      <div class="plan-review-buttons">
        <button class="btn btn-approve" onclick="approvePlan('${escHtml(task.id)}', this)" ${pendingSubmission ? "disabled" : ""}>Approve &amp; continue</button>
        <button class="btn btn-secondary" id="btn-critique"
          onclick="critiquePlan('${escHtml(task.id)}', this)" ${disableActions ? "disabled" : ""}>
          Revise plan${reviseDisabled ? " (limit reached)" : ""}
        </button>
        <button class="btn btn-ghost btn-sm" onclick="cancelTask('${escHtml(task.id)}')" style="margin-left:auto">Cancel</button>
      </div>
    </div>
  `;
}

const api = {
  getWizardSteps,
  classifyWizardPhase,
  getSpecReviewMode,
  buildQmdEvidence,
  getPromptChips,
  buildContractWarnings,
  renderPlanSubtaskCards,
  renderSpecReviewPanel,
  renderPlanReviewPanel
};

if (typeof window !== "undefined") {
  window.PlanningWizard = api;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
