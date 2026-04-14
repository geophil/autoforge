import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "../db/client";
import type { AgentType } from "../types/core";

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

  /**
   * Resolve and snapshot the persona for an agent type into skill_versions.
   * Returns the skill_versions.id for use in event provenance.
   */
  snapshotId(agentType: AgentType): string {
    const content = this.resolve(agentType);
    return this.db.upsertPromptAsset(`persona:${agentType}`, content);
  }
}
