# Self-Improving Persona Population — Umbrella Design

**Status:** Proposed
**Date:** 2026-04-19
**Scope:** Architectural direction for the meta/learning loop. This is the anchor document for the subsequent detail specs (A, B, C, D) and is intentionally principle-level, not implementation-level.

---

## 1. Purpose

Establish the long-term architecture for Autoforge's self-improvement loop so every downstream spec inherits a coherent foundation. This document pins the load-bearing architectural decisions (data shape, reward function, action space, experimentation model, memory model) and defers concrete implementation details to the child specs it enumerates.

Readers should leave this document knowing:
- What we are optimizing (the reward function)
- What meta is allowed to change (the action space)
- How changes are validated (the experimentation model)
- How the system remembers what it has learned (the memory model)
- Which child spec owns which piece

---

## 2. Problem statement

The current meta loop (`src/orchestrator/service.ts :: submitMetaTask` + `src/personas/meta.md`) has the right skeleton but five structural weaknesses that compound:

1. **Coarse signal in.** Meta reads three aggregated numbers (`first_pass_rate`, `avg_iterations`, `avg_step_cost`) from the `agent_performance` view. The richest data in the system — `agent_transcripts`, `review_findings` with categories, rework diffs — is never consulted.
2. **Single hypothesis out.** Meta proposes one free-text edit to one persona per session. No alternatives are considered.
3. **Live activation.** The proposed version is set `is_active=1` immediately and affects all subsequent production traffic. No canary, shadow, or held-out evaluation.
4. **Manual, binary decision.** Promotion/rollback is a human typing a number into `/conclude`. Keep/discard throws away per-niche information (a version that is worse on average but better on a subset of tasks is still discarded).
5. **No memory beyond the experiments table.** Every meta session rediscovers lessons the previous session already learned.

The failure-analysis work already designed in [`docs/design/observability-and-recovery.md`](../../design/observability-and-recovery.md) addresses (1) partially. This umbrella addresses (1)–(5) as a coherent whole.

---

## 3. Architectural decision: Population-of-specialists (P)

We choose **Architecture P** over the incumbent **Architecture V** (versions-in-place). The two were compared in detail during brainstorming; the summary:

- **V (versions-in-place):** one active persona per agent type; meta replaces version → version; keep/discard is binary. Simple, but it throws away per-niche performance information and cannot be grown gracefully into a population model later.
- **P (population-of-specialists):** each agent type has a *population* of variants with roles (baseline, active specialist, candidate, demoted, retired). Tasks are routed to a variant by a dispatch policy. Meta curates the population (edit / fork / merge / promote / demote / retire). Experimentation happens through continuous traffic allocation.

**The decisive asymmetry:** P with population size 1 is operationally identical to V, but V cannot grow gracefully into P. Committing to P now costs a small schema tax; retrofitting later would require migrating `skill_versions`, the meta persona, dispatch, reward views, and the dashboard simultaneously on data already accumulated under the wrong assumptions.

**Default behaviour at rollout:** every agent type starts with population size 1 — the current seed persona, marked `status=baseline`, `traffic_share=1.0`. Nothing in normal operation changes until Layer 1 data justifies the first fork. We are investing in the *option* to specialize, not specialization itself.

---

## 4. Principles

These override implementation choices in the child specs where they conflict.

1. **The reward function is the source of truth.** If a change does not improve the composite score, it is not an improvement — regardless of how sensible it sounds.
2. **Evidence precedes action.** Every fork, merge, promotion, demotion, and retirement cites concrete evidence from the data. Meta is forbidden from acting on intuition alone.
3. **Immutability is non-negotiable.** `skill_versions` rows are never deleted. Retirement is a status change; lessons from retired variants persist and descend the lineage.
4. **Baseline protection.** Every agent type has exactly one variant designated `baseline` at all times. The baseline is the rollback target and always receives at least 50% of traffic.
5. **Graceful degradation.** When population size = 1, the system behaves exactly as it does today. Complexity only manifests when specialization is active.
6. **Human in the loop for novel territory.** The first fork of any lineage requires human approval. Subsequent operations within an approved lineage are autonomous.
7. **One change per experiment.** Within any single variant version, exactly one hypothesis is under test. Composite rewrites are forbidden — they make attribution impossible.
8. **Simpler beats cleverer.** Shorter personas, fewer skills attached, smaller diffs — all else equal — are improvements. This is a first-class reward term, not a tiebreaker.

---

## 5. Reward function

"Better" is a single composite score per task, computed from data we already capture (plus a few easily-added columns). The score has five terms, aligned with the stated goals:

```
task_quality_score(task) =
    w_correctness   * correctness(task)     // tests pass, PR gate pass, no CRITICAL/MAJOR findings
  + w_simplicity    * simplicity(task)      // 1 / (1 + diff_size_normalized)
  + w_alignment     * alignment(task)       // 1 − (architectural-category finding rate)
  + w_fidelity      * fidelity(task)        // 1 − planner_fallback, 1 − scope_drift_rate
  + w_efficiency    * efficiency(task)      // 1 / (1 + total_cost_normalized)
```

- **Weights start equal-valued** and are surfaced in configuration for later tuning. Spec A implements them as a weighted SQL view.
- **Per-task score** is the fundamental measurement unit. Aggregations roll up per variant, per niche (variant × task-category, variant × tier, variant × project), and per population.
- **Simplicity** is a first-class term so the optimizer has explicit pressure toward "smallest, cleanest solution that works" — the goal stated in scoping. Without this term, correctness dominates and we get verbose variants that happen to pass gates.
- **Population-level metrics** (coverage, diversity, redundancy, ensemble gain) are defined in Spec A's view layer on top of these per-task scores.

A change to the weights is itself a governance decision — tracked the same way a skill version change is tracked, with provenance.

---

## 6. The five layers

Each layer exists to enable the layers above it. Child specs implement one or more layers.

### Layer 1 — Observability

Widen the data meta can see. In scope:
- Finish `failure_analysis` events and tool-use stats (already designed in [`docs/design/observability-and-recovery.md`](../../design/observability-and-recovery.md)).
- Make `agent_transcripts` first-class input to meta (queryable by persona version, by failure category).
- Capture diff stats per task (lines added/removed, files touched, test-delta).
- Per-finding-category rollups per persona version (not just aggregate pass rate).
- Introduce the **population-shaped schema** — `skill_versions` gains `parent_version_id`, `specialty`, `status`, `traffic_share`. Events capture which variant was routed, which alternatives were eligible, and why.

### Layer 2 — Reward

Make "better" computable. In scope:
- `task_quality_score` view per section 5.
- Per-variant aggregate view.
- Per-niche conditional views (variant × category, variant × tier, variant × project).
- Population-health view (coverage, diversity, ensemble gain).
- Weight configuration surface (initially static config; later project-overridable).

### Layer 3 — Curation (meta's action space)

Replace "edit text and propose one change" with a richer curator vocabulary. Meta's action set becomes:
- `edit` — produce a new version of an existing variant (never mutate in place; today's behaviour, now named explicitly)
- `fork` — create a new variant with a declared specialty, bootstrapped from a parent version
- `merge` — consolidate two variants whose per-niche performance is statistically indistinguishable
- `promote` / `demote` — adjust traffic share within allowed bounds
- `retire` — archive a variant; lessons descend the lineage

Hypotheses are grounded in transcripts, finding patterns, and rework diffs — not aggregates. Meta reads specific failing traces, not just "first-pass rate dropped."

### Layer 4 — Dispatch policy

At task-submission time, select which variant of each required agent type handles the task. In scope:
- A `select_variant(agent_type, task_context)` function.
- Trivially returns the only eligible variant when population size = 1.
- When population size > 1: ε-greedy initially (ε small, e.g. 0.1), upgradeable to UCB / Thompson sampling.
- Cold-start support: new variants run shadow on next N tasks before receiving real traffic.
- Baseline protection enforced at allocation time (baseline receives ≥ 50%).
- Sequential testing governs promotion and demotion decisions automatically.

### Layer 5 — Memory and lineage

Make learning compound. In scope:
- Auto-reflection on each rework and each failed task: an LLM extracts a structured `lesson` from the (iter_N-1 → iter_N) diff or the failure trace.
- `lessons` table keyed by `(agent_type, failure_category, lineage_id)`.
- Retrieval at dispatch: top-K relevant lessons for the current task are injected into the system prompt.
- Lineage is preserved on retirement: a retired variant's lessons remain retrievable by its current and future descendants (and, when no descendants exist, by any future fork of the same agent type whose specialty covers the retired variant's niche).

---

## 7. Forking discipline (Option B)

Governance for the most consequential action — creating new population members.

- **Meta may propose a fork at any time** but must cite evidence: a failing-task cluster, a finding-category concentration, a specific transcript pattern, or comparable signal surfaced from Layer 1 data.
- **The first fork of any lineage** (e.g., the first time `persona:coder` is forked into `persona:coder.<specialty>`) requires explicit human approval before the variant becomes eligible for traffic. The approval channel is API/CLI at MVP; a dashboard affordance is a non-functional requirement for Spec D.
- **Subsequent operations within an already-approved lineage** (forking an approved lineage further, promoting/demoting, merging, retiring) proceed autonomously through the normal experiment lifecycle.
- **Heterogeneity diagnostic.** Spec D implements a periodic (nightly or every-N-tasks) clustering diagnostic over failing tasks and findings. Its output is the primary input to fork proposals. Without a positive diagnostic, meta is discouraged from proposing forks.
- **Population caps.** Maximum 5 active (non-retired, non-demoted-to-zero) variants per agent type by default, configurable globally. When at cap, a fork proposal must be paired with a merge or retirement proposal.

---

## 8. Pinned decisions

These are locked by this umbrella. Child specs must honour them.

| Decision | Value |
|---|---|
| Reward weights at rollout | Equal (1/5 each) across the five terms |
| Variant selection policy (MVP) | ε-greedy with ε = 0.1; upgradeable interface |
| Baseline protection | Each agent type has exactly one `baseline` variant at all times, receiving ≥ 50% of routed traffic |
| Population cap per agent type | 5 active variants; globally configurable; at-cap forks require a paired merge/retirement |
| Cold-start allocation | New variants receive 0% real traffic; run shadow on next N tasks; eligible for real traffic only after meeting a minimum-evidence bar (N and bar defined in Spec C) |
| Retirement semantics | `status=retired`, `traffic_share=0`, immutable; lessons preserved and attached to lineage; never deleted |
| First-fork approval | Human approval required via API/CLI at MVP |
| Fork evidence requirement | Every fork proposal cites at least one concrete data artifact (failing tasks, finding cluster, transcript excerpt) |

---

## 9. Deferred decisions (owner noted)

These are intentionally deferred to the indicated child specs so this umbrella stays principle-level.

| Decision | Owning spec |
|---|---|
| Exact formula for each reward term (correctness, simplicity normalization, alignment finding-category list, fidelity scope-drift detection, efficiency cost normalization) | Spec A |
| Schema DDL for `parent_version_id`, `specialty`, `status`, `traffic_share` columns and associated indices | Spec A |
| `failure_analysis` event payload finalization (beyond what observability-and-recovery.md specifies) | Spec A |
| `lessons` table schema; auto-reflection prompt and triggering policy | Spec B |
| Meta persona rewrite in curator vocabulary; tool surface required for fork/merge proposals | Spec B |
| `select_variant()` implementation; sequential testing thresholds; cold-start minimum-evidence bar (value of N and scoring rule) | Spec C |
| Heterogeneity diagnostic algorithm, cadence, and confidence thresholds | Spec D |
| Routing classifier (task → specialty) for population size > 1 | Spec D |
| Merging criteria (statistical test for "indistinguishable") | Spec D |
| Dashboard affordances for population health, lineage visualization, approval workflow | Follow-on spec after D |

---

## 10. Schema sketch

Indicative only — concrete DDL belongs to Spec A. Intent here is to show that Architecture P fits on top of the existing schema with small additions.

`skill_versions` gains:
- `parent_version_id TEXT` — lineage pointer; `NULL` for seed rows
- `specialty TEXT` — free-text description of what this variant is for; `NULL` for generalists
- `status TEXT` — one of `baseline | candidate | active | demoted | retired` (subsumes the existing `is_active` flag; the field describes traffic-allocation role, not origin — origin is captured by `experiment_id IS NULL` for file-on-disk seed rows)
- `traffic_share REAL` — allocation hint used by the dispatch policy; 0.0 – 1.0

`experiments` gains (minor):
- `operation TEXT` — one of `edit | fork | merge | promote | demote | retire` (the current schema implicitly assumes `edit`)
- `evidence TEXT` — structured citation of the data that justified the operation

New table `lessons`:
- `(id, agent_type, failure_category, lineage_id, body, source_task_id, created_at)`

Views: `task_quality_score`, `variant_performance`, `niche_performance`, `population_health` — all additive.

Events: the existing `persona_version_id` column is retained unchanged. A new routing event is emitted per task capturing which variant was selected, which alternatives were eligible, and the selection rationale (baseline / exploration / exploitation / shadow). The term "variant id" is used in specs and the meta persona as the semantic alias for `persona_version_id` to emphasize population semantics; no column is renamed.

No existing column is removed. Existing `is_active` remains for one release as a compatibility shim over `status ∈ {baseline, active}`.

---

## 11. Spec decomposition and dependencies

Each child spec is sized to produce an implementable plan through the `writing-plans` skill.

| Spec | Scope | Depends on |
|---|---|---|
| **Spec A — Observability + reward foundation** | Layers 1 and 2. Completes `failure_analysis`; adds diff stats, finding-category rollups, transcripts joinability; adds population-shaped schema columns and events; implements `task_quality_score` and per-niche / population-health views | This umbrella |
| **Spec B — Curator meta + lessons** | Layers 3 and 5. Rewrites meta persona in curator vocabulary with transcript/finding/diff access; introduces `lessons` table, auto-reflection sub-agent, dispatch-time retrieval | Spec A |
| **Spec C — Dispatch policy and safe experimentation** | Layer 4. Implements `select_variant()`, ε-greedy policy, shadow evaluation, cold-start rules, baseline protection, sequential promotion/demotion | Spec A (needs the reward views); independent of Spec B |
| **Spec D — Population operations** | Completes Layer 3's population actions. Heterogeneity diagnostic, forking tooling, merging criteria, routing classifier when population > 1, retirement workflow | Specs A, B, C all shipped |

Spec A and Spec C can be planned in parallel once this umbrella is approved, but Spec C's implementation should not merge before Spec A's reward views exist — otherwise there is nothing for dispatch and experimentation to optimize against.

Specs are written, reviewed, and implemented sequentially through the standard `brainstorming → writing-plans → implementation` flow.

---

## 12. Non-goals

Explicitly out of scope for this umbrella and for Specs A–D unless reopened:

- **Autonomous tier/executor routing as an action.** Tier and executor remain governed by existing code paths. Revisit only if meta's population actions stop yielding returns.
- **Full DSPy-style multi-candidate optimizer.** ε-greedy over a human-approved population is our experimentation model. Multi-candidate generation with a scoring harness is a possible future layer, not this layer.
- **Budget/timeout learning.** Budgets remain hardcoded per tier.
- **QMD context envelope learning.** Which QMD docs are visible to which agent remains manually configured.
- **Skill-attachment learning.** Which skills are attached to which agent type remains a hardcoded choice in `SkillRegistry`. (This is the one non-goal I expect we will revisit; flagging it explicitly so we don't drift into it ad hoc.)
- **Cross-project transfer.** Lessons and variants remain scoped per agent type globally; per-project populations are a future consideration.

---

## 13. Follow-on work and future candidates

The arc Specs A–D delivers the autonomous curation loop. Known improvements that are intentionally out of scope but worth remembering are catalogued in a single place — see Spec D §13 for the full list. Headline items:

- **Dashboard UI** (priority: high) — population view, lineage view, approval queue, lessons browser, diagnostic output, real auth. Replaces the CLI/API-only surface shipped in Spec D.
- **Cost-optimized experimentation** — replay-based shadow evaluation, Thompson/UCB bandit upgrades beyond ε-greedy.
- **Richer reward configuration** — DB-backed weights with history and per-project overrides.
- **Reasoning enhancements** — multi-candidate optimizer (DSPy/TextGrad style), embedding-based lesson retrieval, trajectory-level credit assignment.
- **Action-space expansion** — skill-attachment learning, LLM-based routing classifier at dispatch, cross-lineage merging.
- **Schema cleanups** — drop the `is_active` compatibility shim, remove the ad-hoc `archived_at` ALTER, normalize `review_findings.category`.

Spec D's §13 maintains the canonical list. When future candidates are promoted into scope, they become their own brainstorm → spec cycle.

---

## 14. Success criteria for the umbrella arc

We will consider Specs A–D collectively successful when, without human intervention beyond first-fork approvals:

1. Meta proposals cite concrete evidence from transcripts, findings, or rework diffs — not aggregates alone.
2. No proposed variant reaches real production traffic without passing a shadow/cold-start evaluation.
3. Promotions and demotions are triggered automatically by sequential testing, not manual `/conclude` calls.
4. At least one specialist variant has been forked, evaluated, and either promoted or retired based on niche performance data (demonstrating the end-to-end lifecycle).
5. Retired variants' lessons are observable at dispatch time for tasks similar to those that produced them.
6. The baseline variant is never starved below its minimum traffic share.
7. Population-health views make it possible to answer "is the ensemble improving?" without manual joins.

These success criteria are intentionally observable, so Spec D can include a "graduation" check before we declare the arc done.
