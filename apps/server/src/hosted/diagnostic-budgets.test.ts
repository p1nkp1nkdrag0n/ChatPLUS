import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverLlmModels } from "@personasim/providers";
import {
  HostedModelGateway,
  type HostedGatewayStore,
} from "./model-gateway.js";
import type {
  HostedAttempt,
  HostedAttemptResponse,
  HostedLimits,
} from "./types.js";

const mebibyte = 1024 * 1024;
const endpoint = "https://fixture.example/v1/models";
const limits: HostedLimits = {
  registrationEnabled: false,
  callsEnabled: true,
  globalConcurrency: 64,
  perUserConcurrency: 64,
  maxQueuedCalls: 100,
  maxRequestBytes: 4 * mebibyte,
  perUserDailyMicros: 1,
  globalDailyMicros: 1,
  researchRetentionDays: 0,
  sessionDays: 7,
};

function fixture(transport: typeof fetch) {
  const attempts = new Map<string, HostedAttempt>();
  const responses = new Map<string, HostedAttemptResponse>();
  const store: HostedGatewayStore = {
    getLimits: () => limits,
    resolveModel: () => {
      throw new Error("Diagnostics must not resolve platform credentials");
    },
    resolvePurpose: () => {
      throw new Error("Diagnostics must not resolve platform credentials");
    },
    findAttempt: (id) => attempts.get(id),
    reserve: (input) => {
      const item: HostedAttempt = {
        ...input,
        operationId: input.operationId ?? input.id,
        parentOperationId: input.parentOperationId ?? null,
        sessionId: input.sessionId ?? null,
        status: "reserved",
        costMicros: null,
        usage: null,
        providerRequestId: null,
        reason: null,
        createdAtUtc: new Date().toISOString(),
        updatedAtUtc: new Date().toISOString(),
      };
      attempts.set(item.id, item);
      return item;
    },
    markAttemptSent: (id) => {
      attempts.get(id)!.status = "sent";
    },
    settle: ({ id, costMicros }) => {
      attempts.get(id)!.status = "settled";
      attempts.get(id)!.costMicros = costMicros;
    },
    markUnknown: (id) => {
      attempts.get(id)!.status = "unknown";
    },
    release: (id) => {
      attempts.get(id)!.status = "released";
    },
    recordResearch: vi.fn(),
    recordAttemptResponse: (id, response) => responses.set(id, response),
    readAttemptResponse: (id) => responses.get(id),
    recordAttemptImage: vi.fn(),
    readAttemptImage: () => undefined,
    recordAttemptAsset: vi.fn(),
  };
  const gateway = new HostedModelGateway(store, vi.fn(), transport);
  return { gateway, attempts, responses };
}

function pageBody(bytes: number, cursor = "next"): string {
  const prefix = JSON.stringify({
    models: [
      {
        name: "models/model-one",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
    nextPageToken: cursor,
    padding: "",
  });
  return prefix.replace(
    '"padding":""',
    `"padding":"${"x".repeat(bytes - prefix.length)}"`,
  );
}

afterEach(() => vi.useRealTimers());

describe("hosted diagnostic resource budgets", () => {
  it("rejects an oversized page before persisting its response", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("x".repeat(mebibyte + 1))),
    );
    const f = fixture(transport);
    await expect(
      f.gateway.userDiagnosticsFetch("alice")(endpoint),
    ).rejects.toMatchObject({
      code: "provider_response_too_large",
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(f.responses.size).toBe(0);
    expect([...f.attempts.values()][0]?.status).toBe("unknown");
  });

  it("bounds a single paginated discovery even when the provider repeats one model with fresh cursors", async () => {
    let page = 0;
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(pageBody(900_000, `page-${++page}`))),
    );
    const f = fixture(transport);
    await expect(
      discoverLlmModels({
        protocol: "gemini",
        baseUrl: "https://fixture.example/v1beta",
        timeoutMs: 1000,
        fetch: f.gateway.userDiagnosticsFetch("alice"),
      }),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(5);
    expect(f.responses.size).toBe(4);
    expect(
      [...f.responses.values()].reduce(
        (size, response) => size + Buffer.byteLength(response.body),
        0,
      ),
    ).toBeLessThanOrEqual(4 * mebibyte);
  });

  it("preserves complete normal model lists across pages and stores the full diagnostic response", async () => {
    const pages = [
      { data: [{ id: "one" }], has_more: true, last_id: "one" },
      { data: [{ id: "two" }], has_more: false },
    ];
    let page = 0;
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(pages[page++])),
    );
    const f = fixture(transport);
    const models = await discoverLlmModels({
      protocol: "anthropic",
      baseUrl: "https://fixture.example/v1",
      apiKey: "TEST_KEY",
      timeoutMs: 1000,
      fetch: f.gateway.userDiagnosticsFetch("alice"),
    });
    expect(models.map((model) => model.id)).toEqual(["one", "two"]);
    expect(
      [...f.responses.values()].map(
        (response) => JSON.parse(response.body) as unknown,
      ),
    ).toEqual(pages);
    expect(
      [...f.attempts.values()].every((attempt) => attempt.costMicros === 0),
    ).toBe(true);
  });

  it("shares the daily request count across new actions and counts failed transports", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("fixture failure")),
    );
    const f = fixture(transport);
    for (let action = 0; action < 2; action++) {
      const fetch = f.gateway.userDiagnosticsFetch("alice");
      for (let page = 0; page < 100; page++)
        await expect(fetch(endpoint)).rejects.toThrow("fixture failure");
      await expect(fetch(endpoint)).rejects.toMatchObject({
        code: "diagnostic_budget_exceeded",
      });
    }
    await expect(
      f.gateway.userDiagnosticsFetch("alice")(endpoint),
    ).rejects.toMatchObject({ code: "diagnostic_budget_exceeded" });
    expect(transport).toHaveBeenCalledTimes(200);
    await expect(
      f.gateway.userDiagnosticsFetch("bob")(endpoint),
    ).rejects.toThrow("fixture failure");
    expect(transport).toHaveBeenCalledTimes(201);
  });

  it("caps daily response bytes across actions and restores the allowance on the next UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(" ".repeat(mebibyte - 2) + "{}")),
    );
    const f = fixture(transport);
    for (let action = 0; action < 8; action++) {
      const fetch = f.gateway.userDiagnosticsFetch("alice");
      for (let page = 0; page < 4; page++) await fetch(endpoint);
      await expect(fetch(endpoint)).rejects.toMatchObject({
        code: "diagnostic_budget_exceeded",
      });
    }
    await expect(
      f.gateway.userDiagnosticsFetch("alice")(endpoint),
    ).rejects.toMatchObject({ code: "diagnostic_budget_exceeded" });
    expect(transport).toHaveBeenCalledTimes(32);
    vi.setSystemTime(new Date("2026-09-19T00:00:00Z"));
    await f.gateway.userDiagnosticsFetch("alice")(endpoint);
    expect(transport).toHaveBeenCalledTimes(33);
  });

  it("reserves byte allowances before concurrent responses arrive and refunds unused bytes", async () => {
    const pending: Array<(response: Response) => void> = [];
    const transport = vi.fn<typeof fetch>(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const f = fixture(transport);
    const requests = Array.from({ length: 32 }, () =>
      f.gateway.userDiagnosticsFetch("alice")(endpoint),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(32));
    await expect(
      f.gateway.userDiagnosticsFetch("alice")(endpoint),
    ).rejects.toMatchObject({ code: "diagnostic_budget_exceeded" });
    for (const resolve of pending.splice(0)) resolve(new Response("{}"));
    await Promise.all(requests);
    const next = f.gateway.userDiagnosticsFetch("alice")(endpoint);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!(new Response("{}"));
    await next;
    expect(transport).toHaveBeenCalledTimes(33);
  });

  it("includes credential-redaction expansion in its storage limit", async () => {
    const transport = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ padding: "x".repeat(100_000) })),
    );
    const f = fixture(transport);
    await expect(
      f.gateway.userDiagnosticsFetch("alice")(endpoint, {
        headers: { authorization: "Bearer x" },
      }),
    ).rejects.toMatchObject({ code: "provider_response_too_large" });
    expect(f.responses.size).toBe(0);
  });
});
