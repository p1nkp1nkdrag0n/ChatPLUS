import { expect, test } from "@playwright/test";
import type { HostedMe } from "../../apps/web/src/api/hosted";

test("shows the generated login account until acknowledged, even after a session refresh", async ({
  page,
}) => {
  const session: HostedMe = {
    user: {
      id: "identity-ui-user",
      username: "圆圆",
      accountName: "圆圆#000123",
      role: "user",
      status: "active",
      mustChangePassword: false,
      createdAtUtc: "2026-09-18T00:00:00Z",
      updatedAtUtc: "2026-09-18T00:00:00Z",
      consentVersion: null,
      consentAtUtc: null,
    },
    wallet: {
      userId: "identity-ui-user",
      balanceMicros: 0,
      reservedMicros: 0,
      availableMicros: 0,
    },
    csrfToken: "identity-test-csrf",
  };
  let authenticated = false;
  let authenticatedReads = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.route("**/api/hosted/info", (route) =>
    route.fulfill({
      json: {
        hosted: true,
        surface: "user",
        registrationEnabled: true,
        csrfToken: session.csrfToken,
      },
    }),
  );
  await page.route("**/api/hosted/me", async (route) => {
    if (authenticated) {
      authenticatedReads++;
      await route.fulfill({ json: session });
    } else
      await route.fulfill({
        status: 401,
        json: {
          error: { code: "authentication_required", message: "Sign in" },
        },
      });
  });
  await page.route("**/api/hosted/auth/register", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      username: "圆圆",
      password: "testing-user-password",
      inviteCode: "test-invite",
    });
    authenticated = true;
    await route.fulfill({ json: session });
  });
  await page.route("**/api/hosted/billing", (route) =>
    route.fulfill({ json: { attempts: [], entries: [] } }),
  );
  await page.route("**/api/hosted/models", (route) =>
    route.fulfill({ json: { models: [] } }),
  );
  await page.route("**/api/llm/user-settings", (route) =>
    route.fulfill({
      json: {
        revision: 1,
        onboardingCompleted: true,
        bindings: {},
        imageSelection: null,
      },
    }),
  );

  await page.goto("/account");
  await expect(page).toHaveTitle(/Dearvale/);
  await page.getByRole("button", { name: "收到邀请码？创建账号" }).click();
  await expect(page.locator("#hosted-username-help")).toContainText("圆圆");
  await page
    .getByLabel("用户名（角色对你的称呼）", { exact: true })
    .fill("圆圆");
  await page.getByLabel("密码", { exact: true }).fill("testing-user-password");
  await page.getByLabel("邀请码", { exact: true }).fill("test-invite");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "账号创建成功" }),
  ).toBeVisible();
  await expect(page.getByLabel("完整账号（用于登录）")).toHaveValue(
    "圆圆#000123",
  );
  await page.clock.fastForward(61_000);
  await expect.poll(() => authenticatedReads).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "账号创建成功" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的账号" })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("registration-account.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "我已保存账号，进入 Dearvale" })
    .click();
  await expect(page.getByRole("heading", { name: "我的账号" })).toBeVisible();
  await expect(page.getByLabel("完整账号（用于登录）")).toHaveValue(
    "圆圆#000123",
  );
  expect(errors).toEqual([]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("完整账号（用于登录）")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("account-mobile.png"),
    fullPage: true,
  });
});
