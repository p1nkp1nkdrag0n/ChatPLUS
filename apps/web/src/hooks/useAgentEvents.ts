import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentEventQueryKeys } from "./agentEventQueryKeys";

const EVENTS = [
  "message.created",
  "state.updated",
  "schedule.updated",
  "settlement.completed",
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
    for (const event of EVENTS) source.addEventListener(event, refresh);
    source.addEventListener("ready", refresh);
    source.onopen = refresh;

    return () => {
      for (const event of EVENTS) source.removeEventListener(event, refresh);
      source.removeEventListener("ready", refresh);
      source.onopen = null;
      source.close();
    };
  }, [agentId, queryClient]);
}
