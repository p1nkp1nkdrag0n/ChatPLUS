import { describe, expect, it } from "vitest";
import type { LlmExecutionSelection } from "@personasim/contracts";
import type { ChatMessage } from "../api/types";
import { findChatSendReceipt, prepareChatSend } from "./chatSend";

const selection: LlmExecutionSelection = {
  providerId: "provider-1",
  modelId: "model-1",
  revision: 1,
};
const user: ChatMessage = {
  id: "stored-user",
  clientMessageId: "request-1",
  sessionId: "session-1",
  agentId: "character-1",
  role: "user",
  text: "今天的风很温柔",
  createdAtUtc: "2026-09-10T08:00:00.000Z",
};
const assistant: ChatMessage = {
  id: "stored-assistant",
  sessionId: user.sessionId,
  agentId: user.agentId,
  createdAtUtc: user.createdAtUtc,
  inReplyToMessageId: user.id,
  role: "assistant",
  text: "我们出去走走吧。",
};

describe("chat send reconciliation", () => {
  it("recognizes an SSE-first receipt regardless of message order", () => {
    expect(findChatSendReceipt([assistant, user], "request-1")).toEqual({
      userMessage: user,
      assistantMessage: assistant,
    });
  });

  it("does not mistake equal text, proactive messages, or another turn for the reply", () => {
    const unrelated: ChatMessage = {
      ...assistant,
      inReplyToMessageId: "older-user",
    };
    const proactive: ChatMessage = {
      ...assistant,
      id: "proactive",
      kind: "proactive",
    };
    delete proactive.inReplyToMessageId;
    expect(
      findChatSendReceipt([user, unrelated, proactive], "request-1"),
    ).toEqual({ userMessage: user, assistantMessage: undefined });
    expect(findChatSendReceipt([user, assistant], "another-request")).toEqual({
      userMessage: undefined,
      assistantMessage: undefined,
    });
  });

  it("rejects an assistant receipt from another session or character", () => {
    for (const foreign of [
      { ...assistant, sessionId: "session-2" },
      { ...assistant, agentId: "character-2" },
    ]) {
      expect(
        findChatSendReceipt([user, foreign], "request-1").assistantMessage,
      ).toBeUndefined();
    }
  });
});

describe("chat retry identity", () => {
  it("reuses a failed request and frozen model even after the selected model changes", () => {
    const first = prepareChatSend(undefined, user.text, selection, []);
    const retry = prepareChatSend(
      { text: first.text, retryInput: first },
      first.text,
      { ...selection, modelId: "model-2" },
      [user],
    );
    expect(retry.clientMessageId).toBe(first.clientMessageId);
    expect(retry.modelSelection).toEqual(selection);
    expect(retry.createdAtUtc).toBe(first.createdAtUtc);
    expect(retry.knownMessageIds).toEqual([user.id]);
  });

  it("uses a fresh request and selected model after editing or clearing retry for a model change", () => {
    const first = prepareChatSend(undefined, user.text, selection, []);
    const edited = prepareChatSend(
      { text: user.text },
      user.text,
      { ...selection, modelId: "model-2" },
      [],
    );
    expect(edited.clientMessageId).not.toBe(first.clientMessageId);
    expect(edited.modelSelection.modelId).toBe("model-2");
  });
});
