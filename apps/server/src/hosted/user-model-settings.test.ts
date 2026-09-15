import { afterEach, describe, expect, it } from "vitest";
import {
  LlmProviderInputSchema,
  LlmPurposeSchema,
} from "@personasim/contracts";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import type { ServerConfig } from "../config.js";
import { LlmSettingsService } from "../services/llm-settings-service.js";
import { UserModelSettingsService } from "./user-model-settings.js";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture(completed = false) {
  const db = openDatabase(":memory:");
  databases.push(db);
  runMigrations(db);
  const store = new DatabaseStore(db);
  const settings = new LlmSettingsService(
    store,
    {
      databasePath: ":memory:",
      profile: "hosted",
      llm: {
        provider: "fixture",
        baseUrl: "https://hosted.invalid",
        model: "unconfigured",
        timeoutMs: 120000,
        maxRetries: 0,
      },
    } as ServerConfig,
    new FakeClock("2026-09-15T00:00:00.000Z"),
  );
  const provider = settings.create(
    LlmProviderInputSchema.parse({
      name: "User provider",
      protocol: "openai-compatible",
      baseUrl: "https://supplier.example/v1",
      apiKey: "private-test-key",
      models: [
        {
          id: "custom",
          capabilities: {
            structuredOutputMode: "prompt_json",
            supportsThinkingControl: false,
            supportsStreaming: false,
            maxContextTokens: 64000,
            maxOutputTokens: 8192,
          },
        },
      ],
    }),
  );
  const selection = { providerId: provider.id, modelId: "custom" };
  const options = { initialOnboardingCompleted: completed };
  const service = new UserModelSettingsService(store, settings, options);
  return { db, store, settings, provider, selection, service, options };
}

describe("account model settings", () => {
  it("protects providers and models bound to a non-chat purpose until the binding is changed", () => {
    const f = fixture();
    f.service.update({
      expectedRevision: 0,
      bindings: { diary_review: f.selection },
    });
    expect(() =>
      f.service.assertProviderMutationAllowed(f.provider.id),
    ).toThrow();
    expect(() =>
      f.service.assertProviderMutationAllowed(f.provider.id, []),
    ).toThrow();
    expect(() =>
      f.service.assertProviderMutationAllowed(f.provider.id, [
        { id: "custom" },
      ]),
    ).not.toThrow();
    f.service.update({ expectedRevision: 1, bindings: { diary_review: null } });
    expect(() =>
      f.service.assertProviderMutationAllowed(f.provider.id),
    ).not.toThrow();
  });
  it("initializes new and migrated accounts once and survives service reconstruction", () => {
    const fresh = fixture();
    expect(fresh.service.get()).toEqual({
      revision: 0,
      onboardingCompleted: false,
      bindings: {},
      imageSelection: null,
    });
    expect(
      new UserModelSettingsService(fresh.store, fresh.settings, {
        initialOnboardingCompleted: true,
      }).get().onboardingCompleted,
    ).toBe(false);
    expect(fixture(true).service.get().onboardingCompleted).toBe(true);
  });
  it("completes setup atomically for all text purposes and keeps subsequent choices independent", () => {
    const f = fixture();
    const saved = f.service.completeSetup({
      mode: "user",
      selection: f.selection,
      expectedRevision: 0,
    });
    expect(saved.onboardingCompleted).toBe(true);
    expect(Object.keys(saved.bindings)).toEqual(LlmPurposeSchema.options);
    expect(saved.imageSelection).toBeNull();
    for (const purpose of LlmPurposeSchema.options)
      expect(f.service.resolve(purpose)?.selection.providerId).toBe(
        f.provider.id,
      );
    const edited = f.service.update({
      expectedRevision: 1,
      bindings: { diary_review: null },
    });
    expect(edited.bindings.chat_turn).toEqual(f.selection);
    expect(f.service.resolve("diary_review")).toBeUndefined();
    expect(() =>
      f.service.completeSetup({
        mode: "user",
        selection: f.selection,
        expectedRevision: 2,
      }),
    ).toThrow();
  });
  it("rejects stale cross-device writes and invalid selections without partial changes", () => {
    const f = fixture();
    f.service.update({
      expectedRevision: 0,
      bindings: { chat_turn: f.selection },
    });
    expect(() =>
      f.service.update({ expectedRevision: 0, bindings: { chat_turn: null } }),
    ).toThrow();
    expect(() =>
      f.service.update({
        expectedRevision: 1,
        bindings: {
          chat_turn: null,
          diary_review: { ...f.selection, modelId: "missing" },
        },
      }),
    ).toThrow();
    expect(f.service.get()).toMatchObject({
      revision: 1,
      onboardingCompleted: false,
      bindings: { chat_turn: f.selection },
    });
  });
  it("isolates tenant providers and refuses environment and platform mutation", () => {
    const a = fixture(),
      b = fixture();
    expect(() =>
      b.service.update({
        expectedRevision: 0,
        bindings: { chat_turn: a.selection },
      }),
    ).toThrow();
    expect(() => a.service.assertProvider("hosted")).toThrow();
    expect(() => a.service.assertProvider("fixture")).toThrow();
    expect(() =>
      a.service.completeSetup({
        mode: "platform",
        selection: a.selection,
        expectedRevision: 0,
      }),
    ).toThrow();
    expect(a.service.get().onboardingCompleted).toBe(false);
  });
  it("never falls back from broken user bindings and accepts chat-only explicit selection", () => {
    const f = fixture();
    f.service.update({
      expectedRevision: 0,
      bindings: { diary_review: f.selection },
    });
    expect(f.service.resolve("chat_turn", f.selection)?.model.id).toBe(
      "custom",
    );
    expect(f.service.resolve("plan_schedule", f.selection)).toBeUndefined();
    f.db
      .prepare("UPDATE llm_providers SET credential_json=NULL WHERE id=?")
      .run(f.provider.id);
    expect(() => f.service.resolve("diary_review")).toThrow();
  });
  it("stores hosted customer URLs and keys encrypted and requires re-entry when destination changes", () => {
    const f = fixture();
    const row = f.db
      .prepare("SELECT base_url,credential_json FROM llm_providers WHERE id=?")
      .get(f.provider.id) as { base_url: string; credential_json: string };
    expect(row.base_url).toMatch(/^encrypted-url:v1:/u);
    expect(JSON.stringify(row)).not.toContain("supplier.example");
    expect(JSON.stringify(row)).not.toContain("private-test-key");
    expect(f.settings.resolve(f.selection)).toMatchObject({
      baseUrl: "https://supplier.example/v1",
      apiKey: "private-test-key",
    });
    const changed = LlmProviderInputSchema.parse({
      name: "Changed",
      protocol: "openai-compatible",
      baseUrl: "https://different.example/v1",
      models: f.provider.models,
    });
    expect(() => f.settings.update(f.provider.id, changed)).toThrow(/API Key/u);
    expect(() =>
      f.settings.resolveTarget({
        providerId: f.provider.id,
        draft: changed,
        modelId: "custom",
      }),
    ).toThrow(/API Key/u);
    f.settings.update(f.provider.id, { ...changed, apiKey: "replacement-key" });
    expect(f.settings.resolve(f.selection).apiKey).toBe("replacement-key");
  });
});
