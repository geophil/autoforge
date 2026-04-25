import { describe, expect, test } from "bun:test";
import {
  mannWhitneyUGreater,
  mannWhitneyULess,
  wilcoxonSignedRankGreaterOrEqual
} from "../../src/orchestrator/sequential-test";

function expectBetween(value: number, min: number, max: number): void {
  expect(value).toBeGreaterThanOrEqual(min);
  expect(value).toBeLessThanOrEqual(max);
}

describe("wilcoxonSignedRankGreaterOrEqual", () => {
  test("detects consistently positive paired differences", () => {
    const result = wilcoxonSignedRankGreaterOrEqual([
      [0.8, 0.6],
      [0.9, 0.7],
      [0.7, 0.6],
      [0.85, 0.65]
    ]);

    expect(result.effect).toBeGreaterThan(0);
    expect(result.n).toBe(4);
    expect(result.pValue).toBeLessThanOrEqual(0.10);
  });

  test("returns neutral high p-value for mixed no-effect pairs", () => {
    const result = wilcoxonSignedRankGreaterOrEqual([
      [0.7, 0.6],
      [0.5, 0.6],
      [0.62, 0.6],
      [0.58, 0.6]
    ]);

    expect(Math.abs(result.effect)).toBeLessThan(0.01);
    expect(result.n).toBe(4);
    expect(result.pValue).toBeGreaterThanOrEqual(0.5);
  });

  test("ignores zero-difference pairs for ranking and n", () => {
    const result = wilcoxonSignedRankGreaterOrEqual([
      [0.8, 0.6],
      [0.6, 0.6],
      [0.9, 0.7],
      [0.5, 0.5]
    ]);

    expect(result.effect).toBeCloseTo(0.1, 10);
    expect(result.n).toBe(2);
    expect(result.pValue).toBeCloseTo(0.25, 10);
  });

  test("returns safe neutral result for empty and all-zero inputs", () => {
    expect(wilcoxonSignedRankGreaterOrEqual([])).toEqual({ pValue: 1, effect: 0, n: 0 });
    expect(wilcoxonSignedRankGreaterOrEqual([[0.5, 0.5]])).toEqual({ pValue: 1, effect: 0, n: 0 });
  });
});

describe("mannWhitneyU", () => {
  test("greater detects sampleA above sampleB", () => {
    const result = mannWhitneyUGreater([0.9, 0.88, 0.92, 0.86], [0.6, 0.62, 0.58, 0.64]);

    expect(result.effect).toBeGreaterThan(0);
    expect(result.n).toBe(8);
    expect(result.pValue).toBeLessThanOrEqual(0.05);
  });

  test("less detects sampleA below sampleB", () => {
    const result = mannWhitneyULess([0.4, 0.42, 0.38, 0.44], [0.7, 0.72, 0.68, 0.74]);

    expect(result.effect).toBeLessThan(0);
    expect(result.n).toBe(8);
    expect(result.pValue).toBeLessThanOrEqual(0.05);
  });

  test("returns neutral high p-value for overlapping similar samples", () => {
    const result = mannWhitneyUGreater([0.5, 0.6, 0.7, 0.8], [0.52, 0.61, 0.69, 0.79]);

    expectBetween(result.effect, -0.01, 0.01);
    expect(result.n).toBe(8);
    expect(result.pValue).toBeGreaterThanOrEqual(0.4);
  });

  test("returns safe neutral result for empty and singleton inputs", () => {
    const singleton = mannWhitneyULess([0.5], [0.6, 0.7]);

    expect(mannWhitneyUGreater([], [0.5, 0.6])).toEqual({ pValue: 1, effect: 0, n: 0 });
    expect(singleton.pValue).toBe(1);
    expect(singleton.effect).toBeCloseTo(-0.15, 10);
    expect(singleton.n).toBe(0);
  });

  test("handles ties deterministically", () => {
    const greater = mannWhitneyUGreater([1, 1, 2, 2], [1, 2, 2, 3]);
    const less = mannWhitneyULess([1, 1, 2, 2], [1, 2, 2, 3]);

    expect(greater.effect).toBeCloseTo(-0.5, 10);
    expect(less.effect).toBeCloseTo(-0.5, 10);
    expect(greater.n).toBe(8);
    expect(less.n).toBe(8);
    expect(greater.pValue).toBeGreaterThan(less.pValue);
    expectBetween(greater.pValue, 0, 1);
    expectBetween(less.pValue, 0, 1);
  });
});
