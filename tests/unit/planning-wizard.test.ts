import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type WizardModule = {
  getWizardSteps: () => string[];
  classifyWizardPhase: (task: Record<string, unknown>) => { step: string; status: string };
  getSpecReviewMode: (task: Record<string, unknown>) => {
    mode: string;
    promptLabel: string;
    submitLabel: string;
  };
  buildQmdEvidence: (task: Record<string, unknown>) => {
    state: string;
    chips: string[];
    fallbackReason: string | null;
  };
  getPromptChips: (kind: "spec" | "plan", mode?: string) => string[];
  buildContractWarnings: (
    subtask: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Array<{ level: string; message: string }>;
  renderPlanSubtaskCards: (subtasks: Array<Record<string, unknown>>) => string;
};

function loadPlanningWizardModule(): WizardModule {
  const uiHelpers = readFileSync(
    resolve(process.cwd(), "src/web/public/ui-helpers.js"),
    "utf8"
  );
  const code = readFileSync(
    resolve(process.cwd(), "src/web/public/planning-wizard.js"),
    "utf8"
  );
  const fakeModule: { exports: Record<string, unknown> } = { exports: {} };
  const windowShim: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("module", "exports", "window", uiHelpers)(
    fakeModule,
    fakeModule.exports,
    windowShim
  );
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("module", "exports", "window", code)(
    fakeModule,
    fakeModule.exports,
    windowShim
  );
  return fakeModule.exports as WizardModule;
}

const wizard = loadPlanningWizardModule();

describe("planning wizard helpers", () => {
  test("returns the four stable wizard steps", () => {
    expect(wizard.getWizardSteps()).toEqual(["Describe", "Spec", "Plan", "Execute"]);
  });

  test("classifies task state into wizard step/status", () => {
    expect(wizard.classifyWizardPhase({ state: "planning" })).toEqual({
      step: "Spec",
      status: "waiting_on_planner"
    });
    expect(wizard.classifyWizardPhase({ state: "awaiting_spec_approval" })).toEqual({
      step: "Spec",
      status: "needs_operator"
    });
    expect(wizard.classifyWizardPhase({ state: "awaiting_plan_approval" })).toEqual({
      step: "Plan",
      status: "needs_operator"
    });
    expect(wizard.classifyWizardPhase({ state: "executing" })).toEqual({
      step: "Execute",
      status: "running"
    });
  });

  test("switches to blocking-question review mode when planner asks question", () => {
    expect(wizard.getSpecReviewMode({ currentBlockingQuestion: "Should we include archived rows?" })).toEqual({
      mode: "blocking_question",
      promptLabel: "Answer the planner question",
      submitLabel: "Submit answer"
    });
    expect(wizard.getSpecReviewMode({ currentBlockingQuestion: null })).toEqual({
      mode: "critique",
      promptLabel: "Critique the spec",
      submitLabel: "Revise spec"
    });
  });

  test("builds QMD evidence chips for used context", () => {
    const out = wizard.buildQmdEvidence({
      planningContext: {
        qmdContext: {
          status: "used",
          phase: "spec",
          queries: ["q1", "q2"],
          documents: ["doc-a.md", "doc-b.md"],
          fallbackReason: null
        }
      }
    });
    expect(out.state).toBe("used");
    expect(out.chips).toContain("QMD used");
    expect(out.chips).toContain("Phase: spec");
    expect(out.chips).toContain("2 queries");
    expect(out.chips).toContain("2 docs");
    expect(out.fallbackReason).toBeNull();
  });

  test("builds fallback QMD evidence when retrieval was unavailable", () => {
    const out = wizard.buildQmdEvidence({
      planningContext: {
        qmdContext: {
          status: "fallback",
          phase: "execution_plan",
          queries: [],
          documents: [],
          fallbackReason: "index_unavailable"
        }
      }
    });
    expect(out.state).toBe("fallback");
    expect(out.chips).toContain("QMD fallback");
    expect(out.fallbackReason).toBe("index_unavailable");
  });

  test("returns scoped prompt chips for spec and plan phases", () => {
    expect(wizard.getPromptChips("spec", "blocking_question")).toContain("Answer explicitly with assumptions");
    expect(wizard.getPromptChips("spec")).toContain("Tighten acceptance criteria");
    expect(wizard.getPromptChips("plan")).toContain("Split into smaller subtasks");
  });

  test("renders structured plan subtask cards with deps and tests", () => {
    const html = wizard.renderPlanSubtaskCards([
      {
        id: "t1-subtask-1",
        sequence: 1,
        description: "Create wizard module",
        behavior: "Render the planning wizard helper module.",
        agentType: "coder",
        filesInScope: ["src/web/public/planning-wizard.js"],
        dependencies: [],
        verificationCommands: ["bun test tests/unit/planning-wizard.test.ts"],
        testCriteria: ["Unit tests for phase classification"],
        completionEvidence: ["planning-wizard.test.ts passes"]
      },
      {
        id: "t1-subtask-2",
        sequence: 2,
        description: "Wire dashboard rendering",
        behavior: "Use the module from task detail rendering.",
        agentType: "coder",
        filesInScope: ["src/web/public/dashboard.js"],
        dependencies: ["t1-subtask-1"],
        verificationCommands: ["bun test tests/unit/planning-wizard.test.ts"],
        testCriteria: ["Spec + plan cards render in review states"],
        completionEvidence: ["dashboard render path covered"]
      }
    ]);

    expect(html).toContain("Create wizard module");
    expect(html).toContain("Wire dashboard rendering");
    expect(html).toContain("<strong>Depends on:</strong> #1");
    expect(html).toContain("Verification commands");
    expect(html).toContain("Completion evidence");
    expect(html).toContain("WIP order 2");
    expect(html).toContain("Unit tests for phase classification");
    expect(html).toContain("Spec + plan cards render in review states");
  });

  test("builds advisory and blocking contract warnings", () => {
    const warnings = wizard.buildContractWarnings(
      {
        description: "Broad change",
        filesInScope: ["src/"],
        verificationCommands: ["bun test"],
        testCriteria: ["passes"],
        completionEvidence: ["tests pass"]
      },
      { tier: "THOROUGH" }
    );

    expect(warnings.some((w) => w.level === "blocking" && w.message.includes("behavior"))).toBe(true);
    expect(warnings.some((w) => w.level === "advisory" && w.message.includes("Scope is broad"))).toBe(true);
    expect(warnings.some((w) => w.level === "advisory" && w.message.includes("THOROUGH"))).toBe(true);
  });
});
