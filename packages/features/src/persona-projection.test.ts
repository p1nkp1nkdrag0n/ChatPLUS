import { describe, expect, it } from "vitest";

import {
  deriveExplicitPersonaPractices,
  deriveExplicitPersonaPracticeRetractions,
} from "./persona-projection.js";

describe("finite explicit relationship practice planning", () => {
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
