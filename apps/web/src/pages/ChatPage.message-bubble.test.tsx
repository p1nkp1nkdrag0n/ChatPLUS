import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../api/types";
import { MessageBubble } from "./ChatPage";
import { shouldSubmitChatKey } from "../lib/chatInput";

const message: ChatMessage = {
  id: "assistant-live",
  sessionId: "session-1",
  agentId: "agent-1",
  role: "assistant",
  text: "第一句\n第二句",
  chunks: ["第一句", "第二句"],
  deliveryMode: "sequential",
  kind: "normal",
  createdAtUtc: "2026-08-16T08:00:00.000Z",
};

function renderMessage(input: ChatMessage, animateSequential: boolean): string {
  return renderToStaticMarkup(
    <MessageBubble
      message={input}
      name="林夏"
      timezone="Asia/Shanghai"
      animateSequential={animateSequential}
      onReveal={vi.fn()}
      onDeliveryStart={vi.fn()}
      onDeliveryComplete={vi.fn()}
    />,
  );
}

describe("MessageBubble initial rendering", () => {
  it("shows all sequential chunks immediately for history", () => {
    const markup = renderMessage(message, false);

    expect(markup).toContain("第一句");
    expect(markup).toContain("第二句");
    expect(markup).not.toContain("正在输入下一条消息");
  });

  it("starts an SSE-first live reply at the first bubble without a full flash", () => {
    const markup = renderMessage(message, true);

    expect(markup).toContain("第一句");
    expect(markup).not.toContain("第二句");
    expect(markup).toContain("正在输入下一条消息");
  });

  it("shows the complete text when untrusted chunks do not match", () => {
    const markup = renderMessage(
      {
        ...message,
        text: "I am still here",
        chunks: ["Iam still here"],
      },
      true,
    );

    expect(markup).toContain("I am still here");
    expect(markup).not.toContain("Iam still here");
    expect(markup).not.toContain("正在输入下一条消息");
  });

  it("does not render internal recall diagnostics even from an older cached message", () => {
    const markup = renderMessage(
      {
        ...message,
        memoryRecall: {
          rolloutMode: "enforced",
          promptStrategy: "evidence_selected",
          legacyPromptMemoryIds: [],
          promptMemoryIds: ["memory-1"],
          selectedMemoryIds: ["memory-1"],
          selectedEvidenceIds: ["evidence-1"],
          rejectedMemoryIds: ["memory-2"],
          recallMode: "verbatim_quote",
          score: 0.86,
          abstained: false,
          durationMs: 3,
        },
      },
      false,
    );

    expect(markup).not.toContain("本轮记忆依据");
    expect(markup).not.toContain("相关度");
    expect(markup).not.toContain("86%");
  });
});

describe("Chinese input submission", () => {
  const enter = {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
  };
  it("sends ordinary Enter and preserves Shift+Enter for line breaks", () => {
    expect(shouldSubmitChatKey(enter)).toBe(true);
    expect(shouldSubmitChatKey({ ...enter, shiftKey: true })).toBe(false);
    expect(shouldSubmitChatKey({ ...enter, key: "Escape" })).toBe(false);
  });
  it("never submits while an IME is selecting or confirming a candidate", () => {
    expect(shouldSubmitChatKey({ ...enter, isComposing: true })).toBe(false);
    expect(shouldSubmitChatKey(enter, true)).toBe(false);
    expect(shouldSubmitChatKey({ ...enter, keyCode: 229 })).toBe(false);
  });
});
