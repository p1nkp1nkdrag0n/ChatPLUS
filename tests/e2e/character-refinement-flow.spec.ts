import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { CharacterCreationPreview } from "../../packages/contracts/src/character-interview";
import { mockConfiguredWelcomeCatalog } from "./api-onboarding-fixture";
import {
  basicInterviewAnswers,
  completeInterviewToPreview,
} from "./character-interview-helpers";

async function capture(page: Page, name: string) {
  const directory = process.env["CHARACTER_QA_DIR"];
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
}

test.describe("character biography refinement", () => {
  test.setTimeout(90_000);
  test.beforeEach(async ({ page }) => {
    await mockConfiguredWelcomeCatalog(page);
  });

  test("keeps feedback through failure and refresh, retries one request and supports another revision", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      // The test deliberately returns one 503 to exercise feedback recovery.
      if (message.type() === "error" && !message.text().includes("503")) {
        errors.push(message.text());
      }
    });
    const characterId = await completeInterviewToPreview(page, {
      ...basicInterviewAnswers,
      name: "林澈",
      personality: "温和但有主见，愿意理解别人，也会说出自己的不同意见",
      dailyHabits: "傍晚沿河散步，留意街边的小变化",
      importantExperience: "曾随外祖父修补过一本家谱",
      dialogueStyle: "自然克制，关心具体的事，不急着替别人做决定",
    });
    const previewUrl = `/api/characters/${characterId}/creation-preview`;
    const first = (await (
      await request.get(previewUrl)
    ).json()) as CharacterCreationPreview;
    expect(first.canRefine).toBe(true);
    await expect(page).toHaveTitle("读一读人物小传 · Dearvale");
    await expect(page.getByTestId("character-preview")).toContainText("林澈");
    await capture(page, `portrait-${test.info().project.name}`);
    await page.getByTestId("refine-character").click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${characterId}/refine$`),
    );
    await expect(page).toHaveTitle("调整人物设定 · Dearvale");
    const feedback =
      "把名字改为林汐，性格改为温和但有主见。多写一些面对不同意见时的表现，保留原来的职业和经历。";
    const field = page.getByTestId("refine-feedback");
    await field.fill(feedback);
    await page.reload();
    await expect(field).toHaveValue(feedback);
    await capture(page, `refine-${test.info().project.name}`);
    const requests: Array<Record<string, unknown>> = [];
    let fail = true;
    await page.route("**/api/characters/interview/refine", async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      if (fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "llm_unavailable",
              message: "模型暂时不可用，请重试。",
            },
          }),
        });
      } else await route.continue();
    });
    await page.getByTestId("submit-refinement").click();
    await expect(
      page.getByText("模型暂时不可用，请重试。", { exact: false }),
    ).toBeVisible();
    await expect(field).toHaveValue(feedback);
    await page.reload();
    await expect(field).toHaveValue(feedback);
    await page.getByTestId("submit-refinement").click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${characterId}/preview$`),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[1]).toMatchObject({
      characterId,
      expectedVersion: first.characterVersion,
      feedback,
    });
    const revised = (await (
      await request.get(previewUrl)
    ).json()) as CharacterCreationPreview;
    expect(revised.characterVersion).toBe(first.characterVersion + 1);
    await page.reload();
    for (const paragraph of revised.paragraphs) {
      await expect(page.getByTestId("character-preview")).toContainText(
        paragraph,
      );
    }
    await page.getByTestId("refine-character").click();
    await expect(field).toHaveValue("");
    await field.fill("保留现在的设定，把面对陌生人时的表达写得更具体一些。");
    await page.getByTestId("submit-refinement").click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${characterId}/preview$`),
    );
    expect(requests).toHaveLength(3);
    expect(requests[2]!["expectedVersion"]).toBe(revised.characterVersion);
    expect(requests[2]!["requestId"]).not.toBe(requests[1]!["requestId"]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("renders the feedback form and current biography on a narrow screen", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await completeInterviewToPreview(page, basicInterviewAnswers);
    await page.getByTestId("refine-character").click();
    await expect(page.getByTestId("character-refinement")).toBeVisible();
    const field = page.getByTestId("refine-feedback");
    await field.fill(
      "希望她的好奇心更具体：遇到陌生的话题时，会怎样提问和倾听？保留温和的表达方式。",
    );
    await field.scrollIntoViewIfNeeded();
    await expect(field).toBeVisible();
    await capture(page, "refine-mobile");
    await expect(page.getByTestId("submit-refinement")).toBeEnabled();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("requires reading the latest biography before retrying a stale revision", async ({
    page,
    request,
  }) => {
    const characterId = await completeInterviewToPreview(
      page,
      basicInterviewAnswers,
    );
    const previewUrl = `/api/characters/${characterId}/creation-preview`;
    const first = (await (
      await request.get(previewUrl)
    ).json()) as CharacterCreationPreview;
    await page.getByTestId("refine-character").click();
    const feedback = "让她更愿意表达不同意见，保留原来的职业。";
    await page.getByTestId("refine-feedback").fill(feedback);
    const concurrent = await request.post("/api/characters/interview/compile", {
      data: {
        characterId,
        expectedVersion: first.characterVersion,
        requestId: `e2e-concurrent-${Date.now()}`,
        answers: { ...first.answers, name: "阿澄·新稿" },
      },
    });
    expect(concurrent.ok()).toBe(true);
    const latest = (await concurrent.json()) as {
      preview: CharacterCreationPreview;
    };
    const attempts: Array<Record<string, unknown>> = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().endsWith("/interview/refine")) {
        attempts.push(req.postDataJSON() as Record<string, unknown>);
      }
    });
    await page.getByTestId("submit-refinement").click();
    await expect(page.getByTestId("refinement-refresh")).toBeVisible();
    await expect(page.getByTestId("refine-feedback")).toHaveValue(feedback);
    await page.getByTestId("refinement-refresh").click();
    await expect(page.getByTestId("character-refinement")).toContainText(
      "阿澄·新稿",
    );
    await expect(page.getByTestId("submit-refinement")).toBeDisabled();
    expect(attempts).toHaveLength(1);
    await page.getByTestId("refinement-confirm-version").click();
    await page.getByTestId("submit-refinement").click();
    await expect(page).toHaveURL(
      new RegExp(`/characters/${characterId}/preview$`),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!["expectedVersion"]).toBe(first.characterVersion);
    expect(attempts[1]!["expectedVersion"]).toBe(
      latest.preview.characterVersion,
    );
    expect(attempts[1]!["requestId"]).not.toBe(attempts[0]!["requestId"]);
  });
});
