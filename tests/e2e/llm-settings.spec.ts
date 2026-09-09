import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type {
  LlmCatalog,
  LlmProbeResult,
  LlmProviderInput,
  LlmProviderView,
  LlmSelection,
  LlmSessionModel,
} from "../../packages/contracts/src/llm-settings.js";
import { LlmModelSettingsSchema } from "../../packages/contracts/src/llm-settings.js";

function provider(id: string, name: string): LlmProviderView {
  return {
    id,
    name,
    protocol: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    timeoutMs: 120000,
    revision: 1,
    models: [LlmModelSettingsSchema.parse({ id: `${id}-model` })],
    source: "managed",
    hasApiKey: true,
    credentialStatus: "ready",
    referencedSessions: 0,
  };
}
const reply = (
  modelId: string,
  status: LlmProbeResult["status"] = "success",
): LlmProbeResult => ({
  modelId,
  configRevision: 1,
  testedAt: "2026-09-09T08:00:00.000Z",
  status,
  text:
    status === "failed"
      ? { status: "failed", latencyMs: 20, error: "模型没有返回可见正文" }
      : { status: "success", latencyMs: 80, reply: "你好，连接正常。" },
  structured:
    status === "failed"
      ? { status: "skipped", latencyMs: 0 }
      : status === "partial"
        ? { status: "failed", latencyMs: 120, error: "结构化回复不是有效 JSON" }
        : { status: "success", latencyMs: 120, reply: "测试正常" },
});

async function mockLlm(page: Page) {
  const catalog: LlmCatalog = {
    providers: [provider("alpha", "本地模型"), provider("beta", "云端供应商")],
    defaultSelection: { providerId: "alpha", modelId: "alpha-model" },
  };
  const calls: { path: string; method: string; body: unknown }[] = [];
  const state = {
    catalog,
    calls,
    probeStatus: "success" as LlmProbeResult["status"],
    probeDelay: 0,
    session: null as LlmSelection | null,
    rejectSwitch: false,
  };
  await page.route("**/api/llm/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body =
      request.method() === "GET"
        ? undefined
        : (request.postDataJSON() as Record<string, unknown>);
    calls.push({ path, method: request.method(), body });
    let output: unknown;
    if (path === "/api/llm/providers" && request.method() === "GET")
      output = catalog;
    else if (path === "/api/llm/default") {
      catalog.defaultSelection = body?.["selection"] as LlmSelection;
      output = catalog;
    } else if (
      path.startsWith("/api/llm/providers") &&
      ["POST", "PATCH"].includes(request.method())
    ) {
      const input = body as LlmProviderInput;
      const parts = path.split("/");
      const id =
        request.method() === "POST"
          ? `new-${catalog.providers.length}`
          : (parts[parts.length - 1] ?? "");
      const previous = catalog.providers.find((item) => item.id === id);
      const item: LlmProviderView = {
        ...provider(id, input.name),
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        timeoutMs: input.timeoutMs,
        models: input.models,
        hasApiKey: input.clearApiKey
          ? false
          : !!input.apiKey || !!previous?.hasApiKey,
        revision: (previous?.revision ?? 0) + 1,
      };
      catalog.providers = [
        ...catalog.providers.filter((entry) => entry.id !== id),
        item,
      ];
      output = item;
    } else if (path === "/api/llm/models/discover")
      output = {
        models: [LlmModelSettingsSchema.parse({ id: "detected-model" })],
        discoveredAt: "2026-09-09T07:00:00Z",
      };
    else if (path === "/api/llm/tests") output = { result: null };
    else if (path === "/api/llm/test") {
      const snapshot = reply(
        typeof body?.["modelId"] === "string" ? body["modelId"] : "alpha-model",
        state.probeStatus,
      );
      if (state.probeDelay)
        await new Promise((resolve) => setTimeout(resolve, state.probeDelay));
      output = snapshot;
    } else {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: output });
  });
  await page.route("**/api/sessions/*/model", async (route) => {
    if (route.request().method() === "PATCH") {
      if (state.rejectSwitch) {
        await route.fulfill({
          status: 409,
          json: {
            error: { code: "CONFLICT", message: "模型切换失败，请重试" },
          },
        });
        return;
      }
      state.session = (
        route.request().postDataJSON() as { selection: LlmSelection | null }
      ).selection;
    }
    const effective = state.session ?? catalog.defaultSelection;
    const result: LlmSessionModel = {
      selection: state.session,
      effective: {
        ...effective,
        revision:
          catalog.providers.find((item) => item.id === effective.providerId)
            ?.revision ?? 1,
      },
    };
    await route.fulfill({ json: result });
  });
  return state;
}

async function assertHealthy(page: Page, errors: string[]) {
  await expect(page).toHaveTitle(/Dearvale/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test.describe("model provider settings", () => {
  test("configures models, distinguishes partial and failed replies, and never stores a key in the browser", async ({
    page,
  }, info) => {
    const state = await mockLlm(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "让对话连接你的模型" }),
    ).toBeVisible();
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    await page
      .getByLabel("API Key", { exact: true })
      .fill("temporary-private-test-key");
    await page.getByRole("button", { name: "检测模型", exact: true }).click();
    await expect(
      page.getByText(/发现 1 个模型，尚未验证回复能力/),
    ).toBeVisible();
    await page
      .getByLabel("手动模型 ID")
      .fill(
        "manual-model-with-a-very-long-name-to-check-responsive-wrapping-2026-09-09",
      );
    await page.getByRole("button", { name: "添加模型", exact: true }).click();
    await page.getByText("高级设置", { exact: false }).click();
    await page.getByLabel("输出 token 上限", { exact: true }).fill("8192");
    state.probeStatus = "partial";
    await page.getByRole("button", { name: "测试连接与回复" }).click();
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toContainText("模型能回复，但结构化测试未通过");
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toContainText("实际回复：“你好，连接正常。”");
    await page
      .getByLabel("API 地址", { exact: true })
      .fill("http://127.0.0.1:11434/v1");
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toHaveCount(0);
    state.probeStatus = "failed";
    await page.getByRole("button", { name: "测试连接与回复" }).click();
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toContainText("结构化输出：未执行");
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toContainText("模型没有返回可见正文");
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      ),
    ).not.toContain("temporary-private-test-key");
    const saves = state.calls.filter(
      (item) =>
        item.method === "PATCH" && item.path === "/api/llm/providers/alpha",
    );
    expect(saves).toHaveLength(1);
    expect(saves[0]?.body).toMatchObject({
      apiKey: "temporary-private-test-key",
      models: expect.arrayContaining([
        expect.objectContaining({ id: "detected-model" }),
      ]),
    });
    state.probeStatus = "success";
    await page.getByRole("button", { name: "测试连接与回复" }).click();
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toContainText("测试通过");
    await assertHealthy(page, errors);
    await page.screenshot({
      path: join(
        tmpdir(),
        `chatplus-llm-settings-result-${info.project.name}.png`,
      ),
      fullPage: true,
    });
    await page
      .locator(".app-main")
      .evaluate((element) => element.scrollTo(0, 0));
    await page.screenshot({
      path: join(tmpdir(), `chatplus-llm-settings-${info.project.name}.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertHealthy(page, errors);
    await page.screenshot({
      path: join(
        tmpdir(),
        `chatplus-llm-settings-narrow-${info.project.name}.png`,
      ),
      fullPage: true,
    });
  });

  test("protects unsaved configuration across provider selection and navigation", async ({
    page,
  }) => {
    const state = await mockLlm(page);
    await page.goto("/settings");
    await page.getByLabel("供应商名称", { exact: true }).fill("修改中的供应商");
    await page.getByRole("button", { name: /云端供应商.*OpenAI/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "继续编辑", exact: true }).click();
    await expect(page.getByLabel("供应商名称", { exact: true })).toHaveValue(
      "修改中的供应商",
    );
    await page.getByRole("link", { name: "开发者工具", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "保存并继续" }).click();
    await expect(page).toHaveURL(/\/developer$/);
    expect(
      state.calls.filter((item) => item.path === "/api/llm/test"),
    ).toHaveLength(0);
    expect(
      state.catalog.providers.find((item) => item.id === "alpha")?.name,
    ).toBe("修改中的供应商");
    await page.goBack();
    await page.getByRole("button", { name: /修改中的供应商.*OpenAI/ }).click();
    await page.getByLabel("供应商名称", { exact: true }).fill("应当放弃");
    await page.getByRole("link", { name: "开发者工具", exact: true }).click();
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(page).toHaveURL(/\/developer$/);
    expect(
      state.catalog.providers.find((item) => item.id === "alpha")?.name,
    ).toBe("修改中的供应商");
  });

  test("cancels probes and discards late results after a configuration changes", async ({
    page,
  }) => {
    const state = await mockLlm(page);
    state.probeDelay = 1000;
    await page.goto("/settings");
    await page.getByRole("button", { name: "测试连接与回复" }).click();
    await page.getByRole("button", { name: "取消测试", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("测试已取消");
    await page.getByRole("button", { name: "测试连接与回复" }).click();
    await page
      .getByLabel("API 地址", { exact: true })
      .fill("http://localhost:9000/v1");
    await expect(
      page.getByText("未验证 · 测试最多发出两次短请求"),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          state.calls.filter((item) => item.path === "/api/llm/test").length,
      )
      .toBe(2);
    await page.waitForTimeout(1200);
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toHaveCount(0);
  });

  test("switches only this conversation, keeps drafts, and captures the model when sending", async ({
    page,
    request,
  }, info) => {
    const state = await mockLlm(page);
    const { characterId, sessionId } = await createConversation(request);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/characters/${characterId}/chat?session=${sessionId}`);
    await expect(
      page.getByRole("button", { name: "会话模型", exact: true }),
    ).toBeEnabled();
    await page.getByTestId("chat-input").fill("这条草稿应该保留");
    state.rejectSwitch = true;
    await page.getByRole("button", { name: "会话模型", exact: true }).click();
    await page.getByRole("combobox", { name: "搜索会话模型" }).fill("beta");
    await page.getByRole("option", { name: "beta-model", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("模型切换失败");
    await expect(
      page.getByRole("button", { name: "会话模型", exact: true }),
    ).toContainText("跟随全局默认");
    state.rejectSwitch = false;
    await page.getByRole("button", { name: "会话模型", exact: true }).click();
    await page.getByRole("combobox", { name: "搜索会话模型" }).fill("beta");
    await page
      .getByRole("combobox", { name: "搜索会话模型" })
      .press("ArrowDown");
    await page.getByRole("combobox", { name: "搜索会话模型" }).press("Enter");
    await expect(
      page.getByText("已切换，下一条消息使用该模型。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("chat-input")).toHaveValue(
      "这条草稿应该保留",
    );
    expect(state.catalog.defaultSelection.providerId).toBe("alpha");
    await page.getByRole("button", { name: "测试连接与回复" }).click();
    await expect(
      page.getByRole("status", { name: "模型测试结果" }),
    ).toContainText("beta-model");
    await assertHealthy(page, errors);
    await page.screenshot({
      path: join(tmpdir(), `chatplus-chat-model-${info.project.name}.png`),
      fullPage: true,
    });
    let sent: Record<string, unknown> | undefined;
    await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      sent = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 503,
        json: { error: { code: "UNAVAILABLE", message: "测试发送快照" } },
      });
    });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect
      .poll(() => sent)
      .toMatchObject({
        text: "这条草稿应该保留",
        clientMessageId: expect.any(String),
        modelSelection: {
          providerId: "beta",
          modelId: "beta-model",
          revision: 1,
        },
      });
    expect(
      state.calls.filter((item) => item.path === "/api/llm/test"),
    ).toHaveLength(1);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "会话模型", exact: true }),
    ).toContainText("beta-model");
  });
});

async function createConversation(request: APIRequestContext) {
  const response = await request.post("/api/characters/generate", {
    data: {
      name: `模型选择-${Date.now()}`,
      worldSetting: "当代的小城",
      workOrRole: "书店店员",
      coreTraits: ["温柔", "好奇"],
      initialRelationship: "朋友",
      dialogueStyle: "自然简洁",
      tier: "daily",
      timezone: "Asia/Shanghai",
    },
  });
  expect(response.ok()).toBe(true);
  const { character } = (await response.json()) as {
    character: { id: string; version: number };
  };
  expect(
    (
      await request.post(`/api/characters/${character.id}/publish`, {
        data: { expectedVersion: character.version },
      })
    ).ok(),
  ).toBe(true);
  const session = await request.post(`/api/agents/${character.id}/sessions`);
  const result = (await session.json()) as {
    id?: string;
    session?: { id: string };
  };
  const sessionId = result.session?.id ?? result.id;
  if (!sessionId) throw new Error("Session creation did not return an ID");
  return { characterId: character.id, sessionId };
}
