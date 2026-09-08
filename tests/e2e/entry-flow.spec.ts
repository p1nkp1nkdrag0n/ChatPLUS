import { expect, test } from "@playwright/test";

test.describe("first visit and returning entrance", () => {
  test("saved still mode and live system preferences reach the entrance", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("chatplus.motion.v1", "still"),
    );
    await page.goto("/start");
    await expect(page).toHaveTitle("ChatPLUS · 开始使用");
    await expect(page.locator("html")).toHaveAttribute("data-motion", "still");
    await expect(page.locator(".experience-transition")).toHaveCSS(
      "animation-name",
      "none",
    );
    await page.evaluate(() => {
      localStorage.setItem("chatplus.motion.v1", "auto");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "chatplus.motion.v1",
          newValue: "auto",
        }),
      );
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-motion",
      "reduced",
    );
    await expect(page.locator(".experience-transition")).toHaveCSS(
      "animation-name",
      "none",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("html")).toHaveAttribute("data-motion", "normal");
  });

  test("start is a static guide even with a remembered active character", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "personasim.active-character.v1",
        JSON.stringify({
          version: 1,
          characterId: "never-activate-from-start",
        }),
      );
    });
    const apiRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        apiRequests.push(request.url());
    });
    await page.goto("/start");
    await expect(
      page.getByRole("heading", { name: "从一次相遇开始。" }),
    ).toBeVisible();
    await expect(
      page.getByText("pnpm db:migrate", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "进入应用" })).toHaveAttribute(
      "href",
      "/welcome",
    );
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(apiRequests).toEqual([]);
  });

  test("the first root visit offers usable creation and text import with no published character", async ({
    page,
  }) => {
    await page.route("**/api/characters", (route) =>
      route.fulfill({ json: { characters: [] } }),
    );
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname.startsWith("/api/") &&
        request.method() !== "GET"
      )
        mutations.push(request.url());
    });
    await page.goto("/");
    await expect(page).toHaveURL("/welcome");
    await expect(
      page.getByRole("heading", { name: "欢迎来到 ChatPLUS" }),
    ).toBeVisible();
    await expect(
      page.getByText("还没有可对话的角色。创建一位，或从文字中导入。"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "进入角色列表" }),
    ).toHaveAttribute("href", "/characters");
    await expect(
      page.getByRole("link", { name: "导入角色", exact: true }),
    ).toHaveAttribute("href", "/import");
    await page.getByRole("link", { name: "创建角色", exact: true }).click();
    await expect(page).toHaveURL("/create");
    await expect(page.getByLabel("角色名称")).toBeVisible();
    expect(mutations).toEqual([]);
  });

  test("a returning root visit does not replay welcome", async ({ page }) => {
    await page.goto("/characters");
    await expect(
      page.getByRole("heading", { name: "角色", exact: true }),
    ).toBeVisible();
    await page.goto("/");
    await expect(page).toHaveURL("/characters");
    await expect(
      page.getByRole("heading", { name: "欢迎来到 ChatPLUS" }),
    ).toHaveCount(0);
  });

  test("removed or archived recent characters fall back without a stale activation", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "chatplus.entry.v1",
        JSON.stringify({
          version: 1,
          entered: true,
          lastRoute: "/characters/no-longer-available/chat",
        }),
      );
      localStorage.setItem(
        "personasim.active-character.v1",
        JSON.stringify({ version: 1, characterId: "no-longer-available" }),
      );
    });
    await page.route("**/api/characters", (route) =>
      route.fulfill({
        json: {
          characters: [
            {
              id: "no-longer-available",
              name: "已归档角色",
              status: "archived",
              sourceType: "original",
              tier: "daily",
              version: 1,
              updatedAtUtc: "2026-09-08T00:00:00Z",
            },
          ],
        },
      }),
    );
    const activations: string[] = [];
    page.on("request", (request) => {
      if (
        /\/api\/agents\/no-longer-available\/(activate|events)/.test(
          request.url(),
        )
      )
        activations.push(request.url());
    });
    await page.goto("/");
    await expect(page).toHaveURL("/characters");
    await expect(
      page.getByRole("heading", { name: "角色", exact: true }),
    ).toBeVisible();
    expect(activations).toEqual([]);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("personasim.active-character.v1"),
      ),
    ).toBeNull();
  });

  test("returning navigation revalidates a previously cached character list", async ({
    page,
  }) => {
    let removed = false;
    await page.route("**/api/characters", (route) =>
      route.fulfill({
        json: {
          characters: removed
            ? []
            : [
                {
                  id: "recently-removed",
                  name: "原有角色",
                  status: "published",
                  sourceType: "original",
                  tier: "daily",
                  version: 1,
                  updatedAtUtc: "2026-09-08T00:00:00Z",
                },
              ],
        },
      }),
    );
    await page.goto("/characters");
    await expect(
      page.getByRole("heading", { name: "原有角色", exact: true }),
    ).toBeVisible();
    removed = true;
    const activations: string[] = [];
    page.on("request", (request) => {
      if (
        /\/api\/agents\/recently-removed\/(activate|events)/.test(request.url())
      )
        activations.push(request.url());
    });
    await page.evaluate(() => {
      localStorage.setItem(
        "chatplus.entry.v1",
        JSON.stringify({
          version: 1,
          entered: true,
          lastRoute: "/characters/recently-removed/chat",
        }),
      );
      history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page).toHaveURL("/characters");
    await expect(
      page.getByRole("heading", { name: "原有角色", exact: true }),
    ).toHaveCount(0);
    expect(activations).toEqual([]);
  });

  test("welcome uses the actual published character id and leaves navigation immediate", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "personasim.active-character.v1",
        JSON.stringify({
          version: 1,
          characterId: "removed-previous-character",
        }),
      );
    });
    await page.route("**/api/characters", (route) =>
      route.fulfill({
        json: {
          characters: [
            {
              id: "draft-only",
              name: "草稿角色",
              status: "draft",
              sourceType: "original",
              tier: "daily",
              version: 1,
              updatedAtUtc: "2026-09-08T00:00:00Z",
            },
            {
              id: "actual-server-id",
              name: "当前角色",
              status: "published",
              sourceType: "original",
              tier: "daily",
              version: 1,
              updatedAtUtc: "2026-09-08T00:00:00Z",
            },
          ],
        },
      }),
    );
    await page.goto("/welcome");
    await expect(
      page.getByRole("link", { name: "先聊一会儿 与 当前角色" }),
    ).toHaveAttribute("href", "/characters/actual-server-id/chat");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("personasim.active-character.v1"),
      ),
    ).toBeNull();
    await expect(page.getByRole("link", { name: /草稿角色/ })).toHaveCount(0);
    await page.getByRole("link", { name: "使用说明", exact: true }).click();
    await expect(page).toHaveURL("/start");
    await page.getByRole("link", { name: "进入应用" }).click();
    await expect(page).toHaveURL("/welcome");
    await expect(
      page.getByRole("heading", { name: "欢迎来到 ChatPLUS" }),
    ).toBeFocused();
    await expect(page.locator(".app-shell")).toHaveCount(0);
  });
});
