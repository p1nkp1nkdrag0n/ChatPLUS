import {
  ApiDomainEventSchema,
  ApiTimelineEventSchema,
  type ApiDomainEvent,
  type ApiTimelineEvent,
  type ScheduleItem,
  type TimelineResponse,
} from "@personasim/contracts";

import type { DatabaseStore, StoredActivityEvent } from "../db/store.js";

type MemoryLink = {
  id: string;
  sourceEventId: string | null;
  sourceMessageId: string | null;
};

type ProactiveLink = {
  id: string;
  triggerEventId: string;
};

type MessageLink = {
  id: string;
  triggerEventId: string | null;
  messageKind: string;
  metadata: Record<string, unknown>;
};

type TimelineProjectionInput = {
  activityEvents: StoredActivityEvent[];
  scheduleItems: ScheduleItem[];
  domainEvents: ApiDomainEvent[];
  personalIntentIds: Set<string>;
  memories: MemoryLink[];
  proactiveCandidates: ProactiveLink[];
  messages: MessageLink[];
};

export type TimelineProjectionMode = "fuzzy" | "legacy_exact";

type Lineage = Pick<
  ApiTimelineEvent,
  | "sourceIntentId"
  | "scheduleItemId"
  | "activityEventId"
  | "memoryId"
  | "proactiveCandidateId"
  | "messageId"
  | "source"
>;

type ProjectionIndexes = {
  intentIds: Set<string>;
  scheduleById: Map<string, ScheduleItem>;
  scheduleByIntent: Map<string, ScheduleItem>;
  activityById: Map<string, StoredActivityEvent>;
  activityBySchedule: Map<string, StoredActivityEvent>;
  memoryById: Map<string, MemoryLink>;
  memoryByActivity: Map<string, MemoryLink>;
  memoryByMessage: Map<string, MemoryLink>;
  candidateById: Map<string, ProactiveLink>;
  candidateByActivity: Map<string, ProactiveLink>;
  messageById: Map<string, MessageLink>;
  messageByActivity: Map<string, MessageLink>;
  messageByCandidate: Map<string, MessageLink>;
};

const DOMAIN_EVENT_TITLES: Record<string, string> = {
  "personal_intent.created": "PersonalIntent created",
  "personal_intent.merged": "PersonalIntent merged",
  "personal_intent.consumed": "PersonalIntent consumed",
  "personal_intent.revalidated": "PersonalIntent revalidated",
  "personal_intent.rejected": "PersonalIntent rejected",
  "personal_intent.expired": "PersonalIntent expired",
  "self_plan.committed": "Self plan committed",
  "schedule.command_committed": "Schedule command committed",
  "simulation.settled": "Simulation settled",
  "proactive.claimed": "Proactive candidate claimed",
  "conversation.proactive_message_sent": "Proactive message sent",
  "conversation.turn_committed": "一次对话已被记录",
  "conversation.world_effects_committed": "互动带来了变化",
  "character.created": "角色设定已创建",
  "character.published": "角色开始继续生活",
  "life.daily_context_created": "今天的生活背景已展开",
  "life.intent_settled": "一天的生活进展已结算",
  "life.support_recorded": "一次重要陪伴已被记住",
  "life.delegated_decision_recorded": "共同作出了一个明确选择",
  "life.decision_follow_up_evidenced": "选择产生了后续变化",
  "life.pressure_improved_from_user_evidence": "压力有所缓解",
  "life.pressure_worsened_from_user_evidence": "压力暂时加重",
};

export function buildTimelineResponse(
  store: DatabaseStore,
  agentId: string,
  limit: number,
  mode: TimelineProjectionMode,
): TimelineResponse {
  const fuzzyLife = mode === "fuzzy";
  const storedActivityEvents = store.listActivityEvents(agentId, limit);
  const linkedStoredActivityEvents =
    limit === 500
      ? storedActivityEvents
      : store.listActivityEvents(agentId, 500);
  const activityEvents = fuzzyLife
    ? storedActivityEvents.map(withoutScheduleLineage)
    : storedActivityEvents;
  const linkedActivityEvents = fuzzyLife
    ? linkedStoredActivityEvents.map(withoutScheduleLineage)
    : linkedStoredActivityEvents;
  // Fuzzy life deliberately does not even read the legacy schedule table. This
  // matters for migrated databases: a stale exact plan must not become visible
  // again merely because the user opens the shared-experience timeline.
  const scheduleItems = fuzzyLife ? [] : store.listSchedule(agentId);
  const domainEvents = store
    .listDomainEvents(agentId, limit)
    .map((event) => ApiDomainEventSchema.parse(event))
    .filter(
      (event) => !fuzzyLife || !isLegacyExactPlanningEvent(event.eventType),
    );
  const personalIntentIds = fuzzyLife
    ? new Set<string>()
    : new Set(
        (
          store.database
            .prepare("SELECT id FROM personal_intentions WHERE agent_id = ?")
            .all(agentId) as Array<{ id: string }>
        ).map((row) => row.id),
      );
  const memories = (
    store.database
      .prepare(
        `SELECT id, source_event_id AS sourceEventId,
          source_message_id AS sourceMessageId
         FROM memories
         WHERE agent_id = ?
         ORDER BY created_at_utc DESC, rowid DESC
         LIMIT 500`,
      )
      .all(agentId) as Array<{
      id: string;
      sourceEventId: string | null;
      sourceMessageId: string | null;
    }>
  ).map((row) => ({ ...row }));
  const proactiveCandidates = store.database
    .prepare(
      `SELECT id, trigger_event_id AS triggerEventId
       FROM proactive_candidates
       WHERE agent_id = ?
       ORDER BY created_at_utc DESC, rowid DESC
       LIMIT 500`,
    )
    .all(agentId) as ProactiveLink[];
  const messages = (
    store.database
      .prepare(
        `SELECT id, trigger_event_id AS triggerEventId,
          message_kind AS messageKind, metadata_json AS metadataJson
         FROM messages
         WHERE agent_id = ?
         ORDER BY created_at_utc DESC, rowid DESC
         LIMIT 500`,
      )
      .all(agentId) as Array<{
      id: string;
      triggerEventId: string | null;
      messageKind: string;
      metadataJson: string;
    }>
  ).map(({ metadataJson, ...message }) => ({
    ...message,
    metadata: parseRecord(metadataJson),
  }));

  return {
    events: projectTimelineEvents(
      {
        activityEvents: linkedActivityEvents,
        scheduleItems,
        domainEvents,
        personalIntentIds,
        memories,
        proactiveCandidates,
        messages,
      },
      limit,
    ),
    activityEvents,
    scheduleItems,
    domainEvents,
  };
}

function withoutScheduleLineage(
  event: StoredActivityEvent,
): StoredActivityEvent {
  if (event.scheduleItemId === undefined) return event;
  return {
    id: event.id,
    agentId: event.agentId,
    eventType: event.eventType,
    occurredAtUtc: event.occurredAtUtc,
    summary: LEGACY_ACTIVITY_EVENT_SUMMARIES[event.eventType],
    outcomeFacts: [],
    stateDelta: event.stateDelta,
    origin: event.origin,
    idempotencyKey: `fuzzy-timeline:${event.id}`,
  };
}

const LEGACY_ACTIVITY_EVENT_SUMMARIES: Record<
  StoredActivityEvent["eventType"],
  string
> = {
  started: "一项生活活动已经开始。",
  completed: "一项生活活动已经真实完成。",
  partial: "一项生活活动取得了部分进展。",
  skipped: "一项生活活动最终没有发生。",
  cancelled: "一项生活活动在发生前被取消。",
};

function isLegacyExactPlanningEvent(eventType: string): boolean {
  return (
    eventType.startsWith("schedule.") ||
    eventType.startsWith("personal_intent.") ||
    eventType.startsWith("self_plan.") ||
    eventType === "simulation.settled"
  );
}

export function projectTimelineEvents(
  input: TimelineProjectionInput,
  limit: number,
): ApiTimelineEvent[] {
  const indexes = buildIndexes(input);
  const canonicalActivityEvents = input.activityEvents.map((event) => {
    const scheduleItemId =
      event.scheduleItemId !== undefined &&
      indexes.scheduleById.has(event.scheduleItemId)
        ? event.scheduleItemId
        : undefined;
    const lineage = completeLineage(
      {
        activityEventId: event.id,
        ...(scheduleItemId === undefined ? {} : { scheduleItemId }),
      },
      indexes,
    );
    const schedule =
      lineage.scheduleItemId === undefined
        ? undefined
        : indexes.scheduleById.get(lineage.scheduleItemId);
    return ApiTimelineEventSchema.parse({
      id: event.id,
      type: event.eventType,
      ...(schedule === undefined ? {} : { title: schedule.title }),
      summary: event.summary,
      occurredAtUtc: event.occurredAtUtc,
      ...lineage,
      ...(schedule?.correlationId === undefined
        ? {}
        : { correlationId: schedule.correlationId }),
      ...(schedule?.causationId === undefined
        ? {}
        : { causationId: schedule.causationId }),
    });
  });
  const canonicalDomainEvents = input.domainEvents.map((event) => {
    const lineage = completeLineage(
      lineageFromDomainEvent(event, indexes),
      indexes,
    );
    return ApiTimelineEventSchema.parse({
      id: event.id,
      type: event.eventType.slice(0, 80),
      title: DOMAIN_EVENT_TITLES[event.eventType] ?? event.eventType,
      summary: summarizeDomainEvent(event),
      occurredAtUtc: event.recordedAtUtc,
      ...lineage,
      ...(event.correlationId === null
        ? {}
        : { correlationId: event.correlationId }),
      ...(event.causationId === null ? {} : { causationId: event.causationId }),
    });
  });

  const byId = new Map<string, ApiTimelineEvent>();
  for (const event of [...canonicalActivityEvents, ...canonicalDomainEvents]) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  return [...byId.values()]
    .toSorted(
      (left, right) =>
        right.occurredAtUtc.localeCompare(left.occurredAtUtc) ||
        right.id.localeCompare(left.id),
    )
    .slice(0, limit);
}

function buildIndexes(input: TimelineProjectionInput): ProjectionIndexes {
  const scheduleById = new Map(
    input.scheduleItems.map((item) => [item.id, item]),
  );
  const scheduleByIntent = new Map<string, ScheduleItem>();
  for (const item of input.scheduleItems) {
    if (
      item.sourceIntentId !== undefined &&
      input.personalIntentIds.has(item.sourceIntentId) &&
      !scheduleByIntent.has(item.sourceIntentId)
    ) {
      scheduleByIntent.set(item.sourceIntentId, item);
    }
  }
  const activityById = new Map(
    input.activityEvents.map((event) => [event.id, event]),
  );
  const activityBySchedule = new Map<string, StoredActivityEvent>();
  for (const event of input.activityEvents) {
    if (
      event.scheduleItemId !== undefined &&
      scheduleById.has(event.scheduleItemId) &&
      !activityBySchedule.has(event.scheduleItemId)
    ) {
      activityBySchedule.set(event.scheduleItemId, event);
    }
  }
  const memoryById = new Map(input.memories.map((row) => [row.id, row]));
  const memoryByActivity = new Map<string, MemoryLink>();
  const memoryByMessage = new Map<string, MemoryLink>();
  for (const memory of input.memories) {
    if (
      memory.sourceEventId !== null &&
      activityById.has(memory.sourceEventId) &&
      !memoryByActivity.has(memory.sourceEventId)
    ) {
      memoryByActivity.set(memory.sourceEventId, memory);
    }
    if (
      memory.sourceMessageId !== null &&
      !memoryByMessage.has(memory.sourceMessageId)
    ) {
      memoryByMessage.set(memory.sourceMessageId, memory);
    }
  }
  const candidateById = new Map(
    input.proactiveCandidates.map((row) => [row.id, row]),
  );
  const candidateByActivity = new Map<string, ProactiveLink>();
  for (const candidate of input.proactiveCandidates) {
    if (
      activityById.has(candidate.triggerEventId) &&
      !candidateByActivity.has(candidate.triggerEventId)
    ) {
      candidateByActivity.set(candidate.triggerEventId, candidate);
    }
  }
  const messageById = new Map(input.messages.map((row) => [row.id, row]));
  const messageByActivity = new Map<string, MessageLink>();
  const messageByCandidate = new Map<string, MessageLink>();
  for (const message of input.messages) {
    if (
      message.messageKind === "assistant_proactive" &&
      message.triggerEventId !== null &&
      activityById.has(message.triggerEventId) &&
      !messageByActivity.has(message.triggerEventId)
    ) {
      messageByActivity.set(message.triggerEventId, message);
    }
    const candidateId = stringField(message.metadata, "proactiveCandidateId");
    if (
      candidateId !== undefined &&
      candidateById.has(candidateId) &&
      !messageByCandidate.has(candidateId)
    ) {
      messageByCandidate.set(candidateId, message);
    }
  }
  return {
    intentIds: input.personalIntentIds,
    scheduleById,
    scheduleByIntent,
    activityById,
    activityBySchedule,
    memoryById,
    memoryByActivity,
    memoryByMessage,
    candidateById,
    candidateByActivity,
    messageById,
    messageByActivity,
    messageByCandidate,
  };
}

function lineageFromDomainEvent(
  event: ApiDomainEvent,
  indexes: ProjectionIndexes,
): Lineage {
  const payload = isRecord(event.payload) ? event.payload : {};
  const sourceIntentId = firstExisting(
    [
      ...payloadIds(payload, [
        "sourceIntentId",
        "intentId",
        "personalIntentIds",
      ]),
      ...(event.streamType === "personal_intent" ||
      event.streamType === "self_plan"
        ? [event.streamId]
        : []),
    ],
    indexes.intentIds,
  );
  const scheduleItemId = firstExisting(
    payloadIds(payload, [
      "scheduleItemId",
      "scheduleItemIds",
      "createdScheduleItemIds",
      "changedScheduleItemIds",
      "changedItemIds",
    ]),
    indexes.scheduleById,
  );
  const activityEventId = firstExisting(
    [
      ...payloadIds(payload, [
        "activityEventId",
        "activityEventIds",
        "triggerEventId",
      ]),
      ...(event.causationId === null ? [] : [event.causationId]),
    ],
    indexes.activityById,
  );
  const memoryId = firstExisting(
    payloadIds(payload, ["memoryId", "memoryIds"]),
    indexes.memoryById,
  );
  const proactiveCandidateId = firstExisting(
    [
      ...payloadIds(payload, ["proactiveCandidateId"]),
      ...(event.streamType === "proactive" ? [event.streamId] : []),
      ...(event.causationId === null ? [] : [event.causationId]),
    ],
    indexes.candidateById,
  );
  const messageId = firstExisting(
    payloadIds(payload, ["messageId", "assistantMessageId", "userMessageId"]),
    indexes.messageById,
  );
  return {
    ...(sourceIntentId === undefined ? {} : { sourceIntentId }),
    ...(scheduleItemId === undefined ? {} : { scheduleItemId }),
    ...(activityEventId === undefined ? {} : { activityEventId }),
    ...(memoryId === undefined ? {} : { memoryId }),
    ...(proactiveCandidateId === undefined ? {} : { proactiveCandidateId }),
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function completeLineage(seed: Lineage, indexes: ProjectionIndexes): Lineage {
  let sourceIntentId = seed.sourceIntentId;
  let scheduleItemId = seed.scheduleItemId;
  let activityEventId = seed.activityEventId;
  let memoryId = seed.memoryId;
  let proactiveCandidateId = seed.proactiveCandidateId;
  let messageId = seed.messageId;

  for (let pass = 0; pass < 8; pass += 1) {
    const schedule =
      scheduleItemId === undefined
        ? undefined
        : indexes.scheduleById.get(scheduleItemId);
    const activity =
      activityEventId === undefined
        ? undefined
        : indexes.activityById.get(activityEventId);
    const memory =
      memoryId === undefined ? undefined : indexes.memoryById.get(memoryId);
    const candidate =
      proactiveCandidateId === undefined
        ? undefined
        : indexes.candidateById.get(proactiveCandidateId);
    const message =
      messageId === undefined ? undefined : indexes.messageById.get(messageId);

    if (scheduleItemId === undefined && sourceIntentId !== undefined) {
      scheduleItemId = indexes.scheduleByIntent.get(sourceIntentId)?.id;
    }
    if (
      sourceIntentId === undefined &&
      schedule?.sourceIntentId !== undefined &&
      indexes.intentIds.has(schedule.sourceIntentId)
    ) {
      sourceIntentId = schedule.sourceIntentId;
    }
    if (activityEventId === undefined && scheduleItemId !== undefined) {
      activityEventId = indexes.activityBySchedule.get(scheduleItemId)?.id;
    }
    if (
      scheduleItemId === undefined &&
      activity?.scheduleItemId !== undefined &&
      indexes.scheduleById.has(activity.scheduleItemId)
    ) {
      scheduleItemId = activity.scheduleItemId;
    }
    if (memoryId === undefined && activityEventId !== undefined) {
      memoryId = indexes.memoryByActivity.get(activityEventId)?.id;
    }
    if (activityEventId === undefined && memory?.sourceEventId !== null) {
      activityEventId = memory?.sourceEventId ?? undefined;
    }
    if (messageId === undefined && memory?.sourceMessageId !== null) {
      messageId = memory?.sourceMessageId ?? undefined;
    }
    if (proactiveCandidateId === undefined && activityEventId !== undefined) {
      proactiveCandidateId =
        indexes.candidateByActivity.get(activityEventId)?.id;
    }
    if (activityEventId === undefined && candidate !== undefined) {
      activityEventId = candidate.triggerEventId;
    }
    if (messageId === undefined && proactiveCandidateId !== undefined) {
      messageId = indexes.messageByCandidate.get(proactiveCandidateId)?.id;
    }
    if (messageId === undefined && activityEventId !== undefined) {
      messageId = indexes.messageByActivity.get(activityEventId)?.id;
    }
    if (
      activityEventId === undefined &&
      message?.triggerEventId !== null &&
      message?.triggerEventId !== undefined &&
      indexes.activityById.has(message.triggerEventId)
    ) {
      activityEventId = message.triggerEventId;
    }
    if (proactiveCandidateId === undefined && message !== undefined) {
      const candidateId = stringField(message.metadata, "proactiveCandidateId");
      if (candidateId !== undefined && indexes.candidateById.has(candidateId)) {
        proactiveCandidateId = candidateId;
      }
    }
    if (memoryId === undefined && messageId !== undefined) {
      memoryId = indexes.memoryByMessage.get(messageId)?.id;
    }
  }

  const schedule =
    scheduleItemId === undefined
      ? undefined
      : indexes.scheduleById.get(scheduleItemId);
  return {
    ...(sourceIntentId === undefined ? {} : { sourceIntentId }),
    ...(scheduleItemId === undefined ? {} : { scheduleItemId }),
    ...(activityEventId === undefined ? {} : { activityEventId }),
    ...(memoryId === undefined ? {} : { memoryId }),
    ...(proactiveCandidateId === undefined ? {} : { proactiveCandidateId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(schedule === undefined ? {} : { source: schedule.source }),
  };
}

function payloadIds(
  payload: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  const ids: string[] = [];
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string") ids.push(value);
    if (Array.isArray(value)) {
      ids.push(
        ...value.filter((item): item is string => typeof item === "string"),
      );
    }
  }
  return ids;
}

function firstExisting<T>(
  candidates: readonly string[],
  values: ReadonlyMap<string, T> | ReadonlySet<string>,
): string | undefined {
  return candidates.find((candidate) => values.has(candidate));
}

function summarizeDomainEvent(event: ApiDomainEvent): string {
  const narrative = NARRATIVE_EVENT_SUMMARIES[event.eventType];
  if (narrative !== undefined) return narrative;
  if (isRecord(event.payload)) {
    const reasonSummary = stringField(event.payload, "reasonSummary");
    if (reasonSummary !== undefined) return reasonSummary.slice(0, 1_000);
    const summary = stringField(event.payload, "summary");
    if (summary !== undefined) return summary.slice(0, 1_000);
  }
  return `已保存“${DOMAIN_EVENT_TITLES[event.eventType] ?? event.eventType}”的审计证据。`;
}

const NARRATIVE_EVENT_SUMMARIES: Record<string, string> = {
  "character.created": "角色的初始人格、目标和关系起点已经保存。",
  "character.published": "角色从草稿进入持续生活状态，后续变化会独立累积。",
  "life.daily_context_created":
    "角色形成了今天想推进的事情和近期关注，但这些意图不代表事情已经发生。",
  "life.intent_settled":
    "角色的一项日常意图得到了可追溯的进展结果，并继续影响近期生活主线。",
  "life.support_recorded":
    "角色对一次困境或压力作出了倾听、分析或建议，回应方式已被记录。",
  "life.delegated_decision_recorded":
    "测试用户明确交出决定权后，角色选择了唯一方向；后续行动与结果仍需分别举证。",
  "life.decision_follow_up_evidenced":
    "用户提供了后续证据，系统据此分别记录行动、实际结果或事后反思。",
  "life.pressure_improved_from_user_evidence":
    "根据用户后续反馈，这次交流后压力下降、清晰度或被理解感有所提升。",
  "life.pressure_worsened_from_user_evidence":
    "根据用户后续反馈，当前压力仍在增加，角色会在后续交流中继续承接。",
  "conversation.turn_committed":
    "用户与角色完成了一轮对话，相关状态、关系与人生选择证据已原子保存。",
  "conversation.world_effects_committed":
    "这次互动对当下状态或关系产生了经过校验的细微变化。",
};

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
