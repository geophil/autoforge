# Model Cost Efficiency V2

## Summary

V2 makes cost optimization evidence-driven. The first foundation is composable runtime structure, stable prompt-prefix/cache discipline, and durable telemetry. Adaptive routing and cost policy come later, after repeated dispatches produce queryable runtime evidence.

## Completed Foundation From V1/V1.5

- Deterministic model routing tiers exist for planner, coder, reviewer, and doc dispatches.
- The harness records model/tool telemetry in `.autoforge/telemetry.json`.
- Tool output shaping stores large exec and QMD outputs as internal artifacts and returns bounded summaries to the model.
- Context-envelope hashes support reuse analytics for full dispatch prompts.

## V2 Roadmap

1. Runtime component extraction
   - Keep `HarnessExecutor` as the loop coordinator.
   - Move runtime controls, MCP/QMD behavior, tool outcomes, prompt envelopes, and telemetry summaries into focused components.

2. Stable prompt-prefix/cache discipline
   - Build prompts from stable sections followed by dynamic sections.
   - Hash and version only the stable prefix.
   - Apply provider cache controls only in adapters and only to stable blocks.
   - Never cache volatile task/user text by default.

3. Durable runtime telemetry
   - Emit `agent_runtime_telemetry` after live planner/coder/reviewer/doc dispatches.
   - Store compact summaries in event payload JSON.
   - Keep raw model/tool event arrays in `.autoforge/telemetry.json`.

4. Reporting and KPI helpers
   - Query repeated stable-prefix hashes, cache hit ratio, cached-token savings, max history chars, and tool-output contribution.
   - Add dashboard/API surfaces only when the compact payloads prove useful.

5. Adaptive routing and cost policy
   - Use durable evidence to decide when cheaper, stronger, or specialized models should be selected.
   - Defer semantic retrieval, summarization policy, per-project cost caps, and automated policy changes until the foundation metrics are reliable.

## Success Measures

- Prompt-cache hit ratio improves for repeated agent dispatches with the same persona/skills/status contract.
- Repeated input-token cost drops without reducing task success rate.
- `agent_runtime_telemetry` events can explain token/cost totals, cache behavior, QMD usage, tool-output contribution, and failure subtype counts.
- Adaptive routing decisions are based on durable dispatch evidence rather than ad hoc assumptions.
