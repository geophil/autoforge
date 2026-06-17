# Hermes Lessons For Autoforge RFC

**Date:** 2026-06-15  
**Status:** Draft architecture proposal  
**Scope:** Compare Hermes Agent with Autoforge and propose conservative simplifications. This document is intentionally outside `docs/qmd/` because it is exploratory and should not be treated as accepted knowledgebase material until promoted by a separate documentation task.

## Executive Summary

Hermes Agent and Autoforge are both agent harnesses, but they optimize for different jobs.
Hermes is a general-purpose, long-lived assistant harness: it emphasizes many entry points, a broad tool registry, cross-session continuity, user memory, agent-managed skills, and interchangeable runtime backends. Autoforge is a specialized coding harness: it turns natural-language software tasks into human-reviewable pull requests through isolated worktrees, planner contracts, reviewer loops, PR gates, and event-sourced recovery.

The lesson is not to copy Hermes wholesale. Autoforge should stay narrower. The useful Hermes ideas are the ones that make a specialized coding harness smaller, more legible, and easier to improve:

1. Prefer a compact core agent loop with capability pushed into tools, skills, and context layers.
2. Treat learning as bounded, curated knowledge before treating it as live traffic optimization.
3. Stage agent-authored skill or guidance changes for human review.
4. Keep prompt layers stable and explicit: stable persona/contract, project/QMD context, volatile task/lesson context.
5. Revisit population traffic only after there is enough measured task volume to justify it.

This RFC recommends keeping all current safety invariants and making the self-improvement loop more conservative by default.

## Source Set

External Hermes sources:

- [Hermes Agent README](https://github.com/NousResearch/hermes-agent)
- [Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
- [Hermes prompt assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly)
- [Hermes context compression and caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching)
- [Hermes skills system](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Hermes tools and toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools)

Autoforge evidence sources:

- `docs/qmd/architecture-overview.md`
- `docs/qmd/domain-agent-execution.md`
- `docs/qmd/domain-task-orchestration.md`
- `docs/qmd/domain-event-sourcing.md`
- `docs/qmd/domain-pr-gate.md`
- `docs/qmd/patterns-and-conventions.md`
- `docs/superpowers/specs/2026-04-19-self-improving-persona-population-design.md`
- `docs/superpowers/specs/2026-05-19-coding-agent-harness-patterns-comparison.md`

## QMD Evidence Used

This proposal is grounded in the accepted QMD knowledgebase but does not modify it.

| QMD document | Evidence used | Design implication |
|---|---|---|
| `architecture-overview.md` | Autoforge is a monolith with pluggable agent backends; the orchestrator owns credentials, event sourcing, worktrees, QMD integration, PR gate, and the meta/population loop. | Keep the monolith and safety boundaries; simplify inside the harness instead of creating new services. |
| `domain-agent-execution.md` | Production execution is `HarnessExecutor` plus `AnthropicProvider`, `RuntimeToolRegistry`, and `Workspace`; all agents write `.autoforge-status.json`; the runtime already supports lessons, skills, QMD tools, and transcript attribution. | Add prompt/context layering and knowledge improvements through existing executor boundaries. |
| `domain-task-orchestration.md` | The pipeline is planner -> coder -> reviewer -> PR gate -> PR, with spec/plan approval, WIP limit 1, execution contracts, QMD evidence enforcement, bounded rework, steering, rollback, and population dispatch. | Do not weaken task-to-PR gates; make learning changes advisory/staged unless accepted. |
| `domain-event-sourcing.md` | SQLite events are append-only and projections are rebuildable; population operations, lesson events, shadow runs, and workspace lifecycle events are ordinary events. | Preserve compatibility by adding feature flags or advisory events rather than removing existing event types. |
| `domain-pr-gate.md` | Agents never push; GitHub operations are privileged; STANDARD and THOROUGH require available verification; unresolved critical findings block PR creation. | Any Hermes-inspired simplification must not lower PR gate strictness. |

## Comparison Matrix

| Area | Hermes Agent | Autoforge Today | Recommendation |
|---|---|---|---|
| Product shape | General-purpose assistant across CLI, gateway, API, batch, messaging, and editor surfaces. | Special-purpose coding system that produces pull requests. | Keep Autoforge specialized. Do not add multi-platform chat, gateway, or general automation as core goals. |
| Agent core | One `AIAgent` loop handles prompt assembly, provider resolution, tool dispatch, compression, retries, callbacks, and persistence. | One production `HarnessExecutor` loop drives provider calls and runtime tools through `Workspace`. | Continue consolidating around the single harness path. Avoid reintroducing alternate executor families. |
| Tools | Broad tool/toolset registry across web, browser, terminal, files, memory, delegation, media, messaging, cron, MCP, and more. | Narrow runtime registry: file read/write, exec, artifact reads, done, skill lookup/load, and QMD/MCP support. | Keep the tool surface narrow. Add tools only when they improve task-to-PR evidence or reduce repeated prompt complexity. |
| Workspace | Multiple terminal backends, including local, Docker, SSH, Modal, Daytona, and Singularity. | `Workspace` abstraction with local and Docker providers; task-facing tools cannot access orchestrator credentials. | Keep workspace as the portability boundary. Do not copy Hermes's broad backend list until local/Docker quality is boring. |
| Memory | Bounded curated memory files plus user profile, injected as frozen prompt snapshots. | Lineage-scoped `lessons` extracted by a reflector and retrieved at dispatch. | Strengthen lessons into a bounded curated knowledge layer before expanding persona populations. |
| Skills | Progressive-disclosure skills, agent-managed skill writes, optional approval gate for skill modifications. | Static repo skills loaded by `SkillRegistry`, snapshotted for provenance, with `lookup_skill` and `load_skill` tools. | Add staged skill/doc patch proposals with review before allowing self-modification. |
| Self-improvement | Agent creates and improves skills from experience; memory and session search help continuity. | Reflector lessons, reward views, diagnostician fork proposals, meta operations, shadow runs, and variant traffic. | Default to evidence-backed knowledge artifacts. Keep population traffic experimental until measured volume warrants it. |
| Prompt/context | Deliberate separation between cached system prompt state and API-call-time additions; stable/context/volatile layering. | Dispatch envelopes combine persona, lessons, skills, status instructions, QMD, and task prompt; context envelope hashes are already recorded. | Make Autoforge's prompt layers explicit and cache-aware without changing task behavior. |
| Safety | Command approvals, profile isolation, optional container backends, and platform authorization. | Orchestrator-owned credentials/git, isolated worktrees, strict PR gate, QMD evidence enforcement, bounded rework, human gates. | Preserve Autoforge safety invariants as non-negotiable. Hermes-style memory/skill writes must be staged. |
| Persistence | SQLite session storage with FTS search and session lineage. | SQLite append-only events, projections, transcripts, outcomes, lessons, reward views, and NATS mirror. | Keep event sourcing. Add advisory/staging events rather than mutable background state. |

## What To Adopt

### 1. Bounded Learning Before Population Traffic

Hermes makes learning concrete through small artifacts: memory entries and skill files. Autoforge already has a more rigorous but heavier machinery: lineage lessons, prompt variants, reward views, diagnostician forks, candidate shadow runs, and traffic allocation.

Autoforge should keep the heavy machinery available but make the default learning path smaller:

- terminal task outcome -> reflector proposes at most one lesson;
- repeated or high-confidence lessons -> staged skill or planner-contract patch;
- accepted staged patch -> new prompt/skill snapshot with provenance;
- only after enough outcome volume -> consider variant traffic changes.

This gives the harness a gentler improvement curve and reduces the chance that a premature specialist variant changes production behavior from weak evidence.

### 2. Staged Skill And Guidance Writes

Hermes allows agent-managed skills and can stage skill writes for approval. Autoforge should use the same shape but with stronger coding-harness boundaries:

- agents may propose a patch to `skills/*.md`, `src/personas/*.md`, or draft docs;
- proposals are stored as events and/or draft artifacts;
- humans review diffs before they become active;
- accepted patches produce immutable `skill_versions` snapshots;
- rejected patches remain useful training/evidence data.

This should happen before any feature that allows live agents to mutate prompt assets directly.

### 3. Explicit Prompt Layering

Hermes documents a useful distinction between stable prompt state and ephemeral per-call additions. Autoforge already has the pieces, but the boundary should be named and made inspectable:

| Layer | Autoforge contents | Mutability |
|---|---|---|
| Stable | Persona content, core status contract, runtime tool contract, invariant safety rules. | Changes only through accepted prompt/skill revisions. |
| Project/QMD | AGENTS instructions, QMD-retrieved architecture context, project config, relevant accepted docs. | Rebuilt per dispatch from source of truth. |
| Volatile | Task description, current phase, approved spec/plan, steering, lessons, failure/retry context, recent transcripts. | Changes per dispatch and retry. |

The implementation should preserve `context_envelope_hash` and add enough metadata to understand which layer changed when cache behavior or model quality shifts.

### 4. Progressive Skill Disclosure For Autoforge Skills

Hermes's skills are discoverable first and loaded fully only when needed. Autoforge already has `lookup_skill` and `load_skill`. The next improvement is to make repo skills follow the same operational discipline:

- every skill should have a short trigger description;
- bulky examples or references should be separate supporting files when needed;
- planner/coder/reviewer prompts should prefer loading relevant skills over embedding every rule in the base persona;
- skill load events should remain transcript-visible for attribution.

This can simplify personas while keeping task-specific guidance available.

## What Not To Copy

### Multi-Platform Gateway

Hermes needs Telegram, Discord, Slack, WhatsApp, Signal, CLI, API, and editor continuity. Autoforge's product boundary is task-to-PR. A gateway would add surface area without improving coding quality, PR safety, or architecture simplicity.

### Broad Tool Marketplace

Hermes benefits from many toolsets because it is general purpose. Autoforge benefits from a small, auditable tool surface. More tools mean more prompt surface, more approval policy, more failure modes, and more tests.

### Personal User Memory

Hermes models user preferences and long-term personal context. Autoforge should not store broad user profiles as a harness primitive. Durable Autoforge memory should stay tied to projects, tasks, outcomes, lessons, and accepted docs.

### Default Autonomous Skill Mutation

Hermes can let the agent write skills freely depending on configuration. Autoforge should not do that by default. Because Autoforge changes production code and opens PRs, skill/persona updates should be staged and auditable.

### Live Population Complexity As The First Learning Path

Autoforge's population design is valuable when there is enough traffic to compare variants. It is expensive conceptually and statistically. For a conservative path, keep the schema and events, but prefer lessons and staged guidance changes until enough data exists.

## Conservative Phased Proposal

### Phase 1: Document Non-Negotiable Invariants

Create one accepted QMD update only after this RFC is reviewed. The update should restate:

- agents never receive credentials or push directly;
- the orchestrator owns model APIs, GitHub, and privileged git operations;
- task work happens in isolated worktrees/workspaces;
- STANDARD and THOROUGH cannot treat missing verification as passing;
- QMD evidence is required for configured planner runs;
- PR creation remains behind test/review gate evidence;
- population and learning changes must be attributable to events.

This phase is a documentation promotion step, not a code change.

### Phase 2: Freeze Population Expansion By Default

Preserve existing population tables, views, events, dashboards, and APIs, but make new traffic-affecting operations conservative by default:

- baseline remains the default route when evidence is sparse;
- first forks remain human-approved;
- automatic promote/demote/merge behavior should require a minimum evidence threshold;
- diagnostics may continue to produce proposals, but proposals should be advisory when sample size is low;
- feature flags should allow operators to disable autonomous traffic allocation while keeping lesson extraction.

Compatibility requirement: existing `skill_versions`, `experiments`, `lessons`, `fork_proposals`, reward views, and event types remain readable.

### Phase 3: Improve Lessons Into Bounded Knowledge

Make lessons more Hermes-like in boundedness and reviewability while preserving Autoforge provenance:

- set explicit per-agent and per-lineage active lesson budgets;
- surface lesson usage in dispatch events and transcripts;
- add quality states such as `active`, `staged`, `superseded`, and `retired` where not already covered;
- detect duplicate or stale lessons before injection;
- prefer short, operational lessons with trigger patterns and concrete evidence;
- add a report showing which lessons influenced successful and failed tasks.

Success means lessons become trustworthy enough that fewer persona forks are needed.

### Phase 4: Add Staged Skill/Doc Patch Proposals

Introduce a proposal path for improving durable guidance:

- reflector or meta identifies repeated lesson patterns;
- agent creates a patch proposal against a skill, persona, or draft doc;
- the proposal includes task IDs, findings, transcript references, and expected behavioral impact;
- humans approve or reject the patch;
- accepted patches are applied by trusted orchestrator code and snapshotted.

This is the Autoforge equivalent of Hermes agent-managed skills, adapted for a PR-producing harness.

### Phase 5: Revisit Variant Traffic With Evidence

Only after lessons and staged skill patches are producing measurable improvements should Autoforge revisit active population traffic. Criteria should include:

- enough tasks per agent type to compare variants meaningfully;
- clear task niches where general guidance underperforms;
- stable reward metrics that correlate with human acceptance;
- shadow runs showing candidate benefit without production risk;
- no regression in PR gate pass rate or human review quality.

If these criteria are not met, population remains an observability and experimentation layer rather than the default learning engine.

## Suggested Implementation Slices

### Slice A: RFC Only

This document. No runtime behavior, schemas, APIs, prompt assets, or QMD files change.

Verification:

- `bun run lint`
- manual review that the document lives outside `docs/qmd/`

### Slice B: Accepted Invariants Note

After review, promote only the stable conclusions into QMD. Do not copy the whole RFC into QMD.

Candidate output:

- a short section in `docs/qmd/architecture-overview.md` or a new focused QMD page for learning-governance invariants;
- cross-link from this draft RFC to the accepted QMD update.

### Slice C: Prompt Layer Metadata

Implement explicit prompt layer construction metadata in the dispatch envelope without changing prompt text:

- label stable, project/QMD, and volatile segments;
- include segment hashes in transcript/debug metadata;
- preserve existing `context_envelope_hash`.

Acceptance:

- no behavior change in agent outputs expected;
- transcripts show enough metadata to debug prompt/cache drift.

### Slice D: Staged Skill Patch Proposals

Add a proposal-only workflow for skill/persona/doc improvements:

- event type such as `guidance_patch_proposed`;
- patch artifact stored under ignored runtime artifact storage or a durable proposal table;
- approval endpoint applies the patch through trusted orchestrator code;
- rejected proposals remain queryable.

Acceptance:

- no agent can directly mutate active guidance;
- accepted proposals produce immutable prompt/skill provenance.

### Slice E: Population Conservative Mode

Add configuration to make population dispatch conservative where needed:

- keep baseline routing as the default;
- allow shadow runs and diagnostics;
- prevent autonomous traffic changes unless enabled;
- keep all existing population state visible.

Acceptance:

- existing tests for dispatch and reward views still pass;
- operators can observe candidate performance without production traffic changes.

## Open Questions

1. Should staged guidance patch proposals live only as events/artifacts, or should they get a first-class table like `fork_proposals`?
2. Should active lesson budgets be global, per agent type, per lineage, or per project?
3. Should prompt layer metadata be user-facing in the dashboard or only transcript/debug data?
4. Should conservative population mode be the default in development only, or in all environments until enough task volume exists?
5. What is the minimum task volume before variant traffic allocation becomes statistically meaningful for Autoforge's actual usage?

## Acceptance Criteria

- This RFC remains outside `docs/qmd/`.
- A reader can identify which Hermes ideas Autoforge should adopt, reject, or defer.
- The proposal preserves Autoforge's task-to-PR safety guarantees.
- Any future promotion into QMD is a separate explicit docs task.
- No runtime behavior changes are implied by this RFC alone.

