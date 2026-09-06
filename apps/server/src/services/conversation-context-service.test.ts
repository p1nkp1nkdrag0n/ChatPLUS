import type { AgentAutobiographySnapshot } from "@personasim/contracts";
import type { DateDigest, TemporalQueryResolution } from "@personasim/features";
import { describe, expect, it, vi } from "vitest";

import type { AutobiographyService } from "./autobiography-service.js";
import type { CalendarService } from "./calendar-service.js";
import { ConversationContextService } from "./conversation-context-service.js";
import type { RelationshipArtifactsPromptContextProvider } from "./conversation-context-service.js";
import type { ContinuityIndexService } from "./continuity-index-service.js";
import type { ConversationContinuityService } from "./conversation-continuity-service.js";
import type {
  DateDigestQueryResult,
  DateDigestService,
} from "./date-digest-service.js";

const NOW = "2026-08-21T12:00:00.000Z";

describe("ConversationContextService", () => {
  it("turns an ambiguous date query into required clarification without calendar guessing", () => {
    const fixture = createFixture({
      dateQuery: {
        resolution: {
          kind: "ambiguous",
          reasonCode: "anchor_not_found",
        },
      },
      autobiographyMode: "shadow",
    });

    const result = fixture.service.prepare({
      agentId: "agent-1",
      userText: "\u665a\u4f1a\u4e4b\u540e\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f",
      nowUtc: NOW,
      timezone: "Asia/Shanghai",
    });

    expect(result.temporalResolution).toEqual({
      kind: "ambiguous",
      reasonCode: "anchor_not_found",
    });
    expect(result.calendarContext).toEqual([]);
    expect(fixture.selectCalendar).not.toHaveBeenCalled();
    expect(fixture.prepareContinuity).toHaveBeenCalledWith({
      agentId: "agent-1",
      userText: "\u665a\u4f1a\u4e4b\u540e\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f",
      limit: 2,
    });
    expect(fixture.temporalAnchors).toHaveBeenCalledWith({
      agentId: "agent-1",
      nowUtc: NOW,
      suppressedMemoryIds: [],
      query: "\u665a\u4f1a\u4e4b\u540e\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f",
      limit: 20,
    });
    expect(fixture.queryDateDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        anchors: [
          {
            id: "event-card-party",
            label: "party",
            startAtUtc: "2026-08-20T12:00:00.000Z",
            certainty: "exact",
          },
        ],
      }),
    );
    expect(result.continuity.careCues).toHaveLength(2);
    expect(result.autobiography).toBeUndefined();

    const segment = result.additionalPromptSegments[0];
    expect(segment).toMatchObject({
      id: "13a_temporal_clarification",
      required: true,
    });
    expect(segment?.render({})).toContain("Ask a brief clarifying question");
    expect(segment?.render({})).toContain("Do not guess a date");
  });

  it("bounds resolved calendar context to the verified local date range", () => {
    const resolution: TemporalQueryResolution = {
      kind: "resolved",
      expression: "yesterday",
      fromUtc: "2026-08-19T16:00:00.000Z",
      toUtc: "2026-08-20T16:00:00.000Z",
    };
    const digest: DateDigest = {
      fromUtc: resolution.fromUtc,
      toUtc: resolution.toUtc,
      items: [
        {
          sourceType: "activity_event",
          sourceId: "activity-1",
          kind: "activity_event",
          content: "Finished a verified walk.",
          occurredStartAtUtc: "2026-08-20T02:00:00.000Z",
          sourceEvidenceIds: ["evidence-1"],
        },
      ],
      sourceEvidenceIds: ["evidence-1"],
    };
    const fixture = createFixture({
      dateQuery: { resolution, digest },
      autobiographyMode: "enforced",
    });

    const result = fixture.service.prepare({
      agentId: "agent-1",
      userText: "\u6628\u5929\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f",
      nowUtc: NOW,
      timezone: "Asia/Shanghai",
    });

    expect(fixture.selectCalendar).toHaveBeenCalledWith({
      agentId: "agent-1",
      query: "\u6628\u5929\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f",
      explicitDateQuery: true,
      dateRange: {
        startLocalDateInclusive: "2026-08-20",
        endLocalDateExclusive: "2026-08-21",
      },
      limit: 12,
    });
    expect(result.autobiography).toBe(fixture.autobiographySnapshot);
    expect(result.additionalPromptSegments).toHaveLength(1);
    const rendered = result.additionalPromptSegments[0]?.render({});
    expect(rendered).toContain("Verified date-range digest");
    expect(rendered).toContain('"sourceId":"activity-1"');
    expect(rendered).toContain("planned items as non-occurrences");
  });

  it("lets enforced recall own the single date evidence bundle", () => {
    const resolution: TemporalQueryResolution = {
      kind: "resolved",
      expression: "yesterday",
      fromUtc: "2026-08-19T16:00:00.000Z",
      toUtc: "2026-08-20T16:00:00.000Z",
    };
    const fixture = createFixture({
      dateQuery: {
        resolution,
        digest: {
          fromUtc: resolution.fromUtc,
          toUtc: resolution.toUtc,
          items: [
            {
              sourceType: "activity_event",
              sourceId: "activity-1",
              kind: "activity_event",
              content: "Finished a verified walk.",
              occurredStartAtUtc: "2026-08-20T02:00:00.000Z",
              sourceEvidenceIds: ["evidence-1"],
            },
          ],
          sourceEvidenceIds: ["evidence-1"],
        },
      },
      autobiographyMode: "off",
      memoryRecallMode: "enforced",
    });

    const result = fixture.service.prepare({
      agentId: "agent-1",
      userText: "\u6628\u5929\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f",
      nowUtc: NOW,
      timezone: "Asia/Shanghai",
    });

    expect(result.temporalResolution).toEqual(resolution);
    expect(result.additionalPromptSegments).toEqual([]);
  });

  it("forwards the turn clock and projection exclusions to autobiography and temporal anchors", () => {
    const fixture = createFixture({
      dateQuery: { resolution: { kind: "none" } },
      autobiographyMode: "enforced",
    });
    fixture.service.prepare({
      agentId: "agent-1",
      userText: "最近怎么样？",
      nowUtc: NOW,
      timezone: "Asia/Shanghai",
      suppressedMemoryIds: ["memory-withdrawn-preference"],
    });
    expect(fixture.latestAutobiography).toHaveBeenCalledWith("agent-1", NOW, [
      "memory-withdrawn-preference",
    ]);
    expect(fixture.temporalAnchors).toHaveBeenCalledWith(
      expect.objectContaining({
        nowUtc: NOW,
        suppressedMemoryIds: ["memory-withdrawn-preference"],
      }),
    );
  });

  it("adds bounded safe relationship artifacts through the optional provider", () => {
    const relationshipArtifacts = vi.fn(() => ({
      correspondence: [
        {
          id: "letter-reply-1",
          direction: "agent_to_user",
          status: "in_transit",
          arrivalDueAtUtc: "2026-08-26T12:00:00.000Z",
        },
      ],
      readyKeepsakes: [
        {
          id: "keepsake-ticket-1",
          title: "雨夜票根",
          kind: "ticket_stub",
          description: "一起看完电影留下的票根。",
          sourceEventIds: ["milestone-1"],
          sourceMemoryIds: [],
          sourceLetterIds: [],
          createdEffectiveAtUtc: "2026-08-20T12:00:00.000Z",
        },
      ],
    }));
    const fixture = createFixture({
      dateQuery: { resolution: { kind: "none" } },
      autobiographyMode: "off",
      relationshipArtifacts,
    });

    const result = fixture.service.prepare({
      agentId: "agent-1",
      userText: "你最近寄出的信和那张票根呢？",
      nowUtc: NOW,
      timezone: "Asia/Shanghai",
    });
    const segment = result.additionalPromptSegments.find(
      (item) => item.id === "12b_relationship_artifacts",
    );
    const rendered = segment?.render({}) ?? "";

    expect(relationshipArtifacts).toHaveBeenCalledWith("agent-1", NOW);
    expect(rendered).toContain("keepsake-ticket-1");
    expect(rendered).toContain("雨夜票根");
    expect(rendered).toContain('"status":"in_transit"');
    expect(rendered).toContain("without private letter bodies or image data");
  });
});

function createFixture(input: {
  dateQuery: DateDigestQueryResult;
  autobiographyMode: "off" | "shadow" | "enforced";
  memoryRecallMode?: "legacy" | "shadow" | "enforced";
  relationshipArtifacts?: RelationshipArtifactsPromptContextProvider;
}): {
  service: ConversationContextService;
  prepareContinuity: ReturnType<typeof vi.fn>;
  selectCalendar: ReturnType<typeof vi.fn>;
  queryDateDigest: ReturnType<typeof vi.fn>;
  temporalAnchors: ReturnType<typeof vi.fn>;
  autobiographySnapshot: AgentAutobiographySnapshot;
  latestAutobiography: ReturnType<typeof vi.fn>;
} {
  const prepareContinuity = vi.fn(() => ({
    cueIds: ["cue-1", "cue-2"],
    careCues: [
      {
        id: "cue-1",
        contextSummary: "Portfolio deadline",
        mentionGuidance: "Mention only when relevant.",
        expiresAtUtc: "2026-08-28T12:00:00.000Z",
      },
      {
        id: "cue-2",
        contextSummary: "Interview",
        mentionGuidance: "Ask naturally.",
        expiresAtUtc: "2026-08-29T12:00:00.000Z",
      },
    ],
  }));
  const continuity = {
    preparePrompt: prepareContinuity,
    commitTurn: vi.fn(),
  } as unknown as ConversationContinuityService;

  const autobiographySnapshot = {
    id: "autobiography-1",
  } as unknown as AgentAutobiographySnapshot;
  const latestAutobiography = vi.fn(() => ({
    snapshot: autobiographySnapshot,
    entries: [],
  }));
  const autobiographies = {
    latest: latestAutobiography,
  } as unknown as AutobiographyService;

  const selectCalendar = vi.fn(() => []);
  const calendar = {
    selectPromptContext: selectCalendar,
  } as unknown as CalendarService;
  const queryDateDigest = vi.fn(() => input.dateQuery);
  const dateDigests = {
    query: queryDateDigest,
  } as unknown as DateDigestService;
  const temporalAnchors = vi.fn(() => [
    {
      id: "event-card-party",
      label: "party",
      startAtUtc: "2026-08-20T12:00:00.000Z",
      certainty: "exact" as const,
    },
  ]);
  const continuityIndex = {
    temporalAnchors,
  } as unknown as ContinuityIndexService;

  return {
    service: new ConversationContextService(
      continuity,
      autobiographies,
      calendar,
      dateDigests,
      continuityIndex,
      input.autobiographyMode,
      input.memoryRecallMode ?? "legacy",
      input.relationshipArtifacts,
    ),
    prepareContinuity,
    selectCalendar,
    queryDateDigest,
    temporalAnchors,
    autobiographySnapshot,
    latestAutobiography,
  };
}
