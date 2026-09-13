import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { mockConfiguredWelcomeCatalog } from "./api-onboarding-fixture";
import { answerMainQuestion } from "./character-interview-helpers";

// Browser plugin not available in this worker's skill catalog. This is the
// repository Playwright runner; the main worker performs separate in-app QA.
// Only welcome's configured-provider GET is mocked. Runtime requests below
// use the actual fixture model, isolated SQLite database, and HTTP server.
test.beforeEach(async ({ page }, info) => {
  test.skip(
    !info.config.configFile.endsWith("playwright.mobile.config.ts"),
    "Run with playwright.mobile.config.ts for isolated mobile ports and artifacts.",
  );
  await mockConfiguredWelcomeCatalog(page);
});

test("main: published character opens from library and receives a real chat reply", async ({
  page,
  request,
}, info) => {
  const errors = observeErrors(page);
  const { id, name } = await createCharacter(request, info);
  await page.goto("/characters");
  await expect(page).toHaveTitle(/Dearvale/);
  const row = page.getByTestId("character-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNavigation(page, info);
  await row
    .getByRole("link", { name: `继续聊天：${name}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/characters/${id}/chat`));
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await expectNavigation(page, info);
  await expectComposerAboveNavigation(page, info);

  const text = `今天路边的猫在晒太阳，想把这个小瞬间分享给你。${info.project.name}`;
  await input.fill(text);
  const reply = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/sessions\/[^/]+\/messages$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  expect((await reply).ok()).toBe(true);
  await expect(
    page.locator(".message-group--user .message-bubble"),
  ).toContainText(text);
  await expect(
    page.locator(".message-group--assistant .message-bubble").first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(input).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await expectComposerAboveNavigation(page, info);
  await screenshot(page, info, "chat-with-real-reply");
  expect(errors).toEqual([]);
});

test("main: history creates and switches sessions and restores focus after dismissal", async ({
  page,
  request,
}, info) => {
  const errors = observeErrors(page);
  const { id } = await createCharacter(request, info);
  await page.goto(`/characters/${id}/chat`);
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  const first = sessionId(page);
  expect(first).toBeTruthy();
  const draft = "留在第一段对话里的草稿";
  await input.fill(draft);
  const isMobile = mobile(info);
  const toggle = page.getByRole("button", {
    name: "打开历史对话",
    exact: true,
  });
  const history = isMobile
    ? page.getByRole("dialog", { name: "历史对话", exact: true })
    : page.getByRole("complementary", { name: "历史对话", exact: true });

  if (isMobile) {
    await toggle.click();
    await expect(history).toBeVisible();
    await expectMinimumTouchTarget(toggle);
    await expectMinimumTouchTarget(
      history.getByRole("button", { name: "关闭历史对话", exact: true }),
    );
    await screenshot(page, info, "history-sheet");
    await page.keyboard.press("Escape");
    await expect(history).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await history
      .getByRole("button", { name: "关闭历史对话", exact: true })
      .click();
    await expect(history).not.toBeVisible();
    await expect(toggle).toBeFocused();
    await toggle.click();
  } else {
    await expect(toggle).not.toBeVisible();
    await expect(history).toBeVisible();
  }
  await history.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect.poll(() => sessionId(page)).not.toBe(first);
  const second = sessionId(page);
  await expect(input).toHaveValue("");
  if (isMobile) {
    await expect(history).not.toBeVisible();
    await toggle.click();
  }
  await history.locator(`button[data-session-id="${first}"]`).click();
  await expect.poll(() => sessionId(page)).toBe(first);
  await expect(input).toHaveValue(draft);
  if (isMobile) {
    await expect(history).not.toBeVisible();
    await toggle.click();
  }
  await history.locator(`button[data-session-id="${second}"]`).click();
  await expect.poll(() => sessionId(page)).toBe(second);
  await expect(input).toHaveValue("");
  if (isMobile) await expect(history).not.toBeVisible();
  await page.reload();
  await expect(input).toBeEnabled();
  expect(sessionId(page)).toBe(second);
  await expectNoHorizontalOverflow(page);
  await expectComposerAboveNavigation(page, info);
  expect(errors).toEqual([]);
});

test("pages: welcome, creation, settings, letters and achievements remain usable", async ({
  page,
  request,
}, info) => {
  const errors = observeErrors(page);
  const { id } = await createCharacter(request, info);
  await page.goto("/welcome");
  await expect(
    page.getByRole("heading", { name: /欢迎来到.*Dearvale/ }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, info, "welcome");

  await page.goto("/create");
  await expect(page.getByTestId("character-generator")).toHaveAttribute(
    "data-question",
    "gender",
  );
  await expectNoHorizontalOverflow(page);
  await answerMainQuestion(page, "gender", "女性");
  await expect(page.getByTestId("character-generator")).toHaveAttribute(
    "data-question",
    "name",
  );
  await page.locator("#interview-answer").fill("小鹿");
  await expectNoHorizontalOverflow(page);
  if (mobile(info)) {
    await expectMinimumTouchTarget(page.getByTestId("interview-next"));
    await expectMinimumTouchTarget(page.locator("#interview-answer"));
  }
  await screenshot(page, info, "creation-name");

  // Set the active character through the real chat route before using tabs.
  await page.goto(`/characters/${id}/chat`);
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  for (const { label, route, heading } of [
    {
      label: "书信",
      route: `/characters/${id}/correspondence`,
      heading: "书信",
    },
    { label: "成就", route: "/achievements", heading: "成就收藏" },
    { label: "设置", route: "/settings", heading: "设置" },
    { label: "角色", route: "/characters", heading: "角色" },
  ]) {
    await page
      .locator(".app-nav")
      .getByRole("link", { name: label, exact: true })
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(route);
    await expect(
      page.getByRole("heading", { name: heading, exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.locator(".loading-block")).toHaveCount(0);
    await expect(page.locator(".error-block")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await expectNavigation(page, info);
    await screenshot(page, info, `page-${label}`);
  }
  expect(errors).toEqual([]);
});

function observeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function mobile(info: TestInfo): boolean {
  return (info.project.use.viewport?.width ?? 1440) <= 1100;
}

function sessionId(page: Page): string {
  return new URL(page.url()).searchParams.get("sessionId") ?? "";
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const measurements = await page.evaluate(() => {
    const elements: Element[] = [
      document.documentElement,
      document.body,
      ...Array.from(
        document.querySelectorAll(
          ".app-main, .page, .dearvale-chat, .chat-page, .chat-conversation, .creation-question-form",
        ),
      ),
    ];
    return elements
      .filter((element) => element.clientWidth > 0)
      .map((element) => ({
        element:
          element.tagName.toLowerCase() +
          (element.className
            ? `.${String(element.className).replace(/\s+/gu, ".")}`
            : ""),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }));
  });
  for (const measurement of measurements) {
    expect(
      measurement.scrollWidth,
      JSON.stringify(measurement),
    ).toBeLessThanOrEqual(measurement.clientWidth + 1);
  }
}

async function expectMinimumTouchTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

async function expectNavigation(page: Page, info: TestInfo): Promise<void> {
  const links = page.locator(".app-nav__item");
  await expect(links).toHaveCount(6);
  const names = await links.allTextContents();
  expect(names).toEqual(["对话", "书信", "记忆", "角色", "成就", "设置"]);
  if (!mobile(info)) return;
  for (const link of await links.all()) {
    await expect(link).toBeVisible();
    await expectMinimumTouchTarget(link);
    const box = await link.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (page.viewportSize()?.width ?? 0) + 1,
    );
  }
}

async function expectComposerAboveNavigation(
  page: Page,
  info: TestInfo,
): Promise<void> {
  if (!mobile(info)) return;
  const composer = await page.locator(".composer-wrap").boundingBox();
  const nav = await page.locator(".app-nav").boundingBox();
  expect(composer).not.toBeNull();
  expect(nav).not.toBeNull();
  expect((composer?.y ?? 0) + (composer?.height ?? 0)).toBeLessThanOrEqual(
    (nav?.y ?? 0) + 1,
  );
  await expectMinimumTouchTarget(page.getByTestId("chat-input"));
  await expectMinimumTouchTarget(
    page.getByRole("button", { name: "发送消息", exact: true }),
  );
}

async function screenshot(
  page: Page,
  info: TestInfo,
  name: string,
): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: "image/png" });
}

async function createCharacter(
  request: APIRequestContext,
  info: TestInfo,
): Promise<{ id: string; name: string }> {
  const name = `鹿宁-${info.project.name}-${Date.now()}`;
  const generated = await request.post("/api/characters/generate", {
    data: {
      name,
      worldSetting: "当代的小城",
      workOrRole: "书店店员",
      coreTraits: ["温柔", "好奇"],
      initialRelationship: "朋友",
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
    {
      data: { expectedVersion: character.version },
    },
  );
  expect(published.ok()).toBe(true);
  return { id: character.id, name };
}
