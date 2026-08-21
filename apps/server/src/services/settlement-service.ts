import { DateTime } from "luxon";
import { settleSchedule, settlementIdempotencyKey } from "@personasim/features";

import type {
  DatabaseStore,
  StoredActivityEvent,
} from "../db/store.js";
import { capabilitiesForTier } from "../domain/capabilities.js";
import {
  toFeatureScheduleItems,
  toFeatureState,
} from "../domain/feature-adapters.js";
import { notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import {
  activityEnrichmentSchema,
  runtimeStateSchema,
  type CharacterSpec,
  type RuntimeState,
  type ScheduleItem,
  type StateDelta,
} from "../domain/schemas.js";
import { canonicalUtc, compareUtc } from "../domain/time.js";
import type { Clock } from "../runtime/clock.js";
import type { SseHub } from "../sse/hub.js";
import type { ContinuityIndexService } from "./continuity-index-service.js";
import type { LlmService } from "./llm-service.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";
import type { ScheduleService } from "./schedule-service.js";

export type SettlementResult = {
  agentId: string;
  fromUtc: string;
  toUtc: string;
  idempotencyKey: string;
  alreadySettled: boolean;
  activityEvents: StoredActivityEvent[];
  updatedScheduleItems: ScheduleItem[];
  state: RuntimeState;
};

type ProjectedOutcome = {
  item: ScheduleItem;
  events: StoredActivityEvent[];
  stateDelta: StateDelta;
  completed: boolean;
};

export class SettlementService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
    private readonly schedules: ScheduleService,
    private readonly sse: SseHub,
    private readonly options: {
      continuityIndex?: ContinuityIndexService;
    } = {},
  ) {}

  async settle(
    agentId: string,
    input: { toUtc?: string; hourlyBucket?: string } = {},
  ): Promise<SettlementResult> {
    const spec = this.store.getCharacterSpec(agentId);
    const state = this.store.getRuntimeState(agentId);
    const cursor = this.store.getCursor(agentId);
    if (!spec || !state || !cursor) throw notFound("Character");
    const toUtc = canonicalUtc(input.toUtc ?? this.clock.nowUtc());
    const capabilities = capabilitiesForTier(spec.tier);
    if (spec.status !== "published" || !capabilities.offlineSettlement) {
      return {
        agentId,
        fromUtc: cursor.lastSettledAtUtc,
        toUtc,
        idempotencyKey: settlementIdempotencyKey(
          agentId,
          cursor.lastSettledAtUtc,
          toUtc,
        ),
        alreadySettled: true,
        activityEvents: [],
        updatedScheduleItems: [],
        state,
      };
    }
    if (compareUtc(toUtc, cursor.lastSettledAtUtc) <= 0) {
      return {
        agentId,
        fromUtc: cursor.lastSettledAtUtc,
        toUtc,
        idempotencyKey: settlementIdempotencyKey(
          agentId,
          cursor.lastSettledAtUtc,
          toUtc,
        ),
        alreadySettled: true,
        activityEvents: [],
        updatedScheduleItems: [],
        state,
      };
    }

    const fromUtc = cursor.lastSettledAtUtc;
    const idempotencyKey = settlementIdempotencyKey(agentId, fromUtc, toUtc);
    const existingSettlement = this.store.database
      .prepare("SELECT result_json FROM settlements WHERE idempotency_key = ?")
      .get(idempotencyKey) as { result_json: string } | undefined;
    if (existingSettlement) {
      const previous = JSON.parse(
        existingSettlement.result_json,
      ) as SettlementResult;
      return { ...previous, alreadySettled: true };
    }

    const allItems = this.store.listSchedule(agentId);
    const existingEventKeys = new Set(
      (
        this.store.database
          .prepare(
            "SELECT idempotency_key FROM activity_events WHERE agent_id = ?",
          )
          .all(agentId) as Array<{ idempotency_key: string }>
      ).map((row) => row.idempotency_key),
    );
    // Include activities that start exactly on the persisted cursor boundary.
    // Activity event keys make this one-millisecond inclusive window idempotent.
    const inclusiveFromUtc = new Date(Date.parse(fromUtc) - 1).toISOString();
    const engineResult = settleSchedule({
      agentId,
      fromUtc: inclusiveFromUtc,
      toUtc,
      items: toFeatureScheduleItems(allItems),
      state: toFeatureState(state),
      routineAdherence: spec.schedulePolicy.routineAdherence,
      existingIdempotencyKeys: existingEventKeys,
    });
    const projections: ProjectedOutcome[] = engineResult.changedItems.map(
      (itemLike) => {
        const item = itemLike as ScheduleItem;
        const events = engineResult.events
          .filter((event) => event.scheduleItemId === item.id)
          .map((event): StoredActivityEvent => ({
            id: event.id,
            agentId: event.agentId,
            scheduleItemId: event.scheduleItemId,
            eventType: event.kind,
            occurredAtUtc: event.occurredAtUtc,
            summary: event.summary,
            outcomeFacts: event.kind === "started" ? [] : [event.summary],
            stateDelta: event.stateDelta ?? {},
            origin:
              event.kind === "started" ? "deterministic" : "seeded_probability",
            idempotencyKey: event.idempotencyKey,
          }));
        return {
          item,
          events,
          stateDelta:
            events.find((event) => event.eventType !== "started")?.stateDelta ??
            {},
          completed: events.some((event) => event.eventType === "completed"),
        };
      },
    );
    await this.enrichImportantEvents(spec, projections);
    const updatedScheduleItems = projections.map(
      (projection) => projection.item,
    );
    const activityEvents = projections.flatMap(
      (projection) => projection.events,
    );
    const nextState = runtimeStateSchema.parse(engineResult.state);

    const result: SettlementResult = {
      agentId,
      fromUtc,
      toUtc,
      idempotencyKey,
      alreadySettled: false,
      activityEvents,
      updatedScheduleItems,
      state: nextState,
    };

    this.store.transaction(() => {
      const duplicate = this.store.database
        .prepare("SELECT 1 FROM settlements WHERE idempotency_key = ?")
        .get(idempotencyKey);
      if (duplicate) return;
      const insertedActivityEvents: StoredActivityEvent[] = [];
      for (const projection of projections) {
        this.store.updateScheduleItem(projection.item);
        for (const event of projection.events) {
          if (!this.store.insertActivityEvent(event)) continue;
          insertedActivityEvents.push(event);
          if (event.eventType === "completed") {
            if (capabilities.longTermMemory) this.insertActivityMemory(event);
            if (capabilities.proactiveDialogue) {
              this.createProactiveCandidate(
                spec,
                projection.item,
                event,
                toUtc,
              );
            }
          }
        }
      }
      if (insertedActivityEvents.length > 0) {
        this.options.continuityIndex?.upsertActivityEvents(
          insertedActivityEvents,
        );
      }
      this.store.updateRuntimeState(nextState);
      this.store.updateCursor({
        ...cursor,
        lastSettledAtUtc: toUtc,
        lastHourlyBucket: input.hourlyBucket ?? cursor.lastHourlyBucket,
        revision: cursor.revision + 1,
      });
      this.store.database
        .prepare(
          `INSERT INTO settlements(id, agent_id, from_utc, to_utc, idempotency_key, result_json, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createEntityId("settlement"),
          agentId,
          fromUtc,
          toUtc,
          idempotencyKey,
          JSON.stringify(result),
          this.clock.nowUtc(),
        );
      this.store.insertDomainEvent({
        agentId,
        streamType: "simulation",
        streamId: agentId,
        streamVersion: cursor.revision + 1,
        eventType: "simulation.settled",
        recordedAtUtc: this.clock.nowUtc(),
        effectiveAtUtc: toUtc,
        payload: {
          fromUtc,
          toUtc,
          activityEventIds: activityEvents.map((event) => event.id),
        },
        idempotencyKey: `domain:${idempotencyKey}`,
      });
    });

    for (const event of activityEvents) {
      this.sse.publish({
        type: "activity.created",
        agentId,
        occurredAtUtc: event.occurredAtUtc,
        data: event,
      });
    }
    this.sse.publish({
      type: "state.updated",
      agentId,
      occurredAtUtc: toUtc,
      data: nextState,
    });
    this.sse.publish({
      type: "settlement.completed",
      agentId,
      occurredAtUtc: toUtc,
      data: result,
    });
    return result;
  }

  async settleAndExtend(
    agentId: string,
    input: { toUtc?: string; hourlyBucket?: string } = {},
  ): Promise<SettlementResult> {
    const result = await this.settle(agentId, input);
    const spec = this.store.getCharacterSpec(agentId);
    if (!spec) throw notFound("Character");
    if (spec.status === "published" && capabilitiesForTier(spec.tier).schedule)
      await this.schedules.ensure72Hours(agentId);
    return result;
  }

  private async enrichImportantEvents(
    spec: CharacterSpec,
    projections: ProjectedOutcome[],
  ): Promise<void> {
    if (!capabilitiesForTier(spec.tier).activityEnrichment) return;
    const important = projections.filter(
      (projection) =>
        projection.completed && projection.item.narrativeImportance >= 0.7,
    );
    if (important.length === 0) return;
    const completedActivities = important.map((projection) => {
      const event = projection.events.find(
        (candidate) => candidate.eventType === "completed",
      )!;
      return { eventId: event.id, scheduleItem: projection.item };
    });
    const fixture = {
      events: important.map((projection, index) => {
        const completedActivity = completedActivities[index]!;
        return {
          eventId: completedActivity.eventId,
          summary: `完成了${projection.item.title}，过程给今天留下了值得记住的一段经历。`,
          outcomeFacts: [
            `完成${projection.item.title}`,
            `活动类别：${projection.item.category}`,
          ],
          memoryCandidates: [
            {
              type: "activity_outcome" as const,
              content: `完成了${projection.item.title}。`,
              tags: [projection.item.category],
              importance: projection.item.narrativeImportance,
              confidence: 1,
            },
          ],
          proactiveSummary: `完成了${projection.item.title}，有一些新的感受`,
        };
      }),
    };
    try {
      const enriched = await this.llm.generateObject({
        purpose: "enrich_activity",
        agentId: spec.id,
        system:
          "Briefly enrich completed fictional activities. Add only plausible low-stakes details, never contradict the schedule, and do not expose hidden reasoning.",
        prompt:
          `Character: ${spec.identity.name}. Completed activities: ${JSON.stringify(
            completedActivities,
          )}. ` +
          `Return {events:[{eventId,summary,outcomeFacts,memoryCandidates,proactiveSummary}]}. ` +
          `Return exactly one entry for every completed activity and copy each input eventId verbatim into its matching output entry. ` +
          `Never invent, translate, shorten, or otherwise change an eventId.`,
        schema: activityEnrichmentSchema,
        fixture,
      });
      const expectedEventIds = new Set(
        completedActivities.map((activity) => activity.eventId),
      );
      if (
        enriched.events.length !== expectedEventIds.size ||
        enriched.events.some((event) => !expectedEventIds.has(event.eventId))
      ) {
        throw new Error(
          "Activity enrichment eventIds must exactly match completed activities.",
        );
      }
      for (const enrichment of enriched.events) {
        const projection = important.find((entry) =>
          entry.events.some((event) => event.id === enrichment.eventId),
        );
        const event = projection?.events.find(
          (candidate) => candidate.id === enrichment.eventId,
        );
        if (!event) continue;
        event.summary = enrichment.summary;
        event.outcomeFacts = enrichment.outcomeFacts;
        event.origin = "llm_enriched";
      }
    } catch {
      // Deterministic event summaries remain valid and truthful.
    }
  }

  private insertActivityMemory(event: StoredActivityEvent): void {
    validateMergeAndPersistMemories({
      store: this.store,
      agentId: event.agentId,
      candidates: [
        {
          kind: "episodic",
          content: event.summary,
          importance: event.origin === "llm_enriched" ? 0.78 : 0.62,
          confidence: 1,
          occurredAtUtc: event.occurredAtUtc,
          tags: ["activity"],
          sourceMessageIds: [],
          sourceActivityEventIds: [event.id],
          origin: "runtime_simulation",
          reasonCode: "activity_outcome",
          reasonSummary: "保存已结算活动的可追溯结果。",
        },
      ],
      nowUtc: event.occurredAtUtc,
      maxCandidates: 1,
      authoritativeActivityEventId: event.id,
    });
  }

  private createProactiveCandidate(
    spec: CharacterSpec,
    item: ScheduleItem,
    event: StoredActivityEvent,
    createdAtUtc: string,
  ): void {
    if (
      !capabilitiesForTier(spec.tier).proactiveDialogue ||
      !spec.proactivePolicy.enabled ||
      !item.shareable ||
      !spec.proactivePolicy.shareableCategories.includes(item.category)
    ) {
      return;
    }
    const expiresAtUtc = DateTime.fromISO(createdAtUtc)
      .plus({ hours: 48 })
      .toUTC()
      .toISO()!;
    const cooldownKey = `share:${item.category}:${DateTime.fromISO(createdAtUtc)
      .setZone(spec.identity.timezone)
      .toISODate()}`;
    const similar = this.store.database
      .prepare(
        `SELECT id, priority FROM proactive_candidates
         WHERE agent_id = ? AND status = 'pending' AND cooldown_key = ? LIMIT 1`,
      )
      .get(spec.id, cooldownKey) as
      { id: string; priority: number } | undefined;
    if (similar) {
      this.store.database
        .prepare(
          `UPDATE proactive_candidates SET summary = ?, draft_message = ?, expires_at_utc = ?, priority = ?
           WHERE id = ?`,
        )
        .run(
          event.summary,
          `刚结束${item.title}。${event.summary} 你今天过得怎么样？`,
          expiresAtUtc,
          Math.max(similar.priority, item.narrativeImportance),
          similar.id,
        );
      return;
    }
    this.store.database
      .prepare(
        `INSERT OR IGNORE INTO proactive_candidates(
          id, agent_id, trigger_event_id, intent, summary, draft_message,
          earliest_at_utc, expires_at_utc, priority, cooldown_key, status, created_at_utc
        ) VALUES (?, ?, ?, 'share_experience', ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        createEntityId("proactive"),
        spec.id,
        event.id,
        event.summary,
        `刚结束${item.title}。${event.summary} 你今天过得怎么样？`,
        createdAtUtc,
        expiresAtUtc,
        item.narrativeImportance,
        cooldownKey,
        createdAtUtc,
      );
  }
}

