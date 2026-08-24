import { normalizeText } from "./shared.js";

export const TOPIC_FATIGUE_HISTORY_LIMIT = 12;
export const TOPIC_FATIGUE_PENALTY_PER_MENTION = 0.15;
export const TOPIC_FATIGUE_MAX_PENALTY = 0.6;
export const TOPIC_KEY_MAX_CHARACTERS = 120;

export interface TopicHistoryMessage {
  readonly role?: string;
  readonly content: string;
  readonly topicKeys?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface TopicFatigueTopic {
  readonly topicKey: string;
  readonly aliases?: readonly string[];
}

export interface TopicFatigueResult {
  readonly topicKey: string;
  readonly recentAssistantMentions: number;
  readonly penalty: number;
}

export interface CalculateTopicFatigueInput {
  readonly topics: readonly TopicFatigueTopic[];
  readonly recentMessages: readonly TopicHistoryMessage[];
  readonly historyLimit?: number;
}

/** NFKC and punctuation-insensitive topic keys keep fixtures deterministic. */
export function normalizeTopicKey(value: string): string {
  return normalizeText(value).slice(0, TOPIC_KEY_MAX_CHARACTERS);
}

/**
 * Matches Latin topics on complete word sequences. CJK and other non-Latin
 * topics are compared without separator whitespace so `毕业 作品` can match
 * `毕业作品`, while `art` cannot accidentally match `party`.
 */
export function topicMentionsText(text: string, topic: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedTopic = normalizeTopicKey(topic);
  if (normalizedText === "" || normalizedTopic === "") return false;

  if (/^[a-z0-9]+(?: [a-z0-9]+)*$/u.test(normalizedTopic)) {
    return ` ${normalizedText} `.includes(` ${normalizedTopic} `);
  }

  return normalizedText
    .replace(/\s+/gu, "")
    .includes(normalizedTopic.replace(/\s+/gu, ""));
}

export function topicFatiguePenalty(recentAssistantMentions: number): number {
  const count = Number.isFinite(recentAssistantMentions)
    ? Math.max(0, Math.trunc(recentAssistantMentions))
    : 0;
  return roundScore(
    Math.min(
      TOPIC_FATIGUE_MAX_PENALTY,
      count * TOPIC_FATIGUE_PENALTY_PER_MENTION,
    ),
  );
}

export function countRecentAssistantTopicMentions(
  topic: TopicFatigueTopic,
  recentMessages: readonly TopicHistoryMessage[],
  historyLimit = TOPIC_FATIGUE_HISTORY_LIMIT,
): number {
  const normalizedKey = normalizeTopicKey(topic.topicKey);
  if (normalizedKey === "") return 0;
  const aliases = [topic.topicKey, ...(topic.aliases ?? [])].filter(
    (value) => normalizeTopicKey(value) !== "",
  );
  const boundedLimit = Number.isFinite(historyLimit)
    ? Math.max(
        0,
        Math.min(TOPIC_FATIGUE_HISTORY_LIMIT, Math.trunc(historyLimit)),
      )
    : TOPIC_FATIGUE_HISTORY_LIMIT;
  const assistantHistory = recentMessages.filter(
    (message) => message.role === undefined || message.role === "assistant",
  );
  const assistantMessages =
    boundedLimit === 0 ? [] : assistantHistory.slice(-boundedLimit);

  return assistantMessages.reduce((count, message) => {
    const metadataKeys = messageTopicKeys(message);
    const metadataMatch = metadataKeys.some(
      (key) => normalizeTopicKey(key) === normalizedKey,
    );
    const textMatch = aliases.some((alias) =>
      topicMentionsText(message.content, alias),
    );
    return count + (metadataMatch || textMatch ? 1 : 0);
  }, 0);
}

export function calculateTopicFatigue(
  input: CalculateTopicFatigueInput,
): TopicFatigueResult[] {
  const seen = new Set<string>();
  const results: TopicFatigueResult[] = [];
  for (const topic of input.topics) {
    const topicKey = normalizeTopicKey(topic.topicKey);
    if (topicKey === "" || seen.has(topicKey)) continue;
    seen.add(topicKey);
    const recentAssistantMentions = countRecentAssistantTopicMentions(
      topic,
      input.recentMessages,
      input.historyLimit,
    );
    results.push({
      topicKey,
      recentAssistantMentions,
      penalty: topicFatiguePenalty(recentAssistantMentions),
    });
  }
  return results.sort((left, right) =>
    left.topicKey.localeCompare(right.topicKey),
  );
}

function messageTopicKeys(message: TopicHistoryMessage): string[] {
  const direct = message.topicKeys ?? [];
  const metadataKeys = message.metadata?.["topicKeys"];
  return [
    ...direct,
    ...(Array.isArray(metadataKeys)
      ? metadataKeys.filter(
          (value): value is string => typeof value === "string",
        )
      : []),
  ];
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
