import { describe, expect, test } from "bun:test";
import { filterBySpecialty } from "../../src/orchestrator/specialty-match";

interface TestVariant {
  id: string;
  status: string;
  specialty: string | null;
}

describe("filterBySpecialty", () => {
  test("baseline and generalist are always eligible", () => {
    const variants: TestVariant[] = [
      { id: "base", status: "baseline", specialty: "backend" },
      { id: "general", status: "active", specialty: null },
      { id: "frontend", status: "active", specialty: "React UI" }
    ];

    expect(filterBySpecialty(variants, "write a database migration").map((v) => v.id))
      .toEqual(["base", "general"]);
  });

  test("active specialty with overlapping keyword is included", () => {
    const variants: TestVariant[] = [
      { id: "backend", status: "active", specialty: "Database migration" }
    ];

    expect(filterBySpecialty(variants, "write a database migration").map((v) => v.id))
      .toEqual(["backend"]);
  });

  test("active specialty with no overlap is excluded", () => {
    const variants: TestVariant[] = [
      { id: "frontend", status: "active", specialty: "React UI" }
    ];

    expect(filterBySpecialty(variants, "write a database migration")).toEqual([]);
  });

  test("candidate specialty obeys same matcher as active", () => {
    const variants: TestVariant[] = [
      { id: "candidate", status: "candidate", specialty: "React UI" },
      { id: "unmatched", status: "candidate", specialty: "Database migration" }
    ];

    expect(filterBySpecialty(variants, "fix React component state").map((v) => v.id))
      .toEqual(["candidate"]);
  });

  test("baseline remains eligible even with no keyword overlap", () => {
    const variants: TestVariant[] = [
      { id: "base", status: "baseline", specialty: "React UI" }
    ];

    expect(filterBySpecialty(variants, "write a database migration").map((v) => v.id))
      .toEqual(["base"]);
  });

  test("empty task description includes only baseline and generalists", () => {
    const variants: TestVariant[] = [
      { id: "base", status: "baseline", specialty: "backend" },
      { id: "general", status: "active", specialty: null },
      { id: "frontend", status: "active", specialty: "React UI" }
    ];

    expect(filterBySpecialty(variants, "").map((v) => v.id))
      .toEqual(["base", "general"]);
  });

  test("punctuation and case do not prevent overlap", () => {
    const variants: TestVariant[] = [
      { id: "frontend", status: "active", specialty: "React/UI" }
    ];

    expect(filterBySpecialty(variants, "REACT component work").map((v) => v.id))
      .toEqual(["frontend"]);
  });

  test("order is preserved", () => {
    const variants: TestVariant[] = [
      { id: "base", status: "baseline", specialty: "backend" },
      { id: "react", status: "active", specialty: "React UI" },
      { id: "general", status: "candidate", specialty: null },
      { id: "state", status: "active", specialty: "State management" }
    ];

    expect(filterBySpecialty(variants, "React state work").map((v) => v.id))
      .toEqual(["base", "react", "general", "state"]);
  });
});
