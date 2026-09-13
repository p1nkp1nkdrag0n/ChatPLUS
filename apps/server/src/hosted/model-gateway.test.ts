import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HostedControlStore } from "./control-store.js";
import {
  HostedModelGateway,
  hostedTextCost,
  normalizeHostedUsage,
} from "./model-gateway.js";
import type { HostedModelInput } from "./types.js";
import * as downloads from "../../../../packages/providers/src/safe-image-download.js";

const stores: HostedControlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
    rmSync(store.rootDirectory, { recursive: true, force: true });
  }
});
const model: HostedModelInput = {
  routeId: "friend",
  displayName: "好友模型",
  kind: "text",
  protocol: "openai-compatible",
  baseUrl: "https://provider.example.test/v1",
  modelId: "real-model",
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
  cacheReadMicrosPerMillion: 100_000,
  maxOutputTokens: 100,
  enabled: true,
  apiKey: "TEST_ONLY_CREDENTIAL",
};
function fixture() {
  const store = new HostedControlStore(
    mkdtempSync(join(tmpdir(), "dearvale-gateway-")),
  );
  stores.push(store);
  const admin = store.createAdministrator(
    "administrator",
    "not-a-live-password-hash",
  );
  const invite = store.createInvite(
    { maxUses: 3, initialBalanceMicros: 5_000_000 },
    admin.id,
  );
  const user = store.registerUser({
    username: "friend",
    passwordHash: "not-a-live-password-hash",
    inviteCode: invite.code,
    consentVersion: "v1",
  });
  store.upsertModel(model, admin.id);
  store.setLimits({ callsEnabled: true }, admin.id);
  store.setPurposeDefault("default", "friend", admin.id);
  return { store, admin, user, invite };
}
function response(
  content = '{"text":"hello"}',
  usage: unknown = {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 40 },
  },
  status = 200,
) {
  return new Response(
    JSON.stringify({
      model: "real-model",
      choices: [{ message: { content }, finish_reason: "stop" }],
      ...(usage ? { usage } : {}),
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": "provider-test-id",
      },
    },
  );
}
function generate(
  gateway: HostedModelGateway,
  userId: string,
  operationId: string,
) {
  return gateway.runOperation(
    { userId, operationId, publicModelId: "friend" },
    () =>
      gateway.forUser(userId).executionResolver!(
        "chat_turn",
      ).provider.generateObject({
        purpose: "chat_turn",
        system: "Be helpful",
        prompt: "Private test input",
        schema: z.object({ text: z.string() }),
      }),
  );
}

describe("hosted model accounting", () => {
  it("rejects zero input or output prices before any network request while allowing free cache reads", async () => {
    const { store, admin, user } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response()));
    const gateway = new HostedModelGateway(store, request);
    for (const [input, output] of [
      [0, 2_000_000],
      [1_000_000, 0],
      [0, 0],
    ]) {
      store.upsertModel(
        {
          ...model,
          inputMicrosPerMillion: input!,
          outputMicrosPerMillion: output!,
          cacheReadMicrosPerMillion: 0,
        },
        admin.id,
      );
      await expect(
        generate(gateway, user.id, `invalid-price-${input}-${output}`),
      ).rejects.toMatchObject({ code: "model_pricing_required" });
    }
    expect(request).not.toHaveBeenCalled();
    expect(store.listAttempts()).toHaveLength(0);
    expect(store.wallet(user.id).reservedMicros).toBe(0);
    store.upsertModel({ ...model, cacheReadMicrosPerMillion: 0 }, admin.id);
    expect(await generate(gateway, user.id, "free-cache-valid-base")).toEqual({
      text: "hello",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.listAttempts()[0]?.costMicros).toBe(100);
  });

  it("rechecks pricing on each physical retry even when the operation captured valid prices", async () => {
    const { store, admin, user } = fixture();
    const request = vi.fn<typeof fetch>().mockImplementation(() => {
      store.upsertModel(
        { ...model, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
        admin.id,
      );
      return Promise.resolve(response("{}", undefined, 503));
    });
    await expect(
      generate(
        new HostedModelGateway(store, request),
        user.id,
        "price-changed-before-retry",
      ),
    ).rejects.toMatchObject({ code: "model_pricing_required" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.listAttempts()).toHaveLength(1);
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 5_000_000 - 104,
      reservedMicros: 0,
    });
  });

  it("restores a historically settled zero-price response without dispatching or changing its snapshot", async () => {
    const { store, admin, user } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response()));
    await generate(
      new HostedModelGateway(store, request),
      user.id,
      "legacy-free-settled",
    );
    const old = store.listAttempts()[0]!;
    const historical = {
      ...old.modelSnapshot,
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0,
    };
    // Seed the precise state produced by the previous release's zero-price
    // settlement. This affects only this test's isolated temporary database.
    store.database
      .prepare(
        "UPDATE attempts SET model_json=?,maximum_cost=0,cost=0 WHERE id=?",
      )
      .run(JSON.stringify(historical), old.id);
    store.database
      .prepare("UPDATE ledger SET delta=0 WHERE attempt_id=?")
      .run(old.id);
    store.database
      .prepare("UPDATE wallets SET balance=balance+? WHERE user_id=?")
      .run(old.costMicros, user.id);
    store.upsertModel(
      { ...model, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
      admin.id,
    );
    store.setLimits({ callsEnabled: false }, admin.id);
    expect(
      await generate(
        new HostedModelGateway(store, request),
        user.id,
        "legacy-free-settled",
      ),
    ).toEqual({ text: "hello" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.findAttempt(old.id)).toMatchObject({
      modelSnapshot: historical,
      costMicros: 0,
      status: "settled",
    });
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 5_000_000,
      reservedMicros: 0,
    });
  });

  it("rejects image generation unless the fixed per-image price is positive", async () => {
    const { store, admin, user } = fixture();
    store.upsertModel(
      {
        ...model,
        routeId: "unpriced-image",
        kind: "image",
        imagePointsMicros: 0,
      },
      admin.id,
    );
    store.setPurposeDefault("achievement_badge", "unpriced-image", admin.id);
    const request = vi.fn<typeof fetch>();
    const provider = new HostedModelGateway(
      store,
      request,
    ).imageProviderFactory(user.id)({
      purpose: "achievement_badge",
      generationId: "zero-image",
    });
    await expect(
      provider.generate({
        width: 1024,
        height: 1024,
        idempotencyKey: "zero-image",
        visualSpec: {
          version: "achievement_badge_v1",
          subject: "leaf",
          setting: "garden",
          motifs: ["leaf"],
          palette: ["#FFFFFF", "#333333"],
          theme: "friendship",
        },
      }),
    ).rejects.toMatchObject({ code: "model_pricing_required" });
    expect(request).not.toHaveBeenCalled();
    expect(store.listAttempts()).toHaveLength(0);
  });
  it("uses complete input and discounts cache once, preserving protocol differences", () => {
    const snapshot = { ...model, revision: 1 };
    expect(
      hostedTextCost(
        snapshot,
        normalizeHostedUsage("openai-compatible", {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 40 },
          },
        }),
      ),
    ).toBe(104);
    expect(
      normalizeHostedUsage("anthropic", {
        usage: {
          input_tokens: 60,
          output_tokens: 20,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
      }),
    ).toMatchObject({
      inputTokens: 110,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
    });
    expect(
      normalizeHostedUsage("gemini", {
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 10,
          cachedContentTokenCount: 40,
        },
      }),
    ).toMatchObject({
      inputTokens: 100,
      outputTokens: 30,
      cacheReadTokens: 40,
    });
    expect(
      hostedTextCost(snapshot, { inputTokens: 100, outputTokens: 20 }),
    ).toBeUndefined();
    expect(
      hostedTextCost(snapshot, {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 200,
      }),
    ).toBeUndefined();
  });
  it("reconciles DeepSeek prompt, completion and cache tokens without counting cache twice", () => {
    const calls = [
      [3915, 176, 2304],
      [3833, 305, 2304],
      [3735, 233, 0],
      [6882, 10327, 5760],
    ];
    const totals = calls.reduce(
      (sum, [input, output, cached]) => {
        const usage = normalizeHostedUsage("openai-compatible", {
          usage: {
            prompt_tokens: input,
            completion_tokens: output,
            prompt_cache_hit_tokens: cached,
            prompt_cache_miss_tokens: input! - cached!,
          },
        });
        return {
          input: sum.input + usage.inputTokens!,
          output: sum.output + usage.outputTokens!,
          cached: sum.cached + usage.cacheReadTokens!,
        };
      },
      { input: 0, output: 0, cached: 0 },
    );
    expect(totals).toEqual({ input: 18365, output: 11041, cached: 10368 });
    expect(totals.input - totals.cached).toBe(7997);
    expect(totals.input + totals.output).toBe(29406);
  });

  it("charges authoritative usage, records encrypted research, and durably replays without dispatch", async () => {
    const { store, user } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    const gateway = new HostedModelGateway(store, request);
    expect(await generate(gateway, user.id, "turn-1")).toEqual({
      text: "hello",
    });
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 5_000_000 - 104,
      reservedMicros: 0,
    });
    const row = store.listAttempts({ userId: user.id })[0]!;
    expect(row).toMatchObject({
      status: "settled",
      costMicros: 104,
      providerRequestId: "provider-test-id",
    });
    expect(store.listResearch({ attemptId: row.id })).toHaveLength(2);
    const research = store.researchDatabase
      .prepare("SELECT payload_encrypted FROM research_records")
      .all();
    expect(JSON.stringify(research)).not.toContain("Private test input");
    expect(JSON.stringify(research)).not.toContain("TEST_ONLY_CREDENTIAL");
    const restarted = new HostedModelGateway(store, request);
    expect(await generate(restarted, user.id, "turn-1")).toEqual({
      text: "hello",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.listAttempts({ userId: user.id })).toHaveLength(1);
  });

  it("meters each structured repair and known-usage failed HTTP attempt", async () => {
    const { store, user } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response("{}", undefined, 503))
      .mockResolvedValueOnce(response());
    expect(
      await generate(
        new HostedModelGateway(store, request),
        user.id,
        "retry-known",
      ),
    ).toEqual({ text: "hello" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      store
        .listAttempts({ userId: user.id })
        .every((row) => row.status === "settled"),
    ).toBe(true);
    expect(store.wallet(user.id).balanceMicros).toBe(5_000_000 - 208);
  });

  it("redacts echoed current and historical credentials before research, accounting metadata, and business output", async () => {
    const { store, admin, user } = fixture();
    const historicalKey = model.apiKey!;
    const currentKey = "SECOND_TEST_ONLY_CREDENTIAL";
    const signedUrl =
      "https://assets.example.test/result.png?signature=a%2Fb%2Bz&expires=123";
    const answer = JSON.stringify({
      text: `Echo ${historicalKey} and ${currentKey}`,
      url: signedUrl,
    });
    const upstreamBody = JSON.stringify({
      choices: [{ message: { content: answer }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
    const request = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${historicalKey}`,
      );
      expect(init?.body).toContain(historicalKey);
      expect(init?.body).toContain(currentKey);
      expect(init?.body).toContain(signedUrl);
      return Promise.resolve(
        new Response(upstreamBody, {
          headers: {
            "content-type": `application/json; supplier-note=${historicalKey}`,
            "x-request-id": `request-${currentKey}-${historicalKey}`,
          },
        }),
      );
    });
    const gateway = new HostedModelGateway(store, request);
    const result = await gateway.runOperation(
      { userId: user.id, operationId: "key-echo", publicModelId: "friend" },
      () => {
        const execution = gateway.forUser(user.id).executionResolver!(
          "chat_turn",
        );
        // Rotate after the execution captured its immutable billing revision.
        // Both keys must be protected, including a supplier echo of today's key.
        store.upsertModel({ ...model, apiKey: currentKey }, admin.id);
        return execution.provider.generateObject({
          purpose: "chat_turn",
          system: "Be helpful",
          prompt: `Echo ${historicalKey} and ${currentKey}; keep ${signedUrl}`,
          schema: z.object({ text: z.string(), url: z.string() }),
        });
      },
    );
    expect(result).toEqual({
      text: "Echo [REDACTED_API_KEY] and [REDACTED_API_KEY]",
      url: signedUrl,
    });
    const attempt = store.listAttempts({ userId: user.id })[0]!;
    expect(attempt).toMatchObject({
      status: "settled",
      costMicros: 104,
      providerRequestId: "request-[REDACTED_API_KEY]-[REDACTED_API_KEY]",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
    });
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 5_000_000 - 104,
      reservedMicros: 0,
    });
    const savedResponse = store.readAttemptResponse(attempt.id)!;
    expect(savedResponse.headers?.["content-type"]).toBe(
      "application/json; supplier-note=[REDACTED_API_KEY]",
    );
    const exported = store.exportResearch({ attemptId: attempt.id }, admin.id);
    for (const copy of [
      JSON.stringify(attempt),
      JSON.stringify(savedResponse),
      exported,
      JSON.stringify(result),
    ]) {
      expect(copy).not.toContain(historicalKey);
      expect(copy).not.toContain(currentKey);
    }
    expect(exported).toContain(signedUrl);
    expect(store.listResearch({ attemptId: attempt.id })).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("redacts supplier failure bodies while retaining usage for each physical attempt", async () => {
    const { store, admin, user } = fixture();
    const failure = response("{}", undefined, 503);
    const failureBody = JSON.stringify({
      error: { message: `Supplier echoed ${model.apiKey!}` },
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(failureBody, { status: failure.status }),
      )
      .mockResolvedValueOnce(response());
    expect(
      await generate(
        new HostedModelGateway(store, request),
        user.id,
        "failed-key-echo",
      ),
    ).toEqual({ text: "hello" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      store
        .listAttempts()
        .every(
          (attempt) =>
            attempt.status === "settled" && attempt.costMicros === 104,
        ),
    ).toBe(true);
    expect(store.exportResearch({}, admin.id)).not.toContain(model.apiKey!);
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 5_000_000 - 208,
      reservedMicros: 0,
    });
  });

  it("redacts transport exception messages and freezes an unconfirmed sent attempt", async () => {
    const { store, user } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`Connection failed for ${model.apiKey!}`));
    await expect(
      generate(
        new HostedModelGateway(store, request),
        user.id,
        "error-key-echo",
      ),
    ).rejects.toThrow("Connection failed for [REDACTED_API_KEY]");
    expect(store.listAttempts()[0]?.status).toBe("unknown");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("freezes unknown network results and refuses automatic or later repeat dispatch", async () => {
    const { store, user } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("socket disconnected"));
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "unknown-1"),
    ).rejects.toThrow();
    const attempt = store.listAttempts({ userId: user.id })[0]!;
    expect(attempt.status).toBe("unknown");
    expect(store.wallet(user.id).reservedMicros).toBeGreaterThan(0);
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "unknown-1"),
    ).rejects.toMatchObject({ code: "model_outcome_unknown" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not repair malformed output whose usage is unknown", async () => {
    const { store, user } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response("invalid json", null));
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "unknown-json"),
    ).rejects.toMatchObject({ code: "model_outcome_unknown" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.listAttempts({ userId: user.id })[0]?.status).toBe("unknown");
  });

  it("fails closed before transport if durable research storage is unavailable", async () => {
    const { store, user } = fixture();
    const request = vi.fn<typeof fetch>();
    vi.spyOn(store, "recordResearch").mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "disk-failure"),
    ).rejects.toThrow("disk unavailable");
    expect(request).not.toHaveBeenCalled();
    expect(store.wallet(user.id).reservedMicros).toBe(0);
  });

  it("rejects banned users and insufficient balances before dispatch", async () => {
    const { store, user, admin } = fixture();
    const request = vi.fn<typeof fetch>();
    store.adjustBalance(user.id, -5_000_000, admin.id, "test empty account");
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "empty"),
    ).rejects.toMatchObject({ code: "insufficient_balance" });
    store.banUser(user.id, true, admin.id);
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "banned"),
    ).rejects.toMatchObject({ code: "account_unavailable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("limits concurrent requests per account and rechecks admission after queuing", async () => {
    const { store, user, admin } = fixture();
    let finishFirst!: (value: Response) => void;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue(response());
    const gateway = new HostedModelGateway(store, request);
    const first = generate(gateway, user.id, "concurrent-1");
    const second = generate(gateway, user.id, "concurrent-2");
    const secondResult = second.catch((error: unknown) => error);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    store.banUser(user.id, true, admin.id);
    finishFirst(response());
    expect(await first).toEqual({ text: "hello" });
    expect(await secondResult).toMatchObject({ code: "account_unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("charges confirmed image generation once and retries asset download from saved response", async () => {
    const { store, user, admin } = fixture();
    store.upsertModel(
      {
        ...model,
        routeId: "badge",
        kind: "image",
        modelId: "image-model",
        imagePointsMicros: 700_000,
        imageSpecification: "1024x1024",
      },
      admin.id,
    );
    store.setPurposeDefault("achievement_badge", "badge", admin.id);
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ url: "https://assets.example.test/result.png" }],
        }),
        { status: 200 },
      ),
    );
    const download = vi
      .spyOn(downloads, "downloadImageAsset")
      .mockRejectedValueOnce(new Error("asset download unavailable"))
      .mockResolvedValueOnce({
        bytes: new Uint8Array([137, 80, 78, 71]),
        contentType: "image/png",
      });
    const input = {
      width: 1024,
      height: 1024,
      idempotencyKey: "badge-generation",
      visualSpec: {
        version: "achievement_badge_v1" as const,
        subject: "a leaf",
        setting: "garden",
        motifs: ["leaf"],
        palette: ["#FFFFFF", "#333333"],
        theme: "friendship",
      },
    };
    const context = {
      purpose: "achievement_badge" as const,
      generationId: "badge-generation",
    };
    await expect(
      new HostedModelGateway(store, request)
        .imageProviderFactory(user.id)(context)
        .generate(input),
    ).rejects.toThrow();
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 4_300_000,
      reservedMicros: 0,
    });
    expect(
      await new HostedModelGateway(store, request)
        .imageProviderFactory(user.id)(context)
        .generate(input),
    ).toMatchObject({ mimeType: "image/png" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(2);
    expect(store.listAttempts({ userId: user.id })).toHaveLength(1);
    const attempt = store.listAttempts({ userId: user.id })[0]!;
    const original = store.readAttemptImage(attempt.id);
    expect(Array.from(original?.bytes ?? [])).toEqual([137, 80, 78, 71]);
    expect(
      store.listResearch({ attemptId: attempt.id, kind: "image" }),
    ).toHaveLength(1);
    // Independent encrypted research bytes remain usable after the supplier URL
    // expires or the user deletes the separately stored business asset.
    download.mockRejectedValue(new Error("asset URL expired"));
    expect(
      await new HostedModelGateway(store, request)
        .imageProviderFactory(user.id)(context)
        .generate(input),
    ).toMatchObject({ bytes: original?.bytes });
    expect(download).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never sends a settled request again after its recoverable response was purged", async () => {
    const { store, user } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    await generate(new HostedModelGateway(store, request), user.id, "purged");
    store.researchDatabase
      .prepare(
        "UPDATE research_records SET deleted_at=?,payload_encrypted=NULL WHERE kind='response'",
      )
      .run(new Date().toISOString());
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "purged"),
    ).rejects.toMatchObject({ code: "model_response_unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recovers a saved response using its original protocol and pricing revision", async () => {
    const { store, user, admin } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    await generate(
      new HostedModelGateway(store, request),
      user.id,
      "old-route",
    );
    store.upsertModel(
      {
        ...model,
        protocol: "gemini",
        modelId: "new-model",
        inputMicrosPerMillion: 100_000_000,
      },
      admin.id,
    );
    expect(
      await generate(
        new HostedModelGateway(store, request),
        user.id,
        "old-route",
      ),
    ).toEqual({ text: "hello" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.wallet(user.id).balanceMicros).toBe(5_000_000 - 104);
  });

  it("replays settled responses without resolving disabled aliases or unavailable credentials", async () => {
    const { store, user, admin } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    await generate(
      new HostedModelGateway(store, request),
      user.id,
      "removed-credential",
    );
    store.upsertModel({ ...model, enabled: false }, admin.id);
    store.replacePurposeDefaults({}, admin.id);
    const resolve = vi.spyOn(store, "resolveModel").mockImplementation(() => {
      throw new Error("credential intentionally unavailable");
    });
    expect(
      await generate(
        new HostedModelGateway(store, request),
        user.id,
        "removed-credential",
      ),
    ).toEqual({ text: "hello" });
    expect(resolve).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rechecks a disabled model before a subsequent physical attempt", async () => {
    const { store, user, admin } = fixture();
    const request = vi.fn<typeof fetch>().mockImplementation(() => {
      store.upsertModel({ ...model, enabled: false }, admin.id);
      return Promise.resolve(response("{}", undefined, 503));
    });
    await expect(
      generate(
        new HostedModelGateway(store, request),
        user.id,
        "disable-during-call",
      ),
    ).rejects.toMatchObject({ code: "model_disabled" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 5_000_000 - 104,
      reservedMicros: 0,
    });
  });

  it("freezes a supplier response containing more images than the requested single image", async () => {
    const { store, user, admin } = fixture();
    store.upsertModel(
      { ...model, routeId: "badge", kind: "image", imagePointsMicros: 700_000 },
      admin.id,
    );
    store.setPurposeDefault("achievement_badge", "badge", admin.id);
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ b64_json: "iVBORw==" }, { b64_json: "iVBORw==" }],
        }),
        { status: 200 },
      ),
    );
    const provider = new HostedModelGateway(
      store,
      request,
    ).imageProviderFactory(user.id)({
      purpose: "achievement_badge",
      generationId: "extra-image",
    });
    await provider.generate({
      width: 1024,
      height: 1024,
      idempotencyKey: "extra-image",
      visualSpec: {
        version: "achievement_badge_v1",
        subject: "a leaf",
        setting: "garden",
        motifs: ["leaf"],
        palette: ["#FFFFFF", "#333333"],
        theme: "friendship",
      },
    });
    expect(store.listAttempts({ userId: user.id })[0]).toMatchObject({
      status: "unknown",
      reason: "image_count_mismatch",
      costMicros: null,
    });
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 5_000_000,
      reservedMicros: 700_000,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("records excessive usage as unknown and stops automatic continuation", async () => {
    const { store, user } = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      response("invalid json", {
        prompt_tokens: 1_000_000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    );
    await expect(
      generate(new HostedModelGateway(store, request), user.id, "excessive"),
    ).rejects.toMatchObject({ code: "model_outcome_unknown" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.listAttempts({ userId: user.id })[0]).toMatchObject({
      status: "unknown",
      reason: "cost_exceeds_reservation",
    });
  });

  it("pauses new dispatch and aborts a banned account without automatic retries", async () => {
    const { store, user } = fixture();
    const request = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const reason: unknown = init.signal?.reason;
              reject(
                reason instanceof Error
                  ? reason
                  : new Error("Request cancelled"),
              );
            },
            { once: true },
          );
        }),
    );
    const gateway = new HostedModelGateway(store, request);
    gateway.pause();
    await expect(generate(gateway, user.id, "paused")).rejects.toMatchObject({
      code: "model_gateway_paused",
    });
    gateway.pause(false);
    const pending = generate(gateway, user.id, "cancelled").catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    gateway.abortUser(user.id);
    expect(await pending).toMatchObject({ code: "account_unavailable" });
    expect(gateway.getStats()).toEqual({
      active: 0,
      queued: 0,
      activeImages: 0,
    });
    expect(store.listAttempts({ userId: user.id })[0]?.status).toBe("unknown");
  });

  it("keeps an image probe's physical identity across HTTP recovery even if the caller creates another local ID", async () => {
    const { store, user, admin } = fixture();
    store.upsertModel(
      { ...model, routeId: "badge", kind: "image", imagePointsMicros: 700_000 },
      admin.id,
    );
    store.setPurposeDefault("image_probe", "badge", admin.id);
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("response lost"));
    const gateway = new HostedModelGateway(store, request);
    const probe = (generationId: string) =>
      gateway.runOperation(
        { userId: user.id, operationId: "probe-http-operation" },
        () =>
          gateway
            .imageProviderFactory(user.id)({
              purpose: "image_probe",
              generationId,
            })
            .generate({
              width: 1024,
              height: 1024,
              idempotencyKey: generationId,
              visualSpec: {
                version: "achievement_badge_v1",
                subject: "a leaf",
                setting: "garden",
                motifs: ["leaf"],
                palette: ["#FFFFFF", "#333333"],
                theme: "friendship",
              },
            }),
      );
    await expect(probe("local-first")).rejects.toThrow();
    await expect(probe("local-recovered")).rejects.toMatchObject({
      code: "model_outcome_unknown",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.listAttempts({ userId: user.id })).toHaveLength(1);
  });

  it("replays the same purpose even when an already committed earlier purpose is skipped", async () => {
    const { store, user } = fixture();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(response()));
    const gateway = new HostedModelGateway(store, request);
    await gateway.runOperation(
      {
        userId: user.id,
        operationId: "partial-business-commit",
        publicModelId: "friend",
      },
      async () => {
        await gateway.forUser(user.id).executionResolver!(
          "compile_character",
        ).provider.generateObject({
          purpose: "compile_character",
          system: "",
          prompt: "already committed prework",
          schema: z.object({ text: z.string() }),
        });
        await gateway.forUser(user.id).executionResolver!(
          "chat_turn",
        ).provider.generateObject({
          purpose: "chat_turn",
          system: "",
          prompt: "chat",
          schema: z.object({ text: z.string() }),
        });
      },
    );
    expect(request).toHaveBeenCalledTimes(2);
    const restarted = new HostedModelGateway(store, request);
    expect(
      await generate(restarted, user.id, "partial-business-commit"),
    ).toEqual({ text: "hello" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.wallet(user.id).balanceMicros).toBe(5_000_000 - 208);
  });
});
