import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

const baseUrl = option("--url", "http://127.0.0.1:43179");
const output = resolve(option("--output", "tmp/early-summer-runtime"));
const sampleMs = Number(option("--sample-ms", "10000"));
if (!Number.isFinite(sampleMs) || sampleMs < 1000 || sampleMs > 30000) {
  throw new Error("--sample-ms must be between 1000 and 30000");
}
const chapters = ["sky-meadow", "forest-stream", "writing-desk", "ocean"];
const progressValues = [0, 0.25, 0.5, 0.75, 1];
const modes = ["auto", "reduced", "still"];
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const report = {
  measuredAtUtc: new Date().toISOString(),
  url: new URL("/about", baseUrl).href,
  browser: browser.version(),
  git: {
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    branch: execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
    }).trim(),
    trackedChanges: execFileSync("git", ["diff", "--name-only"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean),
  },
  environment:
    "Headless Chromium on the current Windows host; fixture Vite development server, not a production Lighthouse run or a physical phone.",
  sampleMs,
  limitations: [
    "rAF intervals measure callback cadence, not GPU frame presentation or field FPS.",
    "LCP and CLS are buffered lab observations for this navigation, not field percentiles.",
    "The click-to-DOM and next-rAF timings below are not INP.",
    "Decoded RGBA bytes = naturalWidth * naturalHeight * 4 is an estimate, not measured GPU texture memory.",
    "The 720 CSS px case represents desktop 200% reflow at 1440 device pixels; browser zoom and pinch zoom are not simulated.",
    "Progress endpoints outside scroll bounds are recorded as clamped, never presented as reached.",
  ],
  viewports: [],
};
const gallery = [];

try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });
    await context.addInitScript(() => {
      performance.setResourceTimingBufferSize(5000);
      window.__earlySummerMetrics = {
        lcp: null,
        cls: 0,
        clsTotal: 0,
        clsWindow: null,
        supported: [],
      };
      for (const type of ["largest-contentful-paint", "layout-shift"]) {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
        window.__earlySummerMetrics.supported.push(type);
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (type === "largest-contentful-paint") {
              window.__earlySummerMetrics.lcp = {
                startTime: entry.startTime,
                renderTime: entry.renderTime,
                loadTime: entry.loadTime,
                size: entry.size,
                url: entry.url,
                element: entry.element?.tagName ?? null,
              };
            } else if (!entry.hadRecentInput) {
              const metrics = window.__earlySummerMetrics;
              const session = metrics.clsWindow;
              if (
                !session ||
                entry.startTime - session.last > 1000 ||
                entry.startTime - session.start > 5000
              ) {
                metrics.clsWindow = {
                  start: entry.startTime,
                  last: entry.startTime,
                  value: entry.value,
                };
              } else {
                session.last = entry.startTime;
                session.value += entry.value;
              }
              metrics.clsTotal += entry.value;
              metrics.cls = Math.max(metrics.cls, metrics.clsWindow.value);
            }
          }
        }).observe({ type, buffered: true });
      }
    });
    const page = await context.newPage();
    const failedResponses = [];
    const failedRequests = [];
    const apiRequests = [];
    const consoleProblems = [];
    page.on("response", (response) => {
      if (response.status() >= 400)
        failedResponses.push({
          url: response.url(),
          status: response.status(),
        });
    });
    page.on("requestfailed", (request) =>
      failedRequests.push({
        url: request.url(),
        error: request.failure()?.errorText,
      }),
    );
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        apiRequests.push(request.url());
    });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        consoleProblems.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) =>
      consoleProblems.push(`pageerror: ${error.message}`),
    );
    await page.goto(report.url);
    await page.locator(".marketing-page").waitFor({ state: "visible" });
    const firstViewport = await page.evaluate(() => ({
      ...window.__earlySummerMetrics,
    }));
    const frameIntervals = await page.evaluate(
      (duration) =>
        new Promise((resolveSample) => {
          const values = [];
          let start;
          let previous;
          function frame(now) {
            if (start === undefined) start = now;
            if (previous !== undefined) values.push(now - previous);
            previous = now;
            if (now - start >= duration) resolveSample(values);
            else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        }),
      sampleMs,
    );
    const sortedFrames = [...frameIntervals].sort((a, b) => a - b);
    const firstScreen = await page.evaluate(() => {
      const art = performance
        .getEntriesByType("resource")
        .filter((entry) =>
          new URL(entry.name).pathname.startsWith("/art/early-summer/"),
        );
      const activeImages = [
        ...document.querySelectorAll('.scene[data-active="true"] img'),
      ];
      const uniqueActive = [
        ...new Map(
          activeImages.map((image) => [image.currentSrc || image.src, image]),
        ).values(),
      ];
      return {
        observedBeforeAnyScriptedScrollOrInteraction: true,
        lcp: window.__earlySummerMetrics.lcp,
        cls: window.__earlySummerMetrics.cls,
        artRequestCount: art.length,
        artEncodedBytes: art.reduce(
          (sum, item) => sum + item.encodedBodySize,
          0,
        ),
        artTransferBytes: art.reduce((sum, item) => sum + item.transferSize, 0),
        artUrls: art.map((item) => item.name),
        activeImageCount: uniqueActive.length,
        estimatedActiveRGBABytes: uniqueActive.reduce(
          (sum, image) => sum + image.naturalWidth * image.naturalHeight * 4,
          0,
        ),
      };
    });
    const artBudgetBytes =
      viewport.width > 700 ? Math.floor(1.8 * 1024 * 1024) : 900 * 1024;
    const activeDecodeBudgetBytes =
      (viewport.width > 700 ? 96 : 48) * 1024 * 1024;
    firstScreen.artBudgetBytes = artBudgetBytes;
    firstScreen.artBudgetStatus =
      firstScreen.artEncodedBytes <= artBudgetBytes ? "pass" : "exceeded";
    firstScreen.activeDecodeBudgetBytes = activeDecodeBudgetBytes;
    firstScreen.estimatedActiveDecodeBudgetStatus =
      firstScreen.estimatedActiveRGBABytes <= activeDecodeBudgetBytes
        ? "pass"
        : "exceeded";
    const percentile = (fraction) =>
      sortedFrames[
        Math.min(
          sortedFrames.length - 1,
          Math.floor(sortedFrames.length * fraction),
        )
      ] ?? null;
    const samples = [];
    for (const mode of modes) {
      await page
        .getByRole("combobox", { name: "场景动态", exact: true })
        .selectOption(mode);
      for (const [chapterIndex, id] of chapters.entries()) {
        for (const progress of progressValues) {
          const target = await page.evaluate(
            ({ id: sceneId, progress: p }) => {
              const scene = document.getElementById(sceneId);
              const rect = scene.getBoundingClientRect();
              const top = rect.top + window.scrollY;
              const start = Math.max(0, top - window.innerHeight);
              const end = top + rect.height;
              const wantedScrollY = start + p * (end - start);
              const maxScrollY =
                document.documentElement.scrollHeight - window.innerHeight;
              window.scrollTo({ top: wantedScrollY, behavior: "instant" });
              return {
                wantedScrollY,
                maxScrollY,
                targetProgress: p,
                clamped: wantedScrollY > maxScrollY,
              };
            },
            { id, progress },
          );
          await page.evaluate(
            () =>
              new Promise((resolveFrame) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(resolveFrame),
                ),
              ),
          );
          const measured = await page.locator(`#${id}`).evaluate((scene) => {
            const heading = scene.querySelector("h1, h2");
            const rect = heading.getBoundingClientRect();
            return {
              scrollY: window.scrollY,
              active: scene.dataset.active,
              computedProgress: Number(
                getComputedStyle(scene).getPropertyValue("--progress"),
              ),
              travel: getComputedStyle(scene)
                .getPropertyValue("--travel")
                .trim(),
              documentWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth,
              heading: heading.textContent,
              headingRect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
            };
          });
          samples.push({ mode, id, ...target, ...measured });
          // Four midpoint views per mode prove composition without retaining 60 PNGs.
          if (progress === 0.5) {
            await page.waitForFunction(() => {
              const visible = [...document.querySelectorAll(".scene")].filter(
                (scene) => {
                  const bounds = scene.getBoundingClientRect();
                  return bounds.top < innerHeight && bounds.bottom > 0;
                },
              );
              const images = visible.flatMap((scene) => [
                ...scene.querySelectorAll("img"),
              ]);
              return (
                images.length > 0 &&
                images.every((image) => image.naturalWidth > 0)
              );
            });
            await page.locator(".scene img").evaluateAll(async (images) => {
              await Promise.allSettled(
                images
                  .filter((image) => image.naturalWidth > 0)
                  .map((image) => image.decode()),
              );
            });
            const bytes = await page.screenshot({ scale: "css" });
            gallery.push({
              viewport: viewport.width,
              mode,
              chapterIndex,
              id,
              data: bytes.toString("base64"),
            });
          }
        }
      }
    }
    // Visit every chapter center, then decode each img to force a complete asset check.
    for (const id of chapters)
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    const images = await page.evaluate(async () => {
      await Promise.allSettled(
        [...document.images].map((image) => image.decode()),
      );
      return [...document.images].map((image) => ({
        url: image.currentSrc || image.src,
        complete: image.complete,
        loaded: image.naturalWidth > 0,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        estimatedDecodedRGBABytes: image.naturalWidth * image.naturalHeight * 4,
      }));
    });
    await page
      .getByRole("combobox", { name: "场景动态", exact: true })
      .selectOption("auto");
    await page
      .getByRole("button", { name: "查看后续对话", exact: true })
      .scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((item) =>
        item.textContent.includes("查看后续对话"),
      );
      const messages = document.querySelector(".demo-messages");
      let started;
      button.addEventListener(
        "click",
        () => {
          started = performance.now();
        },
        { once: true, capture: true },
      );
      const observer = new MutationObserver(() => {
        if (messages.children.length < 4 || started === undefined) return;
        observer.disconnect();
        const domMs = performance.now() - started;
        requestAnimationFrame(() => {
          window.__earlySummerMetrics.interaction = {
            eventToDOMMs: domMs,
            eventToNextRAFMs: performance.now() - started,
            description:
              "Synthetic click event capture to DOM change and next rAF; not INP.",
          };
        });
      });
      observer.observe(messages, { childList: true });
    });
    await page
      .getByRole("button", { name: "查看后续对话", exact: true })
      .click();
    await page.waitForFunction(() =>
      Boolean(window.__earlySummerMetrics.interaction),
    );
    const finalMetrics = await page.evaluate(() => ({
      ...window.__earlySummerMetrics,
      dpr: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      resources: performance.getEntriesByType("resource").map((entry) => ({
        url: entry.name,
        initiatorType: entry.initiatorType,
        durationMs: entry.duration,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
      })),
    }));
    const uniqueImages = [
      ...new Map(images.map((image) => [image.url, image])).values(),
    ];
    const resourceTotals = finalMetrics.resources.reduce(
      (sum, item) => ({
        transferBytes: sum.transferBytes + item.transferBytes,
        encodedBytes: sum.encodedBytes + item.encodedBytes,
        decodedBytes: sum.decodedBytes + item.decodedBytes,
      }),
      { transferBytes: 0, encodedBytes: 0, decodedBytes: 0 },
    );
    const imageResourceTotals = finalMetrics.resources
      .filter((item) =>
        /\.(?:png|webp|avif|jpe?g|svg)(?:$|\?)/i.test(
          new URL(item.url).pathname,
        ),
      )
      .reduce(
        (sum, item) => ({
          count: sum.count + 1,
          transferBytes: sum.transferBytes + item.transferBytes,
          encodedBytes: sum.encodedBytes + item.encodedBytes,
        }),
        { count: 0, transferBytes: 0, encodedBytes: 0 },
      );
    report.viewports.push({
      viewport,
      firstViewport,
      firstScreen,
      ...finalMetrics,
      frames: {
        count: frameIntervals.length,
        elapsedMs: frameIntervals.reduce((a, b) => a + b, 0),
        intervalsMs: frameIntervals.map(
          (value) => Math.round(value * 1000) / 1000,
        ),
        meanMs:
          frameIntervals.reduce((a, b) => a + b, 0) / frameIntervals.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maximumMs: sortedFrames.at(-1),
        above33Ms: frameIntervals.filter((value) => value > 33).length,
        above50Ms: frameIntervals.filter((value) => value > 50).length,
      },
      samples,
      images,
      uniqueImageCount: uniqueImages.length,
      estimatedUniqueDecodedRGBABytes: uniqueImages.reduce(
        (sum, item) => sum + item.estimatedDecodedRGBABytes,
        0,
      ),
      resourceTotals,
      imageResourceTotals,
      failedResponses,
      failedRequests,
      apiRequests,
      consoleProblems,
    });
    console.log(
      `Measured ${viewport.width}x${viewport.height}: ${frameIntervals.length} rAF intervals, ${images.length} img elements, ${failedResponses.length} failed HTTP responses`,
    );
    await context.close();
  }
  // Full chapter references are separate from progress/contact-sheet samples.
  // Their contexts do not feed the measurements or the public-page API ledger.
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const referenceContext = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });
    const reference = await referenceContext.newPage();
    await reference.goto(report.url);
    for (const id of chapters) {
      const chapter = reference.locator(`#${id}`);
      await chapter.evaluate((element) => {
        window.scrollTo({
          top: element.getBoundingClientRect().top + window.scrollY,
          behavior: "instant",
        });
      });
      await reference.waitForFunction((sceneId) => {
        const images = [...document.querySelectorAll(`#${sceneId} img`)];
        return (
          images.length > 0 && images.every((image) => image.naturalWidth > 0)
        );
      }, id);
      await chapter.locator("img").evaluateAll(async (images) => {
        await Promise.allSettled(images.map((image) => image.decode()));
      });
      await chapter.screenshot({
        path: resolve(output, `chapter-${id}-${viewport.width}.png`),
        scale: "css",
      });
    }
    await reference.goto(new URL("/welcome", baseUrl).href);
    await reference.locator("#welcome-title").waitFor({ state: "visible" });
    await reference
      .getByText("正在看看有哪些角色可以相遇…", { exact: true })
      .waitFor({ state: "hidden" });
    await reference.waitForFunction(() =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.playState !== "running" ||
            animation.effect?.getComputedTiming().iterations === Infinity,
        ),
    );
    await reference.screenshot({
      path: resolve(output, `welcome-${viewport.width}.png`),
      fullPage: true,
      scale: "css",
    });
    await referenceContext.close();
  }
  const reflowContext = await browser.newContext({
    viewport: { width: 720, height: 500 },
    deviceScaleFactor: 2,
  });
  const reflow = await reflowContext.newPage();
  await reflow.goto(report.url);
  await reflow.locator(".marketing-page").waitFor({ state: "visible" });
  await reflow.waitForFunction(() => {
    const images = [...document.querySelectorAll("#sky-meadow img")];
    return images.length > 0 && images.every((image) => image.naturalWidth > 0);
  });
  await reflow.locator("#sky-meadow img").evaluateAll(async (images) => {
    await Promise.all(images.map((image) => image.decode()));
  });
  report.desktop200PercentReflow = await reflow.evaluate(() => ({
    method:
      "720 CSS px viewport at DPR2, equivalent horizontal reflow to a 1440px-wide desktop at 200%; not native browser zoom.",
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    dpr: devicePixelRatio,
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  await reflow.screenshot({
    path: resolve(output, "desktop-200-percent-reflow.png"),
    scale: "css",
  });
  await reflowContext.close();
  // Browser-rendered contact sheets keep original screenshots as image sources;
  // only three compact grid PNGs are written, plus the reflow sample above.
  const contact = await browser.newPage({
    viewport: { width: 1200, height: 960 },
    deviceScaleFactor: 1,
  });
  for (const mode of modes) {
    const modeImages = gallery.filter((item) => item.mode === mode);
    await contact.setContent(
      `<style>body{margin:0;padding:18px;background:#f4f3ee;color:#263c31;font:14px sans-serif}h1{font-size:20px}section{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0;background:white;padding:6px}img{width:100%;height:360px;object-fit:contain;object-position:top}figcaption{padding:8px 0}</style><h1>ChatPLUS · ${mode} · four chapter midpoints · 1440 / 390 CSS px</h1><section>${modeImages.map((item) => `<figure><img src="data:image/png;base64,${item.data}"/><figcaption>${item.viewport}px · ${item.id} · p=0.5</figcaption></figure>`).join("")}</section>`,
    );
    await contact.screenshot({
      path: resolve(output, `grid-${mode}.png`),
      fullPage: true,
    });
  }
  await contact.close();
  await writeFile(
    resolve(output, "runtime-measurements.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const healthy =
    report.viewports.every(
      (item) =>
        item.failedResponses.length === 0 &&
        item.failedRequests.length === 0 &&
        item.apiRequests.length === 0 &&
        item.consoleProblems.length === 0 &&
        item.images.every((image) => image.loaded),
    ) && !report.desktop200PercentReflow.horizontalOverflow;
  console.log(
    `Wrote ${resolve(output, "runtime-measurements.json")}; resource health ${healthy ? "pass" : "fail"}`,
  );
  if (!healthy) process.exitCode = 1;
} finally {
  await browser.close();
}
