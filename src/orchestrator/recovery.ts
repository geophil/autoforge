import type { DbClient } from "../db/client";
import type { NatsClient } from "../nats/client";
import type { AutoforgeMessage } from "../nats/messages";

export class RecoveryService {
  constructor(
    private readonly db: DbClient,
    private readonly nats?: NatsClient,
    private readonly recordEvent?: (message: AutoforgeMessage) => void
  ) {}

  async recover(): Promise<void> {
    if (this.nats?.isConnected) {
      const recorder = this.recordEvent;
      if (!recorder) {
        throw new Error("RecoveryService requires a recordEvent callback when replaying NATS events");
      }
      const count = await this.nats.replayTaskEvents((message) => {
        // Re-insert event if not already present (idempotent).
        try {
          recorder(message);
        } catch {
          // Event already exists in SQLite — skip.
        }
      });

      if (count > 0) {
        console.log(`[recovery] Replayed ${count} events from NATS JetStream.`);
        return;
      }
    }

    // Fall back to SQLite event log.
    console.log("[recovery] Rebuilding state from SQLite event log.");
    this.db.rebuildProjectionsFromEvents();
  }
}
