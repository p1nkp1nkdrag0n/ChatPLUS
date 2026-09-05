import {
  EventCardDraftSchema,
  EventCardSchema,
  type EventCard,
  type EventCardDraft,
  type ContinuityEvidenceRef,
} from "@personasim/contracts";
import { stableId, type TemporalAnchorLike } from "@personasim/features";

import type { StoredActivityEvent } from "../db/store.js";
import type { Clock } from "../runtime/clock.js";
import type { VerifiedContinuityEvidence } from "./autobiography-service.js";
import { checkpointEntryCardTitle } from "./checkpoint-report-excerpts.js";
import type {
  ArchivedMessage,
  ContinuityRepository,
} from "./continuity-repository.js";

export type PreparedEventCards =
  | { accepted: true; cards: EventCard[] }
  | { accepted: false; issues: string[] };

export interface ContinuityIndexRebuildResult {
  agentId: string;
  archivedMessageCount: number;
  eventCardCount: number;
}

export class ContinuityIndexService {
  constructor(
    private readonly repository: ContinuityRepository,
    private readonly clock: Clock,
  ) {}

  prepareCheckpointCards(input: {
    agentId: string;
    sessionId: string;
    checkpointId: string;
    drafts: readonly EventCardDraft[];
    evidenceCatalog: readonly VerifiedContinuityEvidence[];
    nowUtc: string;
  }): PreparedEventCards {
    const evidenceById = new Map(
      input.evidenceCatalog.map((evidence) => [evidence.id, evidence]),
    );
    const cards: EventCard[] = [];
    const issues: string[] = [];
    for (const [index, candidate] of input.drafts.entries()) {
      const draft = EventCardDraftSchema.safeParse(candidate);
      if (!draft.success) {
        issues.push(
          `card[${index}]: ${draft.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
        continue;
      }
      const verifiedEvidence: ContinuityEvidenceRef[] = [];
      for (const reference of draft.data.evidence) {
        const verified = evidenceById.get(reference.id);
        if (
          verified === undefined ||
          verified.sourceType !== reference.sourceType ||
          verified.sourceId !== reference.sourceId
        ) {
          issues.push(`card[${index}]: unverified evidence ${reference.id}`);
          continue;
        }
        verifiedEvidence.push(toEvidenceRef(verified));
      }
      if (verifiedEvidence.length !== draft.data.evidence.length) continue;
      const dedupeKey = stableId(
        "continuity",
        `${input.agentId}:${draft.data.dedupeKey}`,
      );
      const card = EventCardSchema.safeParse({
        id: stableId("event_card", dedupeKey),
        agentId: input.agentId,
        sessionId: input.sessionId,
        checkpointId: input.checkpointId,
        ...draft.data,
        sourceId:
          draft.data.sourceKind === "checkpoint"
            ? input.checkpointId
            : draft.data.sourceId,
        dedupeKey,
        evidence: verifiedEvidence,
        sourceEvidenceIds: verifiedEvidence.map((evidence) => evidence.id),
        status: "active",
        indexVersion: 1,
        createdAtUtc: input.nowUtc,
        updatedAtUtc: input.nowUtc,
      });
      if (card.success) cards.push(card.data);
      else {
        issues.push(
          `card[${index}]: ${card.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
    }
    return issues.length === 0
      ? { accepted: true, cards }
      : { accepted: false, issues };
  }

  persistPrepared(
    prepared: Extract<PreparedEventCards, { accepted: true }>,
  ): number {
    return this.repository.upsertEventCards(prepared.cards);
  }

  upsertActivityEvents(events: readonly StoredActivityEvent[]): number {
    return this.repository.upsertEventCards(
      events.map((event) => activityEventCard(event)),
    );
  }

  searchEventCards(input: {
    agentId: string;
    query: string;
    limit?: number;
  }): EventCard[] {
    return this.repository.searchEventCards(input);
  }

  scanExplicitFactEventCards(input: {
    agentId: string;
    searchTerms: readonly string[];
    scanLimit: number;
  }) {
    return this.repository.scanExplicitFactEventCards(input);
  }
  temporalAnchors(input: {
    agentId: string;
    query: string;
    limit?: number;
  }): TemporalAnchorLike[] {
    return temporalAnchorsFromEventCards(
      this.searchEventCards(input),
      input.query,
    );
  }

  searchVerbatim(input: {
    agentId: string;
    query: string;
    limit?: number;
  }): ArchivedMessage[] {
    return this.repository.searchArchivedMessages(input);
  }

  rebuildAgent(agentId: string): ContinuityIndexRebuildResult {
    const nowUtc = this.clock.nowUtc();
    const cards = deduplicateCards([
      ...this.cardsFromCheckpointArtifacts(agentId),
      ...this.cardsFromActivities(agentId),
      ...this.cardsFromAutobiography(agentId),
      ...this.cardsFromDomainEvents(agentId),
    ]);
    return this.repository.transaction(() => ({
      agentId,
      archivedMessageCount: this.repository.rebuildMessageArchive(
        agentId,
        nowUtc,
      ),
      eventCardCount: this.repository.replaceEventCards(agentId, cards),
    }));
  }

  private cardsFromCheckpointArtifacts(agentId: string): EventCard[] {
    const cards: EventCard[] = [];
    for (const checkpoint of this.repository.listCommittedCheckpoints(
      agentId,
    )) {
      if (!isObject(checkpoint.artifact)) continue;
      const artifactCards = checkpoint.artifact["eventCards"];
      if (!Array.isArray(artifactCards)) continue;
      for (const candidate of artifactCards) {
        const parsed = EventCardSchema.safeParse(candidate);
        if (
          parsed.success &&
          parsed.data.agentId === agentId &&
          parsed.data.checkpointId === checkpoint.id
        ) {
          cards.push(parsed.data);
        }
      }
    }
    return cards;
  }

  private cardsFromActivities(agentId: string): EventCard[] {
    return this.repository.listActivitiesForIndex(agentId).map((row) =>
      activityEventCard({
        id: String(row["id"]),
        agentId,
        eventType: String(
          row["event_type"],
        ) as StoredActivityEvent["eventType"],
        occurredAtUtc: String(row["occurred_at_utc"]),
        summary: String(row["summary"]),
      }),
    );
  }

  private cardsFromAutobiography(agentId: string): EventCard[] {
    return this.repository
      .listAutobiographyEntries(agentId)
      .flatMap((entry) => {
        const temporalMetadata = temporalFromEntry(entry);
        const parsed = EventCardSchema.safeParse({
          id: stableId("event_card", `autobiography_entry:${entry.id}`),
          agentId,
          cardKind: cardKindFromEntry(entry.entryKind),
          sourceKind: "autobiography_entry",
          sourceId: entry.id,
          dedupeKey: stableId(
            "continuity",
            `${agentId}:autobiography_entry:${entry.id}`,
          ),
          title: checkpointEntryCardTitle(entry),
          summary: entry.content,
          tags: [entry.entryKind],
          namespace: "character_self",
          certainty: "explicit",
          attribution: "mixed",
          temporalMetadata,
          importance: 0.6,
          evidence: entry.evidence,
          sourceEvidenceIds: entry.sourceEvidenceIds,
          status: "active",
          indexVersion: 1,
          createdAtUtc: entry.createdAtUtc,
          updatedAtUtc: entry.createdAtUtc,
        });
        return parsed.success ? [parsed.data] : [];
      });
  }

  private cardsFromDomainEvents(agentId: string): EventCard[] {
    return this.repository.listDomainEventsForIndex(agentId).flatMap((row) => {
      const id = String(row["id"]);
      const eventType = String(row["event_type"]);
      const recordedAtUtc = String(row["recorded_at_utc"]);
      const effectiveAtUtc = String(row["effective_at_utc"]);
      const contextSummary =
        `${eventType}: ${String(row["payload_json"])}`.slice(0, 1_000);
      const evidence: ContinuityEvidenceRef = {
        id: stableId("evidence", `domain_event:${id}`),
        sourceType: "domain_event",
        sourceId: id,
        contextSummary,
        temporalStatus: "unknown",
        reliability: "fact",
        recordedAtUtc,
      };
      const parsed = EventCardSchema.safeParse({
        id: stableId("event_card", `domain_event:${id}`),
        agentId,
        cardKind: "conversation",
        sourceKind: "domain_event",
        sourceId: id,
        dedupeKey: stableId("continuity", `${agentId}:domain_event:${id}`),
        title: eventType.slice(0, 240),
        summary: contextSummary,
        tags: ["domain_event", eventType.slice(0, 64)],
        namespace: "runtime_simulation",
        certainty: "explicit",
        attribution: "simulation_event",
        temporalMetadata: {
          mentionedAtUtc: effectiveAtUtc,
          recordedAtUtc,
          temporalCertainty: "exact",
          temporalStatus: "unknown",
        },
        importance: 0.4,
        evidence: [evidence],
        sourceEvidenceIds: [evidence.id],
        status: "active",
        indexVersion: 1,
        createdAtUtc: recordedAtUtc,
        updatedAtUtc: recordedAtUtc,
      });
      return parsed.success ? [parsed.data] : [];
    });
  }
}

function activityEventCard(
  event: Pick<
    StoredActivityEvent,
    "id" | "agentId" | "eventType" | "occurredAtUtc" | "summary"
  >,
): EventCard {
  const evidence: ContinuityEvidenceRef = {
    id: stableId("evidence", `activity_event:${event.id}`),
    sourceType: "activity_event",
    sourceId: event.id,
    contextSummary: event.summary.slice(0, 1_000),
    temporalStatus: "occurred",
    reliability: "fact",
    recordedAtUtc: event.occurredAtUtc,
  };
  return EventCardSchema.parse({
    id: stableId("event_card", `activity_event:${event.id}`),
    agentId: event.agentId,
    cardKind: "activity",
    sourceKind: "activity_event",
    sourceId: event.id,
    dedupeKey: stableId(
      "continuity",
      `${event.agentId}:activity_event:${event.id}`,
    ),
    title: event.summary.slice(0, 240),
    summary: event.summary.slice(0, 2_000),
    tags: [event.eventType],
    namespace: "runtime_simulation",
    certainty: "explicit",
    attribution: "simulation_event",
    temporalMetadata: {
      occurredStartAtUtc: event.occurredAtUtc,
      recordedAtUtc: event.occurredAtUtc,
      temporalCertainty: "exact",
      temporalStatus: "occurred",
    },
    importance: 0.5,
    evidence: [evidence],
    sourceEvidenceIds: [evidence.id],
    status: "active",
    indexVersion: 1,
    createdAtUtc: event.occurredAtUtc,
    updatedAtUtc: event.occurredAtUtc,
  });
}

function temporalFromEntry(
  entry: ReturnType<ContinuityRepository["listAutobiographyEntries"]>[number],
): EventCard["temporalMetadata"] {
  if (entry.temporalStatus === "occurred" && entry.fromUtc !== undefined) {
    return {
      occurredStartAtUtc: entry.fromUtc,
      ...(entry.throughUtc === undefined
        ? {}
        : { occurredEndAtUtc: entry.throughUtc }),
      recordedAtUtc: entry.createdAtUtc,
      temporalCertainty: "exact",
      temporalStatus: "occurred",
    };
  }
  if (entry.temporalStatus === "planned") {
    return {
      ...(entry.fromUtc === undefined
        ? {}
        : { plannedStartAtUtc: entry.fromUtc }),
      ...(entry.throughUtc === undefined
        ? {}
        : { plannedEndAtUtc: entry.throughUtc }),
      recordedAtUtc: entry.createdAtUtc,
      temporalCertainty: entry.fromUtc === undefined ? "unknown" : "exact",
      temporalStatus: "planned",
    };
  }
  return {
    mentionedAtUtc: entry.fromUtc ?? entry.createdAtUtc,
    recordedAtUtc: entry.createdAtUtc,
    temporalCertainty: entry.fromUtc === undefined ? "unknown" : "exact",
    temporalStatus: "unknown",
  };
}

function cardKindFromEntry(
  kind: ReturnType<
    ContinuityRepository["listAutobiographyEntries"]
  >[number]["entryKind"],
): EventCard["cardKind"] {
  if (kind === "relationship_change") return "relationship_change";
  if (kind === "active_goal") return "goal";
  if (kind === "commitment") return "commitment";
  return "shared_experience";
}

function toEvidenceRef(
  evidence: VerifiedContinuityEvidence,
): ContinuityEvidenceRef {
  return {
    id: evidence.id,
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    ...(evidence.quote === undefined ? {} : { quote: evidence.quote }),
    ...(evidence.contextSummary === undefined
      ? {}
      : { contextSummary: evidence.contextSummary }),
    ...(evidence.temporalStatus === undefined
      ? {}
      : { temporalStatus: evidence.temporalStatus }),
    reliability: evidence.reliability,
    recordedAtUtc: evidence.recordedAtUtc,
  };
}

export function temporalAnchorsFromEventCards(
  cards: readonly EventCard[],
  query: string,
): TemporalAnchorLike[] {
  const normalizedQuery = normalizeAnchorText(query);
  const byCardId = new Map<string, TemporalAnchorLike>();
  for (const card of cards) {
    const temporal = card.temporalMetadata;
    if (
      card.status !== "active" ||
      temporal.temporalStatus !== "occurred" ||
      temporal.occurredStartAtUtc === undefined ||
      (temporal.temporalCertainty !== "exact" &&
        temporal.temporalCertainty !== "date_only") ||
      !card.evidence.some(
        (item) =>
          item.reliability === "fact" || item.reliability === "reported",
      )
    ) {
      continue;
    }
    const label = [card.title, card.summary, ...card.tags]
      .filter((candidate) => {
        const normalized = normalizeAnchorText(candidate);
        return normalized.length > 0 && normalizedQuery.includes(normalized);
      })
      .sort(
        (left, right) =>
          normalizeAnchorText(right).length - normalizeAnchorText(left).length,
      )[0];
    if (label === undefined) continue;
    byCardId.set(card.id, {
      id: card.id,
      label,
      startAtUtc: temporal.occurredStartAtUtc,
      ...(temporal.occurredEndAtUtc === undefined
        ? {}
        : { endAtUtc: temporal.occurredEndAtUtc }),
      certainty: temporal.temporalCertainty,
    });
  }
  return [...byCardId.values()];
}

function normalizeAnchorText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function deduplicateCards(cards: readonly EventCard[]): EventCard[] {
  const byKey = new Map<string, EventCard>();
  for (const card of cards) byKey.set(card.dedupeKey, card);
  return [...byKey.values()];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
