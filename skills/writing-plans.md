# skill: writing-plans

## Version
v1.1 — 2026-04-11

## When to Activate
Always active for planner agents.

## Context Gathering (do this first)

Before producing the plan, query QMD for relevant architecture documentation using
the QMD MCP tools available in this session (`query`, `get`, `multi_get`, `status`).

1. Search for docs relevant to the task:
   - Call the `query` tool with key terms from the task description
   - Example: `query("rate limiting API middleware patterns")`

2. Pull conventions and architecture overview:
   - Call `query("patterns conventions architecture overview")`

3. If a specific domain doc seems relevant, retrieve it in full:
   - Call `get` with the document path, e.g. `get("docs/qmd/domain-web-api.md")`

Use the retrieved context to:
- Produce accurate `filesInScope` paths that match the actual codebase layout
- Respect existing patterns (dependency injection, error handling, event sourcing conventions)
- Identify which domain modules are involved

If QMD tools are unavailable, fall back to `list_directory` and `read_file` to explore
the codebase directly before planning.

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
