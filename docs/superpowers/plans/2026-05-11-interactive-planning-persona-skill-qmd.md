# Plan: Interactive planning — persona, skill, and QMD alignment (#6)

**Status:** Ready to execute  
**Depends on:** Core orchestration already implements two-stage planning (types, state machine, APIs, dashboard spec card, `renderSpecMarkdown`).  
**Out of this plan (unless explicitly added):** Task 8 renderer work — unified `renderPlanMarkdown` modes, `<details>` in `markdownToHtml`, extra unit tests for those modes.

## Goal

Align **human-facing instructions** and **internal documentation** with the shipped interactive planning protocol so that:

1. Live planner agents receive consistent persona + skill guidance for phase-aware output and tier rules.
2. QMD readers see accurate lifecycle, data model, and API descriptions (no stale single-gate / `stage=planner`-only narrative).

## Source of truth (read before editing prose)

Use these implementations as the contract to describe — do not invent behavior:

| Area | Files |
|------|--------|
| Parsed output shapes / phases | `src/types/core.ts` (`ParsedPlannerOutput`, `PlannerSpecArtifacts`, `PlanningContext`) |
| Parser rules | `src/orchestrator/planner-output.ts` |
| Prompt phase assembly, critique/blocking-question prefixes | `src/orchestrator/service.ts` (`buildPlannerPrompt` / planner dispatch helpers — locate via search) |
| Env budgets | `src/config/env.ts` (`PLANNER_MAX_ITERATIONS`, `PLANNER_SPEC_MAX_ITERATIONS`) |
| Transcript stages | `planner:spec`, `planner:execution_plan` (migration `011_spec_artifacts.sql`) |

Keep terminology aligned with the architectural plan: `/Users/jophie/.cursor/plans/interactive-planning_46c0ce85.plan.md` (especially **Task 5** persona/skill bullets and **Task 8** doc list).

---

## Workstream A — `skills/writing-plans.md`

**Objective:** Single skill file remains the protocol spec (locked decision); evolve it from subtasks-only JSON to the **V2 planner artifact contract**.

### Deliverables

1. **Version bump** in the skill header (e.g. v2.0 + date).
2. **Output contract section** documenting `.autoforge-status.json` fields the orchestrator consumes:
   - `status`, `artifacts`
   - `discovery`, `spec`, `planningContext`, `blockingQuestion`, `subtasks`
   - Note that `planningPhase` in JSON is informational; **authoritative phase comes from the `## Phase` block** in the user prompt (orchestrator-owned).
3. **Phase behavior** (what to emit when phase is `spec` vs `execution_plan` vs `combined`):
   - Spec: non-empty discovery/spec as required by tier; `subtasks` empty unless combined.
   - Execution plan: non-empty `subtasks`; may receive `## Approved Spec` in prompt — align subtasks to it.
   - Combined: full artifact in one response when prompted.
4. **Tier rules** (enforceable bullets, not vague guidance):
   - **EXPRESS:** No separate spec gate; combined/minimal spec when asked; keep discovery noise low per plan.
   - **STANDARD:** Minimum spec fields and counts per locked plan (e.g. problem, desiredBehavior ≥ 2, acceptanceCriteria ≥ 2, verification); `blockingQuestion` only when truly blocked.
   - **THOROUGH:** STANDARD requirements plus decisions with `alternativesRejected`; prefer one focused `blockingQuestion` when ambiguity remains vs guessing.
5. **QMD context gathering** — retain existing “query QMD first” flow; add one line that spec-phase planning should anchor **acceptance** and **verification** on QMD-backed conventions where relevant.

### Acceptance criteria

- [ ] Skill mentions **no separate interactive-spec file** (still one skill).
- [ ] Examples use valid JSON shapes (optional shortened examples for length).
- [ ] Tier tables do not contradict `PLANNER_*` iteration semantics (critique loops are orchestrator-enforced; skill describes what to output per attempt).

---

## Workstream B — `src/personas/planner.md`

**Objective:** Persona describes **role and quality bar**; orchestrator owns phase injection — avoid duplicating huge JSON schemas that drift from `writing-plans.md`.

### Deliverables

1. **Responsibilities split:** (a) assess task + tier, (b) produce **shared understanding** when in spec/combined phase, (c) produce **execution plan** when in execution/combined phase.
2. **Output pointer:** Single reference to `.autoforge-status.json` V2 and explicit pointer: “Follow `skills/writing-plans.md` for field-by-field requirements.”
3. **Blocking question policy:** Short alignment with tier rules (STANDARD vs THOROUGH).
4. **Anti-patterns:** e.g. emitting execution-shaped plans when phase asks for spec-only; silent guessing on THOROUGH when a single clarifying question would avoid rework.

### Acceptance criteria

- [ ] Persona does not redefine JSON schema in full duplicate of the skill (DRY).
- [ ] Subtasks ID convention (`<taskId>-subtask-N`) preserved where still required.

---

## Workstream C — QMD documentation

**Objective:** Remove stale lifecycle and schema descriptions; add spec gate, dual transcript stages, and dual iteration ceilings.

### Files and edits (minimum)

| Document | Updates |
|----------|---------|
| `docs/qmd/domain-task-orchestration.md` | Replace single “plan-review pause” narrative with **planning → awaiting_spec_approval → (planning) → awaiting_plan_approval** for STANDARD/THOROUGH + `reviewPlan: true`. Document **combined / `reviewPlan: false`** path (auto approval metadata). Planner transcripts: **`planner:spec`** vs **`planner:execution_plan`**; separate critique budgets (`PLANNER_SPEC_MAX_ITERATIONS` vs `PLANNER_MAX_ITERATIONS`). Refresh state diagram bullets. |
| `docs/qmd/data-models.md` | Extend `TaskStage` with `awaiting_spec_approval`. Document task projection fields: `specArtifacts`, `planningContext`, `currentBlockingQuestion`, `reviewPlan`. Update transcript stage examples away from sole `planner`. Mention `rollback_event_id` on transcripts if task rollback policy is user-visible. |
| `docs/qmd/architecture-overview.md` | Human gates: two-stage planning for STANDARD/THOROUGH; dashboard spec vs plan cards at high level. Fix any `stage: "planner"` examples to phase-specific stages. |
| `docs/qmd/domain-web-api.md` | `POST .../approve-spec`, `POST .../critique-spec`; `/api/config` includes `plannerSpecMaxIterations` (and keep `plannerMaxIterations`). |

### Optional consistency pass

- `docs/qmd/domain-agent-execution.md` — planner skill list still `writing-plans.md`; add footnote that output is phase-aware.
- `docs/qmd/configuration.md` — document `PLANNER_SPEC_MAX_ITERATIONS` if not already.

### Acceptance criteria

- [ ] No QMD file implies **only** `awaiting_plan_approval` between planning and executing for default STANDARD/THOROUGH behavior.
- [ ] Attempt-count narrative matches code: separate namespaces per transcript **stage**, not a single `planner` row mix.

---

## Execution order (recommended)

1. Read orchestrator prompt assembly + parser once (30 min).
2. **Workstream A** (`writing-plans.md`) — largest change; establishes quotes/examples other docs can cite.
3. **Workstream B** (`planner.md`) — short, references A.
4. **Workstream C** — update `domain-task-orchestration.md` first (longest), then `data-models.md`, then overview + web API.

---

## Verification (no new automated tests required for #6)

- [ ] Grep QMD for stale phrases: `awaiting_plan_approval` as the only planning gate, `stage = 'planner'` (as current stage), single “plan attempt counter” without stage qualifier — fix or qualify.
- [ ] Spot-check: submit STANDARD task with review on — dashboard labels and QMD doc sequence match.
- [ ] If personas/skills are loaded in CI or seed scripts, ensure no filename/path changes break imports (only content edits expected).

---

## Explicitly deferred (track separately)

- **Task 8 markdown:** merge spec into `renderPlanMarkdown`, `<details>` support in `markdownToHtml`, additional `plan-markdown.test.ts` cases — optional follow-up PR.
- **Planner prompt code changes** — only if doc review reveals mismatch; #6 is primarily documentation alignment, not behavior changes.

---

## Definition of done

`writing-plans.md` and `planner.md` describe phase-aware V2 output and tier rules consistent with code; QMD files listed under Workstream C are updated and internally consistent; verification checklist passed.
