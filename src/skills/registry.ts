import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { DbClient } from "../db/client";
import type { AgentType } from "../types/core";

/**
 * Maps each agent type to the skill filenames that always apply to it.
 * The 1% rule: if there's any plausible match, include the skill.
 */
const AGENT_SKILLS: Record<AgentType, string[]> = {
  planner: ["writing-plans.md"],
  coder: ["tdd.md", "systematic-debugging.md", "verification-before-completion.md"],
  reviewer: ["two-stage-review.md"],
  doc: ["documentation.md"],
  "doc-review": ["documentation.md", "verification-before-completion.md"],
  pr: [],
  orchestrator: [],
  meta: ["writing-skills.md"],
  reflector: []
};

export class SkillRegistry {
  constructor(
    private readonly skillsDir: string,
    private readonly db?: DbClient
  ) {}

  /**
   * Returns absolute paths to skill files for the given agent type.
   * Only includes files that actually exist on disk.
   */
  skillsForAgent(agentType: AgentType): string[] {
    if (!existsSync(this.skillsDir)) return [];

    const filenames = AGENT_SKILLS[agentType] ?? [];
    return filenames
      .map((filename) => join(this.skillsDir, filename))
      .filter((filePath) => existsSync(filePath));
  }

  /**
   * Snapshot all skill files for an agent type into skill_versions.
   * Returns an array of skill_versions.id values for event provenance.
   * Requires db to be provided at construction time.
   */
  snapshotIds(agentType: AgentType): string[] {
    if (!this.db) return [];
    const paths = this.skillsForAgent(agentType);
    return paths.map((filePath) => {
      try {
        const content = readFileSync(filePath, "utf8").trim();
        const skillName = `skill:${basename(filePath, ".md")}`;
        return this.db!.upsertPromptAsset(skillName, content);
      } catch {
        return "";
      }
    }).filter(Boolean);
  }

  /** List all skill files present in the skills directory. */
  listAll(): string[] {
    if (!existsSync(this.skillsDir)) return [];
    return readdirSync(this.skillsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(this.skillsDir, f));
  }
}
