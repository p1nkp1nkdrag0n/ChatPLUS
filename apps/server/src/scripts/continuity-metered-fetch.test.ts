import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { createOpenAiCompatibleLlmProvider } from "@personasim/providers";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";

describe("physical continuity request admission", () => {
  it("bounds internal provider retries and preserves unknown attempts across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-meter-"));
    try {
      const ledgerPath = join(directory, "attempts.jsonl");
      const network = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("network down"));
      const settings = {
        ledgerPath,
        budget: { maxPhysicalRequests: 2, maxReservedTokenUnits: 100000 },
        fetch: network,
      };
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "test-credential-only",
        baseUrl: "https://test.invalid",
        model: "test",
        maxRetries: 3,
        retryDelay: () => Promise.resolve(),
        fetch: createContinuityMeteredFetch(settings),
      });
      await expect(
        provider.generateObject({
          purpose: "test",
          system: "system",
          prompt: "hello",
          schema: z.object({ text: z.string() }),
        }),
      ).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(2);
      const resumed = createContinuityMeteredFetch(settings);
      await expect(
        resumed("https://test.invalid", {
          body: JSON.stringify({ max_tokens: 10 }),
        }),
      ).rejects.toThrow("budget_reached");
      expect(network).toHaveBeenCalledTimes(2);
      const ledger = await readFile(ledgerPath, "utf8");
      expect(ledger).not.toContain("test-credential-only");
      expect(
        ledger
          .split("\n")
          .filter((line) => line.includes('"stage":"reserved"')),
      ).toHaveLength(2);
      expect(ledger).toContain('"usage":"unknown"');
    } finally {
      const contained = relative(resolve(tmpdir()), resolve(directory));
      if (
        contained.startsWith("..") ||
        !contained.startsWith("continuity-meter-")
      )
        throw new Error("Unexpected cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
