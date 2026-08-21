import { describe, expect, it } from "vitest";

import { buildDateDigest, type DateDigestFactLike } from "./date-digest.js";

const FROM = "2026-08-20T00:00:00.000Z";
const TO = "2026-08-21T00:00:00.000Z";

function fact(overrides: Partial<DateDigestFactLike>): DateDigestFactLike {
  return {
    sourceType: "activity_event",
    sourceId: "activity-1",
    kind: "activity_event",
    content: "Finished a run.",
    temporalStatus: "occurred",
    occurredStartAtUtc: FROM,
    reliability: "reliable",
    sourceEvidenceIds: ["evidence-1"],
    ...overrides,
  };
}

describe("date digest", () => {
  it("includes only reliable occurred facts inside the target range", () => {
    const digest = buildDateDigest({
      fromUtc: FROM,
      toUtc: TO,
      facts: [
        fact({}),
        fact({
          sourceType: "memory",
          sourceId: "shared-1",
          kind: "shared_memory",
          content: "We finished a shared project.",
          occurredStartAtUtc: "2026-08-20T12:00:00.000Z",
          reliability: "reported",
          sourceEvidenceIds: ["evidence-shared"],
        }),
        fact({
          sourceId: "planned-1",
          kind: "schedule_item",
          temporalStatus: "planned",
          occurredStartAtUtc: "2026-08-20T14:00:00.000Z",
        }),
        fact({
          sourceId: "outside-1",
          occurredStartAtUtc: TO,
        }),
        fact({
          sourceId: "inferred-1",
          kind: "user_event",
          occurredStartAtUtc: "2026-08-20T08:00:00.000Z",
          reliability: "inferred",
        }),
      ],
    });

    expect(digest?.items.map((item) => item.sourceId)).toEqual([
      "activity-1",
      "shared-1",
    ]);
    expect(digest?.sourceEvidenceIds).toEqual([
      "evidence-1",
      "evidence-shared",
    ]);
  });

  it("uses overlap semantics for reliable activity intervals", () => {
    const digest = buildDateDigest({
      fromUtc: FROM,
      toUtc: TO,
      facts: [
        fact({
          sourceId: "overlap",
          occurredStartAtUtc: "2026-08-19T23:30:00.000Z",
          occurredEndAtUtc: "2026-08-20T00:30:00.000Z",
        }),
        fact({
          sourceId: "ends-at-boundary",
          occurredStartAtUtc: "2026-08-19T22:00:00.000Z",
          occurredEndAtUtc: FROM,
        }),
      ],
    });
    expect(digest?.items.map((item) => item.sourceId)).toEqual(["overlap"]);
  });

  it("returns undefined rather than an empty or speculative digest", () => {
    expect(
      buildDateDigest({
        fromUtc: FROM,
        toUtc: TO,
        facts: [
          fact({
            temporalStatus: "planned",
            kind: "schedule_item",
          }),
        ],
      }),
    ).toBeUndefined();
  });
});
