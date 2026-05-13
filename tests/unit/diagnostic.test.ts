import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DbClient } from "../../src/db/client";
import type { AgentExecutor, AgentResult, AgentTask } from "../../src/executors/interface";
import { parseDiagnosticOutput, proposalIdForCluster, runDiagnostic, runDiagnosticStalenessSweep } from "../../src/orchestrator/diagnostic";
import type { AutoforgeMessage } from "../../src/nats/messages";
import { LocalWorkspace } from "../../src/runtime/local-workspace";

function freshDb(): DbClient {
  const db = new DbClient(join(mkdtempSync(join(tmpdir(), "diagnostic-test-")), "db.sqlite"));
  db.initSchema(resolve(process.cwd(), "src/db/schema.sql"), resolve(process.cwd(), "src/db/migrations"));
  return db;
}

function createRecorder(db: DbClient): (input: {
  taskId: string;
  projectId: string;
  agent: AutoforgeMessage["agent"];
  type: string;
  status: AutoforgeMessage["status"];
  payload: Record<string, unknown>;
  budgetSeconds: number;
  elapsedSeconds?: number;
  analyticsOnly?: boolean;
}) => void {
  return (input) => {
    const message: AutoforgeMessage = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      timestamp: new Date().toISOString(),
      agent: input.agent,
      type: input.type,
      status: input.status,
      payload: input.analyticsOnly ? { ...input.payload, __analytics_only: true } : input.payload,
      budgetSeconds: input.budgetSeconds,
      elapsedSeconds: input.elapsedSeconds
    };
    db.appendEvent(message);
    if (!input.analyticsOnly) {
      db.applyEvent(message);
    }
  };
}

function seedTerminalSelectedTask(db: DbClient, index: number): void {
  const taskId = `t${index}`;
  db.sqlite.query(`
    INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
    VALUES (?, 'p', ?, 'completed', 'STANDARD', '{}', '[]', 0, ?, ?)
  `).run(taskId, `Fix React styling issue ${index}`, `2026-04-28T10:${String(index).padStart(2, "0")}:00Z`, `2026-04-28T10:${String(index).padStart(2, "0")}:30Z`);
  db.insertTaskDiffStats(taskId, {
    files_changed: 1,
    files_added: 0,
    files_modified: 1,
    files_deleted: 0,
    lines_added: 10,
    lines_deleted: 2,
    test_files_changed: 1
  });
  db.appendEvent({
    id: randomUUID(),
    taskId,
    projectId: "p",
    timestamp: `2026-04-28T10:${String(index).padStart(2, "0")}:20Z`,
    agent: "orchestrator",
    type: "variant_selected",
    status: "done",
    payload: {
      agent_type: "coder",
      selected_variant_id: "variant-base",
      selection_rationale: "baseline"
    },
    budgetSeconds: 0
  });
}

class DiagnosticMockExecutor implements AgentExecutor {
  readonly name = "diagnostic-mock";
  task: AgentTask | null = null;

  async execute(task: AgentTask): Promise<AgentResult> {
    this.task = task;
    return {
      status: "DONE",
      artifacts: [],
      output: {
        clusters: [{
          label: "React styling",
          keywords: "react css styling",
          representative_task_ids: ["t1", "t2", "t3", "t4", "t5"],
          baseline_score_mean: 0.4,
          population_score_mean: 0.7,
          score_gap: 0.3,
          recommendation_strength: "strong",
          suggested_specialty: "React component styling and CSS module work."
        }]
      },
      metrics: { elapsedSeconds: 2 }
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

describe("diagnostic parsing and persistence helpers", () => {
  test("parses valid cluster output", () => {
    const parsed = parseDiagnosticOutput(JSON.stringify({
      clusters: [{
        label: "React styling",
        keywords: "react css styling",
        representative_task_ids: ["t1", "t2", "t3"],
        baseline_score_mean: 0.4,
        population_score_mean: 0.7,
        score_gap: 0.3,
        recommendation_strength: "strong",
        suggested_specialty: "React component styling and CSS module work."
      }]
    }));
    expect(parsed.clusters).toHaveLength(1);
    expect(parsed.clusters[0].recommendation_strength).toBe("strong");
  });

  test("proposal ids are stable for agent, keywords, and date", () => {
    const expected = createHash("sha256").update("coder|react css|2026-04-28").digest("hex").slice(0, 24);
    expect(proposalIdForCluster("coder", "react css", "2026-04-28T10:00:00Z")).toBe(`fp_${expected}`);
  });

  test("staleness sweep marks old open proposals stale", () => {
    const db = freshDb();
    db.insertForkProposal({
      id: "fp_old",
      agentType: "coder",
      label: "old",
      keywords: "old",
      suggestedSpecialty: "old work",
      representativeTaskIds: ["t1", "t2", "t3"],
      baselineScoreMean: 0.4,
      populationScoreMean: 0.6,
      scoreGap: 0.2,
      recommendationStrength: "strong"
    });
    db.sqlite.query("UPDATE fork_proposals SET generated_at = datetime('now', '-20 days') WHERE id = 'fp_old'").run();
    expect(runDiagnosticStalenessSweep(db, 14)).toBe(1);
    expect(db.getForkProposal("fp_old")?.status).toBe("stale");
  });

  test("diagnostic task history deduplicates selected variants by latest event per task", () => {
    const db = freshDb();
    seedTerminalSelectedTask(db, 1);
    db.appendEvent({
      id: randomUUID(),
      taskId: "t1",
      projectId: "p",
      timestamp: "2026-04-28T10:01:50Z",
      agent: "orchestrator",
      type: "variant_selected",
      status: "done",
      payload: {
        agent_type: "coder",
        selected_variant_id: "variant-latest",
        selection_rationale: "exploitation"
      },
      budgetSeconds: 0
    });

    const rows = db.loadDiagnosticTaskHistory("coder", 100);

    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0].selection_payload))).toMatchObject({
      selected_variant_id: "variant-latest",
      selection_rationale: "exploitation"
    });
  });

  test("runDiagnostic persists proposals and emits diagnostic events", async () => {
    const db = freshDb();
    for (let i = 1; i <= 30; i++) {
      seedTerminalSelectedTask(db, i);
    }
    db.insertForkProposal({
      id: "fp_old_during_run",
      agentType: "coder",
      label: "old run proposal",
      keywords: "old run",
      suggestedSpecialty: "old diagnostic work",
      representativeTaskIds: ["t1", "t2", "t3"],
      baselineScoreMean: 0.4,
      populationScoreMean: 0.6,
      scoreGap: 0.2,
      recommendationStrength: "moderate"
    });
    db.sqlite.query("UPDATE fork_proposals SET generated_at = datetime('now', '-20 days') WHERE id = 'fp_old_during_run'").run();
    const executor = new DiagnosticMockExecutor();

    const proposed = await runDiagnostic({
      db,
      executor,
      recordEvent: createRecorder(db),
      agentType: "coder",
      trigger: "unit_test",
      workingDirectory: process.cwd(),
      now: new Date("2026-04-28T12:00:00Z")
    });

    expect(proposed).toBe(1);
    expect(executor.task?.type).toBe("diagnostician");
    expect(executor.task?.budgetSeconds).toBe(90);
    expect(executor.task?.workspace).toBeInstanceOf(LocalWorkspace);
    expect((executor.task?.workspace as LocalWorkspace | undefined)?.rootPath).toBe(process.cwd());
    const diagnosticPrompt = JSON.parse(executor.task?.prompt ?? "{}") as {
      baseline_score_mean?: unknown;
      tasks?: unknown[];
    };
    expect(diagnosticPrompt.tasks).toHaveLength(30);
    expect(typeof diagnosticPrompt.baseline_score_mean).toBe("number");
    expect(Math.abs((diagnosticPrompt.baseline_score_mean as number) - 0.9886792452830189)).toBeLessThan(0.000001);

    const proposalId = proposalIdForCluster("coder", "react css styling", "2026-04-28T12:00:00Z");
    expect(db.getForkProposal(proposalId)).toMatchObject({
      agent_type: "coder",
      label: "React styling",
      recommendation_strength: "strong",
      status: "open"
    });
    expect(db.getForkProposal("fp_old_during_run")?.status).toBe("stale");

    const events = db.sqlite.query(`
      SELECT event_type, payload
      FROM events
      WHERE event_type IN ('diagnostic_cluster_detected', 'diagnostic_run_completed')
      ORDER BY event_type
    `).all() as Array<{ event_type: string; payload: string }>;
    expect(events.map((event) => event.event_type)).toEqual([
      "diagnostic_cluster_detected",
      "diagnostic_run_completed"
    ]);
    expect(JSON.parse(events[0].payload)).toEqual({
      __analytics_only: true,
      fork_proposal_id: proposalId,
      agent_type: "coder",
      label: "React styling",
      score_gap: 0.3,
      recommendation_strength: "strong"
    });
    expect(JSON.parse(events[1].payload)).toMatchObject({
      trigger: "unit_test",
      tasks_analyzed: 30,
      clusters_proposed: 1,
      diagnostician_variant_id: null,
      error: null
    });
  });

  test("runDiagnostic uses injected workspace factory for diagnostician dispatch", async () => {
    const db = freshDb();
    for (let i = 1; i <= 30; i++) {
      seedTerminalSelectedTask(db, i);
    }

    let createInput: any = null;
    let destroyCount = 0;
    const fakeWorkspace = {
      id: "diagnostic-coder-2026-04-28:diagnostician",
      provider: "test",
      readFile: async () => "{}",
      writeFile: async () => {},
      exec: async function* () {
        yield { kind: "exit", exitCode: 0 } as const;
      },
      destroy: async () => {
        destroyCount += 1;
      }
    };
    const executor = {
      name: "diagnostic-mock",
      async execute(task: AgentTask): Promise<AgentResult> {
        expect(task.workspace).toBe(fakeWorkspace);
        return {
          status: "DONE",
          artifacts: [],
          output: { clusters: [] },
          metrics: { elapsedSeconds: 0.1 }
        };
      },
      async healthCheck(): Promise<boolean> {
        return true;
      }
    };

    await runDiagnostic({
      db,
      executor,
      recordEvent: createRecorder(db),
      agentType: "coder",
      trigger: "unit_test",
      workingDirectory: process.cwd(),
      now: new Date("2026-04-28T12:00:00Z"),
      workspaceFactory: {
        create: async (input) => {
          createInput = input;
          return fakeWorkspace;
        }
      }
    });

    expect(createInput).not.toBeNull();
    if (!createInput) {
      throw new Error("Expected workspace factory create input");
    }
    expect(createInput.dispatchId).toBe("diagnostician");
    expect(destroyCount).toBe(1);
  });

  test("diagnostic events remain analytics-only after projection rebuild", async () => {
    const db = freshDb();
    for (let i = 1; i <= 30; i++) {
      seedTerminalSelectedTask(db, i);
    }
    const executor = new DiagnosticMockExecutor();

    const proposed = await runDiagnostic({
      db,
      executor,
      recordEvent: createRecorder(db),
      agentType: "coder",
      trigger: "unit_test",
      workingDirectory: process.cwd(),
      now: new Date("2026-04-28T12:00:00Z")
    });
    expect(proposed).toBe(1);

    const beforeReplay = (db.sqlite.query(
      "SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'diagnostic'"
    ).get() as { n: number }).n;
    expect(beforeReplay).toBe(0);

    db.rebuildProjectionsFromEvents();

    const afterReplay = (db.sqlite.query(
      "SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'diagnostic'"
    ).get() as { n: number }).n;
    expect(afterReplay).toBe(0);
  });

  test("runDiagnostic skips duplicate stable proposal ids without cluster events", async () => {
    const db = freshDb();
    for (let i = 1; i <= 30; i++) {
      seedTerminalSelectedTask(db, i);
    }
    const duplicateProposalId = proposalIdForCluster("coder", "react css styling", "2026-04-28T12:00:00Z");
    db.insertForkProposal({
      id: duplicateProposalId,
      agentType: "coder",
      label: "existing duplicate",
      keywords: "react css styling",
      suggestedSpecialty: "Existing specialty.",
      representativeTaskIds: ["t1", "t2", "t3"],
      baselineScoreMean: 0.4,
      populationScoreMean: 0.7,
      scoreGap: 0.3,
      recommendationStrength: "strong"
    });
    const executor = new DiagnosticMockExecutor();

    const proposed = await runDiagnostic({
      db,
      executor,
      recordEvent: createRecorder(db),
      agentType: "coder",
      trigger: "unit_test",
      workingDirectory: process.cwd(),
      now: new Date("2026-04-28T12:00:00Z")
    });

    expect(proposed).toBe(0);
    const events = db.sqlite.query(`
      SELECT event_type, payload
      FROM events
      WHERE event_type IN ('diagnostic_cluster_detected', 'diagnostic_run_completed')
      ORDER BY event_type
    `).all() as Array<{ event_type: string; payload: string }>;
    expect(events.map((event) => event.event_type)).toEqual(["diagnostic_run_completed"]);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      clusters_proposed: 0,
      error: null
    });
  });

  test("runDiagnostic logs completion event when workspace creation fails", async () => {
    const db = freshDb();
    for (let i = 1; i <= 30; i++) {
      seedTerminalSelectedTask(db, i);
    }

    const proposed = await runDiagnostic({
      db,
      executor: new DiagnosticMockExecutor(),
      recordEvent: createRecorder(db),
      agentType: "coder",
      trigger: "unit_test",
      workingDirectory: process.cwd(),
      now: new Date("2026-04-28T12:00:00Z"),
      workspaceFactory: {
        create: async () => {
          throw new Error("workspace_create_failed");
        }
      }
    });

    expect(proposed).toBe(0);
    const completion = db.sqlite.query(`
      SELECT payload
      FROM events
      WHERE event_type = 'diagnostic_run_completed'
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `).get() as { payload: string } | undefined;
    expect(completion).toBeDefined();
    expect(JSON.parse(completion!.payload)).toMatchObject({
      error: "workspace_create_failed"
    });
  });

  test("diagnostic task history includes finding summaries and failure analysis payload", () => {
    const db = freshDb();
    seedTerminalSelectedTask(db, 1);
    db.sqlite.query(`
      INSERT INTO review_findings (id, task_id, severity, category, description, resolved)
      VALUES ('finding-1', 't1', 'MAJOR', 'scope', 'Detailed text should not enter diagnostics', 0)
    `).run();
    db.appendEvent({
      id: randomUUID(),
      taskId: "t1",
      projectId: "p",
      timestamp: "2026-04-28T10:01:40Z",
      agent: "orchestrator",
      type: "failure_analysis",
      status: "done",
      payload: {
        failure_category: "scope_drift",
        planner_fallback: false,
        details: "keep payload available"
      },
      budgetSeconds: 0
    });

    const rows = db.loadDiagnosticTaskHistory("coder", 10);

    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0].review_findings))).toEqual([
      { category: "scope", severity: "MAJOR" }
    ]);
    expect(JSON.parse(String(rows[0].failure_analysis_payload))).toMatchObject({
      failure_category: "scope_drift",
      planner_fallback: false
    });
  });
});
