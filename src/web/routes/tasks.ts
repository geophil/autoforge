import { Hono } from "hono";
import { z } from "zod";
import type { OrchestratorService } from "../../orchestrator/service";
import type { LiveEventHub } from "../events";

const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  description: z.string().min(1)
});

export function createTaskRoutes(service: OrchestratorService, events: LiveEventHub): Hono {
  const app = new Hono();

  app.post("/", async (ctx) => {
    const body = CreateTaskSchema.parse(await ctx.req.json());
    const task = await service.submitTask(body.projectId, body.description);
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

  return app;
}
