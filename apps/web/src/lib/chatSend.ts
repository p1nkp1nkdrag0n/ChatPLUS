import type { LlmExecutionSelection } from "@personasim/contracts";
import type { ChatMessage } from "../api/types";

export interface ChatSendInput {
  text: string;
  clientMessageId: string;
  modelSelection: LlmExecutionSelection;
  createdAtUtc: string;
  knownMessageIds: string[];
}

export interface ChatDraft {
  text: string;
  retryInput?: ChatSendInput;
}

/** Match a committed turn by identity, never by text or arrival order. */
export function findChatSendReceipt(
  messages: readonly ChatMessage[],
  clientMessageId: string | undefined,
) {
  const userMessage = clientMessageId
    ? messages.find(
        (message) =>
          message.role === "user" &&
          message.clientMessageId === clientMessageId,
      )
    : undefined;
  const assistantMessage = userMessage
    ? messages.find(
        (message) =>
          message.role === "assistant" &&
          message.sessionId === userMessage.sessionId &&
          message.agentId === userMessage.agentId &&
          message.inReplyToMessageId === userMessage.id,
      )
    : undefined;
  return { userMessage, assistantMessage };
}

export function prepareChatSend(
  draft: ChatDraft | undefined,
  text: string,
  modelSelection: LlmExecutionSelection,
  messages: readonly ChatMessage[],
): ChatSendInput {
  const retry = draft?.retryInput;
  return {
    ...(retry?.text === text
      ? retry
      : {
          text,
          clientMessageId: crypto.randomUUID(),
          modelSelection: { ...modelSelection },
          createdAtUtc: new Date().toISOString(),
        }),
    knownMessageIds: messages.map((message) => message.id),
  };
}
