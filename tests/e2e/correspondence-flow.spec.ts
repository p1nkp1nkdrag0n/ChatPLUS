import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

interface LetterSummary {
  id: string;
  direction: "user_to_agent" | "agent_to_user";
  status:
    | "draft"
    | "sealed"
    | "in_transit"
    | "delivered_unread"
    | "read"
    | "cancelled";
  canOpen: boolean;
  progress: number;
  previewText?: string;
}

interface CorrespondenceMailboxResponse {
  letters: LetterSummary[];
}

interface OpenLetterResponse {
  body: string;
}

interface RelationshipArchiveEntry {
  id: string;
  entryType: string;
  href: string;
  sourceIds: string[];
}

interface RelationshipArchivePageResponse {
  items: RelationshipArchiveEntry[];
}

interface KeepsakePageResponse {
  items: Array<{ id: string }>;
}

interface KeepsakeDetailResponse {
  keepsake: { id: string; title: string };
  sources: Array<{ type: string; id: string; href: string }>;
}

interface RelationshipShareProjection {
  exportMode: string;
  envelope?: { letterId: string; waitingDays?: number };
  keepsake?: { keepsakeId: string };
  redactedExcerpt?: string;
}

const SUBJECT = "阶段八端到端主题";
const USER_BODY = "我们把这次漫长等待也留在信里，等你五天后的回音。";

test.describe("correspondence, archive, keepsake, and local share flow", () => {
  test("seals, waits, opens, traces, and builds a body-free share projection", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().project.name}-${Date.now()}`;
    const agentId = await createPublishedHighFidelityCharacter(
      request,
      `书信旅人${suffix}`,
    );
    await rememberCharacter(page, agentId);
    const replyCallsBeforeSeal = await countLetterReplyCalls(request, agentId);

    await page.goto(`/characters/${agentId}/correspondence`);
    await expect(
      page.getByRole("heading", { name: "书信", exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "写一封信" }).first().click();
    await expect(page.getByRole("heading", { name: "写一封信" })).toBeVisible();
    await page.getByLabel("主题（可选）").fill(SUBJECT);
    await page.getByLabel("正文").fill(USER_BODY);
    await page.getByRole("button", { name: "确认封缄并寄出" }).click();
    const sealDialog = page.getByRole("dialog", { name: "确认封缄" });
    await expect(sealDialog).toBeVisible();
    await sealDialog.getByRole("button", { name: "确认封缄并寄出" }).click();
    await expect(page).toHaveURL(/\/letters\/[^?]+\?agentId=/u);
    const incomingLetterId = letterIdFromUrl(page.url());
    await expect(page.locator(".letter-paper__body")).toHaveText(USER_BODY);
    await expect(page.getByRole("link", { name: "继续编辑" })).toHaveCount(0);

    await advanceClock(request, 4);
    await page.reload();
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "80",
    );
    await expect(page.getByRole("heading", { name: "信件在途" })).toBeVisible();
    expect(await countLetterReplyCalls(request, agentId)).toBe(
      replyCallsBeforeSeal,
    );

    await advanceClock(request, 1);
    const afterIncomingArrival = await readMailbox(request, agentId);
    expect(
      afterIncomingArrival.letters.find(
        (letter) => letter.id === incomingLetterId,
      ),
    ).toMatchObject({
      direction: "user_to_agent",
      status: "read",
      progress: 1,
    });
    const reply = afterIncomingArrival.letters.find(
      (letter) => letter.direction === "agent_to_user",
    );
    expect(reply).toMatchObject({
      status: "in_transit",
      canOpen: false,
    });
    expect(reply).not.toHaveProperty("previewText");
    const replyLetterId = reply.id;
    expect(await countLetterReplyCalls(request, agentId)).toBe(
      replyCallsBeforeSeal + 1,
    );

    const inTransitDetail = await request.get(`/api/letters/${replyLetterId}`);
    expect(inTransitDetail.ok()).toBe(true);
    const inTransitText = await inTransitDetail.text();
    expect(inTransitText).not.toMatch(
      /"(?:subject|body|salutation|closing|signature|ciphertext|authTag|encryptedBody)"/iu,
    );
    await page.goto(
      `/letters/${replyLetterId}?agentId=${encodeURIComponent(agentId)}`,
    );
    await expect(page.getByRole("button", { name: "启封阅读" })).toHaveCount(0);
    await expect(page.locator(".letter-paper__body")).toHaveCount(0);
    await expect(
      page.getByText("信件抵达前不会显示正文。", { exact: false }),
    ).toBeVisible();

    await advanceClock(request, 5);
    const arrivedCacheSafe = await request.get(`/api/letters/${replyLetterId}`);
    expect(arrivedCacheSafe.ok()).toBe(true);
    const arrivedCacheSafeText = await arrivedCacheSafe.text();
    expect(arrivedCacheSafeText).not.toMatch(
      /"(?:subject|body|salutation|closing|signature|ciphertext|authTag|encryptedBody)"/iu,
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "启封阅读" })).toBeVisible();
    await expect(page.locator(".letter-paper__body")).toHaveCount(0);
    const unopenedPageSource = await page.content();

    const openedResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/letters/${replyLetterId}/open`),
    );
    await page.getByRole("button", { name: "启封阅读" }).click();
    const openedResponse = await openedResponsePromise;
    expect(openedResponse.ok()).toBe(true);
    const opened = (await openedResponse.json()) as OpenLetterResponse;
    await expect(page.locator(".letter-paper__body")).toContainText(
      opened.body,
      { timeout: 10_000 },
    );
    expect(arrivedCacheSafeText).not.toContain(opened.body);
    expect(unopenedPageSource).not.toContain(opened.body);

    await page.goto(`/characters/${agentId}/correspondence`);
    await page.getByRole("tab", { name: "档案" }).click();
    await expect(
      page.getByText("已归档", { exact: true }).first(),
    ).toBeVisible();

    const archiveResponse = await request.get(
      `/api/agents/${agentId}/relationship-archive?filter=correspondence&limit=20`,
    );
    expect(archiveResponse.ok()).toBe(true);
    const archive =
      (await archiveResponse.json()) as RelationshipArchivePageResponse;
    for (const letterId of [incomingLetterId, replyLetterId]) {
      const entry = archive.items.find((item) => item.id === letterId);
      expect(entry).toMatchObject({
        entryType: "letter",
        href: `/letters/${letterId}?agentId=${agentId}`,
      });
      expect(entry?.sourceIds).toContain(letterId);
    }
    await page.goto(`/characters/${agentId}/relationship-archive`);
    await expect(page.getByRole("heading", { name: "关系档案" })).toBeVisible();
    await expect(
      page.getByText(SUBJECT, { exact: false }).first(),
    ).toBeVisible();
    await page.goto(
      `/characters/${agentId}/relationship-archive?entryId=${encodeURIComponent(`letter:${incomingLetterId}`)}`,
    );
    await expect(
      page.locator(`[data-archive-entry-id="${incomingLetterId}"]`),
    ).toBeVisible();

    const keepsakes = await readKeepsakes(request, agentId);
    expect(keepsakes.items.length).toBeGreaterThan(0);
    const sourcedKeepsake = await findKeepsakeWithLetterSource(
      request,
      keepsakes,
      incomingLetterId,
    );
    expect(sourcedKeepsake).toBeDefined();
    expect(
      sourcedKeepsake?.sources.find(
        (source) => source.type === "letter" && source.id === incomingLetterId,
      ),
    ).toMatchObject({
      href: `/letters/${incomingLetterId}?agentId=${agentId}`,
    });
    await page.goto(`/characters/${agentId}/keepsakes`);
    await expect(
      page.getByRole("heading", { name: "纪念物陈列柜" }),
    ).toBeVisible();
    const filteredKeepsakesPromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.pathname === `/api/agents/${agentId}/keepsakes` &&
        url.searchParams.get("sourceType") === "letter"
      );
    });
    await page
      .getByRole("combobox", { name: "来源", exact: true })
      .selectOption("letter");
    expect((await filteredKeepsakesPromise).ok()).toBe(true);
    await expect(
      page.getByText(sourcedKeepsake.keepsake.title, { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole("button")
      .filter({ hasText: sourcedKeepsake.keepsake.title })
      .first()
      .click();
    await expect(page).toHaveURL(`/keepsakes/${sourcedKeepsake.keepsake.id}`);
    const provenanceLink = page
      .getByRole("link", { name: "打开来源", exact: true })
      .first();
    await expect(provenanceLink).toHaveAttribute(
      "href",
      `/letters/${incomingLetterId}?agentId=${agentId}`,
    );
    await provenanceLink.click();
    await expect(page).toHaveURL(
      `/letters/${incomingLetterId}?agentId=${agentId}`,
    );

    await page.goto(
      `/characters/${agentId}/relationship-share?${new URLSearchParams({
        letterId: replyLetterId,
        keepsakeId: sourcedKeepsake.keepsake.id,
      }).toString()}`,
    );
    await expect(
      page.getByRole("heading", { name: "分享一段共同的回忆" }),
    ).toBeVisible();
    const excerptToggle = page.getByRole("checkbox", {
      name: "正文摘录（默认关闭）",
    });
    await expect(excerptToggle).not.toBeChecked();
    await expect(
      page.getByText("正文摘录已关闭；默认导出中不会出现正文。", {
        exact: true,
      }),
    ).toBeVisible();
    const safeProjectionPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/agents/${agentId}/relationship-share/preview`),
    );
    await page.getByRole("button", { name: "生成安全预览" }).click();
    const safeProjectionResponse = await safeProjectionPromise;
    expect(safeProjectionResponse.ok()).toBe(true);
    const projection =
      (await safeProjectionResponse.json()) as RelationshipShareProjection;
    expect(projection).toMatchObject({
      exportMode: "local_png",
      envelope: { letterId: replyLetterId, waitingDays: 5 },
      keepsake: { keepsakeId: sourcedKeepsake.keepsake.id },
    });
    expect(projection).not.toHaveProperty("redactedExcerpt");
    expect(JSON.stringify(projection)).not.toContain(USER_BODY);
    expect(JSON.stringify(projection)).not.toContain(opened.body);
    expect(JSON.stringify(projection)).not.toMatch(/publicUrl|upload/iu);
    await expect(
      page.getByText("安全投影已核对", { exact: true }),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出本地 PNG" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/u);
    expect(await download.failure()).toBeNull();
  });

  test("recovers an ambiguous failed-reply request through the safe projection", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().project.name}-${Date.now()}`;
    const agentId = await createPublishedHighFidelityCharacter(
      request,
      `恢复旅人·${test.info().project.name === "chromium" ? "桌面" : "移动"}`,
    );
    await rememberCharacter(page, agentId);
    const createdResponse = await request.post(
      `/api/agents/${agentId}/letters`,
      {
        data: {
          clientRequestId: `recovery-create:${suffix}`,
          subject: "等待一封迟到的回信",
          body: "这封信用于验证失败后的安全恢复入口。",
        },
      },
    );
    expect(createdResponse.ok()).toBe(true);
    const created = (await createdResponse.json()) as {
      letter: { id: string; threadId: string };
    };
    const incomingLetterId = created.letter.id;
    const threadId = created.letter.threadId;
    const sealedResponse = await request.post(
      `/api/letters/${incomingLetterId}/seal`,
      { data: { clientRequestId: `recovery-seal:${suffix}` } },
    );
    expect(sealedResponse.ok()).toBe(true);

    let replyState: "failed" | "retry_scheduled" = "failed";
    let retryCalls = 0;
    const retryPayloads: Array<{ clientRequestId: string }> = [];
    let releaseRetryResponse: (() => void) | undefined;
    const retryResponseGate = new Promise<void>((resolve) => {
      releaseRetryResponse = resolve;
    });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route(
      `**/api/agents/${agentId}/correspondence*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            threads: [
              {
                id: threadId,
                agentId,
                status: "open",
                rootLetterId: incomingLetterId,
                latestLetterId: incomingLetterId,
                replyState:
                  replyState === "failed"
                    ? {
                        kind: "failed",
                        incomingLetterId,
                        canRetry: true,
                      }
                    : { kind: "retry_scheduled", incomingLetterId },
              },
            ],
            letters: [
              {
                id: incomingLetterId,
                threadId,
                direction: "user_to_agent",
                status: "read",
                authoredDisplayDate: "2026-09-20",
                dispatchedAtUtc: "2026-09-15T04:00:00.000Z",
                arrivalDueAtUtc: "2026-09-20T04:00:00.000Z",
                progress: 1,
                postmark: "上海 · 2026-09-15",
                canOpen: false,
                canEdit: false,
                previewText: "这封信用于验证失败后的安全恢复入口。",
              },
            ],
            serverTimeUtc: "2026-09-20T04:00:00.000Z",
          }),
        });
      },
    );
    await page.route(
      `**/api/letters/${incomingLetterId}/reply-generation/retry`,
      async (route) => {
        retryCalls += 1;
        retryPayloads.push(
          route.request().postDataJSON() as { clientRequestId: string },
        );
        if (retryCalls === 1) {
          await retryResponseGate;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              error: {
                code: "reply_retry_transport_failed",
                message: "SENTINEL_PRIVATE_PROVIDER_FAILURE",
              },
            }),
          });
          return;
        }
        if (retryCalls === 2) {
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({ incomingLetterId, replayed: true }),
          });
          return;
        }
        replyState = "retry_scheduled";
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ incomingLetterId, replayed: false }),
        });
      },
    );

    await page.goto(`/characters/${agentId}/correspondence`);
    await expect(
      page.getByText("这封回信暂时没有写成", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "回信待处理" }),
    ).toBeDisabled();

    await page.goto(
      `/letters/${incomingLetterId}?agentId=${encodeURIComponent(agentId)}`,
    );
    await expect(
      page.getByText("这封回信暂时没有写成", { exact: true }),
    ).toBeVisible();

    await page.goto(
      `/correspondence/threads/${threadId}?agentId=${encodeURIComponent(agentId)}`,
    );
    const retryButton = page.getByRole("button", { name: /重新/u });
    await expect(retryButton).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("failed-reply-recovery.png"),
      fullPage: true,
    });

    await retryButton.click();
    await expect(retryButton).toBeDisabled();
    await expect(retryButton).toContainText("正在重新请求");
    await retryButton.click({ force: true });
    expect(retryCalls).toBe(1);
    expect(retryPayloads[0]).toEqual({
      clientRequestId: expect.stringMatching(/^letter-reply-retry:/u),
    });

    releaseRetryResponse?.();
    await expect(
      page.getByText("未能确认这次请求，请稍后再次尝试。", { exact: true }),
    ).toBeVisible();
    expect(await page.content()).not.toContain(
      "SENTINEL_PRIVATE_PROVIDER_FAILURE",
    );
    await retryButton.click();

    await expect(
      page.getByText("已安排重新尝试", { exact: true }),
    ).toBeVisible();
    await expect(retryButton).toHaveCount(0);
    expect(retryCalls).toBe(3);
    expect(retryPayloads[1]?.clientRequestId).toBe(
      retryPayloads[0]?.clientRequestId,
    );
    expect(retryPayloads[2]?.clientRequestId).toMatch(/^letter-reply-retry:/u);
    expect(retryPayloads[2]?.clientRequestId).not.toBe(
      retryPayloads[0]?.clientRequestId,
    );
    const scheduledMarkup = await page.content();
    for (const payload of retryPayloads) {
      expect(scheduledMarkup).not.toContain(payload.clientRequestId);
    }
    await page.screenshot({
      path: test.info().outputPath("scheduled-reply-recovery.png"),
      fullPage: true,
    });
    expect(consoleErrors).toEqual([
      expect.stringMatching(/503 \(Service Unavailable\)/u),
    ]);
    expect(pageErrors).toEqual([]);
  });
});

async function createPublishedHighFidelityCharacter(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const generatedResponse = await request.post("/api/characters/generate", {
    data: {
      name,
      worldSetting: "当代城市",
      workOrRole: "地方档案馆研究员",
      coreTraits: ["耐心", "诚恳", "敏锐"],
      coreContradiction: "珍惜每段关系，却不愿用即时回应取代认真思考",
      mainGoal: "整理一套可以被长期保存的城市口述史",
      initialRelationship: "相互信任的老朋友",
      dialogueStyle: "克制、温暖且具体",
      tier: "high_fidelity",
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

async function rememberCharacter(page: Page, agentId: string): Promise<void> {
  await page.addInitScript((characterId) => {
    localStorage.setItem(
      "personasim.active-character.v1",
      JSON.stringify({ version: 1, characterId }),
    );
  }, agentId);
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

async function countLetterReplyCalls(
  request: APIRequestContext,
  agentId: string,
): Promise<number> {
  const response = await request.get("/api/developer/llm-calls?limit=500");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    calls: Array<{ agentId?: string; purpose?: string }>;
  };
  return body.calls.filter(
    (call) => call.agentId === agentId && call.purpose === "letter_reply",
  ).length;
}

async function readMailbox(
  request: APIRequestContext,
  agentId: string,
): Promise<CorrespondenceMailboxResponse> {
  const response = await request.get(`/api/agents/${agentId}/correspondence`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as CorrespondenceMailboxResponse;
}

async function readKeepsakes(
  request: APIRequestContext,
  agentId: string,
): Promise<KeepsakePageResponse> {
  const response = await request.get(
    `/api/agents/${agentId}/keepsakes?limit=50`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as KeepsakePageResponse;
}

async function findKeepsakeWithLetterSource(
  request: APIRequestContext,
  page: KeepsakePageResponse,
  letterId: string,
): Promise<KeepsakeDetailResponse | undefined> {
  for (const item of page.items) {
    const response = await request.get(`/api/keepsakes/${item.id}`);
    expect(response.ok()).toBe(true);
    const detail = (await response.json()) as KeepsakeDetailResponse;
    if (
      detail.sources.some(
        (source) => source.type === "letter" && source.id === letterId,
      )
    ) {
      return detail;
    }
  }
  return undefined;
}

function letterIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/^\/letters\/([^/]+)$/u);
  if (!match?.[1]) throw new Error(`Unable to read letter id from ${url}`);
  return decodeURIComponent(match[1]);
}
