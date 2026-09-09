import { z } from "zod";
import type {
  LlmProbeResult,
  LlmProbeStage,
  LlmTarget,
  LlmDiscoveryResult,
  LlmModelSettings,
} from "@personasim/contracts";
import {
  createManagedLlmProvider,
  createOpenAiCompatibleLlmProvider,
  DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES,
  discoverLlmModels,
  hasVisibleText,
  redactSensitiveText,
} from "@personasim/providers";
import { ApiError } from "../domain/errors.js";
import type {
  LlmSettingsService,
  ResolvedLlmConfiguration,
} from "./llm-settings-service.js";

type DiagnosticSettings = Pick<
  LlmSettingsService,
  "resolveTarget" | "rememberDiscovery" | "rememberProbe"
>;
const TEST_TIMEOUT_MS = 120_000;
const TEST_MAX_OUTPUT_TOKENS = 4096;
const PROBE_SCHEMA = z.strictObject({
  reply: z.string().trim().min(1).max(600),
});

export class LlmDiagnosticsService {
  constructor(
    private readonly settings: DiagnosticSettings,
    private readonly fetchOverride?: typeof fetch,
  ) {}

  async discover(
    target: LlmTarget,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveryResult> {
    const config = this.settings.resolveTarget(target);
    if (config.protocol === "fixture")
      throw new ApiError(
        400,
        "fixture_not_remote",
        "离线演示模型不执行网络检测",
      );
    let models: LlmModelSettings[];
    try {
      models = await discoverLlmModels({
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: Math.min(config.timeoutMs, TEST_TIMEOUT_MS),
        ...(this.fetchOverride ? { fetch: this.fetchOverride } : {}),
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
    } catch (error) {
      const failure = probeFailure(error, config.apiKey, signal);
      throw new ApiError(502, failure.errorCode!, failure.error!);
    }
    const discoveredAt = new Date().toISOString();
    // Draft results are temporary. A revision conflict remains a 409, not a network error.
    if (target.providerId && !target.draft)
      this.settings.rememberDiscovery(
        target.providerId,
        config.selection.revision,
        models,
        discoveredAt,
      );
    return { models, discoveredAt };
  }

  async test(target: LlmTarget, signal?: AbortSignal): Promise<LlmProbeResult> {
    if (!target.modelId)
      throw new ApiError(400, "model_required", "请先选择或填写模型 ID");
    const config = this.settings.resolveTarget(target);
    if (config.protocol === "fixture")
      throw new ApiError(
        400,
        "fixture_not_remote",
        "离线演示不能证明真实模型连通，请选择供应商模型",
      );
    const result: LlmProbeResult = {
      ...(target.providerId ? { providerId: target.providerId } : {}),
      modelId: config.model.id,
      configRevision: config.selection.revision,
      testedAt: new Date().toISOString(),
      status: "failed",
      text: { status: "skipped", latencyMs: 0 },
      structured: { status: "skipped", latencyMs: 0 },
    };
    const model = effectiveProbeModel(config);
    const maxOutputTokens = Math.min(
      model.capabilities.maxOutputTokens ?? 8192,
      TEST_MAX_OUTPUT_TOKENS,
    );
    const timeoutMs = Math.min(config.timeoutMs, TEST_TIMEOUT_MS);
    const run = async (
      generate: () => Promise<string>,
    ): Promise<LlmProbeStage> => {
      const started = performance.now();
      try {
        signal?.throwIfAborted();
        if ((model.thinkingBudget ?? -1) >= maxOutputTokens)
          throw Object.assign(
            new Error("Test thinking budget exceeds the output allowance"),
            { code: "TEST_BUDGET_EXCEEDED" },
          );
        const reply = (await generate()).trim();
        signal?.throwIfAborted();
        if (!hasVisibleText(reply))
          throw Object.assign(new Error("No visible reply"), {
            code: "EMPTY_RESPONSE",
          });
        return {
          status: "success",
          latencyMs: Math.round(performance.now() - started),
          reply: redactSensitiveText(reply, [config.apiKey]).slice(0, 600),
        };
      } catch (error) {
        return {
          ...probeFailure(error, config.apiKey, signal),
          latencyMs: Math.round(performance.now() - started),
        };
      }
    };
    let providers: ReturnType<typeof createProbeProviders> | undefined;
    result.text = await run(() => {
      // Constructor validation belongs to this stage, so invalid settings never become a 500.
      providers = createProbeProviders(
        config,
        model,
        timeoutMs,
        this.fetchOverride,
        signal,
      );
      return providers.text.completeText({
        purpose: "connection_probe_text",
        system:
          "You are testing a text generation connection. Return only one short greeting in Chinese.",
        prompt: "请用一句简短中文打招呼。",
        maxOutputTokens,
      });
    });
    if (result.text.status === "success") {
      if (signal?.aborted)
        result.structured = {
          status: "skipped",
          latencyMs: 0,
          errorCode: "CANCELLED",
          error: "测试已取消，未执行结构化回复测试",
        };
      else
        result.structured = await run(async () => {
          const value = await providers!.structured.generateObject({
            purpose: "connection_probe_structured",
            system:
              "Return one JSON object with a reply field containing a short Chinese greeting.",
            prompt: '请返回 JSON，例如 {"reply":"你好，连接测试成功。"}。',
            maxOutputTokens,
            maxRetries: 0,
            schema: PROBE_SCHEMA,
          });
          return value.reply;
        });
      result.status =
        result.structured.status === "success" ? "success" : "partial";
    } else
      result.structured = {
        status: "skipped",
        latencyMs: 0,
        error: signal?.aborted
          ? "测试已取消，未执行结构化回复测试"
          : "短回复测试未通过，未执行结构化回复测试",
        ...(signal?.aborted ? { errorCode: "CANCELLED" } : {}),
      };
    if (target.providerId && !target.draft && !signal?.aborted)
      this.settings.rememberProbe(result);
    return result;
  }
}

/** Environment sources still execute through the legacy adapter in production. */
function effectiveProbeModel(
  config: ResolvedLlmConfiguration,
): LlmModelSettings {
  if (!config.legacyConfig) return config.model;
  const legacy = config.legacyConfig;
  const capabilities =
    legacy.capabilities ?? DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES;
  return {
    id: legacy.model,
    tokenParameter: "max_tokens",
    capabilities: {
      ...capabilities,
      maxOutputTokens: Math.min(
        legacy.maxOutputTokens ?? 8192,
        capabilities.maxOutputTokens ?? 64_000,
        64_000,
      ),
    },
  };
}

function createProbeProviders(
  config: ResolvedLlmConfiguration,
  model: LlmModelSettings,
  timeoutMs: number,
  fetchOverride?: typeof fetch,
  signal?: AbortSignal,
) {
  if (config.protocol === "fixture")
    throw new TypeError("Fixture cannot be probed remotely");
  const legacy = config.legacyConfig;
  // Combine external cancellation with the old adapter's own timeout signal without changing its body/schema behavior.
  const legacyFetch: typeof fetch = (url, init) => {
    signal?.throwIfAborted();
    return (fetchOverride ?? globalThis.fetch)(url, {
      ...init,
      redirect: "error",
      ...(signal
        ? {
            signal: init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          }
        : {}),
    });
  };
  const structured = legacy
    ? createOpenAiCompatibleLlmProvider({
        ...legacy,
        apiKey: config.apiKey,
        timeoutMs,
        maxRetries: 0,
        fetch: legacyFetch,
      })
    : undefined;
  const text = createManagedLlmProvider({
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    timeoutMs,
    maxRetries: 0,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
    ...(signal ? { signal } : {}),
  });
  return { text, structured: structured ?? text };
}

function probeFailure(
  error: unknown,
  secret: string,
  signal?: AbortSignal,
): LlmProbeStage {
  const rawCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  let code =
    rawCode && /^[a-z0-9_-]{1,100}$/iu.test(rawCode)
      ? rawCode
      : "CONNECTION_FAILED";
  if (
    signal?.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  )
    code = "CANCELLED";
  else if (error instanceof DOMException && error.name === "TimeoutError")
    code = "TIMEOUT";
  else if (error instanceof TypeError || error instanceof z.ZodError)
    code = "INVALID_CONFIGURATION";
  const messages: Record<string, string> = {
    CANCELLED: "测试已取消",
    TIMEOUT: "模型请求超时，已达到本次测试的等待上限（最多 120 秒）",
    REQUEST_TIMEOUT: "模型请求超时，已达到本次测试的等待上限（最多 120 秒）",
    NETWORK_ERROR: "无法连接供应商，请检查 API 地址、网络及代理设置",
    HTTP_400: "供应商拒绝了请求参数，请检查协议类型、模型 ID 和高级设置",
    HTTP_401: "API Key 无效或缺失，供应商未通过身份验证",
    HTTP_403: "当前 API Key 无权访问该接口或模型，请检查模型权限及服务限制",
    HTTP_404: "未找到接口或模型，请检查 API 根地址、协议类型和模型 ID",
    HTTP_405: "该地址不支持当前接口，请检查 API 根地址和协议类型",
    HTTP_408: "供应商处理请求超时，请稍后重试",
    HTTP_413: "供应商拒绝了请求大小，请检查模型或接口限制",
    HTTP_422: "请求参数与模型不兼容，请检查高级设置",
    HTTP_429: "供应商限流或可用额度不足，请检查配额后重试",
    EMPTY_RESPONSE: "模型没有返回可见正文，暂时无法证明它能回复",
    EMPTY_CONTENT: "模型没有返回可见正文，暂时无法证明它能回复",
    EMPTY_FINAL_AFTER_REASONING:
      "模型只返回了思考内容，没有最终回复，请检查思考设置和输出预算",
    OUTPUT_TRUNCATED:
      "模型回复已被截断，测试输出预算不足（每项最多 4096 tokens），请检查思考设置和输出上限",
    TEST_BUDGET_EXCEEDED:
      "当前思考预算已达到测试输出上限（最多 4096 tokens），无法为最终回复留出空间；请调整后重试",
    INVALID_CONFIGURATION:
      "供应商或模型参数无效，请检查协议类型、API 地址及高级设置后重试",
    UNSUPPORTED_RESPONSE_SCHEMA:
      "当前原生结构化模式不支持所需格式，请检查模型的结构化输出设置",
    MISSING_RESPONSE_SCHEMA: "模型请求缺少所需的结构化格式定义",
    INVALID_RESPONSE_ENVELOPE:
      "供应商返回的格式与所选协议不匹配，请检查协议类型和 API 地址",
    INVALID_STRUCTURED_OUTPUT:
      "模型返回了内容，但 JSON 或字段格式未通过校验，当前配置尚不能用于结构化对话",
    MODEL_REFUSAL: "模型拒绝了测试请求，未返回可用回复",
    CONTENT_FILTERED: "供应商拦截了测试请求或回复，未返回可用内容",
    INCOMPLETE_RESPONSE: "模型没有完成文本回复，可能请求了工具调用或中断了生成",
    MODEL_LIST_TOO_LARGE:
      "模型列表过大或分页未正常结束，请缩小供应商返回的模型范围",
  };
  const detail =
    messages[code] ??
    (/^HTTP_5\d\d$/u.test(code)
      ? "供应商服务暂时不可用，请稍后重试"
      : /^HTTP_\d{3}$/u.test(code)
        ? "供应商拒绝了本次请求，请检查 API 地址、密钥和模型设置"
        : "检测失败，无法确认供应商或模型可用，请检查配置后重试");
  return {
    status: "failed",
    latencyMs: 0,
    errorCode: code,
    error: redactSensitiveText(detail, [secret]).slice(0, 600),
  };
}
