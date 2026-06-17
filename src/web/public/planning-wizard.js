(() => {
const { escHtml, oneLine, toArray } =
  typeof window !== "undefined" && window.UiHelpers
    ? window.UiHelpers
    : (typeof UiHelpers !== "undefined" ? UiHelpers : {});

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

function truncateReviewText(value, max = 150) {
  const text = oneLine(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function buildFeedbackSeed(title, value) {
  const text = truncateReviewText(value, 180);
  return text
    ? `${title}: "${text}" — `
    : `${title}: `;
}

function renderCommentButton(title, value, targetId = "critique-spec-input") {
  return `
    <button type="button" class="wizard-comment-button"
      data-feedback-target="${escHtml(targetId)}"
      data-feedback-seed="${escHtml(buildFeedbackSeed(title, value))}">
      Comment
    </button>
  `;
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

function isWideReviewSection(values) {
  return values.length > 3 || values.some((value) => oneLine(value).length > 120);
}

function renderListCard(title, items) {
  const values = toArray(items).map((x) => oneLine(x)).filter(Boolean);
  if (!values.length) return "";
  const wideClass = isWideReviewSection(values) ? " wizard-review-wide" : "";
  return `
    <details class="wizard-review-section${wideClass}" open>
      <summary>
        <span class="wizard-review-title">${escHtml(title)}</span>
        <span class="wizard-review-count">${values.length} ${values.length === 1 ? "item" : "items"}</span>
        ${renderCommentButton(title, values.join("; "))}
      </summary>
      <ul class="wizard-review-list">
        ${values.map((value) => `
          <li class="wizard-review-item">
            <span>${escHtml(value)}</span>
            ${renderCommentButton(title, value)}
          </li>
        `).join("")}
      </ul>
    </details>
  `;
}

function renderTextCard(title, value) {
  const text = oneLine(value);
  if (!text) return "";
  const wideClass = text.length > 180 ? " wizard-review-wide" : "";
  return `
    <details class="wizard-review-section${wideClass}" open>
      <summary>
        <span class="wizard-review-title">${escHtml(title)}</span>
        <span class="wizard-review-count">1 item</span>
        ${renderCommentButton(title, text)}
      </summary>
      <div class="wizard-review-text">${escHtml(text)}</div>
    </details>
  `;
}

function renderDecisionCard(decisions) {
  const rows = toArray(decisions).filter((x) => x && typeof x === "object");
  if (!rows.length) return "";
  return `
    <details class="wizard-review-section" open>
      <summary>
        <span class="wizard-review-title">Decisions</span>
        <span class="wizard-review-count">${rows.length} ${rows.length === 1 ? "item" : "items"}</span>
        ${renderCommentButton("Decisions", rows.map((row) => row?.decision).join("; "))}
      </summary>
      <div class="wizard-decision-list">
        ${rows.map((row) => {
          const decision = oneLine(row.decision) || "(decision)";
          const reason = oneLine(row.reason);
          const consequence = oneLine(row.consequence);
          const alternatives = toArray(row.alternativesRejected).map((x) => oneLine(x)).filter(Boolean);
          return `
            <article class="wizard-decision-item">
              <div class="wizard-decision-title">
                <span>${escHtml(decision)}</span>
                ${renderCommentButton("Decision", decision)}
              </div>
              ${reason ? `<p>${escHtml(reason)}</p>` : ""}
              ${alternatives.length ? `<p><strong>Alternatives:</strong> ${escHtml(alternatives.join("; "))}</p>` : ""}
              ${consequence ? `<p><strong>Consequence:</strong> ${escHtml(consequence)}</p>` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </details>
  `;
}

function renderQmdEvidence(task) {
  const qmd = buildQmdEvidence(task);
  if (qmd.state === "none") return "";
  return `
    <details class="wizard-review-section wizard-qmd-card wizard-qmd-${escHtml(qmd.state)}" open>
      <summary>
        <span class="wizard-review-title">QMD Evidence</span>
        <span class="wizard-review-count">${escHtml(qmd.state)}</span>
        ${renderCommentButton("QMD Evidence", [...qmd.chips, qmd.fallbackReason, ...qmd.documents].filter(Boolean).join("; "))}
      </summary>
      <div class="wizard-chip-list">
        ${qmd.chips.map((chip) => `<span class="wizard-chip">${escHtml(chip)}</span>`).join("")}
      </div>
      ${qmd.fallbackReason ? `<p class="wizard-qmd-note"><strong>Fallback reason:</strong> ${escHtml(qmd.fallbackReason)}</p>` : ""}
      ${qmd.documents.length
        ? `<p class="wizard-qmd-note"><strong>Documents:</strong> ${escHtml(qmd.documents.join(", "))}</p>`
        : ""}
    </details>
  `;
}

function renderSpecCards(task) {
  const specArtifacts = task?.specArtifacts;
  if (!specArtifacts || typeof specArtifacts !== "object") {
    return `
      <details class="wizard-review-section" open>
        <summary>
          <span class="wizard-review-title">Spec not available yet</span>
          <span class="wizard-review-count">empty</span>
        </summary>
        <div class="wizard-review-text">The planner has not returned a structured discovery/spec payload for this attempt.</div>
      </details>
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

  if (subtask?.contractProvided?.behavior === false && oneLine(subtask?.description)) {
    warnings.push({ level: "blocking", message: "Behavior contract is repairable from description before execution." });
  } else if (!oneLine(subtask?.behavior)) {
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
      <div class="wizard-contract-label">
        <span>${escHtml(title)}</span>
        ${renderCommentButton(title, list.join("; "), "critique-input")}
      </div>
      ${list.length
        ? `<ul>${list.map((item) => `
          <li class="wizard-review-item wizard-contract-item">
            <span>${escHtml(item)}</span>
            ${renderCommentButton(title, item, "critique-input")}
          </li>
        `).join("")}</ul>`
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

function renderPlanContractSummary(task) {
  const contract = task?.planContract;
  if (!contract || typeof contract !== "object") return "";
  const invalid = toArray(contract.invalidSubtasks);
  const repairs = toArray(contract.repairs);
  const warnings = toArray(contract.warnings);
  const status = oneLine(contract.status) || "unknown";
  const statusLabel = status === "invalid"
    ? "blocking"
    : status === "repaired"
      ? "repaired"
      : status === "degraded"
        ? "degraded"
        : "valid";
  const rows = [
    ...invalid.map((row) => {
      const missing = toArray(row?.missing).map((x) => oneLine(x)).filter(Boolean);
      return `Subtask ${oneLine(row?.id) || "unknown"} missing ${missing.join(", ") || "required fields"}`;
    }),
    ...repairs.map((repair) => {
      const state = repair?.status === "applied" ? "applied" : "available";
      return `${state}: ${oneLine(repair?.field)} from ${oneLine(repair?.source)} on ${oneLine(repair?.subtaskId)}`;
    }),
    ...warnings.map((warning) => `${oneLine(warning?.level)}: ${oneLine(warning?.message)}`)
  ].filter(Boolean);

  return `
    <details class="wizard-review-section wizard-contract-summary wizard-contract-summary-${escHtml(statusLabel)}" open>
      <summary>
        <span class="wizard-review-title">Plan Contract</span>
        <span class="wizard-review-count">${escHtml(statusLabel)}</span>
        ${renderCommentButton("Plan Contract", rows.join("; ") || statusLabel)}
      </summary>
      ${rows.length
        ? `<ul>${rows.map((row) => `<li class="wizard-review-item">${escHtml(row)}</li>`).join("")}</ul>`
        : `<div class="wizard-contract-ok">Contract is ready for execution.</div>`}
    </details>
  `;
}

function splitSentences(text) {
  const matches = oneLine(text).match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return matches.map((part) => oneLine(part)).filter(Boolean);
}

function splitAtReadableBoundary(text, maxLength = 130) {
  const value = oneLine(text);
  if (value.length <= maxLength) {
    return { head: value, tail: "" };
  }

  const candidates = [
    ". ",
    "; ",
    ": ",
    ", and ",
    ", ensure ",
    ", default",
    ", reject",
    ", add ",
    ", extend ",
    ", wire ",
    ", preserve "
  ];

  let best = -1;
  for (const token of candidates) {
    const idx = value.toLowerCase().lastIndexOf(token, maxLength);
    if (idx > 60 && idx > best) {
      best = idx + token.length;
    }
  }

  if (best === -1) {
    const fallback = value.lastIndexOf(" ", maxLength);
    best = fallback > 60 ? fallback + 1 : maxLength;
  }

  return {
    head: value.slice(0, best).trim(),
    tail: value.slice(best).trim()
  };
}

function buildReadableSubtaskDescription(description) {
  const text = oneLine(description);
  const sentences = splitSentences(text);
  const first = sentences.shift() || text;
  const split = splitAtReadableBoundary(first);
  const headline = split.head || `Subtask`;
  const notes = [split.tail, ...sentences]
    .flatMap((note) => {
      const pieces = [];
      let remaining = oneLine(note);
      while (remaining.length > 180) {
        const next = splitAtReadableBoundary(remaining, 160);
        pieces.push(next.head);
        remaining = next.tail;
        if (!remaining) break;
      }
      if (remaining) pieces.push(remaining);
      return pieces;
    })
    .map((note) => oneLine(note))
    .filter(Boolean);

  return { headline, notes };
}

function renderReadableSubtaskDescription(sequence, description) {
  const readable = buildReadableSubtaskDescription(description);
  return `
    <div class="wizard-subtask-summary">
      <div class="wizard-subtask-title-row">
        <h4>${escHtml(readable.headline)}</h4>
        ${renderCommentButton(`Subtask #${sequence}`, description, "critique-input")}
      </div>
      ${readable.notes.length
        ? `<div class="wizard-subtask-notes">
            <div class="wizard-subtask-notes-label">Implementation notes</div>
            <ul>
              ${readable.notes.map((note) => `<li>${escHtml(note)}</li>`).join("")}
            </ul>
          </div>`
        : ""}
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
        ${renderReadableSubtaskDescription(sequence, description)}
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

function phaseStatusLabel(step, idx, currentIndex, status) {
  if (idx < currentIndex) return "Done";
  if (idx > currentIndex) return "Next";
  if (status === "needs_operator") return "Needs review";
  if (status === "waiting_on_planner") return "Working";
  if (status === "blocked") return "Blocked";
  if (status === "running") return "Running";
  return "Current";
}

function renderStepper(currentStep, status = "idle") {
  const steps = getWizardSteps();
  const currentIndex = steps.indexOf(currentStep);
  return `
    <div class="wizard-step-track" aria-label="Planning wizard progress">
      ${steps.map((step, idx) => {
        const state = idx < currentIndex ? "done" : idx === currentIndex ? "current" : "todo";
        return `
          <div class="wizard-step ${state}">
            <span class="wizard-step-dot">${idx + 1}</span>
            <span class="wizard-step-copy">
              <span class="wizard-step-label">${escHtml(step)}</span>
              <span class="wizard-step-state">${escHtml(phaseStatusLabel(step, idx, currentIndex, status))}</span>
            </span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderSpecReviewPanel(task, options) {
  const maxAttempts = Number(options?.maxAttempts || 1);
  const attemptCount = Number(task?.specAttempt || 0);
  const displayAttempt = Math.min(attemptCount + 1, maxAttempts);
  const mode = getSpecReviewMode(task);
  const reviewState = classifyWizardPhase(task);
  const pendingSubmission = options?.pendingSubmission || null;
  const reviseDisabled = attemptCount >= (maxAttempts - 1);
  const disableActions = reviseDisabled || Boolean(pendingSubmission);
  const blockingQuestion = oneLine(task?.currentBlockingQuestion);
  const chips = getPromptChips("spec", mode.mode);
  return `
    <div class="task-detail-actions wizard-panel">
      ${renderStepper(reviewState.step, reviewState.status)}
      <div class="wizard-header-row">
        <h3 class="wizard-title">Spec review</h3>
        <span class="wizard-attempt">Attempt ${displayAttempt} / ${maxAttempts}</span>
      </div>
      ${renderHistoryDrawer("Spec", task?.specTranscripts, maxAttempts)}
      ${blockingQuestion ? `<div class="wizard-blocking-question"><strong>Blocking question:</strong> ${escHtml(blockingQuestion)}</div>` : ""}
      ${pendingSubmission
        ? `<div class="wizard-pending-note"><strong>Submitted:</strong> ${escHtml(pendingSubmission.text)}</div>`
        : ""}
      <div class="wizard-review-board">
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
  const displayAttempt = Math.min(attemptCount + 1, maxAttempts);
  const reviewState = classifyWizardPhase(task);
  const pendingSubmission = options?.pendingSubmission || null;
  const reviseDisabled = attemptCount >= (maxAttempts - 1);
  const disableActions = reviseDisabled || Boolean(pendingSubmission);
  const chips = getPromptChips("plan");
  return `
    <div class="task-detail-actions wizard-panel">
      ${renderStepper(reviewState.step, reviewState.status)}
      <div class="wizard-header-row">
        <h3 class="wizard-title">Plan review</h3>
        <span class="wizard-attempt">Attempt ${displayAttempt} / ${maxAttempts}</span>
      </div>
      ${renderHistoryDrawer("Plan", task?.planTranscripts, maxAttempts)}
      ${pendingSubmission
        ? `<div class="wizard-pending-note"><strong>Submitted:</strong> ${escHtml(pendingSubmission.text)}</div>`
        : ""}
      ${renderSharedUnderstanding(task)}
      ${renderPlanContractSummary(task)}
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
})();
