import type { DbClient } from "../db/client";
import type { NatsClient } from "../nats/client";

export class RecoveryService {
  constructor(
    private readonly db: DbClient,
    private readonly nats?: NatsClient
  ) {}

  async recover(): Promise<void> {
    if (this.nats?.isConnected) {
      const count = await this.nats.replayTaskEvents((message) => {
        this.db.transaction(() => {
          // Re-insert event if not already present (idempotent).
          try {
            this.db.appendEvent(message);
          } catch {
            // Event already exists in SQLite — skip.
          }
          this.db.applyEvent(message);
        });
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
