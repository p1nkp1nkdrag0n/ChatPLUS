import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { LlmModelSettingsSchema } from "../../packages/contracts/src/llm-settings.js";
import {
  fixtureCatalog,
  mockOnboardingLlm,
  onboardingProvider,
} from "./api-onboarding-fixture";

const secret = "onboarding-private-test-key";
const manualModel = "manual-chat-model";

async function expectStep(page: Page, step: string): Promise<void> {
  await expect(page.getByTestId("api-setup")).toHaveAttribute(
    "data-step",
    step,
  );
  await expect(page.getByTestId("setup-book")).toHaveAttribute(
    "data-phase",
    "idle",
  );
}

async function reachModel(page: Page, key = secret): Promise<void> {
  await page.goto("/welcome");
  await expectStep(page, "service");
  await page
    .getByLabel("API 地址", { exact: true })
    .fill("http://127.0.0.1:11434/v1");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expectStep(page, "key");
  await page.getByLabel("API Key", { exact: true }).fill(key);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expectStep(page, "model");
}

async function enterManualModel(
  page: Page,
  model = manualModel,
): Promise<void> {
  const input = page.getByLabel("模型名称", { exact: true });
  if (!(await input.isVisible())) {
    await page.getByRole("button", { name: "手动填写", exact: true }).click();
  }
  await input.fill(model);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expectStep(page, "test");
}

function writes(state: Awaited<ReturnType<typeof mockOnboardingLlm>>) {
  return state.calls.filter(
    (call) =>
      (call.path === "/api/llm/providers" && call.method === "POST") ||
      call.path === "/api/llm/default",
  );
}

async function expectNoOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test.describe("Dearvale first model setup", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("gates fixture-only welcome without leaking the normal welcome while loading", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.holdCatalog = true;
    try {
      await page.goto("/welcome");
      await expect
        .poll(
          () =>
            state.calls.filter((call) => call.path === "/api/llm/providers")
              .length,
        )
        .toBeGreaterThan(0);
      await expect(page.getByTestId("api-setup")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /欢迎来到/ })).toHaveCount(
        0,
      );
      state.releaseCatalogs();
      await expect(
        page.getByRole("heading", { name: "为故事，添一点魔法" }),
      ).toBeVisible();
      await expectStep(page, "service");
      await expect(page.getByRole("link", { name: "返回官网" })).toBeVisible();
      await expect(page.getByRole("button", { name: /跳过/ })).toHaveCount(0);
      await page.reload();
      await expectStep(page, "service");
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    } finally {
      state.releaseCatalogs();
    }
  });

  for (const source of ["managed", "environment"] as const) {
    test(`opens existing ${source} configuration with no API key directly in welcome`, async ({
      page,
    }) => {
      const provider = onboardingProvider({ source });
      const state = await mockOnboardingLlm(page, {
        providers: [provider],
        defaultSelection: {
          providerId: provider.id,
          modelId: provider.models[0].id,
        },
      });
      await page.goto("/welcome");
      await expect(
        page.getByRole("heading", { name: /欢迎来到.*Dearvale/ }),
      ).toBeVisible();
      await expect(page.getByTestId("api-setup")).toHaveCount(0);
      expect(
        state.calls.filter((call) => call.path === "/api/llm/test"),
      ).toHaveLength(0);
    });
  }

  test("retries catalog failures without assuming the catalog is empty", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.catalogUnavailable = true;
    await page.goto("/welcome");
    await expect(page.getByText(/暂时.*模型配置/)).toBeVisible();
    await expect(page.getByTestId("api-setup")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /欢迎来到/ })).toHaveCount(
      0,
    );
    state.catalogUnavailable = false;
    await page.getByRole("button", { name: /重试|重新/ }).click();
    await expectStep(page, "service");
  });

  test("offers settings repair when saved credentials cannot be read", async ({
    page,
  }) => {
    const provider = onboardingProvider({
      hasApiKey: true,
      credentialStatus: "unavailable",
    });
    const state = await mockOnboardingLlm(page, {
      providers: [provider],
      defaultSelection: { providerId: provider.id, modelId: "local-chat" },
    });
    await page.goto("/welcome");
    await expect(page.getByRole("link", { name: /设置/ })).toHaveAttribute(
      "href",
      "/settings",
    );
    await expect(page.getByRole("heading", { name: /欢迎来到/ })).toHaveCount(
      0,
    );
    expect(
      state.calls.some((call) => call.path.includes("credentials/reset")),
    ).toBe(false);
    state.catalog.providers.push(
      onboardingProvider({ id: "readable-provider" }),
    );
    await page.reload();
    await expectStep(page, "service");
    await expect(
      page.getByRole("link", { name: "修复不可读取的密钥", exact: true }),
    ).toHaveAttribute("href", "/settings");
    await expect(page.getByRole("option", { name: /需要修复/ })).toBeDisabled();
    await page
      .getByLabel("使用已有配置", { exact: true })
      .selectOption("readable-provider");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "model");
  });

  test("discovers models, requires both probes to pass, and saves once before showing welcome", async ({
    page,
  }, info) => {
    const state = await mockOnboardingLlm(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await reachModel(page);
    await expect
      .poll(
        () =>
          state.calls.filter((call) => call.path === "/api/llm/models/discover")
            .length,
      )
      .toBeGreaterThan(0);
    await expect(
      page.getByText("detected-chat", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("搜索模型", { exact: true }).fill("detected");
    await page
      .getByRole("button", { name: "detected-chat", exact: true })
      .click();
    await expect(page.getByLabel("模型名称", { exact: true })).toHaveValue(
      "detected-chat",
    );
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "test");
    state.probeStatus = "partial";
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expect(
      page.getByText("结构化回复不是有效 JSON", { exact: false }),
    ).toBeVisible();
    await expectStep(page, "test");
    expect(writes(state)).toHaveLength(0);
    state.probeStatus = "success";
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expectStep(page, "success");
    await expect(
      page.getByRole("heading", { name: "魔法已经准备好了" }),
    ).toBeVisible();
    expect(writes(state).map((call) => call.path)).toEqual([
      "/api/llm/providers",
      "/api/llm/default",
    ]);
    expect(writes(state)[0]?.body).toMatchObject({
      name: "我的模型连接",
      apiKey: secret,
      models: [expect.objectContaining({ id: "detected-chat" })],
    });
    expect(writes(state)[1]?.body).toEqual({
      selection: { providerId: "created-1", modelId: "detected-chat" },
      expectedRevision: 1,
    });
    expect(
      await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      ),
    ).not.toContain(secret);
    expect(page.url()).not.toContain(secret);
    await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: join(tmpdir(), `dearvale-api-success-${info.project.name}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "进入 Dearvale", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: /欢迎来到.*Dearvale/ }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /欢迎来到.*Dearvale/ }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("accepts a keyless service and manual model after discovery fails", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.discoveryUnavailable = true;
    await reachModel(page, "");
    await expect(
      page.getByText("服务暂时无法读取模型列表", { exact: false }),
    ).toBeVisible();
    const previousDiscoveries = state.calls.filter(
      (call) => call.path === "/api/llm/models/discover",
    ).length;
    await page
      .getByRole("button", { name: "重新读取模型", exact: true })
      .click();
    await expect
      .poll(
        () =>
          state.calls.filter((call) => call.path === "/api/llm/models/discover")
            .length,
      )
      .toBe(previousDiscoveries + 1);
    await enterManualModel(page);
    state.probeStatus = "failed";
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expect(
      page.getByText("模型没有返回可见正文", { exact: false }),
    ).toBeVisible();
    expect(writes(state)).toHaveLength(0);
    state.probeStatus = "success";
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expectStep(page, "success");
    expect(
      state.catalog.providers.find((provider) => provider.id === "created-1")
        ?.hasApiKey,
    ).toBe(false);
  });

  test("retries only setting the default after a successful create", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.defaultFailures = 1;
    await reachModel(page);
    await enterManualModel(page);
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expect(
      page.getByText("默认模型暂时保存失败，请重试", { exact: false }),
    ).toBeVisible();
    await expectStep(page, "test");
    await page.getByRole("button", { name: /保存/, exact: false }).click();
    await expectStep(page, "success");
    expect(
      state.calls.filter((call) => call.path === "/api/llm/test"),
    ).toHaveLength(1);
    expect(writes(state).map((call) => call.path)).toEqual([
      "/api/llm/providers",
      "/api/llm/default",
      "/api/llm/default",
    ]);
  });

  test("uses an existing provider without overwriting its other models or advanced settings", async ({
    page,
  }) => {
    const catalog = fixtureCatalog();
    const existing = onboardingProvider({
      hasApiKey: true,
      models: [
        LlmModelSettingsSchema.parse({
          id: "local-chat",
          thinkingLevel: "high",
        }),
        LlmModelSettingsSchema.parse({
          id: "keep-this-model",
          tokenParameter: "max_completion_tokens",
        }),
      ],
    });
    catalog.providers.push(existing);
    const before = structuredClone(existing);
    const state = await mockOnboardingLlm(page, catalog);
    await page.goto("/welcome");
    await page
      .getByLabel("使用已有配置", { exact: true })
      .selectOption(existing.id);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "model");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "test");
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expectStep(page, "success");
    expect(writes(state)).toHaveLength(1);
    expect(writes(state)[0]?.body).toEqual({
      selection: { providerId: existing.id, modelId: "local-chat" },
      expectedRevision: 3,
    });
    expect(
      state.catalog.providers.find((provider) => provider.id === existing.id),
    ).toEqual(before);
  });

  test("recovers an uncertain creation by choosing the saved provider without duplicating it", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.loseCreateResponse = true;
    await reachModel(page);
    await enterManualModel(page);
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("保存结果暂时无法确认");
    await expect(
      page.getByRole("button", { name: "测试并保存", exact: true }),
    ).toBeDisabled();
    expect(writes(state)).toHaveLength(1);
    await page
      .getByRole("button", { name: "返回连接服务", exact: true })
      .click();
    await expectStep(page, "service");
    await page
      .getByLabel("使用已有配置", { exact: true })
      .selectOption("created-1");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "model");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "test");
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expectStep(page, "success");
    expect(
      state.calls.filter(
        (call) => call.path === "/api/llm/providers" && call.method === "POST",
      ),
    ).toHaveLength(1);
    expect(state.catalog.defaultSelection).toEqual({
      providerId: "created-1",
      modelId: manualModel,
    });
  });

  test("requires explicit confirmation before creating again after recovery finds no saved provider", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.createFailures = 1;
    await reachModel(page);
    await enterManualModel(page);
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("保存结果暂时无法确认");
    expect(state.catalog.providers).toHaveLength(1);
    await page
      .getByRole("button", { name: "返回连接服务", exact: true })
      .click();
    await expectStep(page, "service");
    await expect(
      page.getByRole("button", { name: "下一步", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "确认未保存，新建连接", exact: true })
      .click();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "key");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "model");
    await enterManualModel(page);
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expectStep(page, "success");
    expect(state.catalog.providers).toHaveLength(2);
    expect(
      state.calls.filter(
        (call) => call.path === "/api/llm/providers" && call.method === "POST",
      ),
    ).toHaveLength(2);
  });

  test("holds navigation until an in-flight default save settles", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.holdDefault = true;
    try {
      await reachModel(page);
      await enterManualModel(page);
      await page
        .getByRole("button", { name: "测试并保存", exact: true })
        .click();
      await expect
        .poll(
          () =>
            state.calls.filter((call) => call.path === "/api/llm/default")
              .length,
        )
        .toBe(1);
      await page.getByRole("link", { name: "返回官网", exact: true }).click();
      await expect(
        page.getByText("正在保存，完成后将离开。", { exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/welcome$/);
      await expect(
        page.getByRole("button", { name: "正在保存配置…", exact: true }),
      ).toBeDisabled();
      state.releaseDefaults();
      await expect(page).toHaveURL(/:\d+\/$/);
      expect(state.catalog.defaultSelection).toEqual({
        providerId: "created-1",
        modelId: manualModel,
      });
      expect(writes(state)).toHaveLength(2);
    } finally {
      state.releaseDefaults();
    }
  });

  test("cancels a probe and ignores its late success after the model changes", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.holdProbe = true;
    try {
      await reachModel(page);
      await enterManualModel(page);
      await page
        .getByRole("button", { name: "测试并保存", exact: true })
        .click();
      await expect
        .poll(
          () =>
            state.calls.filter((call) => call.path === "/api/llm/test").length,
        )
        .toBe(1);
      await page.getByRole("button", { name: "取消测试", exact: true }).click();
      await expect(page.getByText(/已取消/)).toBeVisible();
      await page.getByRole("button", { name: "上一步", exact: true }).click();
      await expectStep(page, "model");
      await enterManualModel(page, "replacement-model");
      state.releaseProbes();
      await expect.poll(() => state.completedProbes).toBe(1);
      await expectStep(page, "test");
      expect(writes(state)).toHaveLength(0);
      await page
        .getByRole("button", { name: "测试并保存", exact: true })
        .click();
      await expectStep(page, "success");
      expect(state.catalog.defaultSelection.modelId).toBe("replacement-model");
    } finally {
      state.releaseProbes();
    }
  });

  test("requires retesting when a saved provider revision changes", async ({
    page,
  }) => {
    const state = await mockOnboardingLlm(page);
    state.defaultConflict = true;
    await reachModel(page);
    await enterManualModel(page);
    await page.getByRole("button", { name: "测试并保存", exact: true }).click();
    await expect(page.getByText(/配置.*变化/)).toBeVisible();
    await expectStep(page, "test");
    state.defaultConflict = false;
    await page.getByRole("button", { name: /测试.*保存/ }).click();
    await expectStep(page, "success");
    expect(
      state.calls.filter((call) => call.path === "/api/llm/test"),
    ).toHaveLength(2);
    expect(
      state.calls.filter(
        (call) => call.path === "/api/llm/providers" && call.method === "POST",
      ),
    ).toHaveLength(1);
  });

  test("forgets unsaved keys on reload and validates the service before turning", async ({
    page,
  }) => {
    await mockOnboardingLlm(page);
    await page.goto("/welcome");
    await page
      .getByLabel("API 地址", { exact: true })
      .fill("not-an-api-address");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "service");
    await expect(page.getByTestId("turning-page")).toHaveCount(0);
    await page
      .getByLabel("API 地址", { exact: true })
      .fill("http://localhost:11434/v1");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "key");
    await page.getByLabel("API Key", { exact: true }).fill(secret);
    await page.reload();
    await expectStep(page, "service");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "key");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
  });

  test("provides the existing default root address for each supported protocol", async ({
    page,
  }) => {
    await mockOnboardingLlm(page);
    await page.goto("/welcome");
    await expectStep(page, "service");
    const protocol = page.getByLabel("接口类型", { exact: true });
    const address = page.getByLabel("API 地址", { exact: true });
    await expect(address).toHaveValue("https://api.openai.com/v1");
    await protocol.selectOption("anthropic");
    await expect(address).toHaveValue("https://api.anthropic.com/v1");
    await protocol.selectOption("gemini");
    await expect(address).toHaveValue(
      "https://generativelanguage.googleapis.com/v1beta",
    );
    await protocol.selectOption("openai-compatible");
    await expect(address).toHaveValue("https://api.openai.com/v1");
  });
});

test.describe("Dearvale spellbook page turns", () => {
  test("turns the old paper first, then reveals the next form and restores fields when turning back", async ({
    page,
  }, info) => {
    await mockOnboardingLlm(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/welcome");
    await expectStep(page, "service");
    await page
      .getByLabel("API 地址", { exact: true })
      .fill("http://localhost:11434/v1");
    await page.screenshot({
      path: join(tmpdir(), `dearvale-api-service-${info.project.name}.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "下一步", exact: true })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
    const paper = page.getByTestId("turning-page");
    await expect(paper).toBeAttached();
    await paper.evaluate((element) => {
      for (const animation of element.getAnimations()) {
        animation.pause();
        animation.currentTime = 360;
      }
    });
    await expect(page.getByTestId("setup-book")).toHaveAttribute(
      "data-phase",
      "turning",
    );
    await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("api-setup")).toHaveAttribute(
      "data-step",
      "service",
    );
    await page.screenshot({
      path: join(tmpdir(), `dearvale-api-midturn-${info.project.name}.png`),
      fullPage: true,
    });
    await paper.evaluate((element) =>
      element.getAnimations().forEach((animation) => animation.play()),
    );
    await expectStep(page, "key");
    await expect(
      page.getByRole("heading", { name: "写下你的 API Key", exact: true }),
    ).toBeFocused();
    await page.getByLabel("API Key", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "显示密钥", exact: true }).click();
    await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
      "type",
      "text",
    );
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.getByLabel("模型名称", { exact: true })).toHaveCount(0);
    await expectStep(page, "model");
    await page.getByRole("button", { name: "上一步", exact: true }).click();
    await expect(page.getByTestId("setup-book")).toHaveAttribute(
      "data-phase",
      "turning",
    );
    await expectStep(page, "key");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveValue(
      secret,
    );
    await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await page.getByRole("button", { name: "上一步", exact: true }).click();
    await expectStep(page, "service");
    await expect(page.getByLabel("API 地址", { exact: true })).toHaveValue(
      "http://localhost:11434/v1",
    );
    await expectNoOverflow(page);
  });

  test("finishes safely when reduced motion changes during a page turn", async ({
    page,
  }) => {
    await mockOnboardingLlm(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/welcome");
    await expectStep(page, "service");
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("setup-book")).toHaveAttribute(
      "data-phase",
      "turning",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expectStep(page, "key");
    await expect(page.getByTestId("turning-page")).toHaveCount(0);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "model");
    await expect(page.getByTestId("turning-page")).toHaveCount(0);
  });

  test("keeps a narrow spellbook readable without horizontal overflow, including during turns", async ({
    page,
  }, info) => {
    await mockOnboardingLlm(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/welcome");
    await expectStep(page, "service");
    await expectNoOverflow(page);
    await page.screenshot({
      path: join(tmpdir(), `dearvale-api-mobile-${info.project.name}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("setup-book")).toHaveAttribute(
      "data-phase",
      "turning",
    );
    await expectNoOverflow(page);
    await expectStep(page, "key");
    await page.getByLabel("API Key", { exact: true }).fill(secret);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "model");
    await enterManualModel(
      page,
      "long-model-identifier-for-narrow-mobile-layout-with-extra-provider-details-2026-09",
    );
    await expectNoOverflow(page);
    await page.screenshot({
      path: join(
        tmpdir(),
        `dearvale-api-mobile-summary-${info.project.name}.png`,
      ),
      fullPage: true,
    });
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
});

test.describe("Dearvale spellbook animation recovery", () => {
  async function freezeFallbackTimers(page: Page) {
    const time = new Date("2026-09-11T06:00:00.000Z");
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 1000));
  }

  test("recovers a cancelled leaf animation once after switching tabs", async ({
    page,
    context,
  }) => {
    await mockOnboardingLlm(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/welcome");
    await expectStep(page, "service");
    await freezeFallbackTimers(page);
    await page.evaluate(() => {
      const root = document.querySelector('[data-testid="api-setup"]');
      const recorded = window as Window & { setupStepChanges?: string[] };
      recorded.setupStepChanges = [];
      new MutationObserver(() =>
        recorded.setupStepChanges?.push(root.getAttribute("data-step") ?? ""),
      ).observe(root, { attributes: true, attributeFilter: ["data-step"] });
    });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const paper = page.getByTestId("turning-page");
    await expect(paper).toBeAttached();
    await paper.evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .forEach((animation) => animation.cancel()),
    );
    await expect(page.getByTestId("setup-book")).toHaveAttribute(
      "data-phase",
      "turning",
    );
    const otherTab = await context.newPage();
    await otherTab.bringToFront();
    await page.bringToFront();
    await otherTab.close();
    await page.clock.runFor(1500);
    await expectStep(page, "key");
    await page.clock.runFor(3000);
    await expectStep(page, "key");
    expect(
      await page.evaluate(
        () =>
          (window as Window & { setupStepChanges?: string[] }).setupStepChanges,
      ),
    ).toEqual(["key"]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "model");
    await page.clock.resume();
  });

  test("keeps the revealed form inert until the reveal finishes and then focuses its heading", async ({
    page,
  }) => {
    await mockOnboardingLlm(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/welcome");
    await expectStep(page, "service");
    await freezeFallbackTimers(page);
    await page.evaluate(() => {
      const book = document.querySelector('[data-testid="setup-book"]');
      const observer = new MutationObserver(() => {
        if (book.getAttribute("data-phase") !== "revealing") return;
        const form = book.querySelector(".setup-form");
        for (const animation of form.getAnimations()) {
          animation.pause();
          animation.currentTime = 80;
        }
        observer.disconnect();
      });
      observer.observe(book, {
        attributes: true,
        attributeFilter: ["data-phase"],
      });
    });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const paper = page.getByTestId("turning-page");
    await expect(paper).toBeAttached();
    await paper.evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .forEach((animation) => animation.finish()),
    );
    await expect(page.getByTestId("setup-book")).toHaveAttribute(
      "data-phase",
      "revealing",
    );
    await expect(page.getByTestId("api-setup")).toHaveAttribute(
      "data-step",
      "key",
    );
    await expect(page.getByLabel("API Key", { exact: true })).toBeAttached();
    await expect(
      page.locator('.setup-progress [aria-current="step"]'),
    ).toContainText("填写密钥");
    await expect(page.locator(".setup-leaf-front")).toHaveAttribute(
      "inert",
      "",
    );
    await expect(page.getByLabel("API Key", { exact: true })).toBeDisabled();
    const opacity = await page
      .locator(".setup-form")
      .evaluate((element) => Number(getComputedStyle(element).opacity));
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    await page
      .getByLabel("API Key", { exact: true })
      .evaluate((element: HTMLInputElement) => element.focus());
    await expect(page.getByLabel("API Key", { exact: true })).not.toBeFocused();
    await page
      .locator(".setup-form")
      .evaluate((element) =>
        element.getAnimations().forEach((animation) => animation.play()),
      );
    await page.clock.resume();
    await expectStep(page, "key");
    await expect(page.locator(".setup-leaf-front")).not.toHaveAttribute(
      "inert",
    );
    await expect(
      page.getByRole("heading", { name: "写下你的 API Key", exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel("API Key", { exact: true })).toBeEnabled();
  });

  test("discards old transition callbacks after navigating away and returning to welcome", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockOnboardingLlm(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/welcome");
    await expectStep(page, "service");
    await freezeFallbackTimers(page);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("setup-book")).toHaveAttribute(
      "data-phase",
      "turning",
    );
    await page.getByRole("link", { name: "返回官网", exact: true }).click();
    await expect(page).toHaveURL(/:\d+\/$/);
    await expect(page.getByTestId("api-setup")).toHaveCount(0);
    await expect(page.locator(".story-stage")).toBeVisible();
    const refreshedCatalog = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/llm/providers",
    );
    await page.goBack();
    await refreshedCatalog;
    // React Query schedules observer notifications using a timer too.
    await page.clock.runFor(100);
    await expectStep(page, "service");
    await page.clock.runFor(3000);
    await expectStep(page, "service");
    await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expectStep(page, "key");
    expect(errors).toEqual([]);
    await page.clock.resume();
  });

  test("locks the mobile leaf dimensions when viewport height changes during a turn", async ({
    page,
  }) => {
    await mockOnboardingLlm(page);
    // This simulates viewport resizing only; it does not emulate a physical keyboard.
    await page.setViewportSize({ width: 390, height: 580 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/welcome");
    await expectStep(page, "service");
    await freezeFallbackTimers(page);
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const paper = page.getByTestId("turning-page");
    await expect(paper).toBeAttached();
    const before = await paper.evaluate((element: HTMLElement) => {
      element.getAnimations({ subtree: true }).forEach((animation) => {
        animation.pause();
        animation.currentTime = 240;
      });
      return {
        width: element.offsetWidth,
        height: element.offsetHeight,
        lockedWidth: element.style.getPropertyValue("--turn-width"),
        lockedHeight: element.style.getPropertyValue("--turn-height"),
      };
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await paper.evaluate((element: HTMLElement) => ({
        width: element.offsetWidth,
        height: element.offsetHeight,
        lockedWidth: element.style.getPropertyValue("--turn-width"),
        lockedHeight: element.style.getPropertyValue("--turn-height"),
      })),
    ).toEqual(before);
    expect(before.lockedWidth).not.toBe("");
    expect(before.lockedHeight).not.toBe("");
    await expectNoOverflow(page);
    await expect(page.getByLabel("API Key", { exact: true })).toHaveCount(0);
    await paper.evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .forEach((animation) => animation.play()),
    );
    await page.clock.resume();
    await expectStep(page, "key");
    await expectNoOverflow(page);
  });
});
