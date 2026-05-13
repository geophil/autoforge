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

  test("reflectOnTask uses injected workspace factory with reflector dispatch id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflector-workspace-factory-test-"));
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
    let createInput: any = null;
    let destroyCount = 0;
    const fakeWorkspace = {
      id: "t:reflector",
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
      name: "reflector-mock",
      async execute(task: AgentTask): Promise<AgentResult> {
        expect(task.workspace).toBe(fakeWorkspace);
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
      workspaceFactory: {
        create: async (input) => {
          createInput = input;
          return fakeWorkspace;
        }
      },
      recordEvent: () => {}
    });

    expect(createInput).not.toBeNull();
    if (!createInput) {
      throw new Error("Expected workspace factory create input");
    }
    expect(createInput.dispatchId).toBe("reflector");
    expect(result.skipped).toBe(true);
    expect(destroyCount).toBe(1);
  });
});
