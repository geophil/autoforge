# skill: writing-plans

## Version
v1.0 — 2026-04-09

## When to Activate
Always active for planner agents.

## Instructions

Produce a concrete implementation plan decomposed into subtasks. Output valid JSON only — no prose outside the JSON.

### Plan Structure

```json
{
  "subtasks": [
    {
      "id": "subtask-1",
      "sequence": 1,
      "description": "Clear imperative description of what to implement",
      "filesInScope": ["src/feature.ts", "src/feature.test.ts"],
      "dependencies": [],
      "testCriteria": [
        "Given X input, returns Y output",
        "Given invalid input, throws Z error"
      ]
    }
  ]
}
```

### Rules

- Every subtask has at least one test criterion. Criteria are observable, not vague.
- `filesInScope` lists every file the coder agent is allowed to touch. Be specific.
- `dependencies` lists IDs of subtasks that must complete first. Sequential by default.
- Subtask descriptions are imperative: "Add rate limiting to POST /api/tasks", not "Rate limiting".
- Keep subtasks small: each should fit within the coder budget window.
- Do not plan more than 15 subtasks for any tier. If the feature is larger, escalate.

### Tier Guidelines

- **EXPRESS**: 1–3 subtasks, no brainstorming step.
- **STANDARD**: 3–8 subtasks, single refinement pass.
- **THOROUGH**: 5–15 subtasks, explicit alternatives considered.

## Anti-Patterns

- Vague test criteria ("tests pass", "works correctly").
- Subtasks that span too many files (hard to review, hard to isolate failures).
- Missing dependencies (parallel execution of dependent tasks causes conflicts).
- Planning for "future extensibility" — only plan what the current request requires.
