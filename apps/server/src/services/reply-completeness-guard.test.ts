import { describe, expect, it } from "vitest";
import { inspectReplyCompleteness } from "./reply-completeness-guard.js";

const DRAFT_REQUEST =
  "请把我们刚才确认的测试安排整理成一段可以发给苏禾的话：包括正确日期、两人的分工、场地还没定；再提醒我发送前要确认的一件事。别帮我实际发送。";

describe("inspectReplyCompleteness", () => {
  it("catches the observed empty draft handoff and carries concrete repair evidence", () => {
    const text = "整理好了，你可以直接改：";
    expect(
      inspectReplyCompleteness({
        userMessage: DRAFT_REQUEST,
        text,
        chunks: [text],
      }),
    ).toEqual([
      expect.objectContaining({
        code: "REPLY_DELIVERABLE_BODY_MISSING",
        severity: "error",
        requestedDeliverable: "draft",
        observedSurfaces: [
          { surface: "text", text },
          { surface: "chunks", text },
        ],
      }),
    ]);
  });

  it.each([
    ["帮我拟一条测试通知草稿。", "好嘞，草稿来啦——"],
    ["请写一份邮件草稿。", "已经写好了。"],
    ["请给出正文。", "正文如下："],
    ["请列出采购清单。", "清单如下："],
    ["帮我整理一个清单。", "好的，我已经给你整理好了，你可以直接复制："],
    ["请把资料整理成一段话。", "**整理好了，你可以直接改：**"],
    ["Please draft an email.", "Here is the draft:"],
    ["Can you write a checklist?", "Your checklist is ready."],
  ])(
    "detects an explicit request and empty handoff: %s / %s",
    (userMessage, text) => {
      expect(inspectReplyCompleteness({ userMessage, text })).toHaveLength(1);
    },
  );

  it.each([
    [
      DRAFT_REQUEST,
      "苏禾，测试改为周四下午。你负责插画，我负责组织。场地待定。",
    ],
    [DRAFT_REQUEST, "整理好了，你可以直接改：\n苏禾，测试定在周四下午。"],
    ["请写一句很短的正文。", "正文：好。"],
    ["请写一句很短的正文。", "好。"],
    ["请写一句很短的正文。", "改。"],
    ["请写一句很短的正文。", "通知。"],
    ["请原样写出这条短信：草稿如下：", "草稿如下："],
    [
      "请逐字写出这条短信：整理好了，你可以直接改：",
      "整理好了，你可以直接改：",
    ],
    ["请写一条短信，将‘你可以直接使用’作为正文。", "你可以直接使用"],
    ["请列出采购清单。", "清单如下：\n- 牛奶\n- 面包"],
    ["请给出正文。", "正文如下\n下周四见。"],
    [DRAFT_REQUEST, "要发给谁？"],
    [DRAFT_REQUEST, "我还缺具体日期，先告诉我定在哪天。"],
    [DRAFT_REQUEST, "抱歉，我不能替你写这类内容。"],
    [DRAFT_REQUEST, "整理好了，但还有一个日期需要你确认。"],
    [DRAFT_REQUEST, "“整理好了，你可以直接改：”"],
    [DRAFT_REQUEST, "> 整理好了，你可以直接改："],
    [DRAFT_REQUEST, "他说：整理好了，你可以直接改："],
    ["请写一份代码清单。", "```js\nconst ready = true;\n```"],
    ["请给出正文。", "`整理好了，你可以直接改：`"],
    ["Please draft an email.", "Here is the draft: Hello."],
    ["帮我写一份草稿。", "好的。"],
    ["帮我写一份草稿。", ""],
  ])(
    "preserves real content, clarification, refusal and quotation: %s / %s",
    (userMessage, text) => {
      expect(inspectReplyCompleteness({ userMessage, text })).toEqual([]);
    },
  );

  it.each([
    "今天怎么样？",
    "我把草稿整理好了。",
    "他说帮我写一份草稿。",
    "请解释草稿是什么意思。",
    "请告诉我如何写邮件草稿。",
    "请检查这份草稿是否完整。",
    "不要写正文。",
    "帮我看看草稿，不需要写新的正文。",
    "他让我写草稿，你看他是不是在催我？",
    "请翻译“帮我写一份草稿”。",
    '请评价这句话："帮我写一份草稿"。',
    "```text\n帮我写一份草稿。\n```",
    "Please explain how to write a draft.",
    "Please do not write a draft.",
    "帮我写一份草稿。不过先别写，先告诉我还缺什么。",
    "请写一句正文，只输出“整理好了，你可以直接改：”。",
    "请给出正文，原样引用“整理好了，你可以直接改：”。",
  ])(
    "does not turn mentions, quotes or negations into delivery obligations: %s",
    (userMessage) => {
      expect(
        inspectReplyCompleteness({
          userMessage,
          text: "整理好了，你可以直接改：",
        }),
      ).toEqual([]);
    },
  );

  it("recognizes the complete reply across multiple bubbles", () => {
    expect(
      inspectReplyCompleteness({
        userMessage: DRAFT_REQUEST,
        text: "整理好了，你可以直接改：",
        chunks: ["整理好了，你可以直接改：", "苏禾，测试定在周四下午。"],
      }),
    ).toEqual([]);
    expect(
      inspectReplyCompleteness({
        userMessage: DRAFT_REQUEST,
        text: "整理好了，你可以直接改：",
        chunks: ["整理好了，", "你可以直接改："],
      }),
    ).toHaveLength(1);
  });

  it("leaves surface disagreement to the coherence guard without discarding an existing body", () => {
    expect(
      inspectReplyCompleteness({
        userMessage: DRAFT_REQUEST,
        text: "苏禾，测试定在周四下午。",
        chunks: ["整理好了，你可以直接改："],
      }),
    ).toEqual([]);
    expect(
      inspectReplyCompleteness({
        userMessage: DRAFT_REQUEST,
        text: "",
        chunks: ["整理好了，你可以直接改："],
      }),
    ).toHaveLength(1);
  });

  it("detects a still-empty repair without generating content or hiding the failure", () => {
    const input = {
      userMessage: DRAFT_REQUEST,
      text: "整理好了，你可以直接改：",
    };
    expect(inspectReplyCompleteness(input)).toHaveLength(1);
    expect(
      inspectReplyCompleteness({ ...input, text: "草稿如下：" }),
    ).toHaveLength(1);
    expect(
      inspectReplyCompleteness({
        ...input,
        text: "苏禾，测试定在周四下午，场地待定。",
      }),
    ).toEqual([]);
    expect(input.text).toBe("整理好了，你可以直接改：");
  });
});
