import { Hono } from "hono";
import { z } from "zod";
import type { OrchestratorService } from "../../orchestrator/service";
import type { LiveEventHub } from "../events";

const RejectionCategoryEnum = z.enum([
  "stale_base", "wrong_scope", "incomplete",
  "incorrect_output", "quality_issues", "other"
]);

// NOTE: the response to POST /:id/reject is the NEW (restart) task,
// not the original. The original task will be in state "failed".
const RejectSchema = z.object({
  reason: z.string().min(1),
  guidance: z.string().optional(),
  categories: z.array(RejectionCategoryEnum).optional()
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
    const feedback = RejectSchema.parse(await ctx.req.json());
    const task = await service.rejectTask(ctx.req.param("id"), feedback);
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
