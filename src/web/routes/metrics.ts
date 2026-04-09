import { Hono } from "hono";
import type { DbClient } from "../../db/client";

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

  return app;
}
