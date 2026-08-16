import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

test.describe("PersonaSim fixture flow", () => {
  test("app renders a usable character library", async ({ page }) => {
    await page.goto("/characters");
    await expect(page).toHaveTitle("PersonaSim");
    await expect(
      page.getByRole("heading", { name: "角色", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /创建角色/ })).toBeVisible();
  });

  test("settles the remembered character when the app opens on the library", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().project.name}-${Date.now()}`;
    const firstId = await createPublishedCharacter(
      request,
      `离线结算甲${suffix}`,
    );
    const secondId = await createPublishedCharacter(
      request,
      `离线结算乙${suffix}`,
    );

    await page.addInitScript((characterId) => {
      localStorage.setItem(
        "personasim.active-character.v1",
        JSON.stringify({ version: 1, characterId }),
      );
    }, firstId);
    const activated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/agents/${firstId}/activate`),
    );

    await page.goto("/characters");
    expect((await activated).ok()).toBe(true);

    const activateSecond = page.waitForResponse((response) =>
      response.url().endsWith(`/api/agents/${secondId}/activate`),
    );
    await setActiveCharacter(page, secondId);
    expect((await activateSecond).ok()).toBe(true);

    const reactivateFirst = page.waitForResponse((response) =>
      response.url().endsWith(`/api/agents/${firstId}/activate`),
    );
    await setActiveCharacter(page, firstId);
    expect((await reactivateFirst).ok()).toBe(true);
  });

  test("creates, publishes and chats with a high-fidelity character", async ({
    page,
  }) => {
    const suffix = Date.now().toString().slice(-6);
    const name = `林澈${suffix}`;
    await page.goto("/create");

    await page.getByLabel("角色名称").fill(name);
    await page.getByLabel("社会身份或职业").fill("城市社会学研究生");
    await page.getByLabel("核心性格 1").fill("理性冷静");
    await page.getByLabel("核心性格 2").fill("细腻敏锐");
    await page.getByLabel("核心性格 3").fill("克制内敛");
    await page
      .getByLabel("一个核心矛盾")
      .fill("渴望深层连接，但担心失去独立判断。");
    await page.getByLabel("主要目标").fill("完成一项真正有公共价值的研究");
    await page.getByRole("radio", { name: /拟真模拟/ }).click();
    await page.getByTestId("generate-character").click();

    await expect(page).toHaveURL(/\/characters\/[^/]+\/edit/, {
      timeout: 30_000,
    });
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(
      page.getByText("人格与价值观", { exact: true }).first(),
    ).toBeVisible();
    await page.getByTestId("publish-character").click();

    await expect(page).toHaveURL(/\/characters\/[^/]+\/chat/, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await page
      .getByTestId("chat-input")
      .fill("今晚学校有新生晚会，你要一起去吗？");
    await page.getByRole("button", { name: "发送消息" }).click();

    await expect(page.getByText(/好啊|晚会|具体时间/).last()).toBeVisible({
      timeout: 30_000,
    });
    const expandRail = page.getByRole("button", { name: "展开状态栏" });
    if (await expandRail.isVisible()) await expandRail.click();
    const rail = page.locator(".chat-rail");
    await expect(rail.getByText("接下来 24 小时")).toBeVisible();
    await expect(rail.getByText(/晚会/).first()).toBeVisible();
  });

  test("import form rejects an unsupported file extension client-side", async ({
    page,
  }) => {
    await page.goto("/import");
    await page.getByLabel("角色名称").fill("测试角色");
    await page.getByLabel("作品名称").fill("测试作品");
    await page.getByLabel("角色所处的剧情阶段").fill("开篇之后");
    await page.locator("input[type=file]").setInputFiles({
      name: "character.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not a pdf"),
    });
    await expect(
      page.getByText("第一版只支持 .txt、.md 和 .srt 文件。"),
    ).toBeVisible();
  });
});

async function createPublishedCharacter(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const generatedResponse = await request.post("/api/characters/generate", {
    data: {
      name,
      worldSetting: "当代城市",
      workOrRole: "独立记者",
      coreTraits: ["谨慎", "坦率", "坚定"],
      coreContradiction: "追求真相，但担心牵连同伴",
      mainGoal: "完成一篇可靠的调查报道",
      initialRelationship: "初识",
      dialogueStyle: "简洁克制",
      tier: "daily",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generatedResponse.ok()).toBe(true);
  const generated = (await generatedResponse.json()) as {
    character: { id: string; version: number };
  };
  const publishedResponse = await request.post(
    `/api/characters/${generated.character.id}/publish`,
    { data: { expectedVersion: generated.character.version } },
  );
  expect(publishedResponse.ok()).toBe(true);
  return generated.character.id;
}

async function setActiveCharacter(
  page: Page,
  characterId: string,
): Promise<void> {
  await page.evaluate((nextCharacterId) => {
    localStorage.setItem(
      "personasim.active-character.v1",
      JSON.stringify({ version: 1, characterId: nextCharacterId }),
    );
    window.dispatchEvent(
      new CustomEvent<string>("personasim:active-character-changed", {
        detail: nextCharacterId,
      }),
    );
  }, characterId);
}
