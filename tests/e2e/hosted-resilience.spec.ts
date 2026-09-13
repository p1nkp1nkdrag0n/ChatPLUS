import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  HostedAttempt,
  HostedMe,
  HostedSessionBilling,
} from "../../apps/web/src/api/hosted";

async function openHostedChat(
  page: Page,
  request: APIRequestContext,
  turnCount = 1,
) {
  const generated = await request.post("/api/characters/generate", {
    data: {
      name: "林夏",
      worldSetting: "当代城市",
      workOrRole: "书店店员",
      coreTraits: ["温暖", "耐心"],
      dialogueStyle: "自然简洁",
      tier: "lightweight",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.ok()).toBeTruthy();
  const { character } = (await generated.json()) as {
    character: { id: string; version: number };
  };
  const published = await request.post(
    `/api/characters/${character.id}/publish`,
    { data: { expectedVersion: character.version } },
  );
  expect(published.ok()).toBeTruthy();
  const created = await request.post(`/api/agents/${character.id}/sessions`, {
    data: {},
  });
  expect(created.ok()).toBeTruthy();
  const { session } = (await created.json()) as { session: { id: string } };
  const sessionId = session.id;
  const billing: HostedSessionBilling = { turns: {} };
  const state = {
    meStatus: 200 as number | "network",
    meCalls: 0,
    billingCalls: [] as string[],
    billing,
    errors: [] as string[],
    session: {
      user: {
        id: "ui-hosted-user",
        username: "测试朋友",
        role: "user",
        status: "active",
        mustChangePassword: false,
        createdAtUtc: "2026-09-13T00:00:00Z",
        updatedAtUtc: "2026-09-13T00:00:00Z",
        consentVersion: null,
        consentAtUtc: null,
      },
      wallet: {
        userId: "ui-hosted-user",
        balanceMicros: 100_000_000,
        reservedMicros: 0,
        availableMicros: 100_000_000,
      },
      csrfToken: "ui-csrf-fixture",
    } satisfies HostedMe,
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  page.on("console", (message) => {
    if (
      ["error", "warning"].includes(message.type()) &&
      !message.text().startsWith("Failed to load resource:")
    )
      state.errors.push(message.text());
  });
  await page.clock.install();
  await page.route("**/api/hosted/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/info")
      return route.fulfill({
        json: { hosted: true, surface: "user", csrfToken: "ui-csrf-fixture" },
      });
    if (path === "/api/hosted/me") {
      state.meCalls++;
      if (state.meStatus === "network")
        return route.abort("internetdisconnected");
      return route.fulfill({
        status: state.meStatus,
        json:
          state.meStatus === 200
            ? state.session
            : {
                error: { code: "injected_outage", message: "测试连接暂时中断" },
              },
      });
    }
    if (path.startsWith("/api/hosted/billing")) {
      state.billingCalls.push(route.request().url());
      return route.fulfill({ json: state.billing });
    }
    return route.fallback();
  });
  const messages = Array.from({ length: turnCount }, (_, index) => {
    const clientMessageId = `turn-${index}`;
    state.billing.turns[clientMessageId] = [];
    const common = {
      agentId: character.id,
      sessionId,
      metadata: {},
      createdAtUtc: "2026-09-13T00:00:00Z",
    };
    return [
      {
        ...common,
        id: `user-${index}`,
        role: "user",
        content: `用户消息 ${index}`,
        messageKind: "user",
        clientMessageId,
      },
      {
        ...common,
        id: `assistant-${index}`,
        role: "assistant",
        content: `朋友的回复 ${index}`,
        messageKind: "assistant_reply",
        inReplyToMessageId: `user-${index}`,
      },
    ];
  }).flat();
  await page.route(`**/api/sessions/${sessionId}/messages`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { messages } })
      : route.fallback(),
  );
  const enter = async () => {
    await page.goto(`/characters/${character.id}/chat?sessionId=${sessionId}`);
    await expect(page.getByTestId("chat-input")).toBeEnabled();
    await expect(page).toHaveTitle("Dearvale");
    await expect(page).toHaveURL(
      new RegExp(`/characters/${character.id}/chat\\?sessionId=${sessionId}$`),
    );
    await expect(
      page.getByRole("heading", { name: "林夏", exact: true }),
    ).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await expect.poll(() => state.billingCalls.length).toBe(1);
  };
  return {
    state,
    sessionId,
    characterId: character.id,
    messages,
    enter,
  };
}

test("requires a successful initial identity check before mounting the application", async ({
  page,
  request,
}) => {
  const { state } = await openHostedChat(page, request);
  state.meStatus = 502;
  await page.goto("/characters");
  await expect(page.locator(".hosted-auth")).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveCount(0);
  state.meStatus = 200;
  await page.getByRole("button", { name: "重新验证", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("preserves the actual composer DOM and unsent text through 502 and network errors, then recovers", async ({
  page,
  request,
}, testInfo) => {
  const { state, enter } = await openHostedChat(page, request);
  await enter();
  const composer = page.getByTestId("chat-input");
  await composer.fill("这段还没有发送的话，需要保留下来。");
  await composer.evaluate((element) => {
    element.setAttribute("data-lifecycle-proof", "original-composer");
  });
  for (const failure of [502, "network"] as const) {
    state.meStatus = failure;
    const before = state.meCalls;
    await page.clock.fastForward(60_100);
    await expect.poll(() => state.meCalls).toBeGreaterThan(before);
    await expect(
      page.getByText("连接暂时中断，正在保留当前页面和输入。"),
    ).toBeVisible();
    await expect(composer).toHaveValue("这段还没有发送的话，需要保留下来。");
    await expect(composer).toHaveAttribute(
      "data-lifecycle-proof",
      "original-composer",
    );
    await expect(composer).toBeEnabled();
    if (failure === 502 && process.env["CHATPLUS_QA_SCREENSHOT_DIR"]) {
      mkdirSync(process.env["CHATPLUS_QA_SCREENSHOT_DIR"], { recursive: true });
      await page.screenshot({
        path: join(
          process.env["CHATPLUS_QA_SCREENSHOT_DIR"],
          `hosted-outage-${testInfo.project.name}.png`,
        ),
      });
    }
    state.meStatus = 200;
    await page.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(page.locator(".hosted-connection-notice")).toHaveCount(0);
    await expect(composer).toHaveAttribute(
      "data-lifecycle-proof",
      "original-composer",
    );
    await expect(composer).toHaveValue("这段还没有发送的话，需要保留下来。");
  }
  expect(state.errors).toEqual([]);
});

for (const status of [401, 403]) {
  test(`still blocks the application after an explicit ${status} session rejection`, async ({
    page,
    request,
  }) => {
    const { state, enter } = await openHostedChat(page, request);
    await enter();
    state.meStatus = status;
    await page.clock.fastForward(60_100);
    await expect(page.getByTestId("chat-input")).toHaveCount(0);
    await expect(page.locator(".hosted-auth")).toBeVisible();
    expect(state.errors).toEqual([]);
  });
}

test("loads 100 historical reply costs with one session request and does not poll missing history", async ({
  page,
  request,
}) => {
  const { state, sessionId, enter } = await openHostedChat(page, request, 100);
  await enter();
  await expect(page.locator(".hosted-reply-usage")).toHaveCount(100);
  await page.clock.fastForward(35_000);
  expect(state.billingCalls).toHaveLength(1);
  expect(new URL(state.billingCalls[0]!).pathname).toBe(
    `/api/hosted/billing/sessions/${sessionId}`,
  );
  await expect(page.locator(".hosted-wallet-link strong")).toContainText("100");
  expect(state.errors).toEqual([]);
});

test("refreshes the session's usage and the wallet once after a newly sent reply", async ({
  page,
  request,
}) => {
  const { state, sessionId, characterId, messages, enter } =
    await openHostedChat(page, request);
  await enter();
  const meBefore = state.meCalls;
  await page.route(`**/api/sessions/${sessionId}/messages`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const input = route.request().postDataJSON() as {
      clientMessageId: string;
      text: string;
    };
    const common = {
      agentId: characterId,
      sessionId,
      metadata: {},
      createdAtUtc: "2026-09-13T00:01:00Z",
    };
    const userMessage = {
      ...common,
      id: "new-user",
      role: "user",
      content: input.text,
      messageKind: "user",
      clientMessageId: input.clientMessageId,
    };
    const assistantMessage = {
      ...common,
      id: "new-assistant",
      role: "assistant",
      content: "这是新回复。",
      messageKind: "assistant_reply",
      inReplyToMessageId: "new-user",
    };
    messages.push(userMessage, assistantMessage);
    state.billing.turns[input.clientMessageId] = [
      {
        id: "new-attempt",
        operationId: `chat:${input.clientMessageId}`,
        purpose: "chat_turn",
        status: "settled",
        costMicros: 1_000_000,
        usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 },
        createdAtUtc: common.createdAtUtc,
      },
    ];
    state.session.wallet = {
      ...state.session.wallet,
      balanceMicros: 99_000_000,
      availableMicros: 99_000_000,
    };
    await route.fulfill({
      json: { userMessage, assistantMessage, idempotentReplay: false },
    });
  });
  await page.getByTestId("chat-input").fill("请收下这条新消息。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.getByText("这是新回复。", { exact: true })).toBeVisible();
  await expect.poll(() => state.billingCalls.length).toBe(2);
  await expect.poll(() => state.meCalls).toBe(meBefore + 1);
  await expect(page.locator(".hosted-reply-usage").last()).toContainText(
    "1.00 积分",
  );
  await expect(page.locator(".hosted-wallet-link strong")).toContainText("99");
  expect(state.errors).toEqual([]);
});

test.describe("mobile hosted connection state", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("keeps the draft editable with a visible recovery notice", async ({
    page,
    request,
  }) => {
    const { state, enter } = await openHostedChat(page, request);
    await enter();
    await page.getByTestId("chat-input").fill("手机上的草稿");
    state.meStatus = 502;
    await page.clock.fastForward(60_100);
    await expect(page.locator(".hosted-connection-notice")).toBeInViewport();
    const notice = await page
      .locator(".hosted-connection-notice")
      .boundingBox();
    const input = await page.getByTestId("chat-input").boundingBox();
    expect(notice && input && notice.y + notice.height <= input.y).toBe(true);
    await expect(page.getByTestId("chat-input")).toHaveValue("手机上的草稿");
    await page.getByTestId("chat-input").fill("手机上的草稿继续补充");
    if (process.env["CHATPLUS_QA_SCREENSHOT_DIR"]) {
      mkdirSync(process.env["CHATPLUS_QA_SCREENSHOT_DIR"], { recursive: true });
      await page.screenshot({
        path: join(
          process.env["CHATPLUS_QA_SCREENSHOT_DIR"],
          "hosted-outage-mobile.png",
        ),
      });
    }
    state.meStatus = 200;
    await page.getByRole("button", { name: "重新连接", exact: true }).click();
    await expect(page.locator(".hosted-connection-notice")).toHaveCount(0);
    await expect(page.getByTestId("chat-input")).toHaveValue(
      "手机上的草稿继续补充",
    );
    expect(state.errors).toEqual([]);
  });
});

test("only the current pending turn drives one watcher and settlement refreshes the authoritative wallet", async ({
  page,
  request,
}) => {
  const { state, enter } = await openHostedChat(page, request, 100);
  const attempt = (id: string): HostedAttempt => ({
    id,
    operationId: `chat:${id}`,
    purpose: "chat_turn",
    status: "reserved",
    costMicros: null,
    usage: null,
    createdAtUtc: "2026-09-13T00:00:00Z",
    displayName: "测试模型",
  });
  state.billing.turns["turn-0"] = [attempt("turn-0")];
  state.billing.turns["turn-99"] = [attempt("turn-99")];
  await enter();
  await page.clock.fastForward(2600);
  await expect.poll(() => state.billingCalls.length).toBe(2);
  state.billing.turns["turn-99"][0] = {
    ...attempt("turn-99"),
    status: "settled",
    costMicros: 1_000_000,
    usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: null },
  };
  state.session.wallet = {
    ...state.session.wallet,
    balanceMicros: 99_000_000,
    availableMicros: 99_000_000,
  };
  const meBefore = state.meCalls;
  await page.clock.fastForward(2600);
  await expect.poll(() => state.billingCalls.length).toBe(3);
  await expect.poll(() => state.meCalls).toBe(meBefore + 1);
  await expect(page.locator(".hosted-wallet-link strong")).toContainText("99");
  await page.clock.fastForward(10_000);
  expect(state.billingCalls).toHaveLength(3);
  // The historical reserved call is still visible but does not keep a watcher alive.
  await expect(page.locator(".hosted-reply-usage").first()).toContainText(
    "待核对用量",
  );
  await expect(page.locator(".hosted-reply-usage").last()).toContainText(
    "缓存命中 未知",
  );
  expect(state.errors).toEqual([]);
});
