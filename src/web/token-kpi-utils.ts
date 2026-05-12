export interface TokenKpiEventRow {
  stage: string;
  tokenInput: number;
  attempt?: number;
}

export interface PlannerTokenKpiSummary {
  plannerMedianInputTokens: number;
  totalInputTokens: number;
  plannerInputShare: number;
  plannerRetries: number;
}

const PLANNER_REDUCTION_TARGET_MIN = 0.2;

export function computePlannerTokenKpis(rows: TokenKpiEventRow[]): PlannerTokenKpiSummary {
  const plannerRows = rows.filter((row) =>
    row.stage === "planner:spec" || row.stage === "planner:execution_plan"
  );
  const plannerTokens = plannerRows.map((row) => row.tokenInput).sort((a, b) => a - b);
  const plannerMedianInputTokens = median(plannerTokens);
  const totalInputTokens = rows.reduce((sum, row) => sum + row.tokenInput, 0);
  const plannerInputTokens = plannerRows.reduce((sum, row) => sum + row.tokenInput, 0);
  const plannerInputShare = totalInputTokens > 0 ? plannerInputTokens / totalInputTokens : 0;
  const plannerRetries = plannerRows.filter((row) => (row.attempt ?? 0) > 0).length;
  return {
    plannerMedianInputTokens,
    totalInputTokens,
    plannerInputShare,
    plannerRetries
  };
}

export function plannerReductionAchieved(beforeMedianInputTokens: number, afterMedianInputTokens: number): number {
  if (beforeMedianInputTokens <= 0) return 0;
  const reduction = (beforeMedianInputTokens - afterMedianInputTokens) / beforeMedianInputTokens;
  return Math.max(0, reduction);
}

export function meetsPlannerReductionTarget(beforeMedianInputTokens: number, afterMedianInputTokens: number): boolean {
  return plannerReductionAchieved(beforeMedianInputTokens, afterMedianInputTokens) >= PLANNER_REDUCTION_TARGET_MIN;
}

export function buildPlannerTokenKpiQuery(windowDays: number): { sql: string; params: number[] } {
  return {
    sql: `
      SELECT
        CAST(json_extract(payload, '$.transcript_stage') AS TEXT) AS stage,
        token_input AS tokenInput,
        CAST(COALESCE(json_extract(payload, '$.attempt'), 0) AS INTEGER) AS attempt
      FROM events
      WHERE project_id = ?
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND token_input IS NOT NULL
        AND (
          json_extract(payload, '$.transcript_stage') = 'planner:spec'
          OR json_extract(payload, '$.transcript_stage') = 'planner:execution_plan'
        )
      ORDER BY timestamp ASC, rowid ASC
    `,
    params: [windowDays]
  };
}

export function buildPlannerTokenKpiProjectQuery(
  projectId: string,
  windowDays: number
): { sql: string; params: Array<string | number> } {
  const base = buildPlannerTokenKpiQuery(windowDays);
  return {
    sql: base.sql,
    params: [projectId, ...base.params]
  };
}

export function buildProjectTokenUsageQuery(
  projectId: string,
  windowDays: number
): { sql: string; params: Array<string | number> } {
  return {
    sql: `
      SELECT
        COALESCE(CAST(json_extract(payload, '$.transcript_stage') AS TEXT), event_type) AS stage,
        token_input AS tokenInput,
        CAST(COALESCE(json_extract(payload, '$.attempt'), 0) AS INTEGER) AS attempt
      FROM events
      WHERE project_id = ?
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND token_input IS NOT NULL
      ORDER BY timestamp ASC, rowid ASC
    `,
    params: [projectId, windowDays]
  };
}

export function buildEnvelopeReuseQuery(windowDays: number): { sql: string; params: number[] } {
  return {
    sql: `
      SELECT
        context_envelope_hash AS contextEnvelopeHash,
        COUNT(*) AS occurrences,
        AVG(token_input) AS avgTokenInput
      FROM events
      WHERE project_id = ?
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND token_input IS NOT NULL
        AND context_envelope_hash IS NOT NULL
      GROUP BY context_envelope_hash
      HAVING COUNT(*) > 1
      ORDER BY occurrences DESC, avgTokenInput DESC
      LIMIT ?
    `,
    params: [windowDays]
  };
}

export function buildEnvelopeReuseProjectQuery(
  projectId: string,
  windowDays: number,
  limit: number
): { sql: string; params: Array<string | number> } {
  const base = buildEnvelopeReuseQuery(windowDays);
  return {
    sql: base.sql,
    params: [projectId, ...base.params, limit]
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 0) {
    return (values[mid - 1] + values[mid]) / 2;
  }
  return values[mid];
}
