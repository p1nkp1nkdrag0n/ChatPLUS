import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "../api/types";
import { timelineEventTitle } from "./timelinePresentation";

const BASE_EVENT: TimelineEvent = {
  id: "activity-1",
  type: "completed",
  title: "周六 20:00 在精确日程中安排的约会",
  summary: "两个人完成了一次值得记住的活动。",
  occurredAtUtc: "2026-09-01T12:00:00.000Z",
  provenance: "life_simulation",
};

describe("timeline event presentation", () => {
  it("does not render a legacy exact-schedule title", () => {
    expect(
      timelineEventTitle({
        ...BASE_EVENT,
        scheduleItemId: "legacy-schedule-1",
      }),
    ).toBe("一段经历有了结果");
  });

  it("keeps causal and relationship milestone titles", () => {
    expect(
      timelineEventTitle({
        ...BASE_EVENT,
        id: "life-event-1",
        type: "life.delegated_decision_recorded",
        title: "共同作出了一个明确选择",
      }),
    ).toBe("共同作出了一个明确选择");
  });
});
