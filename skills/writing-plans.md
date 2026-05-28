# skill: writing-plans

## Version

v2.0 — 2026-05-11

## When to Activate

Always active for planner agents.

## Phase contract

Every planner prompt begins with a `## Phase` block. The phase is the orchestrator's source of truth; treat the value as a directive.

| Phase | Emit | Notes |
|-------|------|-------|
| `spec` | `discovery` + `spec` (+ optional `blockingQuestion`) | Pauses at `awaiting_spec_approval`. **Do not emit `subtasks`.** |
| `execution_plan` | `subtasks` | Prompt may include `## Approved Spec` — align every subtask to it. |
| `combined` | `discovery` + `spec` + `subtasks` | Single-shot path when `reviewPlan: false`. |

Your self-reported `planningPhase` in the JSON is informational; the parser trusts payload shape, not the self-report.

## Context Gathering (do this first)

Before producing the artifact, query QMD for relevant architecture documentation using the QMD MCP tools (`query`, `get`, `multi_get`, `status`).

1. **Search for docs relevant to the task** — `query("rate limiting API middleware patterns")`.
2. **Pull conventions and architecture overview** — `query("patterns conventions architecture overview")`.
3. **Retrieve domain docs in full when relevant** — `get("docs/qmd/domain-web-api.md")`.

Use the retrieved context to:

- Produce accurate `filesInScope` paths that match the actual layout (execution-plan/combined phase).
- Anchor `spec.acceptanceCriteria` and `spec.verification` on QMD-backed conventions (spec/combined phase).
- Respect existing patterns (DI, error handling, event sourcing).

If QMD tools are unavailable, fall back to `list_directory` and `read_file`, and record that fallback explicitly in `planningContext.qmdContext`.

When `QMD_MCP_URL` is configured, QMD-backed context is required. Planner outputs that omit usable `planningContext.qmdContext` evidence are rejected and the task is paused at `awaiting_intervention`.

## Output Contract (`.autoforge-status.json`)

Top-level fields the orchestrator consumes:

| Field | Type | When |
|-------|------|------|
| `status` | `"DONE"` | required |
| `artifacts` | `string[]` | required (often `[]`) |
| `discovery` | object (see below) | `spec` / `combined` |
| `spec` | object (see below) | `spec` / `combined` |
| `subtasks` | array (see below) | `execution_plan` / `combined` |
| `blockingQuestion` | `string \| null` | optional, `spec` phase only |
| `planningContext` | object | required |

### `discovery` shape

```json
{
  "intent": "One sentence: what is the goal in plain language?",
  "constraints": ["External limits the design must respect"],
  "assumptions": ["What we are taking on faith — call them out so they can be challenged"],
  "decisions": [
    {
      "decision": "What we are choosing to do",
      "reason": "Why this beats the alternatives",
      "alternativesRejected": ["Other option A — reason rejected", "Other option B — reason rejected"],
      "consequence": "What this commits us to downstream"
    }
  ],
  "nonGoals": ["Things explicitly out of scope so reviewers do not chase them"],
  "openQuestions": ["Anything still unresolved but not blocking"]
}
```

### `spec` shape

```json
{
  "problem": "One paragraph framing the problem in user / system terms (not implementation)",
  "desiredBehavior": ["Observable behaviors the system must exhibit"],
  "acceptanceCriteria": ["Verifiable pass/fail statements a reviewer can check"],
  "verification": ["How acceptance will be confirmed (tests, manual checks, metrics)"],
  "risks": ["Things that could go wrong and how we will mitigate"]
}
```

### `subtasks` shape

```json
[
  {
    "id": "<taskId>-subtask-1",
    "sequence": 1,
    "description": "Imperative: 'Add rate limiting to POST /api/tasks'",
    "agentType": "coder",
    "filesInScope": ["src/routes/tasks.ts", "src/middleware/rate-limit.ts"],
    "dependencies": [],
    "testCriteria": [
      "POST /api/tasks returns 429 after 100 requests/min from one IP",
      "Existing unit tests still pass"
    ]
  }
]
```

`agentType` ∈ `{coder, reviewer, doc, doc-review}`. Default to `coder`. `dependencies` lists ids of subtasks that must complete first — sequential by default.

### `blockingQuestion`

A single focused question for the operator. Use only in `spec` phase. The orchestrator persists it on the task projection as `currentBlockingQuestion`, surfaces it in the dashboard as "Answer this question", and routes the operator's reply back to you on the next attempt prefixed with `## Operator Answer To Question`. Multi-question batching is **not** supported in v1.

### `planningContext` shape

```json
{
  "specRevision": 1,
  "planRevision": 0,
  "approvalMode": null,
  "reviewedAt": null,
  "qmdContext": {
    "status": "used",
    "phase": "spec",
    "queries": ["task orchestration spec approval flow"],
    "documents": ["docs/qmd/domain-task-orchestration.md"],
    "fallbackReason": null
  }
}
```

`qmdContext.status`:
- `"used"`: QMD tools were used and `queries` or `documents` is non-empty.
- `"fallback"`: QMD was unavailable; include `fallbackReason` and leave retrieval evidence in `queries`/`documents` if any.

## Tier rules (enforceable)

These are not soft guidance. The orchestrator records `planner_phase_mismatch` warnings when output shape contradicts the requested phase, but quality-bar enforcement on the spec body lives here.

### `EXPRESS`

- Spec phase is skipped by the orchestrator — you will only see `execution_plan` or `combined`.
- For `combined`: a minimal `spec.problem` + `spec.acceptanceCriteria` is sufficient. `discovery.decisions` and `discovery.openQuestions` may be empty arrays.
- Subtasks: 1–3, no `blockingQuestion`, no over-decomposition.

### `STANDARD`

- Spec output requires:
  - non-empty `spec.problem`
  - `spec.desiredBehavior` ≥ 2 items
  - `spec.acceptanceCriteria` ≥ 2 items
  - non-empty `spec.verification`
- `discovery.decisions` is optional — populate when a real trade-off exists.
- Use `blockingQuestion` **only** when a decision is unrecoverable without operator input.
- Subtasks: 3–8.

### `THOROUGH`

- Everything `STANDARD` requires, plus:
  - `discovery.decisions` must contain ≥ 1 entry with non-empty `alternativesRejected`.
  - Prefer one focused `blockingQuestion` per attempt when real ambiguity exists, rather than guessing.
- Subtasks: 5-15 with explicit alternatives considered. If the feature is larger, escalate via `blockingQuestion`.

## Refactoring tasks

Treat a task as refactoring work when the request asks to refactor, clean up,
restructure, simplify, extract, consolidate, migrate internals, reduce
duplication, improve maintainability, or reorganize code without an explicit
behavior change.

For refactoring tasks, encode safety using the existing contract fields. Do not
invent new JSON fields.

In `discovery`:

- Put the refactor type in `constraints`: mechanical, structural,
  API-preserving design cleanup, migration-assisted, or behavior-changing
  follow-up.
- Put forbidden opportunistic cleanup in `nonGoals`.
- Use `decisions` when choosing between a local cleanup and a broader design
  change.

In `spec`:

- Put behavior invariants in `desiredBehavior` and `acceptanceCriteria`.
- Put public API, data shape, event payload, route, CLI, or migration
  compatibility expectations in `acceptanceCriteria`.
- Put regression risks and mitigation in `risks`.
- Put a verification rationale in `verification`: explain why the selected
  checks prove behavior preservation, not just that "tests pass."

In each refactoring subtask:

- `description` must say what is being preserved as well as what is being
  changed.
- `filesInScope` must be narrow enough to prevent drive-by cleanup.
- `verificationCommands` must prefer targeted checks when available, then add a
  broader suite when risk justifies it.
- `testCriteria` must include at least one behavior-preservation criterion.
- `completionEvidence` must name the proof expected from the coder, such as
  targeted test output, typecheck output, unchanged public API shape, or a note
  that no behavior-bearing tests exist.

Do not classify a behavior-changing feature as a pure refactor. If the requested
change intentionally changes behavior, state that explicitly in the spec and
make the changed behavior part of the acceptance criteria.

## Rules (apply across phases)

- Every subtask has ≥ 1 observable test criterion. No "tests pass" / "works correctly".
- `filesInScope` is specific — the coder may not touch anything outside it.
- `dependencies` is honest — parallel execution of dependent subtasks causes conflicts.
- Subtask descriptions are imperative ("Add rate limiting to POST /api/tasks", not "Rate limiting").
- Keep subtasks small enough to fit within the coder budget window.
- Do not plan for "future extensibility" — only what the current request requires.
- Never exceed 15 subtasks for any tier. Escalate if the work is larger.
- Always emit `planningContext.qmdContext`. If QMD is configured, `status` must be `"used"` with non-empty `queries` or `documents`.

## Anti-patterns

- Emitting `subtasks` during `spec` phase. The orchestrator drops them and asks for clarification.
- Emitting `discovery`/`spec` during `execution_plan` phase. Pauses the task at `awaiting_intervention` — slow and noisy.
- Silent guessing on `THOROUGH`. One `blockingQuestion` is cheaper than a re-plan cycle.
- Vague acceptance criteria ("works correctly"). Always tie criteria to observable behavior.
- Restating approved-spec content inside subtask descriptions. Reference it implicitly via aligned test criteria.
- Adding `planningPhase` and expecting the orchestrator to trust it. The parser trusts payload shape.
