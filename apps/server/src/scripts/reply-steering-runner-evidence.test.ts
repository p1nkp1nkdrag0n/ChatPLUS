import { describe, expect, it } from "vitest";

import {
  steeringAttemptAccounting,
  visibleEvidence,
} from "./reply-steering-runner.js";

describe("reply steering evidence boundaries", () => {
  it("omits provider reasoning fields, typed blocks and embedded JSON reasoning", () => {
    const projected = visibleEvidence({
      choices: [
        {
          message: {
            reasoning_content: "private chain A",
            content: JSON.stringify({
              replyDecision: { text: "visible reply" },
              analysis: "private chain B",
            }),
          },
        },
      ],
      output: [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "private chain C" }],
        },
      ],
      encrypted_content: "private chain D",
      text: "<think>private chain E</think>visible suffix",
      usage: { reasoning_tokens: 19, prompt_tokens: 50, completion_tokens: 28 },
    });
    expect(JSON.stringify(projected)).not.toContain("private chain");
    expect(JSON.stringify(projected)).toContain("visible reply");
    expect(projected).toMatchObject({
      usage: { reasoning_tokens: 19, prompt_tokens: 50, completion_tokens: 28 },
      text: "[omitted:hidden_reasoning]visible suffix",
    });
  });

  it("keeps ordinary visible JSON formatting exactly", () => {
    const content = '{ "replyDecision" : { "text" : "我在听。" } }';
    expect(visibleEvidence({ choices: [{ message: { content } }] })).toEqual({
      choices: [{ message: { content } }],
    });
  });

  it("counts all dispatched attempts and their authoritative usage, excluding blocked retries", () => {
    const rows = [
      reserved(11, 1),
      responded(11, 1, "visible first attempt", 5, 3),
      reserved(12, 1),
      responded(12, 1, '{"replyDecision":{"text":"visible retry"}}', 7, 4),
      {
        stage: "blocked",
        context: { logicalCallIndex: 1, purpose: "chat_turn" },
      },
      reserved(13, 2, "repair_chat_turn"),
      responded(13, 2, "repaired", 9, 6, "repair_chat_turn"),
    ];
    expect(steeringAttemptAccounting(rows)).toEqual({
      physicalRequests: 3,
      retries: 1,
      rawVisibleReplies: ["visible first attempt", "visible retry"],
      usageComplete: true,
      inputTokens: 21,
      outputTokens: 13,
    });
  });

  it("retains failures and malformed visible replies without fabricating missing usage", () => {
    const rows = [
      reserved(1, 1),
      responded(1, 1, "{invalid JSON", 5, 3),
      reserved(2, 1),
      { stage: "transport_failed", attempt: 2, usage: "unknown" },
    ];
    expect(steeringAttemptAccounting(rows)).toEqual({
      physicalRequests: 2,
      retries: 1,
      rawVisibleReplies: ["{invalid JSON"],
      usageComplete: false,
      inputTokens: null,
      outputTokens: null,
    });
    expect(steeringAttemptAccounting([{ stage: "blocked" }])).toMatchObject({
      physicalRequests: 0,
      retries: 0,
      usageComplete: false,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("handles malformed provider envelopes without losing the failure count", () => {
    const rows = [
      null,
      "bad",
      { choices: "bad" },
      { choices: [null, 3, {}, { message: null }] },
    ].flatMap((response, index) => [
      reserved(index, 1),
      {
        stage: "responded",
        attempt: index,
        response,
        context: { purpose: "chat_turn", logicalCallIndex: 1 },
        usage: "unknown",
      },
    ]);
    expect(steeringAttemptAccounting(rows)).toMatchObject({
      physicalRequests: 4,
      retries: 3,
      rawVisibleReplies: [],
      usageComplete: false,
    });
  });
});

function reserved(
  attempt: number,
  logicalCallIndex: number,
  purpose = "chat_turn",
) {
  return { stage: "reserved", attempt, context: { logicalCallIndex, purpose } };
}

function responded(
  attempt: number,
  logicalCallIndex: number,
  content: string,
  prompt_tokens: number,
  completion_tokens: number,
  purpose = "chat_turn",
) {
  return {
    stage: "responded",
    attempt,
    context: { logicalCallIndex, purpose },
    response: { choices: [{ message: { content } }] },
    usage: { prompt_tokens, completion_tokens },
  };
}
