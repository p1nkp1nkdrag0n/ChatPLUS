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
});
