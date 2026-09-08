import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";

test.describe("Dearvale desktop journeys", () => {
  test("keeps the illustrated public journey independent from the character runtime", async ({
    page,
    request,
  }) => {
    const characterId = await createCharacter(request, "官网访问");
    const sessionId = await createSession(request, characterId);
    await page.addInitScript(
      ({ characterId, sessionId }) => {
        localStorage.setItem(
          "dearvale.last-conversation.v1",
          JSON.stringify({ version: 1, characterId, sessionId }),
        );
        localStorage.setItem(
          "personasim.active-character.v1",
          JSON.stringify({ version: 1, characterId }),
        );
      },
      { characterId, sessionId },
    );
    const runtimeRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/agents\/[^/]+\/(activate|events)(\?|$)/.test(request.url()))
        runtimeRequests.push(request.url());
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page).toHaveTitle(/Dearvale/);
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "0",
    );
    await expectNoStoryDisplacement(page);
    await page.getByRole("button", { name: "滚动，开始相遇" }).click();
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "1",
    );
    await expect(
      page.getByText("今天过得怎么样？", { exact: true }),
    ).toBeVisible();
    await expectNoStoryDisplacement(page);
    for (const [name, state] of [
      ["林间", "2"],
      ["书信", "3"],
      ["海岸", "4"],
      ["星夜", "5"],
    ] as const) {
      await page.getByRole("button", { name: `前往${name}` }).click();
      await expect(page.locator(".story-stage")).toHaveAttribute(
        "data-state",
        state,
      );
      await expectNoStoryDisplacement(page);
    }
    // Check the middle of a transition as well as resting scenes: an ordinary
    // fade uses a vertical drift here, while reduced motion must not move text.
    await scrollToStoryPosition(page, 1.74);
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "1",
    );
    await expectNoStoryDisplacement(page);
    await scrollToStoryPosition(page, 1.92);
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "2",
    );
    await expectNoStoryDisplacement(page);
    await expect(page.locator(".story-background img")).toHaveCount(5);
    await expect(page.locator(".story-bubble")).toHaveCount(10);
    await page.getByRole("button", { name: "前往山湖" }).click();
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "0",
    );
    await page.getByRole("button", { name: "前往星夜" }).click();
    await page.getByRole("link", { name: "开始相遇" }).click();
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(
      page.getByRole("button", { name: "继续上次的对话" }),
    ).toBeVisible();
    expect(runtimeRequests).toEqual([]);
  });

  test("holds the last complete scene while the requested background is delayed", async ({
    page,
  }) => {
    let releaseBackground!: () => void;
    let notifyRequested!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      notifyRequested = resolve;
    });
    await page.route("**/dearvale/art/desk.png", async (route) => {
      notifyRequested();
      await release;
      await route.continue();
    });
    try {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.goto("/");
      await page.getByRole("button", { name: "前往林间" }).click();
      await expect(page.locator(".story-stage")).toHaveAttribute(
        "data-state",
        "2",
      );
      await expectSettledStoryScene(page, 2, "林间的对话");
      await requested;
      const forest = page
        .locator(".story-background")
        .filter({ has: page.locator('img[src$="/forest.png"]') });
      await expectOpaqueBackground(forest);
      await expectDecodedBackground(forest.locator("img"));
      await scrollToStoryPosition(page, 3);
      await expect(page.locator(".story-stage")).toHaveAttribute(
        "data-state",
        "2",
      );
      await expectOpaqueBackground(forest);
      await expect(
        page.getByRole("region", { name: "林间的对话" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "书信的对话" }),
      ).toHaveCount(0);
      await expect(
        page.locator('.story-background img[src$="/desk.png"]'),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "重新加载风景" }),
      ).toHaveCount(0);
      releaseBackground();
      await expect(page.locator(".story-stage")).toHaveAttribute(
        "data-state",
        "3",
      );
      const desk = page
        .locator(".story-background")
        .filter({ has: page.locator('img[src$="/desk.png"]') });
      await expectOpaqueBackground(desk);
      await expectDecodedBackground(desk.locator("img"));
      await expect(
        page.getByRole("region", { name: "书信的对话" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "前往书信" }),
      ).toHaveAttribute("aria-current", "step");
    } finally {
      releaseBackground();
    }
  });

  test("retains readable scenery after an image failure and resumes the target on retry", async ({
    page,
  }) => {
    let coastRequests = 0;
    await page.route("**/dearvale/art/coast.png", async (route) => {
      coastRequests += 1;
      if (coastRequests === 1) await route.abort("failed");
      else await route.continue();
    });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await page.getByRole("button", { name: "前往书信" }).click();
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "3",
    );
    await expectSettledStoryScene(page, 3, "书信的对话");
    const desk = page
      .locator(".story-background")
      .filter({ has: page.locator('img[src$="/desk.png"]') });
    await expectOpaqueBackground(desk);
    await expectDecodedBackground(desk.locator("img"));
    const retry = page.getByRole("button", { name: "重新加载风景" });
    await expect(retry).toBeVisible();
    await scrollToStoryPosition(page, 4);
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "3",
    );
    await expectOpaqueBackground(desk);
    await expectDecodedBackground(desk.locator("img"));
    await expect(
      page.getByRole("region", { name: "书信的对话" }),
    ).toBeVisible();
    await retry.click();
    await expect(page.locator(".story-stage")).toHaveAttribute(
      "data-state",
      "4",
    );
    const coast = page
      .locator(".story-background")
      .filter({ has: page.locator('img[src$="/coast.png"]') });
    await expectOpaqueBackground(coast);
    await expectDecodedBackground(coast.locator("img"));
    await expect(
      page.getByRole("region", { name: "海岸的对话" }),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
    expect(coastRequests).toBeGreaterThanOrEqual(2);
  });

  test("enters one idempotent demo and always shows the welcome page before continuing", async ({
    page,
    request,
  }) => {
    const ensured = await Promise.all([
      request.post("/api/demo/ensure"),
      request.post("/api/demo/ensure"),
    ]);
    const first = (await ensured[0].json()) as {
      characterId: string;
      sessionId: string;
    };
    expect(ensured.every((response) => response.ok())).toBe(true);
    expect(await ensured[1].json()).toEqual(first);
    await page.goto("/welcome");
    await page.getByRole("button", { name: "先聊一会儿", exact: true }).click();
    await expectChatSession(page, first.sessionId);
    expect(new URL(page.url()).pathname).toBe(
      `/characters/${first.characterId}/chat`,
    );
    await page.locator(".chat-brand").click();
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(
      page.getByRole("button", { name: "继续上次的对话" }),
    ).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/welcome$/);
    await page.getByRole("button", { name: "继续上次的对话" }).click();
    await expectChatSession(page, first.sessionId);
  });

  test("preserves separate drafts, restores the selected session, and searches real characters", async ({
    page,
    request,
  }) => {
    const characterId = await createCharacter(request, "会话恢复");
    const searchName = `查找邻居-${test.info().project.name}-${Date.now()}`;
    const otherCharacterId = await createCharacter(request, searchName, false);
    await page.goto(`/characters/${characterId}/chat`);
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    const firstSessionId = sessionFromUrl(page);
    expect(firstSessionId).toBeTruthy();
    await page.getByTestId("chat-input").fill("留在第一段对话里的草稿");
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect.poll(() => sessionFromUrl(page)).not.toBe(firstSessionId);
    const secondSessionId = sessionFromUrl(page);
    await expect(page.getByTestId("chat-input")).toHaveValue("");
    await selectSession(page, firstSessionId);
    await expect(page.getByTestId("chat-input")).toHaveValue(
      "留在第一段对话里的草稿",
    );
    await selectSession(page, secondSessionId);
    await expect(page.getByTestId("chat-input")).toHaveValue("");
    await page.reload();
    await expectChatSession(page, secondSessionId);
    await expect(
      page.getByRole("button", { name: "角色近况", exact: true }),
    ).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "角色近况", exact: true }).click();
    await expect(
      page.getByRole("complementary", { name: "角色近况" }),
    ).toBeVisible();
    await page.getByLabel("搜索角色", { exact: true }).fill(searchName);
    await expect(page.locator(".chat-character")).toHaveCount(1);
    await page.locator(".chat-character").click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${otherCharacterId}/edit`),
    );
    await page.goto("/welcome");
    await page.getByRole("button", { name: "继续上次的对话" }).click();
    await expectChatSession(page, secondSessionId);
  });

  test("rejects foreign session links and handles invalid welcome history", async ({
    page,
    request,
  }) => {
    const characterId = await createCharacter(request, "归属校验");
    const owned = await createSession(request, characterId);
    const otherId = await createCharacter(request, "另一段故事");
    const foreign = await createSession(request, otherId);
    const foreignReads: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/sessions/${foreign}/messages`))
        foreignReads.push(request.url());
    });
    await page.goto(`/characters/${characterId}/chat?sessionId=${foreign}`);
    await expect(
      page.getByRole("heading", { name: "这段对话暂时无法打开" }),
    ).toBeVisible();
    expect(sessionFromUrl(page)).toBe(foreign);
    await expect(page.getByTestId("chat-input")).toHaveCount(0);
    expect(foreignReads).toEqual([]);
    await page.getByRole("button", { name: "打开可用的对话" }).click();
    await expectChatSession(page, owned);
    await page.evaluate(() =>
      localStorage.setItem(
        "dearvale.last-conversation.v1",
        JSON.stringify({
          version: 1,
          characterId: "removed-character",
          sessionId: "removed-session",
        }),
      ),
    );
    await page.goto("/welcome");
    await expect(
      page.getByRole("button", { name: "先聊一会儿", exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("supports Chinese composition, emoji insertion, and retrying a failed send", async ({
    page,
    request,
  }) => {
    const characterId = await createCharacter(request, "文字输入");
    await page.goto(`/characters/${characterId}/chat`);
    const input = page.getByTestId("chat-input");
    await expect(input).toBeEnabled();
    const sessionId = sessionFromUrl(page);
    await input.fill("今天的风很温柔");
    await input.dispatchEvent("compositionstart", { data: "温柔" });
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: true,
    });
    await expect(input).toHaveValue("今天的风很温柔");
    await expect(page.locator(".message-bubble")).toHaveCount(0);
    await input.dispatchEvent("compositionend", { data: "温柔" });
    await page.getByRole("button", { name: "选择表情" }).click();
    await page.getByRole("button", { name: "插入 🌿", exact: true }).click();
    await expect(input).toHaveValue("今天的风很温柔🌿");
    let failedFirstSend = false;
    await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
      if (route.request().method() === "POST" && !failedFirstSend) {
        failedFirstSend = true;
        await route.fulfill({
          status: 503,
          json: {
            error: { code: "TEMPORARY", message: "暂时没有收到回复，请重试" },
          },
        });
      } else await route.continue();
    });
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "暂时没有收到回复，请重试",
    );
    await expect(input).toHaveValue("今天的风很温柔🌿");
    const sent = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/sessions/${sessionId}/messages`),
    );
    await page.getByRole("button", { name: "发送消息" }).click();
    expect((await sent).ok()).toBe(true);
    await expect(input).toHaveValue("");
    await expect(
      page.locator(".message-group--user .message-bubble"),
    ).toHaveText("今天的风很温柔🌿");
    await expect(
      page.locator(".message-group--assistant .message-bubble").first(),
    ).toBeVisible();
  });

  test("keeps an old pending reply out of a newly selected conversation", async ({
    page,
    request,
  }) => {
    const characterId = await createCharacter(request, "回复隔离");
    await page.goto(`/characters/${characterId}/chat`);
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    const oldId = sessionFromUrl(page);
    let releaseReply!: () => void;
    let notifyFetched!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const fetched = new Promise<void>((resolve) => {
      notifyFetched = resolve;
    });
    await page.route(`**/api/sessions/${oldId}/messages`, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      notifyFetched();
      await held;
      await route.fulfill({ response });
    });
    await page.getByTestId("chat-input").fill("这是第一段对话的问候");
    await page.getByRole("button", { name: "发送消息" }).click();
    await fetched;
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect.poll(() => sessionFromUrl(page)).not.toBe(oldId);
    const newId = sessionFromUrl(page);
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await selectSession(page, oldId);
    await expect(page.getByTestId("chat-input")).toBeDisabled();
    await selectSession(page, newId);
    await page.getByTestId("chat-input").fill("第二段对话自己的草稿");
    releaseReply();
    await expect(page.getByTestId("chat-input")).toHaveValue(
      "第二段对话自己的草稿",
    );
    await expect(page.locator(".message-bubble")).toHaveCount(0);
    await selectSession(page, oldId);
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await expect(page.getByTestId("chat-input")).toHaveValue("");
    await expect(
      page.locator(".message-group--user .message-bubble"),
    ).toHaveText("这是第一段对话的问候");
    await selectSession(page, newId);
    await expect(page.getByTestId("chat-input")).toHaveValue(
      "第二段对话自己的草稿",
    );
    await expect(page.locator(".message-bubble")).toHaveCount(0);
  });
});

function sessionFromUrl(page: Page): string {
  return new URL(page.url()).searchParams.get("sessionId") ?? "";
}

async function expectNoStoryDisplacement(page: Page): Promise<void> {
  const movingContent = page.locator(".story-opening h1, .story-dialogue");
  await expect(movingContent).toHaveCount(6);
  const measurements = await movingContent.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        verticalOffset: new DOMMatrixReadOnly(style.transform).m42,
        animation: style.animationName,
        opacity: getComputedStyle(element.parentElement).opacity,
      };
    }),
  );
  for (const measurement of measurements) {
    expect(measurement.verticalOffset).toBe(0);
    expect(measurement.animation).toBe("none");
    expect(["0", "1"]).toContain(measurement.opacity);
  }
}

async function scrollToStoryPosition(
  page: Page,
  position: number,
): Promise<void> {
  await page.getByTestId("story-journey").evaluate((element, nextPosition) => {
    const journey = element as HTMLElement;
    window.scrollTo({
      top:
        journey.offsetTop +
        ((journey.offsetHeight - window.innerHeight) * nextPosition) / 5,
      behavior: "instant",
    });
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, position);
}

async function expectSettledStoryScene(
  page: Page,
  position: number,
  regionName: string,
): Promise<void> {
  // data-state changes at the midpoint of a fade. Let the native smooth scroll
  // reach its destination before deliberately jumping to an unavailable image;
  // otherwise the test itself freezes an unfinished crossfade as the last frame.
  await expect
    .poll(() =>
      page
        .getByTestId("story-journey")
        .evaluate((element, expectedPosition) => {
          const journey = element as HTMLElement;
          const destination =
            journey.offsetTop +
            ((journey.offsetHeight - window.innerHeight) * expectedPosition) /
              5;
          return Math.abs(window.scrollY - destination);
        }, position),
    )
    .toBeLessThanOrEqual(1);
  // Scroll observers update styles on the following animation frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect
    .poll(() =>
      page
        .getByRole("region", { name: regionName })
        .evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeGreaterThan(0.999);
}

async function expectDecodedBackground(image: Locator): Promise<void> {
  await expect
    .poll(() =>
      image.evaluate((element) => {
        const picture = element as HTMLImageElement;
        return (
          picture.complete &&
          picture.naturalWidth > 0 &&
          picture.naturalHeight > 0
        );
      }),
    )
    .toBe(true);
}

async function expectOpaqueBackground(background: Locator): Promise<void> {
  // Desktop scroll positions round to physical pixels. At a scene boundary
  // that can leave a negligible crossfade fraction (for example 0.99997).
  // Keep decoded-image, target-state, dialogue, and retry checks exact.
  await expect
    .poll(() =>
      background.evaluate((element) =>
        Number(getComputedStyle(element).opacity),
      ),
    )
    .toBeGreaterThan(0.999);
}

async function expectChatSession(page: Page, sessionId: string): Promise<void> {
  await expect.poll(() => sessionFromUrl(page)).toBe(sessionId);
  await expect(page.getByTestId("chat-input")).toBeVisible();
}

async function selectSession(page: Page, sessionId: string): Promise<void> {
  await page.getByLabel("更多对话操作", { exact: true }).click();
  await page
    .locator(`.chat-history__list button[data-session-id="${sessionId}"]`)
    .click();
  await expectChatSession(page, sessionId);
}

async function createCharacter(
  request: APIRequestContext,
  name: string,
  publish = true,
): Promise<string> {
  const generated = await request.post("/api/characters/generate", {
    data: {
      name: `${name}-${Date.now()}`,
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
  if (publish) {
    const published = await request.post(
      `/api/characters/${character.id}/publish`,
      { data: { expectedVersion: character.version } },
    );
    expect(published.ok()).toBe(true);
  }
  return character.id;
}

async function createSession(
  request: APIRequestContext,
  characterId: string,
): Promise<string> {
  const response = await request.post(`/api/agents/${characterId}/sessions`);
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as {
    id?: string;
    session?: { id: string };
  };
  const id = result.session?.id ?? result.id;
  if (!id) throw new Error("Session creation did not return an ID");
  return id;
}
