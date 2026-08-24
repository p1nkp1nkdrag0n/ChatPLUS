import { describe, expect, it } from "vitest";

import {
  deriveExplicitReplyConstraints,
  detectExplicitAdvicePoints,
} from "./reply-constraints.js";

describe("deriveExplicitReplyConstraints", () => {
  it("turns an explicit three-point short-advice request into hard ceilings", () => {
    expect(
      deriveExplicitReplyConstraints(
        "现在我愿意听一个很短的建议，但不要超过三点。",
      ),
    ).toEqual({
      concise: true,
      topicSwitch: false,
      maxAdvicePoints: 3,
      requiresAdviceResponse: true,
      maxSentences: 4,
    });
  });

  it("does not require advice when the user explicitly rejects it", () => {
    expect(
      deriveExplicitReplyConstraints(
        "现在不要给我建议；即使以后要说，也别超过三点。",
      ),
    ).not.toHaveProperty("requiresAdviceResponse");
  });

  it.each([
    "你能不能告诉我，他给的建议是什么？",
    "我想听你解释，为什么朋友给的建议让我更紧张。",
  ])("does not mistake discussion about advice for a request: %s", (text) => {
    expect(deriveExplicitReplyConstraints(text)).not.toHaveProperty(
      "requiresAdviceResponse",
    );
  });

  it.each([
    "我愿意听听你的建议，别超过三点。",
    "我想听一个简短建议，别超过三点。",
    "麻烦你提两点建议。",
  ])("recognizes a bounded direct advice request: %s", (text) => {
    expect(deriveExplicitReplyConstraints(text)).toMatchObject({
      requiresAdviceResponse: true,
    });
  });

  it("combines a direct advice request with a same-sentence no-follow-up boundary", () => {
    expect(
      deriveExplicitReplyConstraints("给我一个很短的建议，但别再追问我。"),
    ).toMatchObject({
      requiresAdviceResponse: true,
      forbidFollowUpQuestions: true,
    });
  });

  it("recognizes a clean topic switch without treating ordinary negation as one", () => {
    expect(
      deriveExplicitReplyConstraints(
        "好，先不聊这个了。最近上海晚上是不是凉一点了？",
      ).topicSwitch,
    ).toBe(true);
    expect(
      deriveExplicitReplyConstraints("我不觉得今晚很凉。续集呢？").topicSwitch,
    ).toBe(false);
  });

  it("turns an explicit topic stop into a no-follow-up reply boundary", () => {
    expect(
      deriveExplicitReplyConstraints("现在好一点了，我不想继续谈这件事。"),
    ).toMatchObject({
      topicSwitch: true,
      forbidFollowUpQuestions: true,
    });
    expect(
      deriveExplicitReplyConstraints("也别再追问我准备得怎么样了。"),
    ).toMatchObject({
      forbidFollowUpQuestions: true,
    });
  });

  it.each([
    "她说她不想继续谈这件事。",
    "我不觉得今晚很凉。续集呢？",
    "你可以继续问我准备得怎么样。",
  ])("does not invent a no-follow-up boundary: %s", (message) => {
    expect(
      deriveExplicitReplyConstraints(message).forbidFollowUpQuestions,
    ).not.toBe(true);
  });

  it("preserves an explicit two-to-three-sentence summary range", () => {
    expect(
      deriveExplicitReplyConstraints("请用自然的两三句话说说你确定记得的我。"),
    ).toMatchObject({
      concise: true,
      minSentences: 2,
      maxSentences: 3,
    });
  });

  it("captures an explicit timeboxed preparation plan and feelings-first request", () => {
    expect(
      deriveExplicitReplyConstraints(
        "我还是有点紧张。你能先回应我的感受，再陪我梳理一个十分钟准备步骤吗？",
      ),
    ).toMatchObject({
      requiredPreparationMinutes: 10,
      requiresPreparationPlan: true,
      requiresEmotionalAcknowledgement: true,
    });
    expect(
      deriveExplicitReplyConstraints("请帮我制定一个 10 分钟的准备计划。"),
    ).toMatchObject({
      requiredPreparationMinutes: 10,
      requiresPreparationPlan: true,
    });
  });

  it.each([
    "我只有十分钟准备时间。",
    "十分钟准备够吗？",
    "如果要做十分钟准备计划，会不会太赶？",
    "我昨天做了十分钟练习。",
  ])(
    "does not infer a requested plan from a duration mention: %s",
    (message) => {
      expect(deriveExplicitReplyConstraints(message)).not.toHaveProperty(
        "requiresPreparationPlan",
      );
    },
  );
});

describe("detectExplicitAdvicePoints", () => {
  it("counts Chinese numeral-comma items across sentences", () => {
    expect(
      detectExplicitAdvicePoints(
        "好，给你三个很短的建议：一，提前两天把稿子过一遍。二，分享前做三次深呼吸。三，把听众想成熟悉的朋友。",
      ),
    ).toEqual({ count: 3, method: "numbered_or_markdown_list" });
    expect(
      detectExplicitAdvicePoints(
        "嗯，那我说三个短建议。第一，提前一天把讲稿大纲过一遍，不用背。第二，分享前做三次深呼吸。第三，把听众想成熟悉的朋友。",
      ),
    ).toEqual({ count: 3, method: "chinese_ordinals" });
  });

  it.each([
    "1. 提前到场；2. 只看提纲；3. 放慢语速；4. 卡住就停。",
    "一、提前到场；二、只看提纲；三、放慢语速；四、卡住就停。",
  ])("counts every inline numbered item: %s", (text) => {
    expect(detectExplicitAdvicePoints(text)).toEqual({
      count: 4,
      method: "numbered_or_markdown_list",
    });
  });

  it.each([
    "第一点，提前到场。第二点，只看提纲。第三点，放慢语速。",
    "（1）提前到场；（2）只看提纲；（3）放慢语速；（4）卡住就停。",
  ])("counts common structured advice markers: %s", (text) => {
    expect(detectExplicitAdvicePoints(text)).toEqual({
      count: text.includes("（4）") ? 4 : 3,
      method: text.includes("第一点")
        ? "chinese_ordinals"
        : "numbered_or_markdown_list",
    });
  });

  it("counts unnumbered imperative items across strong punctuation", () => {
    expect(
      detectExplicitAdvicePoints(
        "嗯，可以。下周四分享前准备一句轻松的破冰话，帮你自己先松下来；另外提前到现场站上台感受五分钟，能减少未知感。讲的时候预设一个忘词也没关系的小空间就好。",
      ),
    ).toEqual({ count: 3, method: "semicolon_advice_items" });

    expect(
      detectExplicitAdvicePoints(
        "好，就说三点：把开头练熟；提前到场；紧张就深呼吸。慢慢来，你已经准备很久了。",
      ),
    ).toEqual({ count: 3, method: "semicolon_advice_items" });

    expect(
      detectExplicitAdvicePoints(
        "好，就说四点。开头练熟。场地早点去。语速放慢。卡住就停一下。",
      ),
    ).toEqual({ count: 4, method: "punctuated_advice_items" });

    expect(
      detectExplicitAdvicePoints(
        "好，那就三点。下周分享前，把稿子念给信任的人听，当聊天就好；上台前深呼吸三次，只想着最有把握那段。紧张时别对抗，它自然会过去。",
      ),
    ).toEqual({ count: 3, method: "semicolon_advice_items" });

    expect(
      detectExplicitAdvicePoints(
        "好，就说三点。把内容拆成三个你熟的小段落，按顺序讲，别追求完美。提前一天去熟悉场地，站位会踏实很多。紧张就深呼吸，慢点说，停顿不丢人。",
      ),
    ).toEqual({ count: 3, method: "punctuated_advice_items" });

    expect(
      detectExplicitAdvicePoints(
        "好，就三点：提前把开头两分钟练到不用想，上台就稳了；紧张时看观众头顶，别盯眼睛；允许自己讲砸一句，没人记得那么细。",
      ),
    ).toEqual({ count: 3, method: "semicolon_advice_items" });
  });

  it("does not trust a declared point count or count narrative clauses", () => {
    expect(detectExplicitAdvicePoints("好，那就三点。先不展开。")).toEqual({
      count: 0,
      method: "none",
    });
    expect(
      detectExplicitAdvicePoints("我今天看了书；吃了饭；散了步。"),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "我听见你说的要求了。你愿意的话，我们可以顺着这件事继续聊。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "我提前一天去熟悉了场地。紧张时我会深呼吸。之后慢点走回家。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "先前我也这样。然后我上台了。接着灯暗了。最后总算讲完。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "记得我第一次也会慌。然后我说得很快。最后还是讲完了。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "紧张时深呼吸让我头晕。允许自己犯错这件事，我还没学会。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "可以说，我那次真的很紧张。然后我还是上台了。最后也讲完了。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "分享前准备工作让我头疼。另外提前到场是我上次的做法。讲的时候预设停顿会令我更紧张。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "一，我去了北京。二，我去了上海。三，我回了家。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "一，我提前到了现场。二，我准备了稿子。三，我练习了开头。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "第一，我提前到了现场。第二，我准备了稿子。第三，我练习了开头。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "一，我提前到了现场。二，把提纲写好。三，我练习了开头。",
      ),
    ).toEqual({ count: 1, method: "numbered_or_markdown_list" });
    expect(
      detectExplicitAdvicePoints(
        "一，我正在准备稿子。二，我在练习开头。三，我正提前去现场。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "一，我正在准备稿子。二，把提纲写好。三，我在练习开头。",
      ),
    ).toEqual({ count: 1, method: "numbered_or_markdown_list" });
    expect(
      detectExplicitAdvicePoints(
        "分享前准备工作很繁琐。另外提前到场是常见做法。讲的时候预设停顿这种方法并不适合我。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "一，他建议我提前到场。二，她让我只看提纲。三，老师说要放慢语速。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "一，提前到场并不适合我。二，只看提纲不是我的做法。三，放慢语速反而让我更紧张。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "给你三点建议：一，我以前也紧张。二，我后来上台了。三，我最后讲完了。",
      ),
    ).toEqual({ count: 0, method: "none" });
    expect(
      detectExplicitAdvicePoints(
        "一，提前到场对我没用。二，只看提纲我反而更慌。三，准备稿子不是我的习惯。",
      ),
    ).toEqual({ count: 0, method: "none" });
  });

  it("counts every bounded unnumbered directive", () => {
    expect(
      detectExplicitAdvicePoints(
        "分享前准备一句破冰话。另外提前到现场。讲的时候预设一个停顿。紧张就深呼吸。",
      ),
    ).toEqual({ count: 4, method: "punctuated_advice_items" });
    expect(
      detectExplicitAdvicePoints(
        "第一，我建议你提前到场。第二，我建议你只看提纲。第三，我建议你放慢语速。",
      ),
    ).toEqual({ count: 3, method: "chinese_ordinals" });
    expect(
      detectExplicitAdvicePoints(
        "你可以先把提纲写好。你可以提前到场。你可以只看提纲。",
      ),
    ).toEqual({ count: 3, method: "punctuated_advice_items" });
    expect(
      detectExplicitAdvicePoints(
        "我觉得你可以提前到场。我觉得你可以只看提纲。我觉得你可以放慢语速。",
      ),
    ).toEqual({ count: 3, method: "punctuated_advice_items" });
  });
});
