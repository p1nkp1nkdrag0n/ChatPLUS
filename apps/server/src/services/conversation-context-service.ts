import type {
  AgentAutobiographySnapshot,
  CalendarPromptItem,
} from "@personasim/contracts";
import type {
  DateDigest,
  DefaultPromptContext,
  PromptSegment,
  TemporalQueryResolution,
} from "@personasim/features";
import { DateTime } from "luxon";

import type { AutobiographyService } from "./autobiography-service.js";
import type { CalendarService } from "./calendar-service.js";
import type {
  ConversationContinuityPromptContext,
  ConversationContinuityService,
} from "./conversation-continuity-service.js";
import type { ContinuityIndexService } from "./continuity-index-service.js";
import type { DateDigestService } from "./date-digest-service.js";

export interface PreparedConversationContext {
  continuity: ConversationContinuityPromptContext;
  calendarContext: CalendarPromptItem[];
  additionalPromptSegments: PromptSegment<DefaultPromptContext>[];
  temporalResolution: TemporalQueryResolution;
  autobiography?: AgentAutobiographySnapshot;
}

export interface RelationshipArtifactsPromptContext {
  readonly correspondence: readonly Readonly<Record<string, unknown>>[];
  readonly readyKeepsakes: readonly Readonly<Record<string, unknown>>[];
}

export type RelationshipArtifactsPromptContextProvider = (
  agentId: string,
  nowUtc: string,
) => RelationshipArtifactsPromptContext;

/** Collects bounded, turn-local context without placing selection rules in chat orchestration. */
export class ConversationContextService {
  constructor(
    private readonly continuity: ConversationContinuityService,
    private readonly autobiographies: AutobiographyService,
    private readonly calendar: CalendarService,
    private readonly dateDigests: DateDigestService,
    private readonly continuityIndex: ContinuityIndexService,
    private readonly autobiographyMode: "off" | "shadow" | "enforced",
    private readonly memoryRecallMode: "legacy" | "shadow" | "enforced",
    private readonly relationshipArtifacts?: RelationshipArtifactsPromptContextProvider,
  ) {}

  prepare(input: {
    agentId: string;
    userText: string;
    nowUtc: string;
    timezone: string;
  }): PreparedConversationContext {
    const continuity = this.continuity.preparePrompt({
      agentId: input.agentId,
      userText: input.userText,
      limit: 2,
    });
    const temporal = this.dateDigests.query({
      agentId: input.agentId,
      text: input.userText,
      nowUtc: input.nowUtc,
      timezone: input.timezone,
      anchors: this.continuityIndex.temporalAnchors({
        agentId: input.agentId,
        query: input.userText,
        limit: 20,
      }),
      maxItems: 20,
    });
    const dateRange =
      temporal.resolution.kind === "resolved"
        ? localCalendarRange(
            temporal.resolution.fromUtc,
            temporal.resolution.toUtc,
            input.timezone,
          )
        : undefined;
    const calendarContext =
      temporal.resolution.kind === "ambiguous"
        ? []
        : this.calendar.selectPromptContext({
            agentId: input.agentId,
            query: input.userText,
            explicitDateQuery: temporal.resolution.kind === "resolved",
            limit: 12,
            ...(dateRange === undefined ? {} : { dateRange }),
          });
    const additionalPromptSegments = [
      ...temporalSegments(
        temporal.resolution,
        this.memoryRecallMode === "enforced" ? undefined : temporal.digest,
      ),
      ...relationshipArtifactSegments(
        this.relationshipArtifacts?.(input.agentId, input.nowUtc),
      ),
    ];
    const autobiography =
      this.autobiographyMode === "enforced"
        ? this.autobiographies.latest(input.agentId)?.snapshot
        : undefined;

    return {
      continuity,
      calendarContext,
      additionalPromptSegments,
      temporalResolution: temporal.resolution,
      ...(autobiography === undefined ? {} : { autobiography }),
    };
  }

  commitTurn(
    input: Parameters<ConversationContinuityService["commitTurn"]>[0],
  ): ReturnType<ConversationContinuityService["commitTurn"]> {
    return this.continuity.commitTurn(input);
  }

  reconcileMemories(
    agentId: string,
    memoryIds: readonly string[],
  ): ReturnType<ConversationContinuityService["reconcileMemories"]> {
    return this.continuity.reconcileMemories(agentId, memoryIds);
  }
}

function relationshipArtifactSegments(
  context: RelationshipArtifactsPromptContext | undefined,
): PromptSegment<DefaultPromptContext>[] {
  if (
    context === undefined ||
    (context.correspondence.length === 0 && context.readyKeepsakes.length === 0)
  ) {
    return [];
  }
  return [
    staticSegment(
      "12b_relationship_artifacts",
      [
        "Current relationship artifacts, projected without private letter bodies or image data.",
        "Correspondence rows authorize only the stated lifecycle phase and timestamps. A read incoming letter may be acknowledged as received; never invent or reveal its text. Outgoing rows never authorize quoting a reply.",
        "Only readyKeepsakes are durable artifacts that may be mentioned naturally when relevant. Source IDs are provenance, not prose.",
        JSON.stringify(context),
      ].join("\n"),
      false,
      88,
      760,
    ),
  ];
}

function localCalendarRange(
  fromUtc: string,
  toUtc: string,
  timezone: string,
): { startLocalDateInclusive: string; endLocalDateExclusive: string } {
  return {
    startLocalDateInclusive: DateTime.fromISO(fromUtc, { setZone: true })
      .setZone(timezone)
      .toISODate()!,
    endLocalDateExclusive: DateTime.fromISO(toUtc, { setZone: true })
      .setZone(timezone)
      .toISODate()!,
  };
}

function temporalSegments(
  resolution: TemporalQueryResolution,
  digest: DateDigest | undefined,
): PromptSegment<DefaultPromptContext>[] {
  if (resolution.kind === "ambiguous") {
    return [
      staticSegment(
        "13a_temporal_clarification",
        `Temporal query is ambiguous (${resolution.reasonCode}). Ask a brief clarifying question. Do not guess a date or recall events outside a verified range.`,
        true,
        96,
        120,
      ),
    ];
  }
  if (resolution.kind !== "resolved" || digest === undefined) return [];
  return [
    staticSegment(
      "13a_date_digest",
      [
        "Verified date-range digest. Treat planned items as non-occurrences and use only these occurred facts:",
        JSON.stringify(digest),
      ].join("\n"),
      false,
      90,
      900,
    ),
  ];
}

function staticSegment(
  id: string,
  content: string,
  required: boolean,
  priority: number,
  tokenBudget: number,
): PromptSegment<DefaultPromptContext> {
  return {
    id,
    placement: "prompt",
    priority,
    tokenBudget,
    required,
    cacheable: false,
    render: () => content,
  };
}
