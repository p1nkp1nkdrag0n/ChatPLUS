import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { Database } from "../db/connection.js";
import { ApiError } from "../domain/errors.js";

export const LlmKeyMetadataSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  keyVersion: z.literal(1),
});
export type LlmKeyMetadata = z.infer<typeof LlmKeyMetadataSchema>;
const CredentialSchema = z.strictObject({
  version: z.literal(1),
  fingerprint: z.string(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

export function llmKeyPath(databasePath: string): string {
  return `${databasePath}.llm-key`;
}

export function readLlmKeyMetadata(database: Database): LlmKeyMetadata | null {
  if (
    !database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_key_metadata'",
      )
      .get()
  )
    return null;
  const row = database
    .prepare(
      "SELECT fingerprint, key_version AS keyVersion FROM llm_key_metadata WHERE id=1",
    )
    .get();
  if (
    row === undefined &&
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='llm_providers'",
      )
      .get() &&
    database
      .prepare(
        "SELECT 1 FROM llm_providers WHERE credential_json IS NOT NULL AND credential_json <> 'unavailable' LIMIT 1",
      )
      .get()
  ) {
    throw new Error("Encrypted LLM credentials are missing key metadata");
  }
  return row === undefined ? null : LlmKeyMetadataSchema.parse(row);
}

export function readLlmKeyFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("LLM key must be a regular file");
  const raw = readFileSync(path);
  if (raw.length !== 32) throw new Error("LLM key file is invalid");
  return raw;
}

export function llmKeyFingerprint(key: Buffer): string {
  return createHash("sha256")
    .update("chatplus:llm-key:v1:")
    .update(key)
    .digest("hex");
}

export function verifyLlmKeyFile(path: string, metadata: LlmKeyMetadata): void {
  const actual = Buffer.from(llmKeyFingerprint(readLlmKeyFile(path)), "hex");
  if (!timingSafeEqual(actual, Buffer.from(metadata.fingerprint, "hex")))
    throw new Error("LLM key fingerprint does not match");
}

/** Credentials use a dedicated local key, independent of encrypted correspondence. */
export class LlmCredentialService {
  readonly path: string;
  private memoryKey: Buffer | undefined;
  constructor(
    private readonly database: Database,
    databasePath: string,
  ) {
    this.path = llmKeyPath(databasePath);
    if (databasePath === ":memory:") this.memoryKey = randomBytes(32);
  }

  encrypt(providerId: string, apiKey: string): string {
    const key = this.key(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`chatplus:llm-credential:v1:${providerId}`));
    const ciphertext = Buffer.concat([
      cipher.update(apiKey, "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      fingerprint: llmKeyFingerprint(key),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  }

  decrypt(providerId: string, encrypted: string): string {
    try {
      const credential = CredentialSchema.parse(JSON.parse(encrypted));
      const key = this.key(false);
      if (credential.fingerprint !== llmKeyFingerprint(key))
        throw new Error("Credential key mismatch");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(credential.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(`chatplus:llm-credential:v1:${providerId}`));
      decipher.setAuthTag(Buffer.from(credential.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(credential.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw unavailable();
    }
  }

  available(providerId: string, encrypted: string): boolean {
    try {
      this.decrypt(providerId, encrypted);
      return true;
    } catch {
      return false;
    }
  }

  /** Explicit recovery only. Existing provider entries stay, and require new credentials. */
  reset(): void {
    if (existsSync(this.path)) {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
      unlinkSync(this.path);
    }
    this.database.transaction(() => {
      this.database
        .prepare(
          "UPDATE llm_providers SET credential_json = ?, revision = revision + 1 WHERE credential_json IS NOT NULL",
        )
        .run("unavailable");
      this.database.prepare("DELETE FROM llm_key_metadata").run();
      this.database.prepare("DELETE FROM llm_probe_results").run();
    })();
    if (this.memoryKey !== undefined) this.memoryKey = randomBytes(32);
    this.key(true);
  }

  private key(create: boolean): Buffer {
    try {
      const metadata = readLlmKeyMetadata(this.database);
      let key = this.memoryKey;
      if (key === undefined && existsSync(this.path))
        key = readLlmKeyFile(this.path);
      if (key === undefined) {
        if (!create || metadata !== null) throw unavailable();
        mkdirSync(dirname(this.path), { recursive: true });
        const generated = randomBytes(32);
        try {
          writeFileSync(this.path, generated, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        key = readLlmKeyFile(this.path);
        if (process.platform !== "win32") chmodSync(this.path, 0o600);
      }
      const fingerprint = llmKeyFingerprint(key);
      if (metadata !== null && metadata.fingerprint !== fingerprint)
        throw unavailable();
      if (metadata === null && create) {
        this.database
          .prepare(
            "INSERT INTO llm_key_metadata(id,fingerprint,key_version) VALUES(1,?,1) ON CONFLICT(id) DO NOTHING",
          )
          .run(fingerprint);
        if (readLlmKeyMetadata(this.database)?.fingerprint !== fingerprint)
          throw unavailable();
      }
      return key;
    } catch {
      throw unavailable();
    }
  }
}

function unavailable(): ApiError {
  return new ApiError(
    409,
    "credential_unavailable",
    "供应商凭证不可用，请恢复原密钥文件，或重置凭证后重新填写 API Key。",
  );
}
