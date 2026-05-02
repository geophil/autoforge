import { describe, expect, test } from "bun:test";
import { filterSpecialtyEligible } from "../../src/orchestrator/classifier";
import { serializeEmbedding } from "../../src/orchestrator/embedding";
import type { DispatchVariantRow } from "../../src/db/client";

function variant(input: Partial<DispatchVariantRow> & { id: string; status: DispatchVariantRow["status"] }): DispatchVariantRow {
  return {
    id: input.id,
    skill_name: "persona:coder",
    content: "content",
    status: input.status,
    traffic_share: 0,
    parent_version_id: null,
    specialty: input.specialty ?? null,
    specialty_embedding: input.specialty_embedding ?? null,
    created_at: "2026-04-28T00:00:00Z"
  };
}

describe("filterSpecialtyEligible", () => {
  test("baseline is always eligible", async () => {
    const rows = [variant({ id: "base", status: "baseline", specialty: "database" })];
    const eligible = await filterSpecialtyEligible(rows, "React styling", {
      provider: { embed: async () => [1, 0] },
      similarityThreshold: 0.55
    });
    expect(eligible.map((row) => row.id)).toEqual(["base"]);
  });

  test("embedding match includes specialist over threshold", async () => {
    const rows = [
      variant({ id: "base", status: "baseline" }),
      variant({ id: "style", status: "active", specialty: "React styling", specialty_embedding: serializeEmbedding([1, 0]) }),
      variant({ id: "db", status: "active", specialty: "database migrations", specialty_embedding: serializeEmbedding([0, 1]) })
    ];
    const eligible = await filterSpecialtyEligible(rows, "CSS module task", {
      provider: { embed: async () => [1, 0] },
      similarityThreshold: 0.55
    });
    expect(eligible.map((row) => row.id)).toEqual(["base", "style"]);
  });

  test("embedding failure falls back to keyword matching", async () => {
    const rows = [
      variant({ id: "base", status: "baseline" }),
      variant({ id: "frontend", status: "active", specialty: "React component styling" })
    ];
    const eligible = await filterSpecialtyEligible(rows, "fix React button styling", {
      provider: { embed: async () => { throw new Error("offline"); } },
      similarityThreshold: 0.55
    });
    expect(eligible.map((row) => row.id)).toEqual(["base", "frontend"]);
  });

  test("dimension-mismatched specialty embeddings fall back to keyword matching", async () => {
    const rows = [
      variant({ id: "base", status: "baseline" }),
      variant({
        id: "frontend",
        status: "active",
        specialty: "React component styling",
        specialty_embedding: serializeEmbedding([1, 0, 0])
      })
    ];
    const eligible = await filterSpecialtyEligible(rows, "fix React button styling", {
      provider: { embed: async () => [1, 0] },
      similarityThreshold: 0.55
    });

    expect(eligible.map((row) => row.id)).toEqual(["base", "frontend"]);
  });
});
