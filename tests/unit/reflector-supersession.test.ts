import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import { reflectOnTask } from "../../src/orchestrator/reflection";

function freshDb(): DbClient {
  const dir = mkdtempSync(join(tmpdir(), "reflect-super-"));
  const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
  db.initSchema(
    resolve(process.cwd(), "src/db/schema.sql"),
    resolve(process.cwd(), "src/db/migrations")
  );
  return db;
}

describe("reflector supersession", () => {
  test("supersedes listed lesson ids when inserting a new lesson", async () => {
    const db = freshDb();
    db.sqlite.query(
      "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vC','persona:coder','1','c','baseline',1.0)"
    ).run();
    db.sqlite.query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('t','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
    ).run();
    const oldId = db.insertLesson({
      agentType: "coder", lineageRootId: "vC", sourceTaskId: "t",
      sourceVariantId: "vC", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });

    const mockExecutor = {
      async execute() {
        return {
          status: "DONE",
          artifacts: [],
          output: {
            status: "DONE",
            artifacts: [],
            lesson: {
              skip: false,
              agent_type: "coder",
              trigger_pattern: "p2",
              body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
              outcome_kind: "corrective",
              keywords: "react"
            },
            supersedes: [oldId]
          },
          metrics: { elapsedSeconds: 0 }
        };
      },
      name: "mock",
      async healthCheck() {
        return true;
      }
    };

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const personas = {
      snapshotId: (_agent: string) => "vC",
      resolve: (_agent: string) => "reflector-prompt"
    };
    const skills = { skillsForAgent: () => [] };

    const res = await reflectOnTask("t", {
      db,
      executor: mockExecutor as any,
      personas: personas as any,
      skills: skills as any,
      workingDirectory: "/tmp",
      recordEvent: (e) => events.push({ type: e.type, payload: e.payload })
    });

    expect(res.lessonId).toBeDefined();
    expect(res.lessonId).not.toBeNull();
    const old = db.sqlite
      .query("SELECT status, superseded_by FROM lessons WHERE id = ?")
      .get(oldId) as { status: string; superseded_by: string };
    expect(old.status).toBe("superseded");
    expect(old.superseded_by).toBe(res.lessonId as string);

    const supersededEvent = events.find((e) => e.type === "lessons_superseded");
    expect(supersededEvent).toBeDefined();
    expect(supersededEvent!.payload.new_lesson_id).toBe(res.lessonId);
    expect(supersededEvent!.payload.superseded_ids).toEqual([oldId]);
  });

  test("no lessons_superseded event when supersedes is absent", async () => {
    const db = freshDb();
    db.sqlite.query(
      "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vC','persona:coder','1','c','baseline',1.0)"
    ).run();
    db.sqlite.query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('t','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
    ).run();

    const mockExecutor = {
      async execute() {
        return {
          status: "DONE",
          artifacts: [],
          output: {
            status: "DONE",
            artifacts: [],
            lesson: {
              skip: false,
              agent_type: "coder",
              trigger_pattern: "p2",
              body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
              outcome_kind: "corrective",
              keywords: "react"
            }
          },
          metrics: { elapsedSeconds: 0 }
        };
      },
      name: "mock",
      async healthCheck() {
        return true;
      }
    };

    const events: Array<{ type: string }> = [];
    const personas = {
      snapshotId: (_agent: string) => "vC",
      resolve: (_agent: string) => "reflector-prompt"
    };
    const skills = { skillsForAgent: () => [] };

    const res = await reflectOnTask("t", {
      db,
      executor: mockExecutor as any,
      personas: personas as any,
      skills: skills as any,
      workingDirectory: "/tmp",
      recordEvent: (e) => events.push({ type: e.type })
    });

    expect(res.lessonId).not.toBeNull();
    expect(events.find((e) => e.type === "lessons_superseded")).toBeUndefined();
  });

  test("does not supersede lessons from a different lineage", async () => {
    const db = freshDb();
    db.sqlite.query(
      "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vC','persona:coder','1','c','baseline',1.0)"
    ).run();
    db.sqlite.query(
      "INSERT INTO skill_versions (id, skill_name, version, content, status, traffic_share) VALUES ('vOther','persona:coder','2','other','active',0.1)"
    ).run();
    db.sqlite.query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('t','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
    ).run();
    const otherLineageLesson = db.insertLesson({
      agentType: "coder", lineageRootId: "vOther", sourceTaskId: "t",
      sourceVariantId: "vOther", triggerPattern: "p", body: "b", outcomeKind: "corrective"
    });

    const mockExecutor = {
      async execute() {
        return {
          status: "DONE",
          artifacts: [],
          output: {
            status: "DONE",
            artifacts: [],
            lesson: {
              skip: false,
              agent_type: "coder",
              trigger_pattern: "p2",
              body: "TRIGGER\nOBSERVATION\nPRINCIPLE\nEVIDENCE",
              outcome_kind: "corrective",
              keywords: "react"
            },
            supersedes: [otherLineageLesson]
          },
          metrics: { elapsedSeconds: 0 }
        };
      },
      name: "mock",
      async healthCheck() {
        return true;
      }
    };

    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const personas = {
      snapshotId: (_agent: string) => "vC",
      resolve: (_agent: string) => "reflector-prompt"
    };
    const skills = { skillsForAgent: () => [] };

    const res = await reflectOnTask("t", {
      db,
      executor: mockExecutor as any,
      personas: personas as any,
      skills: skills as any,
      workingDirectory: "/tmp",
      recordEvent: (e) => events.push({ type: e.type, payload: e.payload })
    });

    expect(res.lessonId).not.toBeNull();
    const old = db.sqlite
      .query("SELECT status, superseded_by FROM lessons WHERE id = ?")
      .get(otherLineageLesson) as { status: string; superseded_by: string | null };
    expect(old.status).toBe("active");
    expect(old.superseded_by).toBeNull();
    expect(events.find((e) => e.type === "lessons_superseded")).toBeUndefined();
    const rejected = events.find((e) => e.type === "lessons_supersession_rejected");
    expect(rejected).toBeDefined();
    expect(rejected!.payload.requested_ids).toEqual([otherLineageLesson]);
    expect(rejected!.payload.rejected_ids).toEqual([otherLineageLesson]);
  });
});
