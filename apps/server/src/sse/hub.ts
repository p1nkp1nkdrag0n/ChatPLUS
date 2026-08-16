import type { ServerResponse } from "node:http";

import { nanoid } from "nanoid";

export type SseEvent = {
  type: string;
  agentId: string;
  occurredAtUtc: string;
  data: unknown;
};

export class SseHub {
  private readonly clients = new Map<string, Map<string, ServerResponse>>();

  subscribe(agentId: string, response: ServerResponse): () => void {
    const clientId = nanoid();
    const clients =
      this.clients.get(agentId) ?? new Map<string, ServerResponse>();
    clients.set(clientId, response);
    this.clients.set(agentId, clients);
    response.write(`event: ready\ndata: ${JSON.stringify({ agentId })}\n\n`);
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(": heartbeat\n\n");
    }, 25_000);
    heartbeat.unref();

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clients.delete(clientId);
      if (clients.size === 0) this.clients.delete(agentId);
    };
  }

  publish(event: SseEvent): void {
    const payload = {
      id: `sse-${nanoid()}`,
      ...event,
      emittedAtUtc: event.occurredAtUtc,
    };
    const encoded = `id: ${payload.id}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    const clients = this.clients.get(event.agentId);
    if (!clients) return;
    for (const [clientId, response] of clients) {
      if (response.destroyed || response.writableEnded) {
        clients.delete(clientId);
        continue;
      }
      response.write(encoded);
    }
    if (clients.size === 0) this.clients.delete(event.agentId);
  }

  getActiveAgentIds(): string[] {
    return [...this.clients.entries()]
      .filter(([, clients]) => clients.size > 0)
      .map(([agentId]) => agentId);
  }

  connectionCount(agentId?: string): number {
    if (agentId) return this.clients.get(agentId)?.size ?? 0;
    return [...this.clients.values()].reduce(
      (total, clients) => total + clients.size,
      0,
    );
  }

  close(): void {
    for (const clients of this.clients.values()) {
      for (const response of clients.values()) response.end();
    }
    this.clients.clear();
  }
}
