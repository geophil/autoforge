# Add V2 Cost-Efficiency Roadmap Doc

## Summary
Create `docs/qmd/model-cost-efficiency-v2.md` as a forward-looking roadmap for optimizing model cost and agent efficiency after the conservative V1 model-router and tool-result shaping work lands.

## Key Content
- Frame V2 around cost per successful task, not cheapest model per call.
- Group possible V2 work into:
  - Adaptive routing from historical task outcomes.
  - Budget-aware planning and retry control.
  - Smarter context and tool-output compression.
  - Stronger observability and cost attribution.
  - Policy tuning, rollout, and safety controls.
- Include candidate items such as:
  - Per-agent/phase success-rate dashboards by model tier.
  - Automatic escalation/de-escalation based on retry patterns, review findings, and timeout signals.
  - Prompt and context budget preflight before dispatch.
  - Tool-result artifact search and targeted excerpt retrieval.
  - Diff-risk scoring before reviewer/final-review routing.
  - Model-tier A/B experiments using existing persona/variant concepts.
  - Cached summaries for repeated logs, transcripts, and file reads.
  - Configurable per-project cost budgets and hard/soft caps.
  - Post-task attribution: which phases consumed cost, which outputs helped, which retries were avoidable.
  - Optional model-based summarization fallback when deterministic parsers are insufficient.

## Integration Notes
- Position the doc as non-binding roadmap, not current runtime behavior.
- Reference the V1 components conceptually: model router, tool-output artifact store, telemetry, deterministic parsers.
- Avoid prescribing exact schemas for V2 unless already required by V1; keep it as a backlog/strategy document.

## Deferred From V1.5
- Full transcript compaction or sliding-window history management; V1.5 should only add telemetry and a conservative context-growth guardrail.
- Model-based summarization for QMD/tool outputs; V1.5 should use deterministic excerpts only.
- Adaptive model routing from historical outcomes, review findings, retry rates, or per-project calibration.
- Semantic search over stored tool artifacts and transcript/log artifacts.
- Cost and success dashboards by phase, agent type, model tier, and failure subtype.
- Per-project cost budgets, hard caps, soft caps, and operator approval workflows.
- Broader lifecycle-hook, PR-gate, and post-review optimization beyond recording better timeout/context telemetry.
- Automatic QMD document section retrieval or QMD schema changes such as `fromLine`/`maxLines`; V1.5 should shape the MCP results it receives.

## Test Plan
- No automated test required for the doc-only change.
- Run `bun run lint` only if the implementation branch also changes TypeScript.
- Verify the doc is linked from `docs/qmd/architecture-overview.md` or another QMD index if the repo has a conventional place for roadmap docs.

## Assumptions
- The doc belongs under `docs/qmd/`.
- The filename should be `model-cost-efficiency-v2.md`.
- V2 content should remain exploratory and prioritized, not a committed delivery contract.
