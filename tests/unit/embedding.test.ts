import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { DbClient } from "../../src/db/client";
import { MockExecutor } from "../../src/executors/mock";
import { WorktreeManager } from "../../src/git/worktrees";
import { loadEnv } from "../../src/config/env";
import { OrchestratorService } from "../../src/orchestrator/service";
import {
  cosineSimilarity,
  createDeterministicEmbeddingProvider,
  deserializeEmbedding,
  serializeEmbedding,
  type EmbeddingProvider
} from "../../src/orchestrator/embedding";

function createBackfillTestService(embeddingProvider: EmbeddingProvider): {
  service: OrchestratorService;
  db: DbClient;
  cleanup: () => void;
} {
  const baseDir = mkdtempSync(join(tmpdir(), "autoforge-backfill-test-"));
  const dbPath = join(baseDir, `${randomUUID()}.sqlite`);
  const db = new DbClient(dbPath);
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_PATH: dbPath,
    EXECUTOR_DEFAULT: "mock",
    REVIEW_SCORE_THRESHOLD: "0.7",
    TEST_PASS_THRESHOLD: "1"
  });
  const service = new OrchestratorService({
    env,
    db,
    executor: new MockExecutor(),
    worktrees: new WorktreeManager(join(baseDir, "worktrees")),
    embeddingProvider,
    testRunner: async () => ({ passRate: 1, output: "mock test runner" })
  });

  return {
    service,
    db,
    cleanup: () => {
      try {
        (db.sqlite as unknown as { close?: () => void }).close?.();
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }
  };
}

function seedSkillVersion(
  db: DbClient,
  input: { id: string; specialty: string | null; embedding?: Buffer | null }
): void {
  db.sqlite.query(`
    INSERT INTO skill_versions (id, skill_name, version, content, specialty, specialty_embedding)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    "persona:coder",
    input.id,
    `content ${input.id}`,
    input.specialty,
    input.embedding ?? null
  );
}

describe("embedding utilities", () => {
  test("serializes and deserializes float vectors as BLOB bytes", () => {
    const vector = [0.1, -0.2, 0.3];
    expect(deserializeEmbedding(serializeEmbedding(vector))).toEqual(vector);
  });

  test("returns null for malformed non-JSON BLOB bytes", () => {
    expect(deserializeEmbedding(Buffer.from("not-json"))).toBeNull();
  });

  test("returns null for malformed non-finite numeric vectors", () => {
    expect(deserializeEmbedding(Buffer.from("[1e999]"))).toBeNull();
  });

  test("cosine similarity ranks identical vectors above unrelated vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  test("deterministic provider returns stable vectors for tests and local fallback", async () => {
    const provider = createDeterministicEmbeddingProvider(8);
    expect(await provider.embed("React styling")).toEqual(await provider.embed("React styling"));
  });
});

describe("specialty embedding backfill", () => {
  test("stores embeddings for skill versions with specialty and missing embedding", async () => {
    const embeddedTexts: string[] = [];
    const { service, db, cleanup } = createBackfillTestService({
      async embed(text: string): Promise<number[]> {
        embeddedTexts.push(text);
        return [0.25, 0.75];
      }
    });

    try {
      seedSkillVersion(db, { id: "needs-embedding", specialty: "database migrations" });
      seedSkillVersion(db, { id: "generalist", specialty: null });

      const updated = await service.backfillSpecialtyEmbeddings();

      expect(updated).toBe(1);
      expect(embeddedTexts).toEqual(["database migrations"]);
      const needsEmbedding = db.sqlite
        .query("SELECT specialty_embedding FROM skill_versions WHERE id = ?")
        .get("needs-embedding") as { specialty_embedding: Buffer | null };
      const generalist = db.sqlite
        .query("SELECT specialty_embedding FROM skill_versions WHERE id = ?")
        .get("generalist") as { specialty_embedding: Buffer | null };
      expect(deserializeEmbedding(needsEmbedding.specialty_embedding)).toEqual([0.25, 0.75]);
      expect(generalist.specialty_embedding).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("continues and leaves embedding null when provider throws", async () => {
    const { service, db, cleanup } = createBackfillTestService({
      async embed(): Promise<number[]> {
        throw new Error("embedding unavailable");
      }
    });

    try {
      seedSkillVersion(db, { id: "fails-embedding", specialty: "React UI" });

      await expect(service.backfillSpecialtyEmbeddings()).resolves.toBe(0);
      const row = db.sqlite
        .query("SELECT specialty_embedding FROM skill_versions WHERE id = ?")
        .get("fails-embedding") as { specialty_embedding: Buffer | null };
      expect(row.specialty_embedding).toBeNull();
    } finally {
      cleanup();
    }
  });
});
