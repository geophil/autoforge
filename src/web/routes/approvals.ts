import { Hono } from "hono";
import { z } from "zod";
import type { OrchestratorService } from "../../orchestrator/service";
import type { LiveEventHub } from "../events";

const RejectSchema = z.object({
  reason: z.string().min(1).default("Rejected by human reviewer.")
});

const CancelSchema = z.object({
  reason: z.string().min(1).default("Cancelled by operator.")
});

export function createApprovalRoutes(service: OrchestratorService, events: LiveEventHub): Hono {
  const app = new Hono();

  app.post("/:id/approve", async (ctx) => {
    const task = await service.approveTask(ctx.req.param("id"));
    events.publish({ type: "task.updated", data: task });
    return ctx.json(task);
  });

  app.post("/:id/reject", async (ctx) => {
    const payload = RejectSchema.parse(await ctx.req.json());
    const task = await service.rejectTask(ctx.req.param("id"), payload.reason);
    events.publish({ type: "task.updated", data: task });
    return ctx.json(task);
  });

  app.post("/:id/cancel", async (ctx) => {
    let reason = "Cancelled by operator.";
    try {
      const body = CancelSchema.parse(await ctx.req.json());
      reason = body.reason;
    } catch {
      // No body provided — use default reason.
    }
    const task = await service.cancelTask(ctx.req.param("id"), reason);
    events.publish({ type: "task.updated", data: task });
    return ctx.json(task);
  });

  return app;
}
