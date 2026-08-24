import { describe, expect, it } from "vitest";

import {
  classifyMemoryEpistemicStatus,
  isExplicitMemoryCorrection,
  isUserFactRecallRequest,
  isUserMemorySummaryRequest,
  memorySourceCanAuthorizeUserFact,
} from "./memory-epistemic.js";

describe("memory epistemic classification", () => {
  const knownUserFacts = {
    knownUserMemoryContents: [
      "重要发言前，我会把墨绿色珐琅松针放进电脑包内侧袋，代号是 LPM-4827。",
      "小林是我的大学同学，她现在住在苏州。",
    ],
  };

  it.each([
    ["假设我养了一只叫豆包的狗，这里只是举例。", "hypothetical"],
    ["小林说她最喜欢香菜。这是她的偏好，不是我的。", "quoted_third_party"],
    ["刚才关于豆包只是举例，不要把它记成真实宠物。", "retracted"],
    ["我通常不吃香菜。", "asserted_fact"],
    [
      "我只告诉很信任的人：代号是 LPM-4827，请只按我说的内容记。",
      "asserted_fact",
    ],
    ["我纠正一下：准确说法是，我可以接受少量香菜。", "asserted_fact"],
    ["我纠正一下：张伟说，准确说法是，我每天喝咖啡。", "quoted_third_party"],
    [
      "我纠正一下：朋友阿杰说，准确说法是，我每天喝咖啡。",
      "quoted_third_party",
    ],
    [
      "我纠正一下：准确说法是，朋友阿杰说，我每天喝咖啡。",
      "quoted_third_party",
    ],
    ["我纠正一下：准确说法是，我喜欢咖啡；这条不要记录。", "retracted"],
    ["我纠正一下：准确说法是，我喜欢咖啡；别把这条记下来。", "retracted"],
    ["我纠正一下：准确说法是，我要是每天喝咖啡就会失眠。", "hypothetical"],
    ["我纠正一下：准确说法是，我万一每天喝咖啡就会失眠。", "hypothetical"],
    ["我纠正一下：准确说法是，我倘若每天喝咖啡就会失眠。", "hypothetical"],
  ] as const)("classifies %s", (text, expected) => {
    expect(classifyMemoryEpistemicStatus(text)).toBe(expected);
  });

  it("allows an explicit negative preference but rejects unsafe source frames", () => {
    expect(memorySourceCanAuthorizeUserFact({ text: "我通常不吃香菜。" })).toBe(
      true,
    );
    expect(
      memorySourceCanAuthorizeUserFact({
        text: "我可能养狗，这只是假设。",
        status: "hypothetical",
      }),
    ).toBe(false);
  });

  it("detects correction, summary, and user-fact recall intents narrowly", () => {
    expect(isExplicitMemoryCorrection("我纠正一下，前面说得太绝对了。")).toBe(
      true,
    );
    expect(
      isUserMemorySummaryRequest(
        "请用两三句话说说你确定记得的我，不确定的别说。",
      ),
    ).toBe(true);
    expect(isUserFactRecallRequest("小林是谁？", knownUserFacts)).toBe(true);
    expect(isUserFactRecallRequest("你认识的小林是谁？", knownUserFacts)).toBe(
      false,
    );
    expect(
      isUserFactRecallRequest(
        "代号是 LPM-4827，请只按我说的内容记，不要补充。",
        knownUserFacts,
      ),
    ).toBe(false);
    expect(isUserFactRecallRequest("LPM-4827 放在哪里？", knownUserFacts)).toBe(
      true,
    );
    expect(isUserFactRecallRequest("LPM-4827 放哪？", knownUserFacts)).toBe(
      true,
    );
    expect(
      isUserFactRecallRequest(
        "我们开了一个新会话。请告诉我：LPM-4827 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？如果不确定就直说。",
        knownUserFacts,
      ),
    ).toBe(true);
    expect(
      isUserFactRecallRequest("我刚才说的代号是什么？那件东西放在哪里？"),
    ).toBe(true);
    expect(isUserFactRecallRequest("那我现在对香菜的偏好是什么？")).toBe(true);
    expect(
      isUserFactRecallRequest(
        "请说出我现在对香菜的准确偏好，以及小林和我的关系。",
      ),
    ).toBe(true);
    expect(isUserFactRecallRequest("我刚才语气有点重，抱歉。")).toBe(false);
    expect(isUserFactRecallRequest("我现在不想聊了。")).toBe(false);
  });

  it.each(["我改口：我喜欢咖啡。", "我想改口：我的生日是 8 月 2 日。"])(
    "rejects a correction cue without an active marker: %s",
    (text) => {
      expect(isExplicitMemoryCorrection(text)).toBe(true);
      expect(memorySourceCanAuthorizeUserFact({ text })).toBe(false);
    },
  );

  it("does not treat an unknown identifier in a multi-part fact question as user memory", () => {
    expect(
      isUserFactRecallRequest(
        "请告诉我：XYZ-9999 是什么、它放在哪里？另外，我们的共同安排是什么？",
        knownUserFacts,
      ),
    ).toBe(false);
  });

  it.each([
    "LPM-4827 还在吗？",
    "LPM-4827 的位置在哪里？",
    "LPM-4827 的位置？",
    "LPM-4827 是不是放在电脑包内侧袋？",
    "LPM4827 放在哪里？",
    "小林的位置在哪里？",
    "小林还在苏州吗？",
    "小林是不是住在苏州？",
    "What is LPM-4827?",
    "Is LPM-4827 still in the inside pocket?",
  ])("recognizes a known bare user-memory entity: %s", (text) => {
    expect(isUserFactRecallRequest(text, knownUserFacts)).toBe(true);
  });

  it("requires stored user-memory recognition for a bare ID or short name", () => {
    expect(isUserFactRecallRequest("LPM-4827 是什么？")).toBe(false);
    expect(isUserFactRecallRequest("小林是谁？")).toBe(false);
  });

  it.each([
    "GPT-5 是什么？",
    "example.com 是什么网站？",
    "孔子是谁？",
    "大熊猫住在哪里？",
    "你的 LPM-4827 放在哪里？",
    "你提到的 LPM-4827 是什么？",
    "What is GPT-5?",
  ])("does not promote an unknown or externally owned entity: %s", (text) => {
    expect(isUserFactRecallRequest(text, knownUserFacts)).toBe(false);
  });

  it.each([
    "Where did I say I put LPM-4827?",
    "What did I tell you LPM-4827 was?",
    "Do you remember where I live?",
    "What is my current cilantro preference?",
  ])("recognizes an explicit English user-history request: %s", (text) => {
    expect(isUserFactRecallRequest(text)).toBe(true);
  });

  it.each([
    "我只告诉很信任的人一个习惯：每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。最近想到博士资格面谈就有些紧张。另请记住我的关怀方式偏好：只要我谈到这场面谈，先问我现在更需要安慰还是建议，不要马上讲道理。",
    "说回我刚才提到的博士资格面谈，我还是有点紧张。你能先回应我的感受，再陪我梳理一个十分钟准备步骤吗？",
    "我之前提过面谈，现在很紧张。告诉我该怎么冷静下来。",
    "关于我最近的焦虑，你能告诉我该怎么办吗？",
    "我的偏好是先安慰我。现在请告诉我怎么准备面试。",
    "我之前说得太重了，你是什么感受？",
    "我之前提过报告已经跑了两轮，现在很焦虑，请告诉我接下来怎么推进。",
    "I mentioned my interview because I am anxious. Tell me how to calm down.",
  ])(
    "does not classify an assertion or follow-up request as recall: %s",
    (text) => {
      expect(isUserFactRecallRequest(text)).toBe(false);
    },
  );
});
