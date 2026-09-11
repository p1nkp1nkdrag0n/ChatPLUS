import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type {
  Achievement,
  AchievementImageSettings,
} from "../../packages/contracts/src/achievements.js";

async function mockCollection(page: Page) {
  const items: Achievement[] = [
    {
      id: "earned-door",
      title: "初来乍到",
      description: "你第一次推开了这里的门。",
      category: "global",
      unlockedAtUtc: "2026-09-10T04:00:00.000Z",
      badge: { key: "door", status: "fixed" },
      notificationRead: false,
    },
    {
      id: "earned-star",
      title: "独一份纪念",
      description: "这一份纪念，只属于你们的故事。",
      category: "character",
      agentId: "agent-forest",
      agentName: "林间",
      unlockedAtUtc: "2026-09-10T04:01:00.000Z",
      badge: { key: "star", status: "pending" },
      notificationRead: false,
    },
    {
      id: "earned-constellation",
      title: "珍藏此刻",
      description: "把这个值得珍藏的时刻，留在这里。",
      category: "character",
      agentId: "agent-tide",
      agentName: "晚潮",
      unlockedAtUtc: "2026-09-10T04:02:00.000Z",
      badge: { key: "constellation", status: "failed" },
      notificationRead: true,
    },
  ];
  let settings: AchievementImageSettings = {
    enabled: false,
    protocol: "openai-compatible",
    baseUrl: "https://images.example.test/v1",
    model: "custom-image",
    apiKeyConfigured: false,
  };
  const calls: { path: string; method: string; body: unknown }[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body: unknown = request.postData()
        ? request.postDataJSON()
        : undefined;
      calls.push({ path: url.pathname, method: request.method(), body });
      if (url.pathname.endsWith("/events")) {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: ": connected\n\n",
        });
        return;
      }
      let response: unknown = {};
      if (url.pathname === "/api/characters") response = { characters: [] };
      else if (url.pathname === "/api/activity/visit")
        response = { serverTimeUtc: "2026-09-10T04:00:00.000Z" };
      else if (url.pathname === "/api/achievements") {
        response = {
          items: items.filter(
            (item) =>
              (!url.searchParams.get("category") ||
                url.searchParams.get("category") === "all" ||
                item.category === url.searchParams.get("category")) &&
              (!url.searchParams.get("agentId") ||
                item.agentId === url.searchParams.get("agentId")),
          ),
          notifications: items.filter((item) => !item.notificationRead),
          agents: [
            { id: "agent-forest", name: "林间" },
            { id: "agent-tide", name: "晚潮" },
          ],
          serverTimeUtc: "2026-09-10T04:00:00.000Z",
        };
      } else if (url.pathname === "/api/achievements/notifications/ack") {
        const ids = (body as { ids: string[] }).ids;
        for (const item of items)
          if (ids.includes(item.id)) item.notificationRead = true;
      } else if (url.pathname.endsWith("/badge/retry")) {
        const item = items.find((item) => url.pathname.includes(item.id));
        if (!item) throw new Error("Unknown achievement retry");
        item.badge = {
          ...item.badge,
          status: "pending",
        };
        response = item;
      } else if (url.pathname.startsWith("/api/achievements/"))
        response = items.find((item) => url.pathname.endsWith(item.id));
      else if (url.pathname === "/api/settings")
        response = {
          settings: {
            locale: "zh-CN",
            defaultTimezone: "Asia/Shanghai",
            replyGoalReviewEnabled: false,
          },
          runtime: { developerMode: false },
        };
      else if (url.pathname === "/api/llm/providers")
        response = {
          providers: [],
          defaultSelection: { providerId: "fixture", modelId: "fixture" },
        };
      else if (url.pathname === "/api/achievement-image/settings") {
        if (request.method() === "PUT")
          settings = {
            ...(body as AchievementImageSettings),
            apiKeyConfigured:
              Boolean((body as { apiKey?: string }).apiKey) ||
              settings.apiKeyConfigured,
          };
        response = {
          enabled: settings.enabled,
          protocol: settings.protocol,
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKeyConfigured: settings.apiKeyConfigured,
        };
      } else if (url.pathname === "/api/achievement-image/test")
        response = { success: true, message: "图片生成成功，配置可以使用。" };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(response),
      });
    },
  );
  return { items, calls };
}

test("earned collection filters, merged notification persistence, detail, retry, and mobile layout", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(message.text());
  });
  const state = await mockCollection(page);
  await page.goto("/achievements");
  await expect(page).toHaveTitle("Dearvale");
  await expect(
    page.getByRole("heading", { name: "成就收藏", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".achievement-card")).toHaveCount(3);
  await expect(page.locator(".achievement-toast")).toContainText(
    "获得新成就 · 2 枚纪念",
  );
  await expect
    .poll(() => state.items.every((item) => item.notificationRead))
    .toBe(true);
  expect(state.calls.some((call) => call.path === "/api/activity/visit")).toBe(
    true,
  );
  await page.getByRole("button", { name: "关闭成就提示" }).click();
  await page.getByRole("button", { name: "与角色的纪念", exact: true }).click();
  await expect(page.locator(".achievement-card")).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "角色", exact: true })
    .selectOption("agent-tide");
  await expect(page.locator(".achievement-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "查看成就：珍藏此刻，与 晚潮" })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("这枚纪念已经属于你");
  await page.getByRole("button", { name: "重新绘制", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("专属图案等待绘制");
  const completed = state.items.find(
    (item) => item.id === "earned-constellation",
  );
  if (!completed) throw new Error("Missing collection fixture");
  completed.badge = {
    key: "constellation",
    status: "ready",
    imageUrl: "/dearvale/achievements/wax-v2/constellation.webp?v=completed",
  };
  await page.reload();
  await expect(page.locator("dialog img")).toHaveAttribute(
    "src",
    "/dearvale/achievements/wax-v2/constellation.webp?v=completed",
  );
  await page.getByRole("button", { name: "关闭成就详情" }).click();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page
    .getByRole("combobox", { name: "角色", exact: true })
    .selectOption("");
  await expect(page.locator(".achievement-card")).toHaveCount(3);
  await page.screenshot({
    path: join(
      tmpdir(),
      `dearvale-achievements-${testInfo.project.name}-desktop.png`,
    ),
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "成就收藏", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".achievement-toast")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("link", { name: "成就", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: join(
      tmpdir(),
      `dearvale-achievements-${testInfo.project.name}-mobile.png`,
    ),
  });
  await page
    .getByRole("button", { name: "查看成就：独一份纪念，与 林间" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("专属图案等待绘制");
  await expect(
    page.getByRole("button", { name: "重新绘制", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
  await expect(page.locator(".achievements-page")).not.toContainText(
    /好感度|亲近度|下一档|完成率/,
  );
  state.items.length = 0;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "你的故事，正要开始" }),
  ).toBeVisible();
  await expect(page.locator(".achievement-card")).toHaveCount(0);
});

test("six wax colors sit across the note edge on desktop and two-column mobile wall", async ({
  page,
}, testInfo) => {
  const state = await mockCollection(page);
  const samples = [
    ["door", "初来乍到", "你第一次推开了这里的门。"],
    ["sprout", "三日之约", "连续三天，你都来过这里。"],
    ["sun", "一周相伴", "七个连续的日子，留下了你的足迹。"],
    ["flower", "岁月留痕", "共同走过的日子，留下了一份纪念。"],
    ["star", "独一份纪念", "这一份纪念，只属于你们的故事。"],
    ["constellation", "珍藏此刻", "把这个值得珍藏的时刻，留在这里。"],
  ] as const;
  state.items.splice(
    0,
    state.items.length,
    ...samples.map(([key, title, description], index): Achievement => ({
      id: `wax-${key}`,
      title,
      description,
      category: index < 3 ? "global" : "character",
      ...(index < 3 ? {} : { agentId: "agent-forest", agentName: "林间" }),
      unlockedAtUtc: "2026-09-11T04:00:00.000Z",
      badge: { key, status: "fixed" },
      notificationRead: true,
    })),
  );
  await page.goto("/achievements");
  await expect(page.locator(".achievement-card")).toHaveCount(6);
  await expect
    .poll(() =>
      page
        .locator(".achievement-card img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              image instanceof HTMLImageElement &&
              image.complete &&
              image.naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
  const verifyNotes = async (columns: number) => {
    const geometry = await page
      .locator(".achievement-grid")
      .evaluate((grid) => ({
        columns:
          getComputedStyle(grid).gridTemplateColumns.split(/\s+/u).length,
        cards: [...grid.querySelectorAll(".achievement-card")].map((card) => {
          const note = card.getBoundingClientRect();
          const seal = card
            .querySelector(".achievement-card__seal")!
            .getBoundingClientRect();
          const image = card.querySelector("img")!;
          return {
            attached: seal.top < note.top && seal.bottom > note.top,
            contained: getComputedStyle(image).objectFit === "contain",
            width: note.width,
          };
        }),
      }));
    expect(geometry.columns).toBe(columns);
    expect(
      geometry.cards.every(
        (card) => card.attached && card.contained && card.width > 130,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  };
  await verifyNotes(3);
  await page.screenshot({
    path: join(
      tmpdir(),
      `dearvale-wax-wall-${testInfo.project.name}-desktop.png`,
    ),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyNotes(2);
  await page.screenshot({
    path: join(
      tmpdir(),
      `dearvale-wax-wall-${testInfo.project.name}-mobile.png`,
    ),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const first = page.locator(".achievement-card").first();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "初来乍到" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(first).toBeFocused();
});

test("custom image failures fall back to matching wax, and exhausted sources stop retrying", async ({
  page,
}) => {
  const state = await mockCollection(page);
  const item = state.items[1]!;
  item.notificationRead = true;
  item.badge = {
    key: "star",
    status: "generating",
    imageUrl: "/wax-image-test/full.webp?v=retained",
    thumbnailUrl: "/wax-image-test/thumb.webp?v=retained",
  };
  state.items.splice(0, state.items.length, item);
  const attempted: string[] = [];
  await page.route("**/wax-image-test/*.webp?*", async (route) => {
    attempted.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "image/webp",
      body: "invalid image",
    });
  });
  await page.goto("/achievements");
  await expect(page.locator(".achievement-card img")).toHaveAttribute(
    "src",
    "/dearvale/achievements/wax-v2/star.thumb.webp",
  );
  expect(attempted).toHaveLength(2);
  await expect(page.locator(".achievement-card")).toContainText("独一份纪念");
  await expect(page.locator(".achievement-card")).toContainText(
    "专属图案绘制中",
  );
  await page.route(
    "**/dearvale/achievements/wax-v2/star*.webp",
    async (route) => {
      attempted.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: "invalid image",
      });
    },
  );
  attempted.length = 0;
  await page.reload();
  await expect(page.locator(".achievement-badge__fallback svg")).toBeVisible();
  await expect(page.locator(".achievement-card img")).toHaveCount(0);
  expect(attempted).toHaveLength(4);
  expect(new Set(attempted).size).toBe(4);
  await expect(
    page.getByRole("button", { name: "查看成就：独一份纪念，与 林间" }),
  ).toBeVisible();
});

test("real service records opening, publication and successful conversation as earned mementos", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(message.text());
  });
  await page.goto("/achievements");
  await expect(
    page.getByRole("button", { name: "查看成就：初来乍到", exact: true }),
  ).toBeVisible();
  const generated = await request.post("/api/characters/generate", {
    data: {
      name: `成就验收-${Date.now()}`,
      worldSetting: "当代的小城",
      workOrRole: "书店店员",
      coreTraits: ["温柔", "好奇"],
      dialogueStyle: "自然简洁",
      tier: "daily",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.ok()).toBe(true);
  const { character } = (await generated.json()) as {
    character: { id: string; version: number };
  };
  const published = await request.post(
    `/api/characters/${character.id}/publish`,
    { data: { expectedVersion: character.version } },
  );
  expect(published.ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: /^查看成就：故事的开端/ }),
  ).toBeVisible();
  await page.goto(`/characters/${character.id}/chat`);
  await expect(page.getByRole("textbox", { name: "消息内容" })).toBeVisible();
  await expect(
    page.locator(
      ".state-panel, .state-strip, .life-context-overview, .memory-recall-diagnostics",
    ),
  ).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "消息内容" })
    .fill("你好，很高兴认识你。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect
    .poll(async () => {
      const response = await request.get("/api/achievements");
      const value = (await response.json()) as { items: Achievement[] };
      return value.items.some((item) => item.title === "第一声问候");
    })
    .toBe(true);
  await page.getByRole("link", { name: "成就", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^查看成就：第一声问候/ }),
  ).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("image settings save independently and ordinary users cannot open developer tools", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(message.text());
  });
  const state = await mockCollection(page);
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "徽章生图模型" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "开发者工具" })).toHaveCount(0);
  const section = page.getByRole("region", { name: "徽章生图模型" });
  await section.getByRole("switch", { name: "绘制专属徽章" }).click();
  await section.getByLabel("图片接口协议").selectOption("gemini");
  await section.getByLabel("模型名称").fill("my-image-model");
  await section
    .getByLabel("供应商地址")
    .fill("https://images.example.test/v1beta");
  await section
    .getByLabel("API 密钥", { exact: true })
    .fill("e2e-nonsecret-placeholder");
  await section.getByRole("button", { name: "保存生图设置" }).click();
  await expect(section.getByText("已保存", { exact: true })).toBeVisible();
  await expect(section.locator('input[type="password"]')).toHaveValue("");
  expect(
    state.calls.find(
      (call) =>
        call.path === "/api/achievement-image/settings" &&
        call.method === "PUT",
    )?.body,
  ).toMatchObject({
    protocol: "gemini",
    model: "my-image-model",
    enabled: true,
  });
  await section.getByRole("button", { name: "测试已保存配置" }).click();
  await expect(section.getByRole("status")).toContainText("图片生成成功");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "e2e-nonsecret-placeholder",
  );
  await page.goto("/developer");
  await expect(
    page.getByRole("heading", { name: "开发者模式未开启" }),
  ).toBeVisible();
  expect(
    state.calls.some((call) => call.path.startsWith("/api/developer/")),
  ).toBe(false);
  expect(errors).toEqual([]);
});
