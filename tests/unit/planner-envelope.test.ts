import { describe, expect, test } from "bun:test";
import { buildPlannerDispatchEnvelope } from "../../src/orchestrator/planner-envelope";

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
      budgetSeconds: 120,
      environment: {},
      skillFiles: []
    });

    expect(envelope.task.prompt).toContain("## Steering\nStay concise");
    expect(envelope.task.prompt).toContain("## Task\nShip endpoint");
  });

  test("envelope task does not carry workspace; dispatch site attaches it", () => {
    const envelope = buildPlannerDispatchEnvelope({
      taskId: "task-1",
      description: "Ship endpoint",
      tier: "STANDARD",
      attempt: 0,
      model: "claude-sonnet-test",
      systemPrompt: "planner persona",
      userPrompt: "## Task\nShip endpoint",
      budgetSeconds: 120,
      environment: {},
      skillFiles: []
    });
    expect("workspace" in envelope.task).toBe(false);
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
      budgetSeconds: 120,
      environment: {},
      skillFiles: []
    });
    expect(a.contextEnvelopeHash).toBe(b.contextEnvelopeHash);
  });
});
