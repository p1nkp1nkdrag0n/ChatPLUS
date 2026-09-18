import { hash, verify, type Options } from "@node-rs/argon2";
import {
  type HostedControlStore,
  normalizeLoginIdentifier,
  normalizeUsername,
} from "./control-store.js";
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
  private activePasswordWork = 0;
  constructor(readonly store: HostedControlStore) {}
  private async passwordWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.activePasswordWork >= 2)
      throw new HostedError(
        429,
        "auth_busy",
        "登录请求较多，请 1 秒后重试。",
        1,
      );
    this.activePasswordWork++;
    try {
      return await work();
    } finally {
      this.activePasswordWork--;
    }
  }
  async bootstrap(
    username: string,
    password: string,
  ): Promise<HostedLoginResult> {
    normalizeUsername(username);
    validatePassword(password);
    return this.passwordWork(async () => {
      const user = this.store.createAdministrator(
        username,
        await hash(password, passwordOptions),
      );
      return { user, ...this.store.createSession(user.id) };
    });
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
    this.store.assertRegistrationAllowed(input.inviteCode);
    return this.passwordWork(async () => {
      const user = this.store.registerUser({
        username: input.username,
        inviteCode: input.inviteCode,
        passwordHash: await hash(input.password, passwordOptions),
        consentVersion:
          input.acceptedConsent === true
            ? (input.consentVersion ?? null)
            : null,
      });
      return { user, ...this.store.createSession(user.id) };
    });
  }
  async login(username: string, password: string): Promise<HostedLoginResult> {
    let subject = "";
    let record: ReturnType<HostedControlStore["passwordRecord"]>;
    try {
      subject = normalizeLoginIdentifier(username).toLocaleLowerCase("en-US");
      record = this.store.passwordRecord(username);
      // The legacy alias and generated account name share the same failure limit.
      if (record) subject = record.user.accountName.toLocaleLowerCase("en-US");
    } catch {
      // Invalid names share a failure bucket and still receive a generic error.
    }
    const retryAfterSeconds = this.store.loginRetryAfterSeconds(subject);
    if (retryAfterSeconds > 0)
      throw new HostedError(
        429,
        "login_throttled",
        `登录失败次数过多，请 ${retryAfterSeconds} 秒后重试。`,
        retryAfterSeconds,
      );
    return this.passwordWork(async () => {
      if (!record)
        this.dummyHash ??= hash(
          "unavailable-account-password",
          passwordOptions,
        ).catch((error: unknown) => {
          this.dummyHash = undefined;
          throw error;
        });
      const candidate =
        typeof password === "string" && password.length <= 256 ? password : "";
      const valid = await verify(
        record?.passwordHash ?? (await this.dummyHash!),
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
    });
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
    this.store.assertActiveUser(userId);
    const record = this.store.passwordRecordById(userId)!;
    return this.passwordWork(async () => {
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
    });
  }
  async resetPassword(
    userId: string,
    password: string,
    actorId: string,
  ): Promise<HostedUser> {
    validatePassword(password);
    return this.passwordWork(async () => {
      this.store.setPasswordHash(
        userId,
        await hash(password, passwordOptions),
        true,
        actorId,
      );
      return this.store.getUser(userId)!;
    });
  }
}
