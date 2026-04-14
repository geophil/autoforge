import { Hono } from "hono";
import { z } from "zod";
import type { OrchestratorService } from "../../orchestrator/service";

const SubmitMetaSchema = z.object({
  projectId: z.string().min(1),
  focus: z.string().optional()
});

const ConcludeExperimentSchema = z.object({
  metricAfter: z.number(),
  keep: z.boolean()
});

export function createMetaRoutes(service: OrchestratorService): Hono {
  const app = new Hono();

  // Trigger a meta agent session to analyze performance and propose an improvement.
  app.post("/", async (ctx) => {
    const body = SubmitMetaSchema.parse(await ctx.req.json());
    const result = await service.submitMetaTask(body.projectId, body.focus);
    return ctx.json(result, result.experimentId ? 201 : 200);
  });

  // Conclude an experiment after observing canary outcomes.
  app.post("/:experimentId/conclude", async (ctx) => {
    const { experimentId } = ctx.req.param();
    const body = ConcludeExperimentSchema.parse(await ctx.req.json());
    await service.concludeExperiment(experimentId, body.metricAfter, body.keep);
    return ctx.json({ ok: true });
  });

  return app;
}
