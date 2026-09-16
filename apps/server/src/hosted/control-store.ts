import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import {
  assertHostedModelPricing,
  hostedModelPricingReady,
} from "./model-pricing.js";
import {
  HostedCrypto,
  hashOpaqueToken,
  randomOpaqueToken,
  protectDirectory,
} from "./crypto.js";
import {
  HostedError,
  type HostedAttempt,
  type HostedAttemptImage,
  type HostedAttemptResponse,
  type HostedAuditEntry,
  type HostedInvite,
  type HostedLimits,
  type HostedModelInput,
  type HostedModelSnapshot,
  type HostedOperation,
  type HostedReservationInput,
  type HostedResearchInput,
  type HostedResearchMetadata,
  type HostedResolvedModel,
  type HostedSession,
  type HostedUsage,
  type HostedUser,
  type HostedWallet,
} from "./types.js";

type Row = Record<string, unknown>;
function acquireLock(root: string): () => void {
  const path = join(root, "runtime.lock");
  const token = randomUUID();
  const serialized = JSON.stringify({ pid: process.pid, token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, serialized, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      let previous: { pid: number; token: string };
      try {
        previous = JSON.parse(readFileSync(path, "utf8")) as {
          pid: number;
          token: string;
        };
      } catch {
        throw new HostedError(
          409,
          "hosted_lock_invalid",
          "The hosted lock is damaged; confirm the server is stopped before removing it.",
        );
      }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1)
        throw new HostedError(
          409,
          "hosted_lock_invalid",
          "The hosted lock is invalid.",
        );
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (probe) {
        if (probe instanceof Error && "code" in probe && probe.code === "ESRCH")
          alive = false;
      }
      if (alive || attempt > 0)
        throw new HostedError(
          409,
          "hosted_already_running",
          "Another server is already using this hosted data directory.",
        );
      // Only remove the same stale owner examined above; never another contender's lock.
      if (readFileSync(path, "utf8") !== JSON.stringify(previous))
        throw new HostedError(
          409,
          "hosted_already_running",
          "The hosted storage lock changed.",
        );
      unlinkSync(path);
    }
  }
  return () => {
    if (!existsSync(path)) return;
    try {
      if (readFileSync(path, "utf8") === serialized) unlinkSync(path);
    } catch {
      /* A changed owner is never removed. */
    }
  };
}
const now = () => new Date().toISOString();
const defaults: HostedLimits = {
  registrationEnabled: false,
  callsEnabled: false,
  globalConcurrency: 4,
  perUserConcurrency: 1,
  maxQueuedCalls: 40,
  maxRequestBytes: 4 * 1024 * 1024,
  perUserDailyMicros: 100_000_000,
  globalDailyMicros: 1_000_000_000,
  researchRetentionDays: 0,
  sessionDays: 7,
};
export interface ResearchFilter {
  modelOnly?: boolean;
  id?: string;
  userId?: string;
  operationId?: string;
  sessionId?: string;
  attemptId?: string;
  modelId?: string;
  purpose?: string;
  kind?: HostedResearchMetadata["kind"];
  beforeUtc?: string;
  afterUtc?: string;
  limit?: number;
  offset?: number;
}

function amount(value: number, signed = false): number {
  if (!Number.isSafeInteger(value) || (!signed && value < 0))
    throw new HostedError(
      400,
      "invalid_amount",
      "Amounts must be safe integer micros.",
    );
  return value;
}
function text(value: string, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new HostedError(400, "invalid_input", `Invalid ${label}.`);
  return value.trim();
}
export function normalizeUsername(username: string): string {
  const value = text(username, "username", 32).normalize("NFKC");
  if (!/^[\p{L}\p{N}_.-]{2,32}$/u.test(value))
    throw new HostedError(
      400,
      "invalid_username",
      "Username must contain 2–32 letters, numbers, dots, underscores or hyphens.",
    );
  return value;
}
function user(row: Row): HostedUser {
  return {
    id: String(row.id),
    username: String(row.username),
    role: row.role as HostedUser["role"],
    status: row.status as HostedUser["status"],
    mustChangePassword: Boolean(row.must_change_password),
    createdAtUtc: String(row.created_at),
    updatedAtUtc: String(row.updated_at),
    consentVersion: row.consent_version as string | null,
    consentAtUtc: row.consent_at as string | null,
  };
}
function session(row: Row): HostedSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    expiresAtUtc: String(row.expires_at),
    createdAtUtc: String(row.created_at),
    lastSeenAtUtc: String(row.last_seen_at),
  };
}
function invite(row: Row): HostedInvite {
  return {
    id: String(row.id),
    label: String(row.label),
    maxUses: Number(row.max_uses),
    uses: Number(row.uses),
    initialBalanceMicros: Number(row.initial_balance),
    expiresAtUtc: row.expires_at as string | null,
    revokedAtUtc: row.revoked_at as string | null,
    createdAtUtc: String(row.created_at),
  };
}
function attempt(row: Row): HostedAttempt {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    operationId: String(row.operation_id),
    parentOperationId: (row.parent_operation_id as string | null) ?? null,
    sessionId: (row.session_id as string | null) ?? null,
    purpose: String(row.purpose),
    status: row.status as HostedAttempt["status"],
    maximumCostMicros: Number(row.maximum_cost),
    costMicros: row.cost === null ? null : Number(row.cost),
    modelSnapshot: JSON.parse(String(row.model_json)) as HostedModelSnapshot,
    usage:
      row.usage_json === null
        ? null
        : (JSON.parse(row.usage_json as string) as HostedUsage),
    providerRequestId: row.provider_request_id as string | null,
    reason: row.reason as string | null,
    createdAtUtc: String(row.created_at),
    updatedAtUtc: String(row.updated_at),
  };
}
function research(row: Row): HostedResearchMetadata {
  return {
    id: String(row.id),
    attemptId: row.attempt_id as string | null,
    operationId: String(row.operation_id),
    sessionId: row.session_id as string | null,
    userId: String(row.user_id),
    kind: row.kind as HostedResearchMetadata["kind"],
    purpose: String(row.purpose),
    displayName: String(row.display_name),
    modelId: String(row.model_id),
    createdAtUtc: String(row.created_at),
    deletedAtUtc: row.deleted_at as string | null,
  };
}

export class HostedControlStore {
  readonly rootDirectory: string;
  readonly database!: BetterSqlite3.Database;
  readonly researchDatabase!: BetterSqlite3.Database;
  readonly crypto: HostedCrypto;
  private readonly releaseLock: () => void;
  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
    protectDirectory(this.rootDirectory);
    this.releaseLock = acquireLock(this.rootDirectory);
    try {
      if (
        (existsSync(join(this.rootDirectory, "control.sqlite")) ||
          existsSync(join(this.rootDirectory, "research.sqlite"))) &&
        !existsSync(join(this.rootDirectory, ".secrets", "master.key"))
      )
        throw new HostedError(
          500,
          "missing_master_key",
          "Restore the original master key before opening existing hosted data.",
        );
      this.crypto = new HostedCrypto(this.rootDirectory);
      this.database = this.open("control.sqlite");
      this.researchDatabase = this.open("research.sqlite");
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL,username_key TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('admin','user')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','banned')),must_change_password INTEGER NOT NULL DEFAULT 0,consent_version TEXT,consent_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,label TEXT NOT NULL,max_uses INTEGER NOT NULL CHECK(max_uses>0),uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0 AND uses<=max_uses),initial_balance INTEGER NOT NULL CHECK(initial_balance>=0),expires_at TEXT,revoked_at TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invite_redemptions(invite_id TEXT NOT NULL REFERENCES invites(id),user_id TEXT NOT NULL UNIQUE REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(invite_id,user_id));
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS wallets(user_id TEXT PRIMARY KEY REFERENCES users(id),balance INTEGER NOT NULL CHECK(balance>=0),reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0));
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),attempt_id TEXT,delta INTEGER NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT,created_at TEXT NOT NULL,UNIQUE(attempt_id,kind));
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),operation_id TEXT NOT NULL,purpose TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('reserved','sent','settled','released','unknown')),maximum_cost INTEGER NOT NULL CHECK(maximum_cost>=0),cost INTEGER,model_json TEXT NOT NULL,usage_json TEXT,provider_request_id TEXT,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_user_created ON attempts(user_id,created_at);
      CREATE INDEX IF NOT EXISTS attempts_operation ON attempts(user_id,operation_id);
      CREATE TABLE IF NOT EXISTS image_attempt_assets(attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),asset_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_routes(route_id TEXT PRIMARY KEY,current_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS model_versions(route_id TEXT NOT NULL REFERENCES model_routes(route_id),revision INTEGER NOT NULL,snapshot_json TEXT NOT NULL,credential_encrypted TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(route_id,revision));
      CREATE TABLE IF NOT EXISTS purpose_defaults(purpose TEXT PRIMARY KEY,route_id TEXT NOT NULL REFERENCES model_routes(route_id));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT,details_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),method TEXT NOT NULL,path TEXT NOT NULL,input_hash TEXT NOT NULL,session_id TEXT,client_message_id TEXT,status TEXT NOT NULL,status_code INTEGER,response_encrypted TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,id));
      CREATE INDEX IF NOT EXISTS operations_message ON operations(user_id,client_message_id);
      CREATE TABLE IF NOT EXISTS auth_failures(subject TEXT PRIMARY KEY,failures INTEGER NOT NULL,blocked_until TEXT,updated_at TEXT NOT NULL);
    `);
      this.researchDatabase.exec(
        `CREATE TABLE IF NOT EXISTS research_records(id TEXT PRIMARY KEY,attempt_id TEXT,operation_id TEXT NOT NULL,session_id TEXT,user_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('request','response','input','output','image')),purpose TEXT NOT NULL,display_name TEXT NOT NULL,model_id TEXT NOT NULL,payload_encrypted TEXT,created_at TEXT NOT NULL,deleted_at TEXT); CREATE UNIQUE INDEX IF NOT EXISTS research_attempt_kind ON research_records(attempt_id,kind) WHERE attempt_id IS NOT NULL; CREATE INDEX IF NOT EXISTS research_user_created ON research_records(user_id,created_at);`,
      );
      const columns = new Set(
        (
          this.database.pragma("table_info(attempts)") as { name: string }[]
        ).map((column) => column.name),
      );
      if (!columns.has("session_id"))
        this.database.exec("ALTER TABLE attempts ADD COLUMN session_id TEXT");
      if (!columns.has("parent_operation_id"))
        this.database.exec(
          "ALTER TABLE attempts ADD COLUMN parent_operation_id TEXT",
        );
      this.database.exec(
        "CREATE INDEX IF NOT EXISTS attempts_parent_operation ON attempts(user_id,parent_operation_id)",
      );
      const researchColumns = new Set(
        (
          this.researchDatabase.pragma("table_info(research_records)") as {
            name: string;
          }[]
        ).map((column) => column.name),
      );
      if (!researchColumns.has("payload_hash"))
        this.researchDatabase.exec(
          "ALTER TABLE research_records ADD COLUMN payload_hash TEXT",
        );
      const researchDefinition = this.researchDatabase
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='research_records'",
        )
        .get() as { sql: string };
      if (!researchDefinition.sql.includes("'image'")) {
        this.researchDatabase
          .transaction(() => {
            this.researchDatabase.exec(
              "CREATE TABLE research_records_expanded(id TEXT PRIMARY KEY,attempt_id TEXT,operation_id TEXT NOT NULL,session_id TEXT,user_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('request','response','input','output','image')),purpose TEXT NOT NULL,display_name TEXT NOT NULL,model_id TEXT NOT NULL,payload_encrypted TEXT,created_at TEXT NOT NULL,deleted_at TEXT,payload_hash TEXT); INSERT INTO research_records_expanded SELECT id,attempt_id,operation_id,session_id,user_id,kind,purpose,display_name,model_id,payload_encrypted,created_at,deleted_at,payload_hash FROM research_records; DROP TABLE research_records; ALTER TABLE research_records_expanded RENAME TO research_records;",
            );
          })
          .immediate();
      }
      this.researchDatabase.exec(
        "DROP INDEX IF EXISTS research_conversation_kind; CREATE UNIQUE INDEX IF NOT EXISTS research_attempt_kind ON research_records(attempt_id,kind) WHERE attempt_id IS NOT NULL; CREATE INDEX IF NOT EXISTS research_user_created ON research_records(user_id,created_at); CREATE UNIQUE INDEX IF NOT EXISTS research_conversation_input ON research_records(user_id,operation_id,kind) WHERE kind='input'; CREATE UNIQUE INDEX IF NOT EXISTS research_conversation_output ON research_records(user_id,operation_id,kind,payload_hash) WHERE kind='output';",
      );
    } catch (error) {
      this.researchDatabase?.close();
      this.database?.close();
      this.releaseLock();
      throw error;
    }
  }
  private open(name: string): BetterSqlite3.Database {
    const db = new BetterSqlite3(join(this.rootDirectory, name));
    db.pragma("foreign_keys=ON");
    db.pragma("journal_mode=WAL");
    db.pragma("synchronous=FULL");
    db.pragma("busy_timeout=5000");
    return db;
  }
  close(): void {
    if (this.researchDatabase.open) this.researchDatabase.close();
    if (this.database.open) this.database.close();
    this.releaseLock();
  }
  hasAdmin(): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1")
        .get(),
    );
  }
  storageStats(): {
    controlBytes: number;
    controlWalBytes: number;
    researchBytes: number;
    researchWalBytes: number;
    diskAvailableBytes: number | null;
  } {
    const bytes = (name: string) => {
      const path = join(this.rootDirectory, name);
      return existsSync(path) ? statSync(path).size : 0;
    };
    let diskAvailableBytes: number | null = null;
    try {
      const stat = statfsSync(this.rootDirectory);
      const available = stat.bavail * stat.bsize;
      if (Number.isSafeInteger(available)) diskAvailableBytes = available;
    } catch {
      /* Some virtual filesystems do not expose disk capacity. */
    }
    return {
      controlBytes: bytes("control.sqlite"),
      controlWalBytes: bytes("control.sqlite-wal"),
      researchBytes: bytes("research.sqlite"),
      researchWalBytes: bytes("research.sqlite-wal"),
      diskAvailableBytes,
    };
  }
  overviewStats(): {
    users: number;
    activeUsers: number;
    bannedUsers: number;
    totalBalanceMicros: number;
    totalHeldMicros: number;
    chargedMicros: number;
    requestCount: number;
    pendingReconciliations: number;
  } {
    const accounts = this.database
      .prepare(
        "SELECT COUNT(*) AS users,COALESCE(SUM(status='active'),0) AS activeUsers,COALESCE(SUM(status='banned'),0) AS bannedUsers FROM users",
      )
      .get() as Row;
    const wallets = this.database
      .prepare(
        "SELECT COALESCE(SUM(balance),0) AS totalBalanceMicros,COALESCE(SUM(reserved),0) AS totalHeldMicros FROM wallets",
      )
      .get() as Row;
    const attempts = this.database
      .prepare(
        "SELECT COUNT(*) AS requestCount,COALESCE(SUM(CASE WHEN status='settled' THEN cost ELSE 0 END),0) AS chargedMicros,COALESCE(SUM(status='unknown'),0) AS pendingReconciliations FROM attempts",
      )
      .get() as Row;
    return {
      users: Number(accounts.users),
      activeUsers: Number(accounts.activeUsers),
      bannedUsers: Number(accounts.bannedUsers),
      totalBalanceMicros: Number(wallets.totalBalanceMicros),
      totalHeldMicros: Number(wallets.totalHeldMicros),
      chargedMicros: Number(attempts.chargedMicros),
      requestCount: Number(attempts.requestCount),
      pendingReconciliations: Number(attempts.pendingReconciliations),
    };
  }

  getUser(id: string): HostedUser | undefined {
    const row = this.database
      .prepare("SELECT * FROM users WHERE id=?")
      .get(id) as Row | undefined;
    return row ? user(row) : undefined;
  }
  listUsers(
    filter: {
      search?: string;
      status?: HostedUser["status"];
      limit?: number;
      offset?: number;
    } = {},
  ): HostedUser[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.search) {
      clauses.push("(instr(lower(username),lower(?))>0 OR id=?)");
      values.push(filter.search, filter.search);
    }
    if (filter.status) {
      clauses.push("status=?");
      values.push(filter.status);
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM users ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at,id LIMIT ? OFFSET ?`,
        )
        .all(
          ...values,
          Math.min(500, Math.max(1, filter.limit ?? 100)),
          Math.max(0, filter.offset ?? 0),
        ) as Row[]
    ).map(user);
  }
  assertActiveUser(id: string): HostedUser {
    const value = this.getUser(id);
    if (!value || value.status !== "active")
      throw new HostedError(
        403,
        "account_unavailable",
        "This account is unavailable.",
      );
    return value;
  }
  passwordRecord(
    username: string,
  ): { user: HostedUser; passwordHash: string } | undefined {
    const row = this.database
      .prepare("SELECT * FROM users WHERE username_key=?")
      .get(normalizeUsername(username).toLocaleLowerCase("en-US")) as
      Row | undefined;
    return row
      ? { user: user(row), passwordHash: String(row.password_hash) }
      : undefined;
  }
  createAdministrator(username: string, passwordHash: string): HostedUser {
    return this.database
      .transaction(() => {
        if (
          this.database.prepare("SELECT 1 FROM users WHERE role='admin'").get()
        )
          throw new HostedError(
            409,
            "admin_already_initialized",
            "The administrator is already initialized.",
          );
        const value = this.insertUser(username, passwordHash, "admin", null);
        this.audit(value.id, "admin.bootstrap", value.id);
        return value;
      })
      .immediate();
  }
  /** Cheap preflight before password hashing; registration rechecks in its transaction. */
  assertRegistrationAllowed(inviteCode: string): void {
    this.registrationInvite(inviteCode);
  }
  private registrationInvite(inviteCode: string): Row {
    if (!this.limits().registrationEnabled)
      throw new HostedError(
        403,
        "registration_disabled",
        "Registration is disabled.",
      );
    const row = this.database
      .prepare(
        "SELECT * FROM invites WHERE token_hash=? AND revoked_at IS NULL AND uses<max_uses AND (expires_at IS NULL OR expires_at>?)",
      )
      .get(hashOpaqueToken(inviteCode.trim()), now()) as Row | undefined;
    if (!row)
      throw new HostedError(
        400,
        "invalid_invite",
        "The invitation is invalid, expired or already used.",
      );
    return row;
  }
  registerUser(input: {
    username: string;
    passwordHash: string;
    inviteCode: string;
    consentVersion?: string | null;
  }): HostedUser {
    return this.database
      .transaction(() => {
        const row = this.registrationInvite(input.inviteCode);
        const value = this.insertUser(
          input.username,
          input.passwordHash,
          "user",
          input.consentVersion == null
            ? null
            : text(input.consentVersion, "consent version", 100),
        );
        this.database
          .prepare("UPDATE invites SET uses=uses+1 WHERE id=?")
          .run(row.id);
        this.database
          .prepare("INSERT INTO invite_redemptions VALUES(?,?,?)")
          .run(row.id, value.id, now());
        this.credit(
          value.id,
          Number(row.initial_balance),
          "invite_credit",
          "Invitation starting balance",
          null,
        );
        return value;
      })
      .immediate();
  }
  private insertUser(
    username: string,
    passwordHash: string,
    role: HostedUser["role"],
    consentVersion: string | null,
  ): HostedUser {
    username = normalizeUsername(username);
    const timestamp = now();
    const id = randomUUID();
    if (
      this.database
        .prepare("SELECT 1 FROM users WHERE username_key=?")
        .get(username.toLocaleLowerCase("en-US"))
    )
      throw new HostedError(
        409,
        "username_unavailable",
        "This username is unavailable.",
      );
    this.database
      .prepare(
        "INSERT INTO users(id,username,username_key,password_hash,role,consent_version,consent_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        username,
        username.toLocaleLowerCase("en-US"),
        passwordHash,
        role,
        consentVersion,
        consentVersion ? timestamp : null,
        timestamp,
        timestamp,
      );
    this.database
      .prepare("INSERT INTO wallets(user_id,balance,reserved) VALUES(?,0,0)")
      .run(id);
    return this.getUser(id)!;
  }
  setPasswordHash(
    userId: string,
    passwordHash: string,
    mustChangePassword: boolean,
    actorId: string,
    expectedPasswordHash?: string,
  ): void {
    this.database
      .transaction(() => {
        this.assertExists(userId);
        this.assertPasswordUnchanged(userId, expectedPasswordHash);
        this.database
          .prepare(
            "UPDATE users SET password_hash=?,must_change_password=?,updated_at=? WHERE id=?",
          )
          .run(passwordHash, Number(mustChangePassword), now(), userId);
        this.revokeUserSessions(userId);
        this.audit(
          actorId,
          mustChangePassword ? "user.password_reset" : "user.password_change",
          userId,
        );
      })
      .immediate();
  }
  banUser(
    id: string,
    banned: boolean,
    actorId: string,
    reason = "Administrator action",
  ): HostedUser {
    return this.database
      .transaction(() => {
        const target = this.assertExists(id);
        if (target.role === "admin" && banned)
          throw new HostedError(
            400,
            "cannot_ban_admin",
            "Administrator accounts cannot be banned.",
          );
        this.database
          .prepare("UPDATE users SET status=?,updated_at=? WHERE id=?")
          .run(banned ? "banned" : "active", now(), id);
        if (banned) this.revokeUserSessions(id);
        this.audit(actorId, banned ? "user.ban" : "user.unban", id, {
          reason: text(reason, "reason", 2000),
        });
        return this.getUser(id)!;
      })
      .immediate();
  }
  private assertExists(id: string): HostedUser {
    const value = this.getUser(id);
    if (!value)
      throw new HostedError(404, "user_not_found", "Account not found.");
    return value;
  }

  createInvite(
    input: {
      label?: string;
      maxUses?: number;
      initialBalanceMicros?: number;
      expiresAtUtc?: string | null;
    },
    actorId: string,
  ): { invite: HostedInvite; code: string } {
    const id = randomUUID();
    const code = randomOpaqueToken();
    const uses = input.maxUses ?? 1;
    if (!Number.isSafeInteger(uses) || uses < 1 || uses > 10000)
      throw new HostedError(
        400,
        "invalid_invite_limit",
        "Invalid invitation usage limit.",
      );
    const expiry = input.expiresAtUtc
      ? new Date(input.expiresAtUtc).toISOString()
      : null;
    this.database
      .prepare(
        "INSERT INTO invites(id,token_hash,label,max_uses,initial_balance,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        hashOpaqueToken(code),
        input.label?.trim().slice(0, 200) ?? "",
        uses,
        amount(input.initialBalanceMicros ?? 0),
        expiry,
        now(),
      );
    this.audit(actorId, "invite.create", id, { maxUses: uses });
    return { invite: this.listInvites().find((item) => item.id === id)!, code };
  }
  listInvites(): HostedInvite[] {
    return (
      this.database
        .prepare("SELECT * FROM invites ORDER BY created_at DESC,id")
        .all() as Row[]
    ).map(invite);
  }
  revokeInvite(id: string, actorId: string): void {
    this.database
      .prepare("UPDATE invites SET revoked_at=? WHERE id=?")
      .run(now(), id);
    this.audit(actorId, "invite.revoke", id);
  }
  createSession(
    userId: string,
    expectedPasswordHash?: string,
  ): { session: HostedSession; token: string } {
    this.assertActiveUser(userId);
    this.assertPasswordUnchanged(userId, expectedPasswordHash);
    const id = randomUUID();
    const token = randomOpaqueToken();
    const timestamp = now();
    const expires = new Date(
      Date.now() + this.limits().sessionDays * 86400000,
    ).toISOString();
    this.database
      .prepare(
        "INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, userId, hashOpaqueToken(token), expires, timestamp, timestamp);
    return {
      session: {
        id,
        userId,
        expiresAtUtc: expires,
        createdAtUtc: timestamp,
        lastSeenAtUtc: timestamp,
      },
      token,
    };
  }
  authenticateSession(
    token: string,
  ): { user: HostedUser; session: HostedSession } | undefined {
    if (typeof token !== "string" || token.length < 32 || token.length > 200)
      return undefined;
    const row = this.database
      .prepare(
        "SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
      )
      .get(hashOpaqueToken(token), now()) as Row | undefined;
    if (!row) return undefined;
    const account = this.getUser(String(row.user_id));
    if (!account || account.status !== "active") return undefined;
    this.database
      .prepare("UPDATE sessions SET last_seen_at=? WHERE id=?")
      .run(now(), row.id);
    return { user: account, session: session(row) };
  }
  revokeSession(token: string): void {
    this.database
      .prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=?")
      .run(now(), hashOpaqueToken(token));
  }
  private assertPasswordUnchanged(
    userId: string,
    expectedPasswordHash?: string,
  ): void {
    if (expectedPasswordHash === undefined) return;
    const row = this.database
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(userId) as Row | undefined;
    if (row?.password_hash !== expectedPasswordHash)
      throw new HostedError(
        401,
        "credentials_changed",
        "Account credentials changed; sign in again.",
      );
  }
  revokeUserSessions(userId: string): void {
    this.database
      .prepare(
        "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
      )
      .run(now(), userId);
  }
  loginBlocked(subject: string): boolean {
    return this.loginRetryAfterSeconds(subject) > 0;
  }
  loginRetryAfterSeconds(subject: string): number {
    const row = this.database
      .prepare("SELECT blocked_until FROM auth_failures WHERE subject=?")
      .get(hashOpaqueToken(subject)) as Row | undefined;
    if (typeof row?.blocked_until !== "string") return 0;
    const remaining = Date.parse(row.blocked_until) - Date.now();
    return Number.isFinite(remaining)
      ? Math.max(0, Math.ceil(remaining / 1000))
      : 0;
  }
  recordLoginFailure(subject: string): void {
    const key = hashOpaqueToken(subject);
    this.database
      .transaction(() => {
        const row = this.database
          .prepare(
            "SELECT failures,updated_at FROM auth_failures WHERE subject=?",
          )
          .get(key) as Row | undefined;
        const failures =
          row && Date.now() - Date.parse(String(row.updated_at)) < 15 * 60000
            ? Number(row.failures) + 1
            : 1;
        this.database
          .prepare(
            "INSERT INTO auth_failures VALUES(?,?,?,?) ON CONFLICT(subject) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at",
          )
          .run(
            key,
            failures,
            failures >= 5
              ? new Date(Date.now() + 15 * 60000).toISOString()
              : null,
            now(),
          );
      })
      .immediate();
  }
  clearLoginFailures(subject: string): void {
    this.database
      .prepare("DELETE FROM auth_failures WHERE subject=?")
      .run(hashOpaqueToken(subject));
  }

  wallet(userId: string): HostedWallet {
    const row = this.database
      .prepare("SELECT balance,reserved FROM wallets WHERE user_id=?")
      .get(userId) as Row | undefined;
    if (!row)
      throw new HostedError(404, "wallet_not_found", "Wallet not found.");
    return {
      userId,
      balanceMicros: Number(row.balance),
      reservedMicros: Number(row.reserved),
      availableMicros: Number(row.balance) - Number(row.reserved),
    };
  }
  adjustBalance(
    userId: string,
    deltaMicros: number,
    actorId: string,
    reason: string,
  ): HostedWallet {
    return this.database
      .transaction(() => {
        this.credit(
          userId,
          amount(deltaMicros, true),
          "admin_adjustment",
          text(reason, "reason", 2000),
          actorId,
        );
        this.audit(actorId, "wallet.adjust", userId, { deltaMicros, reason });
        return this.wallet(userId);
      })
      .immediate();
  }
  private credit(
    userId: string,
    delta: number,
    kind: string,
    reason: string,
    actorId: string | null,
  ): void {
    const wallet = this.wallet(userId);
    const balance = amount(wallet.balanceMicros + delta);
    if (balance < wallet.reservedMicros)
      throw new HostedError(
        409,
        "balance_reserved",
        "Adjustment would consume reserved funds.",
      );
    this.database
      .prepare("UPDATE wallets SET balance=? WHERE user_id=?")
      .run(balance, userId);
    this.database
      .prepare("INSERT INTO ledger VALUES(?,?,NULL,?,?,?,?,?)")
      .run(randomUUID(), userId, delta, kind, reason, actorId, now());
  }
  listLedger(userId?: string, limit = 100): Row[] {
    return this.database
      .prepare(
        `SELECT id,user_id AS userId,attempt_id AS attemptId,delta AS deltaMicros,kind,reason,actor_id AS actorId,created_at AS createdAtUtc FROM ledger ${userId ? "WHERE user_id=?" : ""} ORDER BY created_at DESC,id LIMIT ?`,
      )
      .all(
        ...(userId ? [userId] : []),
        Math.min(1000, Math.max(1, limit)),
      ) as Row[];
  }
  reserve(input: HostedReservationInput): HostedAttempt {
    amount(input.maximumCostMicros);
    text(input.id, "attempt ID");
    return this.database
      .transaction(() => {
        this.assertActiveUser(input.userId);
        const previous = this.findAttempt(input.id);
        if (previous) {
          if (
            previous.userId !== input.userId ||
            previous.operationId !== (input.operationId ?? input.id) ||
            previous.purpose !== input.purpose ||
            JSON.stringify(previous.modelSnapshot) !==
              JSON.stringify(input.modelSnapshot)
          )
            throw new HostedError(
              409,
              "attempt_id_conflict",
              "Attempt identifier belongs to another request.",
            );
          return previous;
        }
        const limits = this.limits();
        if (!limits.callsEnabled)
          throw new HostedError(
            503,
            "calls_disabled",
            "Model requests are temporarily paused.",
          );
        assertHostedModelPricing(input.modelSnapshot);
        if (!input.modelSnapshot.enabled)
          throw new HostedError(
            403,
            "model_disabled",
            "This model is disabled.",
          );
        const wallet = this.wallet(input.userId);
        if (wallet.availableMicros < input.maximumCostMicros)
          throw new HostedError(
            402,
            "insufficient_balance",
            "Insufficient available balance.",
          );
        const day = now().slice(0, 10);
        const daily = (userId?: string) =>
          Number(
            (
              this.database
                .prepare(
                  `SELECT COALESCE(SUM(CASE WHEN status='settled' THEN cost WHEN status IN('reserved','sent','unknown') THEN maximum_cost ELSE 0 END),0) AS total FROM attempts WHERE created_at>=? ${userId ? "AND user_id=?" : ""}`,
                )
                .get(...(userId ? [day, userId] : [day])) as Row
            ).total,
          );
        if (
          daily(input.userId) + input.maximumCostMicros >
            limits.perUserDailyMicros ||
          daily() + input.maximumCostMicros > limits.globalDailyMicros
        )
          throw new HostedError(
            429,
            "daily_budget_exceeded",
            "The daily spending limit has been reached.",
          );
        const timestamp = now();
        this.database
          .prepare("UPDATE wallets SET reserved=reserved+? WHERE user_id=?")
          .run(input.maximumCostMicros, input.userId);
        this.database
          .prepare(
            "INSERT INTO attempts(id,user_id,operation_id,purpose,status,maximum_cost,model_json,created_at,updated_at,session_id,parent_operation_id) VALUES(?,?,?,?,'reserved',?,?,?,?,?,?)",
          )
          .run(
            input.id,
            input.userId,
            input.operationId ?? input.id,
            input.purpose,
            input.maximumCostMicros,
            JSON.stringify(input.modelSnapshot),
            timestamp,
            timestamp,
            input.sessionId ?? null,
            input.parentOperationId ?? null,
          );
        return this.findAttempt(input.id)!;
      })
      .immediate();
  }
  findAttempt(id: string): HostedAttempt | undefined {
    const row = this.database
      .prepare("SELECT * FROM attempts WHERE id=?")
      .get(id) as Row | undefined;
    return row ? attempt(row) : undefined;
  }
  recordAttemptAsset(
    id: string,
    asset: {
      storageKey: string;
      thumbnailStorageKey?: string;
      sha256: string;
      width?: number;
      height?: number;
      mimeType?: string;
    },
  ): void {
    this.requireAttempt(id);
    const previous = this.readAttemptAsset(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(asset))
      throw new HostedError(
        409,
        "attempt_asset_conflict",
        "This attempt is already linked to another asset.",
      );
    this.database
      .prepare("INSERT OR IGNORE INTO image_attempt_assets VALUES(?,?,?)")
      .run(id, JSON.stringify(asset), now());
  }
  readAttemptAsset(id: string):
    | {
        storageKey: string;
        thumbnailStorageKey?: string;
        sha256: string;
        width?: number;
        height?: number;
        mimeType?: string;
      }
    | undefined {
    const row = this.database
      .prepare("SELECT asset_json FROM image_attempt_assets WHERE attempt_id=?")
      .get(id) as Row | undefined;
    return row
      ? (JSON.parse(String(row.asset_json)) as {
          storageKey: string;
          thumbnailStorageKey?: string;
          sha256: string;
          width?: number;
          height?: number;
          mimeType?: string;
        })
      : undefined;
  }
  listAttempts(
    filter: {
      userId?: string;
      operationId?: string;
      status?: HostedAttempt["status"];
      limit?: number;
    } = {},
  ): HostedAttempt[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [
      ["user_id", filter.userId],
      ["status", filter.status],
    ])
      if (value) {
        clauses.push(`${column}=?`);
        values.push(value);
      }
    if (filter.operationId) {
      clauses.push("(operation_id=? OR parent_operation_id=?)");
      values.push(filter.operationId, filter.operationId);
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM attempts ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC,id LIMIT ?`,
        )
        .all(...values, Math.min(1000, filter.limit ?? 100)) as Row[]
    ).map(attempt);
  }
  listAttemptsForOperations(
    userId: string,
    operationIds: readonly string[],
  ): HostedAttempt[] {
    if (operationIds.length === 0) return [];
    const ids = JSON.stringify(operationIds);
    return (
      this.database
        .prepare(
          `SELECT * FROM attempts
           WHERE user_id=? AND (
             operation_id IN (SELECT value FROM json_each(?)) OR
             parent_operation_id IN (SELECT value FROM json_each(?))
           ) ORDER BY created_at,id`,
        )
        .all(userId, ids, ids) as Row[]
    ).map(attempt);
  }
  markAttemptSent(
    id: string,
    metadata?: { providerRequestId?: string },
  ): HostedAttempt {
    return this.database
      .transaction(() => {
        const item = this.requireAttempt(id);
        this.assertActiveUser(item.userId);
        if (!this.limits().callsEnabled)
          throw new HostedError(
            503,
            "calls_disabled",
            "Model requests are paused.",
          );
        if (item.status !== "reserved")
          throw new HostedError(
            409,
            "attempt_already_sent",
            "This attempt cannot be sent again.",
          );
        this.database
          .prepare(
            "UPDATE attempts SET status='sent',provider_request_id=?,updated_at=? WHERE id=?",
          )
          .run(metadata?.providerRequestId ?? null, now(), id);
        return this.requireAttempt(id);
      })
      .immediate();
  }
  settle(input: {
    id: string;
    costMicros: number;
    usage?: HostedUsage;
    providerRequestId?: string;
    reason?: string;
  }): HostedAttempt {
    return this.database
      .transaction(() => this.settleInside(input, false))
      .immediate();
  }
  private settleInside(
    input: {
      id: string;
      costMicros: number;
      usage?: HostedUsage;
      providerRequestId?: string;
      reason?: string;
    },
    reconcile: boolean,
  ): HostedAttempt {
    amount(input.costMicros);
    const item = this.requireAttempt(input.id);
    if (item.status === "settled") {
      if (item.costMicros !== input.costMicros)
        throw new HostedError(
          409,
          "settlement_conflict",
          "This attempt already has a different settlement.",
        );
      return item;
    }
    if (
      !(["sent", "unknown"] as string[]).includes(item.status) &&
      !(reconcile && item.status === "reserved")
    )
      throw new HostedError(
        409,
        "invalid_settlement_state",
        "This attempt cannot be settled.",
      );
    const wallet = this.wallet(item.userId);
    if (input.costMicros > item.maximumCostMicros && !reconcile) {
      this.database
        .prepare(
          "UPDATE attempts SET status='unknown',reason='cost_exceeds_reservation',updated_at=? WHERE id=?",
        )
        .run(now(), item.id);
      return this.requireAttempt(item.id);
    }
    if (
      input.costMicros >
      wallet.balanceMicros - (wallet.reservedMicros - item.maximumCostMicros)
    )
      throw new HostedError(
        409,
        "reconciliation_balance_required",
        "Add sufficient funds before reconciling this charge.",
      );
    this.database
      .prepare(
        "UPDATE wallets SET balance=balance-?,reserved=reserved-? WHERE user_id=?",
      )
      .run(input.costMicros, item.maximumCostMicros, item.userId);
    this.database
      .prepare(
        "UPDATE attempts SET status='settled',cost=?,usage_json=?,provider_request_id=COALESCE(?,provider_request_id),reason=?,updated_at=? WHERE id=?",
      )
      .run(
        input.costMicros,
        input.usage ? JSON.stringify(input.usage) : null,
        input.providerRequestId ?? null,
        input.reason ?? null,
        now(),
        item.id,
      );
    this.database
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,? ,?,NULL,?)")
      .run(
        randomUUID(),
        item.userId,
        item.id,
        -input.costMicros,
        "llm_charge",
        input.reason ?? item.purpose,
        now(),
      );
    return this.requireAttempt(item.id);
  }
  release(id: string, reason: string): HostedAttempt {
    return this.database
      .transaction(() => {
        const item = this.requireAttempt(id);
        if (item.status === "released") return item;
        if (item.status !== "reserved")
          throw new HostedError(
            409,
            "sent_attempt_cannot_release",
            "A sent or uncertain attempt requires reconciliation.",
          );
        this.database
          .prepare("UPDATE wallets SET reserved=reserved-? WHERE user_id=?")
          .run(item.maximumCostMicros, item.userId);
        this.database
          .prepare(
            "UPDATE attempts SET status='released',reason=?,updated_at=? WHERE id=?",
          )
          .run(reason, now(), id);
        return this.requireAttempt(id);
      })
      .immediate();
  }
  markUnknown(id: string, reason: string): HostedAttempt {
    const item = this.requireAttempt(id);
    if (item.status === "settled" || item.status === "released") return item;
    this.database
      .prepare(
        "UPDATE attempts SET status='unknown',reason=?,updated_at=? WHERE id=?",
      )
      .run(reason, now(), id);
    return this.requireAttempt(id);
  }
  reconcile(input: {
    id: string;
    costMicros: number;
    actorId: string;
    reason: string;
  }): HostedAttempt {
    return this.database
      .transaction(() => {
        text(input.reason, "reconciliation reason", 2000);
        const value = this.settleInside(input, true);
        this.audit(input.actorId, "attempt.reconcile", input.id, {
          costMicros: input.costMicros,
          reason: input.reason,
        });
        return value;
      })
      .immediate();
  }
  private requireAttempt(id: string): HostedAttempt {
    const value = this.findAttempt(id);
    if (!value)
      throw new HostedError(
        404,
        "attempt_not_found",
        "Model attempt not found.",
      );
    return value;
  }
  recoverInterruptedAttempts(): number {
    const timestamp = now();
    return this.database
      .prepare(
        "UPDATE attempts SET status='unknown',reason='server_interrupted',updated_at=? WHERE status='sent'",
      )
      .run(timestamp).changes;
  }

  upsertModel(input: HostedModelInput, actorId: string): HostedModelSnapshot {
    return this.database
      .transaction(() => {
        const routeId = text(input.routeId, "route ID", 100);
        const previous = this.database
          .prepare("SELECT current_revision FROM model_routes WHERE route_id=?")
          .get(routeId) as Row | undefined;
        const revision = previous ? Number(previous.current_revision) + 1 : 1;
        const url = new URL(input.baseUrl);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          throw new HostedError(
            400,
            "invalid_provider_url",
            "Hosted providers require an HTTPS URL without credentials or query parameters.",
          );
        if (
          !["text", "image"].includes(input.kind) ||
          !["openai-compatible", "anthropic", "gemini"].includes(input.protocol)
        )
          throw new HostedError(
            400,
            "invalid_model",
            "Invalid model type or protocol.",
          );
        const snapshot: HostedModelSnapshot = {
          routeId,
          revision,
          displayName: text(input.displayName, "display name", 100),
          kind: input.kind,
          protocol: input.protocol,
          baseUrl: url.toString().replace(/\/$/u, ""),
          modelId: text(input.modelId, "model ID", 200),
          inputMicrosPerMillion: amount(input.inputMicrosPerMillion),
          outputMicrosPerMillion: amount(input.outputMicrosPerMillion),
          cacheReadMicrosPerMillion: amount(input.cacheReadMicrosPerMillion),
          maxOutputTokens: amount(input.maxOutputTokens),
          ...(input.maxContextTokens === undefined
            ? {}
            : { maxContextTokens: amount(input.maxContextTokens) }),
          enabled: Boolean(input.enabled),
          ...(input.cacheWriteMicrosPerMillion === undefined
            ? {}
            : {
                cacheWriteMicrosPerMillion: amount(
                  input.cacheWriteMicrosPerMillion,
                ),
              }),
          ...(input.imagePointsMicros === undefined
            ? {}
            : { imagePointsMicros: amount(input.imagePointsMicros) }),
          ...(input.imageSpecification === undefined
            ? {}
            : {
                imageSpecification: text(
                  input.imageSpecification,
                  "image specification",
                  200,
                ),
              }),
        };
        if (
          snapshot.maxOutputTokens < 1 ||
          snapshot.maxOutputTokens > 1_000_000
        )
          throw new HostedError(
            400,
            "invalid_output_limit",
            "Invalid maximum output token limit.",
          );
        // Preserve user-entered prices as a disabled draft until all mandatory
        // prices are valid. Never invent prices or rewrite historical versions.
        if (!hostedModelPricingReady(snapshot)) snapshot.enabled = false;
        if (
          snapshot.maxContextTokens !== undefined &&
          snapshot.maxContextTokens <= snapshot.maxOutputTokens
        )
          throw new HostedError(
            400,
            "invalid_context_limit",
            "The context token limit must exceed the output token limit.",
          );
        const apiKey =
          input.apiKey?.trim() ||
          (previous ? this.resolveModel(routeId).apiKey : "");
        if (!apiKey)
          throw new HostedError(
            400,
            "provider_key_required",
            "A provider key is required.",
          );
        this.database
          .prepare(
            "INSERT INTO model_routes VALUES(?,?) ON CONFLICT(route_id) DO UPDATE SET current_revision=excluded.current_revision",
          )
          .run(routeId, revision);
        this.database
          .prepare("INSERT INTO model_versions VALUES(?,?,?,?,?)")
          .run(
            routeId,
            revision,
            JSON.stringify(snapshot),
            this.crypto.seal(apiKey, `model:${routeId}:${revision}`),
            now(),
          );
        this.audit(actorId, "model.update", routeId, {
          revision,
          displayName: snapshot.displayName,
        });
        return snapshot;
      })
      .immediate();
  }
  listModels(): HostedModelSnapshot[] {
    return (
      this.database
        .prepare(
          "SELECT v.snapshot_json FROM model_routes r JOIN model_versions v ON v.route_id=r.route_id AND v.revision=r.current_revision ORDER BY r.route_id",
        )
        .all() as Row[]
    ).map(
      (row) => JSON.parse(String(row.snapshot_json)) as HostedModelSnapshot,
    );
  }
  modelHasKey(routeId: string): boolean {
    const row = this.database
      .prepare(
        "SELECT length(v.credential_encrypted)>0 AS present FROM model_versions v JOIN model_routes r ON r.route_id=v.route_id AND r.current_revision=v.revision WHERE r.route_id=?",
      )
      .get(routeId) as Row | undefined;
    return Boolean(row?.present);
  }
  resolveModel(routeId: string, revision?: number): HostedResolvedModel {
    const row = this.database
      .prepare(
        `SELECT v.* FROM model_versions v JOIN model_routes r ON r.route_id=v.route_id WHERE v.route_id=? AND v.revision=${revision === undefined ? "r.current_revision" : "?"}`,
      )
      .get(...(revision === undefined ? [routeId] : [routeId, revision])) as
      Row | undefined;
    if (!row)
      throw new HostedError(404, "model_not_found", "Model route not found.");
    return {
      ...(JSON.parse(String(row.snapshot_json)) as HostedModelSnapshot),
      apiKey: this.crypto.open<string>(
        String(row.credential_encrypted),
        `model:${routeId}:${Number(row.revision)}`,
      ),
    };
  }
  setPurposeDefault(purpose: string, routeId: string, actorId: string): void {
    this.resolveModel(routeId);
    this.database
      .prepare(
        "INSERT INTO purpose_defaults VALUES(?,?) ON CONFLICT(purpose) DO UPDATE SET route_id=excluded.route_id",
      )
      .run(text(purpose, "purpose", 100), routeId);
    this.audit(actorId, "purpose.set", purpose, { routeId });
  }
  purposeDefaults(): Record<string, string> {
    return Object.fromEntries(
      (
        this.database
          .prepare("SELECT * FROM purpose_defaults ORDER BY purpose")
          .all() as Row[]
      ).map((row) => [String(row.purpose), String(row.route_id)]),
    );
  }
  replacePurposeDefaults(
    mappings: Record<string, string>,
    actorId: string,
  ): Record<string, string> {
    return this.database
      .transaction(() => {
        for (const [purpose, routeId] of Object.entries(mappings)) {
          text(purpose, "purpose", 100);
          this.resolveModel(routeId);
        }
        this.database.prepare("DELETE FROM purpose_defaults").run();
        const insert = this.database.prepare(
          "INSERT INTO purpose_defaults VALUES(?,?)",
        );
        for (const [purpose, routeId] of Object.entries(mappings))
          insert.run(purpose, routeId);
        this.audit(actorId, "purpose.replace", null, { mappings });
        return this.purposeDefaults();
      })
      .immediate();
  }
  resolvePurpose(purpose: string): HostedResolvedModel {
    const values = this.purposeDefaults();
    const routeId = values[purpose] ?? values["default"];
    if (!routeId)
      throw new HostedError(
        503,
        "purpose_model_unconfigured",
        `No hosted model is configured for ${purpose}.`,
      );
    return this.resolveModel(routeId);
  }
  limits(): HostedLimits {
    const row = this.database
      .prepare("SELECT value_json FROM settings WHERE key='limits'")
      .get() as Row | undefined;
    return {
      ...defaults,
      ...(row
        ? (JSON.parse(String(row.value_json)) as Partial<HostedLimits>)
        : {}),
    };
  }
  getLimits(): HostedLimits {
    return this.limits();
  }
  setLimits(input: Partial<HostedLimits>, actorId: string): HostedLimits {
    const merged = { ...this.limits() };
    for (const key of Object.keys(input) as (keyof HostedLimits)[]) {
      if (!(key in defaults))
        throw new HostedError(400, "unknown_limit", "Unknown hosted limit.");
      const value = input[key];
      if (typeof defaults[key] === "boolean") {
        if (typeof value !== "boolean")
          throw new HostedError(400, "invalid_limit", "Invalid boolean limit.");
      } else {
        amount(value as number);
        if ((value as number) < (key === "researchRetentionDays" ? 0 : 1))
          throw new HostedError(
            400,
            "invalid_limit",
            "Limits must be positive.",
          );
      }
      Object.assign(merged, { [key]: value });
    }
    if (
      merged.sessionDays > 365 ||
      merged.researchRetentionDays > 3650 ||
      merged.globalConcurrency > 100 ||
      merged.perUserConcurrency > 100
    )
      throw new HostedError(400, "invalid_limit", "Hosted limit is too large.");
    if (input.callsEnabled === true) {
      const models = this.listModels();
      const enabled = models.filter((model) => model.enabled);
      if (!enabled.length) {
        const draft = models.find((model) => !hostedModelPricingReady(model));
        if (draft) assertHostedModelPricing(draft);
        throw new HostedError(
          409,
          "model_configuration_required",
          "请先配置并启用至少一个计费完整的模型，再允许新的模型调用。",
        );
      }
      for (const model of enabled) {
        assertHostedModelPricing(model);
        if (!this.resolveModel(model.routeId).apiKey.trim())
          throw new HostedError(
            409,
            "model_credential_missing",
            "启用的模型尚未配置服务器凭据，不能开启模型调用。",
          );
        if (model.kind === "image" && model.protocol === "anthropic")
          throw new HostedError(
            409,
            "image_protocol_unsupported",
            "启用的图片模型使用了不支持生图的协议，请先修改或停用该模型。",
          );
      }
    }
    this.database
      .prepare(
        "INSERT INTO settings VALUES('limits',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
      )
      .run(JSON.stringify(merged));
    this.audit(actorId, "limits.update", null, input);
    return merged;
  }

  recordResearch(input: HostedResearchInput): HostedResearchMetadata {
    const item = this.requireAttempt(input.attemptId);
    return this.writeResearch(
      {
        attemptId: item.id,
        operationId: item.operationId,
        sessionId: item.sessionId,
        userId: item.userId,
        kind: input.kind,
        purpose: item.purpose,
        displayName: item.modelSnapshot.displayName,
        modelId: item.modelSnapshot.modelId,
      },
      input.payload,
    );
  }
  recordConversation(input: {
    userId: string;
    operationId: string;
    sessionId?: string;
    kind: "input" | "output";
    payload: unknown;
  }): HostedResearchMetadata {
    this.assertExists(input.userId);
    return this.writeResearch(
      {
        attemptId: null,
        operationId: input.operationId,
        sessionId:
          input.sessionId ??
          this.getOperation(input.userId, input.operationId)?.sessionId ??
          null,
        userId: input.userId,
        kind: input.kind,
        purpose: "conversation",
        displayName: "",
        modelId: "",
      },
      input.payload,
    );
  }
  private writeResearch(
    metadata: Omit<
      HostedResearchMetadata,
      "id" | "createdAtUtc" | "deletedAtUtc"
    >,
    payload: unknown,
  ): HostedResearchMetadata {
    const payloadHash = this.crypto.fingerprint(payload, "research-dedup");
    const existing = metadata.attemptId
      ? (this.researchDatabase
          .prepare(
            "SELECT * FROM research_records WHERE attempt_id=? AND kind=?",
          )
          .get(metadata.attemptId, metadata.kind) as Row | undefined)
      : (this.researchDatabase
          .prepare(
            `SELECT * FROM research_records WHERE user_id=? AND operation_id=? AND kind=? ${metadata.kind === "output" ? "AND payload_hash=?" : ""}`,
          )
          .get(
            metadata.userId,
            metadata.operationId,
            metadata.kind,
            ...(metadata.kind === "output" ? [payloadHash] : []),
          ) as Row | undefined);
    if (existing) return research(existing);
    const id = randomUUID();
    const timestamp = now();
    this.researchDatabase
      .prepare(
        "INSERT INTO research_records(id,attempt_id,operation_id,session_id,user_id,kind,purpose,display_name,model_id,payload_encrypted,created_at,deleted_at,payload_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
      )
      .run(
        id,
        metadata.attemptId,
        metadata.operationId,
        metadata.sessionId,
        metadata.userId,
        metadata.kind,
        metadata.purpose,
        metadata.displayName,
        metadata.modelId,
        this.crypto.seal(payload, `research:${id}`),
        timestamp,
        payloadHash,
      );
    return { ...metadata, id, createdAtUtc: timestamp, deletedAtUtc: null };
  }
  recordAttemptResponse(id: string, response: HostedAttemptResponse): void {
    const headers = Object.fromEntries(
      Object.entries(response.headers ?? {}).filter(([key]) =>
        ["content-type", "x-request-id", "request-id"].includes(
          key.toLowerCase(),
        ),
      ),
    );
    this.recordResearch({
      attemptId: id,
      kind: "response",
      payload: {
        status: response.status,
        body: response.body,
        ...(response.providerRequestId
          ? { providerRequestId: response.providerRequestId }
          : {}),
        headers,
      },
    });
  }
  readAttemptResponse(id: string): HostedAttemptResponse | undefined {
    const row = this.researchDatabase
      .prepare(
        "SELECT id,payload_encrypted FROM research_records WHERE attempt_id=? AND kind='response' AND deleted_at IS NULL",
      )
      .get(id) as Row | undefined;
    return row
      ? this.crypto.open<HostedAttemptResponse>(
          String(row.payload_encrypted),
          `research:${String(row.id)}`,
        )
      : undefined;
  }
  recordAttemptImage(id: string, input: HostedAttemptImage): void {
    const bytes = Buffer.from(input.bytes);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (
      checksum !== input.sha256 ||
      bytes.length === 0 ||
      bytes.length > 32 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(input.mimeType) ||
      !Number.isSafeInteger(input.width) ||
      input.width < 1 ||
      !Number.isSafeInteger(input.height) ||
      input.height < 1
    )
      throw new HostedError(
        400,
        "invalid_research_image",
        "The research image bytes, checksum or dimensions are invalid.",
      );
    const existing = this.readAttemptImage(id);
    if (existing) {
      if (
        existing.sha256 !== checksum ||
        existing.mimeType !== input.mimeType ||
        existing.width !== input.width ||
        existing.height !== input.height
      )
        throw new HostedError(
          409,
          "research_image_conflict",
          "The attempt already has a different research image.",
        );
      return;
    }
    const extension =
      input.mimeType === "image/jpeg" ? "jpg" : input.mimeType.split("/")[1]!;
    this.recordResearch({
      attemptId: id,
      kind: "image",
      payload: {
        fileName: `images/${checksum}.${extension}`,
        sha256: checksum,
        mimeType: input.mimeType,
        width: input.width,
        height: input.height,
        byteLength: bytes.length,
        encoding: "base64",
        data: bytes.toString("base64"),
      },
    });
  }
  readAttemptImage(id: string): HostedAttemptImage | undefined {
    const row = this.researchDatabase
      .prepare(
        "SELECT id,payload_encrypted FROM research_records WHERE attempt_id=? AND kind='image' AND deleted_at IS NULL",
      )
      .get(id) as Row | undefined;
    if (!row) return undefined;
    const payload = this.crypto.open<{
      data: string;
      mimeType: string;
      width: number;
      height: number;
      sha256: string;
    }>(String(row.payload_encrypted), `research:${String(row.id)}`);
    const bytes = Buffer.from(payload.data, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== payload.sha256)
      throw new HostedError(
        500,
        "research_image_corrupt",
        "The research image checksum is invalid.",
      );
    return {
      bytes,
      mimeType: payload.mimeType,
      width: payload.width,
      height: payload.height,
      sha256: payload.sha256,
    };
  }
  private researchWhere(filter: ResearchFilter): {
    clause: string;
    values: unknown[];
  } {
    const clauses = ["deleted_at IS NULL"];
    const values: unknown[] = [];
    if (filter.modelOnly)
      clauses.push("kind IN ('request','response','image')");
    for (const [column, value] of [
      ["id", filter.id],
      ["user_id", filter.userId],
      ["operation_id", filter.operationId],
      ["session_id", filter.sessionId],
      ["attempt_id", filter.attemptId],
      ["model_id", filter.modelId],
      ["purpose", filter.purpose],
      ["kind", filter.kind],
    ])
      if (value) {
        clauses.push(`${column}=?`);
        values.push(value);
      }
    if (filter.beforeUtc) {
      clauses.push("created_at<?");
      values.push(filter.beforeUtc);
    }
    if (filter.afterUtc) {
      clauses.push("created_at>=?");
      values.push(filter.afterUtc);
    }
    return { clause: clauses.join(" AND "), values };
  }
  listResearch(filter: ResearchFilter = {}): HostedResearchMetadata[] {
    const where = this.researchWhere(filter);
    return (
      this.researchDatabase
        .prepare(
          `SELECT * FROM research_records WHERE ${where.clause} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
        )
        .all(
          ...where.values,
          Math.min(1000, Math.max(1, filter.limit ?? 100)),
          Math.max(0, filter.offset ?? 0),
        ) as Row[]
    ).map(research);
  }
  readResearch(
    id: string,
    actorId: string,
  ): HostedResearchMetadata & { payload: unknown } {
    const row = this.researchDatabase
      .prepare(
        "SELECT * FROM research_records WHERE id=? AND deleted_at IS NULL",
      )
      .get(id) as Row | undefined;
    if (!row)
      throw new HostedError(
        404,
        "research_not_found",
        "Research record not found.",
      );
    this.audit(actorId, "research.read", id);
    return {
      ...research(row),
      payload: this.crypto.open(
        String(row.payload_encrypted),
        `research:${id}`,
      ),
    };
  }
  exportResearch(filter: ResearchFilter, actorId: string): string {
    const where = this.researchWhere(filter);
    const rows = this.researchDatabase
      .prepare(
        `SELECT * FROM research_records WHERE ${where.clause} ORDER BY created_at,id`,
      )
      .all(...where.values) as Row[];
    this.audit(actorId, "research.export", null, {
      count: rows.length,
      filter,
    });
    return rows
      .map((row) =>
        JSON.stringify({
          ...research(row),
          payload: this.crypto.open(
            String(row.payload_encrypted),
            `research:${String(row.id)}`,
          ),
        }),
      )
      .join("\n");
  }
  deleteResearch(filter: ResearchFilter, actorId: string): number {
    const where = this.researchWhere(filter);
    const changes = this.researchDatabase
      .prepare(
        `UPDATE research_records SET payload_encrypted=NULL,deleted_at=? WHERE ${where.clause}`,
      )
      .run(now(), ...where.values).changes;
    this.audit(actorId, "research.delete", null, { count: changes, filter });
    return changes;
  }
  purgeExpiredResearch(actorId = "system"): number {
    if (this.limits().researchRetentionDays === 0) return 0;
    return this.deleteResearch(
      {
        beforeUtc: new Date(
          Date.now() - this.limits().researchRetentionDays * 86400000,
        ).toISOString(),
      },
      actorId,
    );
  }

  beginOperation(input: {
    id: string;
    userId: string;
    method: string;
    path: string;
    input: unknown;
    sessionId?: string;
    clientMessageId?: string;
  }): HostedOperation {
    const inputHash = createHash("sha256")
      .update(JSON.stringify(input.input) ?? "null")
      .digest("hex");
    return this.database
      .transaction(() => {
        this.assertActiveUser(input.userId);
        const existing = this.getOperation(input.userId, input.id);
        if (existing) {
          if (
            existing.inputHash !== inputHash ||
            existing.path !== input.path ||
            existing.method !== input.method
          )
            throw new HostedError(
              409,
              "operation_id_conflict",
              "The request identifier has already been used with different input.",
            );
          return existing;
        }
        const timestamp = now();
        this.database
          .prepare(
            "INSERT INTO operations(id,user_id,method,path,input_hash,session_id,client_message_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'running',?,?)",
          )
          .run(
            text(input.id, "operation ID"),
            input.userId,
            input.method,
            input.path,
            inputHash,
            input.sessionId ?? null,
            input.clientMessageId ?? null,
            timestamp,
            timestamp,
          );
        return this.getOperation(input.userId, input.id)!;
      })
      .immediate();
  }
  getOperation(userId: string, id: string): HostedOperation | undefined {
    const row = this.database
      .prepare("SELECT * FROM operations WHERE user_id=? AND id=?")
      .get(userId, id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      method: String(row.method),
      path: String(row.path),
      inputHash: String(row.input_hash),
      sessionId: row.session_id as string | null,
      clientMessageId: row.client_message_id as string | null,
      status: row.status as HostedOperation["status"],
      statusCode: row.status_code as number | null,
      ...(row.response_encrypted
        ? {
            response: this.crypto.open(
              row.response_encrypted as string,
              `operation:${userId}:${id}`,
            ),
          }
        : {}),
      createdAtUtc: String(row.created_at),
      updatedAtUtc: String(row.updated_at),
    };
  }
  findOperationByClientMessageId(
    userId: string,
    clientMessageId: string,
  ): HostedOperation | undefined {
    const row = this.database
      .prepare(
        "SELECT id FROM operations WHERE user_id=? AND client_message_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(userId, clientMessageId) as Row | undefined;
    return row ? this.getOperation(userId, String(row.id)) : undefined;
  }
  completeOperation(
    userId: string,
    id: string,
    result: { statusCode: number; response: unknown },
  ): HostedOperation {
    return this.finishOperation(userId, id, result, "completed");
  }
  failOperation(
    userId: string,
    id: string,
    result: { statusCode: number; response: unknown },
  ): HostedOperation {
    return this.finishOperation(userId, id, result, "failed");
  }
  private finishOperation(
    userId: string,
    id: string,
    result: { statusCode: number; response: unknown },
    status: "completed" | "failed",
  ): HostedOperation {
    const existing = this.getOperation(userId, id);
    if (!existing)
      throw new HostedError(404, "operation_not_found", "Operation not found.");
    if (existing.status !== "running") return existing;
    this.database
      .prepare(
        "UPDATE operations SET status=?,status_code=?,response_encrypted=?,updated_at=? WHERE user_id=? AND id=? AND status='running'",
      )
      .run(
        status,
        result.statusCode,
        this.crypto.seal(result.response, `operation:${userId}:${id}`),
        now(),
        userId,
        id,
      );
    return this.getOperation(userId, id)!;
  }
  audit(
    actorId: string,
    action: string,
    targetId: string | null = null,
    details: unknown = {},
  ): void {
    this.database
      .prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        actorId,
        action,
        targetId,
        JSON.stringify(details),
        now(),
      );
  }
  listAudit(limit = 100): HostedAuditEntry[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM admin_audit ORDER BY created_at DESC,id LIMIT ?",
        )
        .all(Math.min(1000, Math.max(1, limit))) as Row[]
    ).map((row) => ({
      id: String(row.id),
      actorId: String(row.actor_id),
      action: String(row.action),
      targetId: row.target_id as string | null,
      details: JSON.parse(String(row.details_json)) as unknown,
      createdAtUtc: String(row.created_at),
    }));
  }
}
