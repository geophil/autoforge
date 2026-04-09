import { connect, type NatsConnection, StringCodec } from "nats";
import type { AutoforgeMessage } from "./messages";

const codec = StringCodec();

export class NatsClient {
  private connection?: NatsConnection;

  constructor(private readonly serverUrl: string) {}

  async connect(): Promise<void> {
    if (!this.connection) {
      this.connection = await connect({ servers: this.serverUrl });
    }
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = undefined;
    }
  }

  async publish(subject: string, message: AutoforgeMessage): Promise<void> {
    if (!this.connection) {
      throw new Error("NATS connection is not established");
    }
    this.connection.publish(subject, codec.encode(JSON.stringify(message)));
  }
}
