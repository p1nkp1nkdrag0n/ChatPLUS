import type { Page } from "@playwright/test";
import {
  LlmModelSettingsSchema,
  type LlmCatalog,
  type LlmProbeResult,
  type LlmProviderInput,
  type LlmProviderView,
  type LlmSelection,
} from "../../packages/contracts/src/llm-settings.js";

export function onboardingProvider(
  overrides: Partial<LlmProviderView> = {},
): LlmProviderView {
  return {
    id: "local-provider",
    name: "已有的本地模型",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    timeoutMs: 120000,
    revision: 3,
    models: [LlmModelSettingsSchema.parse({ id: "local-chat" })],
    source: "managed",
    hasApiKey: false,
    credentialStatus: "ready",
    referencedSessions: 0,
    ...overrides,
  };
}

export function fixtureCatalog(): LlmCatalog {
  return {
    providers: [
      onboardingProvider({
        id: "fixture",
        name: "离线演示",
        protocol: "fixture",
        source: "fixture",
        models: [LlmModelSettingsSchema.parse({ id: "personasim-fixture-v1" })],
      }),
    ],
    defaultSelection: {
      providerId: "fixture",
      modelId: "personasim-fixture-v1",
    },
  };
}

// The welcome gate observes a configured catalog, while character and chat
// requests continue to exercise the disposable server's fixture model.
export async function mockConfiguredWelcomeCatalog(page: Page): Promise<void> {
  const provider = onboardingProvider();
  await page.route("**/api/llm/providers", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: {
        providers: [provider],
        defaultSelection: { providerId: provider.id, modelId: "local-chat" },
      } satisfies LlmCatalog,
    });
  });
}

export async function mockOnboardingLlm(
  page: Page,
  catalog = fixtureCatalog(),
) {
  const pendingProbes: Array<() => void> = [];
  const pendingCatalogs: Array<() => void> = [];
  const pendingDefaults: Array<() => void> = [];
  const state = {
    catalog,
    calls: [] as Array<{
      path: string;
      method: string;
      body: Record<string, unknown> | undefined;
    }>,
    catalogUnavailable: false,
    holdCatalog: false,
    discoveryUnavailable: false,
    discoveredModels: [LlmModelSettingsSchema.parse({ id: "detected-chat" })],
    probeStatus: "success" as LlmProbeResult["status"],
    holdProbe: false,
    completedProbes: 0,
    defaultFailures: 0,
    defaultConflict: false,
    holdDefault: false,
    createFailures: 0,
    loseCreateResponse: false,
    releaseProbes() {
      state.holdProbe = false;
      pendingProbes.splice(0).forEach((release) => release());
    },
    releaseCatalogs() {
      state.holdCatalog = false;
      pendingCatalogs.splice(0).forEach((release) => release());
    },
    releaseDefaults() {
      state.holdDefault = false;
      pendingDefaults.splice(0).forEach((release) => release());
    },
  };
  await page.route("**/api/llm/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body =
      method === "GET"
        ? undefined
        : (request.postDataJSON() as Record<string, unknown>);
    state.calls.push({ path, method, body });
    const fail = async (message: string, status = 503, code = "TEMPORARY") =>
      route.fulfill({ status, json: { error: { code, message } } });

    if (path === "/api/llm/providers" && method === "GET") {
      if (state.holdCatalog)
        await new Promise<void>((resolve) => pendingCatalogs.push(resolve));
      if (state.catalogUnavailable) return fail("暂时无法读取模型配置");
      return route.fulfill({ json: state.catalog });
    }
    if (path === "/api/llm/models/discover") {
      if (state.discoveryUnavailable) return fail("服务暂时无法读取模型列表");
      return route.fulfill({
        json: {
          models: state.discoveredModels,
          discoveredAt: "2026-09-11T08:00:00.000Z",
        },
      });
    }
    if (path === "/api/llm/test") {
      const providerId = body?.["providerId"] as string | undefined;
      const revision = state.catalog.providers.find(
        (item) => item.id === providerId,
      )?.revision;
      const status = state.probeStatus;
      const result: LlmProbeResult = {
        modelId: body?.["modelId"] as string,
        ...(providerId ? { providerId, configRevision: revision } : {}),
        testedAt: "2026-09-11T08:00:00.000Z",
        status,
        text:
          status === "failed"
            ? { status: "failed", latencyMs: 20, error: "模型没有返回可见正文" }
            : { status: "success", latencyMs: 20, reply: "你好，连接正常。" },
        structured:
          status === "failed"
            ? { status: "skipped", latencyMs: 0 }
            : status === "partial"
              ? {
                  status: "failed",
                  latencyMs: 30,
                  error: "结构化回复不是有效 JSON",
                }
              : { status: "success", latencyMs: 30, reply: "测试正常" },
      };
      if (state.holdProbe)
        await new Promise<void>((resolve) => pendingProbes.push(resolve));
      await route.fulfill({ json: result });
      state.completedProbes += 1;
      return;
    }
    if (path === "/api/llm/providers" && method === "POST") {
      if (state.createFailures > 0) {
        state.createFailures -= 1;
        return fail("暂时无法保存配置");
      }
      const input = body as LlmProviderInput;
      const provider = onboardingProvider({
        id: `created-${state.catalog.providers.length}`,
        name: input.name,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        timeoutMs: input.timeoutMs,
        models: input.models,
        revision: 1,
        hasApiKey: Boolean(input.apiKey?.trim()),
      });
      state.catalog.providers.push(provider);
      if (state.loseCreateResponse) {
        state.loseCreateResponse = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: provider });
    }
    if (path === "/api/llm/default") {
      if (state.holdDefault)
        await new Promise<void>((resolve) => pendingDefaults.push(resolve));
      if (state.defaultConflict)
        return fail("配置已变化，请重新测试", 409, "CONFLICT");
      if (state.defaultFailures > 0) {
        state.defaultFailures -= 1;
        return fail("默认模型暂时保存失败，请重试");
      }
      state.catalog.defaultSelection = body?.["selection"] as LlmSelection;
      return route.fulfill({ json: state.catalog });
    }
    if (path === "/api/llm/tests")
      return route.fulfill({ json: { result: null } });
    // Never let configuration tests accidentally mutate the shared backend.
    return fail(
      `未模拟的模型请求：${method} ${path}`,
      501,
      "UNMOCKED_TEST_REQUEST",
    );
  });
  await page.route("**/api/characters", (route) =>
    route.fulfill({ json: { characters: [] } }),
  );
  return state;
}
