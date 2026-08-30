import { describe, expect, it } from "vitest";

import { buildTimelineLineage } from "./timelineLineage";

describe("timeline lineage", () => {
  it("orders non-schedule authoritative entity IDs", () => {
    const nodes = buildTimelineLineage({
      messageId: "message-1",
      memoryId: "memory-1",
      sourceIntentId: "intent-1",
      proactiveCandidateId: "candidate-1",
      activityEventId: "activity-1",
    });

    expect(nodes.map(({ label, id }) => [label, id])).toEqual([
      ["PersonalIntent", "intent-1"],
      ["ActivityEvent", "activity-1"],
      ["Memory", "memory-1"],
      ["ProactiveCandidate", "candidate-1"],
      ["Message", "message-1"],
    ]);
  });

  it("omits unavailable entities without exposing exact-schedule lineage", () => {
    const nodes = buildTimelineLineage({
      sourceIntentId: "intent-1",
    });

    expect(nodes).toHaveLength(1);
    expect(nodes.map((node) => node.label).join(" → ")).toBe("PersonalIntent");
    expect(nodes.some((node) => node.label === "ScheduleItem")).toBe(false);
    expect(nodes.some((node) => node.label === "SelfPlanBundle")).toBe(false);
  });
});
