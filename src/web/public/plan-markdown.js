// Plan markdown helpers.
//
// Exports:
//   - renderPlanMarkdown(task)  -> markdown string (execution plan / subtasks)
//   - renderSpecMarkdown(task)   -> markdown string (discovery + spec)
//   - markdownToHtml(md)        -> HTML string (tiny, safe renderer for the subset emitted by the render* functions)
//
// Loaded both in the browser (via <script src>) and in Bun tests
// (via import or require). See trailing shim.

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Collapse whitespace and trim. Keeps a description safe on a single heading line.
function oneLine(str) {
  return String(str ?? "").replace(/\s+/g, " ").trim();
}

// Map a subtask id (e.g. "abc-subtask-2") to a human-readable "subtask 2"
// when the id matches the conventional shape.
function humanizeDep(dep, subtasksById) {
  if (typeof dep !== "string" || dep.length === 0) return "";
  if (subtasksById.has(dep)) {
    const seq = subtasksById.get(dep);
    return `subtask ${seq}`;
  }
  const m = dep.match(/subtask-(\d+)$/);
  if (m) return `subtask ${m[1]}`;
  return dep;
}

// Append a "Shared Understanding" section (markdown) describing approved
// discovery + spec artifacts to `lines`. When `collapsed` is true, wraps the
// section in `<details><summary>…</summary></details>` for the dashboard's
// awaiting_plan_approval card.
function appendSharedUnderstanding(lines, specArtifacts, blockingQuestion, collapsed) {
  const discovery = specArtifacts.discovery && typeof specArtifacts.discovery === "object"
    ? specArtifacts.discovery
    : {};
  const spec = specArtifacts.spec && typeof specArtifacts.spec === "object"
    ? specArtifacts.spec
    : {};

  if (collapsed) {
    lines.push("<details><summary>Shared Understanding</summary>");
    lines.push("");
  } else {
    lines.push("## Shared Understanding");
    lines.push("");
  }

  if (blockingQuestion && String(blockingQuestion).trim()) {
    lines.push(`> **Awaiting answer:** ${oneLine(blockingQuestion)}`);
    lines.push("");
  }

  if (spec.problem && String(spec.problem).trim()) {
    lines.push("### Problem");
    lines.push("");
    lines.push(oneLine(spec.problem));
    lines.push("");
  }

  const pushBullets = (heading, items) => {
    const arr = Array.isArray(items) ? items.map((x) => oneLine(String(x))).filter(Boolean) : [];
    if (arr.length === 0) return;
    lines.push(`### ${heading}`);
    lines.push("");
    for (const x of arr) lines.push(`- ${x}`);
    lines.push("");
  };

  pushBullets("Desired Behavior", spec.desiredBehavior);
  pushBullets("Acceptance Criteria", spec.acceptanceCriteria);

  const decisions = Array.isArray(discovery.decisions) ? discovery.decisions : [];
  if (decisions.length > 0) {
    lines.push("### Decisions");
    lines.push("");
    for (const dec of decisions) {
      if (!dec || typeof dec !== "object") continue;
      const title = oneLine(dec.decision) || "(decision)";
      const parts = [`**${title}**`];
      if (dec.reason) parts.push(`— ${oneLine(dec.reason)}.`);
      const alt = Array.isArray(dec.alternativesRejected)
        ? dec.alternativesRejected.map((x) => oneLine(String(x))).filter(Boolean)
        : [];
      if (alt.length > 0) parts.push(`Alternatives rejected: ${alt.join("; ")}.`);
      if (dec.consequence) parts.push(`Consequence: ${oneLine(dec.consequence)}.`);
      lines.push(parts.join(" "));
      lines.push("");
    }
  }

  const openQuestions = Array.isArray(discovery.openQuestions)
    ? discovery.openQuestions.map((x) => oneLine(String(x))).filter(Boolean)
    : [];
  if (openQuestions.length > 0) {
    lines.push("### Open Questions");
    lines.push("");
    for (const q of openQuestions) lines.push(`- [ ] ${q}`);
    lines.push("");
  }

  if (collapsed) {
    lines.push("</details>");
    lines.push("");
  }
}

function appendSubtasks(lines, subtasks) {
  lines.push("## Overview");
  const agentTypes = [...new Set(subtasks.map((s) => s?.agentType || "coder"))];
  const count = subtasks.length;
  lines.push(
    `${count} subtask${count !== 1 ? "s" : ""}, ` +
      `${agentTypes.length} agent type${agentTypes.length !== 1 ? "s" : ""} involved: ${agentTypes.join(", ")}.`
  );
  lines.push("");

  const subtasksById = new Map();
  subtasks.forEach((s, idx) => {
    if (s && typeof s.id === "string") {
      subtasksById.set(s.id, s.sequence ?? idx + 1);
    }
  });

  lines.push("## Subtasks");
  lines.push("");
  subtasks.forEach((s, idx) => {
    const seq = s?.sequence ?? idx + 1;
    const desc = oneLine(s?.description) || `Subtask ${seq}`;
    lines.push(`### ${seq}. ${desc}`);

    const agent = s?.agentType || "coder";
    lines.push(`- **Agent:** ${agent}`);

    const files = Array.isArray(s?.filesInScope) ? s.filesInScope.filter(Boolean) : [];
    if (files.length > 0) {
      lines.push(`- **Files in scope:** ${files.map((f) => "`" + f + "`").join(", ")}`);
    } else {
      lines.push(`- **Files in scope:** —`);
    }

    const deps = Array.isArray(s?.dependencies) ? s.dependencies.filter(Boolean) : [];
    const humanized = deps
      .map((d) => humanizeDep(d, subtasksById))
      .filter(Boolean);
    if (humanized.length > 0) {
      lines.push(`- **Depends on:** ${humanized.join(", ")}`);
    } else {
      lines.push(`- **Depends on:** —`);
    }

    const criteria = Array.isArray(s?.testCriteria) ? s.testCriteria.filter(Boolean) : [];
    if (criteria.length > 0) {
      lines.push(`- **Test criteria:**`);
      for (const c of criteria) lines.push(`  - ${oneLine(c)}`);
    } else {
      lines.push(`- **Test criteria:** —`);
    }

    lines.push("");
  });
}

// True when specArtifacts has a meaningful body (matches normalizeSpecArtifacts on the orchestrator side).
function hasSpecBody(specArtifacts) {
  if (!specArtifacts || typeof specArtifacts !== "object") return false;
  const intent = specArtifacts.discovery?.intent;
  const problem = specArtifacts.spec?.problem;
  return (
    (typeof intent === "string" && intent.trim().length > 0) ||
    (typeof problem === "string" && problem.trim().length > 0)
  );
}

// Pure: shape PlanSubtask[] (+ task context, optional spec artifacts) into a
// markdown document. Renders one of four modes:
//
//   1. Spec-only (`specArtifacts` present, `planSubtasks` empty): Shared Understanding section, expanded.
//   2. Subtasks-only (no specArtifacts, planSubtasks non-empty): legacy behavior.
//   3. Spec + subtasks (both present): Shared Understanding in a collapsed <details> block, then Subtasks.
//   4. Neither: `_Plan in progress…_` when state is planning/replanning, else `_No subtasks produced yet._`.
//
// Accepts a task-like object with { description, tier, assessment, planSubtasks,
// specArtifacts?, currentBlockingQuestion?, state? }.
function renderPlanMarkdown(task) {
  const description = oneLine(task?.description) || "(no description)";
  const tier = task?.tier || "—";
  const assessment = task?.assessment || {};
  const subtasks = Array.isArray(task?.planSubtasks) ? task.planSubtasks : [];
  const specArtifacts = task?.specArtifacts ?? null;
  const blockingQuestion = task?.currentBlockingQuestion;
  const state = task?.state;

  const lines = [];
  lines.push(`# Plan for: ${description}`);
  lines.push("");

  const signalBits = [`**Tier:** ${tier}`];
  if (assessment.scope) signalBits.push(`**Scope:** ${assessment.scope}`);
  if (assessment.risk) signalBits.push(`**Risk:** ${assessment.risk}`);
  if (assessment.coupling) signalBits.push(`**Coupling:** ${assessment.coupling}`);
  if (assessment.novelty) signalBits.push(`**Novelty:** ${assessment.novelty}`);
  lines.push(signalBits.join("  •  "));
  lines.push("");

  const hasSpec = hasSpecBody(specArtifacts);
  const hasSubtasks = subtasks.length > 0;

  if (hasSpec && !hasSubtasks) {
    appendSharedUnderstanding(lines, specArtifacts, blockingQuestion, /* collapsed */ false);
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  if (hasSpec && hasSubtasks) {
    appendSharedUnderstanding(lines, specArtifacts, blockingQuestion, /* collapsed */ true);
    appendSubtasks(lines, subtasks);
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  if (hasSubtasks) {
    appendSubtasks(lines, subtasks);
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  // Neither spec nor subtasks. Surface a state-aware empty notice so operators
  // distinguish "still planning" from "planner produced nothing".
  lines.push("## Overview");
  if (state === "planning" || state === "replanning" || state === "assessing") {
    lines.push("_Plan in progress…_");
  } else {
    lines.push("_No subtasks produced yet._");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Markdown document for discovery/spec artifacts shown during awaiting_spec_approval.
 */
function renderSpecMarkdown(task) {
  const description = oneLine(task?.description) || "(no description)";
  const tier = task?.tier || "—";
  const assessment = task?.assessment || {};

  const lines = [];
  lines.push(`# Spec review: ${description}`);
  lines.push("");

  const signalBits = [`**Tier:** ${tier}`];
  if (assessment.scope) signalBits.push(`**Scope:** ${assessment.scope}`);
  if (assessment.risk) signalBits.push(`**Risk:** ${assessment.risk}`);
  if (assessment.coupling) signalBits.push(`**Coupling:** ${assessment.coupling}`);
  if (assessment.novelty) signalBits.push(`**Novelty:** ${assessment.novelty}`);
  lines.push(signalBits.join("  •  "));
  lines.push("");

  const blocking = task?.currentBlockingQuestion;
  if (blocking && String(blocking).trim()) {
    lines.push("## Blocking question");
    lines.push("");
    lines.push(`_${oneLine(blocking)}_`);
    lines.push("");
  }

  const art = task?.specArtifacts;
  if (!art || typeof art !== "object") {
    lines.push("## Discovery & spec");
    lines.push("");
    lines.push("_No structured discovery/spec payload — address the blocking question or request a revision._");
    lines.push("");
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  const d = art.discovery && typeof art.discovery === "object" ? art.discovery : {};
  const specBlock = art.spec && typeof art.spec === "object" ? art.spec : {};

  const pushSimpleBullets = (heading, items) => {
    const arr = Array.isArray(items) ? items.map((x) => oneLine(String(x))).filter(Boolean) : [];
    if (arr.length === 0) return;
    lines.push(`### ${heading}`);
    lines.push("");
    for (const x of arr) {
      lines.push(`- ${x}`);
    }
    lines.push("");
  };

  lines.push("## Discovery");
  lines.push("");
  if (d.intent && String(d.intent).trim()) {
    lines.push(`### Intent`);
    lines.push("");
    lines.push(oneLine(d.intent));
    lines.push("");
  }

  pushSimpleBullets("Constraints", d.constraints);
  pushSimpleBullets("Assumptions", d.assumptions);
  pushSimpleBullets("Non-goals", d.nonGoals);
  pushSimpleBullets("Open questions", d.openQuestions);

  const decisions = Array.isArray(d.decisions) ? d.decisions : [];
  if (decisions.length > 0) {
    lines.push("### Decisions");
    lines.push("");
    for (const dec of decisions) {
      if (!dec || typeof dec !== "object") continue;
      const title = oneLine(dec.decision) || "(decision)";
      lines.push(`- **${title}**`);
      if (dec.reason) lines.push(`  - Reason: ${oneLine(dec.reason)}`);
      const alt = Array.isArray(dec.alternativesRejected)
        ? dec.alternativesRejected.map((x) => oneLine(String(x))).filter(Boolean)
        : [];
      if (alt.length > 0) lines.push(`  - Alternatives rejected: ${alt.join("; ")}`);
      if (dec.consequence) lines.push(`  - Consequence: ${oneLine(dec.consequence)}`);
    }
    lines.push("");
  }

  lines.push("## Spec");
  lines.push("");
  if (specBlock.problem && String(specBlock.problem).trim()) {
    lines.push(oneLine(specBlock.problem));
    lines.push("");
  }

  pushSimpleBullets("Desired behavior", specBlock.desiredBehavior);
  pushSimpleBullets("Acceptance criteria", specBlock.acceptanceCriteria);
  pushSimpleBullets("Verification", specBlock.verification);
  pushSimpleBullets("Risks", specBlock.risks);

  return lines.join("\n").replace(/\n+$/, "\n");
}

// Tiny, safe markdown renderer for the subset renderPlanMarkdown emits:
//   - # / ## / ### headings
//   - - unordered list items (two levels of indent)
//   - **bold** and `inline code` inline
//   - _italic_ (single underscore pair)
//   - > blockquotes (single-line)
//   - <details><summary>…</summary> / </details> wrappers (the only raw HTML
//     this renderer emits — used by renderPlanMarkdown for collapsed Shared
//     Understanding panels)
//   - blank lines separate paragraphs
//
// Escapes all input first, then re-enables structural HTML. The <details>
// path is safe because input is generated by renderPlanMarkdown — a closed
// loop. We still escape the summary text via applyInline.
function markdownToHtml(md) {
  const raw = String(md ?? "");
  const src = escHtml(raw).split("\n");
  const out = [];
  let i = 0;

  const applyInline = (line) =>
    line
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s)\.,;:!?]|$)/g, (_, pre, c) => `${pre}<em>${c}</em>`);

  while (i < src.length) {
    const line = src[i];

    // Blank line — skip.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // <details><summary>…</summary> / </details>. These are the only raw HTML
    // tags this renderer recognises. Note: input was escaped above, so the
    // tags appear as &lt;details&gt; etc. here.
    const detailsOpen = line.match(/^&lt;details&gt;\s*&lt;summary&gt;(.*?)&lt;\/summary&gt;\s*$/);
    if (detailsOpen) {
      out.push(`<details><summary>${applyInline(detailsOpen[1])}</summary>`);
      i++;
      continue;
    }
    if (/^&lt;\/details&gt;\s*$/.test(line)) {
      out.push("</details>");
      i++;
      continue;
    }

    // Blockquote — single-line `> …`. Wraps the line content in a <blockquote>.
    const blockquote = line.match(/^&gt;\s+(.*)$/);
    if (blockquote) {
      out.push(`<blockquote>${applyInline(blockquote[1])}</blockquote>`);
      i++;
      continue;
    }

    // Headings.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${applyInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list block. Supports arbitrary indent depth for sub-bullets.
    // Nested <ul> elements are emitted INSIDE their parent <li>, not as
    // siblings — which is the only shape permitted by HTML5.
    if (/^(\s{0,4})[-*]\s+/.test(line)) {
      // Stack of { indent, hasOpenLi } frames, one per open <ul>.
      const stack = [];
      const closeLi = () => {
        const top = stack[stack.length - 1];
        if (top && top.hasOpenLi) {
          out.push("</li>");
          top.hasOpenLi = false;
        }
      };
      // Close all <ul>s deeper than `indent`. Each pop closes the nested <ul>
      // and then closes the parent <li> that contained it.
      const closeDeeper = (indent) => {
        while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
          closeLi();
          out.push("</ul>");
          stack.pop();
          closeLi();
        }
      };

      while (i < src.length && /^(\s{0,4})[-*]\s+/.test(src[i])) {
        const m = src[i].match(/^(\s*)[-*]\s+(.*)$/);
        const indent = m[1].length;

        if (stack.length === 0) {
          out.push("<ul>");
          stack.push({ indent, hasOpenLi: false });
        } else {
          const top = stack[stack.length - 1];
          if (indent > top.indent) {
            // Open a nested <ul> INSIDE the currently-open parent <li>.
            // Do NOT close the parent li — the nested ul is its child.
            out.push("<ul>");
            stack.push({ indent, hasOpenLi: false });
          } else {
            closeDeeper(indent);
            closeLi();
          }
        }

        const top = stack[stack.length - 1];
        out.push(`<li>${applyInline(m[2])}`);
        top.hasOpenLi = true;
        i++;
      }

      // End of list block: close any remaining open frames.
      while (stack.length > 0) {
        closeLi();
        out.push("</ul>");
        stack.pop();
        // After popping, the new top (if any) had its <li> open because it
        // hosted the nested <ul> we just closed. Close that <li> too.
        closeLi();
      }
      continue;
    }

    // Default: paragraph (collect consecutive non-blank, non-structural lines).
    const isStructural = (s) =>
      /^(#{1,6})\s+/.test(s) ||
      /^(\s{0,4})[-*]\s+/.test(s) ||
      /^&gt;\s+/.test(s) ||
      /^&lt;details&gt;\s*&lt;summary&gt;/.test(s) ||
      /^&lt;\/details&gt;\s*$/.test(s);
    const para = [line];
    i++;
    while (
      i < src.length &&
      src[i].trim() !== "" &&
      !isStructural(src[i])
    ) {
      para.push(src[i]);
      i++;
    }
    out.push(`<p>${applyInline(para.join(" "))}</p>`);
  }

  return out.join("\n");
}

// Browser exposure.
if (typeof window !== "undefined") {
  window.renderPlanMarkdown = renderPlanMarkdown;
  window.renderSpecMarkdown = renderSpecMarkdown;
  window.markdownToHtml = markdownToHtml;
}

// Node / Bun tests (CommonJS).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderPlanMarkdown, renderSpecMarkdown, markdownToHtml };
}
