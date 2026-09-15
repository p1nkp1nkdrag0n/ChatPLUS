import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LlmModelSettingsSchema } from "../../packages/contracts/src/llm-settings.js";
import type {
  LlmProbeResult,
  LlmProviderInput,
  LlmProviderView,
  LlmSelection,
} from "../../packages/contracts/src/llm-settings.js";
import { LlmPurposeSchema } from "../../packages/contracts/src/llm.js";
import type { UserModelSettings } from "../../packages/contracts/src/user-model-settings.js";

const selected = { providerId: "hosted", modelId: "public-text" };
async function screenshot(page: Page, name: string, fullPage = true) {
  const directory = process.env["CHATPLUS_QA_SCREENSHOTS"];
  if (!directory) return;
  if (!isAbsolute(directory))
    throw new Error(
      "CHATPLUS_QA_SCREENSHOTS must be an absolute path outside the repository",
    );
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: join(
      directory,
      `${name}-${page.viewportSize()?.width ?? "default"}.png`,
    ),
    fullPage,
  });
}
function provider(id: string): LlmProviderView {
  return {
    id,
    name: id === "hosted" ? "平台模型" : "我的供应商",
    protocol: "openai-compatible",
    baseUrl:
      id === "hosted"
        ? "https://never-display-platform.invalid/v1"
        : "https://my-api.example/v1",
    timeoutMs: 120000,
    revision: 1,
    models: [
      LlmModelSettingsSchema.parse({
        id: id === "hosted" ? "public-text" : "own-model",
        label: id === "hosted" ? "平台对话模型" : "我的对话模型",
      }),
    ],
    source: "managed",
    hasApiKey: true,
    credentialStatus: "ready",
    referencedSessions: 0,
  };
}

async function mockAccount(
  page: Page,
  options: { completed?: boolean; role?: "user" | "admin"; own?: boolean } = {},
) {
  const state = {
    settings: {
      revision: 0,
      onboardingCompleted: options.completed ?? false,
      bindings: {},
      imageSelection: null,
    } as UserModelSettings,
    catalog: {
      providers: [
        provider("hosted"),
        ...(options.own ? [provider("llmprovider_own")] : []),
      ],
      defaultSelection: selected,
    },
    calls: [] as {
      path: string;
      method: string;
      body: Record<string, unknown> | undefined;
    }[],
    probeStatus: "success" as LlmProbeResult["status"],
    rejectSetup: false,
    unknownCreateOutcome: false,
    errors: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") state.errors.push(message.text());
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (path.endsWith("/events")) {
      await route.fulfill({
        contentType: "text/event-stream",
        body: ": connected\n\n",
      });
      return;
    }
    const method = request.method();
    const body =
      method === "GET"
        ? undefined
        : (request.postDataJSON() as Record<string, unknown>);
    state.calls.push({ path, method, body });
    let output: unknown = {};
    if (path === "/api/hosted/info")
      output = { hosted: true, surface: "user", csrfToken: "csrf-test" };
    else if (path === "/api/hosted/me")
      output = {
        user: {
          id: "account-a",
          username: "test-user",
          role: options.role ?? "user",
          status: "active",
          mustChangePassword: false,
        },
        wallet: {
          balanceMicros: 10000000,
          availableMicros: 10000000,
          reservedMicros: 0,
        },
        csrfToken: "csrf-test",
      };
    else if (path === "/api/hosted/models")
      output = {
        models: [
          {
            publicModelId: "public-text",
            displayName: "平台对话模型",
            kind: "text",
            inputMicrosPerMillion: 1000000,
            outputMicrosPerMillion: 2000000,
            cacheReadMicrosPerMillion: 0,
          },
          {
            publicModelId: "public-image",
            displayName: "平台图片模型",
            kind: "image",
            inputMicrosPerMillion: 0,
            outputMicrosPerMillion: 0,
            cacheReadMicrosPerMillion: 0,
            imagePointsMicros: 3000000,
          },
        ],
      };
    else if (path === "/api/llm/user-settings") {
      if (method === "PATCH") {
        expect(body?.expectedRevision).toBe(state.settings.revision);
        for (const [purpose, value] of Object.entries(
          body?.bindings as Record<string, LlmSelection | null>,
        )) {
          if (value)
            state.settings.bindings[
              purpose as keyof typeof state.settings.bindings
            ] = value;
          else
            delete state.settings.bindings[
              purpose as keyof typeof state.settings.bindings
            ];
        }
        if (body && "imageSelection" in body)
          state.settings.imageSelection =
            body.imageSelection as LlmSelection | null;
        state.settings.revision += 1;
      }
      output = state.settings;
    } else if (path === "/api/llm/setup") {
      if (state.rejectSetup) {
        state.settings.revision += 1;
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "model_settings_changed",
              message: "模型设置已在其他设备更新，请重新读取。",
            },
          },
        });
        return;
      }
      expect(body?.expectedRevision).toBe(state.settings.revision);
      state.settings.onboardingCompleted = true;
      state.settings.bindings = Object.fromEntries(
        LlmPurposeSchema.options.map((purpose) => [purpose, body?.selection]),
      );
      state.settings.revision += 1;
      output = state.settings;
    } else if (path === "/api/llm/providers" && method === "GET")
      output = state.catalog;
    else if (
      path.startsWith("/api/llm/providers") &&
      (method === "POST" || method === "PATCH")
    ) {
      const input = body as LlmProviderInput;
      const id =
        method === "POST" ? "llmprovider_added" : path.split("/").at(-1)!;
      const previous = state.catalog.providers.find((item) => item.id === id);
      const saved: LlmProviderView = {
        ...provider(id),
        name: input.name,
        baseUrl: input.baseUrl,
        protocol: input.protocol,
        models: input.models,
        revision: (previous?.revision ?? 0) + 1,
      };
      state.catalog.providers = [
        ...state.catalog.providers.filter((item) => item.id !== id),
        saved,
      ];
      if (method === "POST" && state.unknownCreateOutcome) {
        state.unknownCreateOutcome = false;
        await route.abort("failed");
        return;
      }
      output = saved;
    } else if (path === "/api/llm/models/discover")
      output = {
        models: [
          LlmModelSettingsSchema.parse({
            id: "discovered-model",
            label: "检测模型",
            capabilities: {
              structuredOutputMode: "prompt_json",
              supportsThinkingControl: false,
              supportsStreaming: false,
              maxContextTokens: 1000000,
            },
          }),
        ],
        discoveredAt: "2026-09-15T12:00:00Z",
      };
    else if (path === "/api/llm/test")
      output = {
        modelId: body?.modelId,
        status: state.probeStatus,
        testedAt: "2026-09-15T12:00:00Z",
        configRevision: body?.revision,
        text: { status: "success", latencyMs: 15, reply: "你好，连接正常。" },
        structured:
          state.probeStatus === "success"
            ? { status: "success", latencyMs: 10 }
            : {
                status: "failed",
                latencyMs: 10,
                error: "结构化回复不是有效 JSON",
              },
      };
    else if (path === "/api/llm/tests") output = { result: null };
    else if (path === "/api/characters") output = { characters: [] };
    else if (path === "/api/achievements")
      output = { notifications: [], achievements: [], total: 0 };
    await route.fulfill({ json: output });
  });
  return state;
}

test("first-use account gate protects deep links and platform setup persists through reload", async ({
  page,
}) => {
  const state = await mockAccount(page);
  await page.goto("/characters/unconfigured/chat");
  await expect(page).toHaveURL(/\/setup$/);
  await expect(
    page.getByRole("heading", { name: "我们需要确定一些设置" }),
  ).toBeVisible();
  await screenshot(page, "onboarding-choices");
  await page
    .getByRole("button", { name: "我没有API-KEY", exact: false })
    .click();
  await page.getByRole("button", { name: "平台模型", exact: true }).click();
  await page.getByRole("option", { name: "平台对话模型", exact: true }).click();
  await expect(
    page.getByText(/每百万 token 输入 1 积分，输出 2 积分/),
  ).toBeVisible();
  await screenshot(page, "onboarding-platform");
  await page.getByRole("button", { name: "使用此模型并继续" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(Object.values(state.settings.bindings)).toHaveLength(
    LlmPurposeSchema.options.length,
  );
  expect(state.settings.bindings.letter_reply).toEqual(selected);
  await page.reload();
  await expect(page.getByText("描述你梦中的他/她")).toBeVisible();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(state.calls.some((call) => call.path === "/api/llm/test")).toBe(false);
  expect(state.errors).toEqual([]);
});

test("own-key setup preserves 64000 and edited budgets, blocks partial tests, and syncs saved settings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockAccount(page);
  state.probeStatus = "partial";
  await page.goto("/welcome");
  await page.getByRole("button", { name: "我有API-KEY", exact: false }).click();
  await page
    .getByLabel("API URL", { exact: true })
    .fill("https://my-api.example/v1");
  await page.getByLabel("API Key", { exact: true }).fill("e2e-user-secret");
  await page.getByRole("button", { name: "检测模型", exact: true }).click();
  await expect(page.getByLabel("上下文预算（token）")).toHaveValue("64000");
  await screenshot(page, "onboarding-own");
  await page.getByLabel("上下文预算（token）").fill("32000");
  await page.getByRole("button", { name: "检测模型", exact: true }).click();
  await expect(page.getByLabel("上下文预算（token）")).toHaveValue("32000");
  await expect(
    page.getByText(
      "文本功能将使用你配置的 API；图片生成暂时使用平台模型，并消耗平台额度。你可以稍后单独修改。",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "测试并完成设置" }).click();
  await expect(page.getByText("模型能回复，但结构化测试未通过")).toBeVisible();
  await expect(page).toHaveURL(/\/setup$/);
  expect(state.settings.onboardingCompleted).toBe(false);
  expect(state.calls.some((call) => call.path === "/api/llm/setup")).toBe(
    false,
  );
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  state.probeStatus = "success";
  await page.getByRole("button", { name: "测试并完成设置" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(state.settings.bindings.chat_turn).toEqual({
    providerId: "llmprovider_added",
    modelId: "discovered-model",
  });
  expect(state.settings.imageSelection).toBeNull();
  expect(
    state.catalog.providers.find((item) => item.id === "llmprovider_added")
      ?.models[0]?.capabilities.maxContextTokens,
  ).toBe(32000);
  const storage = await page.evaluate(() =>
    JSON.stringify([
      Object.entries(localStorage),
      Object.entries(sessionStorage),
    ]),
  );
  expect(storage).not.toContain("e2e-user-secret");
  expect(state.errors).toEqual([]);
});

test("function settings mix model sources, batch text independently from image, and keep platform credentials hidden", async ({
  page,
}) => {
  const state = await mockAccount(page, { completed: true, own: true });
  await page.goto("/model-settings");
  await expect(
    page.getByRole("heading", { name: "模型与功能", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("API 地址", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("https://never-display-platform.invalid/v1"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "书信回复模型", exact: true }).click();
  await page.getByRole("option", { name: "我的对话模型", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "书信回复模型", exact: true }),
  ).toContainText("自己的 API");
  expect(state.settings.bindings.chat_turn).toBeUndefined();
  await page
    .getByLabel("图片生成模型", { exact: true })
    .selectOption("public-image");
  await expect(page.getByText("平台额度 · 3 积分 / 张")).toBeVisible();
  await page
    .getByRole("heading", { name: "模型与功能", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: "模型与功能", exact: true }),
  ).toBeInViewport();
  await screenshot(page, "model-settings", false);
  await page.getByRole("button", { name: "批量我的模型", exact: true }).click();
  await page.getByRole("option", { name: "我的对话模型", exact: true }).click();
  await page
    .getByRole("button", { name: "应用我的模型到全部文本功能" })
    .click();
  await expect(
    page.getByRole("button", { name: "日常聊天模型", exact: true }),
  ).toContainText("自己的 API");
  expect(Object.values(state.settings.bindings)).toHaveLength(
    LlmPurposeSchema.options.length,
  );
  expect(state.settings.imageSelection).toEqual({
    providerId: "hosted",
    modelId: "public-image",
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "日记审核模型", exact: true }),
  ).toContainText("自己的 API");
  await expect(page.getByLabel("图片生成模型", { exact: true })).toHaveValue(
    "public-image",
  );
  expect(state.errors).toEqual([]);
});

test("a setup revision conflict keeps the user in the guide until a successful save", async ({
  page,
}) => {
  const state = await mockAccount(page);
  state.rejectSetup = true;
  await page.goto("/welcome");
  await page
    .getByRole("button", { name: "我没有API-KEY", exact: false })
    .click();
  await page.getByRole("button", { name: "平台模型", exact: true }).click();
  await page.getByRole("option", { name: "平台对话模型", exact: true }).click();
  await page.getByRole("button", { name: "使用此模型并继续" }).click();
  await expect(
    page.getByText("模型设置已在其他设备更新，请重新读取。"),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/setup$/);
  state.rejectSetup = false;
  await page.getByRole("button", { name: "重新读取最新配置" }).click();
  await expect
    .poll(
      () =>
        state.calls.filter(
          (call) =>
            call.path === "/api/llm/user-settings" && call.method === "GET",
        ).length,
    )
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "使用此模型并继续" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
});

test("administrator accounts skip the first-use account gate", async ({
  page,
}) => {
  const state = await mockAccount(page, { role: "admin" });
  await page.goto("/welcome");
  await expect(page.getByText("描述你梦中的他/她")).toBeVisible();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(
    state.calls.some((call) => call.path === "/api/llm/user-settings"),
  ).toBe(false);
});

test("an uncertain provider save recovers the existing configuration instead of creating a duplicate", async ({
  page,
}) => {
  const state = await mockAccount(page);
  state.unknownCreateOutcome = true;
  await page.goto("/welcome");
  await page.getByRole("button", { name: "我有API-KEY", exact: false }).click();
  await page
    .getByLabel("API URL", { exact: true })
    .fill("https://my-api.example/v1");
  await page
    .getByLabel("API Key", { exact: true })
    .fill("secret-before-uncertain-save");
  await page.getByLabel("手动模型 ID", { exact: true }).fill("manual-model");
  await page.getByRole("button", { name: "添加模型", exact: true }).click();
  await expect(page.getByLabel("上下文预算（token）")).toHaveValue("64000");
  await page.getByRole("button", { name: "测试并完成设置" }).click();
  await expect(page.getByText(/保存请求的结果暂时无法确认/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "测试并完成设置" }),
  ).toBeDisabled();
  await page
    .getByLabel("继续使用已有供应商", { exact: true })
    .selectOption("llmprovider_added");
  await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "测试并完成设置" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(
    state.calls.filter(
      (call) => call.path === "/api/llm/providers" && call.method === "POST",
    ),
  ).toHaveLength(1);
  expect(state.settings.bindings.chat_turn).toEqual({
    providerId: "llmprovider_added",
    modelId: "manual-model",
  });
});
