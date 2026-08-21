import { describe, expect, it } from "vitest";

import { CalendarEntryDraftSchema, CalendarEntrySchema } from "./calendar.js";

describe("calendar contracts", () => {
  it("requires agent ownership for private and character-world entries", () => {
    expect(
      CalendarEntrySchema.safeParse({
        id: "calendar_1",
        scope: "user_private",
        title: "Private",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: true,
        recurrence: "none",
        source: "manual",
        status: "active",
        dedupeKey: "private-key",
        revision: 0,
        createdAtUtc: "2026-08-20T00:00:00.000Z",
        updatedAtUtc: "2026-08-20T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires a start time for timed entries", () => {
    expect(
      CalendarEntryDraftSchema.safeParse({
        scope: "character_world",
        title: "Class",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: false,
      }).success,
    ).toBe(false);
  });

  it("accepts an agentless public-system entry", () => {
    expect(
      CalendarEntrySchema.safeParse({
        id: "calendar_public",
        scope: "public_system",
        title: "Public holiday",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: true,
        recurrence: "yearly",
        source: "system_dataset",
        status: "active",
        dedupeKey: "public-key",
        revision: 0,
        createdAtUtc: "2026-08-20T00:00:00.000Z",
        updatedAtUtc: "2026-08-20T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
