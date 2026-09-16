import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostedControlStore } from "./control-store.js";
import { HostedAuthService } from "./auth.js";
let store: HostedControlStore | undefined;
let root: string | undefined;
afterEach(() => {
  vi.useRealTimers();
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it("uses Argon2id, handles invitation concurrency and revokes reset/logout sessions", async () => {
  root = mkdtempSync(join(tmpdir(), "dearvale-auth-"));
  store = new HostedControlStore(root);
  const auth = new HostedAuthService(store);
  const admin = await auth.bootstrap("admin", "a-long-admin-password");
  store.setLimits({ registrationEnabled: true }, admin.user.id);
  expect(store.passwordRecord("admin")!.passwordHash).toMatch(/^\$argon2id\$/u);
  await expect(
    auth.bootstrap("other-admin", "another-long-password"),
  ).rejects.toThrow("already initialized");
  const { code } = store.createInvite(
    { maxUses: 1, initialBalanceMicros: 1000 },
    admin.user.id,
  );
  const results = await Promise.allSettled([
    auth.register({
      username: "friend1",
      password: "a-friend-password",
      inviteCode: code,
    }),
    auth.register({
      username: "friend2",
      password: "a-friend-password",
      inviteCode: code,
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "invalid_invite" },
  });
  const result = results.find((item) => item.status === "fulfilled")!;
  if (result.status !== "fulfilled") throw new Error("No registered user");
  const friend = result.value;
  expect(friend.user).toMatchObject({
    consentVersion: null,
    consentAtUtc: null,
  });
  expect(store.getUser(friend.user.id)).toMatchObject({
    consentVersion: null,
    consentAtUtc: null,
  });
  expect(auth.authenticate(friend.token).user.id).toBe(friend.user.id);
  await auth.resetPassword(
    friend.user.id,
    "temporary-new-password",
    admin.user.id,
  );
  expect(() => auth.authenticate(friend.token)).toThrow("Sign in");
  const fresh = await auth.login(
    friend.user.username,
    "temporary-new-password",
  );
  expect(fresh.user.mustChangePassword).toBe(true);
  const changed = await auth.changePassword(
    friend.user.id,
    "temporary-new-password",
    "permanent-new-password",
  );
  expect(changed.user.mustChangePassword).toBe(false);
  expect(() => auth.authenticate(fresh.token)).toThrow("Sign in");
  auth.logout(changed.token);
  expect(() => auth.authenticate(changed.token)).toThrow("Sign in");
});
it("shares failure limits across canonical usernames and reports the remaining cooldown", async () => {
  root = mkdtempSync(join(tmpdir(), "dearvale-auth-"));
  store = new HostedControlStore(root);
  const auth = new HostedAuthService(store);
  await auth.bootstrap("admin", "a-long-admin-password");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
  for (const username of ["admin", " ADMIN ", "ａｄｍｉｎ", "Admin", " admin"])
    await expect(auth.login(username, "wrong")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  await expect(
    auth.login("admin", "a-long-admin-password"),
  ).rejects.toMatchObject({ code: "login_throttled", retryAfterSeconds: 900 });
  vi.setSystemTime(new Date("2026-09-16T00:14:59.100Z"));
  await expect(
    auth.login(" ADMIN ", "a-long-admin-password"),
  ).rejects.toMatchObject({ code: "login_throttled", retryAfterSeconds: 1 });
  vi.setSystemTime(new Date("2026-09-16T00:15:00Z"));
  await expect(
    auth.login(" ＡＤＭＩＮ ", "a-long-admin-password"),
  ).resolves.toMatchObject({
    user: { username: "admin" },
  });
  expect(store.loginRetryAfterSeconds("admin")).toBe(0);
});
