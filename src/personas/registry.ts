import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "../db/client";
import type { AgentType } from "../types/core";
import { adjustVariantAllocation } from "../orchestrator/allocation";

export class PersonaRegistry {
  constructor(
    private readonly db: DbClient,
    private readonly personasDir: string
  ) {}

  /**
   * Resolve the active persona for an agent type.
   * Priority: DB (meta-loop refined) → file on disk (seed) → minimal fallback.
   */
  resolve(agentType: AgentType): string {
    const fromDb = this.db.getActivePersona(agentType);
    if (fromDb) return fromDb;

    const filePath = join(this.personasDir, `${agentType}.md`);
    if (existsSync(filePath)) return readFileSync(filePath, "utf8").trim();

    return `You are an autonomous ${agentType} agent. Complete your assigned task and write .autoforge-status.json when done.`;
  }

  resolveVariant(variantId: string, fallbackAgentType: AgentType): string {
    const row = this.db.sqlite
      .query("SELECT content FROM skill_versions WHERE id = ? LIMIT 1")
      .get(variantId) as { content: string } | null;
    return row?.content ?? this.resolve(fallbackAgentType);
  }

  /**
   * Resolve and snapshot the persona for an agent type into skill_versions.
   * Returns the skill_versions.id for use in event provenance.
   */
  snapshotId(agentType: AgentType): string {
    const content = this.resolve(agentType);
    return this.db.upsertPromptAsset(`persona:${agentType}`, content);
  }

  ensureDispatchBaseline(agentType: AgentType): void {
    const rows = this.db.sqlite.query(
      "SELECT id, status, traffic_share FROM skill_versions WHERE skill_name = ? AND status IN ('baseline', 'active', 'candidate')"
    ).all(`persona:${agentType}`) as Array<{ id: string; status: string; traffic_share: number }>;
    const baselineRows = rows.filter((row) => row.status === "baseline");
    if (baselineRows.length > 0) {
      if (rows.length > 1) {
        for (const baseline of baselineRows) {
          if (baseline.traffic_share > 0.9) {
            adjustVariantAllocation(
              this.db,
              baseline.id,
              { kind: "demote", delta: baseline.traffic_share - 0.9 },
              "dispatch_bootstrap",
              { reason: "normalize_baseline_share_before_dispatch" }
            );
          }
        }
      }
      return;
    }

    const activeRows = rows.filter((row) => row.status === "active");
    if (activeRows.length !== 1) return;
    const baselineShare = rows.length > 1 ? 0.9 : 1.0;

    adjustVariantAllocation(
      this.db,
      activeRows[0].id,
      { kind: "set_status", newStatus: "baseline", newTrafficShare: baselineShare },
      "dispatch_bootstrap",
      { reason: "normalize_active_persona_before_dispatch" }
    );
  }
}
