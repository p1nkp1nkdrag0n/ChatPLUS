import { afterEach, describe, expect, it, vi } from "vitest";
import { achievementsApi } from "./achievements";

afterEach(() => vi.unstubAllGlobals());

describe("achievement client requests", () => {
  it("acknowledges merged offline batches within the server request limit", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    await achievementsApi.acknowledge(
      Array.from({ length: 125 }, (_, index) => `earned-${index}`),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(
      (fetch.mock.calls[0]?.[1] as { body: string }).body,
    ) as { ids: string[] };
    const second = JSON.parse(
      (fetch.mock.calls[1]?.[1] as { body: string }).body,
    ) as { ids: string[] };
    expect(first.ids).toHaveLength(100);
    expect(second.ids).toHaveLength(25);
    expect(second.ids[0]).toBe("earned-100");
  });
  it("encodes collection filters and never sends client dates for visits", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items: [] }),
    });
    vi.stubGlobal("fetch", fetch);
    await achievementsApi.list({
      category: "character",
      agentId: "role/a b",
      cursor: "24",
      limit: 24,
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/achievements?category=character&agentId=role%2Fa+b&cursor=24&limit=24",
    );
    await achievementsApi.visit();
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
    });
  });

  it("acknowledges only the displayed IDs and encodes badge detail IDs", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    await achievementsApi.acknowledge(["earned-1", "earned-2"]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      body: '{"ids":["earned-1","earned-2"]}',
    });
    await achievementsApi.get("earned/1");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/achievements/earned%2F1");
  });

  it("exposes a safe actionable server error rather than rendering raw response data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () =>
          Promise.resolve({
            error: {
              code: "IMAGE_NOT_CONFIGURED",
              message: "请先保存生图配置",
            },
          }),
      }),
    );
    await expect(achievementsApi.retryBadge("earned-1")).rejects.toMatchObject({
      code: "IMAGE_NOT_CONFIGURED",
      message: "请先保存生图配置",
      status: 503,
    });
  });
});
