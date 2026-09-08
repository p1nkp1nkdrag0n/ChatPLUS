import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize(
    testInfo.project.name === "mobile-chromium"
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  );
  await page.goto("/about");
  await expect(page.locator(".marketing-page")).toHaveAttribute(
    "data-motion",
    "normal",
  );
});

test("ripples do not return after rapid motion changes, offscreen or hidden", async ({
  page,
}) => {
  const river = page.getByTestId("river-water");
  await page.locator("#forest-stream").scrollIntoViewIfNeeded();
  await expect(page.locator("#forest-stream")).toHaveAttribute(
    "data-active",
    "true",
  );
  const bank = page.locator(".layer-bank img");
  await expect
    .poll(() =>
      bank.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await bank.evaluate(async (image) => {
    await (image as HTMLImageElement).decode();
  });
  await pauseClock(page);
  const clickRiverAt = async (x: number, y: number) => {
    let bounds = await river.boundingBox();
    if (!bounds) throw new Error("River must have a rendered hit region");
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("This test requires a fixed viewport");
    const pointY = bounds.y + bounds.height * y;
    if (pointY < 80 || pointY > viewport.height - 30) {
      await page.evaluate(
        (distance) => window.scrollBy({ top: distance, behavior: "instant" }),
        pointY - viewport.height * 0.7,
      );
      await page.clock.runFor(32);
      bounds = await river.boundingBox();
      if (!bounds) throw new Error("River disappeared after native scroll");
    }
    await river.evaluate(
      (element) =>
        new Promise<void>((resolveVisible) => {
          const observer = new IntersectionObserver(([entry]) => {
            if (!entry?.isIntersecting) return;
            observer.disconnect();
            resolveVisible();
          });
          observer.observe(element);
        }),
    );
    await page.mouse.click(
      bounds.x + bounds.width * x,
      bounds.y + bounds.height * y,
    );
  };
  const createRipple = async () => {
    await clickRiverAt(0.75, 0.75);
    await expect(page.locator(".water-ripple")).toHaveCount(1);
  };
  // The stone lies inside the river curve, so only the foreground alpha mask
  // can reject it. The other point checks the outside of the shared curve.
  await clickRiverAt(0.776, 0.95);
  await expect(page.locator(".water-ripple")).toHaveCount(0);
  await clickRiverAt(0.5, 0.75);
  await expect(page.locator(".water-ripple")).toHaveCount(0);
  await createRipple();
  await setMotion(page, "still");
  await expect(page.locator(".water-ripple")).toHaveCount(0);
  await setMotion(page, "auto");
  await expect(page.locator(".water-ripple")).toHaveCount(0);
  await createRipple();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.clock.runFor(32);
  await expect(page.locator(".water-ripple")).toHaveCount(0);
  await page.locator("#forest-stream").scrollIntoViewIfNeeded();
  await page.clock.runFor(32);
  await expect(page.locator(".water-ripple")).toHaveCount(0);
  await createRipple();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(".water-ripple")).toHaveCount(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1000);
  await expect(page.locator(".water-ripple")).toHaveCount(0);
});

test("opening offscreen completes without stealing focus and does not replay", async ({
  page,
}) => {
  const envelope = page.locator(".demo-envelope");
  const open = page.getByRole("button", { name: "查看书信演示", exact: true });
  await open.scrollIntoViewIfNeeded();
  await pauseClock(page);
  await open.click();
  await expect(envelope).toHaveAttribute("data-phase", "opening");
  await page.evaluate(() => {
    document.getElementById("site-title")?.focus();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.clock.runFor(32);
  await expect(envelope).toHaveAttribute("data-phase", "readable");
  await expect(page.locator("#site-title")).toBeFocused();
  await page.locator("#writing-desk").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "收起示例", exact: true }).click();
  await expect(envelope).toHaveAttribute("data-phase", "closed");
  await expect(open).toBeFocused();
  await open.click();
  await expect(envelope).toHaveAttribute("data-phase", "readable");
  await expect(
    page.getByRole("heading", { name: "关于那片水光", exact: true }),
  ).toBeFocused();
});

async function pauseClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date("2026-09-08T00:00:00.000Z") });
  await page.clock.pauseAt(new Date("2026-09-08T00:00:00.100Z"));
}

async function setMotion(
  page: Page,
  preference: "auto" | "still",
): Promise<void> {
  await page.evaluate((value) => {
    localStorage.setItem("chatplus.motion.v1", value);
    window.dispatchEvent(new Event("chatplus-motion-change"));
  }, preference);
  await expect(page.locator(".marketing-page")).toHaveAttribute(
    "data-motion",
    preference === "auto" ? "normal" : "still",
  );
}
