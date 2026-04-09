import { describe, expect, test } from "bun:test";
import { evaluatePrGate } from "../../src/privileged/pr";

describe("pr threshold gate", () => {
  test("accepts fully passing and clean results", () => {
    const result = evaluatePrGate({
      passRate: 1,
      reviewScore: 0.9,
      thresholdScore: 0.7,
      findings: []
    });
    expect(result.accepted).toBeTrue();
  });

  test("rejects unresolved critical findings", () => {
    const result = evaluatePrGate({
      passRate: 1,
      reviewScore: 0.9,
      thresholdScore: 0.7,
      findings: [
        {
          id: "f-1",
          taskId: "t-1",
          severity: "CRITICAL",
          category: "security",
          description: "auth bypass",
          resolved: false
        }
      ]
    });
    expect(result.accepted).toBeFalse();
    expect(result.reason).toBe("critical_findings_unresolved");
  });
});
