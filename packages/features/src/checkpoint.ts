export interface ConversationRetentionPolicyLike {
  fullVerbatimHours: number;
  softTokenLimit: number;
  hardTokenLimit: number;
  minimumTailTokens: number;
  minimumRecentTurns: number;
}

export interface CheckpointRetentionMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  messageKind:
    "user" | "assistant_reply" | "assistant_proactive" | "system_notice";
  content: string;
  createdAtUtc: string;
  replyToMessageId?: string;
}

export interface ConversationTurnLike {
  messages: CheckpointRetentionMessageLike[];
  complete: boolean;
  tokenEstimate: number;
  startedAtUtc: string;
  endedAtUtc: string;
}

export type RetentionSelectionReason =
  | "below_soft_limit"
  | "checkpoint_required"
  | "protected_tail_only"
  | "checkpoint_boundary_not_found"
  | "no_visible_messages";

export interface CheckpointRetentionSelection {
  checkpointMessages: CheckpointRetentionMessageLike[];
  liveTail: CheckpointRetentionMessageLike[];
  droppedFromLiveContextIds: string[];
  shouldCheckpoint: boolean;
  hardLimitApplied: boolean;
  sourceTokenEstimate: number;
  liveTailTokenEstimate: number;
  totalTokenEstimate: number;
  reason: RetentionSelectionReason;
}

const TURN_MESSAGE_OVERHEAD_TOKENS = 6;

export function estimateCheckpointTokens(value: string): number {
  let hanCount = 0;
  let otherCount = 0;
  for (const character of value.normalize("NFKC")) {
    if (/\p{Script=Han}/u.test(character)) hanCount += 1;
    else otherCount += 1;
  }
  return Math.max(1, hanCount + Math.ceil(otherCount / 4));
}

function messageTokens(message: CheckpointRetentionMessageLike): number {
  return (
    TURN_MESSAGE_OVERHEAD_TOKENS + estimateCheckpointTokens(message.content)
  );
}

export function isCheckpointVisibleMessage(
  message: CheckpointRetentionMessageLike,
): boolean {
  return message.role !== "system" && message.messageKind !== "system_notice";
}

export function groupCheckpointTurns(
  messages: readonly CheckpointRetentionMessageLike[],
): ConversationTurnLike[] {
  const visible = messages.filter(isCheckpointVisibleMessage);
  const turns: ConversationTurnLike[] = [];
  let pendingUser: CheckpointRetentionMessageLike | undefined;

  const push = (
    turnMessages: CheckpointRetentionMessageLike[],
    complete: boolean,
  ): void => {
    const first = turnMessages[0];
    const last = turnMessages.at(-1);
    if (first === undefined || last === undefined) return;
    turns.push({
      messages: turnMessages,
      complete,
      tokenEstimate: turnMessages.reduce(
        (total, message) => total + messageTokens(message),
        0,
      ),
      startedAtUtc: first.createdAtUtc,
      endedAtUtc: last.createdAtUtc,
    });
  };

  for (const message of visible) {
    if (message.messageKind === "user") {
      if (pendingUser !== undefined) push([pendingUser], false);
      pendingUser = message;
      continue;
    }

    if (message.messageKind === "assistant_proactive") {
      if (pendingUser !== undefined) {
        push([pendingUser], false);
        pendingUser = undefined;
      }
      push([message], true);
      continue;
    }

    if (pendingUser === undefined) {
      push([message], true);
      continue;
    }
    if (
      message.replyToMessageId !== undefined &&
      message.replyToMessageId !== pendingUser.id
    ) {
      push([pendingUser], false);
      pendingUser = undefined;
      push([message], true);
      continue;
    }
    push([pendingUser, message], true);
    pendingUser = undefined;
  }

  if (pendingUser !== undefined) push([pendingUser], false);
  return turns;
}

function tokenTotal(turns: readonly ConversationTurnLike[]): number {
  return turns.reduce((total, turn) => total + turn.tokenEstimate, 0);
}

function minimumTokenTailStart(
  turns: readonly ConversationTurnLike[],
  minimumTokens: number,
): number {
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    total += turns[index]?.tokenEstimate ?? 0;
    if (total >= minimumTokens) return index;
  }
  return 0;
}

function fullVerbatimTailStart(
  turns: readonly ConversationTurnLike[],
  cutoffMs: number,
): number {
  const index = turns.findIndex(
    (turn) => Date.parse(turn.endedAtUtc) >= cutoffMs,
  );
  return index < 0 ? turns.length : index;
}

function hardLimitTailStart(
  turns: readonly ConversationTurnLike[],
  hardTokenLimit: number,
): number {
  let start = turns.length;
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const next = total + (turns[index]?.tokenEstimate ?? 0);
    if (start < turns.length && next > hardTokenLimit) break;
    start = index;
    total = next;
  }
  return start;
}

function capTurnsAtHardLimit(
  turns: readonly ConversationTurnLike[],
  hardTokenLimit: number,
): {
  turns: ConversationTurnLike[];
  droppedIds: string[];
  applied: boolean;
} {
  const kept = [...turns];
  const droppedIds: string[] = [];
  while (kept.length > 1 && tokenTotal(kept) > hardTokenLimit) {
    const removed = kept.shift();
    if (removed !== undefined) {
      droppedIds.push(...removed.messages.map((message) => message.id));
    }
  }
  return {
    turns: kept,
    droppedIds,
    applied: droppedIds.length > 0,
  };
}

function flattenTurns(
  turns: readonly ConversationTurnLike[],
): CheckpointRetentionMessageLike[] {
  return turns.flatMap((turn) => turn.messages);
}

export function canonicalCheckpointSource(
  messages: readonly CheckpointRetentionMessageLike[],
): string {
  return JSON.stringify(
    messages.map((message) => ({
      id: message.id,
      role: message.role,
      messageKind: message.messageKind,
      content: message.content,
      ...(message.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: message.replyToMessageId }),
      createdAtUtc: message.createdAtUtc,
    })),
  );
}

export function selectConversationRetentionWindow(input: {
  messages: readonly CheckpointRetentionMessageLike[];
  nowUtc: string;
  policy: ConversationRetentionPolicyLike;
  checkpointThroughMessageId?: string;
}): CheckpointRetentionSelection {
  const visible = input.messages.filter(isCheckpointVisibleMessage);
  if (visible.length === 0) {
    return {
      checkpointMessages: [],
      liveTail: [],
      droppedFromLiveContextIds: [],
      shouldCheckpoint: false,
      hardLimitApplied: false,
      sourceTokenEstimate: 0,
      liveTailTokenEstimate: 0,
      totalTokenEstimate: 0,
      reason: "no_visible_messages",
    };
  }

  let source = visible;
  if (input.checkpointThroughMessageId !== undefined) {
    const boundary = source.findIndex(
      (message) => message.id === input.checkpointThroughMessageId,
    );
    if (boundary < 0) {
      const capped = capTurnsAtHardLimit(
        groupCheckpointTurns(source),
        input.policy.hardTokenLimit,
      );
      return {
        checkpointMessages: [],
        liveTail: flattenTurns(capped.turns),
        droppedFromLiveContextIds: capped.droppedIds,
        shouldCheckpoint: false,
        hardLimitApplied: capped.applied,
        sourceTokenEstimate: 0,
        liveTailTokenEstimate: tokenTotal(capped.turns),
        totalTokenEstimate: tokenTotal(groupCheckpointTurns(source)),
        reason: "checkpoint_boundary_not_found",
      };
    }
    source = source.slice(boundary + 1);
  }

  const turns = groupCheckpointTurns(source);
  const totalTokenEstimate = tokenTotal(turns);
  if (totalTokenEstimate <= input.policy.softTokenLimit) {
    return {
      checkpointMessages: [],
      liveTail: flattenTurns(turns),
      droppedFromLiveContextIds: [],
      shouldCheckpoint: false,
      hardLimitApplied: false,
      sourceTokenEstimate: 0,
      liveTailTokenEstimate: totalTokenEstimate,
      totalTokenEstimate,
      reason: "below_soft_limit",
    };
  }

  const nowMs = Date.parse(input.nowUtc);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowUtc must be a valid instant");
  }
  const cutoffMs = nowMs - input.policy.fullVerbatimHours * 60 * 60 * 1_000;
  const recentTurnsStart = Math.max(
    0,
    turns.length - input.policy.minimumRecentTurns,
  );
  const protectedStart = Math.min(
    recentTurnsStart,
    minimumTokenTailStart(turns, input.policy.minimumTailTokens),
    fullVerbatimTailStart(turns, cutoffMs),
  );
  const candidateEnd =
    totalTokenEstimate > input.policy.hardTokenLimit
      ? Math.max(
          protectedStart,
          hardLimitTailStart(turns, input.policy.hardTokenLimit),
        )
      : protectedStart;

  let completeCandidateEnd = 0;
  for (let index = 0; index < candidateEnd; index += 1) {
    if (turns[index]?.complete !== true) break;
    completeCandidateEnd = index + 1;
  }

  const selectedTurns: ConversationTurnLike[] = [];
  let selectedTokens = 0;
  for (let index = 0; index < completeCandidateEnd; index += 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    if (
      selectedTurns.length > 0 &&
      selectedTokens + turn.tokenEstimate > input.policy.hardTokenLimit
    ) {
      break;
    }
    selectedTurns.push(turn);
    selectedTokens += turn.tokenEstimate;
  }

  if (selectedTurns.length === 0) {
    const capped = capTurnsAtHardLimit(turns, input.policy.hardTokenLimit);
    return {
      checkpointMessages: [],
      liveTail: flattenTurns(capped.turns),
      droppedFromLiveContextIds: capped.droppedIds,
      shouldCheckpoint: false,
      hardLimitApplied: capped.applied,
      sourceTokenEstimate: 0,
      liveTailTokenEstimate: tokenTotal(capped.turns),
      totalTokenEstimate,
      reason: "protected_tail_only",
    };
  }

  const live = capTurnsAtHardLimit(
    turns.slice(selectedTurns.length),
    input.policy.hardTokenLimit,
  );
  return {
    checkpointMessages: flattenTurns(selectedTurns),
    liveTail: flattenTurns(live.turns),
    droppedFromLiveContextIds: live.droppedIds,
    shouldCheckpoint: true,
    hardLimitApplied: live.applied,
    sourceTokenEstimate: selectedTokens,
    liveTailTokenEstimate: tokenTotal(live.turns),
    totalTokenEstimate,
    reason: "checkpoint_required",
  };
}
