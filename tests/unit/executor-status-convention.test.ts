import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATUS_FILE,
  buildRuntimeBudgetPrompt,
  buildStatusReportingContractPrompt,
  buildStatusReportingPrompt,
  loadSkillFiles,
  readStatusFile
} from "../../src/executors/status-convention";

describe("executor status convention helpers", () => {
  test("loadSkillFiles concatenates existing skill files in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-skill-"));
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, "alpha");
    writeFileSync(b, "beta");

    const combined = loadSkillFiles([a, join(dir, "missing.md"), b]);
    expect(combined).toContain("alpha");
    expect(combined).toContain("beta");
    expect(combined).toContain("---");
  });

  test("readStatusFile reads valid convention status json", () => {
    const dir = mkdtempSync(join(tmpdir(), "exec-status-"));
    writeFileSync(join(dir, STATUS_FILE), JSON.stringify({
      status: "DONE",
      artifacts: ["src/example.ts"]
    }));

    expect(readStatusFile(dir)).toEqual({
      status: "DONE",
      artifacts: ["src/example.ts"]
    });
  });

  test("buildStatusReportingPrompt includes status file name and budget", () => {
    const prompt = buildStatusReportingPrompt(123);
    expect(prompt).toContain(STATUS_FILE);
    expect(prompt).toContain("123 seconds");
    expect(prompt).toContain("\"DONE\"");
    expect(prompt).toContain("\"DONE_WITH_CONCERNS\"");
    expect(prompt).toContain("\"BLOCKED\"");
    expect(prompt).toContain("\"NEEDS_CONTEXT\"");
  });

  test("status contract is stable while runtime budget is dynamic", () => {
    const contract = buildStatusReportingContractPrompt();
    const budget = buildRuntimeBudgetPrompt(123);

    expect(contract).toContain(STATUS_FILE);
    expect(contract).not.toContain("123 seconds");
    expect(budget).toContain("123 seconds");
  });
});
