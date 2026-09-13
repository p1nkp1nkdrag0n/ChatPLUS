import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedApi, formatPoints, pointsToMicros } from "./hosted";
import { request } from "./client";
import {
  configureHostedSession,
  hostedRequestHeaders,
  resetHostedLocalState,
} from "../lib/hostedSession";

describe("hosted browser transport boundary", () => {
  afterEach(() => {
    configureHostedSession(false);
    vi.unstubAllGlobals();
  });

  it("uses local mode only when the hosted probe is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 404 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: "maintenance", message: "请稍后重试" },
            }),
            { status: 503 },
          ),
        ),
    );
    await expect(hostedApi.info()).resolves.toEqual({ hosted: false });
    await expect(hostedApi.info()).rejects.toMatchObject({
      status: 503,
      code: "maintenance",
    });
  });

  it("keeps CSRF and idempotency in headers and preserves a logical message identity on retries", async () => {
    configureHostedSession(true, "csrf-test-only");
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetch);
    for (let index = 0; index < 2; index++)
      await request("/api/sessions/s/messages", {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: "stable-message",
          text: "test input",
        }),
      });
    for (const [url, init] of fetch.mock.calls as [string, RequestInit][]) {
      expect(url).not.toContain("csrf");
      expect(new Headers(init.headers).get("X-CSRF-Token")).toBe(
        "csrf-test-only",
      );
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
        "stable-message",
      );
    }
    expect(hostedRequestHeaders("GET")).toEqual({});
    configureHostedSession(false);
    expect(hostedRequestHeaders("POST", {})).toEqual({});
  });

  it("preserves a caller supplied operation key", async () => {
    configureHostedSession(true, "csrf-test-only");
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await request("/api/characters/import", {
      method: "POST",
      headers: { "Idempotency-Key": "original-upload" },
      body: "{}",
    });
    expect(
      new Headers((fetch.mock.calls[0]?.[1] as RequestInit).headers).get(
        "Idempotency-Key",
      ),
    ).toBe("original-upload");
  });

  it("does not carry a previous participant's browser drafts into a new account", () => {
    const values = new Map([
      ["dearvale.hosted-user.v1", "previous-user"],
      ["personasim.active-character.v1", "private-character"],
      ["dearvale.last-conversation.v1", "private-session"],
      ["dearvale.character-interview.v1", "private-draft"],
      ["unrelated-setting", "keep"],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    resetHostedLocalState("new-user");
    expect([...values.entries()]).toEqual([
      ["dearvale.hosted-user.v1", "new-user"],
      ["unrelated-setting", "keep"],
    ]);
  });

  it("downloads research as a blob and never treats a failed export as a data file", async () => {
    configureHostedSession(true, "csrf-test-only");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"kind":"input"}\n', {
            headers: { "content-type": "application/x-ndjson" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: "admin_required", message: "管理员权限不足" },
            }),
            { status: 403 },
          ),
        ),
    );
    expect(
      await (await hostedApi.researchExport({ kind: "input" })).text(),
    ).toBe('{"kind":"input"}\n');
    await expect(hostedApi.researchExport({})).rejects.toMatchObject({
      status: 403,
      code: "admin_required",
    });
  });

  it("keeps small charges visible and rejects invalid point amounts", () => {
    expect(formatPoints(1)).toBe("0.000001");
    expect(formatPoints(null)).toBe("待确认");
    expect(pointsToMicros("0.000001")).toBe(1);
    expect(pointsToMicros("12.345678")).toBe(12_345_678);
    for (const value of ["-1", "NaN", "1e9", "0.0000001", "9999999999999999"])
      expect(() => pointsToMicros(value)).toThrow();
  });
});
