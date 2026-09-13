import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  createManagedLlmProvider,
  LlmProviderError,
  RemoteImageGenerationProvider,
  type ImageGenerationProvider,
  type LlmProvider,
} from "@personasim/providers";
import type { LlmPurpose, LlmSelection } from "@personasim/contracts";
import { assertHostedModelPricing } from "./model-pricing.js";
import { redactKnownSecrets } from "./known-secret-redaction.js";
import type {
  HostedLlmExecution,
  LlmServiceObservationOptions,
} from "../services/llm-service.js";
import {
  HostedError,
  type HostedAttempt,
  type HostedAttemptResponse,
  type HostedLimits,
  type HostedModelSnapshot,
  type HostedResearchInput,
  type HostedReservationInput,
  type HostedResolvedModel,
  type HostedUsage,
} from "./types.js";

/** The control store owns all transactions and encryption; no telemetry callback is trusted. */
export interface HostedGatewayStore {
  getLimits(): HostedLimits;
  resolveModel(routeId: string, revision?: number): HostedResolvedModel;
  resolvePurpose(purpose: string): HostedResolvedModel;
  findAttempt(id: string): HostedAttempt | undefined;
  reserve(input: HostedReservationInput): HostedAttempt;
  markAttemptSent(
    id: string,
    metadata?: { providerRequestId?: string },
  ): unknown;
  settle(input: {
    id: string;
    costMicros: number;
    usage?: HostedUsage;
    providerRequestId?: string;
    reason?: string;
  }): unknown;
  markUnknown(id: string, reason: string): unknown;
  release(id: string, reason: string): unknown;
  recordResearch(input: HostedResearchInput): unknown;
  recordAttemptResponse(id: string, response: HostedAttemptResponse): unknown;
  readAttemptResponse(id: string): HostedAttemptResponse | undefined;
  recordAttemptImage(
    id: string,
    image: {
      bytes: Uint8Array;
      mimeType: string;
      width: number;
      height: number;
      sha256: string;
    },
  ): unknown;
  readAttemptImage(id: string):
    | {
        bytes: Uint8Array;
        mimeType: string;
        width: number;
        height: number;
        sha256: string;
      }
    | undefined;
  recordAttemptAsset(
    id: string,
    asset: {
      storageKey: string;
      thumbnailStorageKey?: string;
      sha256: string;
      width?: number;
      height?: number;
      mimeType?: string;
    },
  ): unknown;
}

export interface HostedOperationContext {
  userId: string;
  operationId: string;
  sessionId?: string;
  publicModelId?: string;
}
interface OperationState extends HostedOperationContext {
  sequence: Map<string, number>;
  snapshots: Map<string, HostedResolvedModel>;
  usageUnknown?: boolean;
}
export interface HostedImageContext {
  purpose: "achievement_badge" | "image_probe";
  generationId: string;
  agentId?: string;
}
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** Unknown token fields stay unknown. All input counters include cache reads/writes. */
export function normalizeHostedUsage(
  protocol: HostedModelSnapshot["protocol"],
  raw: unknown,
): HostedUsage {
  const envelope = record(raw);
  const values =
    record(envelope?.[protocol === "gemini" ? "usageMetadata" : "usage"]) ??
    record(record(envelope?.error)?.usage);
  if (!values) return { source: "unavailable" };
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  if (protocol === "openai-compatible") {
    inputTokens = count(values.prompt_tokens ?? values.input_tokens);
    outputTokens = count(values.completion_tokens ?? values.output_tokens);
    const details = record(
      values.prompt_tokens_details ?? values.input_tokens_details,
    );
    cacheReadTokens = count(
      details?.cached_tokens ?? values.prompt_cache_hit_tokens,
    );
    cacheWriteTokens = count(
      details?.cache_creation_input_tokens ??
        values.cache_creation_input_tokens,
    );
  } else if (protocol === "anthropic") {
    inputTokens = count(values.input_tokens);
    outputTokens = count(values.output_tokens);
    cacheReadTokens = count(values.cache_read_input_tokens);
    cacheWriteTokens = count(values.cache_creation_input_tokens);
    if (inputTokens !== undefined)
      inputTokens += (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  } else {
    inputTokens = count(values.promptTokenCount);
    outputTokens = count(values.candidatesTokenCount);
    if (outputTokens !== undefined)
      outputTokens += count(values.thoughtsTokenCount) ?? 0;
    cacheReadTokens = count(values.cachedContentTokenCount);
  }
  return {
    source: "provider",
    rawUsage: values,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

function safeInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new HostedError(422, "billing_overflow", "计费数值超出安全范围。");
  return Number(value);
}
function tokenCost(parts: Array<[number, number]>): number {
  const numerator = parts.reduce(
    (sum, [tokens, rate]) => sum + BigInt(tokens) * BigInt(rate),
    0n,
  );
  return safeInteger((numerator + 999_999n) / 1_000_000n);
}
export function hostedTextCost(
  model: HostedModelSnapshot,
  usage: HostedUsage,
): number | undefined {
  const input = count(usage.inputTokens),
    output = count(usage.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const read = count(usage.cacheReadTokens);
  const write = count(usage.cacheWriteTokens);
  if (
    read === undefined &&
    model.inputMicrosPerMillion !== model.cacheReadMicrosPerMillion
  )
    return undefined;
  if (
    write === undefined &&
    model.cacheWriteMicrosPerMillion !== undefined &&
    model.cacheWriteMicrosPerMillion !== model.inputMicrosPerMillion
  )
    return undefined;
  const cacheRead = read ?? 0,
    cacheWrite = write ?? 0;
  if (cacheRead + cacheWrite > input) return undefined;
  return tokenCost([
    [input - cacheRead - cacheWrite, model.inputMicrosPerMillion],
    [cacheRead, model.cacheReadMicrosPerMillion],
    [
      cacheWrite,
      model.cacheWriteMicrosPerMillion ?? model.inputMicrosPerMillion,
    ],
    [output, model.outputMicrosPerMillion],
  ]);
}

function imageCount(
  protocol: HostedModelSnapshot["protocol"],
  raw: unknown,
): number {
  const value = record(raw);
  if (protocol === "openai-compatible") {
    return Array.isArray(value?.data)
      ? value.data.filter((item: unknown) => {
          const output = record(item);
          return (
            typeof output?.url === "string" ||
            typeof output?.b64_json === "string"
          );
        }).length
      : 0;
  }
  const candidates = value?.candidates;
  if (!Array.isArray(candidates)) return 0;
  return candidates.reduce((sum: number, candidate: unknown) => {
    const parts = record(record(candidate)?.content)?.parts;
    return (
      sum +
      (Array.isArray(parts)
        ? parts.filter((part: unknown) => {
            const item = record(part);
            return (
              item?.thought !== true &&
              typeof record(item?.inlineData ?? item?.inline_data)?.data ===
                "string"
            );
          }).length
        : 0)
    );
  }, 0);
}

function imageSpecification(model: HostedModelSnapshot): {
  width: number;
  height: number;
  quality?: string;
} {
  const specification = model.imageSpecification ?? "1024x1024";
  const parsed =
    /^(\d{2,4})x(\d{2,4})(?::(low|medium|high|auto|standard|hd))?$/u.exec(
      specification,
    );
  if (!parsed)
    throw new HostedError(
      409,
      "image_specification_unsupported",
      "图片规格须为宽x高，可附加冒号和质量档位。",
    );
  const width = Number(parsed[1]),
    height = Number(parsed[2]);
  if (width < 64 || width > 4096 || height < 64 || height > 4096)
    throw new HostedError(
      409,
      "image_specification_unsupported",
      "图片尺寸须在64至4096之间。",
    );
  if (
    model.protocol === "gemini" &&
    (width !== 1024 || height !== 1024 || parsed[3])
  )
    throw new HostedError(
      409,
      "image_specification_unsupported",
      "Gemini图片首版仅支持1024x1024默认规格。",
    );
  return { width, height, ...(parsed[3] ? { quality: parsed[3] } : {}) };
}

function publicSnapshot(model: HostedResolvedModel): HostedModelSnapshot {
  const { apiKey: _credential, ...snapshot } = model;
  void _credential;
  return snapshot;
}
function attemptId(
  userId: string,
  operationId: string,
  purpose: string,
  logicalIndex: number,
  attempt: number,
): string {
  return `model_${createHash("sha256")
    .update(
      JSON.stringify([userId, operationId, purpose, logicalIndex, attempt]),
    )
    .digest("hex")}`;
}

export class HostedModelGateway {
  private readonly operations = new AsyncLocalStorage<OperationState>();
  private active = 0;
  private activeImages = 0;
  private paused = false;
  private readonly activeUsers = new Map<string, number>();
  private readonly controllers = new Map<
    string,
    { userId: string; controller: AbortController }
  >();
  private readonly inFlight = new Map<string, Promise<HostedAttemptResponse>>();
  private readonly queue: Array<{
    userId: string;
    kind: "text" | "image";
    resolve: (release: () => void) => void;
    reject: (reason: unknown) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(
    private readonly store: HostedGatewayStore,
    private readonly transport: typeof fetch = globalThis.fetch,
  ) {}

  getStats(): { active: number; queued: number; activeImages: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      activeImages: this.activeImages,
    };
  }
  pause(paused = true): void {
    this.paused = paused;
    if (paused) {
      for (const item of this.queue.splice(0)) {
        if (item.abort) item.signal?.removeEventListener("abort", item.abort);
        item.reject(
          new HostedError(503, "model_gateway_paused", "模型服务暂时维护中。"),
        );
      }
    } else this.drain();
  }
  abortUser(userId: string): void {
    for (const item of [...this.queue]) {
      if (item.userId !== userId) continue;
      this.queue.splice(this.queue.indexOf(item), 1);
      if (item.abort) item.signal?.removeEventListener("abort", item.abort);
      item.reject(
        new HostedError(403, "account_unavailable", "此账号已停止模型调用。"),
      );
    }
    for (const item of this.controllers.values())
      if (item.userId === userId)
        item.controller.abort(
          new HostedError(403, "account_unavailable", "此账号已停止模型调用。"),
        );
  }
  async shutdown(): Promise<void> {
    this.pause();
    for (const item of this.controllers.values())
      item.controller.abort(new Error("Model gateway shutting down"));
    await Promise.allSettled([...this.inFlight.values()]);
  }

  runOperation<T>(context: HostedOperationContext, operation: () => T): T {
    if (!context.userId || !context.operationId)
      throw new HostedError(
        400,
        "operation_id_required",
        "本次操作缺少请求标识。",
      );
    return this.operations.run(
      { ...context, sequence: new Map(), snapshots: new Map() },
      operation,
    );
  }

  forUser(userId: string): LlmServiceObservationOptions {
    return {
      executionResolver: (purpose, selection, context) =>
        this.resolveExecution(userId, purpose, selection, context),
      imageProviderFactory: this.imageProviderFactory(userId),
      onImageAsset: (id, asset) => {
        if (this.store.findAttempt(id)?.userId !== userId)
          throw new HostedError(
            403,
            "asset_owner_mismatch",
            "图片任务不属于此账号。",
          );
        this.store.recordAttemptAsset(id, asset);
      },
    };
  }

  imageProviderFactory(
    userId: string,
  ): (context: HostedImageContext) => ImageGenerationProvider {
    return (context) => {
      const scope = this.operations.getStore();
      if (scope && scope.userId !== userId)
        throw new HostedError(
          403,
          "model_owner_mismatch",
          "账号与图片任务不匹配。",
        );
      if (context.purpose === "image_probe" && scope)
        context = {
          ...context,
          generationId: `image-probe:${scope.operationId}`,
        };
      const previous = this.store.findAttempt(
        attemptId(userId, context.generationId, context.purpose, 0, 1),
      );
      const model = previous
        ? { ...previous.modelSnapshot, apiKey: "" }
        : this.store.resolvePurpose(context.purpose);
      if (model.kind !== "image")
        throw new HostedError(
          409,
          "image_model_required",
          "此用途需要图片模型。",
        );
      if (model.protocol === "anthropic")
        throw new HostedError(
          409,
          "image_protocol_unsupported",
          "此协议不能用于图片生成。",
        );
      const specification = imageSpecification(model);
      let transportFailure: unknown;
      const controller = new AbortController();
      const assetControllerId = `${attemptId(userId, context.generationId, context.purpose, 0, 1)}:asset`;
      const provider = new RemoteImageGenerationProvider({
        settings: {
          protocol: model.protocol,
          baseUrl: model.baseUrl,
          model: model.modelId,
        },
        apiKey: model.apiKey,
        signal: controller.signal,
        fetch: async (url, init) => {
          try {
            return await this.dispatch(
              {
                userId,
                operationId: context.generationId,
                purpose: context.purpose,
                logicalIndex: 0,
                attempt: 1,
                model,
              },
              url,
              init,
            );
          } catch (error) {
            transportFailure = error;
            throw error;
          }
        },
      });
      return {
        name: provider.name,
        model: model.displayName,
        generate: async (input) => {
          this.controllers.set(assetControllerId, { userId, controller });
          try {
            const meteringId = attemptId(
              userId,
              context.generationId,
              context.purpose,
              0,
              1,
            );
            const saved = this.store.readAttemptImage(meteringId);
            if (saved) {
              const operation = this.operations.getStore();
              if (
                operation &&
                this.store.findAttempt(meteringId)?.status === "unknown"
              )
                operation.usageUnknown = true;
              return {
                ...saved,
                mimeType: saved.mimeType as
                  "image/png" | "image/webp" | "image/jpeg",
                meteringId,
              };
            }
            const result = await provider.generate({
              ...input,
              width: specification.width,
              height: specification.height,
            });
            this.store.recordAttemptImage(meteringId, {
              ...result,
              sha256: createHash("sha256").update(result.bytes).digest("hex"),
            });
            return { ...result, meteringId };
          } catch (error) {
            throw transportFailure ?? error;
          } finally {
            this.controllers.delete(assetControllerId);
          }
        },
      };
    };
  }

  private resolveExecution(
    userId: string,
    purpose: LlmPurpose,
    selection?: LlmSelection,
    context?: { operationId?: string; agentId?: string },
  ): HostedLlmExecution {
    const operation = this.operations.getStore();
    if (operation && operation.userId !== userId)
      throw new HostedError(
        403,
        "model_owner_mismatch",
        "账号与模型任务不匹配。",
      );
    const route =
      purpose === "chat_turn"
        ? (selection?.modelId ?? operation?.publicModelId)
        : undefined;
    const key = `${purpose}:${route ?? "default"}`;
    const resolvedOperationId = context?.operationId ?? operation?.operationId;
    const nextIndex = context?.operationId
      ? 1
      : (operation?.sequence.get(purpose) ?? 0) + 1;
    const earlier = resolvedOperationId
      ? this.store.findAttempt(
          attemptId(userId, resolvedOperationId, purpose, nextIndex, 1),
        )
      : undefined;
    let model = earlier
      ? { ...earlier.modelSnapshot, apiKey: "" }
      : operation?.snapshots.get(key);
    if (!model) {
      model = route
        ? this.store.resolveModel(route)
        : this.store.resolvePurpose(purpose);
      operation?.snapshots.set(key, model);
    }
    if (model.kind !== "text")
      throw new HostedError(409, "text_model_required", "此用途需要文本模型。");
    const resolved = model;
    const capabilities = {
      structuredOutputMode: "prompt_json" as const,
      supportsThinkingControl: false,
      supportsStreaming: false,
      maxOutputTokens: model.maxOutputTokens,
      maxContextTokens:
        model.maxContextTokens ??
        Math.max(32_000, model.maxOutputTokens + 8192),
    };
    const run = async <T>(
      invoke: (provider: LlmProvider) => Promise<T>,
    ): Promise<T> => {
      const scope = this.operations.getStore();
      const operationId = context?.operationId ?? scope?.operationId;
      if (!operationId)
        throw new HostedError(
          409,
          "operation_id_required",
          "后台模型任务缺少持久请求标识，已停止调用。",
        );
      const logicalIndex = context?.operationId
        ? 1
        : (scope?.sequence.get(purpose) ?? 0) + 1;
      if (scope && !context?.operationId)
        scope.sequence.set(purpose, logicalIndex);
      const previous = this.store.findAttempt(
        attemptId(userId, operationId, purpose, logicalIndex, 1),
      );
      const activeModel = previous
        ? { ...previous.modelSnapshot, apiKey: "" }
        : resolved;
      let attempt = 0;
      let admissionFailure: unknown;
      let lastAttemptUnknown = false;
      const provider = createManagedLlmProvider({
        protocol: activeModel.protocol,
        baseUrl: activeModel.baseUrl,
        apiKey: activeModel.apiKey,
        timeoutMs: 120000,
        maxRetries: 1,
        model: {
          id: activeModel.modelId,
          tokenParameter: "max_tokens",
          capabilities: {
            ...capabilities,
            maxOutputTokens: activeModel.maxOutputTokens,
            maxContextTokens:
              activeModel.maxContextTokens ??
              Math.max(32_000, activeModel.maxOutputTokens + 8192),
          },
        },
        fetch: async (url, init) => {
          if (admissionFailure)
            throw new LlmProviderError(
              "Hosted model request blocked",
              "HOSTED_ADMISSION_FAILED",
            );
          try {
            if (lastAttemptUnknown)
              throw new HostedError(
                409,
                "model_outcome_unknown",
                "先前请求的用量待核对，已停止自动重试。",
              );
            const result = await this.dispatch(
              {
                userId,
                operationId,
                purpose,
                logicalIndex,
                attempt: ++attempt,
                model: activeModel,
              },
              url,
              init,
            );
            lastAttemptUnknown =
              this.store.findAttempt(
                attemptId(userId, operationId, purpose, logicalIndex, attempt),
              )?.status === "unknown";
            return result;
          } catch (error) {
            admissionFailure = error;
            throw new LlmProviderError(
              "Hosted model request blocked",
              "HOSTED_ADMISSION_FAILED",
            );
          }
        },
      });
      try {
        return await invoke(provider);
      } catch (error) {
        throw admissionFailure ?? error;
      }
    };
    const provider: LlmProvider = {
      name: resolved.protocol,
      model: resolved.displayName,
      capabilities,
      generate: (input) => run((upstream) => upstream.generate(input)),
      generateObject: (input) =>
        run((upstream) => upstream.generateObject(input)),
      completeStructured: (input) =>
        run((upstream) => upstream.completeStructured(input)),
      complete: (input) => run((upstream) => upstream.complete(input)),
    };
    return {
      provider,
      protocol: model.protocol,
      selection: {
        providerId: "hosted",
        modelId: model.routeId,
        revision: model.revision,
      },
      displayName: model.displayName,
    };
  }

  private async dispatch(
    context: {
      userId: string;
      operationId: string;
      purpose: string;
      logicalIndex: number;
      attempt: number;
      model: HostedResolvedModel;
    },
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (this.operations.getStore()?.usageUnknown)
      throw new HostedError(
        409,
        "model_outcome_unknown",
        "本次操作有待核对费用，已停止继续调用模型。",
      );
    const id = attemptId(
      context.userId,
      context.operationId,
      context.purpose,
      context.logicalIndex,
      context.attempt,
    );
    let pending = this.inFlight.get(id);
    if (!pending) {
      pending = this.dispatchOnce(id, context, url, init);
      this.inFlight.set(id, pending);
    }
    try {
      const response = await pending;
      if (this.store.findAttempt(id)?.status === "unknown") {
        const scope = this.operations.getStore();
        if (scope) scope.usageUnknown = true;
      }
      return new Response(response.body, {
        status: response.status,
        ...(response.headers ? { headers: response.headers } : {}),
      });
    } finally {
      if (this.inFlight.get(id) === pending) this.inFlight.delete(id);
    }
  }

  private async dispatchOnce(
    id: string,
    context: {
      userId: string;
      operationId: string;
      purpose: string;
      model: HostedResolvedModel;
    },
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<HostedAttemptResponse> {
    const previous = this.store.findAttempt(id);
    if (previous) {
      if (
        previous.userId !== context.userId ||
        previous.operationId !== context.operationId
      )
        throw new HostedError(
          409,
          "attempt_owner_mismatch",
          "请求标识不匹配。",
        );
      const response = this.store.readAttemptResponse(id);
      if (response) {
        if (previous.status !== "settled")
          this.account(id, previous.modelSnapshot, response);
        return response;
      }
      if (previous.status === "settled")
        throw new HostedError(
          410,
          "model_response_unavailable",
          "原模型响应已删除或不可用，此请求不会重新发送。",
        );
      if (previous.status !== "reserved")
        throw new HostedError(
          409,
          "model_outcome_unknown",
          "此请求的费用待核对，已停止重复发送。",
        );
    }
    const model = previous?.modelSnapshot ?? publicSnapshot(context.model);
    // Settled/raw-response recovery above is independent of today's pricing.
    // Only a new physical request requires configured positive prices.
    assertHostedModelPricing(model);
    const requestedUrl = new URL(
      typeof url === "string" || url instanceof URL ? url : url.url,
    );
    if (
      requestedUrl.protocol !== "https:" ||
      requestedUrl.origin !== new URL(model.baseUrl).origin
    )
      throw new HostedError(
        400,
        "model_destination_rejected",
        "模型请求地址不受信任。",
      );
    if (typeof init?.body !== "string" || init.method !== "POST")
      throw new HostedError(
        400,
        "model_request_rejected",
        "只允许已配置的模型生成请求。",
      );
    const bytes = Buffer.byteLength(init.body, "utf8");
    if (bytes > this.store.getLimits().maxRequestBytes)
      throw new HostedError(
        413,
        "model_request_too_large",
        "本次模型输入过长。",
      );
    const body = JSON.parse(init.body) as JsonRecord;
    this.enforceOutputLimit(model, body);
    const serialized = JSON.stringify(body);
    const maximumCostMicros =
      model.kind === "image"
        ? (model.imagePointsMicros ?? 0)
        : tokenCost([
            [
              bytes + 4096,
              Math.max(
                model.inputMicrosPerMillion,
                model.cacheReadMicrosPerMillion,
                model.cacheWriteMicrosPerMillion ?? 0,
              ),
            ],
            [model.maxOutputTokens, model.outputMicrosPerMillion],
          ]);
    const release = await this.acquire(
      context.userId,
      model.kind,
      init.signal ?? undefined,
    );
    const controller = new AbortController();
    this.controllers.set(id, { userId: context.userId, controller });
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    let sent = false;
    let credentials = [context.model.apiKey];
    try {
      const operation = this.operations.getStore();
      // Recovery above needs no credential. A genuinely new physical request
      // rechecks today's route admission even when its price snapshot is older.
      const current = this.store.resolveModel(model.routeId);
      assertHostedModelPricing(current);
      if (!current.enabled)
        throw new HostedError(403, "model_disabled", "此模型已停止新调用。");
      const credential = this.store.resolveModel(
        model.routeId,
        model.revision,
      ).apiKey;
      credentials = [context.model.apiKey, current.apiKey, credential];
      if (!current.apiKey.trim() || !credential.trim())
        throw new HostedError(
          503,
          "model_credential_missing",
          "此模型的服务器凭据尚未配置。",
        );
      const headers = new Headers(init.headers);
      headers.delete("authorization");
      headers.delete("x-api-key");
      headers.delete("x-goog-api-key");
      headers.set(
        model.protocol === "openai-compatible"
          ? "authorization"
          : model.protocol === "anthropic"
            ? "x-api-key"
            : "x-goog-api-key",
        model.protocol === "openai-compatible"
          ? `Bearer ${credential}`
          : credential,
      );
      const reserved = this.store.reserve({
        id,
        userId: context.userId,
        operationId: context.operationId,
        purpose: context.purpose,
        maximumCostMicros,
        modelSnapshot: model,
        ...(operation?.sessionId ? { sessionId: operation.sessionId } : {}),
        ...(operation && operation.operationId !== context.operationId
          ? { parentOperationId: operation.operationId }
          : {}),
      });
      if (reserved.status !== "reserved")
        throw new HostedError(
          409,
          "model_outcome_unknown",
          "此请求正在处理或等待核对。",
        );
      this.store.recordResearch({
        attemptId: id,
        kind: "request",
        // Redact only the research copy; the actual provider payload below
        // retains the caller's original content and signed asset URLs.
        payload: JSON.parse(
          redactKnownSecrets(
            JSON.stringify({
              purpose: context.purpose,
              endpoint: requestedUrl.pathname,
              body,
            }),
            credentials,
          ),
        ) as JsonRecord,
      });
      signal.throwIfAborted();
      this.store.markAttemptSent(id);
      sent = true;
      const upstream = await this.transport(url, {
        ...init,
        headers,
        signal,
        body: serialized,
        redirect: "error",
      });
      const text = await readBounded(
        upstream,
        model.kind === "image" ? 48 * 1024 * 1024 : 8 * 1024 * 1024,
      );
      const providerRequestId = redactKnownSecrets(
        upstream.headers.get("x-request-id") ??
          upstream.headers.get("request-id") ??
          "",
        credentials,
      );
      const response: HostedAttemptResponse = {
        status: upstream.status,
        body: redactKnownSecrets(text, credentials),
        headers: {
          "content-type": redactKnownSecrets(
            upstream.headers.get("content-type") ?? "application/json",
            credentials,
          ),
        },
        ...(providerRequestId ? { providerRequestId } : {}),
      };
      // Commit the recoverable response before settlement or any asset download.
      this.store.recordAttemptResponse(id, response);
      this.account(id, model, response);
      return response;
    } catch (error) {
      const state = this.store.findAttempt(id);
      if (state?.status === "reserved")
        this.store.release(id, "request_not_sent");
      else if (sent && state?.status === "sent")
        this.store.markUnknown(id, "provider_response_or_settlement_unknown");
      if (error instanceof Error) {
        const message = redactKnownSecrets(error.message, credentials);
        if (message !== error.message)
          throw error instanceof HostedError
            ? new HostedError(error.statusCode, error.code, message)
            : new Error(message);
      }
      throw error;
    } finally {
      this.controllers.delete(id);
      release();
    }
  }

  private account(
    id: string,
    model: HostedModelSnapshot,
    response: HostedAttemptResponse,
  ): void {
    let raw: unknown;
    try {
      raw = JSON.parse(response.body);
    } catch {
      /* Unknown response remains recoverable. */
    }
    const usage = normalizeHostedUsage(model.protocol, raw);
    const images = model.kind === "image" ? imageCount(model.protocol, raw) : 0;
    const cost =
      model.kind === "image"
        ? response.status >= 200 && response.status < 300 && images === 1
          ? (model.imagePointsMicros ?? 0)
          : undefined
        : hostedTextCost(model, usage);
    if (cost === undefined) {
      this.store.markUnknown(
        id,
        model.kind === "image"
          ? images > 1
            ? "image_count_mismatch"
            : "image_generation_unconfirmed"
          : "provider_usage_incomplete",
      );
      // Successful output can still be delivered while its charge remains frozen.
      if (response.status < 200 || response.status >= 300)
        throw new HostedError(
          409,
          "model_outcome_unknown",
          "供应商返回的计费信息不完整，积分暂时冻结待核对。",
        );
      return;
    }
    this.store.settle({
      id,
      costMicros: cost,
      usage: {
        ...usage,
        ...(model.kind === "image" ? { generatedImages: images } : {}),
      },
      ...(response.providerRequestId
        ? { providerRequestId: response.providerRequestId }
        : {}),
      reason:
        model.kind === "image"
          ? "image_generation_confirmed"
          : "provider_usage",
    });
  }

  private enforceOutputLimit(
    model: HostedModelSnapshot,
    body: JsonRecord,
  ): void {
    if (model.kind === "image") {
      if (
        !Number.isSafeInteger(model.imagePointsMicros) ||
        (model.imagePointsMicros ?? -1) < 0
      )
        throw new HostedError(
          409,
          "image_price_missing",
          "图片模型尚未配置积分价格。",
        );
      const specification = imageSpecification(model);
      if (model.protocol === "openai-compatible") {
        body.n = 1;
        body.size = `${specification.width}x${specification.height}`;
        if (specification.quality) body.quality = specification.quality;
      }
      return;
    }
    if (model.protocol === "gemini") {
      const generation = record(body.generationConfig) ?? {};
      generation.maxOutputTokens = Math.min(
        count(generation.maxOutputTokens) ?? model.maxOutputTokens,
        model.maxOutputTokens,
      );
      body.generationConfig = generation;
    } else {
      const field =
        "max_completion_tokens" in body
          ? "max_completion_tokens"
          : "max_tokens";
      body[field] = Math.min(
        count(body[field]) ?? model.maxOutputTokens,
        model.maxOutputTokens,
      );
    }
  }

  private acquire(
    userId: string,
    kind: "text" | "image",
    signal?: AbortSignal,
  ): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.paused)
      return Promise.reject(
        new HostedError(503, "model_gateway_paused", "模型服务暂时维护中。"),
      );
    const limits = this.store.getLimits();
    if (!limits.callsEnabled)
      return Promise.reject(
        new HostedError(503, "model_calls_disabled", "管理员已暂停模型调用。"),
      );
    if (this.queue.length >= limits.maxQueuedCalls)
      return Promise.reject(
        new HostedError(429, "model_queue_full", "当前请求较多，请稍后重试。"),
      );
    return new Promise((resolve, reject) => {
      const item: (typeof this.queue)[number] = {
        userId,
        kind,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        item.abort = () => {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error ? reason : new Error("Request cancelled"),
          );
        };
        signal.addEventListener("abort", item.abort, { once: true });
      }
      this.queue.push(item);
      this.drain();
    });
  }

  private drain(): void {
    if (this.paused) return;
    const limits = this.store.getLimits();
    while (this.active < limits.globalConcurrency) {
      const index = this.queue.findIndex(
        (item) =>
          (this.activeUsers.get(item.userId) ?? 0) <
            limits.perUserConcurrency &&
          (item.kind !== "image" || this.activeImages < 1),
      );
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0]!;
      if (item.abort) item.signal?.removeEventListener("abort", item.abort);
      if (item.signal?.aborted) {
        item.reject(item.signal.reason);
        continue;
      }
      this.active++;
      if (item.kind === "image") this.activeImages++;
      this.activeUsers.set(
        item.userId,
        (this.activeUsers.get(item.userId) ?? 0) + 1,
      );
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        if (item.kind === "image") this.activeImages--;
        const remaining = (this.activeUsers.get(item.userId) ?? 1) - 1;
        if (remaining) this.activeUsers.set(item.userId, remaining);
        else this.activeUsers.delete(item.userId);
        this.drain();
      });
    }
  }
}

async function readBounded(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new HostedError(
          502,
          "provider_response_too_large",
          "供应商返回内容过大。",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
