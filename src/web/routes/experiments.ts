import { Hono } from "hono";
import type { OrchestratorService } from "../../orchestrator/service";

function mapError(err: unknown): { status: 400 | 404 | 409; body: { error: string } } {
  const message = err instanceof Error ? err.message : String(err);
  if (/experiment not found/i.test(message)) {
    return { status: 404, body: { error: "not_found" } };
  }
  if (/not a proposed fork|proposed content missing|evidence missing|parent variant not found/i.test(message)) {
    return { status: 409, body: { error: message } };
  }
  return { status: 400, body: { error: message } };
}

export function createExperimentsRoutes(service: OrchestratorService): Hono {
  const app = new Hono();

  app.post("/:id/approve-fork", async (ctx) => {
    try {
      const id = ctx.req.param("id");
      const result = await service.approveFork(id);
      return ctx.json({ ok: true, variantId: result.variantId }, 200);
    } catch (err) {
      const { status, body } = mapError(err);
      return ctx.json(body, status);
    }
  });

  return app;
}
