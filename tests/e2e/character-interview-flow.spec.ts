import { expect, test, type Page } from "@playwright/test";
import { mockConfiguredWelcomeCatalog } from "./api-onboarding-fixture";
import {
  answerMainQuestion,
  basicInterviewAnswers,
  fillMainInterview,
  skipInterviewFollowUps,
  type InterviewTestAnswers,
} from "./character-interview-helpers";

test.describe("Dearvale character interview", () => {
  test.setTimeout(90_000);
  test.beforeEach(async ({ page }) => {
    await mockConfiguredWelcomeCatalog(page);
  });

  test("answers twelve questions, restores progress, revises one draft and publishes before welcome changes", async ({
    page,
    request,
  }) => {
    const problems: string[] = [];
    const demoRequests: string[] = [];
    const followUpRequests: unknown[] = [];
    const compileRequests: Record<string, unknown>[] = [];
    let visibleCharacterId = "";
    page.on("pageerror", (error) => problems.push(error.message));
    page.on("request", (req) => {
      if (req.url().includes("/api/demo/")) demoRequests.push(req.url());
      if (
        req.method() === "POST" &&
        req.url().endsWith("/interview/follow-ups")
      )
        followUpRequests.push(req.postDataJSON());
      if (req.method() === "POST" && req.url().endsWith("/interview/compile"))
        compileRequests.push(req.postDataJSON() as Record<string, unknown>);
    });
    // Other E2E cases share a disposable backend. Filter only this view's list,
    // while retaining real server draft/publication state for this character.
    await page.route("**/api/characters", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as {
        characters: Array<{ id: string }>;
      };
      await route.fulfill({
        response,
        json: {
          ...body,
          characters: body.characters.filter(
            (character) => character.id === visibleCharacterId,
          ),
        },
      });
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/welcome");
    await expect(
      page.getByRole("button", { name: "描述你梦中的他/她", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "继续聊天", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "描述你梦中的他/她", exact: true })
      .click();
    await expect(page).toHaveURL(/\/create$/);
    const answers: InterviewTestAnswers = {
      ...basicInterviewAnswers,
      gender: "非二元",
      name: `时雨-${test.info().project.name}`,
      ageText: "二十多岁",
      appearanceDescription: "栗色短发，戴一副圆眼镜",
      dailyHabits: "傍晚沿河散步，随身带着一本小笔记",
      importantExperience: "曾随外祖父修补过一本家谱",
      dialogueStyle: "自然克制，偶尔有一点干幽默",
      currentFocus: "那间即将搬迁的老书店",
      additionalDetails: "喜欢收集不同树木的落叶",
    };
    await answerMainQuestion(page, "gender", answers.gender);
    await answerMainQuestion(page, "name", answers.name);
    await expect(page.locator("label[for='interview-answer']")).toContainText(
      `${answers.name}今年多大了`,
    );
    await page.locator("#interview-answer").fill(answers.ageText);
    await page.getByRole("button", { name: "上一问", exact: true }).click();
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "name",
    );
    await expect(page.locator("#interview-answer")).toHaveValue(answers.name);
    await page.getByTestId("interview-next").click();
    await expect(page.locator("#interview-answer")).toHaveValue(
      answers.ageText,
    );
    await page.reload();
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "ageText",
    );
    await expect(page.locator("#interview-answer")).toHaveValue(
      answers.ageText,
    );
    await fillMainInterview(page, answers, 2);
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "follow-up",
    );
    expect(followUpRequests).toHaveLength(1);
    const saved = await readSavedInterview(page);
    expect(saved.followUpQuestions).toHaveLength(2);
    expect(saved.followUpQuestions.length).toBeLessThanOrEqual(2);
    await page.reload();
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "follow-up",
    );
    expect(followUpRequests).toHaveLength(1);
    await skipInterviewFollowUps(page);
    await page.getByTestId("generate-character").click();
    await expect(page).toHaveURL(/\/characters\/[^/]+\/preview$/);
    visibleCharacterId = new URL(page.url()).pathname.split("/")[2]!;
    const firstPreviewResponse = await request.get(
      `/api/characters/${visibleCharacterId}/creation-preview`,
    );
    expect(firstPreviewResponse.ok()).toBe(true);
    const firstPreview = (await firstPreviewResponse.json()) as {
      characterVersion: number;
      answers: Record<string, unknown>;
      paragraphs: string[];
    };
    expect(firstPreview.answers).toMatchObject(answers);
    expect(firstPreview.paragraphs.join(" ")).toContain(
      answers.importantExperience,
    );
    await page.goto("/welcome");
    await expect(
      page.getByRole("button", { name: "描述你梦中的他/她", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText("还有一份未完成的描绘，等你接着写。"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "描述你梦中的他/她", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${visibleCharacterId}/preview$`),
    );
    await page.getByRole("button", { name: "回去修改", exact: true }).click();
    await page
      .getByRole("group", { name: "选择要修改的答案" })
      .getByRole("button", { name: "年龄", exact: true })
      .click();
    await expect(page).toHaveURL(/\/create$/);
    const editedAnswers = { ...answers, ageText: "年龄不详" };
    await fillMainInterview(page, editedAnswers, 2);
    await skipInterviewFollowUps(page);
    await page.getByTestId("generate-character").click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${visibleCharacterId}/preview$`),
    );
    const latestPreview = (await (
      await request.get(
        `/api/characters/${visibleCharacterId}/creation-preview`,
      )
    ).json()) as typeof firstPreview;
    expect(latestPreview.characterVersion).toBeGreaterThan(
      firstPreview.characterVersion,
    );
    expect(latestPreview.answers.ageText).toBe("年龄不详");
    expect(compileRequests).toHaveLength(2);
    expect(compileRequests[1]).toMatchObject({
      characterId: visibleCharacterId,
      expectedVersion: firstPreview.characterVersion,
    });
    await expect(page.getByTestId("publish-character")).toHaveText(
      `与${answers.name}相遇`,
    );
    await page.getByTestId("publish-character").click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${visibleCharacterId}/chat`),
    );
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await page.goto("/welcome");
    await expect(
      page.getByRole("button", { name: "继续聊天", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("link", { name: "描述你梦中的他/她", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "继续聊天", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${visibleCharacterId}/chat`),
    );
    const archived = await request.delete(
      `/api/characters/${visibleCharacterId}`,
    );
    expect(archived.ok()).toBe(true);
    await page.goto("/welcome");
    await expect(
      page.getByRole("button", { name: "描述你梦中的他/她", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "继续聊天", exact: true }),
    ).toHaveCount(0);
    expect(demoRequests).toEqual([]);
    expect(problems).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });

  test("requires basic answers, permits six omissions, and preserves textual age", async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/create");
    await answerMainQuestion(page, "gender", "女性");
    await page.getByTestId("interview-next").click();
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "name",
    );
    await expect(page.locator("#interview-answer")).toHaveAttribute("required");
    await fillMainInterview(
      page,
      {
        ...basicInterviewAnswers,
        name: `留白-${test.info().project.name}`,
        ageText: "二十多岁",
      },
      1,
    );
    await skipInterviewFollowUps(page);
    await page.getByTestId("generate-character").click();
    await expect(page).toHaveURL(/\/characters\/[^/]+\/preview$/);
    const id = new URL(page.url()).pathname.split("/")[2];
    const body = (await (
      await request.get(`/api/characters/${id}`)
    ).json()) as {
      character: {
        identity: Record<string, unknown>;
        persona: { goals: unknown[]; contradictions: unknown[] };
      };
    };
    expect(body.character.identity).toMatchObject({
      gender: "女性",
      ageText: "二十多岁",
    });
    expect(body.character.persona.goals).toEqual([]);
    expect(body.character.persona.contradictions).toEqual([]);
    await expect(page.getByTestId("publish-character")).toHaveText("与她相遇");
  });

  test("keeps follow-up generation failure nonblocking and does not retry on reload", async ({
    page,
  }) => {
    let calls = 0;
    await page.route(
      "**/api/characters/interview/follow-ups",
      async (route) => {
        calls += 1;
        await route.fulfill({
          status: 503,
          json: {
            error: { code: "TEMPORARY", message: "补充问题暂时没能写好" },
          },
        });
      },
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/create");
    await fillMainInterview(page, basicInterviewAnswers);
    await expect(page.getByTestId("generate-character")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("generate-character")).toBeVisible();
    expect(calls).toBe(1);
    await page.getByTestId("generate-character").click();
    await expect(page).toHaveURL(/\/characters\/[^/]+\/preview$/);
  });

  test("keeps Chinese composition on the current question and remains usable on a narrow screen with reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/create");
    await expect(page).toHaveTitle(/Dearvale/);
    await answerMainQuestion(page, "gender", "男性");
    const input = page.locator("#interview-answer");
    await input.fill("林澈");
    await input.dispatchEvent("compositionstart", { data: "澈" });
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: true,
    });
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "name",
    );
    await expect(input).toHaveValue("林澈");
    await input.dispatchEvent("compositionend", { data: "澈" });
    await page.getByTestId("interview-next").click();
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "ageText",
      { timeout: 900 },
    );
    await expect(page.locator("label[for='interview-answer']")).toContainText(
      "他今年多大了",
    );
    await fillMainInterview(
      page,
      {
        ...basicInterviewAnswers,
        gender: "男性",
        name: "林澈",
        worldSetting: "这里有许多温柔的小故事。".repeat(30),
        additionalDetails: "保留可以缓慢阅读的长答案。".repeat(80),
      },
      2,
    );
    await expectNoHorizontalOverflow(page);
    await skipInterviewFollowUps(page);
    await page.getByTestId("generate-character").click();
    await expect(page).toHaveURL(/\/characters\/[^/]+\/preview$/);
    await expect(page.getByTestId("publish-character")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });

  test("shows a retry state instead of guessing whether a character exists", async ({
    page,
  }) => {
    let unavailable = true;
    await page.route("**/api/characters", async (route) => {
      if (unavailable)
        await route.fulfill({
          status: 503,
          json: { error: { code: "TEMPORARY", message: "暂时无法读取角色" } },
        });
      else await route.fulfill({ json: { characters: [] } });
    });
    await page.goto("/welcome");
    await expect(
      page.getByRole("button", { name: "重新连接", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "继续聊天", exact: true }),
    ).toHaveCount(0);
    unavailable = false;
    await page.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "描述你梦中的他/她", exact: true }),
    ).toBeEnabled();
  });

  test("dips the quill once between questions and allows the written question to be revealed immediately", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/create");
    const desk = page.getByTestId("creation-desk");
    await page
      .getByRole("heading", {
        name: "你梦中的这个人，是什么性别？",
        exact: true,
      })
      .click();
    await expect(desk).toHaveAttribute("data-motion", "idle");
    await page.getByRole("radio", { name: "女性", exact: true }).click();
    await page.getByTestId("interview-next").click();
    await expect(desk).toHaveAttribute("data-motion", "dipping");
    await expect(page.getByTestId("interview-next")).toBeDisabled();
    await expect(page.getByTestId("character-generator")).toHaveAttribute(
      "data-question",
      "name",
    );
    await page
      .getByRole("heading", { name: "她叫什么名字？", exact: true })
      .click();
    await expect(desk).toHaveAttribute("data-motion", "idle");
    const opacity = await page
      .locator(".creation-ink-letter")
      .evaluateAll((letters) =>
        letters.map((letter) => getComputedStyle(letter).opacity),
      );
    expect(opacity.every((value) => value === "1")).toBe(true);
    await expect
      .poll(() =>
        page
          .locator(".creation-stage img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  });
});

async function readSavedInterview(
  page: Page,
): Promise<{ followUpQuestions: unknown[] }> {
  return page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("dearvale.character-interview.v1") ?? "null",
      ) as { followUpQuestions: unknown[] },
  );
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
}
