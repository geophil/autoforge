# skill: tdd

## Version
v1.0 — 2026-04-09

## When to Activate
Always active for coder agents. No exceptions.

## Instructions

Follow the RED → GREEN → REFACTOR cycle for every piece of new behaviour:

1. **RED** — Write a failing test first. Run it and confirm it fails for the right reason. Never write production code before you have a failing test.

2. **GREEN** — Write the minimal code needed to make the test pass. Do not add anything that the test does not require.

3. **REFACTOR** — Clean up the code and tests without changing behaviour. Re-run tests after every change.

### Rules

- If you cannot figure out how to test something, treat that as a design smell. Redesign the interface until it is testable.
- Tests must be deterministic. No sleep() calls, no network calls, no filesystem side effects that aren't cleaned up.
- One logical assertion per test. Test names describe the expected behaviour, not the implementation.
- After REFACTOR, run the full test suite. All tests must pass before you report DONE.

## Anti-Patterns

- Writing production code before the test (RED step skipped).
- Marking a task DONE when any test is red.
- Writing a test that passes on the first run without first seeing it fail.
- Over-engineering during GREEN — minimal code only.

## Metrics
- test_pass_rate: must be 1.0 (100%) before any DONE status.
