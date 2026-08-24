import { canonicalizeDeliveredText } from "@personasim/contracts";

import type { ChatMessage } from "../api/types";

export interface MessageDelivery {
  mode: "single_block" | "sequential";
  chunks: string[];
}

export interface LiveMessageContext {
  sendPending: boolean;
  knownMessageIdsAtSendStart: ReadonlySet<string> | null;
  explicitlyAnimatedIds: ReadonlySet<string>;
  alreadyAnimatedIds: ReadonlySet<string>;
}

export function resolveMessageDelivery(
  message: Pick<ChatMessage, "text" | "chunks" | "deliveryMode">,
): MessageDelivery {
  if (message.deliveryMode !== "sequential") {
    return { mode: "single_block", chunks: [message.text] };
  }

  const chunks: unknown = message.chunks;
  if (
    !Array.isArray(chunks) ||
    chunks.length === 0 ||
    !chunks.every(
      (chunk): chunk is string =>
        typeof chunk === "string" && chunk.trim().length > 0,
    ) ||
    !canonicalizeDeliveredText({
      text: message.text,
      chunks,
      deliveryMode: "sequential",
    }).chunksMatch
  ) {
    return { mode: "single_block", chunks: [message.text] };
  }

  return {
    mode: chunks.length > 1 ? "sequential" : "single_block",
    chunks,
  };
}

export function shouldAnimateLiveMessage(
  message: Pick<
    ChatMessage,
    "id" | "role" | "text" | "chunks" | "deliveryMode"
  >,
  context: LiveMessageContext,
): boolean {
  if (
    message.role !== "assistant" ||
    resolveMessageDelivery(message).mode !== "sequential"
  ) {
    return false;
  }

  if (context.alreadyAnimatedIds.has(message.id)) return false;
  if (context.explicitlyAnimatedIds.has(message.id)) return true;
  return Boolean(
    context.sendPending &&
    context.knownMessageIdsAtSendStart &&
    !context.knownMessageIdsAtSendStart.has(message.id),
  );
}

export function sequentialAnimationSignature(
  chunks: readonly string[],
): string {
  return JSON.stringify(chunks);
}

export function sequentialChunkDelay(chunk: string): number {
  return Math.min(1_200, Math.max(500, 480 + chunk.length * 18));
}
