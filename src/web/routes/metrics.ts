import { Hono } from "hono";
import type { DbClient } from "../../db/client";
import {
  buildEnvelopeReuseProjectQuery,
  buildProjectTokenUsageQuery,
  buildRuntimeCacheKpiProjectQuery,
  computeRuntimeCacheKpiReport,
  computePlannerTokenKpis
} from "../token-kpi-utils";

export function createMetricsRoutes(db: DbClient): Hono {
  const app = new Hono();

  app.get("/:projectId", (ctx) => {
    return ctx.json(db.metricsForProject(ctx.req.param("projectId")));
  });

  app.get("/:projectId/trends", (ctx) => {
    return ctx.json({
      projectId: ctx.req.param("projectId"),
      points: []
    });
  });

  app.get("/:projectId/token-kpis", (ctx) => {
    const projectId = ctx.req.param("projectId");
    const windowDays = parsePositiveInt(ctx.req.query("windowDays"), 7, 1, 90);
    const query = buildProjectTokenUsageQuery(projectId, windowDays);
    const rows = db.sqlite.query(query.sql).all(...query.params) as Array<{
      stage: string;
      tokenInput: number;
      attempt: number;
    }>;
    const summary = computePlannerTokenKpis(rows);
    const plannerRows = rows.filter((row) =>
      row.stage === "planner:spec" || row.stage === "planner:execution_plan"
    ).length;
    return ctx.json({
      projectId,
      windowDays,
      plannerRows,
      summary
    });
  });

  app.get("/:projectId/envelope-reuse", (ctx) => {
    const projectId = ctx.req.param("projectId");
    const windowDays = parsePositiveInt(ctx.req.query("windowDays"), 7, 1, 90);
    const limit = parsePositiveInt(ctx.req.query("limit"), 10, 1, 100);
    const query = buildEnvelopeReuseProjectQuery(projectId, windowDays, limit);
    const rows = db.sqlite.query(query.sql).all(...query.params) as Array<{
      contextEnvelopeHash: string;
      occurrences: number;
      avgTokenInput: number;
    }>;
    return ctx.json({
      projectId,
      windowDays,
      limit,
      rows
    });
  });

  app.get("/:projectId/runtime-cache-kpis", (ctx) => {
    const projectId = ctx.req.param("projectId");
    const windowDays = parsePositiveInt(ctx.req.query("windowDays"), 7, 1, 90);
    const query = buildRuntimeCacheKpiProjectQuery(projectId, windowDays);
    const rows = db.sqlite.query(query.sql).all(...query.params) as Array<{
      stablePrefixHash: string | null;
      cachedInputTokens: number;
      inputTokens: number;
      estimatedCachedInputSavings: number;
      maxHistoryChars: number;
      toolOutputContributionBytes: number;
    }>;
    const report = computeRuntimeCacheKpiReport(rows);
    return ctx.json({
      projectId,
      windowDays,
      rows,
      summary: report.summary,
      stablePrefixes: report.stablePrefixes
    });
  });

  return app;
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
