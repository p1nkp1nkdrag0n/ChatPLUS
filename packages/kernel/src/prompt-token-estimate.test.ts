import { describe, expect, it } from "vitest";
import {
  estimatePromptTokens,
  promptPrefixWithinTokenBudget,
} from "./prompt-token-estimate.js";

describe("Unicode prompt planning estimate", () => {
  it("keeps English text efficient and counts Chinese, JSON and emoji explicitly", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("abcd efgh ijkl")).toBe(4);
    expect(estimatePromptTokens("我没有同意")).toBe(10);
    expect(estimatePromptTokens("😀")).toBe(4);
    expect(estimatePromptTokens('{"ok":true}')).toBe(7);
    expect(estimatePromptTokens("Hello，我没有同意😀")).toBe(18);
  });

  it("estimates the original code points without compatibility normalization", () => {
    expect(estimatePromptTokens("ＡＢＣＤ")).toBe(8);
    expect(estimatePromptTokens("ABCD")).toBe(1);
    expect(estimatePromptTokens("𠮷")).toBe(4);
  });

  it.each([
    "中文不能拆散否定条件",
    "English sentence.",
    "中英 mixed 😀😀",
    '{"note":"没有同意😀","ok":false}',
  ])("returns a bounded prefix without orphan surrogates: %s", (text) => {
    for (let budget = 0; budget < estimatePromptTokens(text); budget += 1) {
      const prefix = promptPrefixWithinTokenBudget(text, budget);
      expect(text.startsWith(prefix)).toBe(true);
      expect(estimatePromptTokens(prefix)).toBeLessThanOrEqual(budget);
      expect(prefix).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  });
});
