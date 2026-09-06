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
    for (const event of AGENT_INVALIDATION_EVENTS) {
      source.addEventListener(
        event,
        event.startsWith("letter.") ? refreshLetter : refresh,
      );
    }
    source.addEventListener("ready", refresh);
    source.onopen = refresh;

    return () => {
      for (const event of AGENT_INVALIDATION_EVENTS) {
        source.removeEventListener(
          event,
          event.startsWith("letter.") ? refreshLetter : refresh,
        );
      }
      source.removeEventListener("ready", refresh);
      source.onopen = null;
      source.close();
    };
  }, [agentId, queryClient]);
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
