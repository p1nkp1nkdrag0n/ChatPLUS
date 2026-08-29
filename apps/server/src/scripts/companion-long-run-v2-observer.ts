import { randomUUID } from "node:crypto";

import type { LlmCallMetric } from "@personasim/providers";
import { estimateConversationTokens } from "@personasim/features";

import type { LlmLogicalCallEvent } from "../services/llm-service.js";
import { sha256Text } from "./companion-long-run-v2-artifacts.js";
import type {
  LogicalCallTrace,
  ProviderAttemptEvidence,
} from "./companion-long-run-v2-run-types.js";

export interface ObservationCursor {
  logicalEventIndex: number;
  attemptIndex: number;
  rawAttemptIndex: number;
}

export interface ObservationSlice {
  logicalCalls: LogicalCallTrace[];
  providerAttempts: ProviderAttemptEvidence[];
}

interface RawAttemptCapture {
  requestModel?: string;
  requestBody?: unknown;
  rawResponse?: unknown;
  responseText?: string;
  startedAtUtc: string;
  completedAtUtc: string;
}

/**
 * Captures the two intentionally separate evidence layers: application-level
 * logical calls and Provider-level physical attempts. Headers are never
 * retained, so an Authorization value cannot enter an artifact.
 */
export class LongRunV2Observer {
  private readonly logicalEvents: LlmLogicalCallEvent[] = [];
  private readonly metrics: LlmCallMetric[] = [];
  private readonly rawAttempts: RawAttemptCapture[] = [];

  constructor(
    private readonly nowUtc: () => string = () => new Date().toISOString(),
  ) {}

  readonly onLogicalCall = (event: LlmLogicalCallEvent): void => {
    this.logicalEvents.push(structuredClone(event));
  };

  readonly onMetric = (metric: LlmCallMetric): void => {
    this.metrics.push(structuredClone(metric));
  };

  cursor(): ObservationCursor {
    return {
      logicalEventIndex: this.logicalEvents.length,
      attemptIndex: this.metrics.length,
      rawAttemptIndex: this.rawAttempts.length,
    };
  }

  wrapFetch(delegate: typeof fetch): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (!url.pathname.replace(/\/+$/u, "").endsWith("/chat/completions")) {
        return delegate(input, init);
      }
      const startedAtUtc = this.nowUtc();
      const requestBody = parseBody(init?.body);
      const model = requestModel(requestBody);
      try {
        const response = await delegate(input, init);
        const responseText = await response.clone().text();
        this.rawAttempts.push({
          ...(model === undefined ? {} : { requestModel: model }),
          ...(requestBody === undefined ? {} : { requestBody }),
          ...parseProviderResponse(responseText),
          startedAtUtc,
          completedAtUtc: this.nowUtc(),
        });
        return response;
      } catch (error) {
        this.rawAttempts.push({
          ...(model === undefined ? {} : { requestModel: model }),
          ...(requestBody === undefined ? {} : { requestBody }),
          responseText:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : "network_error",
          startedAtUtc,
          completedAtUtc: this.nowUtc(),
        });
        throw error;
      }
    };
  }

  slice(cursor: ObservationCursor): ObservationSlice {
    const events = this.logicalEvents.slice(cursor.logicalEventIndex);
    const starts = events.filter(
      (event): event is Extract<LlmLogicalCallEvent, { stage: "started" }> =>
        event.stage === "started",
    );
    const completions = new Map(
      events
        .filter(
          (
            event,
          ): event is Extract<LlmLogicalCallEvent, { stage: "completed" }> =>
            event.stage === "completed",
        )
        .map((event) => [event.index, event]),
    );
    const logicalCalls = starts.map((start) => {
      const completed = completions.get(start.index);
      return {
        index: start.index,
        purpose: start.purpose,
        system: start.system,
        prompt: start.prompt,
        promptSha256: sha256Text(`${start.system}\n${start.prompt}`),
        ...(completed?.parsedOutput === undefined
          ? {}
          : { parsedOutput: completed.parsedOutput }),
        ...(completed?.errorCode === undefined
          ? {}
          : { errorCode: completed.errorCode }),
      } satisfies LogicalCallTrace;
    });

    const metrics = this.metrics.slice(cursor.attemptIndex);
    const raw = this.rawAttempts.slice(cursor.rawAttemptIndex);
    const providerAttempts = metrics.map((metric, index) => {
      const captured = raw[index];
      const logicalCall = logicalCalls.find(
        (call) => call.purpose === metric.purpose,
      );
      const estimatedInputTokens =
        metric.inputTokens === undefined && logicalCall !== undefined
          ? estimateConversationTokens(
              `${logicalCall.system}\n${logicalCall.prompt}`,
            )
          : undefined;
      const estimatedOutputTokens =
        metric.outputTokens === undefined
          ? estimateAttemptOutputTokens(captured, logicalCall?.parsedOutput)
          : undefined;
      const usedEstimate =
        estimatedInputTokens !== undefined ||
        estimatedOutputTokens !== undefined;
      return {
        ...metric,
        ...(usedEstimate ? { usageSource: "estimated" as const } : {}),
        ...(estimatedInputTokens === undefined
          ? {}
          : { inputTokens: estimatedInputTokens }),
        ...(estimatedOutputTokens === undefined
          ? {}
          : { outputTokens: estimatedOutputTokens }),
        attemptId: `attempt-${randomUUID()}`,
        ...(logicalCall === undefined
          ? {}
          : { logicalCallIndex: logicalCall.index }),
        ...(captured?.requestModel === undefined
          ? {}
          : { requestModel: captured.requestModel }),
        ...(captured?.requestBody === undefined
          ? {}
          : { requestBody: captured.requestBody }),
        ...(captured?.rawResponse === undefined
          ? {}
          : { rawResponse: captured.rawResponse }),
        ...(captured?.responseText === undefined
          ? {}
          : { responseText: captured.responseText }),
        startedAtUtc: captured?.startedAtUtc ?? this.nowUtc(),
        completedAtUtc: captured?.completedAtUtc ?? this.nowUtc(),
      } satisfies ProviderAttemptEvidence;
    });

    return { logicalCalls, providerAttempts };
  }
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function requestModel(body: unknown): string | undefined {
  if (
    typeof body === "object" &&
    body !== null &&
    "model" in body &&
    typeof body.model === "string"
  ) {
    return body.model;
  }
  return undefined;
}

function parseProviderResponse(
  text: string,
): Pick<RawAttemptCapture, "rawResponse" | "responseText"> {
  try {
    return { rawResponse: JSON.parse(text) as unknown };
  } catch {
    return { responseText: text };
  }
}

function estimateAttemptOutputTokens(
  captured: RawAttemptCapture | undefined,
  parsedOutput: unknown,
): number | undefined {
  if (parsedOutput !== undefined) {
    return estimateConversationTokens(JSON.stringify(parsedOutput));
  }
  const response = asRecord(captured?.rawResponse);
  const choices = Array.isArray(response["choices"]) ? response["choices"] : [];
  const first = asRecord(choices[0]);
  const message = asRecord(first["message"]);
  const content = message["content"];
  if (typeof content === "string" && content !== "") {
    return estimateConversationTokens(content);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
