import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash, verify } from "@node-rs/argon2";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostedAuthService } from "./auth.js";
import { HostedControlStore } from "./control-store.js";

vi.mock("@node-rs/argon2", () => ({ hash: vi.fn(), verify: vi.fn() }));

const opened: { root: string; store: HostedControlStore }[] = [];
const password = "testing-long-password";
const busy = { statusCode: 429, code: "auth_busy", retryAfterSeconds: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dearvale-auth-limits-"));
  const store = new HostedControlStore(root);
  opened.push({ root, store });
  const admin = store.createAdministrator("admin", "existing-password-hash");
  return { store, admin, auth: new HostedAuthService(store) };
}
beforeEach(() => {
  vi.mocked(hash).mockReset().mockResolvedValue("new-password-hash");
  vi.mocked(verify).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  for (const { root, store } of opened.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["closed", "unknown", "revoked", "expired", "used"] as const)(
  "rejects %s registration before any password work",
  async (state) => {
    const { store, admin, auth } = fixture();
    const invitation = store.createInvite(
      state === "expired" ? { expiresAtUtc: "2000-01-01T00:00:00Z" } : {},
      admin.id,
    );
    if (state !== "closed")
      store.setLimits({ registrationEnabled: true }, admin.id);
    if (state === "revoked") store.revokeInvite(invitation.invite.id, admin.id);
    if (state === "used")
      store.registerUser({
        username: "already-registered",
        passwordHash: "existing-hash",
        inviteCode: invitation.code,
      });
    await expect(
      auth.register({
        username: "friend",
        password,
        inviteCode:
          state === "unknown" ? "unknown-invitation" : invitation.code,
      }),
    ).rejects.toMatchObject({
      code: state === "closed" ? "registration_disabled" : "invalid_invite",
    });
    expect(hash).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  },
);

it.each(["closed", "revoked"] as const)(
  "rechecks %s registration after the password hash completes",
  async (state) => {
    const { store, admin, auth } = fixture();
    store.setLimits({ registrationEnabled: true }, admin.id);
    const { code, invite } = store.createInvite({}, admin.id);
    const work = deferred<string>();
    vi.mocked(hash).mockReturnValueOnce(work.promise);
    const pending = auth.register({
      username: "friend",
      password,
      inviteCode: code,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      code: state === "closed" ? "registration_disabled" : "invalid_invite",
    });
    if (state === "closed")
      store.setLimits({ registrationEnabled: false }, admin.id);
    else store.revokeInvite(invite.id, admin.id);
    work.resolve("new-password-hash");
    await rejected;
    expect(store.listUsers()).toHaveLength(1);
    expect(store.listInvites()[0]!.uses).toBe(0);
  },
);

it("shares two fail-fast password slots across every authentication operation", async () => {
  const { store, admin, auth } = fixture();
  store.setLimits({ registrationEnabled: true }, admin.id);
  const { code } = store.createInvite({}, admin.id);
  const work = deferred<boolean>();
  vi.mocked(verify).mockReturnValue(work.promise);
  const first = auth.login("admin", password);
  const second = auth.login("admin", password);
  expect(verify).toHaveBeenCalledTimes(2);
  await expect(auth.login("admin", password)).rejects.toMatchObject(busy);
  await expect(auth.login("missing", password)).rejects.toMatchObject(busy);
  await expect(auth.bootstrap("other-admin", password)).rejects.toMatchObject(
    busy,
  );
  await expect(
    auth.register({ username: "friend", password, inviteCode: code }),
  ).rejects.toMatchObject(busy);
  await expect(
    auth.changePassword(admin.id, password, password),
  ).rejects.toMatchObject(busy);
  await expect(
    auth.resetPassword(admin.id, password, admin.id),
  ).rejects.toMatchObject(busy);
  expect(hash).not.toHaveBeenCalled();
  expect(verify).toHaveBeenCalledTimes(2);
  work.resolve(true);
  await Promise.all([first, second]);
  await expect(
    auth.resetPassword(admin.id, password, admin.id),
  ).resolves.toMatchObject({
    id: admin.id,
  });
  expect(hash).toHaveBeenCalledTimes(1);
});

it("keeps a password change in its slot through both verification and hashing", async () => {
  const { auth, admin } = fixture();
  const work = deferred<string>();
  vi.mocked(hash).mockReturnValue(work.promise);
  const change = auth.changePassword(admin.id, password, password);
  await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(1));
  const reset = auth.resetPassword(admin.id, password, admin.id);
  await expect(auth.login("admin", password)).rejects.toMatchObject(busy);
  expect(hash).toHaveBeenCalledTimes(2);
  work.resolve("new-password-hash");
  const outcomes = await Promise.allSettled([change, reset]);
  expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
  await expect(auth.login("admin", password)).resolves.toMatchObject({
    user: { id: admin.id },
  });
});

it("releases slots after rejected hash and verify operations", async () => {
  const { auth, admin } = fixture();
  const hashWork = deferred<string>();
  const verifyWork = deferred<boolean>();
  vi.mocked(hash).mockReturnValueOnce(hashWork.promise);
  vi.mocked(verify).mockReturnValueOnce(verifyWork.promise);
  const reset = expect(
    auth.resetPassword(admin.id, password, admin.id),
  ).rejects.toThrow("hash unavailable");
  const login = expect(auth.login("admin", password)).rejects.toMatchObject({
    code: "invalid_credentials",
  });
  await expect(auth.login("admin", password)).rejects.toMatchObject(busy);
  hashWork.reject(new Error("hash unavailable"));
  await reset;
  await expect(auth.login("admin", password)).resolves.toMatchObject({
    user: { id: admin.id },
  });
  verifyWork.reject(new Error("verify unavailable"));
  await login;
  await expect(auth.login("admin", password)).resolves.toMatchObject({
    user: { id: admin.id },
  });
});

it("gates shared dummy hashing and retries it after a hash failure", async () => {
  const { auth } = fixture();
  const work = deferred<string>();
  vi.mocked(hash).mockReturnValueOnce(work.promise);
  const first = expect(auth.login("missing-one", password)).rejects.toThrow(
    "hash unavailable",
  );
  const second = expect(auth.login("missing-two", password)).rejects.toThrow(
    "hash unavailable",
  );
  await expect(auth.login("missing-three", password)).rejects.toMatchObject(
    busy,
  );
  expect(hash).toHaveBeenCalledTimes(1);
  expect(verify).not.toHaveBeenCalled();
  work.reject(new Error("hash unavailable"));
  await Promise.all([first, second]);
  await expect(auth.login("missing-three", password)).rejects.toMatchObject({
    code: "invalid_credentials",
  });
  expect(hash).toHaveBeenCalledTimes(2);
  expect(verify).toHaveBeenCalledTimes(1);
});
