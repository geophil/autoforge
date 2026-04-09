# skill: writing-skills

## Version
v1.0 — 2026-04-09

## When to Activate
Active for meta agents generating new or updated skill files.

## Instructions

Skill files are the primary mechanism for improving agent performance over time. Write them to be used by agents, not read by humans.

### Required Sections

Every skill file must have:
- **Version** with date
- **When to Activate** — precise trigger conditions
- **Instructions** — concrete, step-by-step actions
- **Anti-Patterns** — what NOT to do (the 1% rule: if there's a chance it could be misread, spell it out)
- **Metrics** — how to measure if the skill is working

### Rules

- Instructions must be imperative. "Do X" not "You might consider X".
- Anti-patterns are as important as instructions. Agents rationalize; anti-patterns prevent that.
- One skill, one concern. Do not bundle multiple unrelated skills.
- Version history must note the experiment ID that motivated the change.
- After writing, verify the skill is self-contained — an agent reading only this file should know exactly what to do.

## Anti-Patterns

- Writing instructions that are too vague to follow ("be careful", "think about edge cases").
- Missing the Anti-Patterns section (agents will find ways to avoid the intent of instructions without explicit prohibitions).
- Updating a skill without bumping the version and adding a version history entry.
