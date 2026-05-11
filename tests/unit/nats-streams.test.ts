import { describe, expect, test } from "bun:test";
import { StorageType } from "nats";
import { ensureJetStreamStreams } from "../../src/nats/streams";

describe("JetStream stream provisioning", () => {
  test("provisions the WORKSPACE stream alongside existing streams", async () => {
    const added: Array<{ name: string; subjects: string[]; storage: StorageType }> = [];
    const jsm = {
      streams: {
        info: async () => {
          throw new Error("missing");
        },
        add: async (config: { name: string; subjects: string[]; storage: StorageType }) => {
          added.push(config);
        }
      }
    };

    await ensureJetStreamStreams(jsm as never);

    expect(added.map((stream) => stream.name)).toContain("WORKSPACE");
    expect(added.find((stream) => stream.name === "WORKSPACE")).toMatchObject({
      subjects: ["autoforge.workspace.>"],
      storage: StorageType.File
    });
  });
});
