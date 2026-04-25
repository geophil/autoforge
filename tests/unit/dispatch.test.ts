import { describe, expect, test } from "bun:test";
import { createDispatcher } from "../../src/orchestrator/dispatch";
import { freshDb, seedVariant } from "../helpers/population-fixtures";

type TestDb = ReturnType<typeof freshDb>;

const taskContext = {
  description: "write a database migration",
  tier: "STANDARD" as const,
  projectId: "p"
};

function setCreatedAt(db: TestDb, id: string, createdAt: string): void {
  db.sqlite.query("UPDATE skill_versions SET created_at = ? WHERE id = ?").run(createdAt, id);
}

function seedDispatchPopulation(db: TestDb): void {
  seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.5 });
  seedVariant(db, { id: "active-a", skill: "persona:coder", status: "active", share: 0.3 });
  seedVariant(db, { id: "active-b", skill: "persona:coder", status: "active", share: 0.1 });
  seedVariant(db, { id: "candidate", skill: "persona:coder", status: "candidate", share: 0.0 });
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function expectWithinOnePercent(observed: number, expected: number): void {
  expect(Math.abs(observed - expected)).toBeLessThanOrEqual(0.01);
}

describe("createDispatcher", () => {
  test("population size one returns only_eligible", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 1.0 });
    const dispatcher = createDispatcher(db, { random: () => 0.99 });

    expect(dispatcher.selectVariant("coder", taskContext)).toEqual({
      variantId: "base",
      agentType: "coder",
      rationale: "only_eligible",
      shadowVariantIds: [],
      eligibleVariantIds: ["base"]
    });
  });

  test("specialty filtering excludes nonmatching active and candidate but keeps baseline and generalist", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.5, specialty: "React UI" });
    seedVariant(db, { id: "general", skill: "persona:coder", status: "active", share: 0.2 });
    seedVariant(db, { id: "backend", skill: "persona:coder", status: "active", share: 0.2, specialty: "database migration" });
    seedVariant(db, { id: "frontend", skill: "persona:coder", status: "active", share: 0.1, specialty: "React UI" });
    seedVariant(db, { id: "candidate", skill: "persona:coder", status: "candidate", share: 0, specialty: "CSS layout" });

    const dispatcher = createDispatcher(db, { random: () => 0.99 });

    expect(dispatcher.selectVariant("coder", taskContext).eligibleVariantIds)
      .toEqual(["backend", "base", "general"]);
  });

  test("baseline bucket uses max baseline minimum when stored traffic share is lower", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.3 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.7 });
    const dispatcher = createDispatcher(db, { random: () => 0.49 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "base",
      rationale: "baseline"
    });
  });

  test("baseline bucket uses baseline traffic share when it exceeds minimum", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.7 });
    seedVariant(db, { id: "active", skill: "persona:coder", status: "active", share: 0.3 });
    const dispatcher = createDispatcher(db, { random: () => 0.69 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "base",
      rationale: "baseline"
    });
  });

  test("exploration selects uniformly over active non-baseline competitors", () => {
    const db = freshDb();
    seedDispatchPopulation(db);
    const rolls = [0.55, 0.8];
    const dispatcher = createDispatcher(db, { random: () => rolls.shift() ?? 0 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "active-b",
      rationale: "exploration"
    });
  });

  test("exploration folds to baseline when only candidates compete", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.5 });
    seedVariant(db, { id: "candidate", skill: "persona:coder", status: "candidate", share: 0.0 });
    const dispatcher = createDispatcher(db, { random: () => 0.55 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "base",
      rationale: "baseline",
      shadowVariantIds: ["candidate"]
    });
  });

  test("exploitation selects active variants weighted by traffic share", () => {
    const db = freshDb();
    seedDispatchPopulation(db);
    const rolls = [0.7, 0.8];
    const dispatcher = createDispatcher(db, { random: () => rolls.shift() ?? 0 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "active-b",
      rationale: "exploitation"
    });
  });

  test("candidates are included in shadowVariantIds when live variant is baseline", () => {
    const db = freshDb();
    seedDispatchPopulation(db);
    const dispatcher = createDispatcher(db, { random: () => 0.2 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "base",
      rationale: "baseline",
      shadowVariantIds: ["candidate"]
    });
  });

  test("candidates are included in shadowVariantIds when live variant is active", () => {
    const db = freshDb();
    seedDispatchPopulation(db);
    const rolls = [0.8, 0.1];
    const dispatcher = createDispatcher(db, { random: () => rolls.shift() ?? 0 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "active-a",
      rationale: "exploitation",
      shadowVariantIds: ["candidate"]
    });
  });

  test("shadowVariantIds is capped to three newest eligible candidates", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.5 });
    for (const id of ["candidate-1", "candidate-2", "candidate-3", "candidate-4"]) {
      seedVariant(db, { id, skill: "persona:coder", status: "candidate", share: 0.0 });
    }
    setCreatedAt(db, "candidate-1", "2026-04-24 00:00:01");
    setCreatedAt(db, "candidate-2", "2026-04-24 00:00:02");
    setCreatedAt(db, "candidate-3", "2026-04-24 00:00:03");
    setCreatedAt(db, "candidate-4", "2026-04-24 00:00:04");

    const dispatcher = createDispatcher(db, { random: () => 0.2 });

    expect(dispatcher.selectVariant("coder", taskContext).shadowVariantIds)
      .toEqual(["candidate-4", "candidate-3", "candidate-2"]);
  });

  test("exploration and exploitation fold into baseline with no active competitors", () => {
    const db = freshDb();
    seedVariant(db, { id: "base", skill: "persona:coder", status: "baseline", share: 0.6 });
    seedVariant(db, { id: "frontend", skill: "persona:coder", status: "active", share: 0.4, specialty: "React UI" });
    seedVariant(db, { id: "candidate", skill: "persona:coder", status: "candidate", share: 0.0, specialty: "CSS layout" });
    const dispatcher = createDispatcher(db, { random: () => 0.99 });

    expect(dispatcher.selectVariant("coder", taskContext)).toMatchObject({
      variantId: "base",
      rationale: "baseline",
      shadowVariantIds: [],
      eligibleVariantIds: ["base"]
    });
  });

  test("selection distribution follows configured buckets and active traffic weights", () => {
    const db = freshDb();
    seedDispatchPopulation(db);
    const counts = new Map<string, number>();
    const rationaleCounts = new Map<string, number>();
    const dispatcher = createDispatcher(db, { random: seededRandom(42) });

    for (let i = 0; i < 10_000; i += 1) {
      const selection = dispatcher.selectVariant("coder", taskContext);
      counts.set(selection.variantId, (counts.get(selection.variantId) ?? 0) + 1);
      rationaleCounts.set(selection.rationale, (rationaleCounts.get(selection.rationale) ?? 0) + 1);
    }

    expectWithinOnePercent((counts.get("base") ?? 0) / 10_000, 0.5);
    expectWithinOnePercent((rationaleCounts.get("exploration") ?? 0) / 10_000, 0.1);
    expectWithinOnePercent((rationaleCounts.get("exploitation") ?? 0) / 10_000, 0.4);
    expectWithinOnePercent((counts.get("active-a") ?? 0) / 10_000, 0.3 + 0.1 / 2);
    expectWithinOnePercent((counts.get("active-b") ?? 0) / 10_000, 0.1 + 0.1 / 2);
    expect(counts.get("candidate") ?? 0).toBe(0);
  });
});
