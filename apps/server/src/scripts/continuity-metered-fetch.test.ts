import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { createOpenAiCompatibleLlmProvider } from "@personasim/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createContinuityMeteredFetch } from "./continuity-metered-fetch.js";

describe("physical continuity request admission", () => {
  it("bounds internal provider retries and preserves unknown attempts across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-meter-"));
    const contained = relative(resolve(tmpdir()), resolve(directory));
    if (
      contained.startsWith("..") ||
      !contained.startsWith("continuity-meter-")
    )
      throw new Error("Unexpected cleanup path");
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
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("shared continuity request ledger and complete response evidence", () => {
  let directory: string;
  let ledgerPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "continuity-meter-shared-"));
    ledgerPath = join(directory, "attempts.jsonl");
  });
  afterEach(async () => {
    const contained = relative(resolve(tmpdir()), resolve(directory));
    if (
      contained.startsWith("..") ||
      !contained.startsWith("continuity-meter-shared-")
    )
      throw new Error("Unexpected cleanup path");
    await rm(directory, { recursive: true, force: true });
  });

  it("shares admission across concurrent provider wrappers and preserves token counts", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ usage: { prompt_tokens: 14, completion_tokens: 3 } }),
        ),
      );
    const settings = {
      ledgerPath,
      budget: { maxPhysicalRequests: 2, maxReservedTokenUnits: 100000 },
      fetch: network,
    };
    const character = createContinuityMeteredFetch(settings);
    const user = createContinuityMeteredFetch(settings);
    const init = { body: JSON.stringify({ max_tokens: 10 }) };
    const attempts = await Promise.allSettled([
      character("https://test.invalid", init),
      user("https://test.invalid", init),
      character("https://test.invalid", init),
    ]);
    expect(attempts.map((item) => item.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
    expect(network).toHaveBeenCalledTimes(2);
    const rows = (await readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      rows.filter((row) => row.stage === "reserved").map((row) => row.attempt),
    ).toEqual([1, 2]);
    expect(rows.find((row) => row.stage === "responded")?.usage).toEqual({
      prompt_tokens: 14,
      completion_tokens: 3,
    });
  });

  it("bounds reserved units across wrappers even when the physical count has room", async () => {
    const init = { body: JSON.stringify({ max_tokens: 10 }) };
    const reservation = Buffer.byteLength(init.body, "utf8") + 10;
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    const settings = {
      ledgerPath,
      budget: { maxPhysicalRequests: 10, maxReservedTokenUnits: reservation },
      fetch: network,
    };
    const first = createContinuityMeteredFetch(settings);
    const second = createContinuityMeteredFetch(settings);
    await first("https://test.invalid", init);
    await expect(second("https://test.invalid", init)).rejects.toThrow(
      "budget_reached",
    );
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("retains non-JSON gateway errors without credentials and reports unknown usage", async () => {
    const raw = "gateway error: opaque-credential-value";
    const metered = createContinuityMeteredFetch({
      ledgerPath,
      budget: { maxPhysicalRequests: 1, maxReservedTokenUnits: 10000 },
      secrets: ["opaque-credential-value"],
      fetch: () => Promise.resolve(new Response(raw, { status: 502 })),
    });
    const response = await metered("https://test.invalid", {
      body: JSON.stringify({ max_tokens: 10 }),
    });
    expect(await response.text()).toBe(raw);
    const ledger = await readFile(ledgerPath, "utf8");
    expect(ledger).toContain('"response":"gateway error: [REDACTED]"');
    expect(ledger).toContain('"responseFormat":"text"');
    expect(ledger).toContain('"usage":"unknown"');
    expect(ledger).not.toContain("opaque-credential-value");
  });

  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid ceilings before dispatch: %s",
    (ceiling) => {
      for (const budget of [
        { maxPhysicalRequests: ceiling, maxReservedTokenUnits: 1000 },
        { maxPhysicalRequests: 10, maxReservedTokenUnits: ceiling },
      ])
        expect(() =>
          createContinuityMeteredFetch({ ledgerPath, budget }),
        ).toThrow("invalid_request_budget");
    },
  );

  it("does not replenish the budget when a persisted reservation is missing or malformed", async () => {
    const network = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    const metered = createContinuityMeteredFetch({
      ledgerPath,
      budget: { maxPhysicalRequests: 3, maxReservedTokenUnits: 10000 },
      fetch: network,
    });
    const init = { body: JSON.stringify({ max_tokens: 10 }) };
    await metered("https://test.invalid", init);
    await writeFile(ledgerPath, "");
    await expect(metered("https://test.invalid", init)).rejects.toThrow(
      "ledger_regressed",
    );
    await writeFile(
      ledgerPath,
      JSON.stringify({ stage: "reserved", attempt: 1 }) + "\n",
    );
    await expect(metered("https://test.invalid", init)).rejects.toThrow(
      "invalid_request_ledger",
    );
    expect(network).toHaveBeenCalledTimes(1);
  });
});
