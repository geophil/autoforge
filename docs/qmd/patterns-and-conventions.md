# Patterns and Conventions

How this codebase is structured so new code fits in. Autoforge is a TypeScript ESM project running on Bun.

## File Organization

```
src/
  assessment/   — complexity scoring and tier routing (pure functions)
  config/       — env parsing (Zod), project config constants
  db/           — SQLite client, schema, projection logic
  executors/    — AgentExecutor interface + implementations
  git/          — git worktree management
  nats/         — NATS client, stream definitions, message types
  orchestrator/ — OrchestratorService, state machine, recovery
  privileged/   — GitHub PR operations, test runner (hold credentials)
  skills/       — SkillRegistry (reads from ../skills/*.md)
  types/        — canonical domain types shared across modules
  web/          — Hono server, route factories, SSE hub
  index.ts      — startup wiring (no business logic)
```

**Rule**: Business logic lives in `src/orchestrator/service.ts`. New feature code goes there or in a dedicated `src/{domain}/` directory. `src/index.ts` only wires dependencies and starts the server.

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `state-machine.ts`, `claude-code.ts` |
| Classes | PascalCase | `OrchestratorService`, `WorktreeManager` |
| Functions | camelCase | `assessComplexity()`, `routeTier()` |
| Interfaces | PascalCase | `AgentExecutor`, `PipelineTask` |
| Types | PascalCase | `TaskStage`, `Tier` |
| Constants | UPPER_SNAKE | `MAX_TOOL_ITERATIONS`, `STATUS_FILE` |
| DB columns | snake_case | `task_id`, `event_type`, `budget_seconds` |
| TS fields | camelCase | `taskId`, `eventType`, `budgetSeconds` |
| NATS subjects | `autoforge.{stream}.{projectId}.{taskId}.{event}` | `autoforge.task.proj1.abc.state.executing` |
| Git branches | `autoforge/{taskId}` | `autoforge/f3e2d1c0` |

## Dependency Injection Pattern

`OrchestratorService` receives all dependencies via a `ServiceDeps` interface. This makes it fully testable without mocking globals.

```typescript
// src/orchestrator/service.ts
interface ServiceDeps {
  env: AppEnv;
  db: DbClient;
  executor: AgentExecutor;
  worktrees: WorktreeManager;
  nats?: NatsClient;
  testRunner?: (workingDirectory: string, projectId: string) => Promise<{ passRate: number; output: string }>;
  prCreator?: (payload: PrPayload) => Promise<string>;
}
```

Optional `testRunner` and `prCreator` overrides allow integration tests to inject stubs without changing production code.

## Error Handling Pattern

**Internal errors throw**. The orchestrator uses `throw new Error(...)` for invariant violations. HTTP routes let Hono's default error handler catch unhandled throws (returns 500).

**Agent failures are status values, not exceptions**. `AgentResult.status` is `"FAILED"` or `"TIMEOUT"` — not a thrown error. The orchestrator checks `isSuccess(status)` and transitions the task to `failed` state.

```typescript
// src/orchestrator/service.ts
function isSuccess(status: SubtaskReportStatus | "FAILED" | "TIMEOUT"): boolean {
  return status === "DONE" || status === "DONE_WITH_CONCERNS";
}
```

**External CLI failures are caught and wrapped**. `spawnSync` results are checked for non-zero exit codes; errors are re-thrown as `Error` with the stderr output.

**NATS errors are warnings, never crashes**. All NATS operations use `.catch((err) => console.warn(...))` patterns.

## Zod Validation at System Boundaries

All external inputs (HTTP request bodies, environment variables) are validated with Zod schemas at the entry point. Internal function calls between services do not re-validate.

```typescript
// src/web/routes/tasks.ts — HTTP boundary
const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  description: z.string().min(1)
});
const body = CreateTaskSchema.parse(await ctx.req.json());

// src/config/env.ts — environment boundary
export function loadEnv(rawEnv = process.env): AppEnv {
  return EnvSchema.parse(rawEnv);
}
```

## Testing Approach

**Test files**: `tests/unit/` for pure logic, `tests/integration/` for full pipeline flows. Helper factories in `tests/helpers/`.

**Test runner**: `bun test`. Run all: `bun test`. Run specific: `bun test tests/unit/state-machine.test.ts`.

**Integration tests inject stubs** via the `ServiceDeps` interface (`testRunner`, `prCreator`, `executor: new MockExecutor()`). They do not mock the database — they use a real in-memory SQLite instance.

**Unit tests** cover pure functions directly: state machine transitions, PR gate evaluation, message parsing, tier routing.

## SQLite Projection Pattern

The database uses an event-sourced projection model. `applyEventProjection` is a pure function (given the DB handle and a message, it upserts). This means:

1. Event projection is idempotent — replaying the same event twice is safe due to `INSERT OR REPLACE` and `COALESCE` patterns.
2. The projection function is the single place that knows how events map to table rows — don't scatter SQL into service code.
3. All reads go through typed `DbClient` methods that deserialize JSON columns back to TypeScript types.

## Privileged Operations Pattern

Operations requiring secrets or external system access live in `src/privileged/`. These functions:
- Are called only from the orchestrator process
- Never pass credentials to agent executors
- Gracefully degrade if `GITHUB_TOKEN` is absent or `gh` is unavailable

This boundary is conceptual (not enforced by the TypeScript module system), but it clearly signals to future contributors: "if you're touching GitHub or running tests, it goes here."
