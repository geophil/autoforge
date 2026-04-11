# Complexity Assessment and Tier Routing

This domain is responsible for classifying incoming task descriptions along four complexity dimensions and mapping that classification to an execution tier (EXPRESS / STANDARD / THOROUGH). The tier controls which agents run, how much time they get, and whether review is required. All logic is purely heuristic — keyword and word-count matching with no external calls.

## Business Rules and Invariants

### Tier Determines Agent Budget and Whether Review Runs

EXPRESS skips the reviewer entirely. STANDARD and THOROUGH both run the reviewer, but with different time budgets. See `domain-task-orchestration.md` > Business Rules for the full budget table.

```typescript
// src/assessment/tier.ts
export function routeTier(assessment: ComplexityAssessment): Tier {
  if (
    assessment.scope === "large"   ||
    assessment.novelty === "high"  ||
    assessment.risk === "high"     ||
    assessment.coupling === "high"
  ) return "THOROUGH";

  if (
    assessment.scope === "medium"   ||
    assessment.novelty === "medium" ||
    assessment.risk === "medium"    ||
    assessment.coupling === "medium"
  ) return "STANDARD";

  return "EXPRESS";
}
```

**Rule**: a single "high" dimension on any axis forces THOROUGH. A single "medium" forces STANDARD. Only all-low → EXPRESS.

**Enforced in**: `src/assessment/tier.ts:29`

### Risk Is Keyword-Driven

Words like "security", "payment", "auth", "migration", "critical" trigger `high` risk. "dashboard", "workflow", "pipeline", "integration", "api" trigger `medium`.

```typescript
// src/assessment/tier.ts
const highRiskKeywords = ["security", "payment", "auth", "migration", "critical"];
const mediumKeywords   = ["dashboard", "workflow", "pipeline", "integration", "api"];

const risk = highRiskKeywords.some((key) => normalized.includes(key))
  ? "high"
  : mediumKeywords.some((key) => normalized.includes(key))
    ? "medium"
    : "low";
```

**Enforced in**: `src/assessment/tier.ts:6`

### Scope Is Word-Count-Driven

```typescript
// src/assessment/tier.ts
const wordCount = normalized.split(/\s+/).filter(Boolean).length;
const scope = wordCount > 40 ? "large" : wordCount > 12 ? "medium" : "small";
```

Descriptions over 40 words → `large`. 13–40 words → `medium`. ≤12 words → `small`.

### Novelty and Coupling Are Simple Keyword Checks

```typescript
// src/assessment/tier.ts
const novelty  = normalized.includes("new") ? "high" : "medium";
const coupling = normalized.includes("across") || normalized.includes("multiple") ? "high" : "low";
```

Note: novelty defaults to `"medium"` (never `"low"`), so even the simplest request gets at least STANDARD tier unless scope and risk are also low.

## Decision Points

### Full Assessment → Tier Mapping

```
scope=small + novelty=medium + risk=low + coupling=low  → EXPRESS
scope=medium (any) OR risk=medium (any)                  → STANDARD
scope=large OR novelty=high OR risk=high OR coupling=high → THOROUGH
```

Because novelty can never be `"low"`, a request with no keywords and ≤12 words produces:
`{ scope: "small", novelty: "medium", risk: "low", coupling: "low" }` → **STANDARD** (novelty=medium triggers it).

A completely empty description would still be STANDARD.

## Data Entities

```typescript
// src/types/core.ts
export type Tier = "EXPRESS" | "STANDARD" | "THOROUGH";

export interface ComplexityAssessment {
  scope:    "small" | "medium" | "large";
  novelty:  "low"   | "medium" | "high";
  risk:     "low"   | "medium" | "high";
  coupling: "low"   | "medium" | "high";
  rationale: string;
  similarPastTasks: string[];
}
```

`similarPastTasks` is populated by the heuristic as an empty array; the field is reserved for future meta-loop calibration data. See `domain-event-sourcing.md` > `routing_calibration` table.

## Integration Points

- **Task Orchestration**: `assessComplexity` and `routeTier` are called immediately in `submitTask`. Result is stored in the `created` event payload and persisted to the `tasks` table as the `assessment` column (JSON).
- **Meta-Loop (future)**: The `routing_calibration` table records hindsight assessment — whether the assigned tier was appropriate — enabling the meta-loop to improve routing over time.

## File Map

| File | Purpose |
|------|---------|
| `src/assessment/tier.ts` | `assessComplexity()` and `routeTier()` — all heuristic logic |
| `src/types/core.ts` | `Tier` and `ComplexityAssessment` type definitions |
| `src/db/schema.sql` | `routing_calibration` table for hindsight tier feedback |
