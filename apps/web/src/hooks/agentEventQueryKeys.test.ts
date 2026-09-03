import { describe, expect, it, vi } from "vitest";

import type { AgentSnapshot } from "../api/types";
import {
  agentEventQueryKeys,
  agentOverviewQueryKey,
  primeAgentOverview,
} from "./agentEventQueryKeys";

describe("agentEventQueryKeys", () => {
  it("refreshes both the legacy state query and the user-facing overview", () => {
    expect(agentEventQueryKeys("agent-1")).toEqual([
      ["agent", "agent-1", "state"],
      ["agent", "agent-1", "overview"],
      ["agent", "agent-1", "timeline"],
      ["messages", "agent-1"],
    ]);
  });

  it("primes the exact overview key with the activation snapshot", () => {
    const setQueryData = vi.fn();
    const snapshot = { state: { agentId: "agent-1" } } as AgentSnapshot;

    primeAgentOverview({ setQueryData }, "agent-1", snapshot);

    expect(setQueryData).toHaveBeenCalledWith(
      agentOverviewQueryKey("agent-1"),
      snapshot,
    );
  });
});
