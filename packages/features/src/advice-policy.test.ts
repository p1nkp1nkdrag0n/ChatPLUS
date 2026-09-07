import { describe, expect, it } from "vitest";

import { deriveAdvicePolicy, inspectAdviceLoad } from "./advice-policy.js";
import { buildConversationContextPlan } from "./conversation-context-plan.js";

const context = { agentId: "agent", sessionId: "session", recentMessages: [] };
const plan = (originalQuery: string) =>
  buildConversationContextPlan({ ...context, originalQuery });
const T6 = "工作倒没有出大事，就是改了一天东西，回家以后脑子还是停不下来。";
const T6_REPLY =
  "改了一天东西回家脑子还转，这个我熟，版式改到一定程度，闭上眼都是字在挪位置。\n嗯，我觉得这种情况硬让脑子停下来反而没用，不如给它找个出口，随手画两笔那种，或者干脆把没改完的点记下来，写出来的东西脑子就愿意放下了。\n看情况吧，有时候洗澡或者出门走一圈也行，别躺着硬熬就行。";
// Immutable text copied from the stopped pilot's turn-006. The source run is
// diagnostic evidence, not part of the fresh-character acceptance denominator.
const QWEN_PILOT_T6_REPLY =
  "懂那种感觉，明明身体已经下班了，但脑子里的“编辑器”还开着，还在自动纠错。\n这种惯性挺磨人的，尤其是在做改版式这种细节活儿的时候。\n有时候强迫自己彻底放空反而更难，不如做点不用动脑子的事，比如去洗个热水澡或者漫无目的地翻翻杂志，把注意力从屏幕上移开。";

describe("advice policy from current requests", () => {
  it("A01 prevents the original four-action T6 response without using later relationship practices", () => {
    const current = plan(T6);
    expect(current.advicePolicy).toBe("none_now");
    const inspected = inspectAdviceLoad({
      text: T6_REPLY,
      policy: deriveAdvicePolicy(current),
    });
    expect(inspected.passed).toBe(false);
    expect(inspected.actionCount).toBe(4);
    expect(inspected.actions.map((action) => action.text)).toEqual([
      "画两笔",
      "记下来",
      "洗澡",
      "出门走一圈",
    ]);
    for (const action of inspected.actions)
      expect(T6_REPLY.slice(action.start, action.end)).toBe(action.text);
  });

  it.each([
    [
      "A02 / T8",
      "我现在想具体想一想了，请帮我分析一下：怎样区分真正做错了，和只是被反复修改弄得烦。",
    ],
    ["A03 / T15", "不用先听我说，直接给我建议：我该怎样跟同事确认修改范围？"],
    ["A04 / T16", "不是让你先听我说，是请你帮我分析：哪些要求值得当场问清楚？"],
    ["positive control", "请比较散步和画画两种方法，再给我具体建议。"],
    ["independent paraphrase", "帮我想想办法，把能做的事具体讲讲。"],
  ])(
    "%s retains requested multi-step help without treating it as adoption",
    (_id, query) => {
      const policy = deriveAdvicePolicy(plan(query));
      expect(policy).toBe("requested");
      expect(
        inspectAdviceLoad({
          text: "你可以列一份清单、确认修改范围，再发一封邮件。",
          policy,
        }).passed,
      ).toBe(true);
    },
  );

  it("A05 defers advice until the user finishes, then honors a new explicit request", () => {
    const ordered = plan("先让我说完，然后再帮我分析。");
    expect(ordered).toMatchObject({
      helpTiming: "after_user_finishes",
      supportStyle: "listen_then_help",
      adviceRequested: true,
    });
    expect(deriveAdvicePolicy(ordered)).toBe("none_now");
    expect(
      inspectAdviceLoad({
        text: "你可以先列个清单。",
        policy: deriveAdvicePolicy(ordered),
      }).passed,
    ).toBe(false);
    expect(
      inspectAdviceLoad({
        text: "嗯，你接着说，我听着。",
        policy: deriveAdvicePolicy(ordered),
      }).passed,
    ).toBe(true);
    expect(deriveAdvicePolicy(plan("我说完了，现在请帮我分析。"))).toBe(
      "requested",
    );
  });

  it("keeps uncertain requests bounded and casual sharing limited even without a venting match", () => {
    expect(deriveAdvicePolicy(plan("先听我说，也请帮我分析。"))).toBe(
      "optional_light",
    );
    const casual = plan("到家了，感觉今天特别长。");
    expect(casual.adviceRequested).toBe(false);
    expect(deriveAdvicePolicy(casual)).toBe("optional_light");
    expect(
      inspectAdviceLoad({
        text: "不如画画、洗澡、喝水，再出门走一圈。",
        policy: deriveAdvicePolicy(casual),
      }).passed,
    ).toBe(false);
  });

  it("derives authority from the current request fields rather than trusting a cached policy label", () => {
    const current = plan("下班回来了，今天真长。");
    const mislabeled = { ...current, advicePolicy: "requested" as const };
    expect(deriveAdvicePolicy(mislabeled)).toBe("optional_light");
  });
});

describe("actual advice speech acts and action load", () => {
  it.each([
    ["A06", "不是让你去画画或列清单。"],
    ["denied directive", "我并非建议你洗澡或者出门走一圈。"],
    ["reported activities", "你说画画和走路都没用。"],
    ["quoted suggestion", "‘你可以画画、洗澡、散步’只是她说的话。"],
    ["hypothetical", "假如你去散步或者画画，也不意味着所有问题就解决了。"],
    [
      "hypothetical second-person",
      "如果你可以画画或列清单，你会怎么理解那个建议？",
    ],
    ["character's activities", "我今天洗澡后出门走一圈，还画了两笔。"],
    ["observed user action", "你昨天洗澡、散步，已经够累了。"],
    ["descriptive information", "散步有助于放松，画画能让人换个心情。"],
    ["descriptive activity coordination", "画画和散步都没用。"],
    [
      "optional suggestion followed by explanation",
      "喝水不是万能药，散步也未必有用。",
    ],
    [
      "natural empathy",
      "没有出大事，也不代表今天就轻松。改了一天，回家还缓不过来，确实很耗人。",
    ],
  ])("does not count %s as assigning the user actions", (_id, text) => {
    expect(inspectAdviceLoad({ text, policy: "none_now" })).toMatchObject({
      passed: true,
      actionCount: 0,
    });
  });

  it.each([
    "如果你愿意，可以喝口水，其他的先不管。",
    "不如休息一下吧。",
    "要不要出去走一走？",
    "你要不要出去走一走？",
    "你可以去散步，走一圈就好。",
    "不妨休息一下，歇一会儿也行。",
    "Maybe take a break.",
  ])(
    "allows a single light optional proposal in ordinary conversation: %s",
    (text) => {
      expect(
        inspectAdviceLoad({ text, policy: "optional_light" }),
      ).toMatchObject({ passed: true, actionCount: 1 });
    },
  );

  it.each([
    ["你可以画画、洗澡、喝水、散步。", 4],
    ["不妨先列个清单，再确认修改范围，然后发一封邮件。", 3],
    ["You could take a walk, make a list, and drink some water.", 3],
    ["你可以试试这些：\n- 画画\n- 洗澡\n- 散步", 3],
    ["不如把这些写在纸上，再下楼走走，最后冲个澡。", 3],
  ])(
    "counts independent actions instead of sentences or paragraphs: %s",
    (text, actionCount) => {
      const result = inspectAdviceLoad({ text, policy: "optional_light" });
      expect(result.passed).toBe(false);
      expect(result.actionCount).toBe(actionCount);
      expect(
        result.issues.some(
          (issue) => issue.code === "ADVICE_LOAD_EXCEEDS_LIGHT",
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["你必须联系同事。", "UNREQUESTED_DIRECTIVE"],
    ["你可以每天坚持写日记。", "ADVICE_LOAD_EXCEEDS_LIGHT"],
    ["不妨把整份方案重写一遍。", "ADVICE_LOAD_EXCEEDS_LIGHT"],
  ])(
    "rejects a single imposed or substantial task without help authorization: %s",
    (text, code) => {
      const result = inspectAdviceLoad({ text, policy: "optional_light" });
      expect(result.passed).toBe(false);
      expect(result.actionCount).toBe(1);
      expect(result.issues.some((issue) => issue.code === code)).toBe(true);
      expect(inspectAdviceLoad({ text, policy: "requested" }).passed).toBe(
        true,
      );
    },
  );

  it("does not let a preceding denial or quotation hide a later actual proposal", () => {
    const text =
      "不是让你去画画。‘列清单’也是别人的话。不过你可以洗澡，或者出门走一圈。";
    const result = inspectAdviceLoad({ text, policy: "optional_light" });
    expect(result.actionCount).toBe(2);
    expect(result.passed).toBe(false);
    for (const action of result.actions)
      expect(text.slice(action.start, action.end)).toBe(action.text);
  });

  it("does not let optional wording hide a later command to do the same action", () => {
    const result = inspectAdviceLoad({
      text: "你可以休息一下。你必须歇一会儿。",
      policy: "optional_light",
    });
    expect(result.actionCount).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.actions[0]?.text).toBe("歇一会儿");
    expect(
      result.issues.some((issue) => issue.code === "UNREQUESTED_DIRECTIVE"),
    ).toBe(true);
  });
});

describe("Qwen T6 scoped recommendation frames", () => {
  it("rejects the complete stopped-pilot failure instead of treating it as a reliable zero", () => {
    const result = inspectAdviceLoad({
      text: QWEN_PILOT_T6_REPLY,
      policy: deriveAdvicePolicy(plan(T6)),
    });
    expect(result.passed).toBe(false);
    expect(result.actions.map((action) => action.text)).toEqual([
      "洗个热水澡",
      "翻翻杂志",
    ]);
    expect(result.actionCount).toBe(2);
    expect(result.coverage.status).toBe("resolved");
    for (const action of result.actions)
      expect(QWEN_PILOT_T6_REPLY.slice(action.start, action.end)).toBe(
        action.text,
      );
  });

  it.each([
    ["不如做点不用动脑子的事，比如去洗个热水澡或者翻翻杂志。", 2],
    ["可以做点轻松的事，例如冲个澡，也可以读读杂志。", 2],
    ["你可以读读不用动脑子的杂志。", 1],
    ["先不用做计划，不过可以把电脑收起来。", 1],
    ["如果你愿意，可以试试泡个澡，或者随便翻几页杂志。", 2],
    ["不妨洗个澡，或者不用费心地读读书。", 2],
    ["你可以试试不需要费心的活动，比如洗澡或者翻杂志。", 2],
  ])(
    "keeps negation local and examples in their active frame: %s",
    (text, count) => {
      const result = inspectAdviceLoad({ text, policy: "none_now" });
      expect(result.actionCount).toBe(count);
      expect(result.passed).toBe(false);
      expect(result.coverage.status).toBe("resolved");
      for (const action of result.actions)
        expect(text.slice(action.start, action.end)).toBe(action.text);
    },
  );

  it.each([
    "我不是让你洗澡或翻杂志。",
    "你说洗澡和翻杂志都没用。",
    "我今晚会洗澡，然后翻杂志。",
    "她建议你洗澡，比如泡个热水澡，或者翻杂志。",
    "如果他有空，可以洗澡，然后翻杂志。",
    "你可以不用洗澡，也不必翻杂志。",
    "不用洗澡或者翻杂志，我只是听你说。",
    "“你可以洗澡”，或者“翻翻杂志”，都是我以前听过的建议。",
    "你可以继续说，我在听。",
    "不如聊聊今天发生了什么。",
    "你可以难过，不用急着变得开心。",
    "你可以继续聊，说什么都行。",
    "不如聊聊散步时发生的事。",
    "不如先讲讲洗澡后为什么舒服。",
    "我下班后洗澡，然后翻杂志。",
  ])("does not assign activities outside a user advice frame: %s", (text) => {
    expect(inspectAdviceLoad({ text, policy: "none_now" })).toMatchObject({
      passed: true,
      actionCount: 0,
      reviewRequired: false,
      coverage: { status: "no_action_frame" },
    });
  });

  it("stops inheritance at a subject change but permits a new explicit user suggestion", () => {
    const result = inspectAdviceLoad({
      text: "你可以洗澡，我今晚会翻杂志，然后画两笔，不过你也可以喝水。",
      policy: "none_now",
    });
    expect(result.actions.map((action) => action.text)).toEqual([
      "洗澡",
      "喝水",
    ]);
  });

  it("stops inheriting an optional list across a quoted report", () => {
    const result = inspectAdviceLoad({
      text: "不如洗澡，“休息一下”是她的原话，或者翻杂志也是她的说法。",
      policy: "none_now",
    });
    expect(result.actions.map((action) => action.text)).toEqual(["洗澡"]);
    expect(result.coverage.status).toBe("resolved");
  });

  it("retains concrete help and deduplicates the strongest repeated action across bubbles", () => {
    const text = "你可以洗澡，或者翻杂志。\n你必须每天读读杂志。";
    const result = inspectAdviceLoad({ text, policy: "requested" });
    expect(result.passed).toBe(true);
    expect(result.actionCount).toBe(2);
    expect(result.actions[1]).toMatchObject({
      strength: "directive",
      burden: "substantial",
      text: "读读杂志",
    });
    expect(inspectAdviceLoad({ text, policy: "optional_light" }).passed).toBe(
      false,
    );
  });

  it.each([
    "不如捏个陶土小碗。",
    "你可以给盆栽换个花盆。",
    "你可以先说服同事。",
    "可以找点轻松的事，例如捏个陶土小碗。",
  ])(
    "retains unresolved concrete candidates with spans and bounded none-now review: %s",
    (text) => {
      const result = inspectAdviceLoad({ text, policy: "none_now" });
      expect(result.actionCount).toBe(0);
      expect(result.reviewRequired).toBe(true);
      expect(result.coverage.status).toBe("unresolved");
      expect(result.coverage.unsupportedCandidates.length).toBeGreaterThan(0);
      expect(
        result.issues.some(
          (issue) => issue.code === "ADVICE_ACTION_UNRESOLVED",
        ),
      ).toBe(true);
      for (const candidate of result.coverage.unsupportedCandidates)
        expect(text.slice(candidate.start, candidate.end)).toBe(candidate.text);
      expect(inspectAdviceLoad({ text, policy: "requested" }).passed).toBe(
        true,
      );
    },
  );

  it("does not hide an unknown coordinated action behind a parsed action", () => {
    const text = "不如洗个澡，或者捏个陶土小碗。";
    const result = inspectAdviceLoad({ text, policy: "none_now" });
    expect(result.actionCount).toBe(1);
    expect(result.coverage.status).toBe("partial");
    expect(result.reviewRequired).toBe(true);
    expect(
      result.coverage.unsupportedCandidates.map((candidate) => candidate.text),
    ).toContain("捏个陶土小碗");
  });

  it.each(["你可以洗澡也可以捏个陶土小碗。", "你可以洗澡，并且捏个陶土小碗。"])(
    "retains an unsupported coordinated alternative: %s",
    (text) => {
      const result = inspectAdviceLoad({
        text,
        policy: "none_now",
      });
      expect(result.actionCount).toBe(1);
      expect(result.coverage.status).toBe("partial");
      expect(
        result.coverage.unsupportedCandidates.map(
          (candidate) => candidate.text,
        ),
      ).toContain("捏个陶土小碗");
    },
  );

  it.each([
    "也许换个角度会不同。",
    "也许可以捏个陶土小碗。",
    "也许可以做点轻松的事，比如捏个陶土小碗。",
  ])(
    "marks ambiguous frameworks for review without declaring every uncertainty a violation: %s",
    (text) => {
      const result = inspectAdviceLoad({
        text,
        policy: "none_now",
      });
      expect(result.passed).toBe(true);
      expect(result.actionCount).toBe(0);
      expect(result.reviewRequired).toBe(true);
      expect(result.coverage.status).toBe("unresolved");
      expect(result.issues).toEqual([]);
    },
  );
});
