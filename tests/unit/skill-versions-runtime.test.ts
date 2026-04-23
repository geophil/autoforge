import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";

type SkillVersionRow = {
  id: string;
  status: string;
  traffic_share: number;
  is_active: number;
  experiment_id: string | null;
};

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "skill-versions-runtime-test-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

function getSkillVersion(db: DbClient, id: string): SkillVersionRow {
  return db.sqlite
    .query(
      "SELECT id, status, traffic_share, is_active, experiment_id FROM skill_versions WHERE id = ?"
    )
    .get(id) as SkillVersionRow;
}

function listLiveSkillVersions(db: DbClient, skillName: string): SkillVersionRow[] {
  return db.sqlite
    .query(
      "SELECT id, status, traffic_share, is_active, experiment_id FROM skill_versions WHERE skill_name = ? AND status IN ('baseline', 'active') ORDER BY created_at DESC, id DESC"
    )
    .all(skillName) as SkillVersionRow[];
}

describe("DbClient skill_versions runtime behavior after population migration", () => {
  test("upsertPromptAsset leaves exactly one live row for the asset", () => {
    const db = freshDb();

    const firstId = db.upsertPromptAsset("persona:coder", "hello");
    expect(db.getActiveSkillId("persona:coder")).toBe(firstId);

    let liveRows = listLiveSkillVersions(db, "persona:coder");
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].id).toBe(firstId);

    const firstRow = getSkillVersion(db, firstId);
    expect(firstRow.status).toBe("active");
    expect(firstRow.traffic_share).toBe(1.0);
    expect(firstRow.is_active).toBe(1);

    const secondId = db.upsertPromptAsset("persona:coder", "goodbye");
    expect(db.getActiveSkillId("persona:coder")).toBe(secondId);

    liveRows = listLiveSkillVersions(db, "persona:coder");
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].id).toBe(secondId);

    const demotedRow = getSkillVersion(db, firstId);
    expect(demotedRow.status).toBe("demoted");
    expect(demotedRow.traffic_share).toBe(0.0);
    expect(demotedRow.is_active).toBe(0);
  });

  test("activateProposedVersion leaves the proposed version live", () => {
    const db = freshDb();
    const seedId = db.upsertPromptAsset("persona:coder", "seed");
    const experimentId = db.createExperiment({
      hypothesis: "candidate improves coder quality",
      skillModified: "persona:coder",
      agentAffected: "coder",
      changeDescription: "promote candidate",
      metricName: "reward",
      metricBefore: 0.4
    });

    const proposedId = db.activateProposedVersion(experimentId, "persona:coder", "candidate");

    expect(proposedId).not.toBe(seedId);
    expect(db.getActiveSkillId("persona:coder")).toBe(proposedId);

    const liveRows = listLiveSkillVersions(db, "persona:coder");
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].id).toBe(proposedId);

    const proposedRow = getSkillVersion(db, proposedId);
    expect(proposedRow.status).toBe("active");
    expect(proposedRow.traffic_share).toBe(1.0);
    expect(proposedRow.is_active).toBe(1);
    expect(proposedRow.experiment_id).toBe(experimentId);

    const seedRow = getSkillVersion(db, seedId);
    expect(seedRow.status).toBe("demoted");
    expect(seedRow.is_active).toBe(0);

    const experimentRow = db.sqlite
      .query("SELECT status FROM experiments WHERE id = ?")
      .get(experimentId) as { status: string };
    expect(experimentRow.status).toBe("active");
  });

  test("discarding an experiment reactivates the prior kept or seed version", () => {
    const db = freshDb();
    const seedId = db.upsertPromptAsset("persona:coder", "seed");
    const experimentId = db.createExperiment({
      hypothesis: "candidate hurts coder quality",
      skillModified: "persona:coder",
      agentAffected: "coder",
      changeDescription: "test candidate",
      metricName: "reward",
      metricBefore: 0.6
    });
    const proposedId = db.activateProposedVersion(experimentId, "persona:coder", "candidate");

    db.concludeExperiment(experimentId, 0.2, false);

    expect(db.getActiveSkillId("persona:coder")).toBe(seedId);

    const liveRows = listLiveSkillVersions(db, "persona:coder");
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0].id).toBe(seedId);

    const seedRow = getSkillVersion(db, seedId);
    expect(seedRow.status).toBe("active");
    expect(seedRow.traffic_share).toBe(1.0);
    expect(seedRow.is_active).toBe(1);

    const proposedRow = getSkillVersion(db, proposedId);
    expect(proposedRow.status).toBe("demoted");
    expect(proposedRow.traffic_share).toBe(0.0);
    expect(proposedRow.is_active).toBe(0);

    const experimentRow = db.sqlite
      .query("SELECT status FROM experiments WHERE id = ?")
      .get(experimentId) as { status: string };
    expect(experimentRow.status).toBe("discard");
  });
});
