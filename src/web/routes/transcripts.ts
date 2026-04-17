import { Hono } from "hono";
import type { DbClient } from "../../db/client";

export function createTranscriptsRoutes(db: DbClient): Hono {
  const app = new Hono();

  app.get("/by-task/:taskId", (ctx) => {
    return ctx.json(db.listTranscriptsByTask(ctx.req.param("taskId")));
  });

  app.get("/:id", (ctx) => {
    const row = db.getTranscript(ctx.req.param("id"));
    if (!row) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(row);
  });

  return app;
}
