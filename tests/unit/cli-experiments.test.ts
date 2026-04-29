import { describe, expect, test } from "bun:test";
import { formatPendingForks, parseExperimentCommand, runExperimentCli } from "../../src/cli/experiments";

describe("experiments CLI formatting", () => {
  test("formats pending fork rows", () => {
    const text = formatPendingForks([{
      experiment_id: "exp1",
      proposed_specialty: "React styling",
      parent_variant_id: "v1",
      hypothesis: "frontend failures cluster",
      evidence: { fork_proposal_id: "fp1", task_ids: ["t1", "t2"] },
      proposed_content_preview: "# persona",
      created_at: "2026-04-28T00:00:00Z"
    }]);
    expect(text).toContain("exp1");
    expect(text).toContain("React styling");
    expect(text).toContain("fp1");
  });
});

describe("experiments CLI argument parsing", () => {
  test("approve-fork requires an approver", () => {
    expect(() => parseExperimentCommand(["experiments", "approve-fork", "exp1"]))
      .toThrow("usage: autoforge experiments approve-fork <id> --approver <name> [--notes <notes>]");
  });

  test("approve-fork rejects a flag where approver value is required", () => {
    expect(() => parseExperimentCommand([
      "experiments",
      "approve-fork",
      "exp1",
      "--approver",
      "--notes",
      "ok"
    ])).toThrow("usage: autoforge experiments approve-fork <id> --approver <name> [--notes <notes>]");
  });

  test("reject-fork requires a reviewer", () => {
    expect(() => parseExperimentCommand(["experiments", "reject-fork", "exp1", "--reason", "duplicate"]))
      .toThrow("usage: autoforge experiments reject-fork <id> --reviewer <name> --reason <reason>");
  });

  test("reject-fork rejects a flag where reviewer value is required", () => {
    expect(() => parseExperimentCommand([
      "experiments",
      "reject-fork",
      "exp1",
      "--reviewer",
      "--reason",
      "nope"
    ])).toThrow("usage: autoforge experiments reject-fork <id> --reviewer <name> --reason <reason>");
  });

  test("reject-fork requires a reason", () => {
    expect(() => parseExperimentCommand(["experiments", "reject-fork", "exp1", "--reviewer", "Jophie"]))
      .toThrow("usage: autoforge experiments reject-fork <id> --reviewer <name> --reason <reason>");
  });

  test("approve-fork parses approver and notes", () => {
    expect(parseExperimentCommand([
      "experiments",
      "approve-fork",
      "exp1",
      "--approver",
      "Jophie",
      "--notes",
      "ship it"
    ])).toEqual({
      domain: "experiments",
      command: "approve-fork",
      id: "exp1",
      approver: "Jophie",
      notes: "ship it"
    });
  });

  test("reject-fork parses reviewer and reason", () => {
    expect(parseExperimentCommand([
      "experiments",
      "reject-fork",
      "exp1",
      "--reviewer",
      "Jophie",
      "--reason",
      "duplicate"
    ])).toEqual({
      domain: "experiments",
      command: "reject-fork",
      id: "exp1",
      reviewer: "Jophie",
      reason: "duplicate"
    });
  });
});

describe("experiments CLI runtime", () => {
  test("list-pending throws status and body on failed HTTP response", async () => {
    await expect(runExperimentCli(["experiments", "list-pending"], {
      baseUrl: "http://autoforge.test",
      fetch: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ experiments: [] }),
        text: async () => "server exploded"
      }),
      stdout: () => undefined
    })).rejects.toThrow("HTTP 500: server exploded");
  });

  test("approve-fork throws status and body on failed HTTP response", async () => {
    await expect(runExperimentCli([
      "experiments",
      "approve-fork",
      "exp1",
      "--approver",
      "Jophie"
    ], {
      baseUrl: "http://autoforge.test",
      fetch: async () => ({
        ok: false,
        status: 409,
        text: async () => "already decided"
      }),
      stdout: () => undefined
    })).rejects.toThrow("HTTP 409: already decided");
  });
});
