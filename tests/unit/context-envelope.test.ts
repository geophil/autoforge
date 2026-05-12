import { describe, expect, test } from "bun:test";
import {
  buildContextEnvelopeFromTask,
  hashContextEnvelope
} from "../../src/orchestrator/context-envelope";
import type { AgentTask } from "../../src/executors/interface";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    type: "planner",
    systemPrompt: "You are planner persona.",
    prompt: "## Task\nShip feature X",
    workspace: {
      id: "ws-1",
      provider: "mock",
      readFile: async () => "",
      writeFile: async () => {},
      exec: async function* () {},
      destroy: async () => {}
    },
    budgetSeconds: 120,
    environment: {},
    skillFiles: [],
    ...overrides
  };
}

describe("context envelope hash", () => {
  test("is deterministic for identical envelopes", () => {
    const task = makeTask({ lessons: "Lesson A" });
    const a = buildContextEnvelopeFromTask(task);
    const b = buildContextEnvelopeFromTask(task);
    expect(hashContextEnvelope(a)).toBe(hashContextEnvelope(b));
  });

  test("changes when any stable prompt input changes", () => {
    const base = buildContextEnvelopeFromTask(makeTask({ lessons: "Lesson A" }));
    const changedPrompt = buildContextEnvelopeFromTask(makeTask({ prompt: "different" }));
    const changedSystem = buildContextEnvelopeFromTask(makeTask({ systemPrompt: "other persona" }));
    const changedLessons = buildContextEnvelopeFromTask(makeTask({ lessons: "Lesson B" }));

    expect(hashContextEnvelope(changedPrompt)).not.toBe(hashContextEnvelope(base));
    expect(hashContextEnvelope(changedSystem)).not.toBe(hashContextEnvelope(base));
    expect(hashContextEnvelope(changedLessons)).not.toBe(hashContextEnvelope(base));
  });

  test("normalizes empty lesson blocks to a stable value", () => {
    const noLessons = buildContextEnvelopeFromTask(makeTask());
    const blankLessons = buildContextEnvelopeFromTask(makeTask({ lessons: "   " }));
    expect(hashContextEnvelope(noLessons)).toBe(hashContextEnvelope(blankLessons));
  });
});
