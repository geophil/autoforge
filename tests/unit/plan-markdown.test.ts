import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// plan-markdown.js is a browser-loadable script with a CommonJS shim at the
// bottom. Evaluate it in a fresh scope so we can import the functions.
function loadPlanMarkdownModule(): {
  renderPlanMarkdown: (task: unknown) => string;
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
    markdownToHtml: (md: string) => string;
  };
}

const { renderPlanMarkdown, markdownToHtml } = loadPlanMarkdownModule();

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
