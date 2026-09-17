import { DateTime } from "luxon";
import type { ActivityEventLike } from "./settlement-engine.js";
import type { ScheduleItemLike } from "./schedule-validator.js";
import { normalizeText, parseInstant, parseZone, stableId } from "./shared.js";

export interface ProactivePolicyLike {
  enabled: boolean;
  maxMessagesPerDay: number;
  quietHours: { startLocal: string; endLocal: string };
  minimumCloseness: number;
  shareableCategories: readonly string[];
}

export interface ProactiveCandidateLike {
  id: string;
  agentId: string;
  activityEventId: string;
  category: string;
  status: "pending" | "sent" | "expired" | "suppressed" | "merged";
  summary: string;
  importance: number;
  earliestSendAtUtc: string;
  expiresAtUtc: string;
  dedupeKey: string;
  mergedIntoId?: string;
  sentMessageId?: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  revision: number;
}

export interface CreateProactiveCandidateInput {
  tier: "lightweight" | "daily" | "high_fidelity";
  agentId: string;
  event: ActivityEventLike;
  item: ScheduleItemLike;
  policy: ProactivePolicyLike;
  relationshipCloseness: number;
  nowUtc: string;
  existingCandidates?: readonly ProactiveCandidateLike[];
  ttlHours?: number;
  topicCooldownHours?: number;
  userRelevance?: number;
  shareableValue?: number;
}

export interface CreateCompletedActivityCandidateInput extends Omit<
  CreateProactiveCandidateInput,
  "event" | "item"
> {
  source: {
    id: string;
    agentId: string;
    completed: boolean;
    title: string;
    category: string;
    summary: string;
    shareable: boolean;
    narrativeImportance: number;
    /** The factual source's audit time, never a fabricated activity clock. */
    recordedAtUtc: string;
  };
}

function parseClock(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return hour * 60 + minute;
}

export function isWithinQuietHours(
  atUtc: string,
  timezone: string,
  quietHours: ProactivePolicyLike["quietHours"] = {
    startLocal: "23:00",
    endLocal: "08:00",
  },
): boolean {
  parseZone(timezone);
  const local = parseInstant(atUtc).setZone(timezone);
  const current = local.hour * 60 + local.minute;
  const start = parseClock(quietHours.startLocal) ?? 23 * 60;
  const end = parseClock(quietHours.endLocal) ?? 8 * 60;
  if (start === end) return true;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function isShareable(input: CreateCompletedActivityCandidateInput): boolean {
  const category = normalizeText(input.source.category);
  const categoryAllowed = input.policy.shareableCategories.some((allowed) => {
    const normalized = normalizeText(allowed);
    return (
      normalized !== "" &&
      (category.includes(normalized) || normalized.includes(category))
    );
  });
  // Story importance ranks material; it is not evidence that the user wants it.
  return (
    input.source.shareable ||
    (input.shareableValue ?? 0) >= 0.5 ||
    (categoryAllowed && (input.userRelevance ?? 0) >= 0.5)
  );
}

export function createProactiveCandidate(
  input: CreateProactiveCandidateInput,
): ProactiveCandidateLike | undefined {
  return createCompletedActivityCandidate({
    ...input,
    source: {
      id: input.event.id,
      agentId: input.event.agentId,
      completed: input.event.kind === "completed",
      title: input.item.title,
      category: input.item.category,
      summary: input.event.summary,
      shareable: input.item.shareable,
      narrativeImportance: input.item.narrativeImportance,
      recordedAtUtc: input.event.occurredAtUtc,
    },
  });
}

export function createCompletedActivityCandidate(
  input: CreateCompletedActivityCandidateInput,
): ProactiveCandidateLike | undefined {
  if (
    input.tier !== "high_fidelity" ||
    !input.policy.enabled ||
    !input.source.completed ||
    input.source.agentId !== input.agentId ||
    input.relationshipCloseness < input.policy.minimumCloseness ||
    !isShareable(input)
  ) {
    return undefined;
  }
  const dedupeKey = `${input.agentId}:${normalizeText(input.source.category)}:${normalizeText(input.source.title)}`;
  const duplicate = (input.existingCandidates ?? []).some(
    (candidate) =>
      candidate.agentId === input.agentId &&
      candidate.activityEventId === input.source.id,
  );
  if (duplicate) return undefined;

  const now = parseInstant(input.nowUtc);
  const ttlHours = Math.min(72, Math.max(1, input.ttlHours ?? 24));
  const expires = parseInstant(input.source.recordedAtUtc).plus({
    hours: ttlHours,
  });
  const cooldownHours = Math.max(0, input.topicCooldownHours ?? 24);
  let earliest = now;
  for (const candidate of input.existingCandidates ?? []) {
    if (
      candidate.agentId !== input.agentId ||
      candidate.dedupeKey !== dedupeKey
    )
      continue;
    if (candidate.status !== "sent" && candidate.status !== "pending") continue;
    if (
      candidate.status === "pending" &&
      parseInstant(candidate.expiresAtUtc) <= now
    )
      continue;
    const lastTopicAt =
      candidate.status === "sent"
        ? candidate.updatedAtUtc
        : candidate.earliestSendAtUtc;
    const next = parseInstant(lastTopicAt).plus({ hours: cooldownHours });
    if (next > earliest) earliest = next;
  }
  if (expires <= earliest) return undefined;
  return {
    id: stableId("proactive", `${input.agentId}:${input.source.id}`),
    agentId: input.agentId,
    activityEventId: input.source.id,
    category: input.source.category,
    status: "pending",
    summary: input.source.summary,
    importance: Math.min(
      1,
      Math.max(
        0,
        input.userRelevance ??
          input.shareableValue ??
          input.source.narrativeImportance,
      ),
    ),
    earliestSendAtUtc: earliest.toISO() ?? input.nowUtc,
    expiresAtUtc: expires.toISO() ?? input.nowUtc,
    dedupeKey,
    createdAtUtc: input.nowUtc,
    updatedAtUtc: input.nowUtc,
    revision: 0,
  };
}

export interface SelectProactiveCandidateInput {
  tier: "lightweight" | "daily" | "high_fidelity";
  candidates: readonly ProactiveCandidateLike[];
  nowUtc: string;
  timezone: string;
  policy: ProactivePolicyLike;
  relationshipCloseness: number;
  sentToday?: number;
  blockedCooldownKeys?: ReadonlySet<string>;
}

function localDay(utc: string, timezone: string): string {
  return parseInstant(utc).setZone(timezone).toISODate() ?? "";
}

export function selectProactiveCandidate(
  input: SelectProactiveCandidateInput,
): ProactiveCandidateLike | undefined {
  if (
    input.tier !== "high_fidelity" ||
    !input.policy.enabled ||
    input.relationshipCloseness < input.policy.minimumCloseness ||
    isWithinQuietHours(input.nowUtc, input.timezone, input.policy.quietHours)
  ) {
    return undefined;
  }
  const today = localDay(input.nowUtc, input.timezone);
  const inferredSentToday = input.candidates.filter((candidate) => {
    if (candidate.status !== "sent") return false;
    return localDay(candidate.updatedAtUtc, input.timezone) === today;
  }).length;
  const dailyLimit = Math.max(0, Math.floor(input.policy.maxMessagesPerDay));
  if ((input.sentToday ?? inferredSentToday) >= dailyLimit) return undefined;

  const now = parseInstant(input.nowUtc);
  return input.candidates
    .filter((candidate) => {
      if (candidate.status !== "pending") return false;
      if (input.blockedCooldownKeys?.has(candidate.dedupeKey) === true)
        return false;
      return (
        parseInstant(candidate.earliestSendAtUtc) <= now &&
        parseInstant(candidate.expiresAtUtc) > now
      );
    })
    .sort((left, right) => {
      if (right.importance !== left.importance)
        return right.importance - left.importance;
      return left.createdAtUtc.localeCompare(right.createdAtUtc);
    })[0];
}

export function mergeSimilarProactiveCandidates(
  candidates: readonly ProactiveCandidateLike[],
): ProactiveCandidateLike[] {
  const byCooldown = new Map<string, ProactiveCandidateLike>();
  for (const candidate of candidates) {
    const current = byCooldown.get(candidate.dedupeKey);
    if (current === undefined || candidate.importance > current.importance) {
      byCooldown.set(candidate.dedupeKey, candidate);
    }
  }
  return [...byCooldown.values()].sort(
    (left, right) => right.importance - left.importance,
  );
}

export function expireProactiveCandidates(
  candidates: readonly ProactiveCandidateLike[],
  nowUtc: string,
): ProactiveCandidateLike[] {
  const now = parseInstant(nowUtc);
  return candidates.map((candidate) => {
    if (
      candidate.status !== "pending" ||
      parseInstant(candidate.expiresAtUtc) > now
    )
      return candidate;
    return {
      ...candidate,
      status: "expired",
      updatedAtUtc: nowUtc,
      revision: candidate.revision + 1,
    };
  });
}

export function nextQuietHoursEndUtc(
  atUtc: string,
  timezone: string,
  quietHours: ProactivePolicyLike["quietHours"],
): string {
  const local = parseInstant(atUtc).setZone(timezone);
  const endMinutes = parseClock(quietHours.endLocal) ?? 8 * 60;
  let end = local.startOf("day").plus({ minutes: endMinutes });
  if (end <= local) end = end.plus({ days: 1 });
  return (
    end.toUTC().toISO() ??
    DateTime.fromJSDate(end.toJSDate()).toUTC().toISO() ??
    atUtc
  );
}
