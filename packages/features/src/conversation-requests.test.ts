import { describe, expect, it } from "vitest";
import { deriveCurrentConversationRequests as parse } from "./conversation-requests.js";
import { deriveAdvicePolicy } from "./advice-policy.js";

const policy = (text: string) => {
  const request = parse(text);
  return deriveAdvicePolicy({
    ...request,
    intent: request.conflicting
      ? "uncertain"
      : request.adviceRequested || request.detailedAnalysisRequested
        ? "help"
        : request.listen
          ? "venting"
          : "casual",
  });
};

describe("direct task-request grammar", () => {
  it.each([
    "请给我一个适合首次参会时照着做的发言顺序。",
    "请列一份适合第一次主持会议时用的准备清单。",
    "能不能帮我写一个搬家步骤？",
    "替我梳理明天办手续的流程。",
    "请给我明天能用的清单。",
    "给我一个方案。",
    "Please outline a rehearsal plan.",
    "Give me a checklist for moving house.",
    "朋友让我写回复，你现在帮我列一个沟通步骤清单。",
  ])("classifies the accepted procedural output: %s", (text) => {
    expect(parse(text)).toMatchObject({
      adviceRequested: true,
      structuredTaskRequested: true,
      supportStyle: "offer_requested_help",
      helpTiming: "now",
    });
  });

  it.each([
    "帮我拟一版。",
    "替我写一条拒绝回复。",
    "帮我写一条回复介绍准备顺序。",
    "请给我一个准备计划的摘要。",
    "帮我拟一版关于准备顺序的回复。",
    "帮我比较两个方案。",
    "帮我写一条回复，里面提到‘准备清单’。",
    "她说，给我一个准备顺序。",
    "如果我说请列一个准备清单，你会怎么理解？",
    "不要给我一个准备顺序。",
    "给我一点时间整理准备顺序。",
    "给我一些空间想想计划。",
    "明天再给我清单，今晚只想说说。",
    "Give me some time to write a plan.",
    "Help me write a reply about the plan.",
    "先给我一个准备顺序，但还是先听我说。",
  ])(
    "does not turn another output or inactive request into procedural help: %s",
    (text) => {
      expect(parse(text).structuredTaskRequested).toBe(false);
    },
  );

  it.each([
    "我今晚只剩四十分钟准备，现在有点慌。请给我一个今晚就能照着做的准备顺序，重点是别超时、让他们听懂。",
    "能不能帮我安排一下明天搬家的步骤？",
    "请列一份适合第一次主持会议时用的准备清单。",
    "替我拟一版礼貌但明确的回复。",
    "帮我写条拒绝回复，不要编理由。",
    "我讲完了，现在帮我拟一版。",
    "现在可以一起想办法了。我想今晚发条消息，把‘你什么都不懂’那句话收回来，但不承诺以后回家完全不工作。帮我拟一版。",
    "请给我明天能用的清单。",
    "朋友让我写回复，你现在帮我拟一下。",
    "朋友让我写回复，你现在帮我写说辞。",
    "她说，给我一份准备清单。但现在请你帮我列排练步骤。",
    "Please outline a rehearsal plan.",
    "这轮可以一起讨论方案了。",
    "Help me write a reply without inventing a reason.",
  ])("recognizes requested output now: %s", (text) => {
    expect(parse(text)).toMatchObject({
      adviceRequested: true,
      supportStyle: "offer_requested_help",
      helpTiming: "now",
    });
    expect(policy(text)).toBe("requested");
  });

  it.each([
    "这次请认真展开比较，别为了简短省略代价。按现金流、时间、创作积累和一年后的风险分别讲，指出哪些信息还缺；最后给你的倾向和会让你改主意的条件。",
    "麻烦你逐项对比两份租房方案，最后讲讲你的倾向。",
    "能不能展开解释这个取舍，给一个假设例子？",
  ])("recognizes direct expanded analysis: %s", (text) => {
    expect(parse(text)).toMatchObject({
      adviceRequested: true,
      detailedAnalysisRequested: true,
      supportStyle: "offer_requested_help",
      helpTiming: "now",
    });
    expect(policy(text)).toBe("requested");
  });

  it.each([
    "不要给我准备顺序，先听我说。",
    "请别帮我拟回复，我只想说说。",
    "我没让你帮我写清单。",
    "我不需要你帮我写清单。",
    "她说“请帮我拟一版回复”。",
    "同事说，给我一份准备清单。",
    "同事说，你现在帮我写一版。",
    "如果我说请列个计划，你会怎么理解？",
    "假如有人说，帮我写份安排。",
    "我今天写了一份准备清单。",
    "她认真展开比较了两个方案。",
    "给我一点时间，我只想缓缓。",
    "给我一点时间整理准备步骤。",
    "给我一些空间想想计划。",
    "请给我一点时间想方案。",
    "给我一些空间详细想想计划。",
    "Give me some time to write a plan.",
    "我需要安静和一点空间。",
    "不要请你认真展开比较，先听我说。",
  ])("keeps absent, denied or reported requests inactive: %s", (text) => {
    expect(parse(text).adviceRequested).toBe(false);
    expect(parse(text).detailedAnalysisRequested).toBe(false);
    expect(policy(text)).not.toBe("requested");
  });

  it.each([
    "先让我说完，再帮我列一个步骤清单。",
    "先听我说，然后再替我拟一版回复。",
  ])("defers ordered task help: %s", (text) => {
    expect(parse(text)).toMatchObject({
      adviceRequested: true,
      supportStyle: "listen_then_help",
      helpTiming: "after_user_finishes",
    });
    expect(policy(text)).toBe("none_now");
  });

  it.each([
    "明天再给我清单，今晚只想说说。",
    "明天再请你详细分析，今晚只想说说。",
  ])("does not authorize a future delivery now: %s", (text) => {
    expect(parse(text)).toMatchObject({
      adviceRequested: false,
      detailedAnalysisRequested: false,
      supportStyle: "listen",
    });
    expect(policy(text)).toBe("none_now");
  });

  it("retains conflict and explicit correction semantics", () => {
    expect(parse("先听我说，也请帮我写回复。")).toMatchObject({
      conflicting: true,
      supportStyle: "respond_naturally",
      helpTiming: "unspecified",
    });
    expect(policy("先听我说，也请帮我写回复。")).toBe("optional_light");
    expect(parse("不是让你只听我说，而是请你帮我写一版回复。")).toMatchObject({
      adviceRequested: true,
      supportStyle: "offer_requested_help",
      helpTiming: "now",
    });
  });
});
