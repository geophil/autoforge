import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeComposite,
  getRewardWeights,
  resetRewardWeightsCache,
  validateRewardWeights
} from "../../src/config/reward";

function writeRewardConfigFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "reward-config-test-"));
  const path = join(dir, "reward-weights.json");
  writeFileSync(path, JSON.stringify(contents, null, 2));
  return path;
}

afterEach(() => {
  resetRewardWeightsCache();
});

describe("reward config", () => {
  test("getRewardWeights loads the default config", () => {
    const weights = getRewardWeights();
    expect(weights.correctness).toBe(0.2);
    expect(weights.simplicity).toBe(0.2);
    expect(weights.alignment).toBe(0.2);
    expect(weights.fidelity).toBe(0.2);
    expect(weights.efficiency).toBe(0.2);
  });

  test("getRewardWeights throws when config version is unsupported", () => {
    const path = writeRewardConfigFile({
      version: 2,
      weights: {
        correctness: 0.2,
        simplicity: 0.2,
        alignment: 0.2,
        fidelity: 0.2,
        efficiency: 0.2
      }
    });

    expect(() => getRewardWeights(path)).toThrow(/version/i);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("getRewardWeights throws when top-level weights is missing", () => {
    const path = writeRewardConfigFile({ version: 1 });

    expect(() => getRewardWeights(path)).toThrow(/weights/i);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("getRewardWeights returns an isolated copy", () => {
    const first = getRewardWeights();
    first.correctness = 0.9;

    const second = getRewardWeights();
    expect(second.correctness).toBe(0.2);
  });

  test("computeComposite applies weights correctly", () => {
    const composite = computeComposite({
      r_correctness: 1.0,
      r_simplicity: 0.5,
      r_alignment: 0.8,
      r_fidelity: 1.0,
      r_efficiency: 0.6
    });

    expect(composite).toBeCloseTo(0.78, 5);
  });

  test("validateRewardWeights throws when weights do not sum to 1.0", () => {
    expect(() =>
      validateRewardWeights({
        correctness: 0.3,
        simplicity: 0.2,
        alignment: 0.2,
        fidelity: 0.2,
        efficiency: 0.2
      })
    ).toThrow(/sum/);
  });

  test("validateRewardWeights throws on missing key", () => {
    expect(() =>
      validateRewardWeights({
        correctness: 0.2,
        simplicity: 0.2,
        alignment: 0.2,
        fidelity: 0.2
      } as never)
    ).toThrow(/missing|efficiency/i);
  });

  test("validateRewardWeights throws on negative value", () => {
    expect(() =>
      validateRewardWeights({
        correctness: -0.1,
        simplicity: 0.3,
        alignment: 0.3,
        fidelity: 0.3,
        efficiency: 0.2
      })
    ).toThrow(/negative/i);
  });

  test("validateRewardWeights throws on string value", () => {
    expect(() =>
      validateRewardWeights({
        correctness: "0.2",
        simplicity: 0.2,
        alignment: 0.2,
        fidelity: 0.2,
        efficiency: 0.2
      } as never)
    ).toThrow(/number|finite/i);
  });

  test("validateRewardWeights throws on boolean value", () => {
    expect(() =>
      validateRewardWeights({
        correctness: true,
        simplicity: 0,
        alignment: 0.2,
        fidelity: 0.4,
        efficiency: 0.4
      } as never)
    ).toThrow(/number|finite/i);
  });
});
