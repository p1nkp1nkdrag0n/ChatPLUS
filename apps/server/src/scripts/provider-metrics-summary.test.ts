import { describe, expect, it } from "vitest";
import {
  providerCacheUsage,
  providerMetricsReport,
  renderProviderMetricsReport,
  summarizeProviderMetrics,
  type ProfiledLlmCallMetric,
} from "./provider-metrics-summary.js";

function metric(
  fields: Partial<ProfiledLlmCallMetric> = {},
): ProfiledLlmCallMetric {
  return {
    provider: "openai-compatible",
    profile: "qwen",
    model: "qwen-test",
    purpose: "chat_turn",
    attempt: 1,
    latencyMs: 20,
    success: true,
    usageSource: "provider",
    inputTokens: 100,
    outputTokens: 10,
    ...fields,
  };
}

describe("provider cache accounting", () => {
  it("preserves unknown historical cache values and distinct explicit zeroes after JSON round trips", () => {
    const historical = JSON.parse(
      JSON.stringify([metric()]),
    ) as ProfiledLlmCallMetric[];
    const summary = summarizeProviderMetrics(historical);
    expect(summary).toMatchObject({
      logicalCalls: null,
      logicalIdUnknownAttempts: 1,
      input: { tokens: 100 },
      cacheRead: {
        tokens: null,
        knownAttempts: 0,
        unknownAttempts: 1,
        coverage: 0,
      },
      cacheWrite: { tokens: null, knownAttempts: 0, unknownAttempts: 1 },
      cacheReadRate: { value: null, inputTokens: null, includedAttempts: 0 },
    });
    const zero = summarizeProviderMetrics([
      metric({ cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ]);
    expect(zero.cacheRead).toMatchObject({
      tokens: 0,
      knownAttempts: 1,
      unknownAttempts: 0,
    });
    expect(zero.cacheReadRate).toMatchObject({ value: 0, inputTokens: 100 });
    expect(zero.cacheWrite.tokens).toBe(0);
  });

  it("includes failed billed attempts and excludes unknown or estimated input from the rate denominator", () => {
    const summary = summarizeProviderMetrics([
      metric({
        logicalCallId: "call-1",
        success: false,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
      }),
      metric({ logicalCallId: "call-1", attempt: 2, cacheReadTokens: 60 }),
      metric({ inputTokens: 1000 }),
      metric({
        usageSource: "estimated",
        inputTokens: 400,
        cacheReadTokens: 200,
      }),
    ]);
    expect(summary).toMatchObject({
      physicalAttempts: 4,
      successfulAttempts: 3,
      failedAttempts: 1,
      retryAttempts: 1,
      logicalCalls: 1,
      logicalIdKnownAttempts: 2,
      logicalIdUnknownAttempts: 2,
      cacheRead: {
        tokens: 340,
        knownAttempts: 3,
        unknownAttempts: 1,
        coverage: 0.75,
      },
      cacheWrite: { tokens: 20, knownAttempts: 1, unknownAttempts: 3 },
      cacheReadRate: {
        value: 0.7,
        cacheReadTokens: 140,
        inputTokens: 200,
        includedAttempts: 2,
        excludedAttempts: 2,
      },
    });
  });

  it("rejects malformed or mismatched denominators without silently clipping cache data", () => {
    const summary = summarizeProviderMetrics([
      metric({ cacheReadTokens: -1, cacheWriteTokens: Number.NaN }),
      metric({ cacheReadTokens: 1.5, cacheWriteTokens: -1 }),
      metric({ cacheReadTokens: 200, cacheWriteTokens: 10 }),
      metric({ inputTokens: 0, cacheReadTokens: 0 }),
    ]);
    expect(summary.cacheRead).toMatchObject({ tokens: 200, knownAttempts: 2 });
    expect(summary.cacheWrite).toMatchObject({ tokens: 10, knownAttempts: 1 });
    expect(summary.cacheReadRate).toEqual({
      value: null,
      cacheReadTokens: 0,
      inputTokens: 0,
      includedAttempts: 1,
      excludedAttempts: 3,
    });
  });

  it("groups profiles, response models and purposes while preserving exact field sources", () => {
    const source = "usage.prompt_tokens_details.cached_tokens";
    const report = providerMetricsReport([
      metric({
        logicalCallId: "call-1",
        responseModel: "actual-model",
        cacheReadTokens: 60,
        cacheReadSource: source,
      }),
      metric({
        profile: "bigmodel",
        logicalCallId: "call-2",
        purpose: "memory_update",
      }),
      metric({
        profile: undefined,
        logicalCallId: "call-3",
        cacheWriteTokens: 5,
        cacheWriteSource:
          "usage.prompt_tokens_details.cache_creation_input_tokens",
      }),
    ]);
    expect(report.groups).toHaveLength(3);
    expect(report.groups[0]).toMatchObject({
      profile: "qwen",
      responseModel: "actual-model",
      purpose: "chat_turn",
      cacheRead: { sources: [source] },
    });
    expect(report.groups[2]).toMatchObject({
      profile: null,
      cacheWrite: { tokens: 5 },
    });
    expect(report.total.logicalCalls).toBe(3);
    expect(renderProviderMetricsReport(report)).toContain("60.00% / 100");
    expect(renderProviderMetricsReport(report)).toContain(
      "unknown does not mean zero",
    );
    expect(providerCacheUsage(metric())).toEqual({});
    expect(
      providerCacheUsage(
        metric({ cacheReadTokens: 0, cacheReadSource: source }),
      ),
    ).toEqual({ cacheReadTokens: 0, cacheReadSource: source });
  });
});
