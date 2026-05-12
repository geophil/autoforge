import { describe, expect, test } from "bun:test";
import { buildPlannerDispatchEnvelope } from "../../src/orchestrator/planner-envelope";
import type { Workspace } from "../../src/runtime/workspace";

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

describe("buildPlannerDispatchEnvelope", () => {
  test("prefixes steering text while preserving prompt payload", () => {
    const envelope = buildPlannerDispatchEnvelope({
      taskId: "task-1",
      description: "Ship endpoint",
      tier: "STANDARD",
      attempt: 0,
      model: "claude-sonnet-test",
      systemPrompt: "planner persona",
      userPrompt: "## Task\nShip endpoint",
      steeringPrompt: "## Steering\nStay concise",
      workspace: mockWorkspace(),
      budgetSeconds: 120,
      environment: {},
      skillFiles: []
    });

    expect(envelope.task.prompt).toContain("## Steering\nStay concise");
    expect(envelope.task.prompt).toContain("## Task\nShip endpoint");
  });

  test("normalizes blank lesson blocks out of the hash input", () => {
    const a = buildPlannerDispatchEnvelope({
      taskId: "task-1",
      description: "Ship endpoint",
      tier: "STANDARD",
      attempt: 0,
      model: "claude-sonnet-test",
      systemPrompt: "planner persona",
      userPrompt: "## Task\nShip endpoint",
      lessons: "   ",
      workspace: mockWorkspace(),
      budgetSeconds: 120,
      environment: {},
      skillFiles: []
    });
    const b = buildPlannerDispatchEnvelope({
      taskId: "task-1",
      description: "Ship endpoint",
      tier: "STANDARD",
      attempt: 0,
      model: "claude-sonnet-test",
      systemPrompt: "planner persona",
      userPrompt: "## Task\nShip endpoint",
      workspace: mockWorkspace(),
      budgetSeconds: 120,
      environment: {},
      skillFiles: []
    });
    expect(a.contextEnvelopeHash).toBe(b.contextEnvelopeHash);
  });
});
