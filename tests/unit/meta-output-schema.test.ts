import { describe, expect, test } from "bun:test";
import { MetaOutputSchema, validateMetaOutput } from "../../src/schemas/meta-output";

const baseOp = {
  kind: "edit",
  target_variant_id: "v1",
  hypothesis: "h",
  evidence: {
    task_ids: ["t1"],
    metric_name: "task_quality_score",
    metric_before: 0.5
  },
  proposed_content_file: "proposed-persona.md"
};

describe("MetaOutputSchema", () => {
  test("accepts a well-formed edit operation", () => {
    const out = {
      status: "DONE",
      artifacts: ["proposed-persona.md"],
      operation: { ...baseOp }
    };
    const r = validateMetaOutput(out);
    expect(r.ok).toBe(true);
  });

  test("accepts a well-formed fork with specialty", () => {
    const out = {
      status: "DONE",
      artifacts: [],
      operation: {
        kind: "fork",
        parent_variant_id: "v1",
        specialty: "frontend React",
        hypothesis: "h",
        evidence: { task_ids: ["t1", "t2"], finding_categories: ["styling"] },
        proposed_content_file: "proposed-persona-fork.md"
      }
    };
    expect(validateMetaOutput(out).ok).toBe(true);
  });

  test("rejects fork missing specialty", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        kind: "fork", parent_variant_id: "v1",
        hypothesis: "h",
        evidence: { task_ids: ["t1"] },
        proposed_content_file: "x.md"
      }
    };
    const r = validateMetaOutput(out);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/specialty/i);
  });

  test("rejects edit with specialty (forbidden)", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: { ...baseOp, specialty: "illegal" }
    };
    const r = validateMetaOutput(out);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/specialty/i);
  });

  test("rejects edit missing proposed_content_file", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        kind: "edit", target_variant_id: "v1",
        hypothesis: "h", evidence: { task_ids: ["t1"] }
      }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });

  test("rejects promote/demote/retire with proposed_content_file", () => {
    for (const kind of ["promote", "demote", "retire"] as const) {
      const out = {
        status: "DONE", artifacts: [],
        operation: {
          kind, target_variant_id: "v1",
          hypothesis: "h", evidence: { task_ids: ["t1"] },
          proposed_content_file: "illegal.md"
        }
      };
      expect(validateMetaOutput(out).ok).toBe(false);
    }
  });

  test("accepts promote/demote with just target_variant_id + evidence", () => {
    for (const kind of ["promote", "demote", "retire"] as const) {
      const out = {
        status: "DONE", artifacts: [],
        operation: {
          kind, target_variant_id: "v1",
          hypothesis: "h", evidence: { task_ids: ["t1"] }
        }
      };
      expect(validateMetaOutput(out).ok).toBe(true);
    }
  });

  test("accepts merge with two variant ids", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        kind: "merge",
        target_variant_id: "v1",
        merge_source_variant_id: "v2",
        hypothesis: "h",
        evidence: { task_ids: ["t1"] }
      }
    };
    expect(validateMetaOutput(out).ok).toBe(true);
  });

  test("rejects evidence.task_ids empty", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: { ...baseOp, evidence: { task_ids: [] } }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });

  test("rejects retire_lessons > 3 entries", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: {
        ...baseOp,
        retire_lessons: [
          { id: "l1", reason: "r" },
          { id: "l2", reason: "r" },
          { id: "l3", reason: "r" },
          { id: "l4", reason: "r" }
        ]
      }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });

  test("rejects unknown kind", () => {
    const out = {
      status: "DONE", artifacts: [],
      operation: { kind: "teleport", target_variant_id: "v1", hypothesis: "h",
                   evidence: { task_ids: ["t1"] } }
    };
    expect(validateMetaOutput(out).ok).toBe(false);
  });
});
