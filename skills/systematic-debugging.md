# skill: systematic-debugging

## Version
v1.0 — 2026-04-09

## When to Activate
When any test fails, any unexpected error occurs, or behaviour does not match the spec.

## Instructions

Work through failures in this exact order. Do not skip steps.

1. **Reproduce** — Run the failing test in isolation. Confirm you can reproduce it consistently.

2. **Read the error** — Read the full error message and stack trace. Do not guess. The error tells you what actually happened.

3. **State your hypothesis** — In one sentence, write down what you think is wrong and why, based only on the error. No assumptions.

4. **Isolate** — Narrow the failing scope to the smallest unit possible. Add a temporary failing assertion to confirm your hypothesis.

5. **Root cause** — Identify the exact line or logic that is wrong. Do not fix symptoms; fix causes.

6. **Fix** — Make the minimal change that fixes the root cause. Re-run the test. If it still fails, return to step 2.

7. **Verify the suite** — Run the full test suite. If other tests break, treat each as a new debugging session starting at step 1.

## Anti-Patterns

- Changing multiple things at once to "see if it fixes it".
- Guessing without reading the error.
- Adding workarounds (try/catch that swallows errors, special-case conditions) instead of fixing the root cause.
- Declaring victory before running the full suite.

## Metrics
- Each debugging session should resolve the issue within the allocated budget.
- If you cannot resolve after 3 root-cause hypotheses, report BLOCKED with a detailed explanation.
