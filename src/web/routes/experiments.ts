import { Hono } from "hono";
import type { OrchestratorService } from "../../orchestrator/service";

function mapError(err: unknown): { status: 400 | 404 | 409; body: { error: string } } {
  const message = err instanceof Error ? err.message : String(err);
  if (/experiment not found/i.test(message)) {
    return { status: 404, body: { error: "not_found" } };
  }
  if (/not a proposed fork|proposed content missing|evidence missing|parent variant not found|fork proposal not open/i.test(message)) {
    return { status: 409, body: { error: message } };
  }
  return { status: 400, body: { error: message } };
}

export function createExperimentsRoutes(service: OrchestratorService): Hono {
  const app = new Hono();

  app.get("/", (ctx) => {
    const status = ctx.req.query("status");
    const operation = ctx.req.query("operation");
    if (status === "proposed" && operation === "fork") {
      return ctx.json({ experiments: service.listPendingForkExperiments() });
    }
    return ctx.json({ experiments: [] });
  });

  app.post("/:id/approve-fork", async (ctx) => {
    try {
      const id = ctx.req.param("id");
      const body = await ctx.req.json().catch(() => ({})) as {
        approver?: unknown;
        notes?: unknown;
      };
      const result = await service.approveFork(id, {
        approver: typeof body.approver === "string" ? body.approver : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined
      });
      return ctx.json({ ok: true, variantId: result.variantId }, 200);
    } catch (err) {
      const { status, body } = mapError(err);
      return ctx.json(body, status);
    }
  });

  app.post("/:id/reject-fork", async (ctx) => {
    try {
      const id = ctx.req.param("id");
      const body = await ctx.req.json().catch(() => ({})) as {
        reviewer?: unknown;
        reason?: unknown;
      };
      service.rejectFork(
        id,
        typeof body.reviewer === "string" ? body.reviewer : undefined,
        typeof body.reason === "string" ? body.reason : undefined
      );
      return ctx.json({ ok: true }, 200);
    } catch (err) {
      const { status, body } = mapError(err);
      return ctx.json(body, status);
    }
  });

  return app;
}
