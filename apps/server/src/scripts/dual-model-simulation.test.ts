import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiCompatibleLlmProvider } from "@personasim/providers";
import type * as ProvidersModule from "@personasim/providers";

import {
  readConfig,
  readLlmProfileConfig,
  type ServerConfig,
} from "../config.js";
import { runDualModelSimulation } from "./dual-model-simulation-runner.js";
import {
  assertPaidDualModelEnabled,
  dualModelSimulationMain,
  parseDualModelCliArgs,
} from "./dual-model-simulation.js";

vi.mock("../config.js", () => ({
  readConfig: vi.fn(),
  readLlmProfileConfig: vi.fn(),
}));

vi.mock("./dual-model-simulation-runner.js", () => ({
  runDualModelSimulation: vi.fn(),
}));

vi.mock("@personasim/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof ProvidersModule>()),
  createOpenAiCompatibleLlmProvider: vi.fn(),
}));

describe("dual-model simulation CLI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it.each(["fixture", "run"])(
    "defaults %s to Qwen as the user and BigModel as the character",
    (command) => {
      const options = parseDualModelCliArgs([command]);

      expect(options).toMatchObject({
        command,
        userProfile: "qwen",
        characterProfile: "bigmodel",
        turns: 6,
        stepMinutes: 30,
      });
      expect(options.runId).toMatch(
        new RegExp(`^${command}-[a-zA-Z0-9._-]+$`, "u"),
      );
      expect(options.runId.length).toBeLessThanOrEqual(120);
    },
  );

  it("accepts independent normalized profiles, explicit input files and both flag styles", () => {
    expect(
      parseDualModelCliArgs([
        "run",
        "--",
        "--user-profile= Qwen ",
        "--character-profile",
        "Claude-Sonnet",
        "--turns=20",
        "--step-minutes",
        "1440",
        "--run-id",
        "qwen-claude.review_1",
        "--user-persona-file",
        "test fixtures/user persona.txt",
        "--scenario-file=scenarios/reunion.txt",
      ]),
    ).toEqual({
      command: "run",
      userProfile: "qwen",
      characterProfile: "claude-sonnet",
      turns: 20,
      stepMinutes: 1_440,
      runId: "qwen-claude.review_1",
      userPersonaFile: "test fixtures/user persona.txt",
      scenarioFile: "scenarios/reunion.txt",
    });
  });

  it("allows a one-turn simulation with a one-minute step", () => {
    expect(
      parseDualModelCliArgs(["fixture", "--turns", "1", "--step-minutes", "1"]),
    ).toMatchObject({ turns: 1, stepMinutes: 1 });
  });

  it.each([
    ["turns", "0"],
    ["turns", "21"],
    ["turns", "1.5"],
    ["step-minutes", "0"],
    ["step-minutes", "1441"],
    ["step-minutes", "-1"],
    ["step-minutes", "Infinity"],
  ])("rejects an invalid --%s value %s", (flag, value) => {
    expect(() => parseDualModelCliArgs(["run", `--${flag}`, value])).toThrow(
      /must be an integer/u,
    );
  });

  it.each(["../outside", "nested/run", "nested\\run", ".", "a".repeat(121)])(
    "rejects an unsafe run directory ID %s",
    (runId) => {
      expect(() =>
        parseDualModelCliArgs(["fixture", "--run-id", runId]),
      ).toThrow(/Run ID/u);
    },
  );

  it.each([
    [],
    ["unknown"],
    ["run", "--unknown=value"],
    ["run", "--turns"],
    ["run", "--turns", "--step-minutes", "30"],
    ["run", "--user-profile", "invalid profile"],
  ])("rejects malformed arguments %j", (...args) => {
    expect(() => parseDualModelCliArgs(args)).toThrow();
  });

  it("rejects repeated flags instead of silently changing the selected model", () => {
    expect(() =>
      parseDualModelCliArgs([
        "run",
        "--user-profile=qwen",
        "--user-profile",
        "claude",
      ]),
    ).toThrow(/--user-profile may be specified only once/u);
  });

  it("requires the explicit paid-run opt-in", () => {
    for (const value of [undefined, "", "0", "true"]) {
      expect(() =>
        assertPaidDualModelEnabled({ RUN_PAID_DUAL_MODEL: value }),
      ).toThrow(/RUN_PAID_DUAL_MODEL=1/u);
    }
    expect(() =>
      assertPaidDualModelEnabled({ RUN_PAID_DUAL_MODEL: "1" }),
    ).not.toThrow();
  });

  it("rejects a paid run before reading input files, credentials or creating providers", async () => {
    vi.stubEnv("RUN_PAID_DUAL_MODEL", undefined);

    await expect(
      dualModelSimulationMain([
        "run",
        "--user-persona-file",
        "does-not-exist.txt",
      ]),
    ).rejects.toThrow(/RUN_PAID_DUAL_MODEL=1/u);

    expect(readConfig).not.toHaveBeenCalled();
    expect(readLlmProfileConfig).not.toHaveBeenCalled();
    expect(createOpenAiCompatibleLlmProvider).not.toHaveBeenCalled();
    expect(runDualModelSimulation).not.toHaveBeenCalled();
  });

  it.each(["qwen", "bigmodel"])(
    "rejects a missing %s credential before constructing either live provider",
    async (missingProfile) => {
      vi.stubEnv("RUN_PAID_DUAL_MODEL", "1");
      vi.mocked(readLlmProfileConfig).mockImplementation((profileName) => {
        const config: ServerConfig["llm"] = {
          provider: "openai-compatible",
          profileName,
          baseUrl: "https://example.invalid/v1",
          model: `${profileName}-test-model`,
          timeoutMs: 5_000,
          maxRetries: 0,
          ...(profileName === missingProfile
            ? {}
            : { apiKey: `test-${profileName}-key` }),
        };
        return config;
      });

      await expect(dualModelSimulationMain(["run"])).rejects.toThrow(
        `LLM_PROFILE_${missingProfile.toUpperCase()}_API_KEY is not configured.`,
      );

      expect(readLlmProfileConfig).toHaveBeenCalledWith("qwen");
      expect(readLlmProfileConfig).toHaveBeenCalledWith("bigmodel");
      expect(createOpenAiCompatibleLlmProvider).not.toHaveBeenCalled();
      expect(runDualModelSimulation).not.toHaveBeenCalled();
    },
  );

  it("dispatches the selected user and character models to their separate roles", async () => {
    vi.stubEnv("RUN_PAID_DUAL_MODEL", "1");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const userConfig: ServerConfig["llm"] = {
      provider: "openai-compatible",
      profileName: "speaker-a",
      baseUrl: "https://speaker-a.invalid/v1",
      apiKey: "test-speaker-a-key",
      model: "speaker-a-model",
      timeoutMs: 10_000,
      maxRetries: 1,
    };
    const characterConfig: ServerConfig["llm"] = {
      ...userConfig,
      profileName: "speaker-b",
      baseUrl: "https://speaker-b.invalid/v1",
      apiKey: "test-speaker-b-key",
      model: "speaker-b-model",
    };
    vi.mocked(readLlmProfileConfig).mockImplementation((profileName) => {
      if (profileName === "speaker-a") return userConfig;
      if (profileName === "speaker-b") return characterConfig;
      throw new Error(`Unexpected profile ${profileName}`);
    });
    vi.mocked(readConfig, { partial: true }).mockReturnValue({
      profile: "existing-server-profile",
      databasePath: "existing-server.sqlite",
      llm: { ...userConfig, model: "active-server-model" },
    });
    const userProvider = { model: userConfig.model };
    vi.mocked(createOpenAiCompatibleLlmProvider, {
      partial: true,
    }).mockReturnValue(userProvider);
    const runDirectory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../tmp/dual-model-simulation/role-routing-test",
    );
    vi.mocked(runDualModelSimulation).mockResolvedValue({
      status: "completed",
      runDirectory,
      databasePath: resolve(runDirectory, "personasim.sqlite"),
      completedTurns: 4,
      requestedTurns: 4,
    });

    await dualModelSimulationMain([
      "run",
      "--user-profile",
      "speaker-a",
      "--character-profile",
      "speaker-b",
      "--turns",
      "4",
      "--step-minutes",
      "90",
      "--run-id",
      "role-routing-test",
    ]);

    expect(createOpenAiCompatibleLlmProvider).toHaveBeenCalledTimes(1);
    const providerOptions = vi.mocked(createOpenAiCompatibleLlmProvider).mock
      .calls[0]?.[0];
    expect(providerOptions).toMatchObject(userConfig);
    expect(providerOptions?.onMetric).toBeTypeOf("function");
    expect(runDualModelSimulation).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(runDualModelSimulation).mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      serverConfig: {
        profile: "existing-server-profile",
        databasePath: "existing-server.sqlite",
        llm: characterConfig,
      },
      userProfileName: "speaker-a",
      runDirectory,
      turns: 4,
      stepMinutes: 90,
      explicitSecrets: ["test-speaker-a-key", "test-speaker-b-key"],
    });
    expect(dispatched?.userProvider).toBe(userProvider);
    expect(dispatched?.serverConfig.llm).toBe(characterConfig);
  });
});
