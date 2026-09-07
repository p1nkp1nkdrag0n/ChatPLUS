import { describe, expect, it } from "vitest";

import {
  deriveExplicitPersonaPractices,
  deriveExplicitPersonaPracticeRetractions,
} from "./persona-projection.js";

describe("finite explicit relationship practice planning", () => {
  it("captures plain expression and active small questions as independent explicit directions", () => {
    const text = "以后少打比方，直接说。以后你可以主动问一点。";
    expect(deriveExplicitPersonaPractices({ text, userId: "user" })).toEqual([
      {
        kind: "relationship_practice",
        facet: "expression_style",
        practice: "plain_expression",
        scope: { userId: "user" },
        content: text,
      },
      {
        kind: "relationship_practice",
        facet: "follow_up_questions",
        practice: "natural_questions",
        scope: { userId: "user" },
        content: text,
      },
    ]);
  });

  it("binds each enduring request to its own topic and leaves tonight's exception transient", () => {
    const text =
      "以后聊工作时，少打比方直接说。以后聊电影时，你可以主动问一点，但今晚少问。";
    expect(
      deriveExplicitPersonaPractices({ text, userId: "user" }).map((item) => ({
        practice: item.practice,
        topic: item.scope.topic,
      })),
    ).toEqual([
      { practice: "plain_expression", topic: "工作" },
      { practice: "natural_questions", topic: "电影" },
    ]);
  });

  it.each([
    "今晚少问。",
    "今晚你可以主动问一点。",
    "我希望今晚少问。",
    "这次用一个比喻解释。",
    "嗯。",
    "咖啡店。",
    "我们换个话题吧。",
    "同事说以后你可以主动问一点。",
    "‘以后少打比方直接说’这句话怎么翻译？",
    "'以后你可以主动问一点'",
    "'以后少打比方直接说'",
    "`以后你可以主动问一点`",
    "以后我自己主动问一点。",
    "以后我主动问你一点。",
    "以后我少打比方。",
    "以后我少问。",
    "以后我少追问你。",
    "以后我不喜欢你主动问一点。",
    "以后我不希望你直接说。",
    "以后我不想你少问。",
    "以后我会少打比方。",
    "以后你不要主动问一点。",
  ])(
    "does not infer a persistent expression practice from unsupported input: %s",
    (text) => {
      expect(deriveExplicitPersonaPractices({ text, userId: "user" })).toEqual(
        [],
      );
    },
  );

  it("does not silently choose between conflicting question directions", () => {
    expect(
      deriveExplicitPersonaPractices({
        text: "以后少问，以后你主动问一点。",
        userId: "user",
      }),
    ).toEqual([]);
  });

  it("withdraws explicit ongoing expression requests without turning temporary exceptions into withdrawals", () => {
    expect(
      deriveExplicitPersonaPracticeRetractions({
        text: "以后不用特意少打比方。以后不用主动问了。",
        userId: "user",
      }).map((item) => item.facet),
    ).toEqual(["expression_style", "follow_up_questions"]);
    expect(
      deriveExplicitPersonaPracticeRetractions({
        text: "今晚不用主动问了，这次可以多打比方。",
        userId: "user",
      }),
    ).toEqual([]);
    expect(
      deriveExplicitPersonaPracticeRetractions({
        text: "以后我不用主动问你了。",
        userId: "user",
      }),
    ).toEqual([]);
    expect(
      deriveExplicitPersonaPracticeRetractions({
        text: "'以后不用主动问了'",
        userId: "user",
      }),
    ).toEqual([]);
  });
  it("retains topic scope and extracts only the finite requested facets", () => {
    const proposals = deriveExplicitPersonaPractices({
      text: "我谈工作烦恼时，先听我说，不急着建议，也不要追问。",
      userId: "user",
    });
    expect(proposals.map((item) => item.facet)).toEqual([
      "advice_timing",
      "follow_up_questions",
    ]);
    expect(proposals.every((item) => item.scope.topic === "工作烦恼")).toBe(
      true,
    );
  });

  it.each([
    "今天我好累，先听我说。",
    "她说以后不要追问她。",
    "如果我说以后别建议，你会怎么办？",
    "我会变得更温柔，更理解你。",
    "你以后就是完全顺从我的人。",
    "以后不要先听我说，请直接给建议。",
    "When I talk about work, I prefer fewer questions.",
  ])(
    "does not turn transient, reported, ambiguous, or identity text into an adaptation: %s",
    (text) => {
      expect(deriveExplicitPersonaPractices({ text, userId: "user" })).toEqual(
        [],
      );
    },
  );

  it("recognizes same-topic explicit withdrawal without producing a positive listen-first practice", () => {
    const text = "以后聊工作不用总先听，直接给我建议。";
    expect(
      deriveExplicitPersonaPracticeRetractions({ text, userId: "user" }),
    ).toEqual([
      {
        facet: "advice_timing",
        scope: { userId: "user", topic: "工作" },
        content: text,
      },
    ]);
    expect(deriveExplicitPersonaPractices({ text, userId: "user" })).toEqual(
      [],
    );
  });

  it.each([
    "现在改一下，以后聊工作时可以直接给我建议。",
    "现在起，以后聊工作时可以直接给我建议。",
    "今天先听我说，以后聊工作时可以直接给我建议。",
    "以后聊工作时，直接给我建议。",
    "以后聊工作时可以直接给我建议，但今天还是先听我说。",
  ])(
    "uses the enduring clause's topic and interval for withdrawal: %s",
    (text) => {
      expect(
        deriveExplicitPersonaPracticeRetractions({ text, userId: "user" }),
      ).toEqual([
        {
          facet: "advice_timing",
          scope: { userId: "user", topic: "工作" },
          content: text,
        },
      ]);
    },
  );

  it.each([
    "这次先给建议。",
    "现在直接给我建议。",
    "以后还是先听，但今天可以分析。",
    "以后聊工作时还是先听，但今天可以直接给我建议。",
    "以后聊工作时，今天直接给我建议，也可以追问。",
    "以后聊工作时先听我说，再直接给我建议。",
    "以后聊工作时不要直接给我建议，也不可以追问。",
    "她说现在改一下，以后聊工作时可以直接给我建议。",
    "如果现在改一下，以后聊工作时可以直接给我建议。",
    "以后先听我说。今天聊电影时可以直接给我建议。",
  ])(
    "does not withdraw for temporary, sequential, negated or reported clauses: %s",
    (text) => {
      expect(
        deriveExplicitPersonaPracticeRetractions({ text, userId: "user" }),
      ).toEqual([]);
    },
  );

  it("recognizes an explicit global interval without making a transient second facet enduring", () => {
    const text = "现在起，以后给建议，但这次也可以追问。";
    expect(
      deriveExplicitPersonaPracticeRetractions({ text, userId: "user" }),
    ).toEqual([
      {
        facet: "advice_timing",
        scope: { userId: "user" },
        content: text,
      },
    ]);
  });

  it("keeps each withdrawal bound to its own parsed topic", () => {
    const text = "现在改一下，以后聊工作时直接给我建议，以后聊家庭时可以追问。";
    expect(
      deriveExplicitPersonaPracticeRetractions({ text, userId: "user" }),
    ).toEqual([
      {
        facet: "advice_timing",
        scope: { userId: "user", topic: "工作" },
        content: text,
      },
      {
        facet: "follow_up_questions",
        scope: { userId: "user", topic: "家庭" },
        content: text,
      },
    ]);
  });
});
