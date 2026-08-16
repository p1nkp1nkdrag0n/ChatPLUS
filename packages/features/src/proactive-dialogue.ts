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

function isShareable(
  item: ScheduleItemLike,
  policy: ProactivePolicyLike,
): boolean {
  const category = normalizeText(item.category);
  const categoryAllowed = policy.shareableCategories.some((allowed) => {
    const normalized = normalizeText(allowed);
    return (
      normalized !== "" &&
      (category.includes(normalized) || normalized.includes(category))
    );
  });
  return item.narrativeImportance >= 0.7 && (item.shareable || categoryAllowed);
}

export function createProactiveCandidate(
  input: CreateProactiveCandidateInput,
): ProactiveCandidateLike | undefined {
  if (
    input.tier !== "high_fidelity" ||
    !input.policy.enabled ||
    input.event.kind !== "completed" ||
    input.relationshipCloseness < input.policy.minimumCloseness ||
    !isShareable(input.item, input.policy)
  ) {
    return undefined;
  }
  const dedupeKey = `${input.agentId}:${normalizeText(input.item.category)}:${normalizeText(input.item.title)}`;
  const duplicate = (input.existingCandidates ?? []).some(
    (candidate) =>
      candidate.dedupeKey === dedupeKey &&
      (candidate.status === "pending" || candidate.status === "sent"),
  );
  if (duplicate) return undefined;

  const now = parseInstant(input.nowUtc);
  const ttlHours = Math.min(72, Math.max(1, input.ttlHours ?? 24));
  return {
    id: stableId("proactive", `${input.event.id}:${dedupeKey}`),
    agentId: input.agentId,
    activityEventId: input.event.id,
    category: input.item.category,
    status: "pending",
    summary: input.event.summary,
    importance: Math.min(1, Math.max(0, input.item.narrativeImportance)),
    earliestSendAtUtc: now.toISO() ?? input.nowUtc,
    expiresAtUtc: now.plus({ hours: ttlHours }).toISO() ?? input.nowUtc,
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
  const dailyLimit = Math.min(2, Math.max(0, input.policy.maxMessagesPerDay));
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
