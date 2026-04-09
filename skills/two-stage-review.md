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

### Stage 2: Code Quality

Review the code for:
- **Correctness** — Does it handle error cases, nulls, edge inputs?
- **Readability** — Are names clear? Is the logic obvious?
- **Simplicity** — Is there anything unnecessary? Could it be simpler?
- **Security** — Any injection risks, unvalidated inputs, secret exposure?

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
- Writing vague findings ("this could be better") — every finding needs a specific description and file path.
