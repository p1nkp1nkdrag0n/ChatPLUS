import {
  assembleChatPrompt,
  estimatePromptTokens,
  PromptSegmentRegistryError,
  REPLY_TASK_GROUNDING_POLICY,
} from "@personasim/features";
import { describe, expect, it } from "vitest";

import { RUNTIME_STATE_AUDIT_CASES } from "../scripts/runtime-state-audit-cases.js";
import { runtimeStateAuditInput } from "../scripts/runtime-state-audit-prompts.js";

type AssembledPrompt = ReturnType<typeof assembleChatPrompt>;

function requiredContents(assembled: AssembledPrompt): Map<string, string> {
  const contents = new Map<string, string>();
  for (const placement of ["system", "prompt"] as const) {
    let offset = 0;
    const included = assembled.segmentTrace.segments
      .filter((segment) => segment.included && segment.placement === placement)
      .sort((left, right) => left.renderedIndex! - right.renderedIndex!);
    for (const segment of included) {
      expect(segment.renderedCharacters).toBeTypeOf("number");
      const content = assembled[placement].slice(
        offset,
        offset + segment.renderedCharacters!,
      );
      if (segment.required) contents.set(segment.id, content);
      offset += segment.renderedCharacters! + 1;
    }
    expect(offset - 1).toBe(assembled[placement].length);
  }
  return contents;
}

function requiredTokenCount(assembled: AssembledPrompt): number {
  const contents = requiredContents(assembled);
  return (["system", "prompt"] as const).reduce(
    (total, placement) =>
      total +
      estimatePromptTokens(
        assembled.segmentTrace.segments
          .filter(
            (segment) =>
              segment.required &&
              segment.included &&
              segment.placement === placement,
          )
          .sort((left, right) => left.renderedIndex! - right.renderedIndex!)
          .map((segment) => contents.get(segment.id)!)
          .join("\n"),
      ),
    0,
  );
}

describe.each(["fuzzy", "legacy_exact"] as const)(
  "real runtime-state prompt budget: %s",
  (mode) => {
    const input = () =>
      runtimeStateAuditInput(
        "social-outward",
        RUNTIME_STATE_AUDIT_CASES[0]!,
        mode,
      );

    it.each([3_000, 5_000])(
      "rejects %s tokens instead of sending an empty persona or partial policy",
      (maxInputTokens) => {
        let failure: unknown;
        try {
          assembleChatPrompt({ ...input(), maxInputTokens });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(PromptSegmentRegistryError);
        expect(failure).toMatchObject({
          code: "required_segments_exceed_budget",
        });
      },
    );

    it("retains the actual required payload and normal prompt at 32k tokens", () => {
      const normal = assembleChatPrompt(input());
      const unboundedInput = input();
      delete unboundedInput.maxInputTokens;
      const unbounded = assembleChatPrompt(unboundedInput);
      expect(normal.system).toBe(unbounded.system);
      expect(normal.prompt).toBe(unbounded.prompt);
      expect(normal.segmentTrace.estimatedInputTokens).toBeLessThanOrEqual(
        32_000,
      );

      const required = requiredContents(normal);
      expect(required).toEqual(requiredContents(unbounded));
      expect([...required.keys()].sort()).toEqual([
        "01_app_policy",
        "01b_reply_task_grounding_policy",
        "02_character_identity",
        "03_core_persona",
        "05_boundaries",
        "08_runtime_state",
        "10_current_time",
        "15_reply_strategy",
        "16_user_message",
        "17_output_contract",
      ]);
      for (const segment of normal.segmentTrace.segments.filter(
        (segment) => segment.required,
      )) {
        expect(segment.included).toBe(true);
        expect(segment.truncated).toBe(false);
        expect(required.get(segment.id)).not.toContain('"_truncated":true');
      }
      const persona = JSON.parse(
        required.get("03_core_persona")!.split("\n")[1]!,
      ) as { traits: unknown[] };
      expect(persona.traits).toContainEqual(
        expect.objectContaining({ name: "极度外向" }),
      );
      expect(required.get("03_core_persona")).toContain("桌游《河岸》");
      expect(required.get("01_app_policy")).toMatch(/^APP_POLICY\n/u);
      expect(required.get("01b_reply_task_grounding_policy")).toBe(
        REPLY_TASK_GROUNDING_POLICY,
      );
    });

    it("removes optional appraisal whole before sacrificing required content", () => {
      const normal = assembleChatPrompt(input());
      const full = requiredContents(normal);
      // This budget cannot fit the complete required set with appraisal, but
      // can fit the core contract. Derive it from the actual fixture, not a
      // threshold that assumes a particular policy length or tokenizer count.
      const maxInputTokens = requiredTokenCount(normal) - 1;
      const reduced = assembleChatPrompt({ ...input(), maxInputTokens });
      const retained = requiredContents(reduced);
      expect(retained.size).toBe(full.size);
      for (const [id, content] of full) {
        if (id !== "17_output_contract") expect(retained.get(id)).toBe(content);
      }
      const fullContract = full.get("17_output_contract")!;
      const coreContract = retained.get("17_output_contract")!;
      expect(fullContract).toContain("optional top-level interactionAppraisal");
      expect(coreContract).not.toContain("interactionAppraisal");
      expect(coreContract).not.toContain("privateView:");
      expect(coreContract).not.toContain("need_more_space");
      expect(coreContract).not.toContain("appreciate_trust");
      expect(coreContract).toContain('"text":"the complete reply"');
      expect(fullContract.startsWith(coreContract + "\n")).toBe(true);
      expect(reduced.segmentTrace.estimatedInputTokens).toBeLessThanOrEqual(
        maxInputTokens,
      );
      expect(
        reduced.segmentTrace.segments
          .filter((segment) => segment.required)
          .every((segment) => segment.included && !segment.truncated),
      ).toBe(true);
    });
  },
);
