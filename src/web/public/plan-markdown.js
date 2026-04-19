// Plan markdown helpers.
//
// Two exports:
//   - renderPlanMarkdown(task)  -> markdown string
//   - markdownToHtml(md)        -> HTML string (tiny, safe renderer for the subset emitted by renderPlanMarkdown)
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

// Pure: shape PlanSubtask[] (+ task context) into a markdown document.
// Accepts a task-like object with { description, tier, assessment, planSubtasks }.
function renderPlanMarkdown(task) {
  const description = oneLine(task?.description) || "(no description)";
  const tier = task?.tier || "—";
  const assessment = task?.assessment || {};
  const subtasks = Array.isArray(task?.planSubtasks) ? task.planSubtasks : [];

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

  lines.push("## Overview");
  if (subtasks.length === 0) {
    lines.push("_No subtasks produced yet._");
    lines.push("");
    return lines.join("\n");
  }
  const agentTypes = [...new Set(subtasks.map((s) => s?.agentType || "coder"))];
  const count = subtasks.length;
  lines.push(
    `${count} subtask${count !== 1 ? "s" : ""}, ` +
      `${agentTypes.length} agent type${agentTypes.length !== 1 ? "s" : ""} involved: ${agentTypes.join(", ")}.`
  );
  lines.push("");

  // Build id -> sequence map once for dependency humanization.
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

  return lines.join("\n").replace(/\n+$/, "\n");
}

// Tiny, safe markdown renderer for the subset renderPlanMarkdown emits:
//   - # / ## / ### headings
//   - - unordered list items (two levels of indent)
//   - **bold** and `inline code` inline
//   - _italic_ (single underscore pair)
//   - blank lines separate paragraphs
//
// Escapes all input first, then re-enables structural HTML. Safe because
// escaping happens before any tag insertion.
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
    const para = [line];
    i++;
    while (
      i < src.length &&
      src[i].trim() !== "" &&
      !/^(#{1,6})\s+/.test(src[i]) &&
      !/^(\s{0,4})[-*]\s+/.test(src[i])
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
  window.markdownToHtml = markdownToHtml;
}

// Node / Bun tests (CommonJS).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderPlanMarkdown, markdownToHtml };
}
