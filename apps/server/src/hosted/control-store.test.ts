import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { HostedControlStore } from "./control-store.js";
import type { HostedModelInput } from "./types.js";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomInt: vi.fn(original.randomInt) };
});

const opened: { root: string; store: HostedControlStore }[] = [];
function fixture(configured = true) {
  const root = mkdtempSync(join(tmpdir(), "dearvale-control-"));
  const store = new HostedControlStore(root);
  opened.push({ root, store });
  const admin = store.createAdministrator("admin", "test-password-hash");
  store.setLimits({ registrationEnabled: true }, admin.id);
  if (configured) {
    store.upsertModel(model, admin.id);
    store.setLimits({ callsEnabled: true }, admin.id);
  }
  const created = store.createInvite(
    { initialBalanceMicros: 20_000_000, maxUses: 2 },
    admin.id,
  );
  const user = store.registerUser({
    username: "friend",
    passwordHash: "not-a-real-hash",
    inviteCode: created.code,
    consentVersion: "2026-09",
  });
  return { root, store, admin, user, created };
}
const model: HostedModelInput = {
  routeId: "chat",
  displayName: "测试模型",
  kind: "text",
  protocol: "openai-compatible",
  baseUrl: "https://provider.example/v1",
  modelId: "real-model",
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
  cacheReadMicrosPerMillion: 100_000,
  maxOutputTokens: 1000,
  enabled: true,
  apiKey: "test-private-provider-key",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(crypto.randomInt).mockReset();
  for (const { root, store } of opened.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("hosted central control", () => {
  it("closes fresh registration by default and preserves persisted explicit choices", () => {
    const root = mkdtempSync(join(tmpdir(), "dearvale-control-"));
    const state = { root, store: new HostedControlStore(root) };
    opened.push(state);
    expect(state.store.getLimits().registrationEnabled).toBe(false);
    const admin = state.store.createAdministrator(
      "admin",
      "test-password-hash",
    );
    const { code } = state.store.createInvite({}, admin.id);
    expect(() => state.store.assertRegistrationAllowed(code)).toThrow(
      "disabled",
    );
    for (const registrationEnabled of [true, false]) {
      state.store.setLimits({ registrationEnabled }, admin.id);
      state.store.close();
      state.store = new HostedControlStore(root);
      expect(state.store.getLimits().registrationEnabled).toBe(
        registrationEnabled,
      );
    }
  });
  it("keeps zero-price models as disabled drafts and requires complete pricing before global activation", () => {
    const { store, admin } = fixture(false);
    expect(store.getLimits().callsEnabled).toBe(false);
    expect(() => store.setLimits({ callsEnabled: true }, admin.id)).toThrow(
      "先配置并启用",
    );
    const draft = store.upsertModel(
      {
        ...model,
        inputMicrosPerMillion: 0,
        outputMicrosPerMillion: 0,
        cacheReadMicrosPerMillion: 0,
      },
      admin.id,
    );
    expect(draft).toMatchObject({
      enabled: false,
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    expect(() => store.setLimits({ callsEnabled: true }, admin.id)).toThrow(
      "输入和输出价格必须大于 0",
    );
    expect(store.getLimits().callsEnabled).toBe(false);
    const ready = store.upsertModel(
      { ...model, cacheReadMicrosPerMillion: 0 },
      admin.id,
    );
    expect(ready.enabled).toBe(true);
    expect(store.setLimits({ callsEnabled: true }, admin.id).callsEnabled).toBe(
      true,
    );
    expect(store.resolveModel(model.routeId, draft.revision)).toMatchObject({
      enabled: false,
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
    });
    const imageDraft = store.upsertModel(
      { ...model, routeId: "picture", kind: "image", imagePointsMicros: 0 },
      admin.id,
    );
    expect(imageDraft.enabled).toBe(false);
    expect(store.setLimits({ callsEnabled: true }, admin.id).callsEnabled).toBe(
      true,
    );
  });

  it("blocks a legacy enabled zero-price configuration and direct zero-price reservations", () => {
    const { store, admin, user } = fixture();
    const zero = {
      ...store.listModels()[0]!,
      inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0,
      cacheReadMicrosPerMillion: 0,
    };
    expect(() =>
      store.reserve({
        id: "zero-bypass",
        userId: user.id,
        purpose: "chat_turn",
        maximumCostMicros: 0,
        modelSnapshot: zero,
      }),
    ).toThrow("输入和输出价格必须大于 0");
    expect(store.findAttempt("zero-bypass")).toBeUndefined();
    store.setLimits({ callsEnabled: false }, admin.id);
    // Simulate the old on-disk enabled configuration without changing history
    // through the new save-time normalization.
    store.database
      .prepare(
        "UPDATE model_versions SET snapshot_json=? WHERE route_id=? AND revision=?",
      )
      .run(JSON.stringify(zero), zero.routeId, zero.revision);
    expect(() => store.setLimits({ callsEnabled: true }, admin.id)).toThrow(
      "输入和输出价格必须大于 0",
    );
    expect(store.getLimits().callsEnabled).toBe(false);
    expect(store.resolveModel(zero.routeId).inputMicrosPerMillion).toBe(0);
  });
  it("allows only one live store and protects a replacement owner's lock on repeated close", () => {
    const { root, store } = fixture();
    expect(() => new HostedControlStore(root)).toThrow("already using");
    store.close();
    const replacement = new HostedControlStore(root);
    try {
      store.close();
      expect(existsSync(join(root, "runtime.lock"))).toBe(true);
      expect(() => new HostedControlStore(root)).toThrow("already using");
    } finally {
      replacement.close();
    }
    expect(existsSync(join(root, "runtime.lock"))).toBe(false);
  });
  it("rejects missing keys without creating a replacement or retaining its instance lock", () => {
    const { root, store } = fixture();
    store.close();
    rmSync(join(root, ".secrets", "master.key"));
    expect(() => new HostedControlStore(root)).toThrow("original master key");
    expect(existsSync(join(root, ".secrets", "master.key"))).toBe(false);
    expect(existsSync(join(root, "runtime.lock"))).toBe(false);
  });
  it("does not remove an invalid or still-live lock", () => {
    const { root, store } = fixture();
    store.close();
    writeFileSync(join(root, "runtime.lock"), "invalid-owner");
    expect(() => new HostedControlStore(root)).toThrow("lock is damaged");
    expect(readFileSync(join(root, "runtime.lock"), "utf8")).toBe(
      "invalid-owner",
    );
  });
  it("uses FULL WAL and never stores the invite code or provider secret in plaintext", () => {
    const { root, store, admin, created } = fixture();
    expect(store.database.pragma("synchronous", { simple: true })).toBe(2);
    expect(store.database.pragma("journal_mode", { simple: true })).toBe("wal");
    store.upsertModel(model, admin.id);
    store.database.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = readFileSync(join(root, "control.sqlite"));
    expect(bytes.includes(Buffer.from(created.code))).toBe(false);
    expect(bytes.includes(Buffer.from(model.apiKey!))).toBe(false);
    expect(store.listModels()[0]).not.toHaveProperty("apiKey");
  });
  it("atomically consumes invitations while allowing duplicate display names", () => {
    const { store, created, user } = fixture();
    expect(() =>
      store.registerUser({
        username: "bad#name",
        passwordHash: "x",
        inviteCode: created.code,
        consentVersion: "v1",
      }),
    ).toThrow("Username");
    expect(store.listInvites()[0]!.uses).toBe(1);
    const registered = store.registerUser({
      username: "FRIEND",
      passwordHash: "x",
      inviteCode: created.code,
    });
    expect(registered).toMatchObject({
      username: "FRIEND",
      consentVersion: null,
      consentAtUtc: null,
    });
    expect(store.getUser(user.id)).toMatchObject({
      consentVersion: "2026-09",
      consentAtUtc: user.consentAtUtc,
    });
    expect(() =>
      store.registerUser({
        username: "friend3",
        passwordHash: "x",
        inviteCode: created.code,
        consentVersion: "v1",
      }),
    ).toThrow("invitation");
    expect(store.listUsers()).toHaveLength(3);
    expect(user.accountName).toMatch(/^friend#[0-9]{6}$/u);
    expect(registered.accountName.toLowerCase()).not.toBe(user.accountName);
    expect(store.passwordRecord("friend")).toBeUndefined();
    expect(store.passwordRecord(registered.accountName)?.user.id).toBe(
      registered.id,
    );
    expect(store.listUsers({ search: registered.accountName })).toEqual([
      registered,
    ]);
  });
  it("retries random account suffix collisions and rolls back exhausted registrations", () => {
    const { store, admin } = fixture();
    const { code, invite } = store.createInvite({ maxUses: 3 }, admin.id);
    const random = vi
      .mocked(crypto.randomInt)
      .mockClear()
      .mockImplementation(() => 7);
    const first = store.registerUser({
      username: "圆圆",
      passwordHash: "first",
      inviteCode: code,
    });
    expect(first.accountName).toBe("圆圆#000007");
    random.mockImplementationOnce(() => 7).mockImplementationOnce(() => 8);
    const second = store.registerUser({
      username: "圆圆",
      passwordHash: "second",
      inviteCode: code,
    });
    expect(second.accountName).toBe("圆圆#000008");
    expect(random).toHaveBeenCalledTimes(3);
    const userCount = store.listUsers().length;
    expect(() =>
      store.registerUser({
        username: "圆圆",
        passwordHash: "third",
        inviteCode: code,
      }),
    ).toThrow("暂时无法生成唯一账号");
    expect(store.listUsers()).toHaveLength(userCount);
    expect(
      store.listInvites().find((item) => item.id === invite.id)?.uses,
    ).toBe(2);
    expect(
      store.database.prepare("SELECT count(*) AS count FROM wallets").get(),
    ).toEqual({ count: userCount });
  });
  it("migrates legacy names without changing IDs, wallets or sessions and keeps only their original aliases", () => {
    const { root, store, user, created } = fixture();
    const session = store.createSession(user.id);
    const wallet = store.wallet(user.id);
    store.database.exec(
      "UPDATE users SET username_key=lower(username); DROP INDEX users_legacy_username; ALTER TABLE users DROP COLUMN account_name; ALTER TABLE users DROP COLUMN legacy_username_key;",
    );
    store.close();
    const state = opened.find((item) => item.root === root)!;
    state.store = new HostedControlStore(root);
    const migrated = state.store.getUser(user.id)!;
    expect(migrated).toMatchObject({
      ...user,
      accountName: expect.stringMatching(/^friend#[0-9]{6}$/u),
    });
    expect(state.store.passwordRecord(" FRIEND ")?.user.id).toBe(user.id);
    expect(state.store.passwordRecord(migrated.accountName)?.user.id).toBe(
      user.id,
    );
    expect(state.store.wallet(user.id)).toEqual(wallet);
    expect(state.store.authenticateSession(session.token)?.user.id).toBe(
      user.id,
    );
    const duplicate = state.store.registerUser({
      username: "friend",
      passwordHash: "duplicate",
      inviteCode: created.code,
    });
    expect(state.store.passwordRecord("friend")?.user.id).toBe(user.id);
    expect(state.store.passwordRecord(duplicate.accountName)?.user.id).toBe(
      duplicate.id,
    );
    expect(state.store.database.pragma("foreign_key_check")).toEqual([]);
    state.store.close();
    state.store = new HostedControlStore(root);
    expect(state.store.getUser(user.id)?.accountName).toBe(
      migrated.accountName,
    );
    expect(state.store.getUser(duplicate.id)?.accountName).toBe(
      duplicate.accountName,
    );
  });
  it("freezes funds once, settles once and preserves uncertain attempts", () => {
    const { store, admin, user } = fixture();
    const snapshot = store.upsertModel(model, admin.id);
    const input = {
      id: "attempt1",
      userId: user.id,
      operationId: "operation1",
      purpose: "chat",
      maximumCostMicros: 2_000_000,
      modelSnapshot: snapshot,
    };
    store.reserve(input);
    store.reserve(input);
    expect(store.wallet(user.id).reservedMicros).toBe(2_000_000);
    store.markAttemptSent(input.id);
    expect(() => store.markAttemptSent(input.id)).toThrow("sent again");
    expect(() => store.release(input.id, "cancel")).toThrow("reconciliation");
    store.markUnknown(input.id, "timeout");
    expect(store.wallet(user.id).reservedMicros).toBe(2_000_000);
    store.settle({
      id: input.id,
      costMicros: 750_000,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    store.settle({ id: input.id, costMicros: 750_000 });
    expect(store.wallet(user.id)).toMatchObject({
      balanceMicros: 19_250_000,
      reservedMicros: 0,
    });
    expect(
      store.listLedger(user.id).filter((row) => row.kind === "llm_charge"),
    ).toHaveLength(1);
    expect(() => store.settle({ id: input.id, costMicros: 750_001 })).toThrow(
      "different settlement",
    );
  });
  it("checks ban status after reservation and before supplier dispatch", () => {
    const { store, admin, user } = fixture();
    const input = {
      id: "blocked",
      userId: user.id,
      purpose: "chat",
      maximumCostMicros: 1_000_000,
      modelSnapshot: store.upsertModel(model, admin.id),
    };
    store.reserve(input);
    const auth = store.createSession(user.id);
    store.banUser(user.id, true, admin.id, "test");
    expect(store.authenticateSession(auth.token)).toBeUndefined();
    expect(() => store.markAttemptSent(input.id)).toThrow("unavailable");
    store.release(input.id, "banned before dispatch");
    expect(store.wallet(user.id).reservedMicros).toBe(0);
  });
  it("honors fresh limits and retains funds for an unexpectedly large bill", () => {
    const { store, admin, user } = fixture();
    const snapshot = store.upsertModel(model, admin.id);
    store.setLimits({ perUserDailyMicros: 1000 }, admin.id);
    expect(() =>
      store.reserve({
        id: "large",
        userId: user.id,
        purpose: "chat",
        maximumCostMicros: 1001,
        modelSnapshot: snapshot,
      }),
    ).toThrow("daily");
    store.reserve({
      id: "small",
      userId: user.id,
      purpose: "chat",
      maximumCostMicros: 500,
      modelSnapshot: snapshot,
    });
    store.markAttemptSent("small");
    expect(store.settle({ id: "small", costMicros: 600 }).status).toBe(
      "unknown",
    );
    expect(store.wallet(user.id).reservedMicros).toBe(500);
    store.reconcile({
      id: "small",
      costMicros: 600,
      actorId: admin.id,
      reason: "Verified provider usage",
    });
    expect(store.wallet(user.id).reservedMicros).toBe(0);
  });
  it("keeps immutable model versions and central purpose selections", () => {
    const { store, admin } = fixture();
    const original = store.upsertModel(model, admin.id);
    const updated = store.upsertModel(
      { ...model, displayName: "新版", apiKey: "updated-key" },
      admin.id,
    );
    store.setPurposeDefault("default", model.routeId, admin.id);
    expect(updated.revision).toBe(original.revision + 1);
    expect(store.resolveModel(model.routeId, original.revision)).toMatchObject({
      displayName: model.displayName,
      apiKey: model.apiKey,
    });
    expect(store.resolvePurpose("chat_turn")).toMatchObject({
      displayName: "新版",
      apiKey: "updated-key",
    });
    expect(store.modelHasKey(model.routeId)).toBe(true);
    expect(
      store.replacePurposeDefaults({ chat_turn: model.routeId }, admin.id),
    ).toEqual({ chat_turn: model.routeId });
    expect(() =>
      store.replacePurposeDefaults({ invalid: "missing" }, admin.id),
    ).toThrow("not found");
    expect(store.purposeDefaults()).toEqual({ chat_turn: model.routeId });
    expect(store.replacePurposeDefaults({}, admin.id)).toEqual({});
    expect(() =>
      store.upsertModel(
        { ...model, maxContextTokens: model.maxOutputTokens },
        admin.id,
      ),
    ).toThrow("context token limit");
    expect(
      store.upsertModel({ ...model, maxContextTokens: 16000 }, admin.id)
        .maxContextTokens,
    ).toBe(16000);
  });
  it("associates physical attempts with conversation sessions, parent operations and durable assets", () => {
    const { store, admin, user } = fixture();
    const snapshot = store.upsertModel(model, admin.id);
    store.reserve({
      id: "child",
      userId: user.id,
      operationId: "background-job",
      parentOperationId: "parent-chat",
      sessionId: "session1",
      purpose: "image",
      maximumCostMicros: 100,
      modelSnapshot: snapshot,
    });
    const entry = store.recordResearch({
      attemptId: "child",
      kind: "request",
      payload: { text: "request" },
    });
    expect(entry.sessionId).toBe("session1");
    expect(
      store.listResearch({ modelId: model.modelId, purpose: "image" }),
    ).toHaveLength(1);
    expect(store.listResearch({ modelId: "other-model" })).toHaveLength(0);
    expect(
      store.listAttempts({ userId: user.id, operationId: "parent-chat" }),
    ).toHaveLength(1);
    store.recordAttemptAsset("child", {
      storageKey: "assets/image.png",
      sha256: "hash",
    });
    expect(store.readAttemptAsset("child")).toEqual({
      storageKey: "assets/image.png",
      sha256: "hash",
    });
    const bytes = Buffer.from("fake-image-bytes-for-private-storage");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const image = {
      bytes,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      sha256,
    };
    store.recordAttemptImage("child", image);
    store.recordAttemptImage("child", image);
    expect(store.readAttemptImage("child")).toEqual(image);
    expect(store.listResearch({ kind: "image" })).toHaveLength(1);
    const exported = JSON.parse(
      store.exportResearch({ kind: "image" }, admin.id),
    ) as { payload: { fileName: string; sha256: string; data: string } };
    expect(exported.payload).toMatchObject({
      fileName: `images/${sha256}.png`,
      sha256,
      data: bytes.toString("base64"),
    });
    expect(store.deleteResearch({ kind: "image" }, admin.id)).toBe(1);
    expect(store.readAttemptImage("child")).toBeUndefined();
    store.recordAttemptImage("child", image);
    expect(store.readAttemptImage("child")).toBeUndefined();
    expect(() =>
      store.recordAttemptAsset("child", {
        storageKey: "different.png",
        sha256: "hash",
      }),
    ).toThrow("another asset");
    expect(store.overviewStats()).toMatchObject({
      users: 2,
      activeUsers: 2,
      requestCount: 1,
      totalHeldMicros: 100,
      pendingReconciliations: 0,
    });
  });
  it("stores both conversation and provider records privately and deletes one exact record", () => {
    const { root, store, admin, user } = fixture();
    const input = store.recordConversation({
      userId: user.id,
      operationId: "op",
      kind: "input",
      payload: { text: "private-research-input-unique" },
    });
    const output = store.recordConversation({
      userId: user.id,
      operationId: "op",
      kind: "output",
      payload: { text: "private-output" },
    });
    expect(
      store.recordConversation({
        userId: user.id,
        operationId: "op",
        kind: "output",
        payload: { text: "private-output" },
      }).id,
    ).toBe(output.id);
    const recovered = store.recordConversation({
      userId: user.id,
      operationId: "op",
      kind: "output",
      payload: { text: "recovered-final-output" },
    });
    expect(recovered.id).not.toBe(output.id);
    expect(
      store.recordConversation({
        userId: user.id,
        operationId: "op",
        kind: "input",
        payload: { text: "private-research-input-unique" },
      }).id,
    ).toBe(input.id);
    store.researchDatabase.pragma("wal_checkpoint(TRUNCATE)");
    expect(
      readFileSync(join(root, "research.sqlite")).includes(
        Buffer.from("private-research-input-unique"),
      ),
    ).toBe(false);
    expect(store.readResearch(input.id, admin.id).payload).toEqual({
      text: "private-research-input-unique",
    });
    expect(store.purgeExpiredResearch()).toBe(0);
    expect(store.deleteResearch({ id: input.id }, admin.id)).toBe(1);
    expect(store.listResearch()).toHaveLength(2);
    expect(store.listResearch().map((item) => item.id)).toContain(output.id);
    expect(() => store.readResearch(input.id, admin.id)).toThrow("not found");
  });
  it("replays durable responses with safe headers and blocks conflicting operations", () => {
    const { store, admin, user } = fixture();
    store.reserve({
      id: "attempt",
      userId: user.id,
      operationId: "operation",
      purpose: "chat",
      maximumCostMicros: 1,
      modelSnapshot: store.upsertModel(model, admin.id),
    });
    store.recordAttemptResponse("attempt", {
      status: 200,
      body: '{"answer":"hello"}',
      headers: { authorization: "secret", "content-type": "application/json" },
    });
    expect(store.readAttemptResponse("attempt")).toEqual({
      status: 200,
      body: '{"answer":"hello"}',
      headers: { "content-type": "application/json" },
    });
    const operation = {
      id: "operation",
      userId: user.id,
      method: "POST",
      path: "/messages",
      input: { text: "hello" },
      clientMessageId: "client1",
    };
    expect(store.beginOperation(operation).status).toBe("running");
    expect(() =>
      store.beginOperation({ ...operation, input: { text: "changed" } }),
    ).toThrow("different input");
    store.completeOperation(user.id, operation.id, {
      statusCode: 200,
      response: { text: "answer" },
    });
    expect(
      store.findOperationByClientMessageId(user.id, "client1"),
    ).toMatchObject({ status: "completed", response: { text: "answer" } });
    expect(store.getOperation(admin.id, operation.id)).toBeUndefined();
  });
  it("migrates existing encrypted research records without losing payloads", () => {
    const { root, store, user, admin } = fixture();
    const entry = store.recordConversation({
      userId: user.id,
      operationId: "before-upgrade",
      kind: "input",
      payload: { text: "kept-through-upgrade" },
    });
    store.close();
    const db = new BetterSqlite3(join(root, "research.sqlite"));
    const definition = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='research_records'",
      )
      .get() as { sql: string };
    db.transaction(() => {
      db.exec(
        definition.sql
          .replace("research_records", "research_records_legacy")
          .replace(", 'image'", "")
          .replace(",'image'", ""),
      );
      db.exec(
        "INSERT INTO research_records_legacy SELECT * FROM research_records; DROP TABLE research_records; ALTER TABLE research_records_legacy RENAME TO research_records; CREATE UNIQUE INDEX research_conversation_kind ON research_records(user_id,operation_id,kind) WHERE attempt_id IS NULL;",
      );
    }).immediate();
    db.close();
    const restored = new HostedControlStore(root);
    try {
      expect(restored.readResearch(entry.id, admin.id).payload).toEqual({
        text: "kept-through-upgrade",
      });
      const table = restored.researchDatabase
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='research_records'",
        )
        .get() as { sql: string };
      expect(table.sql).toContain("'image'");
      expect(
        restored.researchDatabase
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='research_conversation_kind'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      restored.close();
    }
  });
});
