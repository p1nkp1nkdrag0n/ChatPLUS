import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmProviderInputSchema } from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { backupInstance, restoreInstance } from "../runtime/instance-backup.js";
import { FakeClock } from "../runtime/clock.js";
import { llmKeyPath } from "./llm-credential-service.js";
import { LlmSettingsService } from "./llm-settings-service.js";
import { LlmService } from "./llm-service.js";

const NOW = "2026-09-09T00:00:00.000Z";
const KEY = "test-only-private-key-do-not-return";
const directories: string[] = [];
const databases: Database[] = [];
function setup(llm?: ServerConfig["llm"]) {
  const root = mkdtempSync(join(tmpdir(), "chatplus-llm-settings-"));
  directories.push(root);
  const databasePath = join(root, "database.sqlite");
  const database = openDatabase(databasePath);
  databases.push(database);
  runMigrations(database);
  database
    .prepare(
      "INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc) VALUES('agent',1,'published','daily','test','original',?,?)",
    )
    .run(NOW, NOW);
  database
    .prepare(
      "INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc) VALUES('session','agent','test',?,?)",
    )
    .run(NOW, NOW);
  const config = {
    databasePath,
    llm: llm ?? {
      provider: "fixture",
      baseUrl: "https://example.test/v1",
      model: "personasim-fixture-v1",
      timeoutMs: 120000,
      maxRetries: 0,
    },
  } as ServerConfig;
  const store = new DatabaseStore(database);
  const clock = new FakeClock(NOW);
  const service = new LlmSettingsService(store, config, clock);
  return { root, databasePath, database, config, store, clock, service };
}
const input = (overrides: Record<string, unknown> = {}) =>
  LlmProviderInputSchema.parse({
    name: "Custom provider",
    protocol: "openai-compatible",
    baseUrl: "http://192.168.1.20:11434/v1/chat/completions",
    apiKey: KEY,
    models: [{ id: "test-model" }],
    ...overrides,
  });
afterEach(() => {
  vi.unstubAllEnvs();
  for (const database of databases.splice(0)) database.close();
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("managed LLM settings", () => {
  it("keeps fixture selections and call revisions stable across service reconstruction", async () => {
    const f = setup();
    const first = f.service.resolve().selection;
    const secondService = new LlmSettingsService(f.store, f.config, f.clock);
    expect(first).toEqual({
      providerId: "fixture",
      modelId: "personasim-fixture-v1",
      revision: 1,
    });
    expect(secondService.resolve().selection).toEqual(first);
    const command = {
      purpose: "repair_chat_turn" as const,
      system: "fixture",
      prompt: "fixture",
      schema: z.object({ text: z.string() }),
      fixture: { text: "stable" },
    };
    const initial = new LlmService(f.config.llm, f.store, f.clock);
    initial.settings = f.service;
    await initial.captureDefault().generateObject(command);
    const rebuilt = new LlmService(f.config.llm, f.store, f.clock);
    rebuilt.settings = secondService;
    await rebuilt.captureDefault().generateObject(command);
    await new LlmService(f.config.llm, f.store, f.clock).generateObject(
      command,
    );
    expect(
      f.store.listLlmCalls().map((call) => ({
        provider: call.provider,
        model: call.model,
        configRevision: call.configRevision,
      })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        provider: "fixture",
        model: "personasim-fixture-v1",
        configRevision: 1,
      })),
    );
  });

  it("records the managed execution's captured revision rather than the edited provider revision", async () => {
    const f = setup();
    const provider = f.service.create(input());
    f.service.update(
      provider.id,
      input({ expectedRevision: 1, name: "Version 2" }),
    );
    const fetchOverride = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"reply":"ok"}' }, finish_reason: "stop" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const runtime = new LlmService(f.config.llm, f.store, f.clock, {
      fetch: fetchOverride,
    });
    runtime.settings = f.service;
    const captured = runtime.captureSelection(
      { providerId: provider.id, modelId: "test-model" },
      2,
    );
    f.service.update(
      provider.id,
      input({ expectedRevision: 2, name: "Version 3" }),
    );
    await captured.generateObject({
      purpose: "repair_chat_turn",
      system: "Return JSON",
      prompt: "hello",
      schema: z.strictObject({ reply: z.string() }),
      maxRetries: 0,
    });
    expect(f.store.listLlmCalls()[0]).toMatchObject({
      provider: "openai-compatible",
      providerProfile: provider.id,
      model: "test-model",
      configRevision: 2,
      success: true,
    });
    expect(
      f.service.catalog().providers.find((item) => item.id === provider.id)
        ?.revision,
    ).toBe(3);
  });

  it("encrypts credentials, persists model choices and never returns secrets", () => {
    const f = setup();
    const provider = f.service.create(input());
    expect(provider.baseUrl).toBe("http://192.168.1.20:11434/v1");
    expect(provider.hasApiKey).toBe(true);
    expect(existsSync(llmKeyPath(f.databasePath))).toBe(true);
    const raw = f.database
      .prepare("SELECT credential_json FROM llm_providers WHERE id=?")
      .get(provider.id);
    expect(JSON.stringify(raw)).not.toContain(KEY);
    expect(JSON.stringify(f.service.catalog())).not.toContain(KEY);
    const selection = { providerId: provider.id, modelId: "test-model" };
    f.service.setDefault(selection);
    f.service.setSessionModel("session", selection);
    const restarted = new LlmSettingsService(f.store, f.config, f.clock);
    expect(restarted.catalog().defaultSelection).toEqual(selection);
    expect(restarted.resolve().apiKey).toBe(KEY);
    expect(restarted.sessionModel("session").effective).toEqual({
      ...selection,
      revision: 1,
    });
  });

  it("leaves key files absent for local models and distinguishes keep/replace/clear", () => {
    const f = setup();
    let provider = f.service.create(input({ apiKey: "" }));
    expect(existsSync(llmKeyPath(f.databasePath))).toBe(false);
    provider = f.service.update(
      provider.id,
      input({ expectedRevision: provider.revision }),
    );
    provider = f.service.update(
      provider.id,
      input({ apiKey: "", expectedRevision: provider.revision }),
    );
    expect(
      f.service.resolve({ providerId: provider.id, modelId: "test-model" })
        .apiKey,
    ).toBe(KEY);
    provider = f.service.update(
      provider.id,
      input({
        apiKey: undefined,
        clearApiKey: true,
        expectedRevision: provider.revision,
      }),
    );
    expect(provider.hasApiKey).toBe(false);
    expect(
      f.service.resolve({ providerId: provider.id, modelId: "test-model" })
        .apiKey,
    ).toBe("");
  });

  it("rejects stale edits and retries, and drafts do not change saved settings", () => {
    const f = setup();
    let provider = f.service.create(input());
    const draft = f.service.resolveTarget({
      providerId: provider.id,
      revision: 1,
      draft: input({ name: "unsaved", apiKey: undefined }),
      modelId: "test-model",
    });
    expect(draft.apiKey).toBe(KEY);
    expect(
      f.service.catalog().providers.find((p) => p.id === provider.id)?.name,
    ).toBe("Custom provider");
    provider = f.service.update(
      provider.id,
      input({ name: "saved", expectedRevision: 1 }),
    );
    expect(() =>
      f.service.update(provider.id, input({ expectedRevision: 1 })),
    ).toThrow(/更新/);
    expect(() =>
      f.service.resolve({ providerId: provider.id, modelId: "test-model" }, 1),
    ).toThrow(/更新/);
    expect(provider.revision).toBe(2);
  });

  it("keeps environment sources read-only and copies their secrets only into encrypted managed records", () => {
    vi.stubEnv("LLM_PROFILE_TEST_ACTIVE_BASE_URL", "https://different.test/v1");
    vi.stubEnv("LLM_PROFILE_TEST_ACTIVE_MODEL", "different-model");
    vi.stubEnv("LLM_PROFILE_TEST_ACTIVE_API_KEY", "not-the-active-key");
    const f = setup({
      provider: "openai-compatible",
      profileName: "test-active",
      baseUrl: "https://gateway.test/v1",
      apiKey: KEY,
      model: "env-model",
      timeoutMs: 32100,
      maxRetries: 2,
    });
    const active = f.service.catalog().defaultSelection;
    expect(active.providerId).toBe("env:test-active");
    expect(
      f.service
        .catalog()
        .providers.filter(
          (provider) => provider.id.replaceAll("-", "_") === "env:test_active",
        ),
    ).toHaveLength(1);
    expect(f.service.resolve().legacyConfig).toEqual(f.config.llm);
    expect(() => f.service.update(active.providerId, input())).toThrow(/只读/);
    const copied = f.service.importEnvironment(active.providerId);
    expect(copied.source).toBe("managed");
    expect(copied.hasApiKey).toBe(true);
    expect(
      f.service.resolve({ providerId: copied.id, modelId: "env-model" }).apiKey,
    ).toBe(KEY);
    expect(f.config.llm.apiKey).toBe(KEY);
    expect(JSON.stringify(f.service.catalog())).not.toContain(KEY);
  });

  it("leaves deleted session references invalid and protects the global default", () => {
    const f = setup();
    const provider = f.service.create(input());
    const selection = { providerId: provider.id, modelId: "test-model" };
    f.service.setSessionModel("session", selection);
    expect(
      f.service.catalog().providers.find((p) => p.id === provider.id)
        ?.referencedSessions,
    ).toBe(1);
    f.service.setDefault(selection);
    expect(() => f.service.delete(provider.id)).toThrow(/默认/);
    expect(() =>
      f.service.update(provider.id, input({ models: [{ id: "replacement" }] })),
    ).toThrow(/默认模型/);
    f.service.setDefault({
      providerId: "fixture",
      modelId: "personasim-fixture-v1",
    });
    f.service.delete(provider.id);
    expect(f.service.sessionModel("session")).toMatchObject({
      selection,
      effective: null,
    });
    expect(
      f.service.setSessionModel("session", null).effective?.providerId,
    ).toBe("fixture");
  });

  it("does not replace a lost key on startup; explicit recovery preserves chat data", () => {
    const f = setup();
    const provider = f.service.create(input());
    unlinkSync(llmKeyPath(f.databasePath));
    const restarted = new LlmSettingsService(f.store, f.config, f.clock);
    expect(
      restarted.catalog().providers.find((p) => p.id === provider.id)
        ?.credentialStatus,
    ).toBe("unavailable");
    expect(() =>
      restarted.resolve({ providerId: provider.id, modelId: "test-model" }),
    ).toThrow(/凭证不可用/);
    expect(() => restarted.update(provider.id, input())).toThrow(/凭证不可用/);
    expect(existsSync(llmKeyPath(f.databasePath))).toBe(false);
    restarted.resetCredentials();
    expect(f.store.getSession("session")).toBeDefined();
    const updated = restarted.update(
      provider.id,
      input({ apiKey: "replacement-test-key" }),
    );
    expect(updated.credentialStatus).toBe("ready");
    expect(
      restarted.resolve({ providerId: provider.id, modelId: "test-model" })
        .apiKey,
    ).toBe("replacement-test-key");
  });

  it("binds ciphertext to its provider and refuses swapping credential rows", () => {
    const f = setup();
    const first = f.service.create(input());
    const second = f.service.create(input({ name: "other" }));
    f.database
      .prepare(
        "UPDATE llm_providers SET credential_json=(SELECT credential_json FROM llm_providers WHERE id=?) WHERE id=?",
      )
      .run(first.id, second.id);
    expect(() =>
      f.service.resolve({ providerId: second.id, modelId: "test-model" }),
    ).toThrow(/凭证不可用/);
    expect(
      f.service.resolve({ providerId: first.id, modelId: "test-model" }).apiKey,
    ).toBe(KEY);
  });

  it("merges discovery without destroying configured capabilities and ignores stale probe responses", () => {
    const f = setup();
    const provider = f.service.create(input());
    f.service.rememberDiscovery(
      provider.id,
      1,
      [...input().models, ...input({ models: [{ id: "new-model" }] }).models],
      NOW,
    );
    expect(
      f.service
        .catalog()
        .providers.find((p) => p.id === provider.id)
        ?.models.map((m) => m.id),
    ).toEqual(["test-model", "new-model"]);
    const result = {
      providerId: provider.id,
      modelId: "test-model",
      configRevision: 1,
      testedAt: NOW,
      status: "success" as const,
      text: { status: "success" as const, latencyMs: 1, reply: "ok" },
      structured: { status: "success" as const, latencyMs: 1, reply: "ok" },
    };
    f.service.rememberProbe(result);
    expect(f.service.latestProbe(provider.id, "test-model")).toEqual(result);
    f.service.update(provider.id, input());
    f.service.rememberProbe(result);
    expect(f.service.latestProbe(provider.id, "test-model")).toBeUndefined();
    f.service.delete(provider.id);
    expect(() =>
      f.service.rememberProbe({ ...result, configRevision: 2 }),
    ).not.toThrow();
    expect(f.service.latestProbe(provider.id, "test-model")).toBeUndefined();
  });
});

describe("LLM credential backup boundaries", () => {
  it("backs up only ciphertext and fingerprints, and restores with a separately supplied matching key", async () => {
    const f = setup();
    const provider = f.service.create(input());
    const backup = join(f.root, "backup");
    const manifest = await backupInstance({
      databasePath: f.databasePath,
      outputDirectory: backup,
    });
    expect(manifest.formatVersion).toBe(3);
    expect(manifest.llmKey?.fingerprint).toHaveLength(64);
    expect(readdirSync(backup)).toEqual(
      expect.arrayContaining(["database.sqlite", "manifest.json"]),
    );
    expect(readdirSync(backup).some((name) => name.endsWith(".llm-key"))).toBe(
      false,
    );
    expect(readFileSync(join(backup, "manifest.json"), "utf8")).not.toContain(
      KEY,
    );
    const target = join(f.root, "restored.sqlite");
    const assets = join(f.root, "restored-assets");
    await expect(
      restoreInstance({
        backupDirectory: backup,
        targetDatabasePath: target,
        targetAssetsPath: assets,
      }),
    ).rejects.toThrow(/LLM key/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(assets)).toBe(false);
    await restoreInstance({
      backupDirectory: backup,
      targetDatabasePath: target,
      targetAssetsPath: assets,
      llmKeyFile: llmKeyPath(f.databasePath),
    });
    const db = openDatabase(target);
    databases.push(db);
    const restored = new LlmSettingsService(
      new DatabaseStore(db),
      { ...f.config, databasePath: target },
      f.clock,
    );
    expect(
      restored.resolve({ providerId: provider.id, modelId: "test-model" })
        .apiKey,
    ).toBe(KEY);
  });

  it("rejects a mismatched key even in missing-key recovery mode", async () => {
    const f = setup();
    f.service.create(input());
    const backup = join(f.root, "backup");
    await backupInstance({
      databasePath: f.databasePath,
      outputDirectory: backup,
    });
    const wrong = join(f.root, "wrong.llm-key");
    writeFileSync(wrong, Buffer.alloc(32, 1));
    await expect(
      restoreInstance({
        backupDirectory: backup,
        targetDatabasePath: join(f.root, "target.sqlite"),
        targetAssetsPath: join(f.root, "assets"),
        llmKeyFile: wrong,
        allowMissingLlmKey: true,
      }),
    ).rejects.toThrow(/fingerprint/);
  });

  it("allows explicitly restoring chat data without its LLM key and keeps old v1 manifests readable", async () => {
    const f = setup();
    const provider = f.service.create(input());
    const backup = join(f.root, "backup");
    await backupInstance({
      databasePath: f.databasePath,
      outputDirectory: backup,
    });
    const target = join(f.root, "recovery.sqlite");
    await restoreInstance({
      backupDirectory: backup,
      targetDatabasePath: target,
      targetAssetsPath: join(f.root, "recovery-assets"),
      allowMissingLlmKey: true,
    });
    const db = openDatabase(target);
    databases.push(db);
    const restored = new LlmSettingsService(
      new DatabaseStore(db),
      { ...f.config, databasePath: target },
      f.clock,
    );
    expect(restored.sessionModel("session")).toBeDefined();
    expect(
      restored.catalog().providers.find((p) => p.id === provider.id)
        ?.credentialStatus,
    ).toBe("unavailable");
    const legacy = setup();
    const legacyBackup = join(legacy.root, "backup");
    await backupInstance({
      databasePath: legacy.databasePath,
      outputDirectory: legacyBackup,
    });
    const path = join(legacyBackup, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    manifest.formatVersion = 1;
    delete manifest.llmKey;
    writeFileSync(path, JSON.stringify(manifest));
    await expect(
      restoreInstance({
        backupDirectory: legacyBackup,
        targetDatabasePath: join(legacy.root, "restored.sqlite"),
        targetAssetsPath: join(legacy.root, "assets"),
      }),
    ).resolves.toMatchObject({ formatVersion: 1 });
  });
});
