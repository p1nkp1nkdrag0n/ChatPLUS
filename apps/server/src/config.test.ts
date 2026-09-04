import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readConfig } from "./config.js";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const llmProfileEnvironmentFields = [
  "BASE_URL",
  "API_KEY",
  "MODEL",
  "TIMEOUT_MS",
  "MAX_RETRIES",
  "STRUCTURED_OUTPUT_MODE",
  "REASONING_EFFORT",
  "REASONING_FORMAT",
  "SUPPORTS_THINKING_CONTROL",
  "SUPPORTS_STREAMING",
  "MAX_CONTEXT_TOKENS",
  "MAX_OUTPUT_TOKENS",
] as const;

const correspondenceEnvironmentFields = [
  "CORRESPONDENCE_MODE",
  "CORRESPONDENCE_EXECUTION",
  "CORRESPONDENCE_TRANSIT_POLICY",
  "CORRESPONDENCE_GENERATION_LEASE_MS",
  "CORRESPONDENCE_MAX_OPEN_THREADS",
  "KEEPSAKE_MODE",
  "ASSET_STORAGE_PATH",
  "INSTANCE_SECRET",
  "SELFHOSTED_REVERSE_PROXY",
  "SERVE_WEB",
  "WEB_DIST_PATH",
] as const;

function clearLlmProfileEnvironment(profilePrefix: string): void {
  for (const field of llmProfileEnvironmentFields) {
    vi.stubEnv(`LLM_PROFILE_${profilePrefix}_${field}`, undefined);
  }
}

function clearCorrespondenceEnvironment(): void {
  for (const field of correspondenceEnvironmentFields) {
    vi.stubEnv(field, undefined);
  }
}

describe("server configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the canonical conversation retention defaults", () => {
    expect(readConfig().conversationRetention).toEqual({
      fullVerbatimHours: 24,
      softTokenLimit: 8_000,
      hardTokenLimit: 12_000,
      minimumTailTokens: 3_000,
      minimumRecentTurns: 12,
    });
  });

  it("keeps correspondence and keepsakes disabled with safe first-version defaults", () => {
    clearCorrespondenceEnvironment();

    expect(readConfig()).toMatchObject({
      correspondenceMode: "off",
      correspondenceExecution: "lazy",
      correspondenceTransitPolicy: "fixed_5d_v1",
      correspondenceGenerationLeaseMs: 1_800_000,
      correspondenceMaxOpenThreads: 1,
      keepsakeMode: "off",
      assetStoragePath: resolve(workspaceRoot, "data/assets"),
    });
    expect(readConfig().instanceSecret).toBeUndefined();
  });

  it.each(["off", "shadow", "enforced"] as const)(
    "accepts correspondence rollout mode %s",
    (mode) => {
      vi.stubEnv("CORRESPONDENCE_MODE", mode);

      expect(readConfig().correspondenceMode).toBe(mode);
    },
  );

  it.each(["lazy", "resident", "worker"] as const)(
    "accepts correspondence execution driver %s",
    (execution) => {
      vi.stubEnv("CORRESPONDENCE_EXECUTION", execution);

      expect(readConfig().correspondenceExecution).toBe(execution);
    },
  );

  it.each(["off", "shadow", "enforced"] as const)(
    "accepts keepsake rollout mode %s",
    (mode) => {
      vi.stubEnv("KEEPSAKE_MODE", mode);

      expect(readConfig().keepsakeMode).toBe(mode);
    },
  );

  it("parses explicit correspondence and keepsake settings", () => {
    vi.stubEnv("CORRESPONDENCE_MODE", "enforced");
    vi.stubEnv("CORRESPONDENCE_EXECUTION", "resident");
    vi.stubEnv("CORRESPONDENCE_TRANSIT_POLICY", "fixed_5d_v1");
    vi.stubEnv("CORRESPONDENCE_GENERATION_LEASE_MS", "900000");
    vi.stubEnv("CORRESPONDENCE_MAX_OPEN_THREADS", "1");
    vi.stubEnv("KEEPSAKE_MODE", "shadow");
    vi.stubEnv("ASSET_STORAGE_PATH", "./var/keepsakes");
    vi.stubEnv("INSTANCE_SECRET", "  test-instance-secret  ");

    expect(readConfig()).toMatchObject({
      correspondenceMode: "enforced",
      correspondenceExecution: "resident",
      correspondenceTransitPolicy: "fixed_5d_v1",
      correspondenceGenerationLeaseMs: 900_000,
      correspondenceMaxOpenThreads: 1,
      keepsakeMode: "shadow",
      assetStoragePath: resolve(workspaceRoot, "var/keepsakes"),
      instanceSecret: "test-instance-secret",
    });
  });

  it("treats a blank instance secret as absent during Stage 0", () => {
    vi.stubEnv("INSTANCE_SECRET", "   ");

    expect(readConfig().instanceSecret).toBeUndefined();
  });

  it.each([
    ["CORRESPONDENCE_MODE", "enabled"],
    ["CORRESPONDENCE_EXECUTION", "cron"],
    ["CORRESPONDENCE_TRANSIT_POLICY", "fixed_3d_v1"],
    ["CORRESPONDENCE_GENERATION_LEASE_MS", "0"],
    ["CORRESPONDENCE_MAX_OPEN_THREADS", "2"],
    ["KEEPSAKE_MODE", "enabled"],
    ["ASSET_STORAGE_PATH", "   "],
  ])("rejects invalid correspondence setting %s=%s", (name, value) => {
    vi.stubEnv(name, value);

    expect(() => readConfig()).toThrow();
  });

  it("uses fuzzy life and promoted continuity defaults in every environment", () => {
    const names = [
      "LIFE_PLANNING_MODE",
      "SCHEDULE_NEGOTIATION_MODE",
      "SELF_INITIATED_PLANNING",
      "MEMORY_RECALL_MODE",
      "AUTOBIOGRAPHY_MODE",
    ] as const;
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      for (const nodeEnv of ["development", "test"] as const) {
        expect(readConfig({ nodeEnv })).toMatchObject({
          lifePlanningMode: "fuzzy",
          scheduleNegotiationMode: "off",
          selfInitiatedPlanningMode: "off",
          memoryRecallMode: "enforced",
          autobiographyMode: "enforced",
        });
      }
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("uses fuzzy life and disables the exact personal-life planner by default", () => {
    const previousPlanning = process.env["SELF_INITIATED_PLANNING"];
    const previousWorldEffects = process.env["LIVE_WORLD_EFFECTS"];
    const previousLifeMode = process.env["LIFE_PLANNING_MODE"];
    delete process.env["SELF_INITIATED_PLANNING"];
    delete process.env["LIVE_WORLD_EFFECTS"];
    delete process.env["LIFE_PLANNING_MODE"];
    try {
      const config = readConfig({ nodeEnv: "development" });
      expect(config.lifePlanningMode).toBe("fuzzy");
      expect(config.selfInitiatedPlanningMode).toBe("off");
      expect(config.liveWorldEffectsMode).toBe("enforced");
    } finally {
      if (previousPlanning === undefined)
        delete process.env["SELF_INITIATED_PLANNING"];
      else process.env["SELF_INITIATED_PLANNING"] = previousPlanning;
      if (previousWorldEffects === undefined)
        delete process.env["LIVE_WORLD_EFFECTS"];
      else process.env["LIVE_WORLD_EFFECTS"] = previousWorldEffects;
      if (previousLifeMode === undefined)
        delete process.env["LIFE_PLANNING_MODE"];
      else process.env["LIFE_PLANNING_MODE"] = previousLifeMode;
    }
  });

  it("allows legacy exact-schedule overrides only in legacy_exact mode", () => {
    const previousPlanning = process.env["SELF_INITIATED_PLANNING"];
    const previousWorldEffects = process.env["LIVE_WORLD_EFFECTS"];
    const previousLifeMode = process.env["LIFE_PLANNING_MODE"];
    const previousNegotiation = process.env["SCHEDULE_NEGOTIATION_MODE"];
    process.env["LIFE_PLANNING_MODE"] = "legacy_exact";
    process.env["SCHEDULE_NEGOTIATION_MODE"] = "shadow";
    process.env["SELF_INITIATED_PLANNING"] = "shadow";
    process.env["LIVE_WORLD_EFFECTS"] = "off";
    try {
      const config = readConfig();
      expect(config.lifePlanningMode).toBe("legacy_exact");
      expect(config.scheduleNegotiationMode).toBe("shadow");
      expect(config.selfInitiatedPlanningMode).toBe("shadow");
      expect(config.liveWorldEffectsMode).toBe("off");
    } finally {
      if (previousPlanning === undefined)
        delete process.env["SELF_INITIATED_PLANNING"];
      else process.env["SELF_INITIATED_PLANNING"] = previousPlanning;
      if (previousWorldEffects === undefined)
        delete process.env["LIVE_WORLD_EFFECTS"];
      else process.env["LIVE_WORLD_EFFECTS"] = previousWorldEffects;
      if (previousLifeMode === undefined)
        delete process.env["LIFE_PLANNING_MODE"];
      else process.env["LIFE_PLANNING_MODE"] = previousLifeMode;
      if (previousNegotiation === undefined)
        delete process.env["SCHEDULE_NEGOTIATION_MODE"];
      else process.env["SCHEDULE_NEGOTIATION_MODE"] = previousNegotiation;
    }
  });

  it("normalizes contradictory exact-schedule flags out of fuzzy mode", () => {
    expect(
      readConfig({
        lifePlanningMode: "fuzzy",
        scheduleNegotiationMode: "enforced",
        selfInitiatedPlanningMode: "enforced",
      }),
    ).toMatchObject({
      lifePlanningMode: "fuzzy",
      scheduleNegotiationMode: "off",
      selfInitiatedPlanningMode: "off",
    });
  });

  it("rejects an invalid conversation retention boundary", () => {
    expect(() =>
      readConfig({
        conversationRetention: {
          fullVerbatimHours: 24,
          softTokenLimit: 12_000,
          hardTokenLimit: 8_000,
          minimumTailTokens: 3_000,
          minimumRecentTurns: 12,
        },
      }),
    ).toThrowError(/softTokenLimit/u);
  });

  it("selects and normalizes a named LLM profile", () => {
    clearLlmProfileEnvironment("CLAUDE_SONNET");
    vi.stubEnv("LLM_ACTIVE_PROFILE", " Claude-Sonnet ");
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv(
      "LLM_PROFILE_CLAUDE_SONNET_BASE_URL",
      "https://sub.wanzhao.top/v1/",
    );
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_API_KEY", "test-profile-key");
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_MODEL", "claude-sonnet-5");
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_TIMEOUT_MS", "150000");
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_MAX_RETRIES", "2");
    vi.stubEnv(
      "LLM_PROFILE_CLAUDE_SONNET_STRUCTURED_OUTPUT_MODE",
      "prompt_json",
    );
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_REASONING_EFFORT", "medium");
    vi.stubEnv(
      "LLM_PROFILE_CLAUDE_SONNET_REASONING_FORMAT",
      "anthropic_output_config",
    );
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_SUPPORTS_THINKING_CONTROL", "false");
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_SUPPORTS_STREAMING", "true");
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_MAX_CONTEXT_TOKENS", "200000");
    vi.stubEnv("LLM_PROFILE_CLAUDE_SONNET_MAX_OUTPUT_TOKENS", "16000");

    expect(readConfig().llm).toEqual({
      provider: "openai-compatible",
      profileName: "claude-sonnet",
      baseUrl: "https://sub.wanzhao.top/v1",
      apiKey: "test-profile-key",
      model: "claude-sonnet-5",
      timeoutMs: 150_000,
      maxRetries: 2,
      maxOutputTokens: 16_000,
      capabilities: {
        structuredOutputMode: "prompt_json",
        supportsThinkingControl: false,
        supportsStreaming: true,
        reasoningEffort: "medium",
        reasoningRequestFormat: "anthropic_output_config",
        maxContextTokens: 200_000,
        maxOutputTokens: 16_000,
      },
    });
  });

  it("uses independent defaults for an active profile", () => {
    clearLlmProfileEnvironment("BIGMODEL");
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("LLM_ACTIVE_PROFILE", "bigmodel");
    vi.stubEnv(
      "LLM_PROFILE_BIGMODEL_BASE_URL",
      "https://open.bigmodel.cn/api/paas/v4",
    );
    vi.stubEnv("LLM_PROFILE_BIGMODEL_MODEL", "glm-5.3-flash");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "must-not-leak");
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "must-not-leak");
    vi.stubEnv("OPENAI_COMPATIBLE_TIMEOUT_MS", "999");

    const config = readConfig();

    expect(config.llm.profileName).toBe("bigmodel");
    expect(config.llm.apiKey).toBeUndefined();
    expect(config.llm.model).toBe("glm-5.3-flash");
    expect(config.llm.timeoutMs).toBe(120_000);
    expect(config.llm.maxRetries).toBe(1);
    expect(config.llm.capabilities).toEqual({
      structuredOutputMode: "json_object",
      supportsThinkingControl: false,
      supportsStreaming: false,
      maxOutputTokens: 8_192,
    });
  });

  it("rejects a reasoning effort without a matching request format", () => {
    clearLlmProfileEnvironment("GROK");
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("LLM_ACTIVE_PROFILE", "grok");
    vi.stubEnv("LLM_PROFILE_GROK_BASE_URL", "https://sub.wanzhao.top/v1");
    vi.stubEnv("LLM_PROFILE_GROK_MODEL", "grok-4.6");
    vi.stubEnv("LLM_PROFILE_GROK_REASONING_EFFORT", "medium");

    expect(() => readConfig()).toThrowError(/reasoningRequestFormat/u);
  });

  it("keeps the legacy OpenAI-compatible environment when no profile is selected", () => {
    vi.stubEnv("LLM_ACTIVE_PROFILE", "");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "http://localhost:4321/v1/");
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "test-legacy-key");
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", "legacy-model");
    vi.stubEnv("OPENAI_COMPATIBLE_TIMEOUT_MS", "4567");
    vi.stubEnv("OPENAI_COMPATIBLE_MAX_RETRIES", "0");
    vi.stubEnv("OPENAI_COMPATIBLE_REASONING_EFFORT", "low");
    vi.stubEnv(
      "OPENAI_COMPATIBLE_REASONING_FORMAT",
      "openai_reasoning_effort_with_thinking",
    );
    vi.stubEnv("OPENAI_COMPATIBLE_SUPPORTS_THINKING_CONTROL", "false");

    const config = readConfig();

    expect(config.llm.profileName).toBeUndefined();
    expect(config.llm.baseUrl).toBe("http://localhost:4321/v1");
    expect(config.llm.apiKey).toBe("test-legacy-key");
    expect(config.llm.model).toBe("legacy-model");
    expect(config.llm.timeoutMs).toBe(4_567);
    expect(config.llm.maxRetries).toBe(0);
    expect(config.llm.capabilities).toMatchObject({
      reasoningEffort: "low",
      reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
      supportsThinkingControl: false,
    });
  });

  it("retains the legacy LLM_* aliases", () => {
    vi.stubEnv("LLM_ACTIVE_PROFILE", "");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", undefined);
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", undefined);
    vi.stubEnv("OPENAI_COMPATIBLE_MODEL", undefined);
    vi.stubEnv("OPENAI_COMPATIBLE_TIMEOUT_MS", undefined);
    vi.stubEnv("OPENAI_COMPATIBLE_MAX_RETRIES", undefined);
    vi.stubEnv("LLM_BASE_URL", "http://localhost:9876/v1");
    vi.stubEnv("LLM_API_KEY", "test-alias-key");
    vi.stubEnv("LLM_MODEL", "alias-model");
    vi.stubEnv("LLM_TIMEOUT_MS", "7654");
    vi.stubEnv("LLM_MAX_RETRIES", "3");

    const config = readConfig();

    expect(config.llm.baseUrl).toBe("http://localhost:9876/v1");
    expect(config.llm.apiKey).toBe("test-alias-key");
    expect(config.llm.model).toBe("alias-model");
    expect(config.llm.timeoutMs).toBe(7_654);
    expect(config.llm.maxRetries).toBe(3);
  });

  it("rejects invalid active profile names", () => {
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("LLM_ACTIVE_PROFILE", "claude sonnet");

    expect(() => readConfig()).toThrowError(/LLM_ACTIVE_PROFILE/u);
  });

  it("rejects an active live profile while the fixture provider is selected", () => {
    vi.stubEnv("LLM_PROVIDER", "fixture");
    vi.stubEnv("LLM_ACTIVE_PROFILE", "claude");

    expect(() => readConfig()).toThrowError(
      /LLM_ACTIVE_PROFILE requires LLM_PROVIDER=openai-compatible/u,
    );
  });

  it.each([
    "not-a-url",
    "http://api.example.com/v1",
    "https://user:password@api.example.com/v1",
    "https://api.example.com/v1?tenant=test",
    "https://api.example.com/v1#models",
  ])("rejects an unsafe profile URL: %s", (baseUrl) => {
    clearLlmProfileEnvironment("UNSAFE");
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("LLM_ACTIVE_PROFILE", "unsafe");
    vi.stubEnv("LLM_PROFILE_UNSAFE_BASE_URL", baseUrl);
    vi.stubEnv("LLM_PROFILE_UNSAFE_MODEL", "test-model");

    expect(() => readConfig()).toThrowError(/LLM profile BASE_URL/u);
  });

  it("allows an HTTP localhost URL supplied as a test override", () => {
    clearLlmProfileEnvironment("SAFE");
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("LLM_ACTIVE_PROFILE", "safe");
    vi.stubEnv("LLM_PROFILE_SAFE_BASE_URL", "https://api.example.com/v1");
    vi.stubEnv("LLM_PROFILE_SAFE_MODEL", "live-model");

    const config = readConfig({
      llm: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:4567/v1",
        model: "test-model",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    });

    expect(config.llm.baseUrl).toBe("http://127.0.0.1:4567/v1");
  });

  it.each(["0.0.0.0", "192.168.1.20", "example.com"])(
    "rejects a non-loopback server host for the unauthenticated local Demo: %s",
    (host) => {
      expect(() => readConfig({ host })).toThrowError(
        /HOST must be a loopback address/u,
      );
    },
  );

  it.each([
    "https://example.com",
    "http://192.168.1.20:5173",
    "not-an-origin",
    "http://localhost:5173,https://example.com",
  ])(
    "rejects a non-loopback browser origin for the unauthenticated local Demo: %s",
    (webOrigin) => {
      expect(() => readConfig({ webOrigin })).toThrowError(
        /WEB_ORIGIN must contain only loopback origins/u,
      );
    },
  );

  it("accepts explicit IPv4 and IPv6 loopback configuration", () => {
    expect(
      readConfig({
        host: "::1",
        webOrigin: "http://127.0.0.2:5173, https://[::1]:5173",
      }),
    ).toMatchObject({
      host: "::1",
      webOrigin: "http://127.0.0.2:5173, https://[::1]:5173",
    });
  });

  it("allows a production-only wildcard bind behind the explicit HTTPS reverse-proxy boundary", () => {
    expect(
      readConfig({
        nodeEnv: "production",
        host: "0.0.0.0",
        webOrigin: "https://friend.example.com",
        selfHostedReverseProxy: true,
        serveWeb: true,
        webDistPath: "C:/chatplus/web-dist",
      }),
    ).toMatchObject({
      selfHostedReverseProxy: true,
      serveWeb: true,
      webDistPath: "C:/chatplus/web-dist",
    });
  });

  it.each([
    {
      nodeEnv: "development" as const,
      host: "0.0.0.0",
      webOrigin: "https://friend.example.com",
    },
    {
      nodeEnv: "production" as const,
      host: "192.168.1.20",
      webOrigin: "https://friend.example.com",
    },
    {
      nodeEnv: "production" as const,
      host: "0.0.0.0",
      webOrigin: "http://friend.example.com",
    },
  ])("rejects an unsafe self-hosted reverse-proxy configuration", (input) => {
    expect(() =>
      readConfig({ ...input, selfHostedReverseProxy: true }),
    ).toThrow();
  });
});
