# Step Inspector — Planner Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transcript capture, plan-review pause, and natural-language critique loop to Autoforge's planner stage. Reference spec: `docs/superpowers/specs/2026-04-16-step-inspector-planner-design.md`.

**Architecture:** New `agent_transcripts` table stores planner I/O per attempt. The orchestrator pauses after planning on STANDARD/THOROUGH (or per-task override) in a new `awaiting_plan_approval` state. Human approves or critiques; critique re-runs the planner with prior plan + feedback, bounded to 3 revisions. The SDK executor becomes the planner's executor (always), gains a per-run model override, exposes a transcript on `AgentResult`, and wires QMD MCP via the SDK's `mcp_servers` parameter. Dashboard adds a Plan Review Panel and a tabbed transcript drill-down.

**Tech Stack:** Bun, TypeScript (ESM, strict), `bun:sqlite`, `bun:test`, Hono, Zod, `@anthropic-ai/sdk`, vanilla JS frontend.

---

## File Map

**New files**
- `src/types/transcripts.ts` — types for `AgentTranscript`, `AgentTranscriptTurn`
- `src/web/routes/transcripts.ts` — `/api/tasks/:id/transcripts` and `/api/transcripts/:id`
- `tests/unit/transcripts.test.ts` — DB methods unit tests
- `tests/unit/sdk-executor-transcript.test.ts` — transcript capture unit test (mocked `messages.create`)
- `tests/integration/plan-review.test.ts` — end-to-end plan-review flow

**Modified files**
- `src/db/schema.sql` — append `agent_transcripts` table + index
- `src/db/client.ts` — add `insertTranscript`, `listTranscriptsByTask`, `getTranscript`
- `src/types/core.ts` — add `awaiting_plan_approval` and `replanning` to `TaskStage`
- `src/config/env.ts` — add `PLANNER_MODEL_COMPLEX`, `PLANNER_MODEL_EXPRESS`, `PLANNER_MAX_ITERATIONS`
- `src/executors/interface.ts` — add `model?` to `AgentTask`, `transcript?` to `AgentResult`
- `src/executors/anthropic-sdk.ts` — per-run model, transcript capture, MCP wiring
- `src/orchestrator/state-machine.ts` — new transitions
- `src/orchestrator/service.ts` — split `submitTask`, add `approvePlan`/`critiquePlan`, staleness exemption, route planner to SDK
- `src/web/server.ts` — register transcripts routes
- `src/web/routes/approvals.ts` — register `/approve-plan` and `/critique-plan`
- `src/web/routes/tasks.ts` — accept optional `reviewPlan` on POST body
- `src/web/public/dashboard.js` — Plan Review Panel + transcript drill-down + state badge
- `src/web/public/styles.css` — styles for plan review panel + tabs
- `src/web/public/index.html` — add transcript drill-down container
- `tests/unit/state-machine.test.ts` — extend coverage for new transitions
- `tests/integration/happy-path.test.ts` — keep green; verify EXPRESS no-pause path explicitly

---

## Task 1: Schema — `agent_transcripts` table

**Files:**
- Modify: `src/db/schema.sql` (append new table at the end)
- Test: `tests/unit/transcripts.test.ts` (create)

- [ ] **Step 1: Write failing test for schema presence**

```ts
// tests/unit/transcripts.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "transcripts-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"));
  return db;
}

describe("agent_transcripts schema", () => {
  test("table exists with required columns", () => {
    const db = freshDb();
    const cols = db.sqlite
      .query("PRAGMA table_info(agent_transcripts)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("task_id");
    expect(names).toContain("stage");
    expect(names).toContain("attempt");
    expect(names).toContain("created_at");
    expect(names).toContain("executor_used");
    expect(names).toContain("model");
    expect(names).toContain("system_prompt");
    expect(names).toContain("user_prompt");
    expect(names).toContain("transcript");
    expect(names).toContain("output");
    expect(names).toContain("critique");
    expect(names).toContain("token_input");
    expect(names).toContain("token_output");
    expect(names).toContain("elapsed_seconds");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/transcripts.test.ts`
Expected: FAIL — `PRAGMA table_info` returns empty array, assertions fail.

- [ ] **Step 3: Append table definition to schema**

Append at end of `src/db/schema.sql`:

```sql
-- Agent transcripts (planner stage in v1; reserves room for other stages).
-- One row per planner attempt. Holds composed system prompt, user prompt,
-- turn-by-turn transcript JSONL, and parsed output.
CREATE TABLE IF NOT EXISTS agent_transcripts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  stage           TEXT NOT NULL,
  attempt         INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  executor_used   TEXT NOT NULL,
  model           TEXT,
  system_prompt   TEXT NOT NULL,
  user_prompt     TEXT NOT NULL,
  transcript      TEXT NOT NULL,
  output          TEXT,
  critique        TEXT,
  token_input     INTEGER,
  token_output    INTEGER,
  elapsed_seconds REAL,
  UNIQUE(task_id, stage, attempt)
);
CREATE INDEX IF NOT EXISTS idx_agent_transcripts_task ON agent_transcripts(task_id, stage, attempt);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/transcripts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql tests/unit/transcripts.test.ts
git commit -m "feat(db): add agent_transcripts table for planner I/O capture"
```

---

## Task 2: DB methods — insert / list / get transcripts

**Files:**
- Modify: `src/db/client.ts`
- Test: `tests/unit/transcripts.test.ts` (extend)

- [ ] **Step 1: Add failing tests for the three DB methods**

Append to `tests/unit/transcripts.test.ts`:

```ts
import type { AgentTranscriptRow } from "../../src/types/transcripts";

describe("DbClient transcripts methods", () => {
  test("insertTranscript and getTranscript round-trip", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-1", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");

    const id = db.insertTranscript({
      taskId: "task-1",
      stage: "planner",
      attempt: 0,
      executorUsed: "anthropic-sdk",
      model: "claude-opus-4",
      systemPrompt: "you are the planner",
      userPrompt: "## Task\nbuild a thing",
      transcript: '{"kind":"assistant","content":[]}',
      output: '{"status":"DONE","subtasks":[]}',
      critique: null,
      tokenInput: 1234,
      tokenOutput: 56,
      elapsedSeconds: 12.3
    });

    const row = db.getTranscript(id);
    expect(row).not.toBeNull();
    expect(row!.taskId).toBe("task-1");
    expect(row!.stage).toBe("planner");
    expect(row!.attempt).toBe(0);
    expect(row!.systemPrompt).toBe("you are the planner");
    expect(row!.tokenInput).toBe(1234);
  });

  test("listTranscriptsByTask returns metadata only, ordered by attempt asc", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-2", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");

    db.insertTranscript({
      taskId: "task-2", stage: "planner", attempt: 1,
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: "fix it",
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });
    db.insertTranscript({
      taskId: "task-2", stage: "planner", attempt: 0,
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });

    const list = db.listTranscriptsByTask("task-2");
    expect(list).toHaveLength(2);
    expect(list[0].attempt).toBe(0);
    expect(list[1].attempt).toBe(1);
    // metadata: must NOT include heavy columns
    expect((list[0] as Partial<AgentTranscriptRow>).systemPrompt).toBeUndefined();
    expect((list[0] as Partial<AgentTranscriptRow>).transcript).toBeUndefined();
  });

  test("UNIQUE(task_id, stage, attempt) prevents duplicates", () => {
    const db = freshDb();
    db.sqlite
      .query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      )
      .run("task-3", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");

    db.insertTranscript({
      taskId: "task-3", stage: "planner", attempt: 0,
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });
    expect(() => db.insertTranscript({
      taskId: "task-3", stage: "planner", attempt: 0,
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    })).toThrow();
  });
});
```

- [ ] **Step 2: Add the types file**

Create `src/types/transcripts.ts`:

```ts
export interface AgentTranscriptInput {
  taskId: string;
  stage: "planner";
  attempt: number;
  executorUsed: string;
  model: string | null;
  systemPrompt: string;
  userPrompt: string;
  transcript: string;
  output: string | null;
  critique: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  elapsedSeconds: number | null;
}

export interface AgentTranscriptRow extends AgentTranscriptInput {
  id: string;
  createdAt: string;
}

export interface AgentTranscriptMeta {
  id: string;
  taskId: string;
  stage: string;
  attempt: number;
  createdAt: string;
  executorUsed: string;
  model: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  elapsedSeconds: number | null;
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/unit/transcripts.test.ts`
Expected: FAIL — `db.insertTranscript is not a function`.

- [ ] **Step 4: Add the three methods to DbClient**

In `src/db/client.ts`, add a top-level import:

```ts
import { randomUUID } from "node:crypto";
import type { AgentTranscriptInput, AgentTranscriptMeta, AgentTranscriptRow } from "../types/transcripts";
```

Then add these methods inside the `DbClient` class (place them above `listTasks`):

```ts
insertTranscript(input: AgentTranscriptInput): string {
  const id = randomUUID();
  this.sqlite.query(`
    INSERT INTO agent_transcripts (
      id, task_id, stage, attempt, created_at, executor_used, model,
      system_prompt, user_prompt, transcript, output, critique,
      token_input, token_output, elapsed_seconds
    ) VALUES (
      $id, $task_id, $stage, $attempt, $created_at, $executor_used, $model,
      $system_prompt, $user_prompt, $transcript, $output, $critique,
      $token_input, $token_output, $elapsed_seconds
    )
  `).run({
    $id: id,
    $task_id: input.taskId,
    $stage: input.stage,
    $attempt: input.attempt,
    $created_at: new Date().toISOString(),
    $executor_used: input.executorUsed,
    $model: input.model,
    $system_prompt: input.systemPrompt,
    $user_prompt: input.userPrompt,
    $transcript: input.transcript,
    $output: input.output,
    $critique: input.critique,
    $token_input: input.tokenInput,
    $token_output: input.tokenOutput,
    $elapsed_seconds: input.elapsedSeconds
  });
  return id;
}

listTranscriptsByTask(taskId: string): AgentTranscriptMeta[] {
  const rows = this.sqlite.query(`
    SELECT id, task_id, stage, attempt, created_at, executor_used, model,
           token_input, token_output, elapsed_seconds
    FROM agent_transcripts
    WHERE task_id = ?
    ORDER BY attempt ASC
  `).all(taskId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    taskId: String(r.task_id),
    stage: String(r.stage),
    attempt: Number(r.attempt),
    createdAt: String(r.created_at),
    executorUsed: String(r.executor_used),
    model: r.model === null ? null : String(r.model),
    tokenInput: r.token_input === null ? null : Number(r.token_input),
    tokenOutput: r.token_output === null ? null : Number(r.token_output),
    elapsedSeconds: r.elapsed_seconds === null ? null : Number(r.elapsed_seconds)
  }));
}

getTranscript(id: string): AgentTranscriptRow | null {
  const row = this.sqlite.query(
    "SELECT * FROM agent_transcripts WHERE id = ?"
  ).get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    stage: String(row.stage) as "planner",
    attempt: Number(row.attempt),
    createdAt: String(row.created_at),
    executorUsed: String(row.executor_used),
    model: row.model === null ? null : String(row.model),
    systemPrompt: String(row.system_prompt),
    userPrompt: String(row.user_prompt),
    transcript: String(row.transcript),
    output: row.output === null ? null : String(row.output),
    critique: row.critique === null ? null : String(row.critique),
    tokenInput: row.token_input === null ? null : Number(row.token_input),
    tokenOutput: row.token_output === null ? null : Number(row.token_output),
    elapsedSeconds: row.elapsed_seconds === null ? null : Number(row.elapsed_seconds)
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/transcripts.test.ts`
Expected: PASS for all three test cases.

- [ ] **Step 6: Commit**

```bash
git add src/db/client.ts src/types/transcripts.ts tests/unit/transcripts.test.ts
git commit -m "feat(db): add insertTranscript / listTranscriptsByTask / getTranscript"
```

---

## Task 3: Env vars — model and iteration config

**Files:**
- Modify: `src/config/env.ts`
- Test: `tests/unit/env.test.ts` (create — small)

- [ ] **Step 1: Write failing test**

Create `tests/unit/env.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadEnv } from "../../src/config/env";

describe("env defaults for planner config", () => {
  test("PLANNER_MODEL_COMPLEX defaults to a non-empty string", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.PLANNER_MODEL_COMPLEX.length).toBeGreaterThan(0);
  });

  test("PLANNER_MODEL_EXPRESS defaults to a non-empty string", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.PLANNER_MODEL_EXPRESS.length).toBeGreaterThan(0);
  });

  test("PLANNER_MAX_ITERATIONS defaults to 3", () => {
    const env = loadEnv({ NODE_ENV: "test" });
    expect(env.PLANNER_MAX_ITERATIONS).toBe(3);
  });

  test("PLANNER_MAX_ITERATIONS coerces from string", () => {
    const env = loadEnv({ NODE_ENV: "test", PLANNER_MAX_ITERATIONS: "5" });
    expect(env.PLANNER_MAX_ITERATIONS).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/env.test.ts`
Expected: FAIL — properties undefined.

- [ ] **Step 3: Add env fields**

In `src/config/env.ts`, add to the `EnvSchema` object (alongside existing fields):

```ts
PLANNER_MODEL_COMPLEX: z.string().default("claude-opus-4-1"),
PLANNER_MODEL_EXPRESS: z.string().default("claude-sonnet-4-6"),
PLANNER_MAX_ITERATIONS: z.coerce.number().int().min(0).max(10).default(3),
```

(Default model IDs match the existing `ANTHROPIC_MODEL` style in this file. Operators override via env when newer versions ship.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/unit/env.test.ts
git commit -m "feat(config): add PLANNER_MODEL_* and PLANNER_MAX_ITERATIONS env vars"
```

---

## Task 4: Executor types — model override + transcript field

**Files:**
- Modify: `src/executors/interface.ts`

No new test for the type-only change; subsequent tasks exercise the new fields.

- [ ] **Step 1: Add the new fields**

Replace the contents of `src/executors/interface.ts` with:

```ts
import type { AgentType, SubtaskReportStatus } from "../types/core";

export interface AgentTask {
  id: string;
  type: AgentType;
  systemPrompt: string;
  prompt: string;
  workingDirectory: string;
  budgetSeconds: number;
  environment: Record<string, string>;
  skillFiles: string[];
  metadata?: Record<string, unknown>;
  /** Per-run model override. When unset, executor uses its configured default. */
  model?: string;
}

export interface ToolStats {
  readCount: number;
  writeCount: number;
  bashCount: number;
  searchCount: number;
  iterations: number;
}

export type AgentTranscriptTurn =
  | { kind: "assistant"; content: unknown }
  | { kind: "tool_result"; toolUseId: string; content: string }
  | { kind: "compaction"; droppedTurns: number };

export interface AgentTranscript {
  systemPrompt: string;
  userPrompt: string;
  turns: AgentTranscriptTurn[];
}

export interface AgentResult {
  status: SubtaskReportStatus | "FAILED" | "TIMEOUT";
  artifacts: string[];
  concerns?: string;
  blockReason?: string;
  output?: unknown;
  metrics: {
    elapsedSeconds: number;
    tokenInput?: number;
    tokenOutput?: number;
    estimatedCost?: number;
    toolStats?: ToolStats;
  };
  /** Captured by SDK executor. Claude Code returns undefined. */
  transcript?: AgentTranscript;
}

export interface AgentExecutor {
  readonly name: string;
  execute(task: AgentTask): Promise<AgentResult>;
  healthCheck(): Promise<boolean>;
}
```

- [ ] **Step 2: Run full test suite to confirm no regressions**

Run: `bun test`
Expected: PASS — additive interface changes only.

- [ ] **Step 3: Commit**

```bash
git add src/executors/interface.ts
git commit -m "feat(executors): add per-run model override and transcript fields"
```

---

## Task 5: SDK executor — per-run model override

**Files:**
- Modify: `src/executors/anthropic-sdk.ts`
- Test: `tests/unit/sdk-executor-transcript.test.ts` (create)

- [ ] **Step 1: Write failing test**

Create `tests/unit/sdk-executor-transcript.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicSdkExecutor } from "../../src/executors/anthropic-sdk";

// Stub Anthropic client by monkey-patching the SDK module export. We use a
// thin wrapper around the executor's behavior by injecting a fake fetch via
// the SDK's transport — but that's heavyweight for Bun, so we instead test
// at the integration level by mocking the global fetch the SDK uses.
// For this test we just assert that the executor reads `task.model` and
// passes it through. We use a partial mock for `messages.create`.
function buildExecutor(captured: { model?: string }): AnthropicSdkExecutor {
  const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
  // Replace the executor's client construction by injecting a private hook.
  (exec as unknown as { _testCreate?: (opts: { model: string }) => Promise<unknown> })
    ._testCreate = async (opts) => {
      captured.model = opts.model;
      return {
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        content: []
      };
    };
  return exec;
}

describe("SDK executor model override", () => {
  test("uses task.model when set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-exec-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { model?: string } = {};
    const exec = buildExecutor(captured);

    await exec.execute({
      id: "t1", type: "planner", systemPrompt: "you are x", prompt: "do y",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: [],
      model: "claude-opus-override"
    });

    expect(captured.model).toBe("claude-opus-override");
  });

  test("falls back to constructor default when task.model unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-exec-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { model?: string } = {};
    const exec = buildExecutor(captured);

    await exec.execute({
      id: "t2", type: "planner", systemPrompt: "you are x", prompt: "do y",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(captured.model).toBe("default-sonnet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sdk-executor-transcript.test.ts`
Expected: FAIL — `_testCreate` hook does not exist; executor calls real Anthropic API instead.

- [ ] **Step 3: Implement the test hook + model override**

In `src/executors/anthropic-sdk.ts`, locate the `execute` method. Replace the call to `client.messages.create` to use a private hook when set:

Add inside the `AnthropicSdkExecutor` class (above `execute`):

```ts
/**
 * Test hook: when set, used instead of constructing an Anthropic client.
 * Production code never sets this. Wired to support unit testing without
 * stubbing the entire SDK module.
 */
private _testCreate?: (opts: {
  model: string;
  max_tokens: number;
  system: string;
  tools: unknown[];
  mcp_servers?: unknown;
  messages: unknown[];
}) => Promise<{
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
  content: unknown[];
}>;
```

Replace `await client.messages.create(...)` with a small dispatch. First, factor out the call options. Find the existing call:

```ts
response = await client.messages.create(
  {
    model: this.model,
    max_tokens: 8192,
    system: systemPrompt,
    tools: TOOLS,
    messages
  },
  { ... }
);
```

Replace with:

```ts
const callOpts = {
  model: task.model ?? this.model,
  max_tokens: 8192,
  system: systemPrompt,
  tools: TOOLS,
  messages
};

if (this._testCreate) {
  response = (await this._testCreate(callOpts)) as Anthropic.Message;
} else {
  response = await client.messages.create(
    callOpts,
    {
      timeout: Math.min(PER_CALL_TIMEOUT_MS, remainingMs),
      signal: AbortSignal.timeout(Math.min(PER_CALL_TIMEOUT_MS, remainingMs))
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sdk-executor-transcript.test.ts`
Expected: PASS for both override cases.

- [ ] **Step 5: Commit**

```bash
git add src/executors/anthropic-sdk.ts tests/unit/sdk-executor-transcript.test.ts
git commit -m "feat(sdk-executor): support per-run model override"
```

---

## Task 6: SDK executor — transcript capture

**Files:**
- Modify: `src/executors/anthropic-sdk.ts`
- Test: `tests/unit/sdk-executor-transcript.test.ts` (extend)

- [ ] **Step 1: Write failing test**

Append to `tests/unit/sdk-executor-transcript.test.ts`:

```ts
describe("SDK executor transcript capture", () => {
  test("returns transcript with system + user prompts and one assistant turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-tr-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    (exec as unknown as { _testCreate?: () => Promise<unknown> })._testCreate = async () => ({
      usage: { input_tokens: 5, output_tokens: 7 },
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello back" }]
    });

    const result = await exec.execute({
      id: "tx", type: "planner", systemPrompt: "persona", prompt: "do thing",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(result.transcript).toBeDefined();
    expect(result.transcript!.systemPrompt).toContain("persona");
    expect(result.transcript!.userPrompt).toBe("do thing");
    expect(result.transcript!.turns.length).toBeGreaterThanOrEqual(1);
    expect(result.transcript!.turns[0].kind).toBe("assistant");
  });

  test("captures tool_result turns when model uses a tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-tr-"));
    writeFileSync(join(dir, "hello.txt"), "world");
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const exec = new AnthropicSdkExecutor("test-key", "default-sonnet");
    let callCount = 0;
    (exec as unknown as { _testCreate?: (opts: { messages: unknown[] }) => Promise<unknown> })
      ._testCreate = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            usage: { input_tokens: 5, output_tokens: 7 },
            stop_reason: "tool_use",
            content: [
              { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "hello.txt" } }
            ]
          };
        }
        return {
          usage: { input_tokens: 5, output_tokens: 7 },
          stop_reason: "end_turn",
          content: [{ type: "text", text: "got it" }]
        };
      };

    const result = await exec.execute({
      id: "tx2", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    const kinds = result.transcript!.turns.map((t) => t.kind);
    expect(kinds).toContain("tool_result");
    const toolResult = result.transcript!.turns.find((t) => t.kind === "tool_result");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.kind === "tool_result") {
      expect(toolResult.content).toBe("world");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/sdk-executor-transcript.test.ts`
Expected: FAIL — `result.transcript` is `undefined`.

- [ ] **Step 3: Capture transcript inside the SDK executor**

In `src/executors/anthropic-sdk.ts`, add an import for the new types at the top:

```ts
import type { AgentExecutor, AgentResult, AgentTask, AgentTranscript, AgentTranscriptTurn } from "./interface";
```

Inside `execute`, declare a `turns` array next to `messages`:

```ts
const turns: AgentTranscriptTurn[] = [];
```

After each successful `messages.create` call, push the assistant turn:

```ts
turns.push({ kind: "assistant", content: response.content });
```

When the executor compacts history at iteration 20, push a marker before the splice:

```ts
if (iteration === 20 && messages.length > 14) {
  const droppedTurns = messages.length - 13;
  turns.push({ kind: "compaction", droppedTurns });
  const first = messages.slice(0, 1);
  const recent = messages.slice(-12);
  messages.length = 0;
  messages.push(...first, ...recent);
}
```

Inside the tool-results loop, push each tool result:

```ts
toolResults.push({
  type: "tool_result",
  tool_use_id: block.id,
  content: result
});
turns.push({ kind: "tool_result", toolUseId: block.id, content: result });
```

In every `return` site of `execute` (TIMEOUT, FAILED, success-without-status, success-with-status), include:

```ts
transcript: {
  systemPrompt,
  userPrompt: task.prompt,
  turns
} satisfies AgentTranscript
```

So for example the success return becomes:

```ts
return {
  status: statusFile.status,
  artifacts: statusFile.artifacts,
  concerns: statusFile.concerns,
  blockReason: statusFile.blockReason,
  output: statusFile,
  metrics: { /* unchanged */ },
  transcript: { systemPrompt, userPrompt: task.prompt, turns }
};
```

Apply the same `transcript` field to TIMEOUT, FAILED, and DONE_WITH_CONCERNS returns.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/sdk-executor-transcript.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/executors/anthropic-sdk.ts tests/unit/sdk-executor-transcript.test.ts
git commit -m "feat(sdk-executor): capture turn-by-turn transcript on AgentResult"
```

---

## Task 7: SDK executor — wire QMD MCP via `mcp_servers`

**Files:**
- Modify: `src/executors/anthropic-sdk.ts`
- Test: `tests/unit/sdk-executor-transcript.test.ts` (extend)

- [ ] **Step 1: Write failing test**

Append to `tests/unit/sdk-executor-transcript.test.ts`:

```ts
describe("SDK executor MCP wiring", () => {
  test("includes mcp_servers when QMD_MCP_URL is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-mcp-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { mcp_servers?: unknown } = {};
    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testCreate?: (opts: { mcp_servers?: unknown }) => Promise<unknown> })
      ._testCreate = async (opts) => {
        captured.mcp_servers = opts.mcp_servers;
        return {
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          content: []
        };
      };

    await exec.execute({
      id: "tm", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30,
      environment: { QMD_MCP_URL: "http://localhost:8181/mcp" },
      skillFiles: []
    });

    expect(captured.mcp_servers).toEqual([
      { type: "url", url: "http://localhost:8181/mcp", name: "qmd" }
    ]);
  });

  test("omits mcp_servers when QMD_MCP_URL is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sdk-nomcp-"));
    writeFileSync(join(dir, ".autoforge-status.json"), JSON.stringify({ status: "DONE", artifacts: [] }));

    const captured: { mcp_servers?: unknown } = {};
    const exec = new AnthropicSdkExecutor("test-key", "sonnet");
    (exec as unknown as { _testCreate?: (opts: { mcp_servers?: unknown }) => Promise<unknown> })
      ._testCreate = async (opts) => {
        captured.mcp_servers = opts.mcp_servers;
        return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", content: [] };
      };

    await exec.execute({
      id: "tm2", type: "planner", systemPrompt: "p", prompt: "u",
      workingDirectory: dir, budgetSeconds: 30, environment: {}, skillFiles: []
    });

    expect(captured.mcp_servers).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/sdk-executor-transcript.test.ts`
Expected: FAIL — `mcp_servers` not yet wired.

- [ ] **Step 3: Wire `mcp_servers`**

In `src/executors/anthropic-sdk.ts`, modify the `callOpts` construction inside `execute` to include `mcp_servers` when configured:

```ts
const mcpServers = task.environment.QMD_MCP_URL
  ? [{ type: "url" as const, url: task.environment.QMD_MCP_URL, name: "qmd" }]
  : undefined;

const callOpts = {
  model: task.model ?? this.model,
  max_tokens: 8192,
  system: systemPrompt,
  tools: TOOLS,
  ...(mcpServers ? { mcp_servers: mcpServers } : {}),
  messages
};
```

Adjust the production branch's `client.messages.create` accordingly — pass `callOpts` through. The `Anthropic.MessageCreateParams` type may not list `mcp_servers` depending on SDK version; if TypeScript complains in the production path, cast at the call site:

```ts
response = await client.messages.create(
  callOpts as unknown as Anthropic.MessageCreateParamsNonStreaming,
  {
    timeout: Math.min(PER_CALL_TIMEOUT_MS, remainingMs),
    signal: AbortSignal.timeout(Math.min(PER_CALL_TIMEOUT_MS, remainingMs))
  }
);
```

Add a comment above the cast explaining why: `// mcp_servers is supported by the Anthropic API but not always in the SDK's typed params.`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/sdk-executor-transcript.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/executors/anthropic-sdk.ts tests/unit/sdk-executor-transcript.test.ts
git commit -m "feat(sdk-executor): wire QMD MCP via Anthropic mcp_servers param"
```

---

## Task 8: TaskStage type + state machine — new states & transitions

**Files:**
- Modify: `src/types/core.ts`
- Modify: `src/orchestrator/state-machine.ts`
- Test: `tests/unit/state-machine.test.ts` (extend)

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/state-machine.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canTransition } from "../../src/orchestrator/state-machine";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/state-machine.test.ts`
Expected: FAIL — TypeScript error or runtime error because the new stages don't exist on `TaskStage`.

- [ ] **Step 3: Add new TaskStage entries**

In `src/types/core.ts`, extend `TaskStage`:

```ts
export type TaskStage =
  | "received"
  | "assessing"
  | "planning"
  | "awaiting_plan_approval"
  | "replanning"
  | "executing"
  | "reviewing"
  | "reworking"
  | "pr_created"
  | "awaiting_approval"
  | "documenting"
  | "completed"
  | "failed";
```

- [ ] **Step 4: Add transitions to the state machine**

In `src/orchestrator/state-machine.ts`, replace `allowedTransitions`:

```ts
const allowedTransitions: Record<TaskStage, TaskStage[]> = {
  received: ["assessing", "failed"],
  assessing: ["planning", "failed"],
  planning: ["awaiting_plan_approval", "executing", "failed"],
  awaiting_plan_approval: ["executing", "replanning", "failed"],
  replanning: ["awaiting_plan_approval", "failed"],
  executing: ["reviewing", "reworking", "failed"],
  reviewing: ["reworking", "pr_created", "failed"],
  reworking: ["executing", "failed"],
  pr_created: ["awaiting_approval", "reworking", "failed"],
  awaiting_approval: ["documenting", "reworking", "failed"],
  documenting: ["completed", "failed"],
  completed: [],
  failed: []
};
```

- [ ] **Step 5: Run state-machine tests to verify they pass**

Run: `bun test tests/unit/state-machine.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full test suite to confirm no regressions**

Run: `bun test`
Expected: PASS — existing tests still green; only types broadened, no transitions removed.

- [ ] **Step 7: Commit**

```bash
git add src/types/core.ts src/orchestrator/state-machine.ts tests/unit/state-machine.test.ts
git commit -m "feat(state-machine): add awaiting_plan_approval and replanning transitions"
```

---

## Task 9: Executor routing — planner always uses SDK

**Files:**
- Modify: `src/orchestrator/service.ts` (the `routeExecutor` method)
- Modify: `src/executors/factory.ts` (verify `ExecutorSet` shape; no edits expected)

- [ ] **Step 1: Read factory to verify the field name**

```bash
grep -n "claudeCode\|sdk" src/executors/factory.ts
```

Expected: `ExecutorSet` exposes `claudeCode` and optional `sdk`.

- [ ] **Step 2: Update the routing**

In `src/orchestrator/service.ts`, find `routeExecutor` and replace with:

```ts
private routeExecutor(tier: Tier, agentType: AgentType): AgentExecutor {
  const set = this.deps.executors;
  if (!set) return this.deps.executor;

  // Planner always routed to SDK so we can capture transcripts and pick
  // the model per run (Opus for STANDARD/THOROUGH). Falls back to Claude
  // Code if no SDK executor is configured (e.g. local dev without API key).
  if (agentType === "planner") return set.sdk ?? set.claudeCode;

  // Meta agent always gets Claude Code — needs broad exploration.
  if (agentType === "meta") return set.claudeCode;

  // SDK executor for EXPRESS tier (existing behavior).
  if (tier === "EXPRESS" && set.sdk) return set.sdk;

  return set.claudeCode;
}
```

- [ ] **Step 3: Run integration tests to confirm no regressions**

Run: `bun test tests/integration/`
Expected: PASS — `MockExecutor` is used in tests, routing change does not affect it.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/service.ts
git commit -m "feat(orchestrator): route planner to SDK executor unconditionally"
```

---

## Task 10: Orchestrator — pause-policy helper + planner phase split

**Files:**
- Modify: `src/orchestrator/service.ts`
- Test: `tests/integration/plan-review.test.ts` (create)

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/plan-review.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";

describe("plan-review pause", () => {
  test("STANDARD task pauses at awaiting_plan_approval after planner", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");
    expect(task.planSubtasks.length).toBeGreaterThan(0);
  });

  test("EXPRESS task does not pause; runs through to awaiting_approval", async () => {
    const { service } = createTestService();
    // The mock complexity assessor returns STANDARD for typical descriptions.
    // We force EXPRESS by passing the override.
    const task = await service.submitTask("autoforge", "tiny tweak", { forceTier: "EXPRESS" });
    expect(task.state).toBe("awaiting_approval");
  });
});
```

(If `submitTask` doesn't currently support `forceTier`, the test will require adapting; an alternative is to drive complexity via description keywords. See Step 4.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/plan-review.test.ts`
Expected: FAIL — `submitTask` runs end-to-end and reaches `awaiting_approval`.

- [ ] **Step 3: Add helper methods on OrchestratorService**

In `src/orchestrator/service.ts`, add private helpers above `submitTask`:

```ts
private pausePolicy(tier: Tier, reviewPlanOverride?: boolean): boolean {
  if (reviewPlanOverride !== undefined) return reviewPlanOverride;
  return tier === "STANDARD" || tier === "THOROUGH";
}

private plannerModel(tier: Tier): string {
  if (tier === "EXPRESS") return this.deps.env.PLANNER_MODEL_EXPRESS;
  return this.deps.env.PLANNER_MODEL_COMPLEX;
}
```

- [ ] **Step 4: Refactor submitTask to optionally pause and accept tier override**

Modify the `submitTask` signature and body. Keep the existing flow for the planner call, then branch based on `pausePolicy`. Replace the existing `submitTask` method with:

```ts
async submitTask(
  projectId: string,
  description: string,
  opts: { reviewPlan?: boolean; forceTier?: Tier } = {}
): Promise<PipelineTask> {
  const taskId = randomUUID();
  const assessment = assessComplexity(description);
  const tier = opts.forceTier ?? routeTier(assessment);
  const worktree = this.deps.worktrees.create(taskId);

  this.recordEvent({
    taskId,
    projectId,
    agent: "orchestrator",
    type: "created",
    status: "pending",
    payload: {
      description,
      state: "received",
      tier,
      assessment,
      planSubtasks: [],
      iteration: 0
    },
    budgetSeconds: 60
  });

  this.transition(taskId, projectId, "received", "assessing", { assessment, tier });
  this.transition(taskId, projectId, "assessing", "planning", {});

  const planSubtasks = await this.runPlannerAttempt(taskId, projectId, description, tier, worktree.path, 0, null);

  if (this.pausePolicy(tier, opts.reviewPlan)) {
    this.transition(taskId, projectId, "planning", "awaiting_plan_approval", { planSubtasks });
    return this.requireTask(taskId);
  }

  this.transition(taskId, projectId, "planning", "executing", { planSubtasks });

  try {
    await this.executeAndReview(taskId, projectId, description, tier, planSubtasks, 0, worktree.path, worktree.branch);
  } catch (err) {
    this.cleanupWorktree(taskId);
    throw err;
  }

  const task = this.deps.db.getTask(taskId);
  if (!task) throw new Error("Task disappeared after orchestration.");
  if (task.state === "awaiting_approval") return task;
  throw new Error(`Task ${taskId} did not reach approval state; current state: ${task.state}`);
}
```

Then add the `runPlannerAttempt` private helper (extracted from the existing planner block, with transcript capture wired in):

```ts
private async runPlannerAttempt(
  taskId: string,
  projectId: string,
  description: string,
  tier: Tier,
  worktreePath: string,
  attempt: number,
  critique: string | null,
  priorPlan?: PlanSubtask[]
): Promise<PlanSubtask[]> {
  const plannerExecutor = this.routeExecutor(tier, "planner");

  const userPrompt = this.buildPlannerPrompt(description, tier, attempt, priorPlan, critique);

  const plannerResult = await plannerExecutor.execute({
    id: taskId,
    type: "planner",
    systemPrompt: this.personas.resolve("planner"),
    prompt: userPrompt,
    workingDirectory: worktreePath,
    budgetSeconds: this.budgetForTier(tier, "planner"),
    environment: this.agentEnvironment(),
    skillFiles: this.skills.skillsForAgent("planner"),
    metadata: { description, tier, attempt },
    model: this.plannerModel(tier)
  });

  const plannerPersonaId = this.personas.snapshotId("planner");
  const plannerSkillIds = this.skills.snapshotIds("planner");
  const planSubtasks = parsePlanSubtasks(taskId, plannerResult.output, worktreePath);
  const plannerFallback =
    planSubtasks.length === 1 &&
    planSubtasks[0].description === "Implement requested behavior with tests-first workflow.";

  // Persist transcript before emitting `planned` so the event payload pointer
  // is always valid.
  const transcript = plannerResult.transcript;
  const turnsJsonl = transcript
    ? transcript.turns.map((t) => JSON.stringify(t)).join("\n")
    : "";

  const transcriptId = this.deps.db.insertTranscript({
    taskId,
    stage: "planner",
    attempt,
    executorUsed: plannerExecutor.name,
    model: this.plannerModel(tier),
    systemPrompt: transcript?.systemPrompt ?? this.personas.resolve("planner"),
    userPrompt: transcript?.userPrompt ?? userPrompt,
    transcript: turnsJsonl,
    output: plannerResult.output ? JSON.stringify(plannerResult.output) : null,
    critique,
    tokenInput: plannerResult.metrics.tokenInput ?? null,
    tokenOutput: plannerResult.metrics.tokenOutput ?? null,
    elapsedSeconds: plannerResult.metrics.elapsedSeconds
  });

  this.recordEvent({
    taskId,
    projectId,
    agent: "planner",
    type: "planned",
    status: plannerFallback ? "done_with_concerns" : "done",
    payload: {
      planSubtasks,
      planner_fallback: plannerFallback,
      attempt,
      transcript_id: transcriptId
    },
    budgetSeconds: this.budgetForTier(tier, "planner"),
    elapsedSeconds: plannerResult.metrics.elapsedSeconds,
    tokenUsage: plannerResult.metrics.tokenInput !== undefined ? {
      input: plannerResult.metrics.tokenInput,
      output: plannerResult.metrics.tokenOutput ?? 0,
      estimatedCost: plannerResult.metrics.estimatedCost
    } : undefined,
    executorUsed: plannerExecutor.name,
    personaVersionId: plannerPersonaId,
    skillVersionIds: plannerSkillIds
  });

  return planSubtasks;
}

private buildPlannerPrompt(
  description: string,
  tier: Tier,
  attempt: number,
  priorPlan: PlanSubtask[] | undefined,
  critique: string | null
): string {
  const assessment = assessComplexity(description);
  const base = `## Task\n${description}\n\n## Complexity signals\nTier: ${tier} | Scope: ${assessment.scope} | Risk: ${assessment.risk} | Coupling: ${assessment.coupling}`;
  if (attempt === 0 || !priorPlan || !critique) return base;

  return [
    base,
    `## Prior plan (attempt ${attempt - 1})`,
    JSON.stringify(priorPlan, null, 2),
    `## Human feedback on prior plan`,
    critique,
    `## Instructions`,
    "Revise the plan to address the feedback. Prefer minimal changes — keep subtasks that were not critiqued, unless the feedback implies they should change."
  ].join("\n\n");
}
```

- [ ] **Step 5: Update tests/helpers/create-service.ts to thread `forceTier`**

In `tests/helpers/create-service.ts`, no change needed — `forceTier` flows through the public `submitTask` signature directly.

- [ ] **Step 6: Run integration test to verify it passes**

Run: `bun test tests/integration/plan-review.test.ts`
Expected: PASS for both cases.

- [ ] **Step 7: Run full test suite to confirm no regressions**

Run: `bun test`
Expected: PASS. The existing happy-path test continues to expect `awaiting_approval`; this passes because the default complexity for "Add a hello world endpoint" routes to STANDARD by `routeTier`, which would now pause. **Update the existing happy-path test:**

In `tests/integration/happy-path.test.ts`, change line 7 to force EXPRESS or add a `reviewPlan: false` override:

```ts
const task = await service.submitTask("autoforge", "Add a hello world endpoint", { reviewPlan: false });
```

Run again: `bun test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/service.ts tests/integration/plan-review.test.ts tests/integration/happy-path.test.ts
git commit -m "feat(orchestrator): pause at awaiting_plan_approval; capture planner transcript"
```

---

## Task 11: Orchestrator — `approvePlan` method

**Files:**
- Modify: `src/orchestrator/service.ts`
- Test: `tests/integration/plan-review.test.ts` (extend)

- [ ] **Step 1: Add failing test**

Append to `tests/integration/plan-review.test.ts`:

```ts
describe("approvePlan", () => {
  test("approves plan and runs to awaiting_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");

    const resumed = await service.approvePlan(task.id);
    expect(resumed.state).toBe("awaiting_approval");
  });

  test("rejects approve when task is not in awaiting_plan_approval", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "x", { reviewPlan: false });
    expect(task.state).toBe("awaiting_approval");
    await expect(service.approvePlan(task.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/plan-review.test.ts`
Expected: FAIL — `service.approvePlan is not a function`.

- [ ] **Step 3: Add the method**

In `src/orchestrator/service.ts`, add `approvePlan` (place above `approveTask`):

```ts
async approvePlan(taskId: string): Promise<PipelineTask> {
  const task = this.requireTask(taskId);
  if (task.state !== "awaiting_plan_approval") {
    throw new Error(`Cannot approve plan: task is in state '${task.state}'`);
  }

  this.recordEvent({
    taskId,
    projectId: task.projectId,
    agent: "orchestrator",
    type: "plan_approved",
    status: "done",
    payload: { state: "executing" },
    budgetSeconds: 60
  });

  this.transition(taskId, task.projectId, "awaiting_plan_approval", "executing", {});

  const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
  if (!worktreePath) throw new Error(`Worktree missing for task ${taskId}`);
  const branch = `autoforge/${taskId}`;

  try {
    await this.executeAndReview(
      taskId, task.projectId, task.description, task.tier,
      task.planSubtasks, 0, worktreePath, branch
    );
  } catch (err) {
    this.cleanupWorktree(taskId);
    throw err;
  }

  return this.requireTask(taskId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/integration/plan-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/service.ts tests/integration/plan-review.test.ts
git commit -m "feat(orchestrator): add approvePlan to resume pipeline after plan review"
```

---

## Task 12: Orchestrator — `critiquePlan` method with iteration limit

**Files:**
- Modify: `src/orchestrator/service.ts`
- Test: `tests/integration/plan-review.test.ts` (extend)

- [ ] **Step 1: Add failing tests**

Append to `tests/integration/plan-review.test.ts`:

```ts
describe("critiquePlan", () => {
  test("critique re-runs planner and returns to awaiting_plan_approval", async () => {
    const { service, db } = createTestService();
    const task = await service.submitTask("autoforge", "Add a STANDARD-tier feature");
    expect(task.state).toBe("awaiting_plan_approval");

    const after = await service.critiquePlan(task.id, "please split subtask 1");
    expect(after.state).toBe("awaiting_plan_approval");

    const transcripts = db.listTranscriptsByTask(task.id);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[1].attempt).toBe(1);
  });

  test("critique on a non-paused task is rejected", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "x", { reviewPlan: false });
    await expect(service.critiquePlan(task.id, "x")).rejects.toThrow();
  });

  test("4th critique exceeds limit and throws", async () => {
    const { service } = createTestService();
    const task = await service.submitTask("autoforge", "STANDARD task");
    await service.critiquePlan(task.id, "feedback 1");
    await service.critiquePlan(task.id, "feedback 2");
    await service.critiquePlan(task.id, "feedback 3");
    // attempt is now 3 (the last allowed); a fourth critique must throw.
    await expect(service.critiquePlan(task.id, "feedback 4")).rejects.toThrow(/limit/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/integration/plan-review.test.ts`
Expected: FAIL — `critiquePlan` not defined.

- [ ] **Step 3: Add the method**

In `src/orchestrator/service.ts`:

```ts
async critiquePlan(taskId: string, critique: string): Promise<PipelineTask> {
  const task = this.requireTask(taskId);
  if (task.state !== "awaiting_plan_approval") {
    throw new Error(`Cannot critique plan: task is in state '${task.state}'`);
  }

  const transcripts = this.deps.db.listTranscriptsByTask(taskId);
  const lastAttempt = transcripts.length === 0 ? 0 : Math.max(...transcripts.map((t) => t.attempt));
  if (lastAttempt >= this.deps.env.PLANNER_MAX_ITERATIONS) {
    throw new Error(`Re-plan iteration limit (${this.deps.env.PLANNER_MAX_ITERATIONS}) reached for task ${taskId}`);
  }

  const nextAttempt = lastAttempt + 1;
  const priorPlan = task.planSubtasks;

  this.recordEvent({
    taskId,
    projectId: task.projectId,
    agent: "orchestrator",
    type: "plan_critiqued",
    status: "in_progress",
    payload: {
      critique_text: critique,
      critiqued_attempt: lastAttempt,
      next_attempt: nextAttempt
    },
    budgetSeconds: 60
  });

  this.transition(taskId, task.projectId, "awaiting_plan_approval", "replanning", {});

  const worktreePath = this.deps.worktrees.findWorktreePath(taskId);
  if (!worktreePath) {
    this.transition(taskId, task.projectId, "replanning", "failed", { reason: "worktree missing" });
    throw new Error(`Worktree missing for task ${taskId}`);
  }

  let newPlan: PlanSubtask[];
  try {
    newPlan = await this.runPlannerAttempt(
      taskId, task.projectId, task.description, task.tier,
      worktreePath, nextAttempt, critique, priorPlan
    );
  } catch (err) {
    this.transition(taskId, task.projectId, "replanning", "failed", { reason: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  this.transition(taskId, task.projectId, "replanning", "awaiting_plan_approval", { planSubtasks: newPlan });
  return this.requireTask(taskId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/integration/plan-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/service.ts tests/integration/plan-review.test.ts
git commit -m "feat(orchestrator): add critiquePlan with iteration limit enforcement"
```

---

## Task 13: Orchestrator — exempt `awaiting_plan_approval` from staleness sweeper

**Files:**
- Modify: `src/orchestrator/service.ts` (the `sweepStaleTasks` method)
- Test: `tests/unit/state-machine.test.ts` (extend) — covered indirectly; add a focused test on the helper if extracted, otherwise document behavior in `plan-review.test.ts`

- [ ] **Step 1: Find the staleness list in `sweepStaleTasks`**

Search inside the `sweepStaleTasks` method for `nonTerminalStates`. It currently lists eight stages. We must:
- ADD `replanning` to the swept set (active planner work; should fail if stuck).
- NOT add `awaiting_plan_approval` (it is a human gate).

- [ ] **Step 2: Update the list**

Replace the `nonTerminalStates` declaration in `sweepStaleTasks`:

```ts
const nonTerminalStates = [
  "received", "assessing", "planning", "replanning",
  "executing", "reviewing", "reworking", "pr_created", "documenting"
  // 'awaiting_plan_approval' and 'awaiting_approval' are intentionally excluded
  // — both are human gates with no in-flight work and no staleness deadline.
];
```

- [ ] **Step 3: Run tests to confirm no regressions**

Run: `bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/service.ts
git commit -m "feat(orchestrator): exempt awaiting_plan_approval from staleness sweeper"
```

---

## Task 14: API — `/approve-plan` and `/critique-plan` routes

**Files:**
- Modify: `src/web/routes/approvals.ts`
- Test: integration test via the orchestrator already covers business logic; add an HTTP-shape test under `tests/unit/`.

- [ ] **Step 1: Add the routes**

In `src/web/routes/approvals.ts`, extend the `createApprovalRoutes` function. Add a Zod schema and two routes:

```ts
const CritiqueSchema = z.object({
  critique: z.string().min(1).max(4000)
});
```

After the existing `app.post("/:id/cancel", ...)` block:

```ts
app.post("/:id/approve-plan", async (ctx) => {
  const task = await service.approvePlan(ctx.req.param("id"));
  events.publish({ type: "task.updated", data: task });
  return ctx.json(task);
});

app.post("/:id/critique-plan", async (ctx) => {
  let body: { critique: string };
  try {
    body = CritiqueSchema.parse(await ctx.req.json());
  } catch (err) {
    return ctx.json({ error: "invalid_body", details: err instanceof Error ? err.message : String(err) }, 400);
  }
  try {
    const task = await service.critiquePlan(ctx.req.param("id"), body.critique);
    events.publish({ type: "task.updated", data: task });
    return ctx.json(task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("limit")) return ctx.json({ error: "iteration_limit_reached", message: msg }, 409);
    return ctx.json({ error: "critique_failed", message: msg }, 400);
  }
});
```

- [ ] **Step 2: Run integration tests to confirm wiring**

Run: `bun test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/routes/approvals.ts
git commit -m "feat(api): add POST /api/tasks/:id/approve-plan and /critique-plan"
```

---

## Task 15: API — `/transcripts` routes + accept `reviewPlan` on task create

**Files:**
- Create: `src/web/routes/transcripts.ts`
- Modify: `src/web/routes/tasks.ts`
- Modify: `src/web/server.ts` (register transcript route group at root level)

- [ ] **Step 1: Create transcripts routes**

Create `src/web/routes/transcripts.ts`:

```ts
import { Hono } from "hono";
import type { DbClient } from "../../src/db/client";

export function createTranscriptsRoutes(db: DbClient): Hono {
  const app = new Hono();

  app.get("/by-task/:taskId", (ctx) => {
    return ctx.json(db.listTranscriptsByTask(ctx.req.param("taskId")));
  });

  app.get("/:id", (ctx) => {
    const row = db.getTranscript(ctx.req.param("id"));
    if (!row) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(row);
  });

  return app;
}
```

(Note path: import path is relative to `src/web/routes/`, so use `../../db/client` — adjust the literal in the file accordingly.)

Correction — use this exact import path:

```ts
import type { DbClient } from "../../db/client";
```

- [ ] **Step 2: Update task create schema to accept `reviewPlan`**

In `src/web/routes/tasks.ts`, replace `CreateTaskSchema`:

```ts
const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  description: z.string().min(1),
  reviewPlan: z.boolean().optional()
});
```

And update the POST handler:

```ts
app.post("/", async (ctx) => {
  const body = CreateTaskSchema.parse(await ctx.req.json());
  const task = await service.submitTask(body.projectId, body.description, {
    reviewPlan: body.reviewPlan
  });
  events.publish({ type: "task.updated", data: task });
  return ctx.json(task, 201);
});
```

- [ ] **Step 3: Register transcripts route group in the server**

In `src/web/server.ts`, add an import and a `.route` registration:

```ts
import { createTranscriptsRoutes } from "./routes/transcripts";
```

Inside `createWebServer`:

```ts
app.route("/api/transcripts", createTranscriptsRoutes(db));
```

- [ ] **Step 4: Add a small smoke test**

Append to `tests/unit/transcripts.test.ts`:

```ts
import { Hono } from "hono";
import { createTranscriptsRoutes } from "../../src/web/routes/transcripts";

describe("transcripts API", () => {
  test("GET /api/transcripts/by-task/:taskId returns metadata", async () => {
    const db = freshDb();
    db.sqlite.query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run("t-api", "proj", "desc", "planning", "STANDARD", "{}", "[]", 0, "2026-04-16T00:00:00Z", "2026-04-16T00:00:00Z");
    db.insertTranscript({
      taskId: "t-api", stage: "planner", attempt: 0,
      executorUsed: "anthropic-sdk", model: "opus", systemPrompt: "s", userPrompt: "u",
      transcript: "", output: null, critique: null,
      tokenInput: 1, tokenOutput: 1, elapsedSeconds: 1
    });

    const app = new Hono();
    app.route("/api/transcripts", createTranscriptsRoutes(db));
    const res = await app.request("/api/transcripts/by-task/t-api");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].attempt).toBe(0);
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/transcripts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/transcripts.ts src/web/routes/tasks.ts src/web/server.ts tests/unit/transcripts.test.ts
git commit -m "feat(api): add /api/transcripts routes and reviewPlan on task create"
```

---

## Task 16: Dashboard — Plan Review Panel rendering

**Files:**
- Modify: `src/web/public/dashboard.js`
- Modify: `src/web/public/styles.css`

- [ ] **Step 1: Extend the action-block branch in `renderTaskDetail`**

In `src/web/public/dashboard.js`, find the `actionsHtml` block in `renderTaskDetail` and add a new branch BEFORE the existing `awaiting_approval` branch:

```js
if (task.state === "awaiting_plan_approval") {
  const attemptCount = (task.planAttempt ?? 0);  // populated below; falls back to 0
  const maxAttempts = (window.PLANNER_MAX_ITERATIONS ?? 3) + 1;
  const planNum = attemptCount + 1;
  const reviseDisabled = attemptCount >= (maxAttempts - 1);
  actionsHtml = `
    <div class="task-detail-actions plan-review">
      <h3 class="plan-review-title">Plan Review — plan #${planNum} of ${maxAttempts}</h3>
      <textarea id="critique-input" class="critique-input" rows="4"
        placeholder="Optional: leave a natural-language critique to revise the plan."></textarea>
      <div class="plan-review-buttons">
        <button class="btn btn-approve" onclick="approvePlan('${task.id}')">Approve &amp; Continue</button>
        <button class="btn btn-secondary" id="btn-critique"
          onclick="critiquePlan('${task.id}')" ${reviseDisabled ? "disabled" : ""}>
          Revise Plan${reviseDisabled ? " (limit reached)" : ""}
        </button>
        <button class="btn btn-ghost btn-sm" onclick="cancelTask('${task.id}')" style="margin-left:auto">Cancel</button>
      </div>
    </div>`;
}
```

Note: `task.planAttempt` is not part of the existing API. We populate it at render time by calling the transcripts API. Add to `refreshTaskDetail`:

Replace the existing `refreshTaskDetail` body with:

```js
async function refreshTaskDetail(taskId) {
  try {
    const [taskRes, transcriptsRes] = await Promise.all([
      fetch(`${API}/api/tasks/${taskId}`),
      fetch(`${API}/api/transcripts/by-task/${taskId}`)
    ]);
    if (!taskRes.ok) {
      detailContent.innerHTML = `<div class="empty-state">Task not found.</div>`;
      return;
    }
    const task = await taskRes.json();
    const transcripts = transcriptsRes.ok ? await transcriptsRes.json() : [];
    task.planAttempt = transcripts.length === 0 ? 0 : Math.max(...transcripts.map((t) => t.attempt));
    task.transcripts = transcripts;
    renderTaskDetail(task);
  } catch {
    detailContent.innerHTML = `<div class="empty-state">Failed to load task.</div>`;
  }
}
```

- [ ] **Step 2: Add `approvePlan` and `critiquePlan` handlers**

Add to `src/web/public/dashboard.js` (after `cancelTask`):

```js
async function approvePlan(taskId) {
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/approve-plan`, { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    toast("Plan approved — execution starting…", "success");
    refreshTasks();
    refreshTaskDetail(taskId);
  } catch (err) {
    toast(`Approve plan failed: ${err.message}`, "error");
  }
}

async function critiquePlan(taskId) {
  const input = document.getElementById("critique-input");
  const critique = (input?.value ?? "").trim();
  if (!critique) {
    toast("Please enter a critique to revise the plan.", "error");
    return;
  }
  try {
    const res = await fetch(`${API}/api/tasks/${taskId}/critique-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ critique })
    });
    if (res.status === 409) {
      toast("Re-plan limit reached — approve or cancel.", "error");
      return;
    }
    if (!res.ok) throw new Error(await res.text());
    toast("Critique submitted — re-planning…", "success");
    refreshTasks();
    refreshTaskDetail(taskId);
  } catch (err) {
    toast(`Critique failed: ${err.message}`, "error");
  }
}

window.approvePlan = approvePlan;
window.critiquePlan = critiquePlan;
```

- [ ] **Step 3: Show test criteria in subtask cards**

In `renderTaskDetail`, find the subtasks rendering block and replace with:

```js
${subtasks.length > 0 ? `
<div class="detail-section">
  <h3>Plan (${subtasks.length} subtask${subtasks.length !== 1 ? "s" : ""})</h3>
  ${subtasks.map((s) => `
    <div class="subtask-item">
      <div class="subtask-header">
        <span class="subtask-seq">#${s.sequence}</span>
        <span class="subtask-agent">${esc(s.agentType ?? "coder")}</span>
        <span class="subtask-desc">${esc(s.description)}</span>
      </div>
      ${s.filesInScope?.length ? `<div class="subtask-files">files: ${s.filesInScope.join(", ")}</div>` : ""}
      ${s.testCriteria?.length ? `<div class="subtask-tests">
        <div class="subtask-tests-label">Test criteria:</div>
        <ul>${s.testCriteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>` : ""}
    </div>
  `).join("")}
</div>` : ""}
```

- [ ] **Step 4: Add CSS styles**

Append to `src/web/public/styles.css`:

```css
/* Plan review panel */
.task-detail-actions.plan-review {
  flex-direction: column;
  align-items: stretch;
  gap: 0.75rem;
}
.plan-review-title { margin: 0 0 0.25rem 0; font-size: 0.95rem; color: var(--text-muted); }
.critique-input {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-family: inherit;
  font-size: 0.9rem;
  resize: vertical;
}
.plan-review-buttons { display: flex; gap: 0.5rem; align-items: center; }
.btn-secondary {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
}
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

/* Subtask card extensions */
.subtask-header { display: flex; gap: 0.5rem; align-items: center; }
.subtask-agent {
  font-size: 0.7rem;
  text-transform: uppercase;
  background: var(--surface);
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  color: var(--text-muted);
}
.subtask-tests { margin-top: 0.4rem; font-size: 0.8rem; color: var(--text-muted); }
.subtask-tests-label { font-weight: 600; margin-bottom: 0.2rem; }
.subtask-tests ul { margin: 0; padding-left: 1.2rem; }
```

- [ ] **Step 5: Manual smoke test**

Run: `bun run src/index.ts`
Open `http://127.0.0.1:3000`, submit a STANDARD-tier task, confirm the Plan Review Panel appears with the textarea and three buttons, and that test criteria are shown under each subtask.

- [ ] **Step 6: Commit**

```bash
git add src/web/public/dashboard.js src/web/public/styles.css
git commit -m "feat(dashboard): add Plan Review Panel with approve/critique flow"
```

---

## Task 17: Dashboard — transcript drill-down (tabbed viewer)

**Files:**
- Modify: `src/web/public/dashboard.js`
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/styles.css`

- [ ] **Step 1: Add the drill-down container to index.html**

In `src/web/public/index.html`, add a `<dialog>` element near the bottom (before the `</body>` tag, alongside other dialogs):

```html
<dialog id="dialog-transcript" class="dialog dialog-wide">
  <div class="dialog-header">
    <h2 id="transcript-title">Transcript</h2>
    <button class="btn btn-ghost btn-sm" id="btn-close-transcript">Close</button>
  </div>
  <div class="transcript-meta" id="transcript-meta"></div>
  <div class="transcript-tabs">
    <button class="tab-btn active" data-tab="system">System Prompt</button>
    <button class="tab-btn" data-tab="user">User Prompt</button>
    <button class="tab-btn" data-tab="transcript">Transcript</button>
    <button class="tab-btn" data-tab="output">Output</button>
  </div>
  <div class="transcript-pane" id="transcript-pane"></div>
</dialog>
```

- [ ] **Step 2: Add the open/close + render logic to dashboard.js**

Append to `src/web/public/dashboard.js`:

```js
const dialogTranscript = document.getElementById("dialog-transcript");
const transcriptMeta = document.getElementById("transcript-meta");
const transcriptPane = document.getElementById("transcript-pane");
let currentTranscript = null;
let currentTab = "system";

document.getElementById("btn-close-transcript").addEventListener("click", () => dialogTranscript.close());

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderTranscriptTab();
  });
});

async function openTranscript(transcriptId) {
  try {
    const res = await fetch(`${API}/api/transcripts/${transcriptId}`);
    if (!res.ok) {
      toast("Transcript not found.", "error");
      return;
    }
    currentTranscript = await res.json();
    document.getElementById("transcript-title").textContent =
      `Planner — attempt ${currentTranscript.attempt} — ${currentTranscript.model ?? currentTranscript.executorUsed}`;
    transcriptMeta.innerHTML = `
      <span>tokens: ${currentTranscript.tokenInput ?? "?"} in / ${currentTranscript.tokenOutput ?? "?"} out</span>
      <span>elapsed: ${formatElapsed(currentTranscript.elapsedSeconds)}</span>
      <span>executor: ${esc(currentTranscript.executorUsed)}</span>
    `;
    currentTab = "system";
    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === "system")
    );
    renderTranscriptTab();
    dialogTranscript.showModal();
  } catch (err) {
    toast(`Failed to load transcript: ${err.message}`, "error");
  }
}
window.openTranscript = openTranscript;

function renderTranscriptTab() {
  if (!currentTranscript) return;
  if (currentTab === "system") {
    transcriptPane.innerHTML = `<pre class="prompt-block">${esc(currentTranscript.systemPrompt)}</pre>`;
  } else if (currentTab === "user") {
    transcriptPane.innerHTML = `<pre class="prompt-block">${esc(currentTranscript.userPrompt)}</pre>`;
    if (currentTranscript.critique) {
      transcriptPane.innerHTML += `<div class="critique-block"><strong>Critique that triggered this attempt:</strong><br>${esc(currentTranscript.critique)}</div>`;
    }
  } else if (currentTab === "transcript") {
    const lines = (currentTranscript.transcript || "").split("\n").filter(Boolean);
    transcriptPane.innerHTML = lines.map((line) => {
      let turn;
      try { turn = JSON.parse(line); } catch { return ""; }
      if (turn.kind === "compaction") {
        return `<div class="turn-compaction">— history compacted (${turn.droppedTurns} turns dropped) —</div>`;
      }
      if (turn.kind === "tool_result") {
        return `<details class="turn turn-tool-result"><summary>tool_result <code>${esc(turn.toolUseId)}</code></summary><pre>${esc(turn.content)}</pre></details>`;
      }
      // assistant: render its content blocks
      const blocks = (turn.content || []).map((b) => {
        if (b.type === "text") return `<div class="block-text">${esc(b.text)}</div>`;
        if (b.type === "tool_use") return `<details class="turn turn-tool-use"><summary>tool_use <strong>${esc(b.name)}</strong></summary><pre>${esc(JSON.stringify(b.input, null, 2))}</pre></details>`;
        if (b.type === "mcp_tool_use") return `<details class="turn turn-mcp"><summary><span class="mcp-badge">qmd</span> ${esc(b.name)}</summary><pre>${esc(JSON.stringify(b.input ?? {}, null, 2))}</pre></details>`;
        return `<div class="block-other">${esc(JSON.stringify(b))}</div>`;
      }).join("");
      return `<div class="turn turn-assistant">${blocks}</div>`;
    }).join("");
  } else if (currentTab === "output") {
    let output;
    try { output = JSON.parse(currentTranscript.output ?? "null"); } catch { output = currentTranscript.output; }
    transcriptPane.innerHTML = `<pre class="output-block">${esc(JSON.stringify(output, null, 2))}</pre>`;
  }
}
```

- [ ] **Step 3: Make `planned` events in the timeline clickable**

In `src/web/public/dashboard.js`, find `loadEvents` and modify the per-event template to make `planned` events clickable when they carry a `transcriptId`.

Find the line that returns the `<div class="tl-item">...` template inside `events.map(...)`. Replace with:

```js
const transcriptId = ev.payload?.transcript_id;
const clickAttr = transcriptId
  ? `style="cursor:pointer" onclick="openTranscript('${transcriptId}')" title="View transcript"`
  : "";
return `
  <div class="tl-item" ${clickAttr}>
    <span class="tl-dot" style="background:${dotColor}"></span>
    <div class="tl-body">
      <span class="tl-agent" style="color:${agentCol}">${esc(ev.agent)}</span>
      <span class="tl-type">${esc(ev.type)}</span>
      ${failureBadge}${elapsed}${tokens}
      <span class="tl-time">${timeAgo(ev.timestamp)}</span>
      ${failureReason}
    </div>
  </div>`;
```

The events route returns the raw event row including `payload`; make sure the route returns `payload` parsed. Verify:

```bash
grep -n "listEvents" src/db/client.ts
```

If `listEvents` returns events with `payload` as a string, parse it in the route or in the client. Quick fix: in `loadEvents` JS, parse on the client side:

```js
const events = (await res.json()).map((ev) => ({
  ...ev,
  payload: typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload
}));
```

- [ ] **Step 4: Add a "View transcript" link in the Plan Review Panel**

In the `actionsHtml` for `awaiting_plan_approval` (Task 16, Step 1), add the link near the title. Replace the title line:

```js
const latestTranscript = (task.transcripts ?? []).slice(-1)[0];
const viewLink = latestTranscript
  ? `<a href="#" onclick="openTranscript('${latestTranscript.id}'); return false;" class="view-transcript-link">View transcript →</a>`
  : "";
// ...
<h3 class="plan-review-title">Plan Review — plan #${planNum} of ${maxAttempts} ${viewLink}</h3>
```

- [ ] **Step 5: Add CSS for the dialog and turns**

Append to `src/web/public/styles.css`:

```css
.dialog-wide { max-width: 80vw; width: 80vw; max-height: 85vh; }
.dialog-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
.transcript-meta { display: flex; gap: 1rem; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem; }
.transcript-tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border); margin-bottom: 0.5rem; }
.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.tab-btn.active { color: var(--text); border-bottom-color: var(--accent); }
.transcript-pane {
  max-height: 65vh;
  overflow: auto;
  font-size: 0.85rem;
  background: var(--bg);
  padding: 0.5rem;
  border-radius: 4px;
}
.prompt-block, .output-block {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  margin: 0;
}
.critique-block {
  margin-top: 0.75rem;
  padding: 0.5rem;
  background: var(--surface);
  border-left: 3px solid var(--yellow);
  border-radius: 3px;
}
.turn { margin: 0.4rem 0; }
.turn-assistant { padding: 0.4rem; background: var(--surface); border-radius: 3px; }
.turn-tool-result, .turn-tool-use, .turn-mcp { background: var(--surface); padding: 0.3rem 0.5rem; border-radius: 3px; }
.turn-tool-result pre, .turn-tool-use pre, .turn-mcp pre {
  white-space: pre-wrap; word-break: break-word; max-height: 30vh; overflow: auto; margin: 0.3rem 0 0 0;
}
.turn-compaction { color: var(--text-dim); text-align: center; padding: 0.5rem; font-style: italic; }
.mcp-badge {
  display: inline-block;
  background: var(--accent);
  color: var(--bg);
  font-size: 0.65rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  text-transform: uppercase;
  margin-right: 0.3rem;
}
.view-transcript-link { color: var(--accent); font-weight: 500; font-size: 0.85rem; margin-left: 0.5rem; }
.block-text { white-space: pre-wrap; }
```

- [ ] **Step 6: Manual smoke test**

Run: `bun run src/index.ts`
Submit a STANDARD task, click "View transcript" or click the `planned` event in the timeline. Tabs should switch correctly; tool calls should be collapsible.

- [ ] **Step 7: Commit**

```bash
git add src/web/public/dashboard.js src/web/public/index.html src/web/public/styles.css
git commit -m "feat(dashboard): add tabbed transcript drill-down with tool call rendering"
```

---

## Task 18: Dashboard — distinguishable state badge for `awaiting_plan_approval`

**Files:**
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/dashboard.js`

- [ ] **Step 1: Add a CSS rule for the new state**

Append to `src/web/public/styles.css`:

```css
.badge-state[data-state="awaiting_plan_approval"] {
  background: var(--yellow);
  color: var(--bg);
}
.badge-state[data-state="replanning"] {
  background: var(--orange);
  color: var(--bg);
}
```

- [ ] **Step 2: Show plan attempt counter in task list cards**

In `src/web/public/dashboard.js`, modify `renderTaskList` to append a `plan #N` badge when relevant. Replace the line that builds the meta row inside the task card template with:

```js
<div class="task-card-meta">
  <code>${t.id.slice(0, 8)}</code>
  <span>${timeAgo(t.createdAt)}</span>
  ${t.iteration > 0 ? `<span>iteration ${t.iteration}</span>` : ""}
  ${t.state === "awaiting_plan_approval" || t.state === "replanning" ? `<span class="card-plan-badge">plan review</span>` : ""}
</div>
```

Append to `src/web/public/styles.css`:

```css
.card-plan-badge {
  background: var(--yellow);
  color: var(--bg);
  font-size: 0.7rem;
  padding: 0.05rem 0.4rem;
  border-radius: 3px;
  font-weight: 500;
}
```

- [ ] **Step 3: Manual smoke test**

Run the dashboard, submit a STANDARD task, confirm:
- The state badge on the card is yellow (vs green for `awaiting_approval`).
- The card shows a "plan review" pill.

- [ ] **Step 4: Commit**

```bash
git add src/web/public/styles.css src/web/public/dashboard.js
git commit -m "feat(dashboard): distinguish awaiting_plan_approval and replanning visually"
```

---

## Task 19: Final integration test — full critique loop end-to-end

**Files:**
- Modify: `tests/integration/plan-review.test.ts`

- [ ] **Step 1: Add the end-to-end test**

Append to `tests/integration/plan-review.test.ts`:

```ts
describe("end-to-end critique loop", () => {
  test("submit -> critique -> approve -> awaiting_approval", async () => {
    const { service, db } = createTestService();
    const created = await service.submitTask("autoforge", "Build a STANDARD-tier widget");
    expect(created.state).toBe("awaiting_plan_approval");

    await service.critiquePlan(created.id, "be more specific about file paths");
    const afterCritique = service.getTask(created.id)!;
    expect(afterCritique.state).toBe("awaiting_plan_approval");

    const approved = await service.approvePlan(created.id);
    expect(approved.state).toBe("awaiting_approval");

    const transcripts = db.listTranscriptsByTask(created.id);
    expect(transcripts.length).toBe(2);
    expect(transcripts[0].attempt).toBe(0);
    expect(transcripts[1].attempt).toBe(1);

    // Final approval still works.
    const completed = await service.approveTask(created.id);
    expect(completed.state).toBe("completed");
  });
});
```

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: PASS for all unit and integration tests.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/plan-review.test.ts
git commit -m "test: end-to-end critique loop integration test"
```

---

## Task 20: Documentation — update qmd architecture doc

**Files:**
- Modify: `docs/qmd/architecture-overview.md`
- Modify: `docs/qmd/domain-task-orchestration.md`

- [ ] **Step 1: Update the data flow diagram in `architecture-overview.md`**

Find the "Data Flow: Task Submission to PR" section and edit step 2.f (planner) and add a new pause step. Replace the step block from `e. recordEvent("created")` through `f. for each subtask:` with:

```
   e. recordEvent("created")
   f. executor.execute({ type: "planner", model: plannerModel(tier), ... })
        → PlanSubtask[] + transcript (captured)
        → db.insertTranscript(...)
   g. if pausePolicy(tier, opts.reviewPlan):
        transition to "awaiting_plan_approval" → return
        Human inspects plan + transcript via dashboard.
        On approve → continue at step h.
        On critique → re-run planner with original prompt + prior plan + critique
                     (up to PLANNER_MAX_ITERATIONS revisions), back to g.
   h. for each subtask:
```

(Renumber subsequent steps accordingly.)

- [ ] **Step 2: Add a brief paragraph to `domain-task-orchestration.md`**

Add a new section under "States" describing `awaiting_plan_approval` and `replanning`:

```markdown
### Plan-review states

- `awaiting_plan_approval` — Set after the planner completes on STANDARD/THOROUGH tasks
  (or any task submitted with `reviewPlan: true`). Human gate; no in-flight work; exempt
  from the staleness sweeper.
- `replanning` — Transient state during a critique-driven planner re-run. Returns to
  `awaiting_plan_approval` on success, transitions to `failed` on planner error or when
  `PLANNER_MAX_ITERATIONS` is exceeded.

The plan attempt counter (0-indexed internally, displayed 1-indexed) is the row count of
`agent_transcripts` for the task with `stage = 'planner'`. The cap is configurable via
`PLANNER_MAX_ITERATIONS` (default 3 revisions, so up to 4 planner runs total).
```

- [ ] **Step 3: Commit**

```bash
git add docs/qmd/architecture-overview.md docs/qmd/domain-task-orchestration.md
git commit -m "docs(qmd): document plan-review states and transcript capture"
```

---

## Self-review (executed before publishing this plan)

1. **Spec coverage check**

| Spec section | Tasks covering it |
|---|---|
| A. Data capture (table + write path) | T1, T2, T10 (write path) |
| B. New states + events + iteration limit | T8, T10, T11, T12, T13 |
| C. Orchestrator split + new endpoints | T10, T11, T12, T14, T15 |
| D.1 Per-run model override | T4, T5, T10 |
| D.2 QMD MCP wiring | T7 |
| D.3 Transcript capture | T6 |
| D.4 Routing | T9 |
| D.5 Cost visibility | (covered by existing telemetry — no new task needed; called out in spec) |
| E.1 Plan Review Panel | T16 |
| E.2 Step drill-down | T17 |
| E.3 Task list badge | T18 |

No spec gaps.

2. **Placeholder scan:** No "TBD", no "etc.", no "implement appropriately." Every code step contains real code; every test step shows assertions.

3. **Type consistency:** `AgentTranscriptInput` / `AgentTranscriptRow` / `AgentTranscriptMeta` are defined in T2 and used consistently in T10, T15. `runPlannerAttempt` signature in T10 matches its call sites in T12. `pausePolicy` and `plannerModel` defined in T10 are referenced in T10 only. `_testCreate` hook is added in T5 and reused in T6 and T7.

4. **Known cross-file change risks:**
- The state-machine type widening in T8 may surface exhaustive-switch errors elsewhere. If `bun test` after T8 reveals any, add a targeted fix in T8 step 6 before committing.
- The events route may need to JSON-parse `payload` (T17 step 3 handles this client-side rather than touching the API to keep blast radius small).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-step-inspector-planner.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task; review between tasks; fast iteration with isolated context per task.

**2. Inline Execution** — Execute tasks in this session using executing-plans; batch execution with checkpoints for human review.

**Which approach?**
