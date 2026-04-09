type EventListener = (payload: string) => void;

export class LiveEventHub {
  private listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: { type: string; data: unknown }): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const listener of this.listeners) {
      listener(payload);
    }
  }
}
