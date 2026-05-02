# Autoforge Spec D - Population Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the self-improving persona population loop by adding heterogeneity diagnostics, embedding-based specialty routing, first-fork approval and rejection workflow, merge execution, and QMD documentation sync.

**Architecture:** Spec D builds on the shipped A/B/C foundation. New migrations add `fork_proposals` and `skill_versions.specialty_embedding`. A small embedding layer feeds an async classifier that replaces Spec C's keyword matcher as the primary eligibility filter while keeping keyword and baseline fallbacks. A diagnostician utility persona periodically turns task-history clusters into fork proposals. Fork approval materializes candidates with embeddings; merge execution retires statistically indistinguishable redundant variants through the existing allocation path.

**Tech Stack:** TypeScript, Bun test, SQLite via `DbClient`, Hono routes, existing event log, existing mock executor, existing nonparametric tests in `sequential-test.ts`, `fetch` for optional OpenAI-compatible embeddings, no new package dependency required.

---

## File Structure

**Create:**

```text
src/db/migrations/009_fork_proposals.sql
src/db/migrations/010_specialty_embedding.sql
src/orchestrator/embedding.ts
src/orchestrator/classifier.ts
src/orchestrator/diagnostic.ts
src/personas/diagnostician.md
src/web/routes/diagnostic.ts
src/cli/index.ts
src/cli/experiments.ts
tests/unit/fork-proposals-schema.test.ts
tests/unit/specialty-embedding-schema.test.ts
tests/unit/embedding.test.ts
tests/unit/classifier.test.ts
tests/unit/diagnostic.test.ts
tests/unit/experiments-route.test.ts
tests/unit/diagnostic-route.test.ts
tests/unit/cli-experiments.test.ts
tests/unit/merge-operation.test.ts
tests/integration/spec-d-autonomous-loop.test.ts
```

**Modify:**

```text
src/config/env.ts
src/config/dispatch.ts
src/db/client.ts
src/orchestrator/dispatch.ts
src/orchestrator/service.ts
src/orchestrator/meta-operations.ts
src/orchestrator/allocation.ts
src/orchestrator/sequential-test.ts
src/personas/meta.md
src/schemas/meta-output.ts
src/types/core.ts
src/web/routes/experiments.ts
src/web/server.ts
package.json
docs/qmd/architecture-overview.md
docs/qmd/domain-task-orchestration.md
docs/qmd/domain-agent-execution.md
docs/qmd/domain-event-sourcing.md
docs/qmd/domain-web-api.md
docs/qmd/data-models.md
docs/qmd/configuration.md
```

**Migration numbering note:** Spec D's design doc names migrations `008` and `009`, but Spec B already shipped `008_experiments_proposed_content.sql`. Use `009_fork_proposals.sql` and `010_specialty_embedding.sql`.

---

## Conventions

- Use TDD for every code task: failing test, failing run, implementation, passing run.
- Preserve existing A/B/C behavior for population size 1.
- Dispatch is allowed to become async. The orchestrator already awaits agent setup points, so this is preferable to hiding network work in synchronous code.
- Embedding calls are optional in local/test mode. Tests use an injected deterministic provider; production uses an OpenAI-compatible HTTP provider only when `OPENAI_API_KEY` is configured.
- Baseline remains the safety net. If classifier embedding fails or no specialist matches, dispatch still returns the baseline plus any eligible generalists from the fallback chain.
- No new dependency is required for embeddings or CLI. Use `fetch`, Bun runtime, and Hono test requests.

---

## Task 1: Schema Additions and Fork Proposal Helpers

**Files:**
- Create: `src/db/migrations/009_fork_proposals.sql`
- Create: `src/db/migrations/010_specialty_embedding.sql`
- Modify: `src/db/client.ts`
- Test: `tests/unit/fork-proposals-schema.test.ts`
- Test: `tests/unit/specialty-embedding-schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/unit/fork-proposals-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "fork-proposals-schema-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

describe("fork_proposals schema", () => {
  test("table and open index exist", () => {
    const db = freshDb();
    const cols = db.sqlite.query("PRAGMA table_info(fork_proposals)").all() as Array<{ name: string; type: string; notnull: number }>;
    const names = cols.map((col) => col.name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "agent_type", "generated_at", "generator", "label", "keywords",
      "suggested_specialty", "representative_task_ids", "baseline_score_mean",
      "population_score_mean", "score_gap", "recommendation_strength",
      "status", "acted_on_experiment_id", "closed_at"
    ]));
    expect(cols.find((col) => col.name === "agent_type")?.notnull).toBe(1);

    const indexes = db.sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fork_proposals'").all() as Array<{ name: string }>;
    expect(indexes.map((idx) => idx.name)).toContain("idx_fork_proposals_open");
  });
});
```

Create `tests/unit/specialty-embedding-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "specialty-embedding-schema-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

describe("skill_versions specialty_embedding schema", () => {
  test("specialty_embedding exists as nullable BLOB", () => {
    const db = freshDb();
    const cols = db.sqlite.query("PRAGMA table_info(skill_versions)").all() as Array<{ name: string; type: string; notnull: number }>;
    const col = cols.find((entry) => entry.name === "specialty_embedding");
    expect(col?.type).toBe("BLOB");
    expect(col?.notnull).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test tests/unit/fork-proposals-schema.test.ts tests/unit/specialty-embedding-schema.test.ts --timeout 20000
```

Expected: both tests fail because the table and column do not exist.

- [ ] **Step 3: Add migrations**

Create `src/db/migrations/009_fork_proposals.sql`:

```sql
-- 009: Spec D fork proposals from heterogeneity diagnostics.

CREATE TABLE IF NOT EXISTS fork_proposals (
  id                      TEXT PRIMARY KEY,
  agent_type              TEXT NOT NULL,
  generated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  generator               TEXT NOT NULL DEFAULT 'diagnostician',
  label                   TEXT NOT NULL,
  keywords                TEXT NOT NULL,
  suggested_specialty     TEXT NOT NULL,
  representative_task_ids TEXT NOT NULL,
  baseline_score_mean     REAL NOT NULL,
  population_score_mean   REAL NOT NULL,
  score_gap               REAL NOT NULL,
  recommendation_strength TEXT NOT NULL CHECK (recommendation_strength IN ('weak', 'moderate', 'strong')),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acted_on', 'stale', 'dismissed')),
  acted_on_experiment_id  TEXT REFERENCES experiments(id),
  closed_at               TEXT
);

CREATE INDEX IF NOT EXISTS idx_fork_proposals_open
  ON fork_proposals(agent_type, status, generated_at);
```

Create `src/db/migrations/010_specialty_embedding.sql`:

```sql
-- 010: Opaque embedding bytes for variant specialties. Backfill is application-side.

ALTER TABLE skill_versions ADD COLUMN specialty_embedding BLOB;
```

- [ ] **Step 4: Add DbClient types and helpers**

In `src/db/client.ts`, add:

```typescript
export interface ForkProposalInsert {
  id: string;
  agentType: string;
  label: string;
  keywords: string;
  suggestedSpecialty: string;
  representativeTaskIds: string[];
  baselineScoreMean: number;
  populationScoreMean: number;
  scoreGap: number;
  recommendationStrength: "weak" | "moderate" | "strong";
}

export interface ForkProposalRow {
  id: string;
  agent_type: string;
  generated_at: string;
  generator: string;
  label: string;
  keywords: string;
  suggested_specialty: string;
  representative_task_ids: string;
  baseline_score_mean: number;
  population_score_mean: number;
  score_gap: number;
  recommendation_strength: "weak" | "moderate" | "strong";
  status: "open" | "acted_on" | "stale" | "dismissed";
  acted_on_experiment_id: string | null;
  closed_at: string | null;
}
```

Add methods to the `DbClient` class:

```typescript
insertForkProposal(input: ForkProposalInsert): void {
  this.sqlite.query(`
    INSERT OR IGNORE INTO fork_proposals
      (id, agent_type, label, keywords, suggested_specialty, representative_task_ids,
       baseline_score_mean, population_score_mean, score_gap, recommendation_strength)
    VALUES
      ($id, $agent_type, $label, $keywords, $suggested_specialty, $representative_task_ids,
       $baseline_score_mean, $population_score_mean, $score_gap, $recommendation_strength)
  `).run({
    $id: input.id,
    $agent_type: input.agentType,
    $label: input.label,
    $keywords: input.keywords,
    $suggested_specialty: input.suggestedSpecialty,
    $representative_task_ids: JSON.stringify(input.representativeTaskIds),
    $baseline_score_mean: input.baselineScoreMean,
    $population_score_mean: input.populationScoreMean,
    $score_gap: input.scoreGap,
    $recommendation_strength: input.recommendationStrength
  });
}

listOpenForkProposals(agentType?: string): ForkProposalRow[] {
  if (agentType) {
    return this.sqlite.query(`
      SELECT * FROM fork_proposals
       WHERE status = 'open' AND agent_type = ?
       ORDER BY generated_at DESC, id ASC
    `).all(agentType) as ForkProposalRow[];
  }
  return this.sqlite.query(`
    SELECT * FROM fork_proposals
     WHERE status = 'open'
     ORDER BY generated_at DESC, id ASC
  `).all() as ForkProposalRow[];
}

getForkProposal(id: string): ForkProposalRow | null {
  const row = this.sqlite.query("SELECT * FROM fork_proposals WHERE id = ?").get(id) as ForkProposalRow | undefined;
  return row ?? null;
}

markForkProposalActedOn(proposalId: string, experimentId: string): void {
  this.sqlite.query(`
    UPDATE fork_proposals
       SET status = 'acted_on', acted_on_experiment_id = ?, closed_at = datetime('now')
     WHERE id = ? AND status = 'open'
  `).run(experimentId, proposalId);
}

markStaleForkProposals(daysOld: number): number {
  const result = this.sqlite.query(`
    UPDATE fork_proposals
       SET status = 'stale', closed_at = datetime('now')
     WHERE status = 'open'
       AND generated_at < datetime('now', '-' || ? || ' days')
  `).run(daysOld);
  return result.changes;
}

updateSpecialtyEmbedding(variantId: string, embedding: Buffer): void {
  this.sqlite.query("UPDATE skill_versions SET specialty_embedding = ? WHERE id = ?").run(embedding, variantId);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test tests/unit/fork-proposals-schema.test.ts tests/unit/specialty-embedding-schema.test.ts --timeout 20000
bun run lint
```

Expected: tests pass and TypeScript exits 0.

---

## Task 2: Embedding Module and Configuration

**Files:**
- Create: `src/orchestrator/embedding.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/dispatch.ts`
- Test: `tests/unit/embedding.test.ts`

- [ ] **Step 1: Write failing embedding tests**

Create `tests/unit/embedding.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  cosineSimilarity,
  createDeterministicEmbeddingProvider,
  deserializeEmbedding,
  serializeEmbedding
} from "../../src/orchestrator/embedding";

describe("embedding utilities", () => {
  test("serializes and deserializes float vectors as BLOB bytes", () => {
    const vector = [0.1, -0.2, 0.3];
    expect(deserializeEmbedding(serializeEmbedding(vector))).toEqual(vector);
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
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
bun test tests/unit/embedding.test.ts --timeout 20000
```

Expected: fails because `embedding.ts` does not exist.

- [ ] **Step 3: Extend config**

In `src/config/env.ts`, add to `EnvSchema`:

```typescript
OPENAI_API_KEY: z.string().optional(),
EMBEDDING_PROVIDER: z.enum(["deterministic", "openai"]).default("deterministic"),
EMBEDDING_MODEL: z.string().default("text-embedding-3-small")
```

In `src/config/dispatch.ts`, extend `DispatchConfig`:

```typescript
  similarityThreshold: number;
  diagnosticTriggerTaskCount: number;
  forkApprovalTimeoutDays: number;
  forkProposalStaleDays: number;
```

Extend `defaultDispatchConfig`:

```typescript
  similarityThreshold: 0.55,
  diagnosticTriggerTaskCount: 50,
  forkApprovalTimeoutDays: 30,
  forkProposalStaleDays: 14
```

- [ ] **Step 4: Implement embedding module**

Create `src/orchestrator/embedding.ts`:

```typescript
import { createHash } from "node:crypto";
import type { AppEnv } from "../config/env";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export function serializeEmbedding(vector: number[]): Buffer {
  const payload = JSON.stringify(vector);
  return Buffer.from(payload, "utf8");
}

export function deserializeEmbedding(blob: Buffer | Uint8Array | null): number[] | null {
  if (!blob) return null;
  const raw = Buffer.from(blob).toString("utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "number")) {
    return null;
  }
  return parsed;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function createDeterministicEmbeddingProvider(dimensions = 64): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      const normalized = text.toLowerCase().trim();
      const values = new Array<number>(dimensions).fill(0);
      for (const token of normalized.split(/[^a-z0-9]+/).filter(Boolean)) {
        const digest = createHash("sha256").update(token).digest();
        for (let i = 0; i < dimensions; i += 1) {
          values[i] += ((digest[i % digest.length] / 255) * 2) - 1;
        }
      }
      const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
      return norm === 0 ? values : values.map((value) => value / norm);
    }
  };
}

export function createOpenAIEmbeddingProvider(input: { apiKey: string; model: string }): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`
        },
        body: JSON.stringify({ model: input.model, input: text })
      });
      if (!response.ok) {
        throw new Error(`embedding request failed: ${response.status}`);
      }
      const body = await response.json() as { data?: Array<{ embedding?: number[] }> };
      const embedding = body.data?.[0]?.embedding;
      if (!embedding || !embedding.every(Number.isFinite)) {
        throw new Error("embedding response missing numeric vector");
      }
      return embedding;
    }
  };
}

export function createEmbeddingProvider(env: AppEnv): EmbeddingProvider {
  if (env.EMBEDDING_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
    }
    return createOpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY, model: env.EMBEDDING_MODEL });
  }
  return createDeterministicEmbeddingProvider();
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test tests/unit/embedding.test.ts --timeout 20000
bun run lint
```

Expected: tests pass and TypeScript exits 0.

---

## Task 3: Embedding Classifier With Fallback Chain

**Files:**
- Create: `src/orchestrator/classifier.ts`
- Modify: `src/db/client.ts`
- Test: `tests/unit/classifier.test.ts`

- [ ] **Step 1: Write failing classifier tests**

Create `tests/unit/classifier.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { filterSpecialtyEligible } from "../../src/orchestrator/classifier";
import { serializeEmbedding } from "../../src/orchestrator/embedding";
import type { DispatchVariantRow } from "../../src/db/client";

function variant(input: Partial<DispatchVariantRow> & { id: string; status: DispatchVariantRow["status"] }): DispatchVariantRow {
  return {
    id: input.id,
    skill_name: "persona:coder",
    content: "content",
    status: input.status,
    traffic_share: 0,
    parent_version_id: null,
    specialty: input.specialty ?? null,
    specialty_embedding: input.specialty_embedding ?? null,
    created_at: "2026-04-28T00:00:00Z"
  };
}

describe("filterSpecialtyEligible", () => {
  test("baseline is always eligible", async () => {
    const rows = [variant({ id: "base", status: "baseline", specialty: "database" })];
    const eligible = await filterSpecialtyEligible(rows, "React styling", {
      provider: { embed: async () => [1, 0] },
      similarityThreshold: 0.55
    });
    expect(eligible.map((row) => row.id)).toEqual(["base"]);
  });

  test("embedding match includes specialist over threshold", async () => {
    const rows = [
      variant({ id: "base", status: "baseline" }),
      variant({ id: "style", status: "active", specialty: "React styling", specialty_embedding: serializeEmbedding([1, 0]) }),
      variant({ id: "db", status: "active", specialty: "database migrations", specialty_embedding: serializeEmbedding([0, 1]) })
    ];
    const eligible = await filterSpecialtyEligible(rows, "CSS module task", {
      provider: { embed: async () => [1, 0] },
      similarityThreshold: 0.55
    });
    expect(eligible.map((row) => row.id)).toEqual(["base", "style"]);
  });

  test("embedding failure falls back to keyword matching", async () => {
    const rows = [
      variant({ id: "base", status: "baseline" }),
      variant({ id: "frontend", status: "active", specialty: "React component styling" })
    ];
    const eligible = await filterSpecialtyEligible(rows, "fix React button styling", {
      provider: { embed: async () => { throw new Error("offline"); } },
      similarityThreshold: 0.55
    });
    expect(eligible.map((row) => row.id)).toEqual(["base", "frontend"]);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
bun test tests/unit/classifier.test.ts --timeout 20000
```

Expected: fails because `classifier.ts` and the `specialty_embedding` field on `DispatchVariantRow` do not exist.

- [ ] **Step 3: Extend dispatch row shape**

In `src/db/client.ts`, update `DispatchVariantRow`:

```typescript
  specialty_embedding: Buffer | null;
```

Update `loadDispatchPopulation` select list to include:

```sql
specialty_embedding
```

- [ ] **Step 4: Implement classifier**

Create `src/orchestrator/classifier.ts`:

```typescript
import type { DispatchVariantRow } from "../db/client";
import { defaultDispatchConfig } from "../config/dispatch";
import { filterBySpecialty } from "./specialty-match";
import { cosineSimilarity, deserializeEmbedding, type EmbeddingProvider } from "./embedding";

export interface ClassifierOptions {
  provider: EmbeddingProvider;
  similarityThreshold?: number;
}

export async function filterSpecialtyEligible(
  variants: DispatchVariantRow[],
  taskDescription: string,
  options: ClassifierOptions
): Promise<DispatchVariantRow[]> {
  const threshold = options.similarityThreshold ?? defaultDispatchConfig.similarityThreshold;
  const baselineAndGeneralists = variants.filter((variant) => variant.status === "baseline" || variant.specialty === null);
  const specialists = variants.filter((variant) => variant.status !== "baseline" && variant.specialty !== null);

  try {
    const taskEmbedding = await options.provider.embed(taskDescription);
    const embeddingMatches = specialists.filter((variant) => {
      const variantEmbedding = deserializeEmbedding(variant.specialty_embedding);
      return variantEmbedding !== null && cosineSimilarity(taskEmbedding, variantEmbedding) >= threshold;
    });
    const noEmbedding = specialists.filter((variant) => deserializeEmbedding(variant.specialty_embedding) === null);
    const keywordFallback = filterBySpecialty(noEmbedding, taskDescription);
    return preserveOrder(variants, [...baselineAndGeneralists, ...embeddingMatches, ...keywordFallback]);
  } catch {
    return filterBySpecialty(variants, taskDescription);
  }
}

function preserveOrder(rows: DispatchVariantRow[], selected: DispatchVariantRow[]): DispatchVariantRow[] {
  const ids = new Set(selected.map((row) => row.id));
  return rows.filter((row) => ids.has(row.id));
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
bun test tests/unit/classifier.test.ts tests/unit/dispatch.test.ts --timeout 20000
bun run lint
```

Expected: classifier tests pass; existing dispatch tests still pass until dispatch is switched in Task 4.

---

## Task 4: Async Dispatch Integration

**Files:**
- Modify: `src/orchestrator/dispatch.ts`
- Modify: `src/orchestrator/service.ts`
- Test: `tests/unit/dispatch.test.ts`
- Test: `tests/integration/lesson-injection-dispatch.test.ts`

- [ ] **Step 1: Update dispatch tests to await selection**

In `tests/unit/dispatch.test.ts`, replace calls like:

```typescript
const result = dispatcher.selectVariant("coder", ctx);
```

with:

```typescript
const result = await dispatcher.selectVariant("coder", ctx);
```

When creating a dispatcher for tests, pass a deterministic provider:

```typescript
const dispatcher = createDispatcher(db, {
  random: () => 0.99,
  embeddingProvider: { embed: async () => [1, 0] }
});
```

- [ ] **Step 2: Run dispatch tests and verify failure**

Run:

```bash
bun test tests/unit/dispatch.test.ts --timeout 20000
```

Expected: tests fail because `createDispatcher` does not accept `embeddingProvider` and `selectVariant` is still sync.

- [ ] **Step 3: Make dispatcher async and classifier-backed**

In `src/orchestrator/dispatch.ts`, update options and return type:

```typescript
import type { EmbeddingProvider } from "./embedding";
import { createDeterministicEmbeddingProvider } from "./embedding";
import { filterSpecialtyEligible } from "./classifier";

interface DispatcherOptions {
  random?: () => number;
  config?: Partial<DispatchConfig>;
  embeddingProvider?: EmbeddingProvider;
}

export function createDispatcher(
  db: DbClient,
  opts: DispatcherOptions = {}
): { selectVariant(agentType: AgentType, taskContext: TaskContext): Promise<SelectionResult> } {
  const random = opts.random ?? Math.random;
  const config = { ...defaultDispatchConfig, ...opts.config };
  const embeddingProvider = opts.embeddingProvider ?? createDeterministicEmbeddingProvider();

  return {
    async selectVariant(agentType: AgentType, taskContext: TaskContext): Promise<SelectionResult> {
      const population = db.loadDispatchPopulation(agentType);
      if (population.length === 1) {
        return {
          variantId: population[0].id,
          agentType,
          rationale: "only_eligible",
          shadowVariantIds: [],
          eligibleVariantIds: [population[0].id]
        };
      }

      const eligible = await filterSpecialtyEligible(population, taskContext.description, {
        provider: embeddingProvider,
        similarityThreshold: config.similarityThreshold
      });

      return chooseFromEligible(agentType, eligible, random, config);
    }
  };
}
```

Move the existing bucket logic into a pure helper:

```typescript
function chooseFromEligible(
  agentType: AgentType,
  eligible: DispatchVariantRow[],
  random: () => number,
  config: DispatchConfig
): SelectionResult {
  if (eligible.length === 0) {
    throw new Error(`No dispatch variants eligible for ${agentType}`);
  }
  const eligibleVariantIds = eligible.map((variant) => variant.id);
  const shadowVariantIds = selectShadowVariants(eligible, config.maxShadowVariantsPerAgentType);
  const baseline = eligible.find((variant) => variant.status === "baseline");
  if (!baseline) throw new Error(`No baseline dispatch variant for ${agentType}`);

  const active = eligible.filter((variant) => variant.status === "active");
  const competitors = active;
  const baselineBucket = Math.max(config.baselineMinTrafficShare, baseline.traffic_share);
  const explorationBucket = competitors.length > 0 ? config.epsilon : 0;
  const exploitationBucket = active.length > 0 ? Math.max(0, 1 - baselineBucket - explorationBucket) : 0;
  const bucketRoll = random();

  if (bucketRoll < baselineBucket) return selection(baseline, agentType, "baseline", shadowVariantIds, eligibleVariantIds);
  if (bucketRoll < baselineBucket + explorationBucket && competitors.length > 0) {
    return selection(selectUniform(competitors, random()), agentType, "exploration", shadowVariantIds, eligibleVariantIds);
  }
  if (bucketRoll < baselineBucket + explorationBucket + exploitationBucket && active.length > 0) {
    return selection(selectWeighted(active, random()), agentType, "exploitation", shadowVariantIds, eligibleVariantIds);
  }
  return selection(baseline, agentType, "baseline", shadowVariantIds, eligibleVariantIds);
}
```

- [ ] **Step 4: Await dispatcher in service**

In `src/orchestrator/service.ts`, find every dispatch selection call and add `await`:

```typescript
const selection = await this.dispatcher.selectVariant(agentType, {
  description,
  tier,
  projectId
});
```

If any helper that calls `selectVariant` is sync, make that helper async and update its call sites.

- [ ] **Step 5: Run tests**

Run:

```bash
bun test tests/unit/dispatch.test.ts tests/integration/lesson-injection-dispatch.test.ts tests/integration/shadow-dispatch.test.ts --timeout 60000
bun run lint
```

Expected: selection tests pass, lesson injection still records selected variant ids, and shadow behavior remains unchanged.

---

## Task 5: Diagnostic Persona and Diagnostic Runner

**Files:**
- Create: `src/personas/diagnostician.md`
- Create: `src/orchestrator/diagnostic.ts`
- Modify: `src/types/core.ts`
- Modify: `src/skills/registry.ts`
- Modify: `src/db/client.ts`
- Test: `tests/unit/diagnostic.test.ts`

- [ ] **Step 1: Add utility agent type**

In `src/types/core.ts`, extend `AgentType`:

```typescript
| "diagnostician"
```

In `src/skills/registry.ts`, add an empty or read-only skill mapping for `diagnostician` matching the reflector pattern.

- [ ] **Step 2: Create diagnostician persona**

Create `src/personas/diagnostician.md`:

```markdown
# Diagnostician Persona

You analyze recent Autoforge task outcomes and identify task clusters where the current persona population is weak enough to justify a specialist fork.

Return only JSON with this shape:

{
  "clusters": [
    {
      "label": "short human-readable cluster name",
      "keywords": "space separated lowercase keywords",
      "representative_task_ids": ["task id"],
      "baseline_score_mean": 0.48,
      "population_score_mean": 0.71,
      "score_gap": 0.23,
      "recommendation_strength": "weak | moderate | strong",
      "suggested_specialty": "one sentence specialty description"
    }
  ]
}

Strength calibration:
- strong: score_gap >= 0.20 and at least 5 representative tasks and a consistent failure pattern.
- moderate: score_gap >= 0.10 or at least 3 representative tasks.
- weak: signal is visible but not yet strong enough for autonomous action.

Return {"clusters": []} when the history is homogeneous or too noisy.
```

- [ ] **Step 3: Write failing diagnostic tests**

Create `tests/unit/diagnostic.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";
import { parseDiagnosticOutput, proposalIdForCluster, runDiagnosticStalenessSweep } from "../../src/orchestrator/diagnostic";

function freshDb(): DbClient {
  const db = new DbClient(join(mkdtempSync(join(tmpdir(), "diagnostic-test-")), "db.sqlite"));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

describe("diagnostic parsing and persistence helpers", () => {
  test("parses valid cluster output", () => {
    const parsed = parseDiagnosticOutput(JSON.stringify({
      clusters: [{
        label: "React styling",
        keywords: "react css styling",
        representative_task_ids: ["t1", "t2", "t3"],
        baseline_score_mean: 0.4,
        population_score_mean: 0.7,
        score_gap: 0.3,
        recommendation_strength: "strong",
        suggested_specialty: "React component styling and CSS module work."
      }]
    }));
    expect(parsed.clusters).toHaveLength(1);
    expect(parsed.clusters[0].recommendation_strength).toBe("strong");
  });

  test("proposal ids are stable for agent, keywords, and date", () => {
    const expected = createHash("sha256").update("coder|react css|2026-04-28").digest("hex").slice(0, 24);
    expect(proposalIdForCluster("coder", "react css", "2026-04-28T10:00:00Z")).toBe(`fp_${expected}`);
  });

  test("staleness sweep marks old open proposals stale", () => {
    const db = freshDb();
    db.insertForkProposal({
      id: "fp_old",
      agentType: "coder",
      label: "old",
      keywords: "old",
      suggestedSpecialty: "old work",
      representativeTaskIds: ["t1", "t2", "t3"],
      baselineScoreMean: 0.4,
      populationScoreMean: 0.6,
      scoreGap: 0.2,
      recommendationStrength: "strong"
    });
    db.sqlite.query("UPDATE fork_proposals SET generated_at = datetime('now', '-20 days') WHERE id = 'fp_old'").run();
    expect(runDiagnosticStalenessSweep(db, 14)).toBe(1);
    expect(db.getForkProposal("fp_old")?.status).toBe("stale");
  });
});
```

- [ ] **Step 4: Implement diagnostic module**

Create `src/orchestrator/diagnostic.ts` with:

```typescript
import { createHash, randomUUID } from "node:crypto";
import type { DbClient } from "../db/client";
import type { AgentExecutor } from "../executors/interface";

export interface DiagnosticCluster {
  label: string;
  keywords: string;
  representative_task_ids: string[];
  baseline_score_mean: number;
  population_score_mean: number;
  score_gap: number;
  recommendation_strength: "weak" | "moderate" | "strong";
  suggested_specialty: string;
}

export interface DiagnosticOutput {
  clusters: DiagnosticCluster[];
}

export function parseDiagnosticOutput(raw: string): DiagnosticOutput {
  const parsed = JSON.parse(raw) as DiagnosticOutput;
  if (!Array.isArray(parsed.clusters)) return { clusters: [] };
  return {
    clusters: parsed.clusters.filter((cluster) =>
      typeof cluster.label === "string" &&
      typeof cluster.keywords === "string" &&
      Array.isArray(cluster.representative_task_ids) &&
      typeof cluster.suggested_specialty === "string" &&
      ["weak", "moderate", "strong"].includes(cluster.recommendation_strength)
    ).slice(0, 3)
  };
}

export function proposalIdForCluster(agentType: string, keywords: string, generatedAt: string): string {
  const day = generatedAt.slice(0, 10);
  const digest = createHash("sha256").update(`${agentType}|${keywords}|${day}`).digest("hex").slice(0, 24);
  return `fp_${digest}`;
}

export function runDiagnosticStalenessSweep(db: DbClient, staleDays: number): number {
  return db.markStaleForkProposals(staleDays);
}
```

Add `runDiagnostic()` in the same file after tests for parsing pass:

```typescript
export async function runDiagnostic(input: {
  db: DbClient;
  executor: AgentExecutor;
  agentType: string;
  trigger: "task_count_50" | "nightly_cron" | "manual";
  workingDirectory: string;
  now?: Date;
}): Promise<{ clustersProposed: number }> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const taskHistory = input.db.loadDiagnosticTaskHistory(input.agentType, 100);
  if (taskHistory.length < 30) {
    input.db.appendEvent({
      id: randomUUID(),
      taskId: `diagnostic:${input.agentType}`,
      projectId: "diagnostic",
      timestamp: now.toISOString(),
      agent: "orchestrator",
      type: "diagnostic_run_completed",
      status: "done",
      payload: {
        trigger: input.trigger,
        tasks_analyzed: taskHistory.length,
        clusters_proposed: 0,
        elapsed_seconds: (Date.now() - started) / 1000,
        diagnostician_variant_id: null,
        error: "insufficient_history"
      },
      budgetSeconds: 0
    });
    return { clustersProposed: 0 };
  }

  const result = await input.executor.execute({
    id: `diagnostic:${input.agentType}:${now.toISOString()}`,
    type: "diagnostician",
    systemPrompt: "",
    prompt: JSON.stringify({ agent_type: input.agentType, tasks: taskHistory }),
    workingDirectory: input.workingDirectory,
    budgetSeconds: 90,
    environment: {},
    skillFiles: []
  });

  const output = parseDiagnosticOutput(typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? {}));
  for (const cluster of output.clusters) {
    const id = proposalIdForCluster(input.agentType, cluster.keywords, now.toISOString());
    input.db.insertForkProposal({
      id,
      agentType: input.agentType,
      label: cluster.label,
      keywords: cluster.keywords,
      suggestedSpecialty: cluster.suggested_specialty,
      representativeTaskIds: cluster.representative_task_ids,
      baselineScoreMean: cluster.baseline_score_mean,
      populationScoreMean: cluster.population_score_mean,
      scoreGap: cluster.score_gap,
      recommendationStrength: cluster.recommendation_strength
    });
    input.db.appendEvent({
      id: randomUUID(),
      taskId: id,
      projectId: "diagnostic",
      timestamp: now.toISOString(),
      agent: "orchestrator",
      type: "diagnostic_cluster_detected",
      status: "done",
      payload: {
        fork_proposal_id: id,
        agent_type: input.agentType,
        label: cluster.label,
        score_gap: cluster.score_gap,
        recommendation_strength: cluster.recommendation_strength
      },
      budgetSeconds: 0
    });
  }

  input.db.appendEvent({
    id: randomUUID(),
    taskId: `diagnostic:${input.agentType}`,
    projectId: "diagnostic",
    timestamp: now.toISOString(),
    agent: "orchestrator",
    type: "diagnostic_run_completed",
    status: "done",
    payload: {
      trigger: input.trigger,
      tasks_analyzed: taskHistory.length,
      clusters_proposed: output.clusters.length,
      elapsed_seconds: (Date.now() - started) / 1000,
      diagnostician_variant_id: null,
      error: null
    },
    budgetSeconds: 0
  });
  return { clustersProposed: output.clusters.length };
}
```

- [ ] **Step 5: Add diagnostic history helper**

In `src/db/client.ts`, add:

```typescript
loadDiagnosticTaskHistory(agentType: string, limit: number): Array<Record<string, unknown>> {
  return this.sqlite.query(`
    SELECT
      t.id AS task_id,
      t.description,
      t.tier,
      t.project_id,
      t.state,
      tqs.r_correctness,
      tqs.r_simplicity,
      tqs.r_alignment,
      tqs.r_fidelity,
      tqs.r_efficiency,
      tds.lines_added,
      tds.lines_deleted,
      e.payload AS selection_payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    LEFT JOIN task_quality_score tqs ON tqs.task_id = t.id
    LEFT JOIN task_diff_stats tds ON tds.task_id = t.id
    WHERE e.event_type = 'variant_selected'
      AND json_extract(e.payload, '$.agent_type') = ?
      AND t.state IN ('completed', 'failed')
    ORDER BY t.updated_at DESC
    LIMIT ?
  `).all(agentType, limit) as Array<Record<string, unknown>>;
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test tests/unit/diagnostic.test.ts --timeout 20000
bun run lint
```

Expected: diagnostic unit tests pass and TypeScript exits 0.

---

## Task 6: Diagnostic Scheduling and Manual Run Route

**Files:**
- Modify: `src/orchestrator/service.ts`
- Create: `src/web/routes/diagnostic.ts`
- Modify: `src/web/server.ts`
- Test: `tests/unit/diagnostic-route.test.ts`

- [ ] **Step 1: Write failing route test**

Create `tests/unit/diagnostic-route.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { createWebServer } from "../../src/web/server";

describe("POST /api/diagnostic/run", () => {
  test("returns a diagnostic result for manual trigger", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      const resp = await app.request("/api/diagnostic/run", {
        method: "POST",
        body: JSON.stringify({ agentType: "coder" }),
        headers: { "content-type": "application/json" }
      });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({ ok: true, agentType: "coder" });
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Add service method**

In `src/orchestrator/service.ts`, add:

```typescript
async runPopulationDiagnostic(agentType: AgentType, trigger: "task_count_50" | "nightly_cron" | "manual" = "manual"): Promise<{ clustersProposed: number }> {
  return runDiagnostic({
    db: this.deps.db,
    executor: this.deps.executor,
    agentType,
    trigger,
    workingDirectory: process.cwd()
  });
}
```

Import `runDiagnostic` and `defaultDispatchConfig`.

At terminal task completion/failure after auto-tuner evaluation, increment an in-memory counter and call:

```typescript
if (this.terminalTaskCount % defaultDispatchConfig.diagnosticTriggerTaskCount === 0) {
  for (const agentType of ["planner", "coder", "reviewer", "doc"] as AgentType[]) {
    void this.runPopulationDiagnostic(agentType, "task_count_50").catch((err) => {
      console.warn(`[diagnostic] ${agentType} failed: ${(err as Error).message}`);
    });
  }
}
```

Add a daily timer method guarded for production/dev:

```typescript
startDiagnosticScheduler(): void {
  const dayMs = 24 * 60 * 60 * 1000;
  setInterval(() => {
    for (const agentType of ["planner", "coder", "reviewer", "doc"] as AgentType[]) {
      void this.runPopulationDiagnostic(agentType, "nightly_cron").catch((err) => {
        console.warn(`[diagnostic] nightly ${agentType} failed: ${(err as Error).message}`);
      });
    }
  }, dayMs).unref?.();
}
```

Call it from `src/index.ts` after service creation:

```typescript
service.startDiagnosticScheduler();
```

- [ ] **Step 3: Add route**

Create `src/web/routes/diagnostic.ts`:

```typescript
import { Hono } from "hono";
import type { OrchestratorService } from "../../orchestrator/service";
import type { AgentType } from "../../types/core";

export function createDiagnosticRoutes(service: OrchestratorService): Hono {
  const app = new Hono();
  app.post("/run", async (ctx) => {
    const body = await ctx.req.json().catch(() => ({})) as { agentType?: AgentType };
    const agentType = body.agentType ?? "coder";
    const result = await service.runPopulationDiagnostic(agentType, "manual");
    return ctx.json({ ok: true, agentType, clustersProposed: result.clustersProposed });
  });
  return app;
}
```

Mount in `src/web/server.ts`:

```typescript
import { createDiagnosticRoutes } from "./routes/diagnostic";
app.route("/api/diagnostic", createDiagnosticRoutes(service));
```

- [ ] **Step 4: Run tests**

Run:

```bash
bun test tests/unit/diagnostic-route.test.ts --timeout 20000
bun run lint
```

Expected: route test passes and TypeScript exits 0.

---

## Task 7: Fork Workflow Completion

**Files:**
- Modify: `src/schemas/meta-output.ts`
- Modify: `src/orchestrator/meta-operations.ts`
- Modify: `src/orchestrator/service.ts`
- Modify: `src/web/routes/experiments.ts`
- Test: `tests/unit/experiments-route.test.ts`
- Test: `tests/unit/meta-operations.test.ts`

- [ ] **Step 1: Write failing tests for list, reject, and first-fork evidence**

Create `tests/unit/experiments-route.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { createWebServer } from "../../src/web/server";

describe("Spec D experiment fork workflow", () => {
  test("GET /api/experiments?status=proposed&operation=fork lists pending forks", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before, operation, evidence, status, proposed_content)
        VALUES ('expFork','h','d','task_quality_score',0.4,'fork',
                json_object('parent_variant_id','vParent','specialty','frontend','fork_proposal_id','fp1'),
                'proposed','# content')
      `).run();
      const resp = await app.request("/api/experiments?status=proposed&operation=fork");
      expect(resp.status).toBe(200);
      const body = await resp.json() as { experiments: Array<{ experiment_id: string }> };
      expect(body.experiments.map((row) => row.experiment_id)).toContain("expFork");
    } finally {
      cleanup();
    }
  });

  test("POST reject-fork discards proposed fork and emits fork_rejected", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before, operation, status)
        VALUES ('expReject','h','d','task_quality_score',0,'fork','proposed')
      `).run();
      const resp = await app.request("/api/experiments/expReject/reject-fork", {
        method: "POST",
        body: JSON.stringify({ reviewer: "test", reason: "evidence_too_weak" }),
        headers: { "content-type": "application/json" }
      });
      expect(resp.status).toBe(200);
      expect((db.sqlite.query("SELECT status FROM experiments WHERE id='expReject'").get() as { status: string }).status).toBe("discard");
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Extend evidence schema for fork proposal ids**

In `src/schemas/meta-output.ts`, add:

```typescript
  fork_proposal_id: z.string().optional()
```

inside `Evidence`.

- [ ] **Step 3: Enforce first-fork citation**

In `src/orchestrator/meta-operations.ts`, before creating a fork experiment, add:

```typescript
const proposalId = typeof op.evidence.fork_proposal_id === "string" ? op.evidence.fork_proposal_id : null;
const firstFork = ctx.db.isFirstForkForLineage(parent.id);
if (firstFork) {
  if (!proposalId) return { ok: false, reason: "fork_proposal_required" };
  const proposal = ctx.db.getForkProposal(proposalId);
  if (!proposal || proposal.status !== "open") return { ok: false, reason: "fork_proposal_not_open" };
  const agentType = parent.skill_name.startsWith("persona:") ? parent.skill_name.slice("persona:".length) : parent.skill_name;
  if (proposal.agent_type !== agentType) return { ok: false, reason: "fork_proposal_agent_mismatch" };
}
```

Add `DbClient.isFirstForkForLineage(parentVariantId)`:

```typescript
isFirstForkForLineage(parentVariantId: string): boolean {
  const root = this.resolveLineageRoot(parentVariantId) ?? parentVariantId;
  const descendants = this.sqlite.query(`
    SELECT id FROM skill_versions
     WHERE id <> ?
       AND status IN ('baseline', 'active')
  `).all(parentVariantId) as Array<{ id: string }>;
  return descendants.every((row) => (this.resolveLineageRoot(row.id) ?? row.id) !== root);
}
```

- [ ] **Step 4: Implement list and reject service methods**

In `src/orchestrator/service.ts`, add:

```typescript
listPendingForkExperiments(): Array<Record<string, unknown>> {
  return this.deps.db.sqlite.query(`
    SELECT id, hypothesis, evidence, proposed_content, created_at
      FROM experiments
     WHERE operation = 'fork' AND status = 'proposed'
     ORDER BY created_at DESC, id ASC
  `).all().map((row) => {
    const r = row as { id: string; hypothesis: string; evidence: string | null; proposed_content: string | null; created_at: string };
    const evidence = r.evidence ? JSON.parse(r.evidence) as Record<string, unknown> : {};
    return {
      experiment_id: r.id,
      hypothesis: r.hypothesis,
      evidence,
      parent_variant_id: evidence.parent_variant_id ?? null,
      proposed_specialty: evidence.specialty ?? null,
      proposed_content_preview: (r.proposed_content ?? "").slice(0, 500),
      created_at: r.created_at
    };
  });
}

rejectFork(experimentId: string, reviewer: string, reason: string): void {
  this.deps.db.transaction(() => {
    const row = this.deps.db.sqlite.query("SELECT id, operation, status FROM experiments WHERE id = ?").get(experimentId) as { operation: string; status: string } | undefined;
    if (!row) throw new Error("experiment not found");
    if (row.operation !== "fork" || row.status !== "proposed") throw new Error("experiment not a proposed fork");
    this.deps.db.sqlite.query("UPDATE experiments SET status = 'discard' WHERE id = ?").run(experimentId);
    this.deps.db.appendEvent({
      id: randomUUID(),
      taskId: experimentId,
      projectId: "experiments",
      timestamp: new Date().toISOString(),
      agent: "orchestrator",
      type: "fork_rejected",
      status: "done",
      payload: { experiment_id: experimentId, reviewer, reason },
      budgetSeconds: 0
    });
  });
}
```

- [ ] **Step 5: Update approve fork**

Change `approveFork` to accept body metadata:

```typescript
async approveFork(experimentId: string, input: { approver?: string; notes?: string } = {}): Promise<{ variantId: string }>
```

Within the approval transaction:

```typescript
const forkProposalId = typeof evidence.fork_proposal_id === "string" ? evidence.fork_proposal_id : null;
if (forkProposalId) this.deps.db.markForkProposalActedOn(forkProposalId, experimentId);
this.deps.db.appendEvent({
  id: randomUUID(),
  taskId: experimentId,
  projectId: "experiments",
  timestamp: new Date().toISOString(),
  agent: "orchestrator",
  type: "fork_approved",
  status: "done",
  payload: {
    experiment_id: experimentId,
    new_variant_id: variantId,
    parent_variant_id: parentId,
    lineage_root_id: this.deps.db.resolveLineageRoot(parentId) ?? parentId,
    specialty,
    approver: input.approver ?? "unknown",
    notes: input.notes ?? null
  },
  budgetSeconds: 0
});
```

After inserting the row, compute the embedding through the service's embedding provider and update `skill_versions.specialty_embedding`. If embedding fails, leave it `NULL` so classifier keyword fallback applies.

- [ ] **Step 6: Update routes**

In `src/web/routes/experiments.ts`, add:

```typescript
app.get("/", (ctx) => {
  const status = ctx.req.query("status");
  const operation = ctx.req.query("operation");
  if (status === "proposed" && operation === "fork") {
    return ctx.json({ experiments: service.listPendingForkExperiments() });
  }
  return ctx.json({ experiments: [] });
});

app.post("/:id/reject-fork", async (ctx) => {
  const id = ctx.req.param("id");
  const body = await ctx.req.json().catch(() => ({})) as { reviewer?: string; reason?: string };
  service.rejectFork(id, body.reviewer ?? "unknown", body.reason ?? "other");
  return ctx.json({ ok: true });
});
```

Update approve route to parse `{ approver, notes }` and pass it to `service.approveFork`.

- [ ] **Step 7: Run tests**

Run:

```bash
bun test tests/unit/experiments-route.test.ts tests/unit/meta-operations.test.ts tests/unit/approve-fork-route.test.ts --timeout 30000
bun run lint
```

Expected: route and meta operation tests pass.

---

## Task 8: CLI Experiment Commands

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/experiments.ts`
- Modify: `package.json`
- Test: `tests/unit/cli-experiments.test.ts`

- [ ] **Step 1: Write failing CLI formatter tests**

Create `tests/unit/cli-experiments.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { formatPendingForks } from "../../src/cli/experiments";

describe("experiments CLI formatting", () => {
  test("formats pending fork rows", () => {
    const text = formatPendingForks([{
      experiment_id: "exp1",
      proposed_specialty: "React styling",
      parent_variant_id: "v1",
      hypothesis: "frontend failures cluster",
      evidence: { fork_proposal_id: "fp1", task_ids: ["t1", "t2"] },
      proposed_content_preview: "# persona",
      created_at: "2026-04-28T00:00:00Z"
    }]);
    expect(text).toContain("exp1");
    expect(text).toContain("React styling");
    expect(text).toContain("fp1");
  });
});
```

- [ ] **Step 2: Implement CLI module**

Create `src/cli/experiments.ts`:

```typescript
export interface PendingForkRow {
  experiment_id: string;
  proposed_specialty: unknown;
  parent_variant_id: unknown;
  hypothesis: string;
  evidence: Record<string, unknown>;
  proposed_content_preview: string;
  created_at: string;
}

export function formatPendingForks(rows: PendingForkRow[]): string {
  if (rows.length === 0) return "No pending fork experiments.\n";
  return rows.map((row) => [
    `Experiment: ${row.experiment_id}`,
    `Specialty: ${String(row.proposed_specialty ?? "")}`,
    `Parent: ${String(row.parent_variant_id ?? "")}`,
    `Proposal: ${String(row.evidence.fork_proposal_id ?? "")}`,
    `Tasks: ${Array.isArray(row.evidence.task_ids) ? row.evidence.task_ids.join(", ") : ""}`,
    `Hypothesis: ${row.hypothesis}`,
    ""
  ].join("\n")).join("\n");
}
```

Create `src/cli/index.ts`:

```typescript
const baseUrl = process.env.AUTOFORGE_URL ?? "http://127.0.0.1:3000";
const [, , domain, command, id, ...rest] = process.argv;

async function main(): Promise<void> {
  if (domain !== "experiments") {
    throw new Error("usage: autoforge experiments <list-pending|approve-fork|reject-fork>");
  }
  if (command === "list-pending") {
    const res = await fetch(`${baseUrl}/api/experiments?status=proposed&operation=fork`);
    const body = await res.json() as { experiments: unknown[] };
    const { formatPendingForks } = await import("./experiments");
    process.stdout.write(formatPendingForks(body.experiments as never));
    return;
  }
  if (command === "approve-fork" && id) {
    const approver = valueAfter(rest, "--approver") ?? "cli";
    const notes = valueAfter(rest, "--notes") ?? "";
    const res = await fetch(`${baseUrl}/api/experiments/${id}/approve-fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approver, notes })
    });
    process.stdout.write(`${await res.text()}\n`);
    return;
  }
  if (command === "reject-fork" && id) {
    const reviewer = valueAfter(rest, "--reviewer") ?? "cli";
    const reason = valueAfter(rest, "--reason") ?? "other";
    const res = await fetch(`${baseUrl}/api/experiments/${id}/reject-fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewer, reason })
    });
    process.stdout.write(`${await res.text()}\n`);
    return;
  }
  throw new Error("usage: autoforge experiments <list-pending|approve-fork|reject-fork>");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

void main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
```

Update `package.json` scripts:

```json
"cli": "bun run src/cli/index.ts"
```

- [ ] **Step 3: Run tests**

Run:

```bash
bun test tests/unit/cli-experiments.test.ts --timeout 20000
bun run lint
```

Expected: CLI formatter tests pass and TypeScript exits 0.

---

## Task 9: Merge Operation Execution

**Files:**
- Modify: `src/orchestrator/sequential-test.ts`
- Modify: `src/orchestrator/allocation.ts`
- Modify: `src/orchestrator/meta-operations.ts`
- Modify: `src/db/client.ts`
- Test: `tests/unit/merge-operation.test.ts`

- [ ] **Step 1: Write failing merge tests**

Create `tests/unit/merge-operation.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";
import { handleMetaOperation } from "../../src/orchestrator/meta-operations";

function freshDb(): DbClient {
  const db = new DbClient(join(mkdtempSync(join(tmpdir(), "merge-operation-")), "db.sqlite"));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

describe("merge operation execution", () => {
  test("rejects cross-lineage merge", () => {
    const db = freshDb();
    db.sqlite.query("INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('a','persona:coder','1','short','active',0.2)").run();
    db.sqlite.query("INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('b','persona:coder','1','longer','active',0.2)").run();
    const result = handleMetaOperation({
      db,
      metaTaskId: "meta1",
      projectId: "p",
      worktreePath: process.cwd(),
      operation: {
        kind: "merge",
        target_variant_id: "a",
        merge_source_variant_id: "b",
        hypothesis: "same behavior",
        evidence: { task_ids: ["t1"] }
      }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("merge_lineage_mismatch");
  });
});
```

- [ ] **Step 2: Add Kolmogorov-Smirnov helper**

In `src/orchestrator/sequential-test.ts`, export:

```typescript
export function kolmogorovSmirnovTwoSample(sampleA: number[], sampleB: number[]): StatisticalTestResult {
  const a = sampleA.filter(Number.isFinite).sort((x, y) => x - y);
  const b = sampleB.filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0 || b.length === 0) return { pValue: 1, effect: 0, n: 0 };
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < a.length || j < b.length) {
    const next = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i] : b[j];
    while (i < a.length && a[i] <= next) i += 1;
    while (j < b.length && b[j] <= next) j += 1;
    d = Math.max(d, Math.abs(i / a.length - j / b.length));
  }
  const nEff = (a.length * b.length) / (a.length + b.length);
  const pValue = Math.min(1, 2 * Math.exp(-2 * nEff * d * d));
  return { pValue, effect: mean(a) - mean(b), n: a.length + b.length };
}
```

- [ ] **Step 3: Allow allocation reason for merge**

In `src/orchestrator/allocation.ts`, add `"meta_merge"` to `AllocationReason`.

- [ ] **Step 4: Add score helper**

In `src/db/client.ts`, add:

```typescript
loadRecentCompositeScoresForVariant(variantId: string, limit: number): number[] {
  return this.loadRecentSelectedTaskScores(variantId, { limit, maxAgeDays: 60 }).map((score) => score.composite);
}
```

- [ ] **Step 5: Execute merge in meta operations**

Replace the proposed-only `handleMerge` path in `src/orchestrator/meta-operations.ts` with a real execution path:

```typescript
const target = ctx.db.getSkillVersionById(op.target_variant_id);
const source = ctx.db.getSkillVersionById(op.merge_source_variant_id);
if (!target) return { ok: false, reason: "target_not_found" };
if (!source) return { ok: false, reason: "merge_source_not_found" };
if (target.skill_name !== source.skill_name) return { ok: false, reason: "merge_agent_type_mismatch" };
if (target.status !== "active" || source.status !== "active") return { ok: false, reason: "merge_requires_active_variants" };
if ((ctx.db.resolveLineageRoot(target.id) ?? target.id) !== (ctx.db.resolveLineageRoot(source.id) ?? source.id)) {
  return { ok: false, reason: "merge_lineage_mismatch" };
}

const targetScores = ctx.db.loadRecentCompositeScoresForVariant(target.id, 30);
const sourceScores = ctx.db.loadRecentCompositeScoresForVariant(source.id, 30);
if (targetScores.length < 30 || sourceScores.length < 30) return { ok: false, reason: "merge_insufficient_observations" };
const ks = kolmogorovSmirnovTwoSample(targetScores, sourceScores);
if (ks.pValue < 0.30 || Math.abs(ks.effect) >= 0.03) return { ok: false, reason: "merge_not_indistinguishable" };
```

Pick survivor and loser:

```typescript
const targetMean = targetScores.reduce((sum, value) => sum + value, 0) / targetScores.length;
const sourceMean = sourceScores.reduce((sum, value) => sum + value, 0) / sourceScores.length;
const targetWins = targetMean > sourceMean + 0.005
  || (Math.abs(targetMean - sourceMean) <= 0.005 && target.content.length <= source.content.length);
const survivor = targetWins ? target : source;
const loser = targetWins ? source : target;
```

Within a transaction:

```typescript
const experimentId = randomUUID();
const mergedSpecialty = mergeSpecialtyText(survivor.specialty, loser.specialty);
ctx.db.sqlite.query("UPDATE skill_versions SET specialty = ?, specialty_embedding = NULL WHERE id = ?").run(mergedSpecialty, survivor.id);
const allocation = adjustVariantAllocation(
  ctx.db,
  loser.id,
  { kind: "set_status", newStatus: "retired", newTrafficShare: 0 },
  "meta_merge",
  { meta_task_id: ctx.metaTaskId, ks_p_value: ks.pValue, mean_diff: ks.effect }
);
if (!allocation.ok) return { ok: false, reason: allocation.reason };
ctx.db.insertMetaOperationExperiment({
  experimentId,
  metaTaskId: ctx.metaTaskId,
  operation: "merge",
  hypothesis: op.hypothesis,
  changeDescription: `merged ${loser.id} into ${survivor.id}`,
  evidence: { ...op.evidence, survivor_variant_id: survivor.id, retired_variant_id: loser.id, ks_p_value: ks.pValue },
  status: "active"
});
ctx.db.appendEvent({
  id: randomUUID(),
  taskId: experimentId,
  projectId: ctx.projectId,
  timestamp: new Date().toISOString(),
  agent: "orchestrator",
  type: "variants_merged",
  status: "done",
  payload: {
    experiment_id: experimentId,
    kept_variant_id: survivor.id,
    retired_variant_id: loser.id,
    merged_specialty: mergedSpecialty,
    tie_breaker_used: Math.abs(targetMean - sourceMean) <= 0.005 ? "text_size" : "composite_score"
  },
  budgetSeconds: 0
});
```

Add helper:

```typescript
function mergeSpecialtyText(a: string | null, b: string | null): string {
  const parts = [a, b].filter((value): value is string => Boolean(value && value.trim()));
  const merged = Array.from(new Set(parts.join(" ").split(/\s+/))).join(" ");
  return merged.slice(0, 150);
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
bun test tests/unit/merge-operation.test.ts tests/unit/meta-operations.test.ts tests/unit/sequential-test.test.ts --timeout 30000
bun run lint
```

Expected: merge tests pass and existing meta operation tests still pass.

---

## Task 10: Startup Specialty Embedding Backfill

**Files:**
- Modify: `src/orchestrator/service.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/embedding.test.ts`

- [ ] **Step 1: Add backfill service method**

In `src/orchestrator/service.ts`, add:

```typescript
async backfillSpecialtyEmbeddings(): Promise<number> {
  const rows = this.deps.db.sqlite.query(`
    SELECT id, specialty FROM skill_versions
     WHERE specialty IS NOT NULL
       AND specialty_embedding IS NULL
  `).all() as Array<{ id: string; specialty: string }>;
  let updated = 0;
  for (const row of rows) {
    try {
      const vector = await this.embeddingProvider.embed(row.specialty);
      this.deps.db.updateSpecialtyEmbedding(row.id, serializeEmbedding(vector));
      updated += 1;
    } catch (err) {
      console.warn(`[embedding] backfill skipped ${row.id}: ${(err as Error).message}`);
    }
  }
  return updated;
}
```

This requires the service constructor to accept or create an `embeddingProvider`. In tests, default to deterministic provider.

- [ ] **Step 2: Wire startup**

In `src/index.ts`, after service creation:

```typescript
await service.backfillSpecialtyEmbeddings();
```

- [ ] **Step 3: Run tests**

Run:

```bash
bun test tests/unit/embedding.test.ts tests/unit/classifier.test.ts --timeout 20000
bun run lint
```

Expected: tests pass and TypeScript exits 0.

---

## Task 11: End-to-End Spec D Loop

**Files:**
- Test: `tests/integration/spec-d-autonomous-loop.test.ts`

- [ ] **Step 1: Write end-to-end fixture test**

Create `tests/integration/spec-d-autonomous-loop.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { createWebServer } from "../../src/web/server";

describe("Spec D autonomous population loop", () => {
  test("diagnostic proposal can be approved into a candidate", async () => {
    const { service, db, cleanup } = createTestService({
      diagnostician: async () => ({
        status: "DONE",
        artifacts: [],
        output: {
          clusters: [{
            label: "React styling",
            keywords: "react css styling",
            representative_task_ids: ["t1", "t2", "t3", "t4", "t5"],
            baseline_score_mean: 0.4,
            population_score_mean: 0.7,
            score_gap: 0.3,
            recommendation_strength: "strong",
            suggested_specialty: "React component styling and CSS module work."
          }]
        },
        metrics: { elapsedSeconds: 1 }
      })
    });
    const app = createWebServer(service, db);
    try {
      db.sqlite.query("INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('base','persona:coder','1','base','baseline',0.8)").run();
      for (let i = 0; i < 30; i += 1) {
        db.sqlite.query(`
          INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
          VALUES (?, 'p', 'React CSS task', 'completed', 'STANDARD', '{}', '[]', 0, datetime('now'), datetime('now'))
        `).run(`t${i}`);
        db.sqlite.query(`
          INSERT INTO events (id, task_id, timestamp, project_id, agent, event_type, status, payload, budget_seconds)
          VALUES (?, ?, datetime('now'), 'p', 'orchestrator', 'variant_selected', 'done',
                  json_object('agent_type','coder','selected_variant_id','base','selection_rationale','baseline'), 0)
        `).run(`e${i}`, `t${i}`);
      }

      const diagnostic = await app.request("/api/diagnostic/run", {
        method: "POST",
        body: JSON.stringify({ agentType: "coder" }),
        headers: { "content-type": "application/json" }
      });
      expect(diagnostic.status).toBe(200);
      const proposals = db.listOpenForkProposals("coder");
      expect(proposals).toHaveLength(1);

      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before, operation, evidence, status, proposed_content)
        VALUES ('expFork','h','d','task_quality_score',0.4,'fork',
                json_object('parent_variant_id','base','specialty','React styling','fork_proposal_id',?,'task_ids',json_array('t1','t2','t3')),
                'proposed','# React styling specialist')
      `).run(proposals[0].id);

      const approve = await app.request("/api/experiments/expFork/approve-fork", {
        method: "POST",
        body: JSON.stringify({ approver: "test", notes: "approved fixture" }),
        headers: { "content-type": "application/json" }
      });
      expect(approve.status).toBe(200);
      const approved = await approve.json() as { variantId: string };
      expect(db.getForkProposal(proposals[0].id)?.status).toBe("acted_on");

      const created = db.sqlite.query("SELECT status, specialty FROM skill_versions WHERE id = ?").get(approved.variantId) as { status: string; specialty: string };
      expect(created.status).toBe("candidate");
      expect(created.specialty).toBe("React styling");

      const approvedEvent = db.sqlite.query("SELECT payload FROM events WHERE event_type = 'fork_approved' AND task_id = 'expFork'").get() as { payload: string } | undefined;
      expect(approvedEvent).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run integration test**

Run:

```bash
bun test tests/integration/spec-d-autonomous-loop.test.ts --timeout 60000
```

Expected: the diagnostic route creates an open fork proposal, the approval route materializes a candidate variant, the cited proposal moves to `acted_on`, and a `fork_approved` event is emitted. Merge behavior is covered by `tests/unit/merge-operation.test.ts` because it requires synthetic 30-observation score windows that are clearer and faster to seed at unit level.

---

## Task 12: QMD Documentation Sync

**Files:**
- Modify: `docs/qmd/architecture-overview.md`
- Modify: `docs/qmd/domain-task-orchestration.md`
- Modify: `docs/qmd/domain-agent-execution.md`
- Modify: `docs/qmd/domain-event-sourcing.md`
- Modify: `docs/qmd/domain-web-api.md`
- Modify: `docs/qmd/data-models.md`
- Modify: `docs/qmd/configuration.md`

- [ ] **Step 1: Update architecture overview**

In `docs/qmd/architecture-overview.md`, replace the old meta-loop diagram section with the Spec D flow:

```text
Task outcomes -> reward views -> lessons/reflection -> diagnostic fork proposals -> meta operation -> first-fork approval -> shadow evaluation -> graduation/promotion/demotion/merge/retirement.
```

Mention that `skill_versions` now represents a population per persona type, not one active row only.

- [ ] **Step 2: Update task orchestration docs**

In `docs/qmd/domain-task-orchestration.md`, add the dispatch flow:

```text
For each agent dispatch, OrchestratorService asks the dispatcher for a selected variant. The dispatcher applies classifier eligibility, baseline protection, epsilon exploration, exploitation weights, and candidate shadow selection. The selected variant's content and lineage lessons are injected into the agent prompt.
```

- [ ] **Step 3: Update agent execution docs**

In `docs/qmd/domain-agent-execution.md`, add utility agents:

```text
Reflector extracts lessons from terminal tasks. Diagnostician analyzes recent task histories and proposes forkable niches. Both run through AgentExecutor but are utility personas, not population members receiving live task traffic.
```

- [ ] **Step 4: Update event sourcing and data model docs**

In `docs/qmd/domain-event-sourcing.md` and `docs/qmd/data-models.md`, document:

```text
fork_proposals
skill_versions.specialty_embedding
variant_selected
shadow_run_completed
traffic_allocated
diagnostic_run_completed
diagnostic_cluster_detected
fork_approved
fork_rejected
variants_merged
```

- [ ] **Step 5: Update web API and configuration docs**

In `docs/qmd/domain-web-api.md`, add:

```text
GET /api/experiments?status=proposed&operation=fork
POST /api/experiments/:id/approve-fork
POST /api/experiments/:id/reject-fork
POST /api/diagnostic/run
```

In `docs/qmd/configuration.md`, add:

```text
EMBEDDING_PROVIDER
EMBEDDING_MODEL
OPENAI_API_KEY
AUTOFORGE_URL for CLI commands
```

- [ ] **Step 6: Verify docs contain the new terms**

Run:

```bash
rg "fork_proposals|diagnostic_run_completed|variants_merged|EMBEDDING_PROVIDER|approve-fork" docs/qmd
```

Expected: matches appear in the updated QMD docs.

---

## Final Verification

- [ ] **Step 1: Focused Spec D suite**

Run:

```bash
bun test tests/unit/fork-proposals-schema.test.ts tests/unit/specialty-embedding-schema.test.ts tests/unit/embedding.test.ts tests/unit/classifier.test.ts tests/unit/diagnostic.test.ts tests/unit/experiments-route.test.ts tests/unit/diagnostic-route.test.ts tests/unit/cli-experiments.test.ts tests/unit/merge-operation.test.ts tests/integration/spec-d-autonomous-loop.test.ts --timeout 60000
```

Expected: all Spec D tests pass.

- [ ] **Step 2: Full suite**

Run:

```bash
bun test --timeout 60000
```

Expected: every test passes.

- [ ] **Step 3: Typecheck**

Run:

```bash
bun run lint
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 4: Manual API sanity**

Run a dev server and exercise the routes:

```bash
bun run dev
```

In another terminal:

```bash
curl -s -X POST http://127.0.0.1:3000/api/diagnostic/run -H 'content-type: application/json' -d '{"agentType":"coder"}'
curl -s 'http://127.0.0.1:3000/api/experiments?status=proposed&operation=fork'
```

Expected: diagnostic route returns JSON and pending fork list returns JSON.

- [ ] **Step 5: QMD doc verification**

Run:

```bash
rg "population|fork_proposals|diagnostician|variants_merged|specialty_embedding|approve-fork" docs/qmd
```

Expected: QMD docs describe Spec D concepts and routes.

---

## Plan Self-Review

Spec D requirements covered:

1. `fork_proposals` table: Task 1.
2. `skill_versions.specialty_embedding`: Task 1.
3. Diagnostician persona and diagnostic runner: Tasks 5 and 6.
4. Embedding classifier replacing keyword primary path: Tasks 2, 3, and 4.
5. First-fork approval workflow with list, approve, reject, events, and proposal status: Task 7.
6. CLI parity for pending fork operations: Task 8.
7. Merge operation and validator rules: Task 9.
8. Embedding backfill: Task 10.
9. End-to-end loop evidence: Task 11.
10. QMD documentation sync: Task 12.

No implementation task depends on an uncreated module without first creating it in an earlier task. Existing A/B/C behavior is protected by focused regression test commands in Tasks 3, 4, 7, and 9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-population-operations.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** - Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
