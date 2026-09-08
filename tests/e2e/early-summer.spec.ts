import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

const chapters = [
  { id: "sky-meadow", title: /让相遇，\s*慢慢成为故事。/ },
  { id: "forest-stream", title: /不只是回答你，\s*也记住你说过的话。/ },
  { id: "writing-desk", title: /有些话，\s*值得慢慢抵达。/ },
  { id: "ocean", title: /故事不必\s*一开始就完整。/ },
] as const;

test.describe("early-summer public story", () => {
  test("only the first chapter downloads art until another chapter is entered", async ({
    page,
  }) => {
    const sceneRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/art\/early-summer\/s0[1-4]\//.test(path)) sceneRequests.push(path);
    });
    await page.goto("/about");
    await expect(page.locator("#sky-meadow")).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator("#sky-meadow img")
          .evaluateAll(
            (images) =>
              images.length > 0 &&
              images.every(
                (image) => (image as HTMLImageElement).naturalWidth > 0,
              ),
          ),
      )
      .toBe(true);
    expect(sceneRequests.some((path) => path.includes("/s01/"))).toBe(true);
    expect(sceneRequests.filter((path) => /\/s0[2-4]\//.test(path))).toEqual(
      [],
    );
    for (const [index, chapter] of chapters.slice(1).entries()) {
      const scene = page.locator(`#${chapter.id}`);
      await scene.scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          scene
            .locator("img")
            .evaluateAll((images) =>
              images.every(
                (image) => (image as HTMLImageElement).naturalWidth > 0,
              ),
            ),
        )
        .toBe(true);
      expect(
        sceneRequests.some((path) => path.includes(`/s0${index + 2}/`)),
      ).toBe(true);
    }
  });

  test("the guide footer returns to the first chapter with heading focus", async ({
    page,
  }) => {
    await page.goto("/start");
    const returnToStory = page.getByRole("link", {
      name: "回到初夏的风里",
      exact: true,
    });
    await returnToStory.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    await returnToStory.click();
    await expect(page).toHaveURL("/about");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator("#site-title")).toBeFocused();
    await expect(
      page.getByRole("link", { name: "开始使用", exact: true }).first(),
    ).toBeVisible();
  });

  test("without JavaScript the story and installation link remain readable", async ({
    browser,
    baseURL,
    page,
  }) => {
    if (!baseURL)
      throw new Error("This test requires the isolated web fixture");
    const staticPage = await browser.newPage({
      javaScriptEnabled: false,
      viewport: page.viewportSize() ?? { width: 1280, height: 720 },
    });
    const apiRequests: string[] = [];
    staticPage.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        apiRequests.push(request.url());
    });
    try {
      await staticPage.goto(new URL("/about", baseURL).href);
      for (const [index, chapter] of chapters.entries()) {
        await expect(
          staticPage.getByRole("heading", {
            name: chapter.title,
            level: index === 0 ? 1 : 2,
          }),
        ).toBeVisible();
      }
      const start = staticPage.getByRole("link", {
        name: "开始使用",
        exact: true,
      });
      await expect(start).toHaveAttribute("href", "#static-start");
      await start.click();
      await expect(staticPage).toHaveURL(/\/about#static-start$/);
      await expect(staticPage.locator("#static-start")).toBeVisible();
      await expect(
        staticPage.getByRole("link", { name: "阅读完整使用文档" }),
      ).toHaveAttribute(
        "href",
        "https://github.com/p1nkp1nkdrag0n/ChatPLUS#readme",
      );
      await expect(staticPage.locator("#root")).toBeEmpty();
      expect(apiRequests).toEqual([]);
    } finally {
      await staticPage.close();
    }
  });

  test("four chapters and explicit demonstrations stay entirely public", async ({
    page,
  }) => {
    const apiRequests: string[] = [];
    const errors: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/")) {
        apiRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await rememberCharacter(page, "must-not-be-activated-by-public-page");
    await page.goto("/about");
    await expect(page).toHaveURL("/about");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    for (const chapter of chapters) {
      await expect(
        page
          .locator(`#${chapter.id}`)
          .getByRole("heading", { name: chapter.title }),
      ).toBeAttached();
    }
    const firstStart = page
      .getByRole("link", { name: "开始使用", exact: true })
      .first();
    await expect(firstStart).toBeVisible();
    await expect(firstStart).toHaveAttribute("href", "/start");
    const headings = await page
      .locator(".marketing-page h1, .marketing-page h2")
      .allTextContents();
    expect(headings.join(" ")).not.toMatch(/接住|接得住/);

    await expect(
      page.getByText("今天想再画一张。", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "查看后续对话", exact: true })
      .click();
    await expect(
      page.getByText("今天想再画一张。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("还想画溪流，还是换个题材？", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("关于那片水光", { exact: true })).toHaveCount(
      0,
    );
    const openDemo = page.getByRole("button", {
      name: "查看书信演示",
      exact: true,
    });
    await openDemo.scrollIntoViewIfNeeded();
    await page.clock.install({ time: new Date("2026-09-08T00:00:00.000Z") });
    await page.clock.pauseAt(new Date("2026-09-08T00:00:00.100Z"));
    await openDemo.click();
    const skip = page.getByRole("button", { name: "跳过动画", exact: true });
    await expect(skip).toBeVisible();
    await skip.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "关于那片水光", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/今天沿着溪边走了一段路/)).toBeVisible();
    await page.locator("#sky-meadow").scrollIntoViewIfNeeded();
    await page.locator("#writing-desk").scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("heading", { name: "关于那片水光", exact: true }),
    ).toBeVisible();
    await expect(skip).toHaveCount(0);
    expect(apiRequests).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: test.info().outputPath("public-letter-open.png"),
    });
  });

  test("motion settings follow system changes and persist the still override", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/about");
    const story = page.locator(".marketing-page");
    const preference = page.getByRole("combobox", {
      name: "场景动态",
      exact: true,
    });
    await expect(story).toHaveAttribute("data-motion", "normal");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(story).toHaveAttribute("data-motion", "reduced");
    await preference.selectOption("still");
    await expect(story).toHaveAttribute("data-motion", "still");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(story).toHaveAttribute("data-motion", "still");
    await expect
      .poll(() =>
        story.evaluate(
          (element) =>
            element
              .getAnimations({ subtree: true })
              .filter((animation) => animation.playState === "running").length,
        ),
      )
      .toBe(0);
    await page.reload();
    await expect(preference).toHaveValue("still");
    await expect(story).toHaveAttribute("data-motion", "still");
    await preference.selectOption("reduced");
    await expect(story).toHaveAttribute("data-motion", "reduced");
    await preference.selectOption("auto");
    await expect(story).toHaveAttribute("data-motion", "normal");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(story).toHaveAttribute("data-motion", "reduced");
  });

  test("native scrolling, chapter anchors and browser history remain usable", async ({
    page,
  }) => {
    await page.goto("/about");
    await expect(page.locator("#sky-meadow")).toBeVisible();
    const scrollBehavior = await page.evaluate(() => ({
      bodyOverflow: getComputedStyle(document.body).overflowY,
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
    }));
    expect(scrollBehavior.bodyOverflow).not.toBe("hidden");
    expect(scrollBehavior.rootOverflow).not.toBe("hidden");
    await page.keyboard.press("Control+End");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollHeight -
            window.innerHeight -
            window.scrollY,
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.keyboard.press("Control+Home");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.locator('a[href="#forest-stream"]').first().click();
    await expect(page).toHaveURL(/\/about#forest-stream$/);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(100);
    await page.goBack();
    await expect(page).toHaveURL("/about");
    await page.goForward();
    await expect(page).toHaveURL(/\/about#forest-stream$/);
    await expect(
      page.locator("#forest-stream").getByRole("heading"),
    ).toBeVisible();
  });

  test("offscreen scenes pause and hiding the document clears active motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/about");
    const meadow = page.locator('[data-scene="S01"]');
    const ocean = page.locator('[data-scene="S04"]');
    await expect(meadow).toHaveAttribute("data-active", "true");
    await expect(ocean).toHaveAttribute("data-active", "false");
    await ocean.scrollIntoViewIfNeeded();
    await expect(meadow).toHaveAttribute("data-active", "false");
    await expect(ocean).toHaveAttribute("data-active", "true");
    expect(
      await meadow
        .locator(".scene-layer img")
        .evaluateAll((images) =>
          images.every(
            (image) => getComputedStyle(image).animationPlayState === "paused",
          ),
        ),
    ).toBe(true);
    // Exercise the document visibility event seam deterministically; the test
    // does not claim to measure OS window minimization or background throttling.
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(ocean).toHaveAttribute("data-active", "false");
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(ocean).toHaveAttribute("data-active", "true");
  });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 900 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ]) {
    test(`all chapters fit ${viewport.width}x${viewport.height} without horizontal overflow`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto("/about");
      await expect(page.locator(".marketing-page")).toBeVisible();
      for (const chapter of chapters) {
        await page.locator(`#${chapter.id}`).scrollIntoViewIfNeeded();
        await expect(
          page
            .locator(`#${chapter.id}`)
            .getByRole("heading", { name: chapter.title }),
        ).toBeVisible();
        const layout = await page.evaluate(() => ({
          width: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
      }
      await page.locator("#sky-meadow").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`public-${viewport.width}.png`),
      });
    });
  }

  test("images failing to load leave the story and navigation usable", async ({
    page,
  }) => {
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() === "image") await route.abort();
      else await route.continue();
    });
    await page.goto("/about");
    for (const chapter of chapters) {
      await page.locator(`#${chapter.id}`).scrollIntoViewIfNeeded();
      await expect(
        page
          .locator(`#${chapter.id}`)
          .getByRole("heading", { name: chapter.title }),
      ).toBeVisible();
    }
    const start = page
      .getByRole("link", { name: "开始使用", exact: true })
      .last();
    await start.click();
    await expect(page).not.toHaveURL(/\/about/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
});

test.describe("early-summer entry and daily regressions", () => {
  test("explicit create and import links are not replaced by onboarding", async ({
    page,
  }) => {
    for (const path of ["/create", "/import"]) {
      await page.goto(path);
      await expect(page).toHaveURL(path);
      await expect(page.getByLabel("角色名称")).toBeVisible();
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "欢迎来到 ChatPLUS" }),
      ).toHaveCount(0);
    }
  });

  test("IME confirmation and Shift+Enter preserve the draft without sending", async ({
    page,
    request,
  }) => {
    const characterId = await createPublishedCharacter(request, "输入法验收");
    const messageRequests: string[] = [];
    const sceneRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/api\/sessions\/[^/]+\/messages$/.test(request.url())
      ) {
        messageRequests.push(request.url());
      }
      if (/\/marketing\/|\/early-summer\/s0[1-4][/.-]/i.test(request.url())) {
        sceneRequests.push(request.url());
      }
    });
    await page.goto(`/characters/${characterId}/chat`);
    const input = page.getByTestId("chat-input");
    await expect(input).toBeVisible();
    await input.fill("今天路边的花开了");
    await input.dispatchEvent("compositionstart", { data: "花" });
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      isComposing: true,
      keyCode: 229,
      bubbles: true,
    });
    await input.dispatchEvent("compositionend", { data: "花" });
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("今天路边的花开了\n");
    expect(messageRequests).toEqual([]);
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/sessions\/[^/]+\/messages$/.test(response.url()),
    );
    await input.press("Enter");
    expect((await sent).ok()).toBe(true);
    await expect(input).toHaveValue("");
    expect(messageRequests).toHaveLength(1);
    expect(sceneRequests).toEqual([]);
  });

  test("an SSE message refresh preserves a reader's history position", async ({
    page,
    request,
  }) => {
    const characterId = await createPublishedCharacter(request, "历史阅读验收");
    const sessionResponse = await request.post(
      `/api/agents/${characterId}/sessions`,
      { data: {} },
    );
    expect(sessionResponse.ok()).toBe(true);
    const sessionBody = (await sessionResponse.json()) as {
      id?: string;
      session?: { id: string };
    };
    const sessionId = sessionBody.session?.id ?? sessionBody.id;
    expect(sessionId).toBeTruthy();
    const history = Array.from({ length: 45 }, (_, index) => ({
      id: `history-${index}`,
      agentId: characterId,
      sessionId,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `第 ${index + 1} 段共同经历。${"溪边的树影慢慢落在水面，今天的风也很轻。".repeat(4)}`,
      createdAtUtc: "2026-09-03T04:00:00.000Z",
    }));
    await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({ json: { messages: history } });
    });
    await rememberCharacter(page, characterId);
    await page.goto(`/characters/${characterId}/chat`);
    await expect(page.locator(".message-group")).toHaveCount(45);
    const list = page.locator(".message-list");
    await expect
      .poll(() =>
        list.evaluate((element) => element.scrollHeight - element.clientHeight),
      )
      .toBeGreaterThan(500);
    await list.evaluate((element) => {
      element.scrollTo({ top: 180, behavior: "instant" });
      element.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => list.evaluate((element) => element.scrollTop))
      .toBe(180);
    history.push({
      id: "history-incoming",
      agentId: characterId,
      sessionId,
      role: "assistant",
      text: "历史阅读中的新消息不应抢走阅读位置。",
      createdAtUtc: "2026-09-03T04:00:01.000Z",
    });
    const sent = await request.post(`/api/sessions/${sessionId}/messages`, {
      data: {
        agentId: characterId,
        clientMessageId: `history-event-${test.info().project.name}-${Date.now()}`,
        text: "触发隔离 fixture 的消息更新事件。",
      },
    });
    expect(sent.ok()).toBe(true);
    await expect(page.locator(".message-group")).toHaveCount(46);
    // Observe frames after the DOM update so a deferred smooth scroll cannot
    // make an immediate scrollTop assertion pass before the animation starts.
    const positions = await list.evaluate(async (element) => {
      const values: number[] = [];
      for (let frame = 0; frame < 40; frame += 1) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        values.push(element.scrollTop);
      }
      return values;
    });
    expect(Math.min(...positions)).toBe(180);
    expect(Math.max(...positions)).toBe(180);
    await expect(
      page.getByText("历史阅读中的新消息不应抢走阅读位置。", { exact: true }),
    ).toBeAttached();
    const latest = page.getByRole("button", {
      name: "查看新消息",
      exact: true,
    });
    await expect(latest).toBeVisible();
    await latest.click();
    await expect
      .poll(() =>
        list.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThan(72);
    await expect(latest).toHaveCount(0);
  });

  test("an unopened reply stays out of DOM and caches, including a failed open", async ({
    page,
    request,
  }) => {
    const characterId = await createPublishedCharacter(
      request,
      "启封隐私验收",
      "high_fidelity",
    );
    const suffix = `${test.info().project.name}-${Date.now()}`;
    const drafted = await request.post(`/api/agents/${characterId}/letters`, {
      data: {
        clientRequestId: `privacy-draft-${suffix}`,
        subject: "等水光慢慢抵达",
        body: "这是一封隔离 fixture 来信，用来核查启封边界。",
      },
    });
    expect(drafted.ok()).toBe(true);
    const draft = (await drafted.json()) as { letter: { id: string } };
    const sealed = await request.post(`/api/letters/${draft.letter.id}/seal`, {
      data: { clientRequestId: `privacy-seal-${suffix}` },
    });
    expect(sealed.ok()).toBe(true);
    await advanceClock(request, 5);
    const mailbox = await request.get(
      `/api/agents/${characterId}/correspondence`,
    );
    expect(mailbox.ok()).toBe(true);
    const mailboxBody = (await mailbox.json()) as {
      letters: Array<{ id: string; direction: string }>;
    };
    const incoming = mailboxBody.letters.find(
      (letter) => letter.direction === "agent_to_user",
    );
    expect(incoming).toBeDefined();
    if (!incoming)
      throw new Error("Fixture did not generate the expected reply");
    await advanceClock(request, 5);
    const detail = await request.get(`/api/letters/${incoming.id}`);
    expect(detail.ok()).toBe(true);
    const safeDetail = await detail.text();
    expect(safeDetail).not.toMatch(
      /"(?:subject|body|salutation|closing|signature|ciphertext|authTag|encryptedBody)"/u,
    );
    const consoleMessages: string[] = [];
    let openRequests = 0;
    page.on("console", (message) => consoleMessages.push(message.text()));
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/api/letters/${incoming.id}/open`)
      ) {
        openRequests += 1;
      }
    });
    await rememberCharacter(page, characterId);
    await page.goto(`/letters/${incoming.id}?agentId=${characterId}`);
    const open = page.getByRole("button", { name: "启封阅读", exact: true });
    await expect(open).toBeVisible();
    await expect(page.locator(".letter-paper__body")).toHaveCount(0);
    const beforeOpen = {
      html: await page.content(),
      cached: await readClientCaches(page),
      storage: await readBrowserStorage(page),
      url: page.url(),
    };
    await page.route(
      `**/api/letters/${incoming.id}/open`,
      async (route) => {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: "fixture_open_unavailable",
              message: "隔离测试：这次启封未成功。",
            },
          },
        });
      },
      { times: 1 },
    );
    await open.click();
    await expect(
      page.getByText("隔离测试：这次启封未成功。", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".letter-paper__body")).toHaveCount(0);
    await expect(open).toBeEnabled();
    await page.clock.install({ time: new Date("2026-09-08T00:00:00.000Z") });
    await page.clock.pauseAt(new Date("2026-09-08T00:00:00.100Z"));
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/letters/${incoming.id}/open`),
    );
    await open.focus();
    await page.keyboard.press("Enter");
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const opened = (await response.json()) as { body: string };
    const skip = page.getByRole("button", { name: "跳过展开", exact: true });
    await expect(skip).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem("chatplus.motion.v1", "still");
      window.dispatchEvent(new Event("chatplus-motion-change"));
    });
    // The browser clock remains paused before the 900 ms reveal timer: changing
    // the setting must reveal the mounted response without another open request.
    await expect(page.locator(".letter-paper__body")).toHaveText(opened.body);
    expect(openRequests).toBe(2);
    expect(opened.body.length).toBeGreaterThan(10);
    for (const value of [safeDetail, ...Object.values(beforeOpen)])
      expect(value).not.toContain(opened.body);
    expect(await readClientCaches(page)).not.toContain(opened.body);
    expect(await readBrowserStorage(page)).not.toContain(opened.body);
    expect(consoleMessages.join("\n")).not.toContain(opened.body);
    expect(page.url()).not.toContain(opened.body);
    await page.getByRole("link", { name: "返回书信", exact: true }).click();
    await expect(page).toHaveURL(`/characters/${characterId}/correspondence`);
    await expect(page.locator(".letter-paper__body")).toHaveCount(0);
    expect(await readClientCaches(page)).not.toContain(opened.body);
    expect(await page.content()).not.toContain(opened.body);
  });
});

async function createPublishedCharacter(
  request: APIRequestContext,
  name: string,
  tier: "daily" | "high_fidelity" = "daily",
): Promise<string> {
  const generatedResponse = await request.post("/api/characters/generate", {
    data: {
      name: `${name}-${test.info().project.name}-${Date.now()}`,
      worldSetting: "当代城市",
      workOrRole: "书店店员",
      coreTraits: ["细心", "耐心"],
      coreContradiction: "",
      mainGoal: "",
      initialRelationship: "朋友",
      dialogueStyle: "自然克制",
      tier,
      timezone: "Asia/Shanghai",
    },
  });
  expect(generatedResponse.ok()).toBe(true);
  const generated = (await generatedResponse.json()) as {
    character: { id: string; version: number };
  };
  const published = await request.post(
    `/api/characters/${generated.character.id}/publish`,
    { data: { expectedVersion: generated.character.version } },
  );
  expect(published.ok()).toBe(true);
  return generated.character.id;
}

async function advanceClock(
  request: APIRequestContext,
  days: number,
): Promise<void> {
  const response = await request.post("/api/developer/clock/advance", {
    data: { days },
  });
  expect(response.ok()).toBe(true);
}

async function readBrowserStorage(page: Page): Promise<string> {
  const snapshot = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  return stringLeaves(snapshot).join("\n");
}

async function readClientCaches(page: Page): Promise<string> {
  // The repository E2E setup serves source with Vite. Inspect its actual singleton,
  // not an extra QueryClient instance, to prove decrypted reader data is absent.
  const snapshot = await page.evaluate(async () => {
    const modulePath = "/src/app/queryClient.ts";
    const { queryClient } = (await import(modulePath)) as {
      queryClient: {
        getQueryCache(): {
          getAll(): Array<{ queryKey: unknown; state: { data: unknown } }>;
        };
        getMutationCache(): {
          getAll(): Array<{ state: { data: unknown; variables: unknown } }>;
        };
      };
    };
    return {
      queries: queryClient
        .getQueryCache()
        .getAll()
        .map((query) => ({ key: query.queryKey, data: query.state.data })),
      mutations: queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => ({
          data: mutation.state.data,
          variables: mutation.state.variables,
        })),
    };
  });
  return stringLeaves(snapshot).join("\n");
}

function stringLeaves(value: unknown, depth = 0): string[] {
  if (depth > 12) return [];
  if (typeof value === "string") {
    try {
      const decoded: unknown = JSON.parse(value);
      return [value, ...stringLeaves(decoded, depth + 1)];
    } catch {
      return [value];
    }
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((item: unknown) =>
      stringLeaves(item, depth + 1),
    );
  }
  return [];
}

async function rememberCharacter(
  page: Page,
  characterId: string,
): Promise<void> {
  await page.addInitScript((activeCharacterId) => {
    localStorage.setItem(
      "personasim.active-character.v1",
      JSON.stringify({ version: 1, characterId: activeCharacterId }),
    );
  }, characterId);
}
