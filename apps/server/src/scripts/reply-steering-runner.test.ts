import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplySteeringMode } from "@personasim/features";
import { readConfig, type ServerConfig } from "../config.js";
import type { ReplySteeringBlindReviewKey } from "./reply-steering-report.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import {
  assertPromptPair,
  runReplySteering,
  evaluationConfig,
  resolveSteeringModes,
  steeringModeOrder,
  visibleEvidence,
  withoutLengthSteering,
  withoutSteeringFields,
  STEERING_FIELDS,
} from "./reply-steering-runner.js";

describe("reply steering experiment integrity", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the historical default pair and rejects ambiguous mode selections", () => {
    expect(resolveSteeringModes()).toEqual(["current", "no_length_steering"]);
    for (const modes of [
      [],
      ["current"],
      ["no_length_only_steering"],
      ["current", "current"],
      ["current", "typo"],
    ]) {
      expect(() => resolveSteeringModes(modes)).toThrow();
    }
    expect(resolveSteeringModes(["no_delivery_steering", "current"])).toEqual([
      "no_delivery_steering",
      "current",
    ]);
  });

  it("deterministically shuffles multi-arm order without fixing the middle mode", () => {
    const modes: ReplySteeringMode[] = [
      "current",
      "no_length_steering",
      "no_length_only_steering",
      "no_chunk_count_steering",
      "no_delivery_steering",
    ];
    const positions = new Set<number>();
    for (let scenario = 0; scenario < 12; scenario++) {
      const key = `profile/persona/scenario-${scenario}/1`;
      const ordered = steeringModeOrder(modes, key);
      expect(ordered).toEqual(steeringModeOrder(modes.toReversed(), key));
      expect([...ordered].sort()).toEqual([...modes].sort());
      positions.add(ordered.indexOf("no_length_only_steering"));
    }
    expect(positions.size).toBeGreaterThan(2);
  });

  it.each([
    ["no_length_only_steering", ["softTargetCharacters", "lengthGuidance"]],
    ["no_chunk_count_steering", ["preferredChunkCount"]],
    ["no_delivery_steering", ["deliveryPreference", "deliveryGuidance"]],
  ] as const)(
    "enforces exact field removal and token budget for %s",
    (mode, fields) => {
      const strategy = {
        advicePolicy: "none_now",
        ...Object.fromEntries(STEERING_FIELDS.map((field) => [field, "steer"])),
      };
      const baseline = {
        system: "fixed",
        prompt: `REPLY_STRATEGY_JSON\n${JSON.stringify(strategy)}`,
        maxOutputTokens: 123,
      };
      const expected = Object.fromEntries(
        Object.entries(strategy).filter(
          ([key]) => !(fields as readonly string[]).includes(key),
        ),
      );
      const experimental = {
        ...baseline,
        prompt: `REPLY_STRATEGY_JSON\n${JSON.stringify(expected)}`,
      };
      expect(withoutSteeringFields(baseline.prompt, mode)).toBe(
        experimental.prompt,
      );
      expect(() =>
        assertPromptPair(baseline, experimental, mode),
      ).not.toThrow();
      expect(() =>
        assertPromptPair(
          baseline,
          { ...experimental, maxOutputTokens: 124 },
          mode,
        ),
      ).toThrow("Output budgets differ");
      expect(() =>
        assertPromptPair(
          baseline,
          { ...experimental, prompt: withoutLengthSteering(baseline.prompt) },
          mode,
        ),
      ).toThrow("outside approved fields");
      expect(() => assertPromptPair(baseline, baseline, mode)).toThrow(
        "outside approved fields",
      );
      const missing = { ...baseline, prompt: experimental.prompt };
      expect(() => assertPromptPair(missing, experimental, mode)).toThrow(
        "Baseline missing",
      );
    },
  );

  it("resolves evaluation policy from captured settings without re-reading environment", () => {
    const base = readConfig({
      memoryRecallMode: "legacy",
      personaRuntimeMode: "off",
      logLevel: "info",
    });
    const original = structuredClone(base);
    vi.stubEnv("LOG_LEVEL", "debug");
    const effective = evaluationConfig(
      base,
      { ...base.llm, model: "isolated-evaluation-model" },
      "isolated",
    );
    expect(effective.logLevel).toBe("info");
    expect(effective).toMatchObject({
      memoryRecallMode: "enforced",
      personaRuntimeMode: "enforced",
      clockMode: "fake",
      correspondenceMode: "off",
    });
    expect(effective.llm.model).toBe("isolated-evaluation-model");
    expect(base).toEqual(original);
  });
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

  it("runs every isolated ablation, records its exact proof and separates deployment settings", async () => {
    const directory = join(
      CONTINUITY_WORKSPACE_ROOT,
      "tmp",
      `reply-steering-test-${randomUUID()}`,
    );
    const modes: ReplySteeringMode[] = [
      "current",
      "no_length_steering",
      "no_length_only_steering",
      "no_chunk_count_steering",
      "no_delivery_steering",
    ];
    vi.stubEnv("PERSONA_RUNTIME_MODE", "off");
    const deploymentSecret = Buffer.alloc(32, 7).toString("base64");
    vi.stubEnv("INSTANCE_SECRET", deploymentSecret);
    try {
      const results = await runReplySteering({
        output: directory,
        profiles: ["deepseek"],
        personas: ["warm-observant"],
        scenarioIds: ["sharing-small-delight"],
        repeats: 1,
        fixture: true,
        modes,
      });
      expect(results).toHaveLength(5);
      expect(results.every((row) => row.success)).toBe(true);
      expect(new Set(results.map((row) => row.promptSha256)).size).toBe(5);
      expect(
        new Set(results.map((row) => row.nonTargetPromptSha256)).size,
      ).toBe(1);
      const manifestText = readFileSync(
        join(directory, "manifest.json"),
        "utf8",
      );
      expect(manifestText).not.toContain(deploymentSecret);
      expect(manifestText).not.toContain("fixture-only");
      const manifest = JSON.parse(manifestText) as {
        experiment: {
          options: { modes: ReplySteeringMode[] };
          baseDeploymentConfig: ServerConfig;
          effectiveEvaluationConfigs: { deepseek: ServerConfig };
        };
      };
      expect(manifest.experiment.options.modes).toEqual(modes);
      expect(manifest.experiment.baseDeploymentConfig.personaRuntimeMode).toBe(
        "off",
      );
      expect(
        manifest.experiment.effectiveEvaluationConfigs.deepseek
          .personaRuntimeMode,
      ).toBe("enforced");
      const artifact = JSON.parse(
        readFileSync(
          join(
            directory,
            "deepseek_warm-observant_sharing-small-delight_prompt-pair.json",
          ),
          "utf8",
        ),
      ) as { proofs: { mode: ReplySteeringMode; removedFields: string[] }[] };
      expect(artifact.proofs).toHaveLength(4);
      expect(
        artifact.proofs.find(
          (proof) => proof.mode === "no_length_only_steering",
        )?.removedFields,
      ).toEqual(["softTargetCharacters", "lengthGuidance"]);
      const key = JSON.parse(
        readFileSync(join(directory, "blind-key.json"), "utf8"),
      ) as ReplySteeringBlindReviewKey;
      expect(key.groups).toHaveLength(4);
      expect(key.groups.every((group) => group.candidates.length === 2)).toBe(
        true,
      );
    } finally {
      const child = relative(join(CONTINUITY_WORKSPACE_ROOT, "tmp"), directory);
      if (!child.startsWith("..") && child.startsWith("reply-steering-test-"))
        rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

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
