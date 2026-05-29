# Model Cost Efficiency V2

## Purpose

Model Cost Efficiency V2 makes agent cost optimization measurable before it makes routing more aggressive. The foundation is composable runtime structure, stable prompt-prefix/cache discipline, shared model selection, low-cost utility LLM calls, durable runtime telemetry, and queryable KPI helpers. Adaptive routing, semantic retrieval, phase-triggered compaction, dashboards, and cost caps remain later work until the foundation produces reliable evidence.

This is the canonical roadmap. The PR-sized implementation plan lives in `docs/superpowers/plans/Cost optimization V2 PLAN.md`.

## Foundation Principles

- Preserve task behavior while changing runtime internals.
- Keep `HarnessExecutor` as the coordinator and move focused runtime behavior into composable components.
- Treat prompt caching as an adapter-level optimization. Cache misses must not affect correctness.
- Treat utility LLM calls as bounded, non-mutating work that defaults to the cheapest configured model.
- Put long-lived prompt material before dynamic task context, and version/hash only the stable prefix.
- Keep raw model/tool telemetry in `.autoforge/telemetry.json`; store compact dispatch summaries in durable events.
- Use existing JSON event payload storage unless query needs prove a schema migration is worth the cost.

## Implemented Foundation

### Runtime Composition

The harness runtime now uses focused components:

- `RuntimeControls` composes `RunBudget`, `AgentRunGuardrails`, `ToolResultShaper`, and runtime config.
- `McpToolAdapter` owns QMD/MCP setup, tool listing, call timeout handling, result text extraction, allowance accounting inputs, and close safety.
- `ToolExecutionOutcome` normalizes local tools, QMD tools, guardrail blocks, unknown tools, recoverable errors, and timeout-like failures.
- `PromptEnvelope` separates stable prefix sections from dynamic context.
- `model-selection` centralizes tier lookup for agent dispatches and cheap-first utility purpose selection.
- `UtilityModelCaller` reuses `ModelProvider` for no-tool utility calls such as compaction.
- `ConversationHistory` and `HistoryCompactor` keep long sessions under context guardrails by compacting older complete exchange groups.

The executor loop remains responsible for orchestration: provider calls, tool turns, status finalization, telemetry writing, and timeout handling.

### Stable Prompt Prefixes

`PromptEnvelope` renders stable sections before dynamic sections and records:

- `stablePrefixVersion`
- `stablePrefixHash`
- stable sections with cache hints for providers that support them

Stable sections include persona content, stable skill files, harness/tool protocol, safety rules, and status/output contract. Dynamic sections include task text, steering, retrieved content, lessons, compact state, tool results, errors, diffs, timestamps, run IDs, workspace IDs, and other volatile task context.

Provider adapters receive structured prompt sections and cache hints. Anthropic applies cache controls only to stable system blocks; non-cache providers ignore hints without changing rendered content.

### Shared Model Selection And Utility Calls

Agent dispatch routing remains risk-sensitive: planner, coder, reviewer, and doc work use `standard` by default and escalate to `strong` for sensitive areas or repeated failures. Utility calls are selected separately by use case and purpose, default to `cheap`, and never receive tools.

Utility purpose overrides are supported through `HARNESS_COMPACTION_MODEL`, `HARNESS_SUMMARIZATION_MODEL`, `HARNESS_CLASSIFICATION_MODEL`, and `HARNESS_EXTRACTION_MODEL`. Fallback order is purpose override, then `MODEL_TIER_CHEAP`, then `claude-3-haiku-20240307`. Purpose-specific timeout and max-token budgets keep these calls bounded.

### Threshold History Compaction

The harness compacts conversation history when serialized history reaches 75% of `HARNESS_CONTEXT_MAX_CHARS`. It preserves the latest six history messages verbatim, compacts only older complete assistant/tool-result exchange groups, stores dropped raw history under `.autoforge/history-compactions/`, and inserts a structured compact memory block into the remaining history.

LLM-assisted compaction uses `UtilityModelPurpose = "compaction"` and the selected cheap utility model. If the provider errors, times out, or returns invalid JSON, the runtime falls back to deterministic extractive memory and continues the agent run.

### Runtime Telemetry

`buildRuntimeTelemetrySummary()` turns `AgentResult.metrics.telemetry` into compact summary fields suitable for event payloads:

- model/tool counts by provider/model/name/status
- token totals, cached tokens, cache creation tokens, cache hit ratio
- estimated cached-input savings when model pricing is known
- stable-prefix hash/version
- QMD call count, elapsed time, and allowance usage
- raw, returned-to-model, artifact, and summary tool-output bytes
- max history/transcript chars
- utility and compaction counts, fallback count, compaction tokens/cost, and before/after history chars
- failure subtype counts
- final status

Raw telemetry events stay in `.autoforge/telemetry.json`.

### Durable Dispatch Events

Planner, coder, reviewer, and doc dispatches emit `agent_runtime_telemetry` after the routed execution completes. The payload combines the runtime summary with dispatch context:

- executor
- model
- routed tier
- task tier
- agent type
- phase
- files in scope

These events are stored in the existing `events.payload` JSON column. No migration is required for the V2 foundation.

### Reporting Helpers

Runtime cache KPI helpers read stored `agent_runtime_telemetry` payloads and compute:

- repeated stable-prefix hashes
- cached-input-token ratio
- estimated cached-input savings
- max history chars
- tool-output contribution
- per-stable-prefix aggregate rows for repeated hashes

The web metrics route exposes this through `GET /api/metrics/:projectId/runtime-cache-kpis`. Dashboard UI remains optional.

## Current KPI Surfaces

### Runtime Cache KPI Query

`buildRuntimeCacheKpiProjectQuery(projectId, windowDays)` selects compact runtime telemetry payload fields from `events`.

It prefers nested `payload.toolOutputBytes.returnedToModel` and falls back to legacy `payload.returnedToolOutputBytes`, so older and newer telemetry payloads can be compared in the same report window.

### Runtime Cache KPI Report

`computeRuntimeCacheKpiReport(rows)` returns:

- `summary`: aggregate cache and tool-output KPIs across rows
- `stablePrefixes`: repeated stable-prefix aggregates sorted by occurrences, cache ratio, input tokens, and hash

## Success Measures

- Prompt-cache hit ratio improves for repeated dispatches with the same persona, stable skills, tool protocol, and status contract.
- Repeated input-token cost drops without reducing task success rate.
- `agent_runtime_telemetry` can explain token/cost totals, cache behavior, QMD usage, tool-output contribution, and failure subtype counts.
- Runtime cache KPI reports show repeated stable-prefix hashes and estimated cached-input savings.
- Future routing or cost-policy changes use durable dispatch evidence instead of ad hoc assumptions.

## Backlog After Foundation

- Adaptive model routing based on observed telemetry, not static heuristics alone.
- Semantic retrieval policy for choosing stable versus dynamic context.
- Phase-triggered compaction and richer summarization policy for repeated tool output.
- Dashboard UI for runtime cache KPIs.
- Per-project or per-tier cost caps with intervention behavior.
- Provider-specific cache controls beyond Anthropic if other providers expose compatible APIs.
