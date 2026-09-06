import { afterEach, describe, expect, it, vi } from "vitest";

import { readConfig } from "../config.js";
import { LONG_RUN_V2_PROFILE_ORDER } from "./companion-long-run-v2-run-types.js";
import {
  apiKeyEnvironmentForProfile,
  assertLongRunV2ProfileConfigsReady,
  buildLongRunV2ChildEnvironment,
  evaluatePaidLongRunGuard,
  parseLongRunV2ProfileArgs,
  preparePaidLongRunProfiles,
  readLongRunV2ProfileConfig,
  rotateLongRunV2Profiles,
} from "./companion-long-run-v2-profiles.js";

const SECRET_VALUES = [
  "deepseek-secret-value",
  "claude-secret-value",
  "grok-secret-value",
  "gpt-secret-value",
  "bigmodel-secret-value",
] as const;

describe("companion long-run v2 profile orchestration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps all five evaluation profiles through readConfig without exposing credentials", () => {
    const environment = completeProfileEnvironment();
    const snapshots = LONG_RUN_V2_PROFILE_ORDER.map((profile) =>
      readLongRunV2ProfileConfig(profile, environment),
    );

    expect(snapshots.map((item) => item.profile)).toEqual([
      "deepseek",
      "claude",
      "grok",
      "gpt56-sol",
      "bigmodel",
    ]);
    expect(snapshots.map((item) => item.requestedModel)).toEqual([
      "deepseek-v4-flash",
      "claude-opus-4-6",
      "grok-4.6",
      "gpt-5.6-sol",
      "glm-5.3-flash",
    ]);
    expect(snapshots.map((item) => item.baseOrigin)).toEqual([
      "https://api.deepseek.test",
      "https://wanzhao.test",
      "https://wanzhao.test",
      "https://wanzhao.test",
      "https://bigmodel.test",
    ]);
    expect(snapshots.map((item) => item.reasoningEffort)).toEqual([
      "max",
      "medium",
      "medium",
      "medium",
      "low",
    ]);
    expect(snapshots.map((item) => item.profileSource)).toEqual([
      "legacy",
      "named",
      "named",
      "named",
      "named",
    ]);
    expect(snapshots.map((item) => item.configuredProfileName)).toEqual([
      null,
      "claude",
      "grok",
      "gpt56-sol",
      "bigmodel",
    ]);
    expect(snapshots.map((item) => item.apiKeyEnvironment)).toEqual([
      "OPENAI_COMPATIBLE_API_KEY",
      "LLM_PROFILE_CLAUDE_API_KEY",
      "LLM_PROFILE_GROK_API_KEY",
      "LLM_PROFILE_GPT56_SOL_API_KEY",
      "LLM_PROFILE_BIGMODEL_API_KEY",
    ]);
    expect(snapshots.every((item) => item.apiKeyPresent)).toBe(true);
    expect(
      snapshots.every((item) => /^[a-f0-9]{64}$/u.test(item.configSha256)),
    ).toBe(true);
    expect(new Set(snapshots.map((item) => item.configSha256))).toHaveLength(5);
    expect(snapshots[1]?.capabilities).toMatchObject({
      structuredOutputMode: "prompt_json",
      reasoningEffort: "medium",
      reasoningRequestFormat: "anthropic_output_config",
    });
    expect(snapshots[4]?.capabilities).toMatchObject({
      structuredOutputMode: "json_object",
      reasoningEffort: "low",
      reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
    });
    expect(
      snapshots.every((item) => item.capabilities.maxOutputTokens === 32_768),
    ).toBe(true);

    const serialized = JSON.stringify(snapshots);
    for (const secret of SECRET_VALUES)
      expect(serialized).not.toContain(secret);
    // URL paths are non-secret compatibility inputs: changing /v1 or the
    // BigModel API prefix must invalidate a Pilot/checkpoint reuse.
    expect(serialized).toContain("/api/paas/v4");
    expect(serialized).toContain("/v1");
  });

  it("keeps the sanitized config hash stable when only a credential value changes", () => {
    const firstEnvironment = completeProfileEnvironment();
    const secondEnvironment = {
      ...firstEnvironment,
      LLM_PROFILE_GROK_API_KEY: "rotated-grok-secret",
    };

    const first = readLongRunV2ProfileConfig("grok", firstEnvironment);
    const second = readLongRunV2ProfileConfig("grok", secondEnvironment);

    expect(first.configSha256).toBe(second.configSha256);
    expect(JSON.stringify([first, second])).not.toContain(
      "rotated-grok-secret",
    );
  });

  it("parses defaults, canonicalizes CSV order, and removes duplicates", () => {
    expect(parseLongRunV2ProfileArgs([])).toEqual({
      profiles: [...LONG_RUN_V2_PROFILE_ORDER],
      runs: 3,
    });
    expect(
      parseLongRunV2ProfileArgs([
        "--profiles",
        "GROK,deepseek,grok,bigmodel",
        "--runs=2",
      ]),
    ).toEqual({
      profiles: ["deepseek", "grok", "bigmodel"],
      runs: 2,
    });
    expect(
      parseLongRunV2ProfileArgs(["--profiles=claude,gpt56-sol", "--runs", "1"]),
    ).toEqual({ profiles: ["claude", "gpt56-sol"], runs: 1 });
  });

  it.each([
    [["--profiles", "unknown"], /Unknown long-run profile/u],
    [["--profiles", "gemini"], /Unknown long-run profile/u],
    [["--profiles", "all,grok"], /cannot be combined/u],
    [["--profiles", "grok,,bigmodel"], /non-empty CSV/u],
    [["--profiles"], /requires a value/u],
    [["--runs", "0"], /integer from 1 through 3/u],
    [["--runs", "4"], /integer from 1 through 3/u],
    [["--runs", "2.5"], /integer from 1 through 3/u],
    [["--runs=1", "--runs=2"], /only once/u],
    [["--unknown", "value"], /Unknown companion long-run argument/u],
  ] as const)("rejects invalid arguments: %j", (argv, message) => {
    expect(() => parseLongRunV2ProfileArgs(argv)).toThrowError(message);
  });

  it("rotates three repetitions across early, middle, and late positions", () => {
    const original = [...LONG_RUN_V2_PROFILE_ORDER];
    const rotations = rotateLongRunV2Profiles(original, 3);

    expect(rotations).toEqual([
      {
        repetition: 1,
        profiles: ["deepseek", "claude", "grok", "gpt56-sol", "bigmodel"],
      },
      {
        repetition: 2,
        profiles: ["claude", "grok", "gpt56-sol", "bigmodel", "deepseek"],
      },
      {
        repetition: 3,
        profiles: ["gpt56-sol", "bigmodel", "deepseek", "claude", "grok"],
      },
    ]);
    for (const profile of LONG_RUN_V2_PROFILE_ORDER) {
      const positions = rotations.map((rotation) =>
        rotation.profiles.indexOf(profile),
      );
      expect(new Set(positions).size).toBe(3);
    }
    expect(original).toEqual(LONG_RUN_V2_PROFILE_ORDER);
  });

  it("constructs case-safe child environments while keeping credentials out of arguments", () => {
    const parent: NodeJS.ProcessEnv = {
      Path: "C:\\tools",
      llm_active_profile: "stale",
      llm_provider: "fixture",
      LLM_API_KEY: "generic-fallback-secret",
      OPENAI_COMPATIBLE_API_KEY: SECRET_VALUES[0],
      LLM_PROFILE_GROK_API_KEY: SECRET_VALUES[2],
    };
    const deepseek = buildLongRunV2ChildEnvironment("deepseek", parent);
    const grok = buildLongRunV2ChildEnvironment("grok", parent);

    expect(caseInsensitiveValue(deepseek, "LLM_PROVIDER")).toBe(
      "openai-compatible",
    );
    expect(
      caseInsensitiveValue(deepseek, "LLM_ACTIVE_PROFILE"),
    ).toBeUndefined();
    expect(deepseek.OPENAI_COMPATIBLE_API_KEY).toBe(SECRET_VALUES[0]);
    expect(caseInsensitiveValue(deepseek, "LLM_API_KEY")).toBeUndefined();
    expect(caseInsensitiveValue(grok, "LLM_ACTIVE_PROFILE")).toBe("grok");
    expect(grok.LLM_PROFILE_GROK_API_KEY).toBe(SECRET_VALUES[2]);
    expect(parent.llm_active_profile).toBe("stale");
    expect(parent.llm_provider).toBe("fixture");
    expect(apiKeyEnvironmentForProfile("gpt56-sol")).toBe(
      "LLM_PROFILE_GPT56_SOL_API_KEY",
    );

    const commandArguments = [
      "companion-long-run-v2-child.ts",
      "--profile",
      "grok",
    ];
    expect(JSON.stringify(commandArguments)).not.toContain(SECRET_VALUES[2]);
  });

  it("recognizes only the explicit paid guard and skips before reading config", () => {
    expect(evaluatePaidLongRunGuard({ RUN_PAID_LONGRUN: "1" })).toEqual({
      status: "READY",
    });
    expect(
      evaluatePaidLongRunGuard({ RUN_PAID_LONGRUN: "true" }),
    ).toMatchObject({ status: "SKIPPED" });
    expect(evaluatePaidLongRunGuard({})).toMatchObject({ status: "SKIPPED" });

    const reader = vi.fn(readConfig);
    const result = preparePaidLongRunProfiles(
      ["--profiles", "all", "--runs", "3"],
      completeProfileEnvironment(),
      reader,
    );
    expect(result.status).toBe("SKIPPED");
    if (result.status !== "SKIPPED") throw new Error("Expected skipped plan");
    expect(result.reason).toContain("RUN_PAID_LONGRUN=1");
    expect(reader).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result);
    for (const secret of SECRET_VALUES)
      expect(serialized).not.toContain(secret);
  });

  it("resolves ready profile snapshots sequentially and returns the run rotations", () => {
    const environment = {
      ...completeProfileEnvironment(),
      RUN_PAID_LONGRUN: "1",
    };
    const observedProfiles: Array<string | undefined> = [];
    const reader = vi.fn(() => {
      observedProfiles.push(process.env.LLM_ACTIVE_PROFILE);
      return readConfig();
    });

    const result = preparePaidLongRunProfiles(
      ["--profiles", "all", "--runs", "3"],
      environment,
      reader,
    );

    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Expected ready plan");
    expect(reader).toHaveBeenCalledTimes(5);
    expect(observedProfiles).toEqual([
      undefined,
      "claude",
      "grok",
      "gpt56-sol",
      "bigmodel",
    ]);
    expect(result.profileConfigs.map((item) => item.profile)).toEqual(
      LONG_RUN_V2_PROFILE_ORDER,
    );
    expect(result.rotations).toHaveLength(3);
    const serialized = JSON.stringify(result);
    for (const secret of SECRET_VALUES)
      expect(serialized).not.toContain(secret);
  });

  it("rejects all selected profiles before paid work when any API key is missing", () => {
    const environment = completeProfileEnvironment();
    delete environment.LLM_PROFILE_GROK_API_KEY;
    const snapshots = LONG_RUN_V2_PROFILE_ORDER.map((profile) =>
      readLongRunV2ProfileConfig(profile, environment),
    );

    expect(() => assertLongRunV2ProfileConfigsReady(snapshots)).toThrow(
      /grok \(LLM_PROFILE_GROK_API_KEY\)/u,
    );
    expect(() =>
      assertLongRunV2ProfileConfigsReady(
        snapshots.filter((profile) => profile.profile !== "grok"),
      ),
    ).not.toThrow();
    const serialized = JSON.stringify(snapshots);
    for (const secret of SECRET_VALUES)
      expect(serialized).not.toContain(secret);
  });
});

function completeProfileEnvironment(): NodeJS.ProcessEnv {
  return {
    LLM_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: "https://api.deepseek.test/v1",
    OPENAI_COMPATIBLE_API_KEY: SECRET_VALUES[0],
    OPENAI_COMPATIBLE_MODEL: "deepseek-v4-flash",
    OPENAI_COMPATIBLE_REASONING_EFFORT: "max",
    OPENAI_COMPATIBLE_REASONING_FORMAT: "openai_reasoning_effort_with_thinking",
    OPENAI_COMPATIBLE_SUPPORTS_THINKING_CONTROL: "false",
    OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS: "131072",
    OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS: "32768",
    LLM_PROFILE_CLAUDE_BASE_URL: "https://wanzhao.test/v1",
    LLM_PROFILE_CLAUDE_API_KEY: SECRET_VALUES[1],
    LLM_PROFILE_CLAUDE_MODEL: "claude-opus-4-6",
    LLM_PROFILE_CLAUDE_STRUCTURED_OUTPUT_MODE: "prompt_json",
    LLM_PROFILE_CLAUDE_REASONING_EFFORT: "medium",
    LLM_PROFILE_CLAUDE_REASONING_FORMAT: "anthropic_output_config",
    LLM_PROFILE_CLAUDE_SUPPORTS_THINKING_CONTROL: "false",
    LLM_PROFILE_CLAUDE_MAX_CONTEXT_TOKENS: "1000000",
    LLM_PROFILE_CLAUDE_MAX_OUTPUT_TOKENS: "32768",
    LLM_PROFILE_GROK_BASE_URL: "https://wanzhao.test/v1",
    LLM_PROFILE_GROK_API_KEY: SECRET_VALUES[2],
    LLM_PROFILE_GROK_MODEL: "grok-4.6",
    LLM_PROFILE_GROK_REASONING_EFFORT: "medium",
    LLM_PROFILE_GROK_REASONING_FORMAT: "openai_reasoning_effort",
    LLM_PROFILE_GROK_MAX_CONTEXT_TOKENS: "500000",
    LLM_PROFILE_GROK_MAX_OUTPUT_TOKENS: "32768",
    LLM_PROFILE_GPT56_SOL_BASE_URL: "https://wanzhao.test/v1",
    LLM_PROFILE_GPT56_SOL_API_KEY: SECRET_VALUES[3],
    LLM_PROFILE_GPT56_SOL_MODEL: "gpt-5.6-sol",
    LLM_PROFILE_GPT56_SOL_REASONING_EFFORT: "medium",
    LLM_PROFILE_GPT56_SOL_REASONING_FORMAT: "openai_reasoning_effort",
    LLM_PROFILE_GPT56_SOL_MAX_CONTEXT_TOKENS: "1050000",
    LLM_PROFILE_GPT56_SOL_MAX_OUTPUT_TOKENS: "32768",
    LLM_PROFILE_BIGMODEL_BASE_URL: "https://bigmodel.test/api/paas/v4",
    LLM_PROFILE_BIGMODEL_API_KEY: SECRET_VALUES[4],
    LLM_PROFILE_BIGMODEL_MODEL: "glm-5.3-flash",
    LLM_PROFILE_BIGMODEL_REASONING_EFFORT: "low",
    LLM_PROFILE_BIGMODEL_REASONING_FORMAT:
      "openai_reasoning_effort_with_thinking",
    LLM_PROFILE_BIGMODEL_SUPPORTS_THINKING_CONTROL: "false",
    LLM_PROFILE_BIGMODEL_MAX_CONTEXT_TOKENS: "1000000",
    LLM_PROFILE_BIGMODEL_MAX_OUTPUT_TOKENS: "32768",
  };
}

function caseInsensitiveValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const matched = Object.entries(environment).find(
    ([key]) => key.toUpperCase() === name,
  );
  return matched?.[1];
}
