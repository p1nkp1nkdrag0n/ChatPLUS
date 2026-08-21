import { describe, expect, it } from "vitest";

import { buildTimelineLineage } from "./timelineLineage";

describe("timeline lineage", () => {
  it("orders every available authoritative entity ID", () => {
    const nodes = buildTimelineLineage({
      messageId: "message-1",
      memoryId: "memory-1",
      scheduleItemId: "schedule-1",
      sourceIntentId: "intent-1",
      proactiveCandidateId: "candidate-1",
      activityEventId: "activity-1",
    });

    expect(nodes.map(({ label, id }) => [label, id])).toEqual([
      ["PersonalIntent", "intent-1"],
      ["ScheduleItem", "schedule-1"],
      ["ActivityEvent", "activity-1"],
      ["Memory", "memory-1"],
      ["ProactiveCandidate", "candidate-1"],
      ["Message", "message-1"],
    ]);
  });

  it("omits unavailable entities without inventing a SelfPlanBundle", () => {
    const nodes = buildTimelineLineage({
      sourceIntentId: "intent-1",
      scheduleItemId: "schedule-1",
    });

    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.label).join(" → ")).toBe(
      "PersonalIntent → ScheduleItem",
    );
    expect(nodes.some((node) => node.label === "SelfPlanBundle")).toBe(false);
  });
});
