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

function mapServiceError(err: unknown): { status: 400 | 404 | 409; body: { error: string } } {
  const message = err instanceof Error ? err.message : String(err);
  if (/not found/i.test(message)) {
    return { status: 404, body: { error: "not_found" } };
  }
  if (/terminal state|must be archived/i.test(message)) {
    return { status: 409, body: { error: message } };
  }
  return { status: 400, body: { error: message } };
}

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
    const archived = ctx.req.query("archived");
    const includeArchived = ctx.req.query("includeArchived");
    if (archived === "true") {
      return ctx.json(service.listTasks({ onlyArchived: true }));
    }
    if (includeArchived === "true") {
      return ctx.json(service.listTasks({ includeArchived: true }));
    }
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

  app.post("/:id/archive", async (ctx) => {
    try {
      const task = await service.archiveTask(ctx.req.param("id"));
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const { status, body } = mapServiceError(err);
      return ctx.json(body, status);
    }
  });

  app.post("/:id/unarchive", async (ctx) => {
    try {
      const task = await service.unarchiveTask(ctx.req.param("id"));
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const { status, body } = mapServiceError(err);
      return ctx.json(body, status);
    }
  });

  app.delete("/:id", async (ctx) => {
    const id = ctx.req.param("id");
    try {
      await service.deleteTaskPermanently(id);
      events.publish({ type: "task.deleted", data: { taskId: id } });
      return ctx.json({ ok: true });
    } catch (err) {
      const { status, body } = mapServiceError(err);
      return ctx.json(body, status);
    }
  });

  return app;
}
