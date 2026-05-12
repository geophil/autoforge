import { describe, expect, test } from "bun:test";
import type { Workspace } from "../../src/runtime/workspace";
import { buildAgentDispatchEnvelope } from "../../src/orchestrator/dispatch-envelope";

function mockWorkspace(): Workspace {
  return {
    id: "ws-1",
    provider: "mock",
    readFile: async () => "",
    writeFile: async () => {},
    exec: async function* () {},
    destroy: async () => {}
  };
}

describe("buildAgentDispatchEnvelope", () => {
  test("builds task prompt with steering prefix and stable hash", () => {
    const one = buildAgentDispatchEnvelope({
      id: "task-1-doc",
      type: "doc",
      systemPrompt: "doc persona",
      basePrompt: "Document the API changes.",
      steeringPrompt: "Focus on migration notes first.",
      workspace: mockWorkspace(),
      budgetSeconds: 120,
      environment: {},
      skillFiles: [],
      metadata: { taskId: "task-1" }
    });
    const two = buildAgentDispatchEnvelope({
      id: "task-1-doc",
      type: "doc",
      systemPrompt: "doc persona",
      basePrompt: "Document the API changes.",
      steeringPrompt: "Focus on migration notes first.",
      workspace: mockWorkspace(),
      budgetSeconds: 120,
      environment: {},
      skillFiles: [],
      metadata: { taskId: "task-1" }
    });

    expect(one.task.prompt).toContain("Focus on migration notes first.");
    expect(one.task.prompt).toContain("Document the API changes.");
    expect(one.contextEnvelopeHash).toBe(two.contextEnvelopeHash);
  });
});
