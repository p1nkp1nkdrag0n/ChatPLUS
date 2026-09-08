import { defineConfig, devices } from "@playwright/test";

const webPort = process.env["CHATPLUS_E2E_WEB_PORT"] ?? "43173";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  // Both viewport projects intentionally exercise the same disposable backend.
  // Keep them sequential because its FakeClock and developer LLM-call ledger are
  // process-global mutable test seams.
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Dearvale's current release targets desktop; both approved sizes run the full suite.
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "chromium-wide",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
});
