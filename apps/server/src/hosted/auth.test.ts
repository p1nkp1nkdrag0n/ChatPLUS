import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HostedControlStore } from "./control-store.js";
import { HostedAuthService } from "./auth.js";
let store: HostedControlStore | undefined;
let root: string | undefined;
afterEach(() => {
  store?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
it("uses Argon2id, handles invitation concurrency and revokes reset/logout sessions", async () => {
  root = mkdtempSync(join(tmpdir(), "dearvale-auth-"));
  store = new HostedControlStore(root);
  const auth = new HostedAuthService(store);
  const admin = await auth.bootstrap("admin", "a-long-admin-password");
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
it("uses generic authentication errors and throttles repeated failures", async () => {
  root = mkdtempSync(join(tmpdir(), "dearvale-auth-"));
  store = new HostedControlStore(root);
  const auth = new HostedAuthService(store);
  await auth.bootstrap("admin", "a-long-admin-password");
  for (let index = 0; index < 5; index++)
    await expect(auth.login("admin", "wrong")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
  await expect(
    auth.login("admin", "a-long-admin-password"),
  ).rejects.toMatchObject({ code: "login_throttled" });
});
