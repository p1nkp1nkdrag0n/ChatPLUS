import { join } from "node:path";

import { expect, test } from "@playwright/test";
type CharacterSpec = {
  id: string;
  version: number;
  persona: { boundaries: unknown[] };
};

test("creates and publishes a character with optional concerns left blank", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(message.text());
  });
  await page.goto("/create");
  await expect(page).toHaveTitle("Dearvale");
  await page.getByLabel("角色名称").fill(`阿澄-${test.info().project.name}`);
  await page.getByLabel("社会身份或职业").fill("书店店员");
  await page.getByLabel("核心性格 1").fill("习惯先听别人说完");
  await expect(page.getByLabel("最近拿不准的事情（可空）")).not.toHaveAttribute(
    "required",
  );
  await expect(
    page.getByLabel("目前在意/想做的事（可空）"),
  ).not.toHaveAttribute("required");
  const screenshotDirectory = process.env["CHATPLUS_QA_SCREENSHOT_DIR"];
  if (screenshotDirectory)
    await page.screenshot({
      path: join(
        screenshotDirectory,
        `character-create-${test.info().project.name}.png`,
      ),
      fullPage: true,
    });
  await page.getByTestId("generate-character").click();
  await expect(page).toHaveURL(/\/characters\/[^/]+\/edit/);
  await expect(
    page.getByText(
      "目前没有设定矛盾。角色可以自然相处，不需要固定的内心冲突。",
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      "目前没有明确目标。可以直接保存、发布，之后再补充新的关注点。",
    ),
  ).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  if (screenshotDirectory)
    await page.screenshot({
      path: join(
        screenshotDirectory,
        `character-empty-${test.info().project.name}.png`,
      ),
      fullPage: true,
    });
  await page.getByTestId("publish-character").click();
  await expect(page).toHaveURL(/\/characters\/[^/]+\/chat/);
  await page.getByTestId("chat-input").fill("今天路边的猫在晒太阳。");
  const reply = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/sessions\/[^/]+\/messages$/.test(response.url()),
  );
  await page.getByRole("button", { name: "发送消息" }).click();
  expect((await reply).ok()).toBe(true);
  expect(errors).toEqual([]);
});

test("removes every goal and tension and persists the empty editor state", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/characters/generate", {
    data: {
      name: `编辑验收-${test.info().project.name}`,
      worldSetting: "当代城市",
      workOrRole: "插画师",
      coreTraits: ["细心"],
      coreContradiction: "想独处，也想见朋友",
      mainGoal: "完成漫画",
      initialRelationship: "邻居",
      dialogueStyle: "自然",
      tier: "daily",
      timezone: "Asia/Shanghai",
    },
  });
  expect(response.ok()).toBe(true);
  const { character } = (await response.json()) as {
    character: { id: string };
  };
  await page.goto(`/characters/${character.id}/edit`);
  await page.getByRole("button", { name: "删除张力 1", exact: true }).click();
  await page.getByRole("button", { name: "删除目标 1", exact: true }).click();
  await page.getByTestId("publish-character").click();
  await expect(page).toHaveURL(
    new RegExp(`/characters/${character.id}/chat\\?sessionId=[^&]+$`),
  );
  await page.goto(`/characters/${character.id}/edit`);
  await expect(
    page.getByText(
      "目前没有明确目标。可以直接保存、发布，之后再补充新的关注点。",
    ),
  ).toBeVisible();
  const persistedResponse = await request.get(
    `/api/characters/${character.id}`,
  );
  const persisted = (await persistedResponse.json()) as {
    character: {
      persona: { goals: unknown[]; contradictions: unknown[] };
      compilationPolicyVersion: string;
    };
  };
  expect(persisted.character.persona.goals).toEqual([]);
  expect(persisted.character.persona.contradictions).toEqual([]);
  expect(persisted.character.compilationPolicyVersion).toBe(
    "companion_character_v3",
  );
});

test("reviews an exact quarantined constraint and saves the author's confirmation", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(message.text());
  });
  const generated = await request.post("/api/characters/generate", {
    data: {
      name: `来源复核-${test.info().project.name}`,
      worldSetting: "当代城市",
      workOrRole: "插画师",
      coreTraits: ["细心"],
      initialRelationship: "刚认识",
      dialogueStyle: "自然中文",
      tier: "daily",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.ok()).toBe(true);
  const { character } = (await generated.json()) as {
    character: CharacterSpec;
  };
  const edited = await request.patch(`/api/characters/${character.id}/draft`, {
    data: {
      expectedVersion: character.version,
      patch: {
        persona: {
          boundaries: [
            {
              id: "review-boundary",
              condition: "被要求透露住址",
              forbiddenBehavior: "披露住址",
              responsePattern: "说明这是私事",
              hard: true,
            },
          ],
        },
      },
    },
  });
  expect(edited.ok()).toBe(true);
  const before = ((await edited.json()) as { character: CharacterSpec })
    .character;
  expect(before.persona.boundaries).toEqual([]);
  await page.goto(`/characters/${character.id}/edit`);
  await expect(page).toHaveTitle("Dearvale");
  await page.getByRole("button", { name: "约束来源", exact: true }).click();
  const review = page.getByRole("region", { name: "约束来源复核" });
  await expect(
    review.getByRole("heading", { name: "约束来源复核" }),
  ).toBeVisible();
  const candidate = review
    .locator("details")
    .filter({ hasText: "persona.boundaries" })
    .filter({ hasText: "披露住址" });
  await expect(candidate.getByLabel("原始候选")).toHaveValue(/披露住址/);
  await expect(candidate.getByLabel("当前采用内容")).toHaveValue("尚未采用");
  await expect(
    candidate.getByRole("button", { name: "不采用此候选" }),
  ).toBeVisible();
  const screenshotDirectory = process.env["CHATPLUS_QA_SCREENSHOT_DIR"];
  if (screenshotDirectory)
    await page.screenshot({
      path: join(
        screenshotDirectory,
        `authority-pending-${test.info().project.name}.png`,
      ),
      fullPage: true,
    });
  await candidate.getByRole("button", { name: "确认此内容与强度" }).click();
  await expect(candidate.locator("summary")).toContainText("已确认");
  await expect(
    candidate.getByRole("button", { name: "确认此内容与强度" }),
  ).toHaveCount(0);
  const persisted = (
    (await (await request.get(`/api/characters/${character.id}`)).json()) as {
      character: CharacterSpec;
    }
  ).character;
  expect(persisted.version).toBeGreaterThan(before.version);
  expect(persisted.persona.boundaries).toEqual([
    expect.objectContaining({
      id: "review-boundary",
      hard: true,
      forbiddenBehavior: "披露住址",
    }),
  ]);
  const rejectedCandidate = review
    .locator("details")
    .filter({ has: page.getByRole("button", { name: "不采用此候选" }) })
    .first();
  const candidateSummary = await rejectedCandidate
    .locator("summary")
    .textContent();
  await rejectedCandidate.getByRole("button", { name: "不采用此候选" }).click();
  await expect(
    review
      .locator("details")
      .filter({ hasText: candidateSummary.replace("待复核", "未采用") })
      .first(),
  ).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(errors).toEqual([]);
  if (screenshotDirectory)
    await page.screenshot({
      path: join(
        screenshotDirectory,
        `authority-confirmed-${test.info().project.name}.png`,
      ),
      fullPage: true,
    });
});
