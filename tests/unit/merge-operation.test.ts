import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";
import { handleMetaOperation } from "../../src/orchestrator/meta-operations";
import type { MetaOperation } from "../../src/schemas/meta-output";

const schemaPath = resolve(process.cwd(), "src/db/schema.sql");
const migrationsPath = resolve(process.cwd(), "src/db/migrations");

function freshDb(): { db: DbClient; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "merge-operation-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(schemaPath, migrationsPath);
  return {
    db,
    cleanup: () => {
      try {
        (db.sqlite as unknown as { close?: () => void }).close?.();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

function seedVariant(
  db: DbClient,
  input: {
    id: string;
    skill?: string;
    status?: "baseline" | "candidate" | "active" | "demoted" | "retired";
    share?: number;
    parent?: string | null;
    specialty?: string | null;
    content?: string;
    createdAt?: string;
  }
): void {
  db.sqlite.query(`
    INSERT INTO skill_versions
      (id, skill_name, version, content, status, traffic_share, parent_version_id, specialty, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.skill ?? "persona:coder",
    input.id,
    input.content ?? `${input.skill ?? "persona:coder"} ${input.id}`,
    input.status ?? "active",
    input.share ?? 0.1,
    input.parent ?? null,
    input.specialty ?? null,
    input.createdAt ?? "2026-04-19T00:00:00Z"
  );
}

function mergeOperation(targetId: string, sourceId: string): MetaOperation {
  return {
    kind: "merge",
    target_variant_id: targetId,
    merge_source_variant_id: sourceId,
    hypothesis: "variants are statistically indistinguishable",
    evidence: { task_ids: ["evidence-task"], metric_name: "task_quality_score", metric_before: 0.9 }
  };
}

function runMerge(db: DbClient, targetId: string, sourceId: string) {
  return handleMetaOperation({
    db,
    // Persist canonical events the way OrchestratorService.recordEvent would,
    // so tests that read variants_merged events back from the DB observe them.
    recordEvent: (event) => {
      db.appendEvent({
        id: randomUUID(),
        taskId: event.taskId,
        projectId: event.projectId,
        timestamp: new Date().toISOString(),
        agent: event.agent,
        type: event.type,
        status: event.status,
        payload: event.analyticsOnly ? { ...event.payload, __analytics_only: true } : event.payload,
        budgetSeconds: event.budgetSeconds,
        elapsedSeconds: event.elapsedSeconds
      });
    },
    operation: mergeOperation(targetId, sourceId),
    metaTaskId: "meta-merge-task",
    worktreePath: "/tmp/nope",
    projectId: "autoforge"
  });
}

function seedScoredObservation(
  db: DbClient,
  input: {
    taskId: string;
    variantId: string;
    linesChanged: number;
    selectedAt: string;
  }
): void {
  db.sqlite.query(`
    INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
    VALUES (?, 'autoforge', 'merge observation', 'completed', 'STANDARD', '{}', '[]', 0, ?, ?)
  `).run(input.taskId, input.selectedAt, input.selectedAt);

  db.insertTaskDiffStats(input.taskId, {
    files_changed: 1,
    files_added: 0,
    files_modified: 1,
    files_deleted: 0,
    lines_added: input.linesChanged,
    lines_deleted: 0,
    test_files_changed: 1
  });

  db.sqlite.query(`
    INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
    VALUES (?, ?, ?, 'autoforge', 'orchestrator', 'variant_selected', 'done', ?, 60)
  `).run(
    randomUUID(),
    input.taskId,
    input.selectedAt,
    JSON.stringify({
      agent_type: "coder",
      selected_variant_id: input.variantId,
      selected_variant_specialty: null,
      eligible_variant_ids: [input.variantId],
      selection_rationale: "exploitation",
      shadow_variant_ids: [],
      injected_lesson_ids: []
    })
  );
}

function seedObservations(db: DbClient, variantId: string, linesChanged: number, count = 30): void {
  for (let index = 0; index < count; index += 1) {
    seedScoredObservation(db, {
      taskId: `${variantId}-task-${index}`,
      variantId,
      linesChanged,
      selectedAt: `2026-04-24T00:${String(index).padStart(2, "0")}:00Z`
    });
  }
}

function seedObservationLines(db: DbClient, variantId: string, linesChanged: number[]): void {
  linesChanged.forEach((lineCount, index) => {
    seedScoredObservation(db, {
      taskId: `${variantId}-task-${index}`,
      variantId,
      linesChanged: lineCount,
      selectedAt: `2026-04-24T00:${String(index).padStart(2, "0")}:00Z`
    });
  });
}

function variantRow(db: DbClient, id: string): {
  status: string;
  traffic_share: number;
  specialty: string | null;
  specialty_embedding: Buffer | null;
} {
  return db.sqlite
    .query("SELECT status, traffic_share, specialty, specialty_embedding FROM skill_versions WHERE id = ?")
    .get(id) as {
      status: string;
      traffic_share: number;
      specialty: string | null;
      specialty_embedding: Buffer | null;
    };
}

function eventPayloads(db: DbClient, type: string): Record<string, unknown>[] {
  return (db.sqlite
    .query("SELECT payload FROM events WHERE event_type = ? ORDER BY rowid ASC")
    .all(type) as Array<{ payload: string }>)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

describe("handleMetaOperation merge execution", () => {
  test("rejects missing target with target_not_found", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "source" });

      expect(runMerge(db, "missing-target", "source")).toEqual({ ok: false, reason: "target_not_found" });
    } finally {
      cleanup();
    }
  });

  test("rejects missing merge source with merge_source_not_found", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "target" });

      expect(runMerge(db, "target", "missing-source")).toEqual({ ok: false, reason: "merge_source_not_found" });
    } finally {
      cleanup();
    }
  });

  test("rejects self-merge with merge_requires_distinct_variants and leaves variant active", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root", status: "baseline", share: 0.8 });
      seedVariant(db, { id: "variant", parent: "root", status: "active", share: 0.1 });
      seedObservations(db, "variant", 20);

      expect(runMerge(db, "variant", "variant")).toEqual({ ok: false, reason: "merge_requires_distinct_variants" });
      expect(variantRow(db, "variant")).toMatchObject({ status: "active", traffic_share: 0.1 });
    } finally {
      cleanup();
    }
  });

  test("rejects cross-lineage merge with merge_lineage_mismatch", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root-a", status: "baseline", share: 0.8 });
      seedVariant(db, { id: "a", parent: "root-a" });
      seedVariant(db, { id: "root-b", status: "baseline", share: 0.8 });
      seedVariant(db, { id: "b", parent: "root-b" });

      expect(runMerge(db, "a", "b")).toEqual({ ok: false, reason: "merge_lineage_mismatch" });
    } finally {
      cleanup();
    }
  });

  test("rejects cross-agent merge with merge_agent_type_mismatch", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "coder-root", skill: "persona:coder", status: "baseline", share: 0.8 });
      seedVariant(db, { id: "coder-active", skill: "persona:coder", parent: "coder-root" });
      seedVariant(db, { id: "doc-active", skill: "persona:doc", parent: "coder-root" });

      expect(runMerge(db, "coder-active", "doc-active")).toEqual({ ok: false, reason: "merge_agent_type_mismatch" });
    } finally {
      cleanup();
    }
  });

  test("rejects inactive variants with merge_requires_active_variants", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root", status: "baseline", share: 0.8 });
      seedVariant(db, { id: "active", parent: "root", status: "active" });
      seedVariant(db, { id: "retired", parent: "root", status: "retired", share: 0 });

      expect(runMerge(db, "active", "retired")).toEqual({ ok: false, reason: "merge_requires_active_variants" });
    } finally {
      cleanup();
    }
  });

  test("rejects insufficient observations with merge_insufficient_observations", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root", status: "baseline", share: 0.8 });
      seedVariant(db, { id: "a", parent: "root" });
      seedVariant(db, { id: "b", parent: "root" });
      seedObservations(db, "a", 20, 29);
      seedObservations(db, "b", 20, 30);

      expect(db.loadRecentCompositeScoresForVariant("a", 30)).toHaveLength(29);
      expect(runMerge(db, "a", "b")).toEqual({ ok: false, reason: "merge_insufficient_observations" });
    } finally {
      cleanup();
    }
  });

  test("rejects dissimilar score distributions with merge_not_indistinguishable", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root", status: "baseline", share: 0.8 });
      seedVariant(db, { id: "a", parent: "root" });
      seedVariant(db, { id: "b", parent: "root" });
      seedObservations(db, "a", 20);
      seedObservations(db, "b", 1800);

      expect(runMerge(db, "a", "b")).toEqual({ ok: false, reason: "merge_not_indistinguishable" });
    } finally {
      cleanup();
    }
  });

  test("merges indistinguishable active same-lineage variants", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root", status: "baseline", share: 0.8 });
      seedVariant(db, {
        id: "target",
        parent: "root",
        share: 0.1,
        specialty: "fast API work",
        content: "short survivor",
        createdAt: "2026-04-20T00:00:00Z"
      });
      seedVariant(db, {
        id: "source",
        parent: "root",
        share: 0.1,
        specialty: "backend reliability",
        content: "this persona content is longer than the target",
        createdAt: "2026-04-21T00:00:00Z"
      });
      db.sqlite
        .query("UPDATE skill_versions SET specialty_embedding = ? WHERE id = ?")
        .run(Buffer.from([1, 2, 3]), "target");
      seedObservations(db, "target", 20);
      seedObservations(db, "source", 20);

      const targetScores = db.loadRecentCompositeScoresForVariant("target", 30);
      const sourceScores = db.loadRecentCompositeScoresForVariant("source", 30);
      expect(targetScores).toHaveLength(30);
      expect(sourceScores).toHaveLength(30);

      const result = runMerge(db, "target", "source");

      expect(result.ok).toBe(true);
      expect(result.experimentId).toBeString();
      const survivor = variantRow(db, "target");
      expect(survivor.status).toBe("active");
      expect(survivor.traffic_share).toBe(0.1);
      expect(survivor.specialty).toBe("fast API work + backend reliability");
      expect(survivor.specialty_embedding).toBeNull();
      expect(variantRow(db, "source")).toMatchObject({ status: "retired", traffic_share: 0 });

      const mergeEvents = eventPayloads(db, "variants_merged");
      expect(mergeEvents).toHaveLength(1);
      expect(mergeEvents[0]).toMatchObject({
        experiment_id: result.experimentId,
        kept_variant_id: "target",
        retired_variant_id: "source",
        merged_specialty: "fast API work + backend reliability",
        tie_breaker_used: "text_size"
      });

      const experiments = db.sqlite
        .query("SELECT operation, status FROM experiments WHERE id = ?")
        .get(result.experimentId as string) as { operation: string; status: string };
      expect(experiments).toEqual({ operation: "merge", status: "active" });

      const allocationEvents = eventPayloads(db, "traffic_allocated");
      expect(allocationEvents.some((payload) => payload.reason === "meta_merge")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("uses text size when source mean advantage is within the merge tie window", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root", status: "baseline", share: 0.8 });
      seedVariant(db, {
        id: "target",
        parent: "root",
        share: 0.1,
        specialty: "short specialist",
        content: "short",
        createdAt: "2026-04-20T00:00:00Z"
      });
      seedVariant(db, {
        id: "source",
        parent: "root",
        share: 0.1,
        specialty: "long specialist",
        content: "this source persona content is intentionally longer",
        createdAt: "2026-04-21T00:00:00Z"
      });
      seedObservationLines(db, "target", Array(30).fill(20));
      seedObservationLines(db, "source", [19, ...Array(29).fill(20)]);

      const targetMean = mean(db.loadRecentCompositeScoresForVariant("target", 30));
      const sourceMean = mean(db.loadRecentCompositeScoresForVariant("source", 30));
      expect(sourceMean).toBeGreaterThan(targetMean);
      expect(sourceMean - targetMean).toBeLessThanOrEqual(0.005);

      const result = runMerge(db, "target", "source");

      expect(result.ok).toBe(true);
      expect(variantRow(db, "target")).toMatchObject({ status: "active", traffic_share: 0.1 });
      expect(variantRow(db, "source")).toMatchObject({ status: "retired", traffic_share: 0 });
      const mergeEvents = eventPayloads(db, "variants_merged");
      expect(mergeEvents[0]).toMatchObject({
        kept_variant_id: "target",
        retired_variant_id: "source",
        tie_breaker_used: "text_size"
      });
    } finally {
      cleanup();
    }
  });

  test("keeps source by composite score when mean advantage exceeds the merge tie window", () => {
    const { db, cleanup } = freshDb();
    try {
      seedVariant(db, { id: "root", status: "baseline", share: 0.8 });
      seedVariant(db, {
        id: "target",
        parent: "root",
        share: 0.1,
        specialty: "short specialist",
        content: "short",
        createdAt: "2026-04-20T00:00:00Z"
      });
      seedVariant(db, {
        id: "source",
        parent: "root",
        share: 0.1,
        specialty: "long specialist",
        content: "this source persona content is intentionally longer",
        createdAt: "2026-04-21T00:00:00Z"
      });
      seedObservationLines(db, "target", [...Array(7).fill(40), ...Array(23).fill(20)]);
      seedObservationLines(db, "source", [...Array(7).fill(0), ...Array(23).fill(20)]);

      const targetMean = mean(db.loadRecentCompositeScoresForVariant("target", 30));
      const sourceMean = mean(db.loadRecentCompositeScoresForVariant("source", 30));
      expect(sourceMean - targetMean).toBeGreaterThan(0.005);
      expect(sourceMean - targetMean).toBeLessThan(0.03);

      const result = runMerge(db, "target", "source");

      expect(result.ok).toBe(true);
      expect(variantRow(db, "source")).toMatchObject({ status: "active", traffic_share: 0.1 });
      expect(variantRow(db, "target")).toMatchObject({ status: "retired", traffic_share: 0 });
      const mergeEvents = eventPayloads(db, "variants_merged");
      expect(mergeEvents[0]).toMatchObject({
        kept_variant_id: "source",
        retired_variant_id: "target",
        tie_breaker_used: "composite_score"
      });
    } finally {
      cleanup();
    }
  });
});

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
