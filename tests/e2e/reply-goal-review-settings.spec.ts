import { expect, test } from "@playwright/test";
import { GetSettingsResponseSchema } from "../../packages/contracts/src/api.js";

test("saves reply goal review from settings and retains it after reload", async ({
  page,
  request,
}) => {
  await request.put("/api/settings", {
    data: { replyGoalReviewEnabled: false },
  });
  await page.goto("/settings");
  const toggle = page.getByRole("switch", {
    name: "回复目标复核",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(
    GetSettingsResponseSchema.parse(
      await (await request.get("/api/settings")).json(),
    ).settings.replyGoalReviewEnabled,
  ).toBe(false);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator(".save-success")).toHaveText("已保存");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(
    GetSettingsResponseSchema.parse(
      await (await request.get("/api/settings")).json(),
    ).settings.replyGoalReviewEnabled,
  ).toBe(true);
  await toggle.click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator(".save-success")).toHaveText("已保存");
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});
