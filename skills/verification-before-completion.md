# skill: verification-before-completion

## Version
v1.0 — 2026-04-09

## When to Activate
Always — immediately before writing the .autoforge-status.json file.

## Instructions

Before reporting DONE, run through this checklist. Each item must be true:

1. **Tests pass** — Run the test suite. All tests green. Zero failures, zero errors.

2. **Spec criteria met** — Re-read the task description and every test criterion in the subtask definition. For each criterion, confirm there is a test that covers it and it passes.

3. **Refactor safety proven when relevant** — If the subtask is a refactor, cleanup, restructure, extraction, consolidation, or maintainability change, confirm observable behavior is preserved unless the subtask explicitly asked for behavior changes. Check public APIs, routes, event payloads, data shapes, and call sites touched by the refactor. If equivalence is not proven, report `DONE_WITH_CONCERNS` with the verification gap.

4. **Verification is targeted** — Run the narrow checks named by the subtask when available. For shared or high-risk refactors, also run the broader suite or typecheck requested by the plan.

5. **Files in scope only** — Review the files you modified. Every modified file must be listed in `filesInScope`. If you needed to touch a file outside scope, add it to the artifacts list and note it in concerns.

6. **No leftover debug code** — Search for console.log, TODO, FIXME, debugger, print statements. Remove or resolve each one.

7. **Imports clean** — No unused imports. No imports of packages not in the project dependencies.

8. **Status file written** — Write `.autoforge-status.json` with accurate status and artifact paths.

## Anti-Patterns

- Reporting DONE without running tests.
- Skipping spec criteria that seem "obvious".
- Reporting a refactor as DONE when behavior preservation was not checked.
- Treating a broad "tests pass" result as enough when the subtask named a narrower behavior-preservation check that was skipped.
- Forgetting to write the status file.
- Listing files in artifacts that were not actually modified.

## Metrics
- A DONE report that later fails review is a verification failure.
