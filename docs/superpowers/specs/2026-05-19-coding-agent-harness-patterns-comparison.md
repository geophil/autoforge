# Coding Agent Harness Patterns: Public Guidance vs. Autoforge

**Date:** 2026-05-19  
**Status:** Research and roadmap artifact  
**Scope:** Compare published coding-agent harness practices with Autoforge's current architecture. No runtime behavior, schemas, APIs, or prompt assets are changed by this document.

## Executive Summary

Autoforge already matches many high-leverage coding-agent harness patterns: isolated task workspaces, orchestrator-owned credentials, explicit planner contracts, QMD-backed repo grounding, structured event history, reviewer/rework loops, test-gated PR creation, lineage-scoped lessons, and shadow evaluation for prompt variants.

The biggest opportunities are not wholesale architecture changes. They are tighter quality loops around code generation and refactoring:

1. Add refactoring-specific planner/coder/reviewer contract fields so agents preserve observable behavior and distinguish mechanical cleanup from design change.
2. Turn context retrieval quality into measurable evidence, not just "QMD was used."
3. Make verification selection more task-aware, especially for refactors and cross-module changes.
4. Upgrade reviewer rubrics from generic quality findings to behavior, regression, maintainability, and refactoring-safety dimensions.
5. Feed post-task outcomes back into routing, tool ergonomics, and prompt lessons with more explicit metrics.

## Source Set

Primary external references used:

- [OpenAI: Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [OpenAI: A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [Anthropic: Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [GitHub Docs: Using GitHub Copilot cloud agent to improve a project](https://docs.github.com/en/copilot/tutorials/cloud-agent/improve-a-project)
- [Agentic Refactoring: An Empirical Study of AI Coding Agents](https://arxiv.org/abs/2511.04824)

Autoforge verification sources:

- `docs/qmd/architecture-overview.md`
- `docs/qmd/domain-task-orchestration.md`
- `docs/qmd/domain-agent-execution.md`
- `docs/qmd/domain-pr-gate.md`
- `docs/qmd/domain-event-sourcing.md`
- `src/orchestrator/service.ts`
- `src/runtime/harness-executor.ts`
- `src/runtime/tools.ts`
- `src/runtime/workspace.ts`
- `src/runtime/local-workspace.ts`
- `src/runtime/container-workspace.ts`
- `src/privileged/pr.ts`

## Pattern Catalog And Autoforge Fit

| Pattern | Public guidance | Autoforge today | Fit | Opportunity |
|---|---|---|---|---|
| Stable harness loop with durable event history | OpenAI's Codex App Server separates client protocol from the core harness, persists threads, and emits structured event updates for rich UIs. Source: [OpenAI Codex harness](https://openai.com/index/unlocking-the-codex-harness/). | Autoforge uses an event-sourced SQLite log, task projections, SSE dashboard events, transcripts, workspace lifecycle events, and restart/recovery behavior. | Strong | Keep event payloads stable enough for future external clients; document event compatibility expectations if Autoforge becomes an integration surface. |
| Tool execution in a sandbox with explicit policy | OpenAI emphasizes sandboxed shell/file tools and policy-managed extensions; OpenAI's agent guide frames guardrails as layered defenses. Anthropic emphasizes clear toolsets and environment feedback. Sources: [OpenAI Codex harness](https://openai.com/index/unlocking-the-codex-harness/), [OpenAI agent guide](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/), [Anthropic agents](https://www.anthropic.com/engineering/building-effective-agents). | `Workspace` is the file/exec boundary. `LocalWorkspace` and `ContainerWorkspace` constrain paths; task-facing agents get `QMD_MCP_URL` but not secrets; privileged GitHub and model credentials remain in orchestrator code. | Strong | Add risk labels to runtime tools and lifecycle hooks so high-risk mutations can be surfaced in events and, later, approval policy. |
| Repository instructions and environment setup | GitHub recommends custom instructions with codebase summary, structure, build/test commands, contribution rules, and technical principles; it also recommends setup steps for repeat agent tasks. Source: [GitHub Copilot cloud agent docs](https://docs.github.com/en/copilot/tutorials/cloud-agent/improve-a-project). | `AGENTS.md`, QMD docs, personas, skills, `package.json`, Docker workspace docs, and lifecycle hooks provide most of this. | Strong | Add a periodic "agent readiness" check that detects stale instructions, missing setup guidance, or drift between QMD docs and executable commands. |
| Orchestrator-worker decomposition | Anthropic identifies orchestrator-workers as a fit for coding tasks where changed files and subtasks are not known upfront. Source: [Anthropic agents](https://www.anthropic.com/engineering/building-effective-agents). | Planner emits `PlanSubtask[]`; STANDARD/THOROUGH can use spec and plan approvals; execution contract requires behavior, files in scope, verification commands, test criteria, and evidence. | Strong | Improve contract specificity for refactors: invariants preserved, public API compatibility, migration expectations, rollback criteria, and forbidden behavior changes. |
| Evaluator-optimizer loop | Anthropic recommends generator/evaluator loops when clear criteria exist and iterative refinement improves quality. Source: [Anthropic agents](https://www.anthropic.com/engineering/building-effective-agents). | Coder output flows to reviewer, CRITICAL/MAJOR findings trigger rework up to 3 iterations, then PR gate checks tests and review score. | Strong | Split reviewer output into typed dimensions: spec compliance, regression risk, refactor safety, maintainability, test adequacy, and security. Use dimensions in gate/reward views. |
| Ground truth from environment | Anthropic stresses tool results and code execution as ground truth during agent work. Source: [Anthropic agents](https://www.anthropic.com/engineering/building-effective-agents). | Agents use workspace tools; lifecycle hooks, pre-review checks, authenticated tests, test results, and `task_exit_check` create execution evidence. | Good | Encourage coder agents to run targeted verification before `done`, then compare declared verification with PR-gate results. |
| Context retrieval and grounding | Public guidance favors agents that inspect the real environment and use available knowledge sources instead of relying on static assumptions. Sources: [Anthropic agents](https://www.anthropic.com/engineering/building-effective-agents), [GitHub Copilot cloud agent docs](https://docs.github.com/en/copilot/tutorials/cloud-agent/improve-a-project). | Planner must emit usable `planningContext.qmdContext` evidence when QMD is configured. QMD is forwarded to planner/coder/reviewer/doc/doc-review. | Good | Measure retrieval quality: query count, retrieved docs, cited conventions used in acceptance criteria, and whether later failures trace to missed context. |
| Tool ergonomics and evaluations | Anthropic recommends measuring tool use with realistic tasks, tool-call counts, runtime, token use, errors, and transcript review. Source: [Anthropic tool design](https://www.anthropic.com/engineering/writing-tools-for-agents). | Autoforge records tool stats, token/cost telemetry, transcripts, loaded skills, shadow runs, and task quality views. | Good | Add harness/tool evaluation scenarios that stress common coding workflows: locate convention, edit across files, run narrow tests, recover from failed command, and summarize evidence. |
| Guardrails and human checkpoints | OpenAI recommends layered guardrails, strict access controls, and pausing for risky tools or human escalation. Anthropic recommends checkpoints and stopping conditions. Sources: [OpenAI agent guide](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/), [Anthropic agents](https://www.anthropic.com/engineering/building-effective-agents). | Credentials stay in orchestrator. Human gates exist for spec, plan, PR approval, first fork approval, and interventions. Time budgets and rework limits bound loops. | Strong | Add explicit escalation categories for risky changes: auth/security, migrations, public API changes, generated code, and broad refactors. |
| Refactoring discipline | The agentic refactoring study finds agents often perform localized consistency edits, frequently targeting maintainability/readability with measurable but modest structural improvements. Source: [Agentic Refactoring](https://arxiv.org/abs/2511.04824). | Autoforge treats refactoring as a generic task unless the planner/coder/reviewer personas infer special handling. Tests and review gates catch some risk, but contracts do not currently encode refactoring semantics. | Partial | Add a refactor mode or contract extension that requires before/after behavior invariants, API compatibility, test selection rationale, and a review check for behavior-preserving change. |
| Learning loop and prompt evolution | Public guidance emphasizes measuring outcomes and iterating. Anthropic warns not to add complexity unless it improves outcomes. Sources: [Anthropic agents](https://www.anthropic.com/engineering/building-effective-agents), [Anthropic tool design](https://www.anthropic.com/engineering/writing-tools-for-agents). | Autoforge has task quality views, `lessons`, reflector, diagnostician, fork proposals, meta operations, variants, and shadow evaluation. | Strong | Use refactor/codegen outcome labels to drive more focused lessons: "context miss", "test miss", "over-broad edit", "under-specified plan", "tool friction". |

## Strengths To Preserve

- **Credential and privilege separation.** Agents never need `GITHUB_TOKEN`, model API keys, or direct PR powers. This aligns with layered guardrail guidance and should remain a non-negotiable harness invariant.
- **Workspace abstraction.** `Workspace.readFile`, `writeFile`, `exec`, and `destroy` keep harness logic independent from local vs. Docker execution. This matches the public direction toward sandboxed, portable agent runtimes.
- **Evidence-first planning.** Requiring QMD evidence for configured planner runs is a strong answer to repository grounding. It also gives humans and the meta-loop something inspectable.
- **Execution contracts.** Requiring behavior, scope, verification, test criteria, and completion evidence is exactly the right shape for high-quality code generation.
- **Reviewer/rework plus PR gate.** Autoforge combines LLM evaluation, deterministic pre-review checks, authenticated tests, and hard PR-gate conditions. That layered quality model is healthier than relying on any one signal.
- **Event-sourced observability.** Agent dispatches, transcripts, variants, shadow runs, test results, intervention causes, and exit checks give Autoforge enough telemetry to improve the harness empirically.

## Gaps And Drift Risks

### 1. Refactoring Is Not Yet A First-Class Contract

The refactoring study suggests agents often make localized, consistency-oriented refactors and can improve maintainability/readability, but the risk is accidental behavior change or shallow cleanup that misses design-level needs. Autoforge's current execution contract is generic; it does not require explicit behavior invariants or compatibility claims for refactors.

**Recommended V1 improvement:** Add refactoring guidance to planner/coder/reviewer prompts or skills before changing orchestration code. Require:

- intended refactor type: mechanical, structural, API-preserving design cleanup, migration-assisted, or behavior-changing follow-up;
- observable behavior invariants;
- public API and data compatibility expectations;
- affected tests and why they are sufficient;
- rollback or review notes for broad changes.

### 2. QMD Evidence Is Required, But Retrieval Quality Is Not Scored

Autoforge can reject planner output missing QMD context, which is a strong baseline. The remaining gap is quality: a planner can query QMD but still retrieve weak or irrelevant context.

**Recommended V1 improvement:** Add advisory scoring in planner review UI or task events:

- no QMD evidence;
- evidence present but unrelated to files in scope;
- evidence present but not reflected in acceptance criteria;
- evidence reflected in subtasks and verification.

This can begin as reporting only. It does not need to block PRs until enough outcome data exists.

### 3. Verification Selection Is Still Too Coarse For Refactors

The PR gate requires 100% pass rate and blocks missing verification for STANDARD/THOROUGH. That is good, but refactors often need targeted regression reasoning: changed public paths, affected callers, snapshots, contract tests, migrations, or type-level checks.

**Recommended V1 improvement:** Ask planners to include a "verification rationale" for each subtask: why these commands exercise the edited behavior and what residual risk remains. Reviewers should flag verification mismatch even if tests pass.

### 4. Reviewer Findings Are Not Rich Enough For Learning

Autoforge computes review score from unresolved findings, but the finding categories are not yet tuned for post-hoc harness improvement. A generic MAJOR finding is less useful to the reflector/meta loop than "missed repository convention" or "refactor changed observable behavior."

**Recommended V1 improvement:** Add reviewer rubric categories in prompt guidance first:

- behavior regression;
- insufficient context grounding;
- weak verification;
- unsafe broad edit;
- API compatibility risk;
- maintainability/readability improvement;
- security or credential boundary risk.

Later, if useful, promote these categories into typed schema fields.

### 5. Tool Ergonomics Need Held-Out Harness Evals

Anthropic's tool-design guidance emphasizes realistic held-out evaluations and tool-call metrics. Autoforge records telemetry, but there is no explicit held-out benchmark suite for the harness itself.

**Recommended V1 improvement:** Create a small non-production eval catalog with tasks that exercise agent-tool workflows:

- find the right convention from QMD and source;
- make a narrow bug fix with targeted tests;
- perform a mechanical refactor without behavior change;
- recover from a failing test command;
- avoid editing files outside the contract;
- produce correct completion evidence.

These should run against `MockWorkspace` or small fixture repos before graduating to real agent runs.

## Prioritized Roadmap

### P0: Preserve Existing Safety Invariants

- Keep model/GitHub credentials in orchestrator-owned code only.
- Keep task work isolated in worktrees/workspaces.
- Keep STANDARD/THOROUGH from passing PR gate with unavailable verification.
- Keep QMD evidence required when QMD is configured.
- Keep rework bounded by an explicit iteration limit.

### P1: Prompt/Skill Improvements For Quality

- Update planner guidance to recognize refactoring tasks and emit behavior-preservation evidence.
- Update coder guidance to run or document targeted verification before marking `DONE`.
- Update reviewer guidance to evaluate refactor safety and verification sufficiency.
- Add examples of good and bad refactoring contracts to the planning skill.

Expected impact: higher quality without schema or orchestration churn.

### P1: Measurement Improvements

- Add QMD retrieval-quality advisory metrics.
- Add task outcome labels for context miss, verification miss, refactor regression, and over-broad edit.
- Include tool-call count, tool errors, and elapsed time in harness evaluation summaries.
- Correlate reviewer categories with reflector lessons and variant performance.

Expected impact: better feedback loops for prompt variants and harness/tool design.

### P2: Refactoring-Aware Gate Enhancements

- Add optional contract fields for refactoring tasks once prompt-only guidance proves stable.
- Teach pre-review checks to compare reported artifacts against files-in-scope and refactor invariants where machine-checkable.
- Add reviewer finding categories to structured schema if prompt-level categories are useful.

Expected impact: stronger regression control for medium and large refactors.

### P2: Harness Evaluation Suite

- Build fixture tasks for codegen and refactoring workflows.
- Run them through mock and real harness modes where feasible.
- Track pass/fail, token cost, tool calls, retry count, review findings, and PR-gate result.
- Use held-out tasks when optimizing tools or personas to avoid overfitting.

Expected impact: empirical harness iteration instead of anecdotal prompt tuning.

### P3: Integration Surface Hardening

- If Autoforge exposes its harness to external clients, define stable event payload expectations, compatibility policy, and client-ready turn/item abstractions.
- Add richer approval policy for high-risk tool actions and broad edits.
- Consider remote workspace provider expansion only after local/Docker harness metrics are healthy.

Expected impact: safer embedding and scaling, but not needed for near-term codegen/refactor quality.

## Suggested First Execution Slice

Implement the smallest useful improvement without touching orchestration:

1. Update the planner skill/persona guidance for refactor-specific contracts.
2. Update the reviewer persona to classify refactor-safety and verification-sufficiency findings.
3. Add a short QMD/spec note documenting the desired refactor contract shape.
4. Verify with prompt/persona unit tests if those files are covered, plus grep for drift.

This slice strengthens behavior immediately and creates better data for deciding whether typed schema or gate changes are warranted.

## Implemented First Slice

The first implementation slice applies the roadmap at the prompt and skill
layer only. It intentionally avoids TypeScript schema, parser, database, and PR
gate changes until the new categories prove useful in real task outcomes.

Implemented edits:

- Planner guidance now treats refactors as behavior-preservation work and asks
  for refactor type, invariants, compatibility expectations, verification
  rationale, and non-goals using existing discovery/spec/subtask fields.
- Coder guidance now requires refactor equivalence checks, targeted
  verification, scoped edits, and `DONE_WITH_CONCERNS` when behavior
  preservation cannot be proven.
- Reviewer guidance now checks refactor safety and verification sufficiency
  before style, and recommends finding categories such as
  `behavior_regression`, `verification_gap`, `scope_drift`,
  `api_compatibility`, `refactor_safety`, `context_grounding`, and `security`.

Deferred on purpose:

- typed planner fields for refactor contracts;
- a closed enum for review finding categories;
- PR-gate logic that blocks on refactor-specific categories;
- QMD retrieval-quality scoring;
- a held-out harness evaluation suite.

## Traceability Notes

Targeted source checks completed while drafting:

- `execution_contract`: emitted and validated in `src/orchestrator/service.ts`; documented in `docs/qmd/domain-task-orchestration.md`.
- `task_exit_check`: emitted before PR creation in `src/orchestrator/service.ts`; rendered by dashboard per existing plan docs.
- `planner:spec` and `planner:execution_plan`: transcript stages used throughout planner dispatch and retry paths.
- `workspace`: implemented as the file/exec boundary in `src/runtime/workspace.ts`, `local-workspace.ts`, and `container-workspace.ts`.
- `lessons`: retrieved by lineage for dispatch and inserted by reflector flow.
- `reviewer`: dispatched in `executeAndReview()` after coder work and pre-review checks, except EXPRESS.
- `pr_gate`: enforced by `evaluatePrGate()` in `src/privileged/pr.ts`, including verification availability, pass rate, review score, and unresolved CRITICAL findings.

## Assumptions

- This artifact should guide future work but not itself change runtime behavior.
- Public references are used for patterns, not as binding requirements.
- Autoforge's QMD docs remain the system of record for current behavior; this file is a comparison and roadmap.
