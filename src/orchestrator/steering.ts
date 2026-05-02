export type SteeringScope = "next_attempt";

export interface SteeringMessage {
  eventId: string;
  timestamp: string;
  message: string;
  scope: SteeringScope;
  author: string;
}

interface EventLike {
  id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function collectPendingSteering(events: EventLike[]): SteeringMessage[] {
  const consumed = new Set<string>();
  for (const event of events) {
    if (event.type !== "steering_consumed") continue;
    const ids = event.payload.steering_event_ids;
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === "string") consumed.add(id);
      }
    }
  }

  const pending: SteeringMessage[] = [];
  for (const event of events) {
    if (event.type !== "steering_message") continue;
    const message = typeof event.payload.message === "string" ? event.payload.message.trim() : "";
    const scope = event.payload.scope;
    if (!message || scope !== "next_attempt") continue;
    if (consumed.has(event.id)) continue;
    pending.push({
      eventId: event.id,
      timestamp: event.timestamp,
      message,
      scope: "next_attempt",
      author: typeof event.payload.author === "string" ? event.payload.author : "operator"
    });
  }

  return pending;
}

export function renderSteeringPrompt(messages: SteeringMessage[]): string {
  if (messages.length === 0) return "";
  const lines = ["# Operator Steering", "", "Apply this guidance to the upcoming attempt:", ""];
  for (const msg of messages) {
    lines.push(`- ${msg.message}`);
  }
  return lines.join("\n");
}
