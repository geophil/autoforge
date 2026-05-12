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

const RetrySchema = z.object({
  fromStage: z.enum(["planning", "executing"]).optional(),
  checkpointId: z.string().min(1).optional(),
  operatorNote: z.string().min(1).max(4000).optional(),
  planningPhase: z.enum(["spec", "execution_plan"]).optional(),
  resumeSubtaskId: z.string().min(1).optional(),
  forceFullReplay: z.boolean().optional(),
  /**
   * Acknowledged-override for the `cannot_rollback_to_approved_spec` guard.
   * Required when the operator wants to redo a spec phase that was already
   * approved, but is NOT rolling back to a spec-phase checkpoint.
   */
  force: z.boolean().optional()
});

const SteerSchema = z.object({
  message: z.string().min(1).max(4000),
  // V1 supports next_attempt only. Reserved future values:
  // - task_lifetime: apply on every dispatch until task terminates.
  // - until_revoked: apply until a dedicated steering_revoked event.
  scope: z.literal("next_attempt")
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
    try {
      const task = await service.approvePlan(ctx.req.param("id"));
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Cannot approve plan:")) {
        return ctx.json({ error: "invalid_state", message: msg }, 409);
      }
      throw err;
    }
  });

  app.post("/:id/retry", async (ctx) => {
    let fromStage: "planning" | "executing" | undefined;
    let checkpointId: string | undefined;
    let planningPhase: "spec" | "execution_plan" | undefined;
    let resumeSubtaskId: string | undefined;
    let forceFullReplay: boolean | undefined;
    let operatorNote: string | undefined;
    let force: boolean | undefined;
    try {
      const body = RetrySchema.parse(await ctx.req.json().catch(() => ({})));
      fromStage = body.fromStage;
      checkpointId = body.checkpointId;
      operatorNote = body.operatorNote;
      planningPhase = body.planningPhase;
      resumeSubtaskId = body.resumeSubtaskId;
      forceFullReplay = body.forceFullReplay;
      force = body.force;
    } catch (err) {
      return ctx.json({ error: "invalid_body", details: err instanceof Error ? err.message : String(err) }, 400);
    }
    try {
      const task = await service.retryFromIntervention(ctx.req.param("id"), {
        fromStage,
        checkpointId,
        operatorNote,
        planningPhase,
        resumeSubtaskId,
        forceFullReplay,
        force
      });
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Cannot retry:")) {
        return ctx.json({ error: "invalid_state", message: msg }, 409);
      }
      // Rollback failures (state is incompatible with the requested rollback)
      // are surfaced as HTTP 409 so the dashboard can show them inline without
      // dropping the operator note. `checkpoint_stage_after_retry_stage` is
      // operator input validation, so it stays 400.
      const rollbackConflictErrors = new Set([
        "checkpoint_unreachable",
        "checkpoint_not_found",
        "invalid_worktree_path",
        "cannot_rollback_to_approved_spec"
      ]);
      if (rollbackConflictErrors.has(msg)) {
        return ctx.json({ error: msg, message: msg }, 409);
      }
      if (msg === "checkpoint_stage_after_retry_stage") {
        return ctx.json({ error: msg, message: msg }, 400);
      }
      if (msg.startsWith("Retry from stage")) {
        return ctx.json({ error: "unsupported_stage", message: msg }, 400);
      }
      return ctx.json({ error: "retry_failed", message: msg }, 400);
    }
  });

  app.post("/:id/steer", async (ctx) => {
    let body: { message: string; scope: "next_attempt" };
    try {
      body = SteerSchema.parse(await ctx.req.json());
    } catch (err) {
      return ctx.json({ error: "invalid_body", details: err instanceof Error ? err.message : String(err) }, 400);
    }
    try {
      const task = service.addSteeringMessage(ctx.req.param("id"), body.message, body.scope);
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Cannot steer")) {
        return ctx.json({ error: "invalid_state", message: msg }, 409);
      }
      if (msg === "unsupported_steering_scope") {
        return ctx.json({ error: "unsupported_scope", message: msg }, 400);
      }
      return ctx.json({ error: "steer_failed", message: msg }, 400);
    }
  });

  app.post("/:id/approve-spec", async (ctx) => {
    try {
      const task = await service.approveSpec(ctx.req.param("id"));
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Cannot approve spec:")) {
        return ctx.json({ error: "invalid_state", message: msg }, 409);
      }
      throw err;
    }
  });

  app.post("/:id/critique-spec", async (ctx) => {
    let body: { critique: string };
    try {
      body = CritiqueSchema.parse(await ctx.req.json());
    } catch (err) {
      return ctx.json({ error: "invalid_body", details: err instanceof Error ? err.message : String(err) }, 400);
    }
    try {
      const task = await service.critiqueSpec(ctx.req.param("id"), body.critique);
      events.publish({ type: "task.updated", data: task });
      return ctx.json(task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("iteration limit")) {
        return ctx.json({ error: "iteration_limit_reached", message: msg }, 409);
      }
      if (msg.startsWith("Cannot critique spec:")) {
        return ctx.json({ error: "invalid_state", message: msg }, 409);
      }
      return ctx.json({ error: "critique_failed", message: msg }, 400);
    }
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
      // Match the orchestrator's specific iteration-limit phrasing to avoid
      // false positives from unrelated "limit" words (e.g. "rate limit").
      if (msg.includes("iteration limit")) {
        return ctx.json({ error: "iteration_limit_reached", message: msg }, 409);
      }
      if (msg.startsWith("Cannot critique plan:")) {
        return ctx.json({ error: "invalid_state", message: msg }, 409);
      }
      return ctx.json({ error: "critique_failed", message: msg }, 400);
    }
  });

  return app;
}
