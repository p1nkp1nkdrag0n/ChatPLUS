import type { QueryClient } from "@tanstack/react-query";
import type { AgentSnapshot } from "../api/types";

export function agentOverviewQueryKey(agentId: string): readonly string[] {
  return ["agent", agentId, "overview"];
}

export function primeAgentOverview(
  queryClient: Pick<QueryClient, "setQueryData">,
  agentId: string,
  snapshot: AgentSnapshot,
): void {
  queryClient.setQueryData(agentOverviewQueryKey(agentId), snapshot);
}

export function agentEventQueryKeys(
  agentId: string,
): ReadonlyArray<readonly string[]> {
  return [
    ["agent", agentId, "state"],
    agentOverviewQueryKey(agentId),
    ["agent", agentId, "timeline"],
    ["messages", agentId],
    ["correspondence", agentId],
    ["relationship-archive", agentId],
    ["keepsakes", agentId],
    ["temporal-tasks", agentId],
  ];
}
