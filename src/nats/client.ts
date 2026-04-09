import { connect, StringCodec, type NatsConnection, type JetStreamClient, type JetStreamManager } from "nats";
import type { AutoforgeMessage } from "./messages";
import { ensureJetStreamStreams } from "./streams";
import { taskSubject } from "./messages";

const codec = StringCodec();

export class NatsClient {
  private connection?: NatsConnection;
  private js?: JetStreamClient;

  constructor(private readonly serverUrl: string) {}

  /** Attempt to connect. Returns false if NATS is unavailable (graceful degradation). */
  async connect(): Promise<boolean> {
    try {
      this.connection = await connect({ servers: this.serverUrl, timeout: 3_000 });
      const jsm: JetStreamManager = await this.connection.jetstreamManager();
      await ensureJetStreamStreams(jsm);
      this.js = this.connection.jetstream();
      return true;
    } catch (err) {
      console.warn(`[nats] Could not connect to ${this.serverUrl}: ${err instanceof Error ? err.message : err}. Events will be SQLite-only.`);
      this.connection = undefined;
      this.js = undefined;
      return false;
    }
  }

  get isConnected(): boolean {
    return this.js !== undefined;
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.drain();
      this.connection = undefined;
      this.js = undefined;
    }
  }

  /**
   * Publish a task event to the TASKS JetStream stream.
   * No-op if NATS is not connected.
   */
  async publishTaskEvent(message: AutoforgeMessage): Promise<void> {
    if (!this.js) return;
    const subject = taskSubject(message.projectId, message.taskId, message.type);
    try {
      await this.js.publish(subject, codec.encode(JSON.stringify(message)));
    } catch (err) {
      console.warn(`[nats] Failed to publish event ${message.type}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Replay all events from the TASKS stream in order, oldest first.
   * Calls `onEvent` for each message. Returns the count of replayed events.
   * Returns 0 if NATS is not connected.
   */
  async replayTaskEvents(onEvent: (message: AutoforgeMessage) => void): Promise<number> {
    if (!this.js) return 0;

    try {
      // Create an ephemeral ordered consumer that starts from the very first message.
      const consumer = await this.js.consumers.get("TASKS");
      const messages = await consumer.consume({ max_messages: 10_000 });

      let count = 0;
      // Consume with a short idle-heartbeat so we know when the stream is drained.
      for await (const msg of messages) {
        try {
          const parsed = JSON.parse(codec.decode(msg.data)) as AutoforgeMessage;
          onEvent(parsed);
          count++;
          msg.ack();
        } catch {
          msg.nak();
        }

        // Stop once we've processed all pending messages (no more waiting).
        if (msg.info.pending === 0) {
          break;
        }
      }

      return count;
    } catch (err) {
      console.warn(`[nats] JetStream replay failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  /** Legacy core-NATS publish (kept for compatibility). */
  async publish(subject: string, message: AutoforgeMessage): Promise<void> {
    if (!this.connection) return;
    this.connection.publish(subject, codec.encode(JSON.stringify(message)));
  }
}
