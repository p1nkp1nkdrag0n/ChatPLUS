import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LlmCatalog,
  LlmProbeResult,
  LlmProviderView,
} from "@personasim/contracts";
import { ApiError } from "../api/types";
import { newModel } from "./llmSettings";
import {
  availableSetupProviders,
  configuredDefault,
  createApiSetupController,
  probeSucceeded,
  validateSetupConnection,
} from "./apiSetup";

const fixture: LlmProviderView = {
  id: "fixture",
  name: "演示",
  protocol: "fixture",
  source: "fixture",
  baseUrl: "",
  timeoutMs: 120_000,
  revision: 1,
  hasApiKey: false,
  credentialStatus: "ready",
  models: [newModel("fixture-model")],
  referencedSessions: 0,
};
const saved: LlmProviderView = {
  ...fixture,
  id: "saved",
  name: "我的模型连接",
  protocol: "openai-compatible",
  source: "managed",
  baseUrl: "https://example.test/v1",
  revision: 3,
  hasApiKey: true,
  models: [newModel("model-a")],
};
const initial: LlmCatalog = {
  providers: [fixture],
  defaultSelection: { providerId: fixture.id, modelId: "fixture-model" },
};
const ready: LlmCatalog = {
  providers: [fixture, saved],
  defaultSelection: { providerId: saved.id, modelId: "model-a" },
};
const success: LlmProbeResult = {
  modelId: "model-a",
  configRevision: 1,
  testedAt: "2026-09-11T00:00:00Z",
  status: "success",
  text: { status: "success", latencyMs: 10 },
  structured: { status: "success", latencyMs: 20 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(catalog = initial) {
  const api = {
    catalog: vi.fn().mockResolvedValue({
      ...ready,
      defaultSelection: initial.defaultSelection,
    }),
    discover: vi.fn().mockResolvedValue({
      models: [newModel("model-a")],
      discoveredAt: "2026-09-11T00:00:00Z",
    }),
    test: vi.fn().mockResolvedValue(success),
    create: vi.fn().mockResolvedValue(saved),
    setDefault: vi.fn().mockResolvedValue(ready),
  };
  const setup = createApiSetupController(catalog, api);
  setup.setDraft({ baseUrl: saved.baseUrl, apiKey: "secret-test-key" });
  setup.setModelId("model-a");
  return { api, setup };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("API setup entry rules", () => {
  it("requires an existing, readable real provider and model, including environment and keyless services", () => {
    expect(configuredDefault(initial)).toBe(false);
    expect(configuredDefault(ready)).toBe(true);
    expect(configuredDefault({ ...ready, providers: [fixture] })).toBe(false);
    expect(
      configuredDefault({
        ...ready,
        defaultSelection: { ...ready.defaultSelection, modelId: "missing" },
      }),
    ).toBe(false);
    expect(
      configuredDefault({
        ...ready,
        providers: [{ ...saved, credentialStatus: "unavailable" }],
      }),
    ).toBe(false);
    expect(
      configuredDefault({
        ...ready,
        providers: [{ ...saved, hasApiKey: false }],
      }),
    ).toBe(true);
    expect(
      configuredDefault({
        ...ready,
        providers: [{ ...saved, source: "environment" }],
      }),
    ).toBe(true);
    expect(
      availableSetupProviders({
        ...ready,
        providers: [
          fixture,
          saved,
          { ...saved, id: "broken", credentialStatus: "unavailable" },
        ],
      }),
    ).toHaveLength(2);
  });

  it("rejects URL credentials and requires both probe stages to succeed", () => {
    const { setup } = harness();
    expect(validateSetupConnection(setup.getSnapshot().draft)).toBeNull();
    expect(
      validateSetupConnection({
        ...setup.getSnapshot().draft,
        baseUrl: "https://secret@example.test/v1",
      }),
    ).toContain("API 根地址");
    expect(probeSucceeded(success)).toBe(true);
    expect(
      probeSucceeded({
        ...success,
        structured: { status: "skipped", latencyMs: 0 },
      }),
    ).toBe(false);
    expect(probeSucceeded({ ...success, status: "partial" })).toBe(false);
  });
});

describe("API setup request and save state", () => {
  it("tests the selected draft before creating one model and setting its exact revision as default", async () => {
    const { setup, api } = harness();
    await setup.submit();
    expect(api.test.mock.calls[0]?.[0]).toMatchObject({
      draft: { apiKey: "secret-test-key", name: "我的模型连接" },
      modelId: "model-a",
    });
    expect(api.test.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ models: [newModel("model-a")] }),
    );
    expect(api.setDefault).toHaveBeenCalledExactlyOnceWith(
      ready.defaultSelection,
      saved.revision,
    );
    expect(setup.getSnapshot()).toMatchObject({
      completed: true,
      task: "idle",
      selectedProviderId: saved.id,
      draft: { apiKey: "" },
    });
    setup.selectProvider("new");
    expect(setup.getSnapshot().draft.apiKey).toBe("");
    setup.dispose();
  });

  it("supports keyless local services and preserves discovered model settings", async () => {
    const { setup, api } = harness();
    setup.setDraft({ apiKey: "", baseUrl: "http://localhost:1234/v1" });
    const model = {
      ...newModel("model-a"),
      tokenParameter: "max_completion_tokens" as const,
    };
    api.discover.mockResolvedValue({ models: [model] });
    await setup.discover();
    await setup.submit();
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "", models: [model] }),
    );
    setup.dispose();
  });

  it("keeps partial or failed probes on the form without saving", async () => {
    const { setup, api } = harness();
    api.test.mockResolvedValue({
      ...success,
      status: "partial",
      structured: { status: "failed", latencyMs: 1, error: "结构化输出失败" },
    });
    await setup.submit();
    expect(setup.getSnapshot()).toMatchObject({
      completed: false,
      task: "idle",
      error: "结构化输出失败",
    });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.setDefault).not.toHaveBeenCalled();
    setup.dispose();
  });

  it("retains the saved provider and retries only setting default after a save failure", async () => {
    const { setup, api } = harness();
    api.setDefault.mockRejectedValueOnce(new TypeError("offline"));
    await setup.submit();
    expect(setup.getSnapshot()).toMatchObject({
      completed: false,
      canRetryDefault: true,
      draft: { apiKey: "" },
    });
    await setup.submit();
    expect(api.test).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.setDefault).toHaveBeenCalledTimes(2);
    expect(setup.getSnapshot().completed).toBe(true);
    setup.dispose();
  });

  it("refreshes after a revision conflict and tests the newly saved provider before retrying", async () => {
    const { setup, api } = harness();
    const updated = { ...saved, revision: 4 };
    api.setDefault.mockRejectedValueOnce(
      new ApiError({
        status: 409,
        code: "model_configuration_changed",
        message: "changed",
      }),
    );
    api.catalog.mockResolvedValue({ ...ready, providers: [fixture, updated] });
    await setup.submit();
    expect(setup.getSnapshot()).toMatchObject({
      completed: false,
      canRetryDefault: false,
      probe: null,
      selectedProvider: { revision: 4 },
    });
    api.test.mockResolvedValue({
      ...success,
      providerId: saved.id,
      configRevision: 4,
    });
    api.setDefault.mockResolvedValue({
      ...ready,
      providers: [fixture, updated],
    });
    await setup.submit();
    expect(api.test).toHaveBeenLastCalledWith(
      { providerId: saved.id, revision: 4, modelId: "model-a" },
      expect.any(AbortSignal),
    );
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.setDefault).toHaveBeenLastCalledWith(ready.defaultSelection, 4);
    expect(setup.getSnapshot().completed).toBe(true);
    setup.dispose();
  });

  it("recovers an uncertain create without repeating it and requires an explicit provider choice", async () => {
    const { setup, api } = harness();
    api.create.mockRejectedValueOnce(
      new TypeError("connection interrupted after commit"),
    );
    await setup.submit();
    expect(api.catalog).toHaveBeenCalledOnce();
    expect(setup.getSnapshot()).toMatchObject({
      needsRecovery: true,
      recoveryReady: true,
      completed: false,
      draft: { apiKey: "" },
    });
    await setup.submit();
    expect(api.create).toHaveBeenCalledOnce();
    setup.selectProvider(saved.id);
    expect(setup.getSnapshot().recoveryReady).toBe(false);
    api.test.mockResolvedValue({
      ...success,
      providerId: saved.id,
      configRevision: saved.revision,
    });
    await setup.submit();
    expect(api.create).toHaveBeenCalledOnce();
    expect(setup.getSnapshot().completed).toBe(true);
    setup.dispose();
  });

  it("does not unlock uncertain creation while recovery is offline", async () => {
    const { setup, api } = harness();
    api.create.mockRejectedValue(new TypeError("offline"));
    api.catalog.mockRejectedValue(new TypeError("offline"));
    await setup.submit();
    setup.selectProvider("new");
    await setup.submit();
    expect(api.create).toHaveBeenCalledOnce();
    expect(setup.getSnapshot().needsRecovery).toBe(true);
    expect(setup.getSnapshot().recoveryReady).toBe(false);
    api.catalog.mockResolvedValue(ready);
    await setup.recover();
    expect(setup.getSnapshot().recoveryReady).toBe(true);
    setup.selectProvider(saved.id);
    expect(setup.getSnapshot().needsRecovery).toBe(false);
    expect(setup.getSnapshot().recoveryReady).toBe(false);
    setup.dispose();
  });

  it("requires a successful fresh catalog read before explicitly starting again after an uncertain save", async () => {
    const { setup, api } = harness();
    expect(setup.getSnapshot().recoveryReady).toBe(false);
    api.create.mockRejectedValueOnce(new TypeError("unknown create outcome"));
    api.catalog.mockResolvedValue(initial);
    await setup.submit();
    expect(setup.getSnapshot()).toMatchObject({
      needsRecovery: true,
      recoveryReady: true,
    });
    const pending = deferred<LlmCatalog>();
    api.catalog.mockReturnValueOnce(pending.promise);
    const recovery = setup.recover();
    expect(setup.getSnapshot().recoveryReady).toBe(false);
    setup.selectProvider("new");
    expect(setup.getSnapshot().needsRecovery).toBe(true);
    pending.resolve(initial);
    await recovery;
    expect(setup.getSnapshot().recoveryReady).toBe(true);
    setup.selectProvider("new");
    expect(setup.getSnapshot()).toMatchObject({
      needsRecovery: false,
      recoveryReady: false,
    });
    setup.dispose();
  });

  it("reconnects subscriptions after effect cleanup without losing non-secret draft fields", () => {
    const { setup } = harness();
    setup.setDraft({
      protocol: "anthropic",
      baseUrl: "https://anthropic.example.test/v1",
    });
    const oldListener = vi.fn();
    const unsubscribe = setup.subscribe(oldListener);
    unsubscribe();
    setup.dispose();
    expect(oldListener).not.toHaveBeenCalled();
    expect(setup.getSnapshot()).toMatchObject({
      task: "idle",
      draft: { protocol: "anthropic", apiKey: "" },
    });
    const listener = vi.fn();
    const detach = setup.subscribe(listener);
    setup.setDraft({ apiKey: "newly-entered-key" });
    expect(listener).toHaveBeenCalled();
    expect(setup.getSnapshot().draft).toMatchObject({
      protocol: "anthropic",
      baseUrl: "https://anthropic.example.test/v1",
      apiKey: "newly-entered-key",
    });
    detach();
    setup.dispose();
  });

  it("reuses existing model settings and does not remotely discover or overwrite their list", async () => {
    const models = [
      newModel("model-a"),
      { ...newModel("model-b"), thinkingBudget: 2000 },
    ];
    const catalog = { ...ready, providers: [fixture, { ...saved, models }] };
    const { setup, api } = harness(catalog);
    api.catalog.mockResolvedValue(catalog);
    setup.selectProvider(saved.id);
    setup.setDraft({ apiKey: "must-not-overwrite" });
    await setup.discover();
    expect(api.discover).not.toHaveBeenCalled();
    expect(setup.getSnapshot().models).toEqual(models);
    setup.setModelId("model-b");
    api.test.mockResolvedValue({
      ...success,
      modelId: "model-b",
      providerId: saved.id,
      configRevision: saved.revision,
    });
    api.setDefault.mockResolvedValue({
      ...catalog,
      defaultSelection: { providerId: saved.id, modelId: "model-b" },
    });
    await setup.submit();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.test).toHaveBeenCalledWith(
      { providerId: saved.id, modelId: "model-b", revision: saved.revision },
      expect.any(AbortSignal),
    );
    setup.dispose();
  });

  it("rejects unreadable saved credentials and model IDs absent from a saved provider", async () => {
    const { setup, api } = harness({
      ...ready,
      providers: [{ ...saved, credentialStatus: "unavailable" }],
    });
    setup.selectProvider(saved.id);
    await setup.submit();
    expect(setup.getSnapshot().error).toContain("模型设置修复");
    expect(api.test).not.toHaveBeenCalled();
    setup.dispose();
    const other = harness(ready);
    other.setup.selectProvider(saved.id);
    other.setup.setModelId("unsaved-model");
    await other.setup.submit();
    expect(other.api.test).not.toHaveBeenCalled();
    expect(other.setup.getSnapshot().error).toContain("已经保存的模型");
    other.setup.dispose();
  });

  it("ignores cancelled tests and prevents rapid duplicate submissions", async () => {
    const { setup, api } = harness();
    const pending = deferred<LlmProbeResult>();
    api.test.mockReturnValueOnce(pending.promise);
    const first = setup.submit();
    await setup.submit();
    expect(api.test).toHaveBeenCalledOnce();
    setup.cancel();
    expect((api.test.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    pending.resolve(success);
    await first;
    expect(api.create).not.toHaveBeenCalled();
    expect(setup.getSnapshot().completed).toBe(false);
    setup.dispose();
  });

  it("invalidates a pending test when credentials change and allows retry", async () => {
    const { setup, api } = harness();
    const pending = deferred<LlmProbeResult>();
    api.test.mockReturnValueOnce(pending.promise);
    const request = setup.submit();
    setup.setDraft({ apiKey: "replacement-key" });
    pending.resolve(success);
    await request;
    expect(api.create).not.toHaveBeenCalled();
    await setup.submit();
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "replacement-key" }),
    );
    setup.dispose();
  });

  it("ignores late discovery after changing protocols and preserves manual model entry on discovery failure", async () => {
    const { setup, api } = harness();
    const pending = deferred<{
      models: ReturnType<typeof newModel>[];
      discoveredAt: string;
    }>();
    api.discover.mockReturnValueOnce(pending.promise);
    const request = setup.discover();
    setup.setDraft({ protocol: "anthropic" });
    pending.resolve({ models: [newModel("stale")], discoveredAt: "today" });
    await request;
    expect(setup.getSnapshot().models).toEqual([]);
    api.discover.mockRejectedValueOnce(new Error("offline"));
    await setup.discover();
    expect(setup.getSnapshot().error).toContain("手动填写");
    expect(setup.getSnapshot().modelId).toBe("model-a");
    setup.dispose();
  });

  it("times out probes, ignores the eventual result, and cancels outstanding work on unmount", async () => {
    vi.useFakeTimers();
    const { setup, api } = harness();
    const pending = deferred<LlmProbeResult>();
    api.test.mockReturnValueOnce(pending.promise);
    const request = setup.submit();
    vi.advanceTimersByTime(255_001);
    expect(setup.getSnapshot().error).toContain("超时");
    pending.resolve(success);
    await request;
    expect(api.create).not.toHaveBeenCalled();
    const next = deferred<LlmProbeResult>();
    api.test.mockReturnValueOnce(next.promise);
    const retry = setup.submit();
    setup.dispose();
    next.resolve(success);
    await retry;
    expect(api.create).not.toHaveBeenCalled();
    expect(setup.getSnapshot().draft.apiKey).toBe("");
  });

  it("does not claim completion if the server confirms a different default", async () => {
    const { setup, api } = harness();
    api.setDefault.mockResolvedValue(initial);
    await setup.submit();
    expect(setup.getSnapshot()).toMatchObject({
      completed: false,
      canRetryDefault: false,
      probe: null,
    });
    expect(api.catalog).toHaveBeenCalledOnce();
    setup.dispose();
  });
});
