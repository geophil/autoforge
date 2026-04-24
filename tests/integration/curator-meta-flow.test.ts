import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { setMockMetaResult } from "../../src/executors/mock";

describe("curator meta flow", () => {
  test("valid edit operation creates a candidate variant and an active experiment", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vBase','persona:coder','1','seed','baseline',1.0)"
      ).run();

      setMockMetaResult({
        status: "DONE",
        artifacts: ["proposed.md"],
        operation: {
          kind: "edit",
          target_variant_id: "vBase",
          hypothesis: "clarify tone",
          evidence: { task_ids: ["t1"] },
          proposed_content_file: "proposed.md"
        }
      }, "# Proposed coder persona");

      const result = await service.submitMetaTask("autoforge", "tone");
      expect(result.experimentId).not.toBeNull();
      expect(result.status).toBe("DONE");

      const exp = db.sqlite
        .query("SELECT operation, status, proposed_content FROM experiments WHERE id = ?")
        .get(result.experimentId!) as { operation: string; status: string; proposed_content: string };
      expect(exp.operation).toBe("edit");
      expect(exp.status).toBe("active");
      expect(exp.proposed_content).toBe("# Proposed coder persona");

      const candidate = db.sqlite
        .query("SELECT COUNT(*) AS n FROM skill_versions WHERE parent_version_id = 'vBase' AND status = 'candidate'")
        .get() as { n: number };
      expect(candidate.n).toBe(1);

      const proposedEvent = db.sqlite
        .query("SELECT json_extract(payload, '$.operation_kind') AS kind FROM events WHERE event_type = 'experiment_proposed'")
        .get() as { kind: string } | undefined;
      expect(proposedEvent?.kind).toBe("edit");
    } finally {
      cleanup();
    }
  });

  test("malformed output emits meta_rejected and returns DONE_WITH_CONCERNS", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      setMockMetaResult({
        status: "DONE",
        artifacts: [],
        operation: { kind: "fork" }
      });

      const result = await service.submitMetaTask("autoforge", "focus");
      expect(result.status).toBe("DONE_WITH_CONCERNS");
      expect(result.experimentId).toBeNull();

      const rejected = db.sqlite
        .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'meta_rejected'")
        .get() as { n: number };
      expect(rejected.n).toBeGreaterThanOrEqual(1);

      const anyExp = db.sqlite.query("SELECT COUNT(*) AS n FROM experiments").get() as { n: number };
      expect(anyExp.n).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("handler rejection (missing proposed_content) emits meta_rejected with handler: prefix", async () => {
    const { service, db, cleanup } = createTestService();
    try {
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vBase2','persona:coder','1','seed','baseline',1.0)"
      ).run();
      setMockMetaResult({
        status: "DONE",
        artifacts: [],
        operation: {
          kind: "edit",
          target_variant_id: "vBase2",
          hypothesis: "h",
          evidence: { task_ids: ["t1"] },
          proposed_content_file: "missing.md"
        }
      });

      const result = await service.submitMetaTask("autoforge", "focus");
      expect(result.status).toBe("DONE_WITH_CONCERNS");
      expect(result.experimentId).toBeNull();
      expect(result.reason).toContain("proposed_content_empty");

      const rejected = db.sqlite.query(
        "SELECT json_extract(payload, '$.reason') AS reason FROM events WHERE event_type = 'meta_rejected' ORDER BY timestamp DESC LIMIT 1"
      ).get() as { reason: string };
      expect(rejected.reason).toMatch(/^handler:/);
    } finally {
      cleanup();
    }
  });

  test("executor exception still runs cleanup; caller sees the exception propagate", async () => {
    const { service, cleanup } = createTestService({
      meta: async () => {
        throw new Error("executor blew up");
      }
    });
    try {
      await expect(service.submitMetaTask("autoforge", "x")).rejects.toThrow("executor blew up");
    } finally {
      cleanup();
    }
  });
});
