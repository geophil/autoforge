import { describe, expect, test } from "bun:test";
import { buildSystemPromptForTask } from "../../src/runtime/harness-executor";
import type { AgentTask } from "../../src/executors/interface";
import { MockWorkspace } from "../../src/runtime/mock-workspace";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "t1",
    type: "coder",
    systemPrompt: "You are the coder.",
    prompt: "user prompt",
    workspace: new MockWorkspace({ id: "test-workspace" }),
    budgetSeconds: 60,
    environment: {},
    skillFiles: [],
    ...overrides
  };
}

describe("buildSystemPrompt lesson injection", () => {
  test("inserts # Lessons section after the stable prefix when skills is empty", () => {
    const prompt = buildSystemPromptForTask(makeTask({
      lessons: "# Lessons from past tasks in this lineage\n\n## Lesson L1 (corrective)\nTRIGGER: styling\nOBSERVATION: ...\nPRINCIPLE: ...\nEVIDENCE: ..."
    }));

    const personaIdx = prompt.indexOf("You are the coder.");
    const lessonIdx = prompt.indexOf("# Lessons from past tasks");
    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(lessonIdx).toBeGreaterThan(personaIdx);
    // Lessons are task-derived dynamic context, so the stable status contract
    // remains in the cacheable prefix before the lesson block.
    const statusIdx = prompt.indexOf("# Status Reporting");
    expect(statusIdx).toBeGreaterThan(personaIdx);
    expect(statusIdx).toBeLessThan(lessonIdx);
  });

  test("omits lesson section entirely when lessons is undefined", () => {
    const prompt = buildSystemPromptForTask(makeTask());
    expect(prompt).not.toContain("# Lessons");
  });

  test("omits lesson section when lessons is empty string or whitespace only", () => {
    expect(buildSystemPromptForTask(makeTask({ lessons: "" }))).not.toContain("# Lessons");
    expect(buildSystemPromptForTask(makeTask({ lessons: "   \n\n  " }))).not.toContain("# Lessons");
  });
});
