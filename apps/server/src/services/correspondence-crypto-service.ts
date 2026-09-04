import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  EncryptedLetterBodySchema,
  EntityIdSchema,
  LetterReplyProposalSchema,
  UtcDateTimeSchema,
  type EncryptedLetterBody,
  type LetterReplyProposal,
} from "@personasim/contracts";
import {
  canonicalCorrespondenceJson,
  canonicalLetterReplyContent,
} from "@personasim/features";

import type { Database } from "../db/connection.js";
import { createEntityId } from "../domain/id.js";
import {
  deriveCorrespondenceInstanceSecretFingerprint,
  parseCorrespondenceInstanceSecret,
} from "./correspondence-instance-secret.js";

const LETTER_KEY_INFO = "chatplus-letter-v1";
const KEY_METADATA_ID = 1;
const KEY_VERSION = 1;
const FINGERPRINT_VERSION = 1;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type CorrespondenceMode = "off" | "shadow" | "enforced";

export type CorrespondenceCryptoStartupErrorCode =
  | "CORRESPONDENCE_SECRET_REQUIRED"
  | "CORRESPONDENCE_SECRET_INVALID"
  | "CORRESPONDENCE_SECRET_MISMATCH"
  | "CORRESPONDENCE_KEY_METADATA_MISSING";

export class CorrespondenceCryptoStartupError extends Error {
  constructor(
    public readonly code: CorrespondenceCryptoStartupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CorrespondenceCryptoStartupError";
  }
}

export type CorrespondenceOpenErrorCode =
  | "not_found"
  | "letter_not_arrived"
  | "letter_not_openable"
  | "letter_integrity_error";

export class CorrespondenceOpenError extends Error {
  constructor(
    public readonly code: CorrespondenceOpenErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CorrespondenceOpenError";
  }
}

export class CorrespondenceEncryptionNotAuthorizedError extends Error {
  readonly code = "correspondence_processing_paused";

  constructor() {
    super("Encrypted correspondence generation is not enabled");
    this.name = "CorrespondenceEncryptionNotAuthorizedError";
  }
}

export interface InitializeCorrespondenceCryptoInput {
  mode: CorrespondenceMode;
  instanceSecret?: string;
  nowUtc?: string;
}

export interface LetterCryptoContext {
  letterId: string;
  direction: "agent_to_user";
  contentHash: string;
  authoredEffectiveAtUtc: string;
  arrivalDueAtUtc: string;
}

export interface EncryptLetterReplyInput extends LetterCryptoContext {
  proposal: LetterReplyProposal;
  createdAtUtc?: string;
}

export interface DecryptLetterReplyInput extends LetterCryptoContext {
  encryptedBody: EncryptedLetterBody;
}

export interface OpenCorrespondenceLetterInput {
  letterId: string;
  agentId: string;
  openedAtUtc: string;
}

export interface OpenCorrespondenceLetterResult {
  letterId: string;
  agentId: string;
  openedAtUtc: string;
  proposal: LetterReplyProposal;
  replayed: boolean;
}

interface KeyMetadataRow {
  fingerprint_version: number;
  fingerprint: string;
  key_version: number;
  created_at_utc: string;
}

interface OpenLetterRow {
  id: string;
  agent_id: string;
  direction: string;
  status: string;
  content_hash: string | null;
  encrypted_ciphertext: string | null;
  encrypted_iv: string | null;
  encrypted_auth_tag: string | null;
  encrypted_key_version: number | null;
  encrypted_aad_hash: string | null;
  encrypted_created_at_utc: string | null;
  arrival_due_at_utc: string | null;
  effective_author_time_utc: string | null;
  delivered_effective_at_utc: string | null;
  processed_at_utc: string | null;
  opened_at_utc: string | null;
  updated_at_utc: string;
}

export class CorrespondenceCryptoService {
  private constructor(
    private readonly instanceSecret: Buffer,
    private readonly encryptionEnabled: boolean,
  ) {}

  static initialize(
    database: Database,
    input: InitializeCorrespondenceCryptoInput,
  ): CorrespondenceCryptoService | undefined {
    const initialize = database.transaction(() => {
      const encryptedRowCount = readEncryptedRowCount(database);
      const encryptedRowsHaveInvalidMetadata =
        haveInvalidEncryptedRowMetadata(database);
      const metadata = database
        .prepare(
          `SELECT fingerprint_version, fingerprint, key_version, created_at_utc
           FROM correspondence_key_metadata WHERE id = ?`,
        )
        .get(KEY_METADATA_ID) as KeyMetadataRow | undefined;

      const secret = parseCorrespondenceInstanceSecret(input.instanceSecret);
      const secretIsRequired =
        input.mode === "enforced" ||
        metadata !== undefined ||
        encryptedRowCount > 0;
      if (secret === undefined) {
        if (input.instanceSecret !== undefined) {
          throw startupError(
            "CORRESPONDENCE_SECRET_INVALID",
            "INSTANCE_SECRET must be canonical Base64 encoding at least 32 bytes",
          );
        }
        if (secretIsRequired) {
          throw startupError(
            "CORRESPONDENCE_SECRET_REQUIRED",
            "INSTANCE_SECRET is required for encrypted correspondence",
          );
        }
        return undefined;
      }

      if (
        encryptedRowsHaveInvalidMetadata ||
        (encryptedRowCount > 0 && metadata === undefined)
      ) {
        throw startupError(
          "CORRESPONDENCE_KEY_METADATA_MISSING",
          "Encrypted correspondence exists without instance key metadata",
        );
      }

      // A decoded secret can only exist when the original canonical string was
      // present; retain that narrowing explicitly for the shared helper.
      if (input.instanceSecret === undefined) {
        throw startupError(
          "CORRESPONDENCE_SECRET_REQUIRED",
          "INSTANCE_SECRET is required for encrypted correspondence",
        );
      }
      const fingerprint = deriveCorrespondenceInstanceSecretFingerprint(
        input.instanceSecret,
      );
      if (metadata !== undefined) {
        if (
          metadata.fingerprint_version !== FINGERPRINT_VERSION ||
          metadata.key_version !== KEY_VERSION ||
          !SHA_256_PATTERN.test(metadata.fingerprint) ||
          !UtcDateTimeSchema.safeParse(metadata.created_at_utc).success
        ) {
          throw startupError(
            "CORRESPONDENCE_KEY_METADATA_MISSING",
            "Correspondence key metadata is missing or unsupported",
          );
        }
        if (!safeDigestEqual(metadata.fingerprint, fingerprint)) {
          throw startupError(
            "CORRESPONDENCE_SECRET_MISMATCH",
            "INSTANCE_SECRET does not match this correspondence database",
          );
        }
      } else if (input.mode === "enforced") {
        database
          .prepare(
            `INSERT INTO correspondence_key_metadata(
               id, fingerprint_version, fingerprint, key_version,
               created_at_utc
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            KEY_METADATA_ID,
            FINGERPRINT_VERSION,
            fingerprint,
            KEY_VERSION,
            input.nowUtc ?? new Date().toISOString(),
          );
      } else {
        return undefined;
      }

      return new CorrespondenceCryptoService(secret, input.mode === "enforced");
    });

    return initialize.immediate();
  }

  encryptReply(input: EncryptLetterReplyInput): EncryptedLetterBody {
    if (!this.encryptionEnabled) {
      throw new CorrespondenceEncryptionNotAuthorizedError();
    }
    validateCryptoContext(input);
    const proposal = LetterReplyProposalSchema.parse(input.proposal);
    const aad = canonicalAad(input);
    const iv = randomBytes(12);
    const canonicalProposal = canonicalCorrespondenceJson(proposal);
    const plaintext = Buffer.from(canonicalProposal, "utf8");
    if (
      !safeDigestEqual(input.contentHash, hashLetterReplyProposal(proposal))
    ) {
      plaintext.fill(0);
      throw new Error("Letter proposal content hash mismatch");
    }
    const key = this.deriveLetterKey(input.letterId);
    let ciphertext: Buffer | undefined;
    let authTag: Buffer | undefined;
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv, {
        authTagLength: 16,
      });
      cipher.setAAD(aad);
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      authTag = cipher.getAuthTag();
      return EncryptedLetterBodySchema.parse({
        letterId: input.letterId,
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        keyVersion: KEY_VERSION,
        aadHash: sha256(aad),
        createdAtUtc: input.createdAtUtc ?? new Date().toISOString(),
      });
    } finally {
      key.fill(0);
      plaintext.fill(0);
      ciphertext?.fill(0);
      authTag?.fill(0);
    }
  }

  decryptReply(input: DecryptLetterReplyInput): LetterReplyProposal {
    try {
      validateCryptoContext(input);
      const encryptedBody = EncryptedLetterBodySchema.parse(
        input.encryptedBody,
      );
      if (
        encryptedBody.letterId !== input.letterId ||
        encryptedBody.keyVersion !== KEY_VERSION
      ) {
        throw new Error("Unexpected encrypted-letter key metadata");
      }

      const aad = canonicalAad(input);
      if (!safeDigestEqual(encryptedBody.aadHash, sha256(aad))) {
        throw new Error("AAD hash mismatch");
      }
      const iv = decodeCanonicalBase64(encryptedBody.iv);
      const authTag = decodeCanonicalBase64(encryptedBody.authTag);
      const ciphertext = decodeCanonicalBase64(encryptedBody.ciphertext, true);
      if (iv.length !== 12 || authTag.length !== 16) {
        throw new Error("Unexpected AES-GCM envelope length");
      }

      const key = this.deriveLetterKey(input.letterId);
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, {
          authTagLength: 16,
        });
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);
        plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        const proposal = LetterReplyProposalSchema.parse(
          JSON.parse(plaintext.toString("utf8")) as unknown,
        );
        if (
          !safeDigestEqual(input.contentHash, hashLetterReplyProposal(proposal))
        ) {
          throw new Error("Decrypted proposal content hash mismatch");
        }
        return proposal;
      } finally {
        key.fill(0);
        plaintext?.fill(0);
      }
    } catch {
      throw integrityError();
    }
  }

  private deriveLetterKey(letterId: string): Buffer {
    return Buffer.from(
      hkdfSync(
        "sha256",
        this.instanceSecret,
        Buffer.from(letterId, "utf8"),
        Buffer.from(LETTER_KEY_INFO, "utf8"),
        32,
      ),
    );
  }
}

export class CorrespondenceOpenService {
  constructor(
    private readonly database: Database,
    private readonly crypto: CorrespondenceCryptoService,
  ) {}

  openLetter(
    input: OpenCorrespondenceLetterInput,
  ): OpenCorrespondenceLetterResult {
    if (
      !EntityIdSchema.safeParse(input.letterId).success ||
      !EntityIdSchema.safeParse(input.agentId).success
    ) {
      throw new CorrespondenceOpenError(
        "not_found",
        "Correspondence letter was not found",
      );
    }
    if (!UtcDateTimeSchema.safeParse(input.openedAtUtc).success) {
      throw new CorrespondenceOpenError(
        "letter_not_openable",
        "This correspondence letter cannot be opened at that time",
      );
    }
    const open = this.database.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM letters WHERE id = ?")
        .get(input.letterId) as OpenLetterRow | undefined;
      if (row === undefined || row.agent_id !== input.agentId) {
        throw new CorrespondenceOpenError(
          "not_found",
          "Correspondence letter was not found",
        );
      }
      if (row.direction !== "agent_to_user") {
        throw new CorrespondenceOpenError(
          "letter_not_openable",
          "This correspondence letter cannot be opened",
        );
      }
      if (row.status === "sealed" || row.status === "in_transit") {
        throw new CorrespondenceOpenError(
          "letter_not_arrived",
          "This correspondence letter has not arrived",
        );
      }
      if (row.status !== "delivered_unread" && row.status !== "read") {
        throw new CorrespondenceOpenError(
          "letter_not_openable",
          "This correspondence letter cannot be opened",
        );
      }

      if (row.status === "read") {
        if (row.opened_at_utc === null) throw integrityError();
        const proposal = this.decryptRow(row);
        this.recordOpenEvent(row, row.opened_at_utc);
        return {
          letterId: row.id,
          agentId: row.agent_id,
          openedAtUtc: row.opened_at_utc,
          proposal,
          replayed: true,
        };
      }
      const deliveredEffectiveAt = UtcDateTimeSchema.safeParse(
        row.delivered_effective_at_utc,
      );
      const processedAt = UtcDateTimeSchema.safeParse(row.processed_at_utc);
      const updatedAt = UtcDateTimeSchema.safeParse(row.updated_at_utc);
      if (
        !deliveredEffectiveAt.success ||
        !processedAt.success ||
        !updatedAt.success ||
        Date.parse(processedAt.data) < Date.parse(deliveredEffectiveAt.data)
      ) {
        throw integrityError();
      }
      // The wall clock may move backwards after catch-up has already observed
      // delivery. Keep the user-visible and audited open time monotonic with
      // that persisted history instead of making an otherwise arrived letter
      // impossible to open.
      const openedAtUtc = latestUtcDateTime(
        input.openedAtUtc,
        deliveredEffectiveAt.data,
        processedAt.data,
        updatedAt.data,
      );

      const result = this.database
        .prepare(
          `UPDATE letters
           SET status = 'read', opened_at_utc = ?, updated_at_utc = ?
           WHERE id = ? AND agent_id = ? AND direction = 'agent_to_user'
             AND status = 'delivered_unread'`,
        )
        .run(openedAtUtc, openedAtUtc, row.id, row.agent_id);
      if (result.changes !== 1) {
        throw new CorrespondenceOpenError(
          "letter_not_openable",
          "This correspondence letter could not be opened",
        );
      }
      // Keep the state transition and plaintext release in one transaction,
      // but perform the guarded transition first. If authentication or
      // schema validation fails, SQLite rolls this update back and no
      // plaintext leaves the service.
      const proposal = this.decryptRow(row);
      this.recordOpenEvent(row, openedAtUtc);
      return {
        letterId: row.id,
        agentId: row.agent_id,
        openedAtUtc,
        proposal,
        replayed: false,
      };
    });

    return open.immediate();
  }

  private decryptRow(row: OpenLetterRow): LetterReplyProposal {
    if (
      row.content_hash === null ||
      row.arrival_due_at_utc === null ||
      row.effective_author_time_utc === null ||
      row.encrypted_ciphertext === null ||
      row.encrypted_iv === null ||
      row.encrypted_auth_tag === null ||
      row.encrypted_key_version === null ||
      row.encrypted_aad_hash === null ||
      row.encrypted_created_at_utc === null
    ) {
      throw integrityError();
    }
    return this.crypto.decryptReply({
      letterId: row.id,
      direction: "agent_to_user",
      contentHash: row.content_hash,
      authoredEffectiveAtUtc: row.effective_author_time_utc,
      arrivalDueAtUtc: row.arrival_due_at_utc,
      encryptedBody: {
        letterId: row.id,
        ciphertext: row.encrypted_ciphertext,
        iv: row.encrypted_iv,
        authTag: row.encrypted_auth_tag,
        keyVersion: row.encrypted_key_version,
        aadHash: row.encrypted_aad_hash,
        createdAtUtc: row.encrypted_created_at_utc,
      },
    });
  }

  private recordOpenEvent(row: OpenLetterRow, openedAtUtc: string): void {
    const idempotencyKey = `letter-open:${row.id}`;
    this.database
      .prepare(
        `INSERT INTO domain_events(
           id, agent_id, stream_type, stream_id, stream_version, event_type,
           recorded_at_utc, effective_at_utc, payload_json, correlation_id,
           causation_id, idempotency_key
         ) VALUES (?, ?, 'correspondence_letter', ?, 1, 'letter.opened',
           ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        createEntityId("event"),
        row.agent_id,
        row.id,
        openedAtUtc,
        openedAtUtc,
        canonicalCorrespondenceJson({ letterId: row.id, openedAtUtc }),
        idempotencyKey,
      );
    const event = this.database
      .prepare(
        `SELECT agent_id, stream_type, stream_id, event_type, effective_at_utc
         FROM domain_events WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as
      | {
          agent_id: string;
          stream_type: string;
          stream_id: string;
          event_type: string;
          effective_at_utc: string;
        }
      | undefined;
    if (
      event === undefined ||
      event.agent_id !== row.agent_id ||
      event.stream_type !== "correspondence_letter" ||
      event.stream_id !== row.id ||
      event.event_type !== "letter.opened" ||
      event.effective_at_utc !== openedAtUtc
    ) {
      throw new Error("Correspondence open event idempotency conflict");
    }
  }
}

function latestUtcDateTime(...values: readonly string[]): string {
  return values.reduce((latest, candidate) =>
    Date.parse(candidate) > Date.parse(latest) ? candidate : latest,
  );
}

function readEncryptedRowCount(database: Database): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM letters
       WHERE encrypted_ciphertext IS NOT NULL
          OR encrypted_iv IS NOT NULL
          OR encrypted_auth_tag IS NOT NULL
          OR encrypted_key_version IS NOT NULL
          OR encrypted_aad_hash IS NOT NULL
          OR encrypted_created_at_utc IS NOT NULL`,
    )
    .get() as { count: number };
  return row.count;
}

function haveInvalidEncryptedRowMetadata(database: Database): boolean {
  const rows = database
    .prepare(
      `SELECT encrypted_ciphertext, encrypted_iv, encrypted_auth_tag,
              encrypted_key_version, encrypted_aad_hash,
              encrypted_created_at_utc
       FROM letters
       WHERE encrypted_ciphertext IS NOT NULL
          OR encrypted_iv IS NOT NULL
          OR encrypted_auth_tag IS NOT NULL
          OR encrypted_key_version IS NOT NULL
          OR encrypted_aad_hash IS NOT NULL
          OR encrypted_created_at_utc IS NOT NULL`,
    )
    .all() as Array<{
    encrypted_ciphertext: string | null;
    encrypted_iv: string | null;
    encrypted_auth_tag: string | null;
    encrypted_key_version: number | null;
    encrypted_aad_hash: string | null;
    encrypted_created_at_utc: string | null;
  }>;
  return rows.some((row) => {
    if (
      row.encrypted_ciphertext === null ||
      row.encrypted_iv === null ||
      row.encrypted_auth_tag === null ||
      row.encrypted_key_version !== KEY_VERSION ||
      row.encrypted_aad_hash === null ||
      !SHA_256_PATTERN.test(row.encrypted_aad_hash) ||
      row.encrypted_created_at_utc === null ||
      !UtcDateTimeSchema.safeParse(row.encrypted_created_at_utc).success
    ) {
      return true;
    }
    try {
      return (
        decodeCanonicalBase64(row.encrypted_ciphertext).length === 0 ||
        decodeCanonicalBase64(row.encrypted_iv).length !== 12 ||
        decodeCanonicalBase64(row.encrypted_auth_tag).length !== 16
      );
    } catch {
      return true;
    }
  });
}

function decodeCanonicalBase64(value: string, allowEmpty = false): Buffer {
  if (
    (!allowEmpty && value.length === 0) ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64_PATTERN.test(value)
  ) {
    throw new Error("Invalid canonical Base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("Invalid canonical Base64");
  }
  return decoded;
}

function canonicalAad(input: LetterCryptoContext): Buffer {
  return Buffer.from(
    canonicalCorrespondenceJson({
      arrivalDueAt: input.arrivalDueAtUtc,
      authoredEffectiveAt: input.authoredEffectiveAtUtc,
      contentHash: input.contentHash,
      direction: input.direction,
      letterId: input.letterId,
    }),
    "utf8",
  );
}

function validateCryptoContext(input: LetterCryptoContext): void {
  if (
    !EntityIdSchema.safeParse(input.letterId).success ||
    input.direction !== "agent_to_user" ||
    !SHA_256_PATTERN.test(input.contentHash) ||
    !UtcDateTimeSchema.safeParse(input.authoredEffectiveAtUtc).success ||
    !UtcDateTimeSchema.safeParse(input.arrivalDueAtUtc).success
  ) {
    throw new Error("Invalid correspondence encryption context");
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashLetterReplyProposal(proposal: LetterReplyProposal): string {
  const parsed = LetterReplyProposalSchema.parse(proposal);
  return sha256(Buffer.from(canonicalLetterReplyContent(parsed), "utf8"));
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!SHA_256_PATTERN.test(left) || !SHA_256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function startupError(
  code: CorrespondenceCryptoStartupErrorCode,
  message: string,
): CorrespondenceCryptoStartupError {
  return new CorrespondenceCryptoStartupError(code, message);
}

function integrityError(): CorrespondenceOpenError {
  return new CorrespondenceOpenError(
    "letter_integrity_error",
    "Letter integrity verification failed",
  );
}
