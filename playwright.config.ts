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
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
