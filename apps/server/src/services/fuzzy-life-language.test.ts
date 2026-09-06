import { describe, expect, it } from "vitest";

import {
  analyzeSupportSpeechAct,
  compactLifePromptText,
  exactlyOne,
  hasExplicitCausalStageReference,
  hasExplicitSupportIntent,
  inferActionKind,
  inferOutcomeValence,
  isActionEvidence,
  isDelegatedDecision,
  isDilemma,
  isOutcomeEvidence,
  isPressureDisclosure,
  isReflectionEvidence,
  parseScaleMetric,
  pressureKind,
  reflectionStance,
  supportMode,
} from "./fuzzy-life-language.js";

describe("fuzzy-life language helpers", () => {
  it("keeps explicit delegation separate from a negated delegation", () => {
    const delegations = [
      "这次请你替我决定选哪个",
      "我现在明确授权你，在 A 和 B 之间代我选一个。",
      "现在我明确授权你替我在 A 和 B 之间作决定。",
      "这次由你直接决定。",
      "你替我选一个。",
      "我到底要不要辞职？不要只分析，你直接替我决定。",
      "我要不要辞职？你直接替我做最后决定。",
      "你说了算。",
      "好，这次请你替我决定。",
      "不用解释，直接替我选一个。",
      "不是推卸责任，这次请你替我决定。",
      "刚才的信息够了，现在请你替我决定。",
      "你帮我选一个吧。",
      "这件事你来决定吧。",
      "决定权交给你。",
      "我把这次的决定权交给你。",
      "我授权你从 A 和 B 中选一个。",
      "这件事就由你定吧。",
      "不是请你给建议，而是请你替我决定。",
      "如果我刚才说得不清楚，我现在明确授权你替我决定。",
      "我现在明确授权你替我决定未来一年去哪里工作。",
      "我现在明确授权你替我决定以后住北京还是上海。",
      "我现在明确授权你在上次讨论的 A 和 B 之间替我作决定。",
      "我现在明确授权你替我决定，因为上次你的建议很准。",
      "我现在明确授权你：替我决定。",
      "只有 A/B 两个选项，这次请你替我决定。",
      "明天的事，这次请你替我决定。",
      "这次请你直接做决定。",
      "这次请你决定吧。",
      "我请你替我决定。",
      "麻烦替我选一个。",
      "我现在明确授权你替我决定，但这不代表以后都授权你代选。",
      "这次请你替我决定，以后是否授权我们再说。",
      "这次请你替我决定，以后需要时我会另行授权。",
      "你说了算吧。",
      "你还记得上次的建议吗？这次请你替我决定。",
      "这不是未来授权，而是现在我明确授权你替我决定。",
      "这次请你替我决定。顺便请翻译“good luck”。",
      "我之前一直犹豫但现在请你替我决定。",
      "那你现在就替我决定了吧。",
      "如果你刚才没听清楚，我现在明确授权你替我决定。",
      "如果刚才信号不好，我现在明确授权你替我决定。",
      "我现在正式授权你替我决定。",
      "我正式授权你替我决定。",
    ];
    for (const text of delegations) {
      expect(isDelegatedDecision(text), text).toBe(true);
    }

    expect(isDelegatedDecision("这次不要你替我决定，我自己选")).toBe(false);
  });

  it.each(["另外", "此外", "顺便", "还有"])(
    "recognizes current authorization after %s with or without a comma",
    (prefix) => {
      for (const separator of ["", "，"]) {
        for (const scope of [
          "在接受影像平台副主编岗位和启动独立影像项目之间替我作一次决定",
          "，只在接受影像平台副主编岗位和启动独立影像项目之间替我作一次决定",
        ]) {
          const text = `${prefix}${separator}我现在明确授权你${scope}。`;
          const analysis = analyzeSupportSpeechAct(text);
          expect(analysis, text).toMatchObject({
            delegated: true,
            explicitSupport: true,
            supportMode: "delegated_decision",
          });
          expect(analysis.operativeDilemmaText).toContain(prefix);
        }
      }
    },
  );

  it.each([
    ["另外请翻译“我现在明确授权你替我决定”。", "listen_only"],
    ["另外我昨天明确授权你替我决定过。", "listen_only"],
    ["另外我明天会明确授权你替我决定。", "listen_only"],
    ["如果明天我还没回复，另外我现在明确授权你替我决定。", "listen_only"],
    ["另外我现在没有授权你替我决定。", "listen_only"],
    ["另外我现在明确授权你替我决定，但我只把它当作建议。", "recommend"],
    ["另外我现在明确授权你替我决定，但先听我说。", "listen_only"],
    ["另外我现在明确授权你替我决定，不过先帮我分析。", "deliberate"],
    ["另外我现在明确授权你替我决定。等等，我还是自己选。", "listen_only"],
  ])(
    "keeps the operative limits after a discourse marker: %s",
    (text, expectedMode) => {
      expect(analyzeSupportSpeechAct(text)).toMatchObject({
        delegated: false,
        supportMode: expectedMode,
      });
    },
  );

  it("accepts only a current explicit delegation from the retained long-run evidence", () => {
    expect(
      isDelegatedDecision(
        "现在我明确授权你，只在“博物馆稳定岗”和“杭州三个月项目”之间替我作一次决定。直接说“博物馆”或“杭州”，再给一个理由。我会把你的选择当作决定，但不会假装自己已经行动；这次授权只限今天这一件事，不延伸到以后的决定。",
      ),
    ).toBe(true);

    const nonDelegations = [
      "有件事得更正：我今天刚问到家里人。那张底片里的人其实是我姨妈，不是外婆；姨妈也明确说了不愿意公开展示。你不用替我处理她的决定，我只是把归属和边界说准。",
      "信看完了。你说把水痕保留到‘不再妨碍看清主体’为止，这个标准我能用；你也没有趁机替我选工作，这两点都对。先不用再解释，我只是告诉你我收到了。",
      "可以问一句。‘可以给建议’只允许你建议，不等于授权你代选；只有我明确说‘替我决定’，才是一次具体代选授权。把这两层分开就行。",
      "刚才断了一下。你还记得你替我选的是哪一项，以及那次授权只限什么范围吗？只答两点。",
      "把事实记准：这是杭州决定和我实际行动之后出现的混合结果，不是计划。先不要判定这个选择对不对；只帮我拆开，哪部分可能受当时选择影响，哪部分来自执行方式或外部环境，最多三点。",
      "先不谈第二封信的正文。如果要描述我们现在的关系，只说三件确实发生过的事，不给我贴‘谨慎型’或任何人格标签，也别把一次代选写成你长期替我决定。",
      "明天我要定《潮痕》的内部清单。请先问一个真正必要的问题，再给一条建议；别因为你曾替我选过工作，就把这次也接过去。",
    ];

    for (const text of nonDelegations) {
      expect(isDelegatedDecision(text), text).toBe(false);
    }
  });

  it("rejects historical, quoted, conditional, and meta-level delegation language", () => {
    const nonDelegations = [
      "请复述我上次授权你替我选择的结果。",
      "如果以后我明确授权你替我决定，你才可以代选。",
      "只有我明确说‘替我决定’，才算授权。",
      "这不是请你替我决定，我只想听建议。",
      "上次是你说了算，这次我自己选。",
      "请你替我比较这两个选项。",
      "请你替我列出可选项。",
      "请把【你替我选一个】这句话翻译成英文。",
      "请把《你替我选一个》这句话改写得更礼貌。",
      "请解释“你替我选一个”是什么意思。",
      "请你等我明确授权后再替我决定。",
      "我想请你以后替我决定。",
      "我想以后正式授权你替我决定。",
      "这次请你替我决定。等等，我还是自己选。",
      "你替我选一个，不，还是我自己来。",
      "请你替我决定，但不是现在。",
      "如果需要，你替我决定。",
      "如果需要，这次请你替我决定。",
      "等我回来，你替我决定。",
      "明天，你替我决定。",
      "规则是，你替我决定才算授权。",
      "这条规则是，你替我决定。",
      "上次，你替我决定了。",
      "请你替我决定，不过我最终还是自己决定。",
      "我授权你替我决定，但先别替我决定。",
      "请你替我决定……算了。",
      "请你替我决定，我撤回刚才的话。",
      "请你替我决定，不过决定权还是在我。",
      "请你替我决定，但最后由我决定。",
      "请你替我决定，但我只把你的话当建议。",
      "请你替我决定，但我保留最终决定权。",
      "请你替我决定，但你的选择只供我参考。",
      "请你替我决定，我会把它当建议。",
      "请你替我决定。我想了想，还是由我来决定。",
      "请你替我决定，其实这次我只想听建议。",
      "请你替我决定，不过暂时别替我选。",
      "请你替我决定，先不要做决定。",
      "请你替我决定，但不要现在决定。",
      "请你替我定稿。",
      "请你替我定一个闹钟。",
      "请你替我定制一份方案。",
      "请你替我定会议室。",
      "请你决定性地改进这个方案。",
      "请你选择性地忽略这个细节。",
      "刚才，你替我决定了。",
      "刚刚，你替我选了杭州。",
      "你替我决定过了。",
      "你替我选过杭州。",
      "你替我决定了。",
      "今天上午，你替我决定了。",
      "请说明：你替我决定是什么意思。",
      "举例来说：你替我决定。",
      "你替我决定，这句话是在举例。",
      "你替我决定，这是要翻译的原句。",
      "你替我选一个，是错误示范。",
      "请你替我决定。等等，明天再说。",
      "请你替我决定，如果有需要的话。",
      "你说了算？",
      "这不是授权：你替我决定。",
      "我没有授权你：替我决定。",
      "不要说：你替我决定。",
      "授权示例：你替我决定。",
      "反例：你替我决定。",
      "只有我说：你替我决定，才算授权。",
      "请你替我决定，这只是个例子。",
      "请你替我决定，仅为示例。",
      "请你替我决定，这是反例。",
      "请你替我决定，这只是一种说法。",
      "如果我明天没回复，我现在明确授权你替我决定。",
      "如果你还没收到我的选择，我现在明确授权你替我决定。",
      "请你替我决定，如果我明天没回复。",
      "若我明天没回复，我现在明确授权你替我决定。",
      "万一我明天没回复，我现在明确授权你替我决定。",
      "只要我明天没回复，我现在明确授权你替我决定。",
      "在我明天没回复的情况下，我现在明确授权你替我决定。",
      "如果我刚才没说清楚，或者我明天没回复，我现在明确授权你替我决定。",
      "如果我刚才没说清楚，并且你还没收到我的选择，我现在明确授权你替我决定。",
      "我现在明确授权你替我决定，只要我明天还没回复。",
      "我现在明确授权你替我决定，前提是明天仍未收到我的选择。",
      "请你替我决定。这不是授权。",
      "请你替我决定。我没有授权你。",
      "请你替我决定。这是假设。",
      "假设：你替我决定。",
      "例如：你替我决定。",
      "我是在测试你：请你替我决定。",
      "原文：请你替我决定。",
      "原文是：请你替我决定。",
      "例子：请你替我决定。",
      "测试文本：请你替我决定。",
      "转述：请你替我决定。",
      "你刚才说：请你替我决定。",
      "他对我说：请你替我决定。",
      "闻溪回答：请你替我决定。",
    ];

    for (const text of nonDelegations) {
      expect(isDelegatedDecision(text), text).toBe(false);
    }
  });

  it("preserves support-mode precedence", () => {
    expect(supportMode("随便", true, false)).toBe("delegated_decision");
    expect(supportMode("请陪我一起分析收益和代价", false, false)).toBe(
      "deliberate",
    );
    expect(supportMode("先听我说，不要分析", false, true)).toBe("listen_only");
    expect(supportMode("请直接推荐一个方向", false, false)).toBe("recommend");
    expect(supportMode("我该不该换工作", false, true)).toBe("deliberate");
    expect(supportMode("今天有点累", false, false)).toBe("listen_only");
  });

  it("keeps quoted, meta-level, and future support language non-operative", () => {
    const inactiveSupport = [
      "请翻译“替我比较这两个选项”是什么意思。",
      "请解释“帮我分析这两个选项”是什么意思。",
      "请把【替我列出两个方案】改写得礼貌些。",
      "如果以后我请你帮我分析 A/B，再开始梳理。",
      "等我明天回来，再替我比较两个方案。",
      "请你帮我分析 A/B。这只是个例子。",
      "请你帮我分析 A/B；这仅为示例。",
      "请翻译“我该不该辞职”是什么意思。",
      "举例来说：我该不该辞职。",
      "如果以后我问你该不该辞职，再帮我分析。",
      "并非要你帮我分析。",
      "这不是让你帮我分析。",
      "请把 `请帮我分析` 原样复制。",
      "原文：请帮我分析。",
      "你刚才说：请你帮我分析。",
    ];

    for (const text of inactiveSupport) {
      expect(hasExplicitSupportIntent(text), text).toBe(false);
      expect(supportMode(text, false, false), text).toBe("listen_only");
      expect(isDilemma(text), text).toBe(false);
    }
  });

  it("keeps unrelated later meta language from cancelling a current support request", () => {
    const activeSupport = [
      "请帮我分析 A/B。顺便请翻译“good luck”。",
      "请帮我分析未来一年的职业方向。",
      "你还记得上次的建议吗？这次请帮我分析 A/B。",
      "请你替我比较这两个选项，我没有授权你替我决定。",
      "请帮我分析 A/B，以后是否再请你帮我分析另说。",
    ];

    for (const text of activeSupport) {
      expect(hasExplicitSupportIntent(text), text).toBe(true);
      expect(supportMode(text, false, false), text).toBe("deliberate");
    }
  });

  it("downgrades revoked delegation requests to recommendation support", () => {
    const recommendationOnly = [
      "请你替我决定，但我只把你的话当建议。",
      "请你替我决定，不过决定权还是在我。",
      "请你替我决定，但最终由我决定。",
      "请你替我决定，但你的选择只供我参考。",
      "请你替我决定，不过我最终还是自己决定。",
      "请你替我决定，但我保留最终决定权。",
      "请你替我决定，其实这次我只想听建议。",
      "请你替我决定，但只当建议。",
      "请你替我选一个，供我参考。",
      "由你决定，但最终由我决定。",
      "请你替我决定，但只供我参考。",
      "请你替我决定，不过只是建议。",
      "请你替我决定，最后我来拍板。",
      "请你替我决定，你的意见仅供参考。",
      "请你替我决定，但只能作为参考。",
      "请你替我决定，但你的答案仅作参考。",
      "请你替我决定，但拍板权在我。",
      "请你替我决定，但我才是最终决定的人。",
      "请你替我决定，不过最后要我确认。",
      "请你替我决定，但是否采纳由我。",
      "请你替我决定，不过给我建议就好。",
      "请你替我决定，但建议一下就行。",
      "请你替我决定，不过别替我做主，给建议即可。",
      "请你替我决定，但你只能提意见。",
      "请你替我决定，但我只需要你的建议。",
      "请你替我决定，但最后还是我拍板。",
      "请你替我决定，只是给个参考。",
    ];

    for (const text of recommendationOnly) {
      expect(isDelegatedDecision(text), text).toBe(false);
      expect(hasExplicitSupportIntent(text), text).toBe(true);
      expect(supportMode(text, false, false), text).toBe("recommend");
    }
    expect(supportMode("请你替我比较 A/B 两个选项。", false, false)).toBe(
      "deliberate",
    );
    expect(isDilemma("我在考虑未来一年该不该换工作。")).toBe(true);
  });

  it("uses the last effective support instruction", () => {
    const listenOnly = [
      "请帮我分析，不过别分析了，先听我说。",
      "不用帮我分析，只要听我说。",
    ];

    for (const text of listenOnly) {
      expect(hasExplicitSupportIntent(text), text).toBe(true);
      expect(supportMode(text, false, false), text).toBe("listen_only");
    }
  });

  it("keeps past support narration and targeted support negation non-operative", () => {
    for (const text of [
      "你从来没有帮我分析过。",
      "你从未替我比较过这两个方向。",
      "你以前没有给过我建议。",
      "你还没帮我梳理过。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: false,
        supportMode: "listen_only",
      });
    }

    expect(analyzeSupportSpeechAct("请推荐一个，但别给建议。")).toMatchObject({
      delegated: false,
      explicitSupport: false,
      supportMode: "listen_only",
    });
    for (const text of [
      "请帮我分析，但别给建议。",
      "别给建议，但请帮我分析。",
      "别替我决定，但请帮我分析。",
      "你从来没有帮我分析过，但现在请帮我分析。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: true,
        supportMode: "deliberate",
      });
    }
    expect(analyzeSupportSpeechAct("请你替我决定，但别给建议。")).toMatchObject(
      {
        delegated: true,
        explicitSupport: true,
        supportMode: "delegated_decision",
      },
    );
    for (const text of [
      "请你替我决定，但不要把你的回答当作建议。",
      "请你替我决定，但我不会把你的选择当作建议。",
      "请你替我决定，但我不是把你的回答当作建议。",
      "请你替我决定，但并非把你的选择当作建议。",
      "请你替我决定，但我不把你的回答当作建议。",
      "请你替我决定，但你的答案不是仅供参考。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: true,
        explicitSupport: true,
        supportMode: "delegated_decision",
      });
    }
    for (const text of [
      "请你替我决定，但我只把你的回答当作建议。",
      "请你替我决定，但你的选择仅供参考。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: true,
        supportMode: "recommend",
      });
    }
  });

  it("reduces authority and support changes in one ordered speech act", () => {
    expect(
      analyzeSupportSpeechAct("请你替我决定，改成只听我说。"),
    ).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "listen_only",
    });
    expect(
      analyzeSupportSpeechAct("请你替我决定，改成帮我分析。"),
    ).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "deliberate",
    });
    expect(
      analyzeSupportSpeechAct("先听我说，改成请你替我决定。"),
    ).toMatchObject({
      delegated: true,
      explicitSupport: true,
      supportMode: "delegated_decision",
    });
    expect(analyzeSupportSpeechAct("请直接给我一个明确建议。")).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "recommend",
    });
  });

  it("allows current evaluation frames without opening conditional authority", () => {
    expect(
      analyzeSupportSpeechAct(
        "如果现在必须二选一，请你替我比较 A/B 两个选项。",
      ),
    ).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "deliberate",
    });
    expect(
      analyzeSupportSpeechAct("如果今天就要二选一，请直接推荐 A/B。"),
    ).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "recommend",
    });
    expect(
      analyzeSupportSpeechAct("如果现在必须二选一，请你替我决定 A/B。"),
    ).toMatchObject({
      delegated: false,
      supportMode: "listen_only",
    });
    for (const text of [
      "模拟一下我选择 A 后的结果，但这次请你替我决定 B。",
      "如果是我，我会选 A；但现在我明确授权你替我决定 B。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: true,
        explicitSupport: true,
        supportMode: "delegated_decision",
      });
    }
  });

  it("keeps future authority blocked across soft punctuation", () => {
    for (const separator of ["，", "：", "；", ",", ":", ";"]) {
      expect(
        isDelegatedDecision(
          `如果我明天没回复${separator}我现在明确授权你替我决定。`,
        ),
        separator,
      ).toBe(false);
    }
  });

  it("keeps negated, completed, and scenario dilemma language non-operative", () => {
    for (const text of [
      "我不是在问该不该辞职，只是在复述。",
      "我过去很犹豫该不该辞职，现在已经决定了。",
      "测试一下识别：我该不该辞职。",
      "场景设定：我该不该辞职。",
      "我已经不纠结该不该辞职了。",
      "我不再犹豫要不要分手。",
      "我已经决定不辞职，不用再问该不该辞职。",
      "我早就选好了，不存在怎么选的问题。",
      "我并没有拿不定主意。",
      "这篇文章讨论该不该辞职。",
      "视频标题是该不该辞职。",
      "老师让我们讨论要不要转行。",
      "我要写一篇关于怎么选工作的文章。",
    ]) {
      expect(analyzeSupportSpeechAct(text).dilemmaLike, text).toBe(false);
      expect(isDilemma(text), text).toBe(false);
    }
  });

  it("does not revive negated or cancelled support requests", () => {
    for (const text of [
      "不要帮我分析。",
      "请不要帮我分析。",
      "别替我比较这两个选项。",
      "先别帮我分析。",
      "暂时不要帮我分析。",
      "不必帮我分析。",
      "请帮我分析，但我不想听分析了。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: false,
        supportMode: "listen_only",
      });
    }
    for (const text of [
      "请帮我分析 A/B，不用了。",
      "请帮我分析 A/B，算了吧。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: false,
        supportMode: "listen_only",
      });
    }
    for (const text of [
      "我该不该辞职？我不想听分析了。",
      "我该不该辞职，但先别帮我分析。",
      "我该怎么选？不必帮我分析。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: false,
        dilemmaLike: true,
        supportMode: "listen_only",
      });
    }
  });

  it("revokes authority and blocks simulation-framed delegation", () => {
    for (const text of [
      "请你替我决定。我不想让你替我决定。",
      "请你替我决定，我不同意你替我决定。",
      "请你替我决定。后来想想，我反悔了。",
      "请你替我决定，我收回刚才的委托。",
      "请你替我决定，我的事还是我自己做主。",
      "请你替我决定，最终拍板的人是我。",
      "请你替我决定，我没有把决定权给你。",
      "请你替我决定，我拒绝让你替我做决定。",
      "请你替我决定。我可没让你替我决定。",
      "请你替我决定，我没叫你替我决定。",
      "请你替我决定，我没说让你代选。",
      "请你替我决定。别自作主张。",
      "请你替我决定，但我不希望你替我决定。",
      "请你替我决定，但我没答应让你替我决定。",
      "请你替我决定，但我现在不同意了。",
      "请你替我决定，但你无权替我决定。",
      "为了测试，请你替我决定。",
      "模拟一下：请你替我决定。",
      "角色扮演：你替我决定。",
      "在这个模拟里，你替我决定。",
      "作为示例，你替我决定。",
      "假想情景：你替我决定。",
      "练习句子：你替我决定。",
      "假装我是用户，你替我决定。",
      "测试用例：你替我决定。",
      "我只是转述同事的话：请你替我决定。",
      "同事的原话是：请你替我决定。",
      "我来举个例子：请你替我决定。",
      "请分析这句台词：你替我决定。",
      "我是在复述朋友的话：请你替我决定。",
      "在故事里，我对角色说：请你替我决定。",
      "客服让我转告你：请你替我决定。",
      "英文翻译任务：请你替我决定。",
      "我在模拟用户会怎么说：请你替我决定。",
      "我不会对你说：请你替我决定。",
      "请你替我决定。我开玩笑的。",
      "朋友请我转述给你：请你替我决定。",
    ]) {
      expect(isDelegatedDecision(text), text).toBe(false);
    }
    expect(
      analyzeSupportSpeechAct("请你替我决定，不过你只负责分析。"),
    ).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "deliberate",
    });
  });

  it("keeps past calendar narration inactive until a current pivot", () => {
    for (const text of [
      "昨天，你替我决定。",
      "昨晚，你替我选一个。",
      "前天，你来决定。",
      "上周，你替我作决定。",
      "上个月，你替我决定。",
    ]) {
      expect(isDelegatedDecision(text), text).toBe(false);
    }
    expect(isDelegatedDecision("昨天，你替我决定，但现在请你替我决定。")).toBe(
      true,
    );
  });

  it("separates real consequence simulation from utterance simulation", () => {
    for (const text of [
      "模拟一下我辞职后的最坏情况。",
      "模拟我选择杭州项目后的三个月。",
      "假设我选择 A，会有什么风险？",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: true,
        supportMode: "deliberate",
      });
    }
  });

  it("keeps user dilemma ownership separate from other people's dilemmas", () => {
    for (const text of [
      "我朋友正在犹豫该不该辞职。",
      "这是朋友的问题：她该不该辞职。",
      "你该不该辞职？",
    ]) {
      expect(isDilemma(text), text).toBe(false);
    }
    for (const text of [
      "我在 A 和 B 之间左右为难。",
      "到底选 A 还是 B。",
      "我不知道该选杭州还是上海。",
      "我举棋不定。",
      "你觉得我该不该辞职？",
    ]) {
      expect(isDilemma(text), text).toBe(true);
    }
  });

  it("keeps direct answer requests and current hypothetical advice operative", () => {
    for (const text of [
      "请你回答：我该不该辞职？",
      "你说：我该不该辞职？",
      "直接回答：我该不该辞职？",
    ]) {
      expect(isDilemma(text), text).toBe(true);
    }
    const advice =
      analyzeSupportSpeechAct("如果是我，我会优先保护被摄者的尊严。");
    expect(advice.operativeDilemmaText).toContain("如果是我");
    expect(advice.operativeDilemmaClassifyText).toContain("我会优先保护");
  });

  it("keeps independent meta clauses from cancelling active requests", () => {
    expect(
      analyzeSupportSpeechAct("我该不该辞职，顺便翻译“good luck”。"),
    ).toMatchObject({
      delegated: false,
      dilemmaLike: true,
      supportMode: "deliberate",
    });
    expect(
      analyzeSupportSpeechAct("请帮我分析 A/B，顺便翻译“good luck”。"),
    ).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "deliberate",
    });
    expect(
      analyzeSupportSpeechAct("这次请你替我决定，顺便翻译“good luck”。"),
    ).toMatchObject({
      delegated: true,
      supportMode: "delegated_decision",
    });
  });

  it("applies a trailing qualifier to its own task before an earlier task", () => {
    for (const text of [
      "请帮我分析 A/B。另一个独立任务：这句话只是一个例句。",
      "我该不该辞职？另一个独立任务：这句话只是测试文本。",
    ]) {
      const analysis = analyzeSupportSpeechAct(text);
      expect(analysis.operativeDilemmaText, text).not.toContain(
        "另一个独立任务",
      );
      expect(analysis.operativeDilemmaText, text).not.toContain("测试文本");
      expect(analysis.dilemmaLike || analysis.explicitSupport, text).toBe(true);
    }
  });

  it("does not let an independent future sentence erase the current request", () => {
    expect(
      analyzeSupportSpeechAct("请帮我分析 A/B。如果需要，我再补充数字。"),
    ).toMatchObject({
      explicitSupport: true,
      supportMode: "deliberate",
    });
    for (const text of [
      "我该不该辞职？如果家人需要我，我会先留下。",
      "我该不该辞职？如果明天需要，提醒我带伞。",
      "我该不该辞职？以后再说天气。",
    ]) {
      expect(analyzeSupportSpeechAct(text).dilemmaLike, text).toBe(true);
    }
  });

  it("keeps no-colon scenarios and future conditional requests inactive", () => {
    for (const text of [
      "假设我该不该辞职，你会怎么回答？",
      "假设用户该不该辞职，请示范回答。",
      "例如我该不该辞职，你应该怎么回答？",
      "模拟我该不该辞职时的对话。",
      "测试文本是我该不该辞职。",
      "场景设定是我该不该辞职。",
      "下周如果我还没决定，再帮我分析。",
      "明天如果我焦虑，再帮我分析。",
      "后天如果我焦虑，再帮我分析。",
      "下个月如果我焦虑，再帮我分析。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: false,
        dilemmaLike: false,
        supportMode: "listen_only",
      });
    }
  });

  it("uses the current executable instruction after an authority grant", () => {
    expect(analyzeSupportSpeechAct("请你替我决定，但先听我说。")).toMatchObject(
      {
        delegated: false,
        explicitSupport: true,
        supportMode: "listen_only",
      },
    );
    expect(
      analyzeSupportSpeechAct("请你替我决定，不过先帮我分析。"),
    ).toMatchObject({
      delegated: false,
      explicitSupport: true,
      supportMode: "deliberate",
    });
    for (const text of [
      "请你替我决定，你只能给建议。",
      "请你替我决定，你只负责建议。",
    ]) {
      expect(analyzeSupportSpeechAct(text), text).toMatchObject({
        delegated: false,
        explicitSupport: true,
        supportMode: "recommend",
      });
    }
  });

  it("keeps quoted evidence visible but inert for classification", () => {
    const analysis = analyzeSupportSpeechAct("朋友说“选项 A 是杭州项目”。");
    expect(analysis.dilemmaLike).toBe(false);
    expect(analysis.operativeDilemmaText).toBe("");
    expect(analysis.operativeDilemmaClassifyText).not.toContain(
      "选项 A 是杭州项目",
    );
  });

  it("parses explicit ten-point scales and clamps the result", () => {
    expect(parseScaleMetric("压力大概 7.5 / 10", "pressure")).toBe(0.75);
    expect(parseScaleMetric("清晰度升到 12/10", "clarity")).toBe(1);
    expect(parseScaleMetric("压力有一点高", "pressure")).toBeUndefined();
  });

  it("does not turn negated plans or provenance questions into actions", () => {
    expect(isActionEvidence("我今天已经提交了申请")).toBe(true);
    expect(
      isActionEvidence(
        "你今天已经把克制版粗剪发给被摄者确认了，这是实际行动。",
      ),
    ).toBe(true);
    expect(isActionEvidence("我还没有提交申请，只是计划去做")).toBe(false);
    expect(isActionEvidence("我朋友已经按照这个决定提交了离职申请")).toBe(
      false,
    );
    expect(isActionEvidence("请按顺序回顾决定、行动和结果分别是什么")).toBe(
      false,
    );
  });

  it("requires observed outcome language instead of questions or scale-only feedback", () => {
    expect(isOutcomeEvidence("后来公司同意了申请，结果比预期更好")).toBe(true);
    expect(isOutcomeEvidence("我朋友辞职后，后来结果成功了。")).toBe(false);
    expect(isOutcomeEvidence("后来我朋友成功了。")).toBe(false);
    expect(isOutcomeEvidence("后来我成功了。")).toBe(true);
    expect(isOutcomeEvidence("后来你成功了。")).toBe(true);
    expect(isOutcomeEvidence("还没有最终结果，公司也没有反馈")).toBe(false);
    expect(isOutcomeEvidence("压力 6/10，清晰度 8/10")).toBe(false);
    expect(isOutcomeEvidence("明天这个决定的结果可能会让我很开心")).toBe(false);
  });

  it("does not turn third-party consent modality or its correction into life action/outcome evidence", () => {
    for (const text of [
      "姨妈也许愿意让我单独看修复稿。",
      "姨妈还没确认是否允许我查看修复稿。",
      "刚才说了姨妈没有同意让我看修复稿，不能说她已经同意了。",
      "更正一下：姨妈没有授权公开或转发修复稿。",
    ]) {
      expect(isActionEvidence(text), text).toBe(false);
      expect(isOutcomeEvidence(text), text).toBe(false);
      expect(isReflectionEvidence(text), text).toBe(false);
    }
  });

  it.each([
    [
      "姨妈也许愿意让我看修复稿；另外我今天已经提交了副主编岗位的申请。",
      true,
      false,
      false,
    ],
    [
      "姨妈也许愿意让我看修复稿；另外，后来我拿到了副主编岗位，但收入比原来少，这是混合结果。",
      false,
      true,
      false,
    ],
    [
      "姨妈也许愿意让我看修复稿；另外我回头看接受副主编岗位这个决定，仍认同稳定收入的方向，但也担心创作时间减少的代价。",
      false,
      false,
      true,
    ],
    [
      "刚才说了姨妈没有同意让我看修复稿，不能说她已经同意了；另外我在考虑副主编岗位。",
      false,
      false,
      false,
    ],
  ] as const)(
    "classifies only independent life evidence: %s",
    (text, action, outcome, reflection) => {
      expect(isActionEvidence(text)).toBe(action);
      expect(isOutcomeEvidence(text)).toBe(outcome);
      expect(isReflectionEvidence(text)).toBe(reflection);
    },
  );

  it("distinguishes reflection evidence from a reflection request", () => {
    expect(isReflectionEvidence("回头看，我很庆幸做了这个决定")).toBe(true);
    expect(isReflectionEvidence("你现在怎么看自己的选择？")).toBe(false);
    expect(isReflectionEvidence("我朋友回头看这个决定，觉得很值得")).toBe(
      false,
    );
    expect(reflectionStance("我仍认同这个方向，但也担心代价")).toBe("mixed");
    expect(reflectionStance("我后悔了，觉得自己选错了")).toBe("reverse");
  });

  it("requires current first-person pressure instead of possible future pressure", () => {
    expect(isPressureDisclosure("我现在因为工作很焦虑")).toBe(true);
    expect(isPressureDisclosure("以后我可能会很焦虑")).toBe(false);
    expect(isPressureDisclosure("我朋友最近因为工作很焦虑")).toBe(false);
  });

  it("keeps causal-stage gates and small normalization helpers deterministic", () => {
    expect(
      hasExplicitCausalStageReference(
        "为了这个决定，我已经开始落实第一步",
        "action",
      ),
    ).toBe(true);
    expect(
      hasExplicitCausalStageReference("后来公司回复并同意了", "outcome"),
    ).toBe(true);
    expect(inferActionKind("我已经完成了申请")).toBe("completed");
    expect(inferOutcomeValence("结果成功了，但收入更不稳定")).toBe("mixed");
    expect(pressureKind("creative")).toBe("work");
    expect(exactlyOne(["only"])).toBe("only");
    expect(exactlyOne(["one", "two"])).toBeUndefined();
    expect(compactLifePromptText("  一段\n  文本  ", 20)).toBe("一段 文本");
  });
});
