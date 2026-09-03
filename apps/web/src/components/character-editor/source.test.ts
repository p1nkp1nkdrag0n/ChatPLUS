import { afterEach, describe, expect, it, vi } from "vitest";

import { rebaseEditedRuleToUserSpec } from "./source";

afterEach(() => vi.restoreAllMocks());

describe("rebaseEditedRuleToUserSpec", () => {
  it("rebases an edited canon rule onto a newly created user source", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    const original = {
      id: "rule-canon",
      kind: "register" as const,
      instruction: "使用原作中的正式语气。",
      enforcement: "soft" as const,
      conditions: ["公开场合"],
      origin: "canon_extract" as const,
      sourceRefs: ["source-canon"],
    };

    const result = rebaseEditedRuleToUserSpec(
      {
        sources: [
          {
            id: "source-canon",
            sourceType: "imported_text",
            label: "原作文本",
          },
        ],
      },
      original,
      (rule) => ({ ...rule, instruction: "改用更直接的表达。" }),
    );

    expect(result.rule).toEqual({
      ...original,
      instruction: "改用更直接的表达。",
      origin: "user_spec",
      sourceRefs: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(result.sources).toEqual([
      {
        id: "source-canon",
        sourceType: "imported_text",
        label: "原作文本",
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        sourceType: "user_spec",
        label: "角色编辑器手工设定",
      },
    ]);
  });

  it("reuses the existing user source instead of creating duplicates", () => {
    const result = rebaseEditedRuleToUserSpec(
      {
        sources: [
          {
            id: "source-user",
            sourceType: "user_spec",
            label: "角色编辑器手工设定",
          },
        ],
      },
      {
        behavior: "保持距离",
        origin: "model_inference" as const,
        sourceRefs: ["source-model"],
      },
      (rule) => ({ ...rule, behavior: "先倾听，再回应" }),
    );

    expect(result.rule.origin).toBe("user_spec");
    expect(result.rule.sourceRefs).toEqual(["source-user"]);
    expect(result.sources).toHaveLength(1);
  });
});
