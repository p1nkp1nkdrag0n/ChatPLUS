import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./types";
import {
  diariesApi,
  diaryErrorMessage,
  diaryQueryKeys,
  localDiaryDate,
} from "./diaries";

const entry = {
  id: "diary-1",
  agentId: "agent:a",
  entryDate: "2026-09-13",
  timezone: "Asia/Shanghai",
  title: "雨停之后",
  body: "今晚，你说起了窗边的花。\n\n我想把这句话留下。",
  revision: 2,
  createdAtUtc: "2026-09-13T12:00:00.000Z",
  updatedAtUtc: "2026-09-13T13:00:00.000Z",
  sourceMessageIds: ["message-1"],
  validity: "current",
  hasNewMaterial: false,
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("diary API", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("encodes character IDs and sends the exact user action, date, timezone and expected revision", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ volumes: [] }))
      .mockResolvedValueOnce(response({ entries: [entry] }))
      .mockResolvedValueOnce(response({ entry }));
    vi.stubGlobal("fetch", fetch);
    await diariesApi.volumes({ agentId: "agent:a", year: 2026, month: 9 });
    expect(
      (await diariesApi.entries("agent:a", "2026-09")).entries[0]?.body,
    ).toBe(entry.body);
    const input = {
      entryDate: entry.entryDate,
      timezone: entry.timezone,
      clientRequestId: "request-1",
      expectedRevision: 1,
    };
    await diariesApi.generate("agent:a", input);
    expect(fetch.mock.calls[0]![0]).toBe(
      "/api/diaries/volumes?agentId=agent%3Aa&year=2026&month=9",
    );
    expect(fetch.mock.calls[1]![0]).toBe(
      "/api/agents/agent%3Aa/diaries?month=2026-09",
    );
    expect(fetch.mock.calls[2]![0]).toBe("/api/agents/agent%3Aa/diaries");
    expect(fetch.mock.calls[2]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(input),
    });
    expect(diaryQueryKeys.entries("agent:a", "2026-09")).not.toEqual(
      diaryQueryKeys.entries("agent:b", "2026-09"),
    );
  });

  it("surfaces no-material and revision conflicts instead of manufacturing diary text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response(
            { error: { code: "diary_no_material", message: "No material" } },
            422,
          ),
        ),
    );
    await expect(
      diariesApi.generate("a", {
        entryDate: "2026-09-13",
        timezone: "UTC",
        clientRequestId: "r1",
      }),
    ).rejects.toMatchObject({ code: "diary_no_material", status: 422 });
    expect(
      diaryErrorMessage(
        new ApiError({
          code: "diary_revision_conflict",
          status: 409,
          message: "Conflict",
        }),
      ),
    ).toContain("已有更新");
    expect(
      diaryErrorMessage(new Error("private provider payload")),
    ).not.toContain("private");
  });

  it("rejects malformed returned data and formats dates in the browser's local calendar", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ entries: [{ ...entry, body: ["not a string"] }] }),
        ),
    );
    await expect(diariesApi.entries("a", "2026-09")).rejects.toThrow();
    expect(localDiaryDate(new Date(2026, 8, 3, 0, 5))).toBe("2026-09-03");
  });
});
