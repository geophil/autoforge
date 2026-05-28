# skill: two-stage-review

## Version
v1.0 — 2026-04-09

## When to Activate
Always active for reviewer agents.

## Instructions

Conduct the review in two distinct stages. Write findings as structured JSON in `.autoforge-status.json`.

### Stage 1: Spec Compliance

Read the task description and test criteria. For each criterion:
- Does the implementation satisfy it?
- Is there a test that proves it?
- Are edge cases covered?

Flag any gap as a finding.

### Stage 2: Refactor Safety And Verification

When the task is a refactor, cleanup, restructure, simplification, extraction,
consolidation, migration of internals, or maintainability change:

- Confirm observable behavior is preserved unless the plan explicitly asked for
  behavior changes.
- Check public APIs, routes, event payloads, data shapes, migrations, and call
  sites touched by the change.
- Check that verification commands prove the changed path, not just unrelated
  behavior.
- Flag accidental behavior changes, unproven equivalence, and drive-by cleanup
  as findings before reviewing style.

### Stage 3: Code Quality

Review the code for:
- **Correctness** — Does it handle error cases, nulls, edge inputs?
- **Readability** — Are names clear? Is the logic obvious?
- **Simplicity** — Is there anything unnecessary? Could it be simpler?
- **Security** — Any injection risks, unvalidated inputs, secret exposure?

### Finding Categories

Prefer specific categories that make later lessons and reward views useful:

- `behavior_regression` — unexpected observable behavior change
- `verification_gap` — tests or checks do not prove the requested behavior
- `scope_drift` — changed files or behavior outside the plan
- `api_compatibility` — public API, route, event payload, data shape, or migration risk
- `refactor_safety` — refactor mixes behavior changes, is too broad, or is hard to prove safe
- `context_grounding` — conflicts with repo conventions or QMD-backed architecture guidance
- `security` — credential, auth, injection, access-control, or data-exposure risk

Use existing categories such as `correctness`, `maintainability`, or
`error_handling` when they are more precise.

### Severity Classification

- **CRITICAL** — Will cause production failure or security breach. Blocks merge.
- **MAJOR** — Wrong behaviour, missing error handling, test gaps. Must fix.
- **MINOR** — Style, naming, mild inefficiency. Log only.
- **NITPICK** — Subjective preferences. Ignore.

### Output Format

Write `.autoforge-status.json` with this structure:

```json
{
  "status": "DONE",
  "artifacts": [],
  "output": {
    "findings": [
      {
        "severity": "MAJOR",
        "category": "error_handling",
        "description": "getUserById does not handle null return from database",
        "filePath": "src/users.ts"
      }
    ]
  }
}
```

If there are no CRITICAL or MAJOR findings, set status to "DONE". If there are, set it to "DONE_WITH_CONCERNS" and list concerns.

## Anti-Patterns

- Flagging nitpicks as CRITICAL.
- Missing security issues because "it's probably fine".
- Reviewing style when spec compliance is not yet confirmed.
- Reviewing style before refactor safety and verification sufficiency when the task is a refactor.
- Treating a broad passing suite as sufficient when targeted behavior-preservation checks were skipped.
- Writing vague findings ("this could be better") — every finding needs a specific description and file path.
