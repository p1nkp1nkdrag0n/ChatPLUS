import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type APIRequestContext } from "@playwright/test";

interface MailboxLetter {
  id: string;
  direction: "user_to_agent" | "agent_to_user";
  status: string;
}

test("reads real correspondence inside the mailbox without caching decrypted letters", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const suffix = `${test.info().project.name}-${Date.now()}`;
  // Viewport projects share a disposable backend. Give each run its own
  // correspondent so old opened letters and unfinished drafts cannot leak in.
  const characterId = await createPublishedCharacter(
    request,
    `书信阅读-${suffix}`,
  );
  const draft = await request.post(`/api/agents/${characterId}/letters`, {
    data: {
      clientRequestId: `embedded-reader-draft:${suffix}`,
      subject: "关于那片花海",
      body: "那天的风很温柔。我沿着湖边的小路走了很久，看到一整片白色的小花。想把这个安静的下午也写给你。",
    },
  });
  expect(draft.ok()).toBe(true);
  const { letter: outgoing } = (await draft.json()) as {
    letter: MailboxLetter;
  };
  const sealed = await request.post(`/api/letters/${outgoing.id}/seal`, {
    data: { clientRequestId: `embedded-reader-seal:${suffix}` },
  });
  expect(sealed.ok()).toBe(true);

  await advance(request, 5);
  await mailbox(request, characterId);
  await advance(request, 5);
  const letters = await mailbox(request, characterId);
  const incoming = letters.find(
    (letter) => letter.direction === "agent_to_user",
  );
  if (!incoming) throw new Error("The fixture reply did not arrive");
  expect(incoming.status).toBe("delivered_unread");
  const url = `/characters/${characterId}/correspondence?letterId=${incoming.id}`;
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "书信", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".mailbox-sidebar")).toBeVisible();
  await expect(page.locator(".mailbox-detail .letter-paper__body")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "启封阅读", exact: true }),
  ).toBeVisible();

  const opening = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/letters/${incoming.id}/open`),
  );
  await page.getByRole("button", { name: "启封阅读", exact: true }).click();
  const response = await opening;
  expect(response.ok()).toBe(true);
  const opened = (await response.json()) as { body: string };
  await expect(page.locator(".mailbox-detail .letter-paper__body")).toHaveText(
    opened.body,
  );
  await expect(page).toHaveURL(
    new RegExp(
      `/characters/${characterId}/correspondence\\?letterId=${incoming.id}$`,
    ),
  );
  await expect(page.locator(".mailbox-sidebar")).toBeVisible();

  const cached = await page.evaluate(async (modulePath) => {
    const { queryClient } = (await import(modulePath)) as {
      queryClient: {
        getQueryCache: () => {
          getAll: () => Array<{ state: { data: unknown } }>;
        };
      };
    };
    return JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    );
  }, "/src/app/queryClient.ts");
  expect(cached).not.toContain(opened.body);
  await page.screenshot({
    path: join(tmpdir(), `dearvale-mailbox-${test.info().project.name}.png`),
  });

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制正文", exact: true }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.replace(/\r\n/g, "\n")).toBe(opened.body);
  await page.getByRole("button", { name: "专注阅读", exact: true }).click();
  await expect(page.locator(".mailbox-sidebar")).toBeHidden();
  await expect(page.locator(".letter-paper__body")).toHaveText(opened.body);
  await page.getByRole("button", { name: "退出专注", exact: true }).click();
  await expect(page.locator(".mailbox-sidebar")).toBeVisible();
  await page.reload();
  await expect(page.locator(".mailbox-detail .letter-paper__body")).toHaveText(
    opened.body,
  );
  await expect(
    page.getByRole("link", { name: "回信", exact: true }),
  ).toBeVisible();

  const longBody =
    "今天路过湖边，树影落在水面上。想把这一小段日常写给你。\n\n".repeat(120);
  await page.getByRole("link", { name: "回信", exact: true }).click();
  await page.getByLabel("主题（可选）").fill("很长的一封信");
  await page.getByLabel("正文", { exact: true }).fill(longBody);
  for (const [name, template] of [
    ["素笺", "plain"],
    ["夜蓝", "midnight"],
    ["棉纸", "cotton"],
  ]) {
    const radio = page.getByRole("radio", { name, exact: true });
    await page
      .locator(".paper-selector__option")
      .filter({ has: radio })
      .click();
    await expect(radio).toBeChecked();
    await expect(
      page.locator(`.compose-preview .letter-paper--${template}`),
    ).toBeVisible();
    await expect(
      page.locator(".compose-preview .letter-paper__body"),
    ).toHaveText(longBody);
  }
  const saving = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/agents/${characterId}/letters`),
  );
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  const saved = await saving;
  expect(saved.ok()).toBe(true);
  const { letter: longLetter } = (await saved.json()) as {
    letter: MailboxLetter;
  };
  await expect(page).toHaveURL(new RegExp(`draftId=${longLetter.id}$`));
  await page.goto(
    `/characters/${characterId}/correspondence?letterId=${longLetter.id}`,
  );
  await expect(page.locator(".letter-paper__body")).toHaveText(longBody);
  expect(
    await page
      .locator(".letter-paper__content")
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  const sidebarBefore = await page.locator(".mailbox-sidebar").boundingBox();
  await page.locator(".letter-paper__content").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await page.locator(".mailbox-sidebar").boundingBox()).toEqual(
    sidebarBefore,
  );
  expect(
    await page
      .locator("body")
      .evaluate((element) => element.scrollWidth <= window.innerWidth),
  ).toBe(true);

  await page.route("**/api/settings", async (route) => {
    const actual = await route.fetch();
    const settings = (await actual.json()) as {
      runtime: Record<string, unknown>;
    };
    await route.fulfill({
      json: {
        ...settings,
        runtime: { ...settings.runtime, correspondenceMode: "off" },
      },
    });
  });
  await page.goto(url);
  await expect(page.getByText("书信当前只读", { exact: true })).toBeVisible();
  await expect(page.locator(".mailbox-detail .letter-paper__body")).toHaveText(
    opened.body,
  );
  await expect(
    page.getByRole("link", { name: "回信", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "复制正文", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

async function createPublishedCharacter(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const generatedResponse = await request.post("/api/characters/generate", {
    data: {
      name,
      worldSetting: "当代的小城",
      workOrRole: "独立插画师",
      coreTraits: ["温柔", "细心"],
      initialRelationship: "相互信任的老朋友",
      dialogueStyle: "自然、温暖且具体",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generatedResponse.ok()).toBe(true);
  const { character } = (await generatedResponse.json()) as {
    character: { id: string; version: number };
  };
  const publishedResponse = await request.post(
    `/api/characters/${character.id}/publish`,
    {
      data: { expectedVersion: character.version },
    },
  );
  expect(publishedResponse.ok()).toBe(true);
  return character.id;
}

async function advance(request: APIRequestContext, days: number) {
  const response = await request.post("/api/developer/clock/advance", {
    data: { days },
  });
  expect(response.ok()).toBe(true);
}

async function mailbox(request: APIRequestContext, characterId: string) {
  const response = await request.get(
    `/api/agents/${characterId}/correspondence`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { letters: MailboxLetter[] }).letters;
}
