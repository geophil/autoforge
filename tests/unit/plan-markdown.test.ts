import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// plan-markdown.js is a browser-loadable script with a CommonJS shim at the
// bottom. Evaluate it in a fresh scope so we can import the functions.
function loadPlanMarkdownModule(): {
  renderPlanMarkdown: (task: unknown) => string;
  renderSpecMarkdown: (task: unknown) => string;
  markdownToHtml: (md: string) => string;
} {
  const code = readFileSync(
    resolve(process.cwd(), "src/web/public/plan-markdown.js"),
    "utf8"
  );
  const fakeModule: { exports: Record<string, unknown> } = { exports: {} };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("module", "exports", "window", code)(
    fakeModule,
    fakeModule.exports,
    undefined
  );
  return fakeModule.exports as {
    renderPlanMarkdown: (task: unknown) => string;
    renderSpecMarkdown: (task: unknown) => string;
    markdownToHtml: (md: string) => string;
  };
}

const { renderPlanMarkdown, renderSpecMarkdown, markdownToHtml } = loadPlanMarkdownModule();

describe("renderPlanMarkdown", () => {
  test("empty plan renders a no-subtasks notice", () => {
    const md = renderPlanMarkdown({
      description: "Do nothing useful",
      tier: "EXPRESS",
      assessment: {},
      planSubtasks: []
    });
    expect(md).toContain("# Plan for: Do nothing useful");
    expect(md).toContain("**Tier:** EXPRESS");
    expect(md).toContain("## Overview");
    expect(md).toContain("_No subtasks produced yet._");
    expect(md).not.toContain("## Subtasks");
  });

  test("single subtask with no deps renders all fields", () => {
    const md = renderPlanMarkdown({
      description: "Add a health endpoint",
      tier: "STANDARD",
      assessment: { scope: "single", risk: "low", coupling: "loose" },
      planSubtasks: [
        {
          id: "t1-subtask-1",
          sequence: 1,
          description: "Implement GET /health",
          agentType: "coder",
          filesInScope: ["src/routes/health.ts", "src/types/"],
          dependencies: [],
          testCriteria: ["Returns 200", "Unit tests pass"]
        }
      ]
    });

    expect(md).toContain("# Plan for: Add a health endpoint");
    expect(md).toContain("**Tier:** STANDARD");
    expect(md).toContain("**Scope:** single");
    expect(md).toContain("**Risk:** low");
    expect(md).toContain("**Coupling:** loose");
    expect(md).toContain("1 subtask, 1 agent type involved: coder.");
    expect(md).toContain("### 1. Implement GET /health");
    expect(md).toContain("- **Agent:** coder");
    expect(md).toContain("- **Files in scope:** `src/routes/health.ts`, `src/types/`");
    expect(md).toContain("- **Depends on:** —");
    expect(md).toContain("- **Test criteria:**");
    expect(md).toContain("  - Returns 200");
    expect(md).toContain("  - Unit tests pass");
  });

  test("multi-subtask with cross-references resolves dep ids to 'subtask N'", () => {
    const md = renderPlanMarkdown({
      description: "Two-step feature",
      tier: "THOROUGH",
      assessment: { scope: "multi", risk: "medium", coupling: "tight" },
      planSubtasks: [
        {
          id: "t9-subtask-1",
          sequence: 1,
          description: "Implement",
          agentType: "coder",
          filesInScope: ["src/a.ts"],
          dependencies: [],
          testCriteria: ["A"]
        },
        {
          id: "t9-subtask-2",
          sequence: 2,
          description: "Review",
          agentType: "reviewer",
          filesInScope: ["src/a.ts"],
          dependencies: ["t9-subtask-1"],
          testCriteria: ["B"]
        }
      ]
    });

    expect(md).toContain("2 subtasks, 2 agent types involved: coder, reviewer.");
    expect(md).toContain("### 1. Implement");
    expect(md).toContain("### 2. Review");
    // dependency humanized to subtask 1 (via subtasksById exact match)
    expect(md).toMatch(/### 2\. Review[\s\S]*- \*\*Depends on:\*\* subtask 1/);
  });

  test("dep id matching 'subtask-N' suffix is humanized even without id table hit", () => {
    const md = renderPlanMarkdown({
      description: "Orphan dep",
      tier: "STANDARD",
      assessment: {},
      planSubtasks: [
        {
          id: "x-subtask-1",
          sequence: 1,
          description: "Only one",
          agentType: "coder",
          filesInScope: [],
          dependencies: ["some-unknown-subtask-7"],
          testCriteria: []
        }
      ]
    });
    expect(md).toContain("- **Depends on:** subtask 7");
  });

  test("missing optional fields fall back to em dashes and defaults", () => {
    const md = renderPlanMarkdown({
      description: "Barebones task",
      tier: "STANDARD",
      assessment: {},
      planSubtasks: [
        {
          id: "t1-subtask-1",
          sequence: 1,
          description: "Bare subtask"
          // no agentType, no filesInScope, no dependencies, no testCriteria
        }
      ]
    });
    expect(md).toContain("### 1. Bare subtask");
    expect(md).toContain("- **Agent:** coder");
    expect(md).toContain("- **Files in scope:** —");
    expect(md).toContain("- **Depends on:** —");
    expect(md).toContain("- **Test criteria:** —");
  });

  test("task with no description still produces a valid heading", () => {
    const md = renderPlanMarkdown({
      description: "",
      tier: "EXPRESS",
      assessment: {},
      planSubtasks: []
    });
    expect(md.split("\n")[0]).toBe("# Plan for: (no description)");
  });

  test("description whitespace is collapsed onto one line", () => {
    const md = renderPlanMarkdown({
      description: "Line one\n\nline two   with gaps",
      tier: "STANDARD",
      assessment: {},
      planSubtasks: []
    });
    expect(md.split("\n")[0]).toBe("# Plan for: Line one line two with gaps");
  });
});

// Three display modes plus the planning-in-progress empty state. Each test
// here uses the same renderPlanMarkdown entry point.
describe("renderPlanMarkdown — phase-aware display modes", () => {
  const sampleSpec = {
    discovery: {
      intent: "Add observability for widgets",
      constraints: [],
      assumptions: [],
      decisions: [
        {
          decision: "Use ETag caching",
          reason: "Reduces backend load",
          alternativesRejected: ["Always re-fetch"],
          consequence: "Clients must handle 304 responses"
        }
      ],
      nonGoals: [],
      openQuestions: ["What retention applies to historical widget counts?"]
    },
    spec: {
      problem: "There is no view of widget totals.",
      desiredBehavior: ["GET returns totals", "Pagination supported"],
      acceptanceCriteria: ["p95 latency under 100ms", "Rate-limit applied"],
      verification: ["Load test"],
      risks: []
    }
  };

  test("spec-only mode: Shared Understanding section is expanded, includes blockingQuestion blockquote", () => {
    const md = renderPlanMarkdown({
      description: "Widget totals API",
      tier: "STANDARD",
      assessment: { scope: "medium", risk: "low" },
      planSubtasks: [],
      specArtifacts: sampleSpec,
      currentBlockingQuestion: "Should totals include archived widgets?"
    });

    expect(md).toContain("# Plan for: Widget totals API");
    expect(md).toContain("## Shared Understanding");
    expect(md).not.toContain("<details>");
    expect(md).toContain("> **Awaiting answer:** Should totals include archived widgets?");
    expect(md).toContain("### Problem");
    expect(md).toContain("There is no view of widget totals.");
    expect(md).toContain("### Desired Behavior");
    expect(md).toContain("- GET returns totals");
    expect(md).toContain("### Acceptance Criteria");
    expect(md).toContain("### Decisions");
    expect(md).toContain("**Use ETag caching**");
    expect(md).toContain("Alternatives rejected: Always re-fetch.");
    expect(md).toContain("### Open Questions");
    expect(md).toContain("- [ ] What retention applies to historical widget counts?");
    expect(md).not.toContain("## Subtasks");
    expect(md).not.toContain("_No subtasks produced yet._");
    expect(md).not.toContain("_Plan in progress…_");
  });

  test("spec + subtasks mode: Shared Understanding wraps in <details> and Subtasks follows", () => {
    const md = renderPlanMarkdown({
      description: "Widget totals API",
      tier: "STANDARD",
      assessment: {},
      planSubtasks: [
        {
          id: "t1-subtask-1",
          sequence: 1,
          description: "Wire GET /widgets/totals",
          agentType: "coder",
          filesInScope: ["src/widgets/totals.ts"],
          dependencies: [],
          testCriteria: ["Returns totals"]
        }
      ],
      specArtifacts: sampleSpec
    });

    expect(md).toContain("<details><summary>Shared Understanding</summary>");
    expect(md).toContain("</details>");
    expect(md).toContain("### Problem");
    // <details> must precede the ## Subtasks heading
    expect(md.indexOf("<details>")).toBeLessThan(md.indexOf("## Subtasks"));
    // Subtasks block still renders the legacy fields
    expect(md).toContain("### 1. Wire GET /widgets/totals");
    expect(md).toContain("- **Agent:** coder");
    expect(md).toContain("- **Files in scope:** `src/widgets/totals.ts`");
  });

  test("planning-in-progress: state=planning + no artifacts renders 'Plan in progress…'", () => {
    const md = renderPlanMarkdown({
      description: "Brand-new task",
      tier: "STANDARD",
      assessment: {},
      planSubtasks: [],
      state: "planning"
    });
    expect(md).toContain("_Plan in progress…_");
    expect(md).not.toContain("_No subtasks produced yet._");
  });

  test("legacy empty state: no state field falls back to subtasks-not-produced notice", () => {
    const md = renderPlanMarkdown({
      description: "Old-style task",
      tier: "EXPRESS",
      assessment: {},
      planSubtasks: []
    });
    expect(md).toContain("_No subtasks produced yet._");
    expect(md).not.toContain("_Plan in progress…_");
  });

  test("legacy subtasks-only mode is unchanged when specArtifacts is absent", () => {
    const md = renderPlanMarkdown({
      description: "Legacy task",
      tier: "STANDARD",
      assessment: { scope: "medium" },
      planSubtasks: [
        {
          id: "legacy-subtask-1",
          sequence: 1,
          description: "Do the thing",
          agentType: "coder",
          filesInScope: ["src/"],
          dependencies: [],
          testCriteria: ["Works"]
        }
      ]
    });
    expect(md).toContain("## Overview");
    expect(md).toContain("1 subtask, 1 agent type involved: coder.");
    expect(md).toContain("## Subtasks");
    expect(md).toContain("### 1. Do the thing");
    expect(md).not.toContain("Shared Understanding");
    expect(md).not.toContain("<details>");
  });
});

describe("markdownToHtml — <details> and blockquote support", () => {
  test("<details><summary>…</summary> / </details> passes through with summary content escaped", () => {
    const md = [
      "<details><summary>Shared Understanding</summary>",
      "",
      "### Problem",
      "",
      "The thing.",
      "",
      "</details>"
    ].join("\n");
    const html = markdownToHtml(md);
    expect(html).toContain("<details><summary>Shared Understanding</summary>");
    expect(html).toContain("</details>");
    expect(html).toContain("<h3>Problem</h3>");
    expect(html).toContain("<p>The thing.</p>");
  });

  test("blockquote `> …` becomes <blockquote> with inline bold preserved", () => {
    const md = "> **Awaiting answer:** What is the rate limit?";
    const html = markdownToHtml(md);
    expect(html).toContain("<blockquote><strong>Awaiting answer:</strong> What is the rate limit?</blockquote>");
  });

  test("non-recognised raw HTML in source is still escaped (defence in depth)", () => {
    const md = [
      "# safe",
      "<script>alert(1)</script>",
      "<details><summary>Real wrapper</summary>",
      "</details>"
    ].join("\n");
    const html = markdownToHtml(md);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // …but our two recognised tags do come through
    expect(html).toContain("<details>");
    expect(html).toContain("</details>");
  });
});

describe("renderSpecMarkdown", () => {
  test("without artifacts shows blocking question and fallback body", () => {
    const md = renderSpecMarkdown({
      description: "Ship widgets",
      tier: "STANDARD",
      assessment: { scope: "multi" },
      currentBlockingQuestion: "Which datastore?",
      specArtifacts: null
    });
    expect(md).toContain("# Spec review: Ship widgets");
    expect(md).toContain("**Tier:** STANDARD");
    expect(md).toContain("## Blocking question");
    expect(md).toContain("_Which datastore?_");
    expect(md).toContain("_No structured discovery/spec payload");
  });

  test("renders discovery, decisions, and spec sections", () => {
    const md = renderSpecMarkdown({
      description: "Feature X",
      tier: "THOROUGH",
      assessment: {},
      specArtifacts: {
        discovery: {
          intent: "Expose widget counts via API",
          constraints: ["Rate limiting"],
          assumptions: ["Redis exists"],
          decisions: [
            {
              decision: "Use pagination",
              reason: "Large catalogs",
              alternativesRejected: ["Full scan"],
              consequence: "More requests"
            }
          ],
          nonGoals: ["Admin UI"],
          openQuestions: ["Retention policy"]
        },
        spec: {
          problem: "No observability into widgets.",
          desiredBehavior: ["GET returns totals"],
          acceptanceCriteria: ["p95 under 100ms"],
          verification: ["Load test"],
          risks: ["Cache stampedes"]
        }
      }
    });
    expect(md).toContain("### Intent");
    expect(md).toContain("Expose widget counts via API");
    expect(md).toContain("### Constraints");
    expect(md).toContain("- Rate limiting");
    expect(md).toContain("**Use pagination**");
    expect(md).toContain("Alternatives rejected: Full scan");
    expect(md).toContain("## Spec");
    expect(md).toContain("No observability into widgets.");
    expect(md).toContain("### Desired behavior");
    expect(md).toContain("- GET returns totals");
  });

  test("roundtrip to HTML includes headings from renderSpecMarkdown", () => {
    const md = renderSpecMarkdown({
      description: "Z",
      tier: "STANDARD",
      assessment: {},
      specArtifacts: {
        discovery: { intent: "I", constraints: [], assumptions: [], decisions: [], nonGoals: [], openQuestions: [] },
        spec: {
          problem: "P",
          desiredBehavior: [],
          acceptanceCriteria: [],
          verification: [],
          risks: []
        }
      }
    });
    const html = markdownToHtml(md);
    expect(html).toContain("<h1>Spec review: Z</h1>");
    expect(html).toContain("<h2>Discovery</h2>");
    expect(html).toContain("<h2>Spec</h2>");
  });
});

describe("markdownToHtml", () => {
  test("renders headings, bold, inline code, and nested bullets", () => {
    const md = [
      "# Title",
      "",
      "**Tier:** STANDARD",
      "",
      "## Overview",
      "Two subtasks.",
      "",
      "## Subtasks",
      "",
      "### 1. Do it",
      "- **Agent:** coder",
      "- **Files in scope:** `src/a.ts`, `src/b.ts`",
      "- **Test criteria:**",
      "  - Returns 200",
      "  - Tests pass"
    ].join("\n");
    const html = markdownToHtml(md);

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<h2>Overview</h2>");
    expect(html).toContain("<h3>1. Do it</h3>");
    expect(html).toContain("<strong>Tier:</strong>");
    expect(html).toContain("<code>src/a.ts</code>");
    expect(html).toContain("<ul>");
    // Nested list: a <ul> inside another <ul>
    expect(html.match(/<ul>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/<li>Returns 200\s*<\/li>/);
  });

  test("nested list places the inner <ul> inside the parent <li> (valid HTML)", () => {
    const md = [
      "- Parent",
      "  - Child A",
      "  - Child B"
    ].join("\n");
    const html = markdownToHtml(md);

    // Must NOT contain a <ul> as a direct sibling of a sibling <li>
    // (i.e. "</li>\n<ul>" at the top level). The nested <ul> has to live
    // inside the parent <li>.
    expect(html).not.toMatch(/<li>Parent<\/li>\s*<ul>/);
    // The nested <ul> must appear BEFORE the closing </li> of the parent.
    expect(html).toMatch(/<li>Parent\s*<ul>[\s\S]*<\/ul>\s*<\/li>/);
    // Sanity: both children are present and properly wrapped.
    expect(html).toMatch(/<li>Child A\s*<\/li>/);
    expect(html).toMatch(/<li>Child B\s*<\/li>/);
  });

  test("deeper nesting (three levels) produces valid nested structure", () => {
    const md = [
      "- a",
      "  - b",
      "    - c",
      "- d"
    ].join("\n");
    const html = markdownToHtml(md);

    // Each nested <ul> sits inside the preceding <li>. The regex implicitly
    // asserts a single top-level list (opens/closes match around the whole
    // structure).
    expect(html).toMatch(/<li>a\s*<ul>[\s\S]*<li>b\s*<ul>[\s\S]*<li>c\s*<\/li>\s*<\/ul>\s*<\/li>\s*<\/ul>\s*<\/li>\s*<li>d\s*<\/li>/);
    // Opens and closes must balance.
    expect((html.match(/<ul>/g) || []).length).toBe((html.match(/<\/ul>/g) || []).length);
    expect((html.match(/<li>/g) || []).length).toBe((html.match(/<\/li>/g) || []).length);
    // Still exactly one outermost <ul> — the first non-whitespace emission.
    expect(html.trimStart().startsWith("<ul>")).toBe(true);
  });

  test("dedent after nested list closes inner ul and resumes at parent level", () => {
    const md = [
      "- Parent one",
      "  - Child",
      "- Parent two"
    ].join("\n");
    const html = markdownToHtml(md);

    expect(html).toMatch(/<li>Parent one\s*<ul>\s*<li>Child\s*<\/li>\s*<\/ul>\s*<\/li>\s*<li>Parent two\s*<\/li>/);
  });

  test("escapes raw HTML in source to prevent injection", () => {
    const md = [
      "# <script>alert(1)</script>",
      "- dangerous: `<img src=x onerror=y>`"
    ].join("\n");
    const html = markdownToHtml(md);
    // Raw < should be escaped everywhere; no live script tag should survive.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img ");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("produces no output for empty input", () => {
    expect(markdownToHtml("")).toBe("");
    expect(markdownToHtml(null as unknown as string)).toBe("");
  });

  test("roundtrip from renderPlanMarkdown to HTML contains expected structure", () => {
    const md = renderPlanMarkdown({
      description: "Ship it",
      tier: "STANDARD",
      assessment: { scope: "single" },
      planSubtasks: [
        {
          id: "t1-subtask-1",
          sequence: 1,
          description: "Ship",
          agentType: "coder",
          filesInScope: ["src/"],
          dependencies: [],
          testCriteria: ["Works"]
        }
      ]
    });
    const html = markdownToHtml(md);
    expect(html).toContain("<h1>Plan for: Ship it</h1>");
    expect(html).toContain("<h2>Overview</h2>");
    expect(html).toContain("<h2>Subtasks</h2>");
    expect(html).toContain("<h3>1. Ship</h3>");
    expect(html).toContain("<code>src/</code>");
    expect(html).toMatch(/<li>Works\s*<\/li>/);
  });
});
