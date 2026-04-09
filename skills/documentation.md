# skill: documentation

## Version
v1.0 — 2026-04-09

## When to Activate
Always active for doc agents.

## Instructions

Generate a markdown document in `docs/features/` describing what was built.

### Required Sections

```markdown
# Feature: <name>

## What was built
One paragraph. What does this feature do from the user's perspective?

## Why
One paragraph. What problem does it solve? Why was it built now?

## Key decisions
Bullet list of non-obvious choices made during implementation.
For each: what was chosen, what the alternative was, and why this one won.

## Gotchas
Things the next developer needs to know. Surprises. Edge cases.
Leave this empty if there are genuinely none.

## Related
Links to related docs, PRs, or issues.
```

### Rules

- Write for the next developer, not for the person who built it.
- No implementation details that are obvious from reading the code.
- No claims about future plans or "could be extended to...".
- Every gotcha must be concrete and actionable.

## Anti-Patterns

- Generic documentation that could apply to any feature.
- Describing HOW the code works instead of WHY decisions were made.
- Leaving sections empty without explanation.
