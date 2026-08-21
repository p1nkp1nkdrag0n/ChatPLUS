import {
  DEFAULT_CONVERSATION_RETENTION_POLICY as CONTRACT_DEFAULT_CONVERSATION_RETENTION_POLICY,
  type ConversationRetentionPolicy,
} from "@personasim/contracts";

export type { ConversationRetentionPolicy } from "@personasim/contracts";

export const DEFAULT_CONVERSATION_RETENTION_POLICY: ConversationRetentionPolicy =
  CONTRACT_DEFAULT_CONVERSATION_RETENTION_POLICY;

export interface RetentionMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAtUtc: string;
  origin?: "user" | "reactive" | "proactive" | "deterministic_fallback";
}

export interface ConversationTurn<T extends RetentionMessageLike> {
  messages: readonly T[];
  complete: boolean;
  proactive: boolean;
  estimatedTokens: number;
}

export interface ConversationRetentionSelection<
  T extends RetentionMessageLike,
> {
  messages: readonly T[];
  turns: readonly ConversationTurn<T>[];
  estimatedTokens: number;
  omittedMessageCount: number;
  checkpointThroughMessageId?: string;
  truncatedForHardLimit: boolean;
}

export interface SelectConversationRetentionInput<
  T extends RetentionMessageLike,
> {
  messages: readonly T[];
  nowUtc: string;
  policy?: ConversationRetentionPolicy;
}

const HAN_CHARACTER = /\p{Script=Han}/u;

export function estimateConversationTokens(value: string): number {
  let han = 0;
  let other = 0;
  for (const character of value) {
    if (HAN_CHARACTER.test(character)) han += 1;
    else other += 1;
  }
  return han + Math.ceil(other / 4);
}

export function groupConversationTurns<T extends RetentionMessageLike>(
  messages: readonly T[],
): ConversationTurn<T>[] {
  const turns: Array<{
    messages: T[];
    complete: boolean;
    proactive: boolean;
    estimatedTokens: number;
  }> = [];

  for (const message of messages) {
    if (message.role === "user") {
      turns.push(makeTurn([message], false, false));
      continue;
    }

    if (message.role === "system") {
      turns.push(makeTurn([message], true, false));
      continue;
    }

    if (message.origin === "proactive") {
      turns.push(makeTurn([message], true, true));
      continue;
    }

    const current = turns.at(-1);
    if (
      current !== undefined &&
      !current.proactive &&
      !current.complete &&
      current.messages[0]?.role === "user"
    ) {
      current.messages.push(message);
      current.complete = true;
      current.estimatedTokens += estimateConversationTokens(message.text);
      continue;
    }

    turns.push(makeTurn([message], true, false));
  }

  return turns;
}

export function selectConversationRetention<T extends RetentionMessageLike>(
  input: SelectConversationRetentionInput<T>,
): ConversationRetentionSelection<T> {
  const policy = validatePolicy(
    input.policy ?? DEFAULT_CONVERSATION_RETENTION_POLICY,
  );
  const nowMillis = Date.parse(input.nowUtc);
  if (!Number.isFinite(nowMillis)) throw new TypeError("nowUtc must be valid");

  const turns = groupConversationTurns(input.messages);
  if (turns.length === 0) {
    return {
      messages: [],
      turns: [],
      estimatedTokens: 0,
      omittedMessageCount: 0,
      truncatedForHardLimit: false,
    };
  }

  const recentTurnIndex = Math.max(0, turns.length - policy.minimumRecentTurns);
  const cutoffMillis = nowMillis - policy.fullVerbatimHours * 60 * 60 * 1_000;
  const fullWindowIndex = turns.findIndex((turn) =>
    turn.messages.some(
      (message) => Date.parse(message.createdAtUtc) >= cutoffMillis,
    ),
  );
  const tailIndex = earliestTailIndex(turns, policy.minimumTailTokens);
  let firstSelectedIndex = Math.min(
    recentTurnIndex,
    fullWindowIndex === -1 ? turns.length : fullWindowIndex,
    tailIndex,
  );
  let estimatedTokens = sumTurnTokens(turns.slice(firstSelectedIndex));

  while (firstSelectedIndex > 0) {
    const previous = turns[firstSelectedIndex - 1];
    if (
      previous === undefined ||
      estimatedTokens + previous.estimatedTokens > policy.softTokenLimit
    ) {
      break;
    }
    firstSelectedIndex -= 1;
    estimatedTokens += previous.estimatedTokens;
  }

  while (
    firstSelectedIndex < turns.length - 1 &&
    estimatedTokens > policy.hardTokenLimit
  ) {
    const dropped = turns[firstSelectedIndex];
    if (dropped === undefined) break;
    estimatedTokens -= dropped.estimatedTokens;
    firstSelectedIndex += 1;
  }

  let selectedTurns = turns.slice(firstSelectedIndex);
  let truncatedForHardLimit = false;
  if (estimatedTokens > policy.hardTokenLimit) {
    selectedTurns = [
      truncateTurnToBudget(
        selectedTurns[selectedTurns.length - 1]!,
        policy.hardTokenLimit,
      ),
    ];
    estimatedTokens = selectedTurns[0]?.estimatedTokens ?? 0;
    firstSelectedIndex = turns.length - 1;
    truncatedForHardLimit = true;
  }

  const omittedTurns = turns.slice(0, firstSelectedIndex);
  const checkpointTurn = [...omittedTurns]
    .reverse()
    .find((turn) => turn.complete);
  const checkpointThroughMessageId = checkpointTurn?.messages.at(-1)?.id;
  const messages = selectedTurns.flatMap((turn) => [...turn.messages]);
  const omittedMessageCount = turns
    .slice(0, firstSelectedIndex)
    .reduce((count, turn) => count + turn.messages.length, 0);

  return {
    messages,
    turns: selectedTurns,
    estimatedTokens,
    omittedMessageCount,
    ...(checkpointThroughMessageId === undefined
      ? {}
      : { checkpointThroughMessageId }),
    truncatedForHardLimit,
  };
}

function makeTurn<T extends RetentionMessageLike>(
  messages: T[],
  complete: boolean,
  proactive: boolean,
): {
  messages: T[];
  complete: boolean;
  proactive: boolean;
  estimatedTokens: number;
} {
  return {
    messages,
    complete,
    proactive,
    estimatedTokens: messages.reduce(
      (total, message) => total + estimateConversationTokens(message.text),
      0,
    ),
  };
}

function earliestTailIndex<T extends RetentionMessageLike>(
  turns: readonly ConversationTurn<T>[],
  minimumTailTokens: number,
): number {
  let tokens = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    tokens += turns[index]?.estimatedTokens ?? 0;
    if (tokens >= minimumTailTokens) return index;
  }
  return 0;
}

function sumTurnTokens<T extends RetentionMessageLike>(
  turns: readonly ConversationTurn<T>[],
): number {
  return turns.reduce((total, turn) => total + turn.estimatedTokens, 0);
}

function truncateTurnToBudget<T extends RetentionMessageLike>(
  turn: ConversationTurn<T>,
  budget: number,
): ConversationTurn<T> {
  let remaining = budget;
  const messages = turn.messages.map((message, index) => {
    const remainingMessages = turn.messages.length - index - 1;
    const messageBudget = Math.max(
      1,
      Math.min(
        estimateConversationTokens(message.text),
        remaining - remainingMessages,
      ),
    );
    const text = truncateTextToTokenBudget(message.text, messageBudget);
    remaining -= estimateConversationTokens(text);
    return { ...message, text };
  });
  return makeTurn(messages, turn.complete, turn.proactive);
}

function truncateTextToTokenBudget(value: string, budget: number): string {
  if (estimateConversationTokens(value) <= budget) return value;
  if (budget <= 0) return "";
  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate =
      middle >= characters.length
        ? characters.join("")
        : characters.slice(0, middle).join("") + "...";
    if (estimateConversationTokens(candidate) <= budget) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return "";
  return characters.slice(0, low).join("") + "...";
}

function validatePolicy(
  policy: ConversationRetentionPolicy,
): ConversationRetentionPolicy {
  const values = [
    policy.fullVerbatimHours,
    policy.softTokenLimit,
    policy.hardTokenLimit,
    policy.minimumTailTokens,
    policy.minimumRecentTurns,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new TypeError(
      "Conversation retention values must be non-negative integers",
    );
  }
  if (policy.hardTokenLimit < 1) {
    throw new TypeError("hardTokenLimit must be positive");
  }
  if (policy.softTokenLimit > policy.hardTokenLimit) {
    throw new TypeError("softTokenLimit cannot exceed hardTokenLimit");
  }
  if (policy.minimumTailTokens > policy.hardTokenLimit) {
    throw new TypeError("minimumTailTokens cannot exceed hardTokenLimit");
  }
  return policy;
}
