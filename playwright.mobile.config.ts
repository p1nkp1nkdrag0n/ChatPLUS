import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

// Reuse the disposable fixture backend, on ports separate from desktop QA.
process.env["CHATPLUS_E2E_API_PORT"] =
  process.env["CHATPLUS_MOBILE_E2E_API_PORT"] ?? "43271";
process.env["CHATPLUS_E2E_WEB_PORT"] =
  process.env["CHATPLUS_MOBILE_E2E_WEB_PORT"] ?? "43273";
process.env["CHATPLUS_E2E_WEBSITE_PORT"] =
  process.env["CHATPLUS_MOBILE_E2E_WEBSITE_PORT"] ?? "43274";
process.env["PERSONASIM_LOAD_ENV"] = "false";

const artifactRoot =
  process.env["CHATPLUS_MOBILE_QA_DIR"] ?? join(tmpdir(), "dearvale-mobile-qa");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "mobile-flow.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  outputDir: join(artifactRoot, "results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${process.env["CHATPLUS_E2E_WEB_PORT"]}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    ...[
      { name: "iphone-pro-402", width: 402, height: 874 },
      { name: "iphone-pro-max-440", width: 440, height: 956 },
      { name: "android-360", width: 360, height: 800 },
      { name: "mobile-landscape-956", width: 956, height: 440 },
    ].map(({ name, width, height }) => ({
      name,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width, height },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    })),
    {
      name: "desktop-1440",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
