# Complexity And Policy Routing

This domain classifies incoming tasks once and turns that decision into tier,
model, tool, retry, and review policy. The policy layer is intentionally
auditable: the deterministic scan, optional low-cost LLM classification, and
final merged decision are recorded in `task_policy_decision` events.

## Business Rules And Invariants

### One Task Policy Decision Owns Routing

`decideTaskPolicy()` returns a `TaskPolicyDecision` with:

- task type (`bugfix`, `feature`, `refactor`, `migration`, `infrastructure`,
  `security`, `documentation`, or `unknown`)
- risk level (`low`, `medium`, `high`)
- sensitive areas
- confidence and input signals
- budget class
- tier (`EXPRESS`, `STANDARD`, `THOROUGH`)
- model floor
- required gates
- tool policy
- retry policy

Legacy `assessComplexity()` remains as a compatibility wrapper over the
deterministic task policy so existing task rows and API shapes keep their
`ComplexityAssessment` payload.

### Deterministic Guardrails Have Veto Power

The deterministic scanner checks task text and file scope for sensitive areas
such as auth, permissions, secrets, payments, database schema/migrations,
production infrastructure, security, customer-facing behavior, and
orchestrator/runtime code.

Hard high-risk signals force high risk. The LLM classifier can upgrade risk,
but it cannot downgrade deterministic high-risk signals.

### Low-Cost LLM Classification Is Advisory

When configured for a real harness runtime, Autoforge uses a no-tool utility
model call with purpose `classification` to classify task type, risk, sensitive
areas, confidence, rationale, and signals. It uses the same utility-model
selection knobs as other bounded helper calls:

- `HARNESS_CLASSIFICATION_MODEL`
- `HARNESS_CLASSIFICATION_TIMEOUT_SECONDS`
- `HARNESS_CLASSIFICATION_MAX_TOKENS`
- `MODEL_TIER_CHEAP`

If the classifier errors, times out, or returns invalid JSON, Autoforge falls
back to deterministic-only policy and records the fallback in the policy event.

### Tier Mapping

The final merged risk level maps to task tier:

| Risk | Tier |
|---|---|
| `low` | `EXPRESS` |
| `medium` | `STANDARD` |
| `high` | `THOROUGH` |

Operator `forceTier` still overrides the final tier and is recorded as a tier
override in the policy source metadata.

### Tool Policy Scopes QMD

QMD access is no longer exposed to every task-facing agent just because
`QMD_MCP_URL` is configured.

- Planner receives QMD for task scoping and evidence.
- Doc/doc-review receives QMD only for documentation or architecture-grounding
  policies.
- Coder and reviewer do not receive QMD by default.

## Integration Points

- **Task Orchestration**: `submitTask()` creates and records the policy before
  planning proceeds.
- **Model Routing**: `routeModel()` consumes `TaskPolicyDecision` as the model
  floor and sensitive-area source, while still allowing file-scope escalation.
- **Agent Environment**: `agentEnvironment()` exposes QMD according to
  `policy.toolPolicy`.
- **Telemetry**: `agent_runtime_telemetry` includes compact policy context so
  cost and success can be evaluated by task type, risk, and tool policy.

## File Map

| File | Purpose |
|------|---------|
| `src/orchestrator/task-policy.ts` | Hybrid deterministic + utility-LLM policy decision |
| `src/assessment/tier.ts` | Compatibility wrapper for legacy complexity assessment |
| `src/orchestrator/model-routing.ts` | Model-tier projection from policy and failures |
| `src/orchestrator/service.ts` | Policy event emission and policy-scoped environment |
