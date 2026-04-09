import { RetentionPolicy, StorageType, type JetStreamManager } from "nats";

export async function ensureJetStreamStreams(jsm: JetStreamManager): Promise<void> {
  await ensureStream(jsm, "TASKS", ["autoforge.task.>"], RetentionPolicy.Limits, StorageType.File, 1_000);
  await ensureStream(jsm, "META", ["autoforge.meta.>"], RetentionPolicy.Limits, StorageType.File);
  await ensureStream(jsm, "SYSTEM", ["autoforge.system.>"], RetentionPolicy.Limits, StorageType.Memory, 100);
}

async function ensureStream(
  jsm: JetStreamManager,
  name: string,
  subjects: string[],
  retention: RetentionPolicy,
  storage: StorageType,
  maxMsgsPerSubject?: number
): Promise<void> {
  try {
    await jsm.streams.info(name);
  } catch {
    await jsm.streams.add({
      name,
      subjects,
      retention,
      storage,
      max_msgs_per_subject: maxMsgsPerSubject
    });
  }
}
