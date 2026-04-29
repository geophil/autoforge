import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient, type ForkProposalInsert } from "../../src/db/client";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "fork-proposals-schema-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

function validProposal(overrides: Partial<ForkProposalInsert> = {}): ForkProposalInsert {
  return {
    id: randomUUID(),
    agentType: "coder",
    label: "UI repair cluster",
    keywords: "ui,repair",
    suggestedSpecialty: "ui-repair",
    representativeTaskIds: ["task-1", "task-2"],
    baselineScoreMean: 0.42,
    populationScoreMean: 0.67,
    scoreGap: 0.25,
    recommendationStrength: "moderate",
    ...overrides
  };
}

describe("fork_proposals schema", () => {
  test("table and open index exist", () => {
    const db = freshDb();
    const cols = db.sqlite.query("PRAGMA table_info(fork_proposals)").all() as Array<{ name: string; type: string; notnull: number }>;
    const names = cols.map((col) => col.name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "agent_type", "generated_at", "generator", "label", "keywords",
      "suggested_specialty", "representative_task_ids", "baseline_score_mean",
      "population_score_mean", "score_gap", "recommendation_strength",
      "status", "acted_on_experiment_id", "closed_at"
    ]));
    expect(cols.find((col) => col.name === "agent_type")?.notnull).toBe(1);

    const indexes = db.sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='fork_proposals'").all() as Array<{ name: string }>;
    expect(indexes.map((idx) => idx.name)).toContain("idx_fork_proposals_open");
  });

  test("constraint failures are not ignored when inserting proposals", () => {
    const db = freshDb();

    expect(() => db.insertForkProposal(validProposal({
      recommendationStrength: "invalid" as never
    }))).toThrow();

    expect(db.listOpenForkProposals()).toHaveLength(0);
  });

  test("duplicate proposal ids are ignored without adding rows", () => {
    const db = freshDb();
    const proposal = validProposal({ id: "duplicate-proposal" });

    expect(db.insertForkProposal(proposal)).toBe(true);
    expect(db.insertForkProposal(proposal)).toBe(false);

    expect(db.listOpenForkProposals()).toHaveLength(1);
  });
});
