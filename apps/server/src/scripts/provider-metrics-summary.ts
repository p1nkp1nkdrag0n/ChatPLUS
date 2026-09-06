import type { LlmCallMetric } from "@personasim/providers";

/** Profile is runner metadata; it must never be guessed from a model name. */
export type ProfiledLlmCallMetric = LlmCallMetric & {
  profile?: string | undefined;
  /** Exact provider input retained when an observer estimates missing output. */
  providerInputTokens?: number;
};

/** Observer trace IDs are local to a runtime, not globally unique provider calls. */
export function providerAccountingMetric(
  attempt: ProfiledLlmCallMetric & { providerLogicalCallId?: string },
): ProfiledLlmCallMetric {
  const { providerLogicalCallId } = attempt;
  const metric = { ...attempt };
  delete metric.logicalCallId;
  delete metric.providerLogicalCallId;
  return {
    ...metric,
    ...(providerLogicalCallId === undefined
      ? {}
      : { logicalCallId: providerLogicalCallId }),
  };
}

export type ProviderCacheUsage = Pick<
  LlmCallMetric,
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheReadSource"
  | "cacheWriteSource"
>;

export function providerCacheUsage(
  metric: ProviderCacheUsage,
): ProviderCacheUsage {
  return {
    ...(metric.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: metric.cacheReadTokens }),
    ...(metric.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: metric.cacheWriteTokens }),
    ...(metric.cacheReadSource === undefined
      ? {}
      : { cacheReadSource: metric.cacheReadSource }),
    ...(metric.cacheWriteSource === undefined
      ? {}
      : { cacheWriteSource: metric.cacheWriteSource }),
  };
}

export type ProviderMetricsReport = ReturnType<typeof providerMetricsReport>;

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenCoverage(
  metrics: readonly ProfiledLlmCallMetric[],
  field:
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
) {
  const known = metrics.filter((metric) => isTokenCount(metric[field]));
  return {
    tokens: known.length
      ? known.reduce((sum, metric) => sum + metric[field]!, 0)
      : null,
    knownAttempts: known.length,
    unknownAttempts: metrics.length - known.length,
    coverage: metrics.length ? known.length / metrics.length : null,
  };
}

/** Missing cache fields remain unknown, including on historical provider usage. */
export function summarizeProviderMetrics(
  metrics: readonly ProfiledLlmCallMetric[],
) {
  const logicalIds = metrics.flatMap((metric) =>
    typeof metric.logicalCallId === "string" && metric.logicalCallId.length > 0
      ? [metric.logicalCallId]
      : [],
  );
  const providerInput = (metric: ProfiledLlmCallMetric) =>
    metric.providerInputTokens ??
    (metric.usageSource === "provider" ? metric.inputTokens : undefined);
  const readRateAttempts = metrics.filter(
    (metric) =>
      isTokenCount(providerInput(metric)) &&
      isTokenCount(metric.cacheReadTokens) &&
      metric.cacheReadTokens <= providerInput(metric)!,
  );
  const readTokens = readRateAttempts.reduce(
    (sum, metric) => sum + metric.cacheReadTokens!,
    0,
  );
  const inputTokens = readRateAttempts.reduce(
    (sum, metric) => sum + providerInput(metric)!,
    0,
  );
  return {
    physicalAttempts: metrics.length,
    successfulAttempts: metrics.filter((metric) => metric.success).length,
    failedAttempts: metrics.filter((metric) => !metric.success).length,
    retryAttempts: metrics.filter(
      (metric) => Number.isInteger(metric.attempt) && metric.attempt > 1,
    ).length,
    logicalCalls: logicalIds.length ? new Set(logicalIds).size : null,
    logicalIdKnownAttempts: logicalIds.length,
    logicalIdUnknownAttempts: metrics.length - logicalIds.length,
    input: tokenCoverage(metrics, "inputTokens"),
    output: tokenCoverage(metrics, "outputTokens"),
    cacheRead: {
      ...tokenCoverage(metrics, "cacheReadTokens"),
      sources: [
        ...new Set(
          metrics.flatMap((metric) =>
            metric.cacheReadSource ? [metric.cacheReadSource] : [],
          ),
        ),
      ].sort(),
    },
    cacheWrite: {
      ...tokenCoverage(metrics, "cacheWriteTokens"),
      sources: [
        ...new Set(
          metrics.flatMap((metric) =>
            metric.cacheWriteSource ? [metric.cacheWriteSource] : [],
          ),
        ),
      ].sort(),
    },
    cacheReadRate: {
      value: inputTokens > 0 ? readTokens / inputTokens : null,
      cacheReadTokens: readRateAttempts.length ? readTokens : null,
      inputTokens: readRateAttempts.length ? inputTokens : null,
      includedAttempts: readRateAttempts.length,
      excludedAttempts: metrics.length - readRateAttempts.length,
    },
    usageSources: [
      ...new Set(metrics.map((metric) => metric.usageSource ?? "unavailable")),
    ].sort(),
  };
}

export function providerMetricsReport(
  metrics: readonly ProfiledLlmCallMetric[],
) {
  const groups = new Map<
    string,
    {
      dimensions: {
        provider: string;
        profile: string | null;
        model: string;
        responseModel: string | null;
        purpose: string;
      };
      metrics: ProfiledLlmCallMetric[];
    }
  >();
  for (const metric of metrics) {
    const dimensions = {
      provider: metric.provider,
      profile: metric.profile ?? null,
      model: metric.model,
      responseModel: metric.responseModel ?? null,
      purpose: metric.purpose,
    };
    const key = JSON.stringify(dimensions);
    const group = groups.get(key) ?? { dimensions, metrics: [] };
    group.metrics.push(metric);
    groups.set(key, group);
  }
  return {
    schemaVersion: "provider-metrics-v1",
    total: summarizeProviderMetrics(metrics),
    groups: [...groups.values()].map(({ dimensions, metrics: grouped }) => ({
      ...dimensions,
      ...summarizeProviderMetrics(grouped),
    })),
    limitations: [
      "Cache fields missing from historical or current responses remain unknown; known token sums are partial when coverage is incomplete.",
      "Cache read rate uses only attempts with both provider input and valid cache read tokens; estimated input and cache reads exceeding input are excluded.",
      "Logical calls count only observed IDs; attempts without an ID cannot be deduplicated into logical calls.",
      "Local segment cache hits and prompt prefix characters are not provider cache tokens. No billing prices are inferred.",
    ],
  };
}

export function renderProviderMetricsReport(
  report: ReturnType<typeof providerMetricsReport>,
): string {
  const cell = (value: string | number | null | undefined) =>
    String(value ?? "unknown")
      .replace(/\|/gu, "\\|")
      .replace(/[\r\n]+/gu, " ");
  const lines = [
    "# Provider usage and prompt cache",
    "",
    "Each row counts physical attempts, including failed responses and retries. Token totals include known values only; unknown does not mean zero.",
    "",
    "| Profile | Model / response model | Purpose | Attempts / failed / retries | Logical calls / unknown-ID attempts | Input / output tokens | Cache read tokens / known attempts | Cache write tokens / known attempts | Read rate / input denominator |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.groups.map(
      (group) =>
        `| ${cell(group.profile)} | ${cell(group.model)} / ${cell(group.responseModel)} | ${cell(group.purpose)} | ${group.physicalAttempts} / ${group.failedAttempts} / ${group.retryAttempts} | ${cell(group.logicalCalls)} / ${group.logicalIdUnknownAttempts} | ${cell(group.input.tokens)} / ${cell(group.output.tokens)} | ${cell(group.cacheRead.tokens)} / ${group.cacheRead.knownAttempts} of ${group.physicalAttempts} | ${cell(group.cacheWrite.tokens)} / ${group.cacheWrite.knownAttempts} of ${group.physicalAttempts} | ${group.cacheReadRate.value === null ? "unknown" : `${(group.cacheReadRate.value * 100).toFixed(2)}%`} / ${cell(group.cacheReadRate.inputTokens)} |`,
    ),
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
  ];
  return lines.join("\n");
}
