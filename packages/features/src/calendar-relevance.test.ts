import type { CalendarEntry } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCalendarDedupeKey,
  selectCalendarPromptContext,
} from "./calendar-relevance.js";

describe("calendar relevance", () => {
  it("does not leak a private entry merely because it happens in the date range", () => {
    const result = selectCalendarPromptContext({
      entries: [entry({ scope: "user_private", title: "Therapy appointment" })],
      agentId: "agent_1",
      query: "How are you today?",
      dateRange: {
        startLocalDateInclusive: "2026-08-21",
        endLocalDateExclusive: "2026-08-22",
      },
      explicitDateQuery: false,
    });

    expect(result).toEqual([]);
  });

  it("includes a private entry for a lexical title hit or explicit date query", () => {
    const privateEntry = entry({
      scope: "user_private",
      title: "Therapy appointment",
    });
    const lexical = selectCalendarPromptContext({
      entries: [privateEntry],
      agentId: "agent_1",
      query: "Can we discuss my therapy appointment?",
      explicitDateQuery: false,
    });
    const dated = selectCalendarPromptContext({
      entries: [privateEntry],
      agentId: "agent_1",
      query: "What is happening today?",
      dateRange: {
        startLocalDateInclusive: "2026-08-21",
        endLocalDateExclusive: "2026-08-22",
      },
      explicitDateQuery: true,
    });

    expect(lexical).toHaveLength(1);
    expect(dated).toHaveLength(1);
    expect(lexical[0]?.ref).toBe("calendar_1");
    expect(lexical[0]?.label).not.toContain(privateEntry.id);
  });

  it("isolates agent entries and includes public events in a matching range", () => {
    const result = selectCalendarPromptContext({
      entries: [
        entry({
          id: "calendar_other",
          agentId: "agent_2",
          scope: "character_world",
          title: "Other agent event",
        }),
        entry({
          id: "calendar_public",
          agentId: undefined,
          scope: "public_system",
          title: "Public holiday",
        }),
      ],
      agentId: "agent_1",
      query: "hello",
      dateRange: {
        startLocalDateInclusive: "2026-08-21",
        endLocalDateExclusive: "2026-08-22",
      },
      explicitDateQuery: false,
    });

    expect(result.map((item) => item.label)).toEqual([
      "all-day | Public holiday",
    ]);
  });

  it("projects yearly occurrences into the requested local year", () => {
    const result = selectCalendarPromptContext({
      entries: [
        entry({
          localDate: "2020-08-21",
          recurrence: "yearly",
          scope: "public_system",
          agentId: undefined,
          title: "Anniversary",
        }),
      ],
      agentId: "agent_1",
      query: "",
      dateRange: {
        startLocalDateInclusive: "2026-08-21",
        endLocalDateExclusive: "2026-08-22",
      },
      explicitDateQuery: false,
    });

    expect(result[0]?.localDate).toBe("2026-08-21");
  });

  it("builds stable scope-aware dedupe keys", () => {
    expect(
      buildCalendarDedupeKey({
        agentId: "agent_1",
        scope: "character_world",
        title: "  Research   Day ",
        localDate: "2026-08-21",
        recurrence: "none",
      }),
    ).toBe("character_world:agent_1:none:2026-08-21:research day");
  });
});

function entry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: "calendar_1",
    agentId: "agent_1",
    scope: "character_world",
    title: "Research day",
    localDate: "2026-08-21",
    timezone: "Asia/Shanghai",
    allDay: true,
    recurrence: "none",
    source: "manual",
    status: "active",
    dedupeKey: "calendar-key",
    revision: 0,
    createdAtUtc: "2026-08-20T00:00:00.000Z",
    updatedAtUtc: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}
