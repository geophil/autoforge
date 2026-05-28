# Cost Optimization V2 PR-Sized Development Plan

## Summary

Turn the V2 roadmap into independently mergeable PRs. Each PR preserves external behavior, adds focused tests, and records evidence before the next layer builds on it. Adaptive routing stays out until runtime structure, prompt-cache discipline, and telemetry are stable.

## PR Units

- PR 1: Runtime Controls Extraction
  - Add `RuntimeControls` to compose `RunBudget`, `AgentRunGuardrails`, `ToolResultShaper`, and runtime config.
  - Keep `HarnessExecutor` as coordinator.
  - Verify existing timeout, final-reserve, context guardrail, and tool-shaping tests still pass.

- PR 2: MCP/QMD Adapter Extraction
  - Add `McpToolAdapter` for setup, tool listing, QMD call timeout, result text extraction, allowance accounting inputs, and close safety.
  - Keep QMD tool behavior and telemetry equivalent.
  - Test setup success/error/timeout, call success/error/timeout, and close on early return.

- PR 3: Unified Tool Execution Outcome
  - Add `ToolExecutionOutcome` for local tools, QMD tools, guardrail blocks, and recoverable errors.
  - Route shaping and telemetry through the normalized outcome.
  - Test local success/error, QMD success/error, guardrail block, unknown tool, and timeout-like failures.

- PR 4: Prompt Envelope Foundation
  - Add `PromptEnvelope` with `stablePrefix`, `dynamicContext`, `stablePrefixVersion`, and `stablePrefixHash`.
  - Keep rendered prompt semantics equivalent while keeping volatile task context out of the stable hash.
  - Stable prefix includes persona, stable skills, harness/tool protocol, safety rules, and status/output contract.
  - Dynamic context includes task text, steering, retrieved content, compact state, tool results, errors, diffs, timestamps, run IDs, workspace IDs, and task-derived lessons.
  - Test stable hash determinism and volatile-data exclusion.

- PR 5: Provider Cache Adapter Discipline
  - Extend `ModelProvider.message` input to support structured prompt sections/cache hints.
  - Update `AnthropicProvider` to cache only stable system blocks.
  - Remove default cache marking from first user/task message.
  - Non-cache providers ignore hints without changing content.
  - Test Anthropic params and normalized cache read/create usage.

- PR 6: Runtime Telemetry Summary Builder
  - Add compact summary helpers from `AgentResult.metrics.telemetry`.
  - Include model/tool counts, token totals, cached tokens, cache creation tokens, cache hit ratio, stable-prefix hash/version, QMD usage, max history chars, tool bytes, failure subtype counts, final status, and estimated cached-input savings when pricing supports it.
  - Keep raw events only in `.autoforge/telemetry.json`.
  - Test summaries from representative success, failure, timeout, and cache-hit ledgers.

- PR 7: Durable Dispatch Telemetry Events
  - Emit `agent_runtime_telemetry` after planner/coder/reviewer/doc dispatches.
  - Store compact payloads in existing `events.payload`; no DB migration by default.
  - Include executor, model, routed tier when available, agent type, phase/stage, and telemetry summary.
  - Test event emission for successful and failed/timeout dispatches.

- PR 8: Reporting/KPI Query Helpers
  - Add query/helper support for repeated stable-prefix hashes, cached-token ratio, estimated cached-input savings, max history chars, and tool-output contribution.
  - Keep dashboard UI optional.
  - Test helper output from stored event payloads.

- PR 9: Canonical Roadmap Documentation
  - Create `docs/qmd/model-cost-efficiency-v2.md` as the canonical roadmap.
  - Link it from agent execution docs or the relevant QMD index.
  - Keep this file as the development plan.

## Acceptance Tests

- Run `bun run lint`.
- Run focused runtime tests for harness, Anthropic provider, telemetry, QMD/MCP, guardrails, and prompt envelopes.
- Run orchestrator tests covering planner/coder/reviewer/doc telemetry emission.
- Run existing plan-review and awaiting-intervention integration tests.
- Confirm no task behavior changes except corrected cache annotation placement.

## Assumptions

- PR-sized units are the desired implementation granularity.
- Behavior preservation is required through PR 8.
- Lessons are dynamic unless later proven stable for a given prefix key.
- Prompt caching is an optimization only; cache misses must not alter correctness.
- Adaptive routing, semantic retrieval, summarization policy, dashboards, and cost caps remain post-foundation backlog.
