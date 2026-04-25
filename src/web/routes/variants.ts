import { Hono } from "hono";
import type { DbClient } from "../../db/client";
import type { AgentType } from "../../types/core";

const RECENT_WINDOW = { limit: 50, maxAgeDays: 3650 };
const RECENT_SHADOW_WINDOW = { limit: 50 };
const STATUS_ORDER: Record<string, number> = {
  baseline: 0,
  active: 1,
  candidate: 2,
  demoted: 3,
  retired: 4
};

export function createVariantsRoutes(db: DbClient): Hono {
  const app = new Hono();

  app.get("/:id/scores", (ctx) => {
    const variantId = ctx.req.param("id");
    const scores = db.loadRecentSelectedTaskScores(variantId, RECENT_WINDOW);
    return ctx.json({ variantId, scores });
  });

  app.get("/:id/shadow", (ctx) => {
    const variantId = ctx.req.param("id");
    const shadowRuns = db.loadRecentShadowRuns(variantId, RECENT_SHADOW_WINDOW);
    return ctx.json({ variantId, shadowRuns });
  });

  app.get("/:agentType", (ctx) => {
    const agentType = ctx.req.param("agentType");
    const variants = db.loadDispatchPopulation(agentType as AgentType)
      .map((row) => ({
        id: row.id,
        agentType,
        status: row.status,
        trafficShare: row.traffic_share,
        specialty: row.specialty,
        parentVersionId: row.parent_version_id,
        createdAt: row.created_at
      }))
      .sort((left, right) => {
        const statusDelta = (STATUS_ORDER[left.status] ?? 99) - (STATUS_ORDER[right.status] ?? 99);
        if (statusDelta !== 0) return statusDelta;
        return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
      });
    return ctx.json({ agentType, variants });
  });

  return app;
}
