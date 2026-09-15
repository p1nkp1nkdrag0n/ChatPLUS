import { afterEach, describe, expect, it, vi } from "vitest";
import { interviewApi } from "./interview";
import { ApiError } from "./types";

describe("character refinement transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the reviewed version and preserves feedback and operation identity on retries", async () => {
    const response = {
      character: { id: "character-1", version: 4 },
      preview: { characterVersion: 4 },
    };
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(response))),
      );
    vi.stubGlobal("fetch", fetch);
    const input = {
      characterId: "character-1",
      expectedVersion: 3,
      feedback: "  调整性格\n保留职业  ",
      requestId: "request-1",
    };
    await expect(interviewApi.refine(input)).resolves.toEqual(response);
    await interviewApi.refine(input);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      expect(call).toEqual([
        "/api/characters/interview/refine",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(input),
        }),
      ]);
    }
  });

  it("returns version conflicts to the page without falling back to draft mutation", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "version_conflict",
            message: "描绘已有更新",
            issues: { expectedVersion: 3, currentVersion: 4 },
            requestId: "server-request-1",
          },
        }),
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = interviewApi.refine({
      characterId: "character-1",
      expectedVersion: 3,
      feedback: "调整性格",
      requestId: "request-1",
    });
    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      status: 409,
      code: "version_conflict",
      message: "描绘已有更新",
      issues: [],
      requestId: "server-request-1",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
