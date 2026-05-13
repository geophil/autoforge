import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DbClient } from "../../src/db/client";
import type { AgentResult, AgentTask } from "../../src/executors/interface";
import { reflectOnTask } from "../../src/orchestrator/reflection";
import { PersonaRegistry } from "../../src/personas/registry";

describe("reflector persona", () => {
  test("PersonaRegistry.resolve returns the reflector persona file content", () => {
    const dir = mkdtempSync(join(tmpdir(), "reflector-persona-test-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    const reg = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
    const text = reg.resolve("reflector");
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain("Reflector");
    expect(text).toContain("outcome_kind");
  });

  test("reflectOnTask gives the reflector a private local workspace not pointing at the working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflector-workspace-test-"));
    const db = new DbClient(join(dir, `${randomUUID()}.sqlite`));
    db.initSchema(
      resolve(process.cwd(), "src/db/schema.sql"),
      resolve(process.cwd(), "src/db/migrations")
    );
    db.sqlite.query(
      "INSERT INTO tasks (id, project_id, description, state, tier, assessment, plan, iteration, created_at, updated_at) VALUES ('t','p','d','completed','STANDARD','{}','[]',0,datetime('now'),datetime('now'))"
    ).run();

    const personas = new PersonaRegistry(db, resolve(process.cwd(), "src/personas"));
    const skills = { skillsForAgent: () => [] };
    let observedWorkspace: { id: string; provider: string; rootPath: string } | null = null;
    const executor = {
      name: "reflector-mock",
      async execute(task: AgentTask): Promise<AgentResult> {
        const ws = task.workspace as unknown as { id: string; provider: string; rootPath: string };
        observedWorkspace = { id: ws.id, provider: ws.provider, rootPath: ws.rootPath };
        return {
          status: "DONE",
          artifacts: [],
          output: { lesson: { skip: true, reason: "unit-test" } },
          metrics: { elapsedSeconds: 0.1 }
        };
      },
      async healthCheck(): Promise<boolean> {
        return true;
      }
    };

    const result = await reflectOnTask("t", {
      db,
      executor,
      personas,
      skills: skills as any,
      workingDirectory: dir,
      recordEvent: () => {}
    });

    if (!observedWorkspace) throw new Error("executor was not invoked");
    const obs: { id: string; provider: string; rootPath: string } = observedWorkspace;
    expect(obs.provider).toBe("local");
    expect(obs.id).toBe("t:reflector");
    // The reflector must NOT see the working directory; rootPath must be an
    // ephemeral tmpdir under autoforge-reflector-* that is NOT `dir`.
    expect(obs.rootPath).not.toBe(dir);
    expect(obs.rootPath).toContain("autoforge-reflector-");
    expect(result.skipped).toBe(true);
  });
});
