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
