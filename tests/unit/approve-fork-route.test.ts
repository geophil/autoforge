import { describe, expect, test } from "bun:test";
import { createTestService } from "../helpers/create-service";
import { createWebServer } from "../../src/web/server";

function seedParent(db: ReturnType<typeof createTestService>["db"], id = "vParent"): void {
  db.sqlite.query(
    "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES (?, 'persona:coder', '1', 'seed', 'baseline', 1.0)"
  ).run(id);
}

function seedProposedFork(
  db: ReturnType<typeof createTestService>["db"],
  id: string,
  parentId = "vParent",
  evidenceSuffix = ""
): void {
  db.sqlite.query(`
    INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before,
                             operation, evidence, status, proposed_content)
    VALUES (?, 'h', 'd', 'task_quality_score', 0.5, 'fork',
            json_object('parent_variant_id', ?, 'specialty', 'frontend'${evidenceSuffix}),
            'proposed', '# Forked content')
  `).run(id, parentId);
}

describe("POST /api/experiments/:id/approve-fork", () => {
  test("creates a candidate skill_versions row, applies pending retires, flips experiment to active", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vParent','persona:coder','1','seed','baseline',1.0)"
      ).run();
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();

      const lessonId = db.insertLesson({
        agentType: "coder",
        lineageRootId: "vParent",
        sourceTaskId: "metaT",
        sourceVariantId: "vParent",
        triggerPattern: "p",
        body: "b",
        outcomeKind: "corrective"
      });
      db.insertForkProposal({
        id: "fp-approve",
        agentType: "coder",
        label: "Frontend cluster",
        keywords: "frontend,react",
        suggestedSpecialty: "frontend",
        representativeTaskIds: ["metaT"],
        baselineScoreMean: 0.4,
        populationScoreMean: 0.7,
        scoreGap: 0.3,
        recommendationStrength: "strong"
      });

      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before,
                                 operation, evidence, status, proposed_content)
        VALUES ('exp1','h','d','task_quality_score',0.5,'fork',
                json_object('parent_variant_id','vParent','specialty','frontend','pending_retire_lessons',json_array(?),'fork_proposal_id','fp-approve'),
                'proposed','# Forked content')
      `).run(lessonId);

      const resp = await app.request("/api/experiments/exp1/approve-fork", {
        method: "POST",
        body: JSON.stringify({ approver: "ops", notes: "approved for shadowing" }),
        headers: { "content-type": "application/json" }
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { ok: boolean; variantId: string };
      expect(body.ok).toBe(true);
      expect(typeof body.variantId).toBe("string");

      const variant = db.sqlite.query(
        "SELECT status, parent_version_id, specialty, content, skill_name, traffic_share FROM skill_versions WHERE id = ?"
      ).get(body.variantId) as { status: string; parent_version_id: string; specialty: string; content: string; skill_name: string; traffic_share: number };
      expect(variant.status).toBe("candidate");
      expect(variant.parent_version_id).toBe("vParent");
      expect(variant.specialty).toBe("frontend");
      expect(variant.content).toBe("# Forked content");
      expect(variant.skill_name).toBe("persona:coder");
      expect(variant.traffic_share).toBe(0.0);

      const embedding = db.sqlite.query(
        "SELECT specialty_embedding FROM skill_versions WHERE id = ?"
      ).get(body.variantId) as { specialty_embedding: Uint8Array | null };
      expect(embedding.specialty_embedding).toBeInstanceOf(Uint8Array);

      const exp = db.sqlite.query("SELECT status FROM experiments WHERE id='exp1'").get() as { status: string };
      expect(exp.status).toBe("active");

      expect(db.getForkProposal("fp-approve")?.status).toBe("acted_on");
      expect(db.getForkProposal("fp-approve")?.acted_on_experiment_id).toBe("exp1");

      const lesson = db.sqlite.query("SELECT status FROM lessons WHERE id = ?").get(lessonId) as { status: string };
      expect(lesson.status).toBe("retired");

      const allocation = db.sqlite.query(`
        SELECT payload
          FROM events
         WHERE event_type = 'traffic_allocated'
           AND task_id = ?
      `).get(body.variantId) as { payload: string } | undefined;
      expect(allocation).toBeDefined();
      expect(JSON.parse(allocation?.payload ?? "{}")).toMatchObject({
        variant_id: body.variantId,
        agent_type: "coder",
        old_status: null,
        old_traffic_share: null,
        new_status: "candidate",
        new_traffic_share: 0,
        reason: "meta_fork_approved"
      });

      const approval = db.sqlite.query(`
        SELECT payload
          FROM events
         WHERE event_type = 'fork_approved'
      `).get() as { payload: string } | undefined;
      expect(JSON.parse(approval?.payload ?? "{}")).toMatchObject({
        experiment_id: "exp1",
        variant_id: body.variantId,
        parent_variant_id: "vParent",
        lineage_root_id: "vParent",
        specialty: "frontend",
        approver: "ops",
        notes: "approved for shadowing"
      });
    } finally {
      cleanup();
    }
  });

  test("returns 404 for unknown experiment", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      const resp = await app.request("/api/experiments/missing/approve-fork", { method: "POST" });
      expect(resp.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  test("returns 409 when experiment is not a proposed fork (e.g., already-active edit)", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT2','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before, operation, status)
        VALUES ('exp2','h','d','task_quality_score',0,'edit','active')
      `).run();
      const resp = await app.request("/api/experiments/exp2/approve-fork", { method: "POST" });
      expect(resp.status).toBe(409);
    } finally {
      cleanup();
    }
  });

  test("returns 409 when proposed fork has no proposed_content", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      db.sqlite.query(
        "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vParent2','persona:coder','1','seed','baseline',1.0)"
      ).run();
      db.sqlite.query(
        "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('metaT3','p','meta','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
      ).run();
      db.sqlite.query(`
        INSERT INTO experiments (id, hypothesis, change_description, metric_name, metric_before, operation, evidence, status)
        VALUES ('exp3','h','d','task_quality_score',0.5,'fork',
                json_object('parent_variant_id','vParent2','specialty','x'),
                'proposed')
      `).run();
      const resp = await app.request("/api/experiments/exp3/approve-fork", { method: "POST" });
      expect(resp.status).toBe(409);
    } finally {
      cleanup();
    }
  });

  test("concurrent approval only creates one candidate", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    let calls = 0;
    let releaseEmbeddings!: () => void;
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbeddings = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      (service as unknown as { embeddingProvider: { embed: () => Promise<number[]> } }).embeddingProvider = {
        async embed(): Promise<number[]> {
          calls += 1;
          if (calls === 2) resolve();
          await embeddingGate;
          return [1, 0, 0];
        }
      };
    });
    try {
      seedParent(db);
      seedProposedFork(db, "exp-race");

      const first = app.request("/api/experiments/exp-race/approve-fork", { method: "POST" });
      const second = app.request("/api/experiments/exp-race/approve-fork", { method: "POST" });
      await bothStarted;
      releaseEmbeddings();
      const responses = await Promise.all([first, second]);

      expect(responses.map((resp) => resp.status).sort()).toEqual([200, 409]);
      const candidates = db.sqlite.query(
        "SELECT COUNT(*) AS n FROM skill_versions WHERE experiment_id = 'exp-race'"
      ).get() as { n: number };
      expect(candidates.n).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("returns 409 when cited fork proposal is no longer open", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    try {
      seedParent(db);
      db.insertForkProposal({
        id: "fp-stale",
        agentType: "coder",
        label: "Frontend cluster",
        keywords: "frontend,react",
        suggestedSpecialty: "frontend",
        representativeTaskIds: ["metaT"],
        baselineScoreMean: 0.4,
        populationScoreMean: 0.7,
        scoreGap: 0.3,
        recommendationStrength: "strong"
      });
      db.sqlite.query("UPDATE fork_proposals SET status = 'stale' WHERE id = 'fp-stale'").run();
      seedProposedFork(db, "exp-stale", "vParent", ", 'fork_proposal_id', 'fp-stale'");

      const resp = await app.request("/api/experiments/exp-stale/approve-fork", { method: "POST" });

      expect(resp.status).toBe(409);
      const candidates = db.sqlite.query(
        "SELECT COUNT(*) AS n FROM skill_versions WHERE experiment_id = 'exp-stale'"
      ).get() as { n: number };
      expect(candidates.n).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("approves when embedding provider fails and leaves specialty embedding null", async () => {
    const { service, db, cleanup } = createTestService();
    const app = createWebServer(service, db);
    (service as unknown as { embeddingProvider: { embed: () => Promise<number[]> } }).embeddingProvider = {
      async embed(): Promise<number[]> {
        throw new Error("embedding unavailable");
      }
    };
    try {
      seedParent(db);
      seedProposedFork(db, "exp-embedding-fails");

      const resp = await app.request("/api/experiments/exp-embedding-fails/approve-fork", { method: "POST" });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { variantId: string };
      const row = db.sqlite.query(
        "SELECT specialty_embedding FROM skill_versions WHERE id = ?"
      ).get(body.variantId) as { specialty_embedding: Uint8Array | null };
      expect(row.specialty_embedding).toBeNull();
    } finally {
      cleanup();
    }
  });
});
