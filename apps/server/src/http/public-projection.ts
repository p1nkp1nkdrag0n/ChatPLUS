import {
  PublicAgentSnapshotSchema,
  PublicMessageSchema,
  PublicSendMessageResponseSchema,
  PublicTimelineResponseSchema,
  PublicRelationshipArchivePageResponseSchema,
  RelationshipRecapSchema,
  type PublicAgentSnapshot,
  type PublicMessage,
  type PublicSendMessageResponse,
  type PublicTimelineResponse,
  type TimelineResponse,
  type RelationshipArchivePageResponse,
  type RelationshipRecap,
} from "@personasim/contracts";

import type { StoredMessage } from "../db/store.js";
import type { ChatTurnResult } from "../services/conversation-service.js";
import { PUBLIC_TIMELINE_DOMAIN_EVENT_TYPES } from "./timeline-projection.js";

/** A positive allow-list: adding a diagnostic to a stored message cannot
 * accidentally expose it through history, a replay or a proactive delivery. */
export function projectPublicMessage(message: StoredMessage): PublicMessage {
  const metadata: PublicMessage["metadata"] = {};
  const chunks = message.metadata["chunks"];
  if (
    Array.isArray(chunks) &&
    chunks.length > 0 &&
    chunks.length <= 12 &&
    chunks.every(
      (chunk): chunk is string =>
        typeof chunk === "string" && chunk.length > 0 && chunk.length <= 4_000,
    ) &&
    chunks.join("\n") === message.content
  )
    metadata.chunks = chunks;
  const deliveryMode = message.metadata["deliveryMode"];
  if (deliveryMode === "single_block" || deliveryMode === "sequential") {
    metadata.deliveryMode = deliveryMode;
  }
  return PublicMessageSchema.parse({
    id: message.id,
    sessionId: message.sessionId,
    agentId: message.agentId,
    role: message.role,
    content: message.content,
    messageKind: message.messageKind,
    ...(message.clientMessageId === undefined
      ? {}
      : { clientMessageId: message.clientMessageId }),
    ...(message.inReplyToMessageId === undefined
      ? {}
      : { inReplyToMessageId: message.inReplyToMessageId }),
    metadata,
    createdAtUtc: message.createdAtUtc,
  });
}

export function projectPublicTurn(
  turn: ChatTurnResult,
): PublicSendMessageResponse {
  return PublicSendMessageResponseSchema.parse({
    idempotentReplay: turn.idempotentReplay,
    userMessage: projectPublicMessage(turn.userMessage),
    assistantMessage: projectPublicMessage(turn.assistantMessage),
  });
}

export function projectPublicSnapshot(
  input: {
    agentId: string;
    capabilities: {
      fuzzyLife: boolean;
      legacyExactSchedule: boolean;
      schedule: boolean;
    };
    serverTimeUtc: string;
    characterLocalTime: string;
  },
  proactiveMessage?: StoredMessage,
): PublicAgentSnapshot {
  return PublicAgentSnapshotSchema.parse({
    agentId: input.agentId,
    capabilities: {
      fuzzyLife: input.capabilities.fuzzyLife,
      legacyExactSchedule: input.capabilities.legacyExactSchedule,
      schedule: input.capabilities.schedule,
    },
    serverTimeUtc: input.serverTimeUtc,
    characterLocalTime: input.characterLocalTime,
    ...(proactiveMessage === undefined
      ? {}
      : { proactiveMessage: projectPublicMessage(proactiveMessage) }),
  });
}

// Only historical, user-facing occurrences belong in the public journal.
// State effects, pressure projections, memory internals and planning are not
// history merely because an internal event has a timestamp.
const PUBLIC_HISTORY_TYPES = new Set([
  "started",
  "completed",
  "partial",
  "skipped",
  "cancelled",
  ...PUBLIC_TIMELINE_DOMAIN_EVENT_TYPES,
]);
const PUBLIC_HISTORY_COPY: Record<string, { title: string; summary: string }> =
  {
    "character.created": {
      title: "初次相遇",
      summary: "一位新的角色来到这里。",
    },
    "character.published": {
      title: "故事开始",
      summary: "角色已经准备好与你相识。",
    },
    "conversation.turn_committed": {
      title: "一次对话",
      summary: "你们完成了一次交流。",
    },
    "conversation.proactive_message_sent": {
      title: "收到问候",
      summary: "角色向你发来了一条消息。",
    },
    "life.support_recorded": {
      title: "一次陪伴",
      summary: "你们一起聊过了一件重要的事。",
    },
    "life.delegated_decision_recorded": {
      title: "共同的选择",
      summary: "你们一起作出了一次选择。",
    },
    "life.decision_follow_up_evidenced": {
      title: "故事的后续",
      summary: "你为之前的经历带来了新的后续。",
    },
  };

export function projectPublicTimeline(
  timeline: TimelineResponse,
): PublicTimelineResponse {
  return PublicTimelineResponseSchema.parse({
    events: timeline.events
      .filter((event) => PUBLIC_HISTORY_TYPES.has(event.type))
      .map((event) => ({
        id: event.id,
        type: event.type,
        ...(event.title === undefined ? {} : { title: event.title }),
        summary: event.summary,
        ...PUBLIC_HISTORY_COPY[event.type],
        occurredAtUtc: event.occurredAtUtc,
        provenance: event.provenance,
      })),
  });
}

export function projectPublicArchive(page: RelationshipArchivePageResponse) {
  return PublicRelationshipArchivePageResponseSchema.parse({
    ...page,
    items: page.items
      .filter((item) =>
        item.entryType === "turning_point"
          ? item.sourceType !== "reflection"
          : item.entryType !== "life" ||
            PUBLIC_HISTORY_COPY[item.title] !== undefined,
      )
      .map((item) => {
        if (item.entryType === "turning_point") {
          return {
            id: item.id,
            agentId: item.agentId,
            entryType: item.entryType,
            sourceType: item.sourceType,
            title: item.title,
            summary: item.summary,
            effectiveAtUtc: item.effectiveAtUtc,
            recordedAtUtc: item.recordedAtUtc,
            href: item.href,
            sourceIds: item.sourceIds,
          };
        }
        return item.entryType === "life"
          ? { ...item, ...PUBLIC_HISTORY_COPY[item.title] }
          : item;
      }),
  });
}

export function projectPublicRecap(
  recap: RelationshipRecap,
): RelationshipRecap {
  return RelationshipRecapSchema.parse({
    ...recap,
    items: recap.items
      .filter(
        (item) =>
          item.sourceType !== "reflection" &&
          (item.sourceType !== "domain_event" ||
            PUBLIC_HISTORY_COPY[item.title] !== undefined),
      )
      .map((item) =>
        item.sourceType === "domain_event"
          ? { ...item, ...PUBLIC_HISTORY_COPY[item.title] }
          : item,
      ),
  });
}

/** SSE is a notification channel, never an alternate state or metadata API. */
export function projectPublicEventData(
  type: string,
  value: unknown,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of [
    "messageId",
    "sessionId",
    "letterId",
    "threadId",
    "keepsakeId",
    "achievementId",
    "unlockId",
    "badgeId",
  ]) {
    const candidate = input[key];
    if (
      typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= 240
    )
      output[key] = candidate;
  }
  if (type === "message.created" && typeof input["id"] === "string")
    output["messageId"] = input["id"];
  return output;
}
