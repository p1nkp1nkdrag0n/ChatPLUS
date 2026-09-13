import { hash, verify, type Options } from "@node-rs/argon2";
import { type HostedControlStore, normalizeUsername } from "./control-store.js";
import { HostedError, type HostedSession, type HostedUser } from "./types.js";

export interface HostedLoginResult {
  user: HostedUser;
  session: HostedSession;
  token: string;
}
// @node-rs exposes Algorithm as an ambient const enum; 2 is its Argon2id value.
const passwordOptions: Options = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};
function validatePassword(password: string): void {
  if (
    typeof password !== "string" ||
    password.length < 10 ||
    password.length > 256
  )
    throw new HostedError(
      400,
      "invalid_password",
      "Password must contain 10–256 characters.",
    );
}
export class HostedAuthService {
  private dummyHash: Promise<string> | undefined;
  constructor(readonly store: HostedControlStore) {}
  async bootstrap(
    username: string,
    password: string,
  ): Promise<HostedLoginResult> {
    normalizeUsername(username);
    validatePassword(password);
    const user = this.store.createAdministrator(
      username,
      await hash(password, passwordOptions),
    );
    return { user, ...this.store.createSession(user.id) };
  }
  async register(input: {
    username: string;
    password: string;
    inviteCode: string;
    consentVersion?: string | undefined;
    acceptedConsent?: boolean | undefined;
  }): Promise<HostedLoginResult> {
    normalizeUsername(input.username);
    validatePassword(input.password);
    const user = this.store.registerUser({
      username: input.username,
      inviteCode: input.inviteCode,
      passwordHash: await hash(input.password, passwordOptions),
      consentVersion:
        input.acceptedConsent === true ? (input.consentVersion ?? null) : null,
    });
    return { user, ...this.store.createSession(user.id) };
  }
  async login(username: string, password: string): Promise<HostedLoginResult> {
    const subject =
      typeof username === "string"
        ? username.normalize("NFKC").toLocaleLowerCase("en-US")
        : "";
    if (this.store.loginBlocked(subject))
      throw new HostedError(
        429,
        "login_throttled",
        "Too many failed login attempts. Try again in 15 minutes.",
      );
    let record: ReturnType<HostedControlStore["passwordRecord"]>;
    try {
      record = this.store.passwordRecord(username);
    } catch {
      record = undefined;
    }
    this.dummyHash ??= hash("unavailable-account-password", passwordOptions);
    const candidate =
      typeof password === "string" && password.length <= 256 ? password : "";
    const valid = await verify(
      record?.passwordHash ?? (await this.dummyHash),
      candidate,
    ).catch(() => false);
    if (!valid || !record || record.user.status !== "active") {
      this.store.recordLoginFailure(subject);
      throw new HostedError(
        401,
        "invalid_credentials",
        "Username or password is incorrect, or the account is unavailable.",
      );
    }
    this.store.clearLoginFailures(subject);
    return {
      user: record.user,
      ...this.store.createSession(record.user.id, record.passwordHash),
    };
  }
  authenticate(token: string): { user: HostedUser; session: HostedSession } {
    const value = this.store.authenticateSession(token);
    if (!value)
      throw new HostedError(
        401,
        "authentication_required",
        "Sign in to continue.",
      );
    return value;
  }
  logout(token: string): void {
    this.store.revokeSession(token);
  }
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<HostedLoginResult> {
    validatePassword(newPassword);
    const user = this.store.assertActiveUser(userId);
    const record = this.store.passwordRecord(user.username)!;
    if (
      typeof currentPassword !== "string" ||
      currentPassword.length > 256 ||
      !(await verify(record.passwordHash, currentPassword).catch(() => false))
    )
      throw new HostedError(
        401,
        "invalid_credentials",
        "Current password is incorrect.",
      );
    this.store.setPasswordHash(
      userId,
      await hash(newPassword, passwordOptions),
      false,
      userId,
      record.passwordHash,
    );
    return {
      user: this.store.getUser(userId)!,
      ...this.store.createSession(userId),
    };
  }
  async resetPassword(
    userId: string,
    password: string,
    actorId: string,
  ): Promise<HostedUser> {
    validatePassword(password);
    this.store.setPasswordHash(
      userId,
      await hash(password, passwordOptions),
      true,
      actorId,
    );
    return this.store.getUser(userId)!;
  }
}
