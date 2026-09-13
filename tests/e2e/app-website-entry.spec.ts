import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  mockConfiguredWelcomeCatalog,
  mockOnboardingLlm,
} from "./api-onboarding-fixture";

const websiteUrl = `http://127.0.0.1:${process.env["CHATPLUS_E2E_WEBSITE_PORT"] ?? "43174"}/`;

test("application root opens welcome and public links open the independent website", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockConfiguredWelcomeCatalog(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page).toHaveTitle("欢迎来到 Dearvale");
  await expect(page.locator(".welcome-page")).toBeVisible();
  await expect(page.getByTestId("story-journey")).toHaveCount(0);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.screenshot({
    path: join(tmpdir(), `dearvale-welcome-${test.info().project.name}.png`),
  });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "访问官网", exact: true }).click();
  const website = await popupPromise;
  await expect(website).toHaveURL(websiteUrl);
  await expect(website.getByTestId("story-journey")).toBeVisible();
  await expect(page).toHaveURL(/\/welcome$/);
  await website.close();
  expect(errors).toEqual([]);
});

test("an unconfigured application starts its model welcome setup without the public journey", async ({
  page,
}) => {
  await mockOnboardingLlm(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByTestId("api-setup")).toHaveAttribute(
    "data-step",
    "service",
  );
  await expect(page.getByTestId("story-journey")).toHaveCount(0);
});

test("website loads without API traffic and enters the separately hosted application", async ({
  page,
}) => {
  const apiRequests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      apiRequests.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(websiteUrl);
  await expect(page).toHaveTitle("Dearvale · 让相遇，慢慢成为故事");
  await expect(page.getByTestId("story-journey")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "前往星夜" }).click();
  await expect(page.locator(".story-stage")).toHaveAttribute("data-state", "5");
  expect(apiRequests).toEqual([]);
  await page.screenshot({
    path: join(tmpdir(), `dearvale-website-${test.info().project.name}.png`),
  });
  await mockConfiguredWelcomeCatalog(page);
  await page.getByRole("link", { name: "开始相遇", exact: true }).click();
  await expect(page).toHaveURL(
    `http://127.0.0.1:${process.env["CHATPLUS_E2E_WEB_PORT"] ?? "43173"}/welcome`,
  );
  await expect(page.locator(".welcome-page")).toBeVisible();
  expect(errors).toEqual([]);
});
