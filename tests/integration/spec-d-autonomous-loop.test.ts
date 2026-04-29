import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { createWebServer } from "../../src/web/server";
import type { DbClient } from "../../src/db/client";

function seedBaselineCoderVariant(db: DbClient): void {
  db.sqlite.query(`
    INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share)
    VALUES ('variant-base', 'persona:coder', '1', '# Baseline coder persona', 'baseline', 1.0)
  `).run();
}

function seedCompletedCoderTask(db: DbClient, index: number): string {
  const taskId = `task-${String(index).padStart(2, "0")}`;
  const minute = String(index).padStart(2, "0");
  db.sqlite.query(`
    INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at)
    VALUES (?, 'project-spec-d', ?, 'completed', 'STANDARD', '{}', '[]', 0, ?, ?)
  `).run(
    taskId,
    `Completed frontend task ${index}`,
    `2026-04-28T12:${minute}:00Z`,
    `2026-04-28T12:${minute}:30Z`
  );
  db.insertTaskDiffStats(taskId, {
    files_changed: 2,
    files_added: 0,
    files_modified: 2,
    files_deleted: 0,
    lines_added: 20 + index,
    lines_deleted: 3,
    test_files_changed: 1
  });
  db.appendEvent({
    id: randomUUID(),
    taskId,
    projectId: "project-spec-d",
    timestamp: `2026-04-28T12:${minute}:20Z`,
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
  return taskId;
}

function seedProposedForkExperiment(db: DbClient, proposalId: string, taskIds: string[]): void {
  db.sqlite.query(`
    INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before,
                             operation, evidence, status, proposed_content)
    VALUES ($id, $hypothesis, $description, 'task_quality_score', 0.5,
            'fork', $evidence, 'proposed', $content)
  `).run({
    $id: "expFork",
    $hypothesis: "Specialized frontend UI work will improve coder quality.",
    $description: "Fork coder persona for React UI implementation tasks.",
    $evidence: JSON.stringify({
      parent_variant_id: "variant-base",
      specialty: "React UI implementation",
      fork_proposal_id: proposalId,
      task_ids: taskIds
    }),
    $content: "# React UI coder persona\n\nFocus on React component implementation and styling."
  });
}

describe("Spec D autonomous loop", () => {
  test("runs diagnostic, proposes a fork, and approves the proposed fork end-to-end", async () => {
    const taskIdsSeenByDiagnostician: string[] = [];
    const { service, db, cleanup } = createTestService({
      diagnostician: (task) => {
        const prompt = JSON.parse(task.prompt) as { tasks: Array<{ task_id: string }> };
        taskIdsSeenByDiagnostician.push(...prompt.tasks.map((row) => row.task_id));
        return {
          status: "DONE",
          artifacts: [],
          output: {
            clusters: [{
              label: "React UI work",
              keywords: "react ui components",
              representative_task_ids: ["task-01", "task-02", "task-03", "task-04", "task-05"],
              baseline_score_mean: 0.42,
              population_score_mean: 0.68,
              score_gap: 0.26,
              recommendation_strength: "strong",
              suggested_specialty: "React UI implementation"
            }]
          },
          metrics: { elapsedSeconds: 0.1 }
        };
      }
    });
    const app = createWebServer(service, db);

    try {
      seedBaselineCoderVariant(db);
      const taskIds = Array.from({ length: 30 }, (_, index) => seedCompletedCoderTask(db, index + 1));

      const diagnosticResp = await app.request("/api/diagnostic/run", {
        method: "POST",
        body: JSON.stringify({ agentType: "coder" }),
        headers: { "content-type": "application/json" }
      });
      expect(diagnosticResp.status).toBe(200);
      expect(await diagnosticResp.json()).toMatchObject({
        ok: true,
        agentType: "coder",
        clustersProposed: 1
      });
      expect(taskIdsSeenByDiagnostician).toHaveLength(30);

      const proposals = db.listOpenForkProposals("coder");
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        agent_type: "coder",
        label: "React UI work",
        suggested_specialty: "React UI implementation",
        status: "open"
      });

      seedProposedForkExperiment(db, proposals[0].id, taskIds.slice(0, 5));

      const approvalResp = await app.request("/api/experiments/expFork/approve-fork", {
        method: "POST",
        body: JSON.stringify({ approver: "ops", notes: "approve proposed Spec D fork" }),
        headers: { "content-type": "application/json" }
      });
      expect(approvalResp.status).toBe(200);
      const approvalBody = await approvalResp.json() as { ok: boolean; variantId: string };
      expect(approvalBody.ok).toBe(true);
      expect(typeof approvalBody.variantId).toBe("string");

      const candidate = db.sqlite.query(`
        SELECT status, parent_version_id, specialty, content
          FROM skill_versions
         WHERE id = ?
      `).get(approvalBody.variantId) as {
        status: string;
        parent_version_id: string;
        specialty: string;
        content: string;
      };
      expect(candidate).toEqual({
        status: "candidate",
        parent_version_id: "variant-base",
        specialty: "React UI implementation",
        content: "# React UI coder persona\n\nFocus on React component implementation and styling."
      });

      const actedProposal = db.getForkProposal(proposals[0].id);
      expect(actedProposal?.status).toBe("acted_on");
      expect(actedProposal?.acted_on_experiment_id).toBe("expFork");

      const approvalEvent = db.sqlite.query(`
        SELECT payload
          FROM events
         WHERE event_type = 'fork_approved'
      `).get() as { payload: string } | undefined;
      expect(JSON.parse(approvalEvent?.payload ?? "{}")).toMatchObject({
        experiment_id: "expFork",
        variant_id: approvalBody.variantId,
        parent_variant_id: "variant-base",
        specialty: "React UI implementation",
        approver: "ops",
        notes: "approve proposed Spec D fork"
      });
    } finally {
      cleanup();
    }
  });
});
