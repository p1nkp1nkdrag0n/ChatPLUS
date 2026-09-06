import { describe, expect, it, vi } from "vitest";

import type { AgentSnapshot } from "../api/types";
import {
  agentEventQueryKeys,
  agentOverviewQueryKey,
  primeAgentOverview,
} from "./agentEventQueryKeys";
import {
  AGENT_INVALIDATION_EVENTS,
  letterIdFromAgentEvent,
} from "./useAgentEvents";

describe("agentEventQueryKeys", () => {
  it("refreshes both the legacy state query and the user-facing overview", () => {
    expect(agentEventQueryKeys("agent-1")).toEqual([
      ["agent", "agent-1", "state"],
      ["agent", "agent-1", "overview"],
      ["agent", "agent-1", "timeline"],
      ["messages", "agent-1"],
      ["correspondence", "agent-1"],
      ["relationship-archive", "agent-1"],
      ["keepsakes", "agent-1"],
      ["temporal-tasks", "agent-1"],
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

  it("subscribes to every correspondence invalidation event", () => {
    expect(AGENT_INVALIDATION_EVENTS).toEqual(
      expect.arrayContaining([
        "correspondence.updated",
        "letter.arrived",
        "letter.opened",
        "letter.generation.retryable",
        "keepsake.created",
      ]),
    );
  });

  it("extracts the letter id from the server SSE envelope", () => {
    expect(
      letterIdFromAgentEvent(
        JSON.stringify({
          type: "letter.arrived",
          data: { letterId: "letter-arrived-1" },
        }),
      ),
    ).toBe("letter-arrived-1");
    expect(
      letterIdFromAgentEvent(JSON.stringify({ letterId: "legacy-letter-1" })),
    ).toBe("legacy-letter-1");
    expect(letterIdFromAgentEvent("not-json")).toBeUndefined();
    expect(
      letterIdFromAgentEvent(JSON.stringify({ data: {} })),
    ).toBeUndefined();
  });
});
