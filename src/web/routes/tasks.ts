import { Hono } from "hono";
import { z } from "zod";
import type { OrchestratorService } from "../../orchestrator/service";
import type { LiveEventHub } from "../events";
import type { DbClient } from "../../db/client";

const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  description: z.string().min(1),
  reviewPlan: z.boolean().optional(),
  forceTier: z.enum(["EXPRESS", "STANDARD", "THOROUGH"]).optional()
});

export function createTaskRoutes(service: OrchestratorService, events: LiveEventHub, db: DbClient): Hono {
  const app = new Hono();

  app.post("/", async (ctx) => {
    const body = CreateTaskSchema.parse(await ctx.req.json());
    const task = await service.submitTask(body.projectId, body.description, {
      reviewPlan: body.reviewPlan,
      forceTier: body.forceTier
    });
    events.publish({ type: "task.updated", data: task });
    return ctx.json(task, 201);
  });

  app.get("/", (ctx) => {
    return ctx.json(service.listTasks());
  });

  app.get("/:id", (ctx) => {
    const task = service.getTask(ctx.req.param("id"));
    if (!task) {
      return ctx.json({ error: "not_found" }, 404);
    }
    return ctx.json(task);
  });

  app.get("/:id/events", (ctx) => {
    return ctx.json(db.listEvents(ctx.req.param("id")));
  });

  return app;
}
