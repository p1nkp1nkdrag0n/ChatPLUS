import { expect, type Page } from "@playwright/test";

export const mainQuestionFields = [
  "gender",
  "name",
  "ageText",
  "worldSetting",
  "workOrRole",
  "appearanceDescription",
  "personality",
  "dailyHabits",
  "importantExperience",
  "dialogueStyle",
  "currentFocus",
  "additionalDetails",
] as const;

export type InterviewTestAnswers = Partial<
  Record<(typeof mainQuestionFields)[number], string>
>;

export const basicInterviewAnswers: InterviewTestAnswers = {
  gender: "女性",
  name: "阿澄",
  ageText: "二十多岁",
  worldSetting: "湖边的一座当代小城",
  workOrRole: "书店店员",
  personality: "温和、好奇，习惯先听别人说完",
};

export async function answerMainQuestion(
  page: Page,
  field: (typeof mainQuestionFields)[number],
  value?: string,
): Promise<void> {
  const form = page.getByTestId("character-generator");
  await expect(form).toHaveAttribute("data-question", field);
  if (field === "gender") {
    const custom = value !== "女性" && value !== "男性";
    await page
      .getByRole("radio", { name: custom ? "自定义" : value, exact: true })
      .click();
    if (custom)
      await page
        .getByRole("textbox", { name: "自定义性别", exact: true })
        .fill(value ?? "非二元");
  } else if (value === undefined) {
    await expect(page.locator("#interview-answer")).not.toHaveAttribute(
      "required",
    );
    await page.getByRole("button", { name: "暂时略过", exact: true }).click();
    return;
  } else {
    await page.locator("#interview-answer").fill(value);
  }
  await page.getByTestId("interview-next").click();
}

export async function fillMainInterview(
  page: Page,
  answers: InterviewTestAnswers,
  startAt = 0,
): Promise<void> {
  for (const field of mainQuestionFields.slice(startAt)) {
    await answerMainQuestion(page, field, answers[field]);
  }
}

export async function skipInterviewFollowUps(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "先写到这里", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "先写到这里", exact: true }).click();
  await expect(page.getByTestId("generate-character")).toBeVisible();
}

export async function completeInterviewToPreview(
  page: Page,
  answers: InterviewTestAnswers,
): Promise<string> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/create");
  await fillMainInterview(page, answers);
  await skipInterviewFollowUps(page);
  await page.getByTestId("generate-character").click();
  await expect(page).toHaveURL(/\/characters\/[^/]+\/preview$/, {
    timeout: 30_000,
  });
  return new URL(page.url()).pathname.split("/")[2];
}
