import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentEventQueryKeys } from "./agentEventQueryKeys";

export const AGENT_INVALIDATION_EVENTS = [
  "message.created",
  "state.updated",
  "schedule.updated",
  "settlement.completed",
  "correspondence.updated",
  "letter.arrived",
  "letter.opened",
  "letter.generation.retryable",
  "keepsake.created",
  "keepsake.updated",
  "message",
  "state",
  "schedule",
  "settlement",
] as const;

export function useAgentEvents(agentId: string | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!agentId) return undefined;
    const source = new EventSource(`/api/agents/${agentId}/events`);
    const refresh = () => {
      for (const queryKey of agentEventQueryKeys(agentId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const refreshLetter = (event: Event) => {
      refresh();
      if (!(event instanceof MessageEvent)) return;
      const letterId = letterIdFromAgentEvent(event.data);
      if (letterId !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: ["letter", letterId],
        });
      }
    };
    const refreshKeepsake = (event: Event) => {
      refresh();
      if (!(event instanceof MessageEvent)) return;
      for (const queryKey of keepsakeEventQueryKeys(event.type, event.data)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const refreshConnected = () => {
      refresh();
      // Reconnection must also refresh mounted detail views after a missed update.
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "keepsake" &&
          isRecord(query.state.data) &&
          isRecord(query.state.data["keepsake"]) &&
          query.state.data["keepsake"]["agentId"] === agentId,
      });
      void queryClient.invalidateQueries({ queryKey: ["letter"] });
    };
    const listenerFor = (event: string) =>
      event.startsWith("letter.")
        ? refreshLetter
        : event.startsWith("keepsake.")
          ? refreshKeepsake
          : refresh;
    for (const event of AGENT_INVALIDATION_EVENTS) {
      source.addEventListener(event, listenerFor(event));
    }
    source.addEventListener("ready", refreshConnected);
    source.onopen = refreshConnected;

    return () => {
      for (const event of AGENT_INVALIDATION_EVENTS) {
        source.removeEventListener(event, listenerFor(event));
      }
      source.removeEventListener("ready", refreshConnected);
      source.onopen = null;
      source.close();
    };
  }, [agentId, queryClient]);
}

export function keepsakeEventQueryKeys(
  eventType: string,
  value: unknown,
): string[][] {
  const keys: string[][] = eventType === "keepsake.created" ? [["letter"]] : [];
  if (typeof value !== "string") return keys;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return keys;
    const nested = isRecord(parsed["data"]) ? parsed["data"] : undefined;
    const keepsakeId = nested?.["keepsakeId"] ?? parsed["keepsakeId"];
    if (typeof keepsakeId === "string" && keepsakeId.length > 0) {
      keys.push(["keepsake", keepsakeId]);
    }
  } catch {
    // Invalidations carry no authoritative product state.
  }
  return keys;
}

export function letterIdFromAgentEvent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return undefined;
    // Current SseHub preserves the domain event envelope, whose details live
    // under `data`. Keep the direct fallback for older local servers.
    const nested = isRecord(parsed["data"]) ? parsed["data"] : undefined;
    const candidate = nested?.["letterId"] ?? parsed["letterId"];
    return typeof candidate === "string" && candidate.length > 0
      ? candidate
      : undefined;
  } catch {
    // SSE is only an invalidation hint; malformed data is not a fact source.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
