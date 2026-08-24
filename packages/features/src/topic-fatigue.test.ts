import { describe, expect, it } from "vitest";

import {
  calculateTopicFatigue,
  countRecentAssistantTopicMentions,
  normalizeTopicKey,
  topicFatiguePenalty,
  topicMentionsText,
} from "./topic-fatigue.js";

describe("topic fatigue", () => {
  it("normalizes NFKC, case, whitespace and punctuation", () => {
    expect(normalizeTopicKey(" ＧＲＡＤ Project！ ")).toBe("grad project");
    expect(
      topicMentionsText("My GRAD-project is moving.", "grad project"),
    ).toBe(true);
  });

  it("uses Latin word boundaries and compact CJK matching", () => {
    expect(topicMentionsText("The party is tomorrow.", "art")).toBe(false);
    expect(topicMentionsText("I had brunch.", "run")).toBe(false);
    expect(topicMentionsText("I make art and run.", "art")).toBe(true);
    expect(topicMentionsText("x ".repeat(100) + "art", "art")).toBe(true);
    expect(topicMentionsText("毕业作品今天有进展", "毕业 作品")).toBe(true);
  });

  it("counts each of the last twelve assistant messages at most once", () => {
    const recentMessages = [
      { role: "assistant", content: "grad project" },
      ...Array.from({ length: 11 }, (_, index) => ({
        role: "assistant",
        content: index < 2 ? "art, art, art" : "something else",
      })),
      { role: "user", content: "art" },
      { role: "assistant", content: "art" },
    ];

    expect(
      countRecentAssistantTopicMentions({ topicKey: "art" }, recentMessages),
    ).toBe(3);
    expect(
      countRecentAssistantTopicMentions({ topicKey: "art" }, recentMessages, 0),
    ).toBe(0);
    expect(
      countRecentAssistantTopicMentions(
        { topicKey: "art" },
        Array.from({ length: 30 }, () => ({
          role: "assistant",
          content: "art",
        })),
        30,
      ),
    ).toBe(12);
  });

  it("accepts explicit turn topic metadata without scanning unsafe values", () => {
    const messages = [
      {
        role: "assistant",
        content: "No lexical mention here.",
        metadata: { topicKeys: ["ＧＲＡＤ Project"], ignored: "grad project" },
      },
    ];

    expect(
      countRecentAssistantTopicMentions({ topicKey: "grad project" }, messages),
    ).toBe(1);
  });

  it("applies the deterministic penalty and caps it at 0.6", () => {
    expect([0, 1, 2, 3, 4, 10].map(topicFatiguePenalty)).toEqual([
      0, 0.15, 0.3, 0.45, 0.6, 0.6,
    ]);
  });

  it("deduplicates normalized keys and returns a stable order", () => {
    expect(
      calculateTopicFatigue({
        topics: [
          { topicKey: "Zoo" },
          { topicKey: "ＡＲＴ", aliases: ["painting"] },
          { topicKey: "art" },
        ],
        recentMessages: [{ role: "assistant", content: "painting" }],
      }),
    ).toEqual([
      { topicKey: "art", recentAssistantMentions: 1, penalty: 0.15 },
      { topicKey: "zoo", recentAssistantMentions: 0, penalty: 0 },
    ]);
  });
});
