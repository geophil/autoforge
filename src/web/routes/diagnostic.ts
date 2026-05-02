import { Hono } from "hono";
import type { OrchestratorService } from "../../orchestrator/service";
import type { AgentType } from "../../types/core";

const DIAGNOSTIC_AGENT_TYPES = ["planner", "coder", "reviewer", "doc"] as const;
type DiagnosticAgentType = typeof DIAGNOSTIC_AGENT_TYPES[number];

export function createDiagnosticRoutes(service: OrchestratorService): Hono {
  const app = new Hono();
  app.post("/run", async (ctx) => {
    const body = await ctx.req.json().catch(() => ({})) as { agentType?: unknown };
    const agentType = body.agentType ?? "coder";
    if (!isDiagnosticAgentType(agentType)) {
      return ctx.json({ error: "agentType must be one of: planner, coder, reviewer, doc" }, 400);
    }
    const result = await service.runPopulationDiagnostic(agentType, "manual");
    return ctx.json({ ok: true, agentType, clustersProposed: result.clustersProposed });
  });
  return app;
}

function isDiagnosticAgentType(value: unknown): value is DiagnosticAgentType & AgentType {
  return typeof value === "string" && DIAGNOSTIC_AGENT_TYPES.includes(value as DiagnosticAgentType);
}
