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

const CritiqueSchema = z.object({
  critique: z.string().min(1).max(4000)
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

  app.post("/:id/approve-plan", async (ctx) => {
    const task = await service.approvePlan(ctx.req.param("id"));
    events.publish({ type: "task.updated", data: task });
    return ctx.json(task);
  });

  app.post("/:id/critique-plan", async (ctx) => {
    let body: { critique: string };
    try {
      body = CritiqueSchema.parse(await ctx.req.json());
    } catch (err) {
      return ctx.json({ error: "invalid_body", details: err instanceof Error ? err.message : String(err) }, 400);
    }
    try {
      const task = await service.critiquePlan(ctx.req.param("id"), body.critique);
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("limit")) return ctx.json({ error: "iteration_limit_reached", message: msg }, 409);
      return ctx.json({ error: "critique_failed", message: msg }, 400);
    }
  });

  return app;
}
