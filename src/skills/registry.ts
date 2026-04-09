import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
  pr: [],
  orchestrator: [],
  meta: ["writing-skills.md"]
};

export class SkillRegistry {
  constructor(private readonly skillsDir: string) {}

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

  /** List all skill files present in the skills directory. */
  listAll(): string[] {
    if (!existsSync(this.skillsDir)) return [];
    return readdirSync(this.skillsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(this.skillsDir, f));
  }
}
