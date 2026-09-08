import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import {
  assertPromptPair,
  runReplySteering,
  visibleEvidence,
  withoutLengthSteering,
  STEERING_FIELDS,
} from "./reply-steering-runner.js";

describe("reply steering experiment integrity", () => {
  it("rejects differences to grounding, controls or the output protocol", () => {
    const strategy = {
      complexity: "simple",
      advicePolicy: "none_now",
      ...Object.fromEntries(STEERING_FIELDS.map((field) => [field, "steer"])),
    };
    const current = {
      system: "same protocol",
      prompt: `HISTORY\nfixed\nREPLY_STRATEGY_JSON\n${JSON.stringify(strategy)}\nUSER\nhello`,
    };
    const experimental = {
      ...current,
      prompt: withoutLengthSteering(current.prompt),
    };
    expect(() => assertPromptPair(current, experimental)).not.toThrow();
    expect(() =>
      assertPromptPair(current, { ...experimental, system: "changed" }),
    ).toThrow();
    expect(() =>
      assertPromptPair(current, {
        ...experimental,
        prompt: experimental.prompt.replace("fixed", "more memory"),
      }),
    ).toThrow();
    expect(() =>
      assertPromptPair(current, {
        ...experimental,
        prompt: experimental.prompt.replace("none_now", "allowed"),
      }),
    ).toThrow();
  });

  it("exports visible model content and usage without hidden reasoning", () => {
    expect(
      visibleEvidence({
        choices: [
          { message: { content: "visible", reasoning_content: "private" } },
        ],
        usage: {
          completion_tokens: 5,
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      }),
    ).toEqual({
      choices: [{ message: { content: "visible" } }],
      usage: {
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
  });

  it("runs paired HTTP generations from unchanged isolated snapshots without network", async () => {
    const directory = join(
      CONTINUITY_WORKSPACE_ROOT,
      "tmp",
      `reply-steering-test-${randomUUID()}`,
    );
    try {
      const results = await runReplySteering({
        output: directory,
        profiles: ["deepseek"],
        personas: ["warm-observant"],
        scenarioIds: ["sharing-small-delight", "help-presentation-tonight"],
        repeats: 1,
        fixture: true,
      });
      expect(results).toHaveLength(4);
      expect(
        results.every((row) => row.success && row.physicalRequests >= 1),
      ).toBe(true);
      expect(
        results.every(
          (row) =>
            row.inputTokens === null &&
            row.outputTokens === null &&
            !row.usageComplete,
        ),
      ).toBe(true);
      for (const id of ["sharing-small-delight", "help-presentation-tonight"]) {
        const pair = results.filter((row) => row.scenarioId === id);
        expect(new Set(pair.map((row) => row.nonTargetPromptSha256)).size).toBe(
          1,
        );
        expect(new Set(pair.map((row) => row.promptSha256)).size).toBe(2);
      }
      const records = readFileSync(join(directory, "attempts.jsonl"), "utf8");
      expect(records).not.toContain("fixture-only");
      expect(
        readFileSync(join(directory, "blind-review.md"), "utf8"),
      ).not.toContain("no_length_steering");
      expect(
        JSON.parse(readFileSync(join(directory, "results.json"), "utf8")),
      ).toHaveLength(4);
    } finally {
      const child = relative(join(CONTINUITY_WORKSPACE_ROOT, "tmp"), directory);
      if (!child.startsWith("..") && child.startsWith("reply-steering-test-")) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
