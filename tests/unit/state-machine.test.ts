import { describe, expect, test } from "bun:test";
import { assertTransition, canTransition } from "../../src/orchestrator/state-machine";

describe("orchestrator state machine", () => {
  test("allows canonical task progression", () => {
    expect(canTransition("received", "assessing")).toBeTrue();
    expect(canTransition("planning", "executing")).toBeTrue();
    expect(canTransition("reviewing", "pr_created")).toBeTrue();
    expect(canTransition("awaiting_approval", "documenting")).toBeTrue();
    expect(canTransition("documenting", "completed")).toBeTrue();
  });

  test("rejects impossible transitions", () => {
    expect(canTransition("received", "completed")).toBeFalse();
    expect(() => assertTransition("received", "completed")).toThrow();
  });
});

describe("plan-review state transitions", () => {
  test("planning -> awaiting_plan_approval is allowed", () => {
    expect(canTransition("planning", "awaiting_plan_approval")).toBe(true);
  });

  test("planning -> executing remains allowed (EXPRESS path)", () => {
    expect(canTransition("planning", "executing")).toBe(true);
  });

  test("awaiting_plan_approval -> executing is allowed (approve)", () => {
    expect(canTransition("awaiting_plan_approval", "executing")).toBe(true);
  });

  test("awaiting_plan_approval -> replanning is allowed (critique)", () => {
    expect(canTransition("awaiting_plan_approval", "replanning")).toBe(true);
  });

  test("awaiting_plan_approval -> failed is allowed (cancel)", () => {
    expect(canTransition("awaiting_plan_approval", "failed")).toBe(true);
  });

  test("replanning -> awaiting_plan_approval is allowed", () => {
    expect(canTransition("replanning", "awaiting_plan_approval")).toBe(true);
  });

  test("replanning -> failed is allowed", () => {
    expect(canTransition("replanning", "failed")).toBe(true);
  });

  test("awaiting_plan_approval -> documenting is NOT allowed", () => {
    expect(canTransition("awaiting_plan_approval", "documenting")).toBe(false);
  });
});

describe("spec-review state transitions", () => {
  test("planning -> awaiting_spec_approval", () => {
    expect(canTransition("planning", "awaiting_spec_approval")).toBe(true);
  });

  test("awaiting_spec_approval -> planning", () => {
    expect(canTransition("awaiting_spec_approval", "planning")).toBe(true);
  });

  test("awaiting_spec_approval -> replanning", () => {
    expect(canTransition("awaiting_spec_approval", "replanning")).toBe(true);
  });

  test("replanning -> awaiting_spec_approval", () => {
    expect(canTransition("replanning", "awaiting_spec_approval")).toBe(true);
  });

  test("awaiting_spec_approval -> failed", () => {
    expect(canTransition("awaiting_spec_approval", "failed")).toBe(true);
  });
});
