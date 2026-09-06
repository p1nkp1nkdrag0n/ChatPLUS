import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type {
  EncryptedLetterBody,
  LetterReplyProposal,
} from "@personasim/contracts";
import { canonicalCorrespondenceJson } from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import {
  CorrespondenceCryptoService,
  CorrespondenceCryptoStartupError,
  CorrespondenceEncryptionNotAuthorizedError,
  CorrespondenceOpenError,
  CorrespondenceOpenService,
  hashLetterReplyProposal,
  type CorrespondenceCryptoStartupErrorCode,
  type CorrespondenceMode,
  type CorrespondenceOpenErrorCode,
} from "./correspondence-crypto-service.js";

const INSTANCE_SECRET = Buffer.alloc(32, 0x17).toString("base64");
const OTHER_SECRET = Buffer.alloc(32, 0x29).toString("base64");
const T0 = "2026-09-03T12:00:00.000Z";
const T1 = "2026-09-08T12:00:00.000Z";
const T2 = "2026-09-09T01:00:00.000Z";
const T3 = "2026-09-13T12:00:00.000Z";
const T4 = "2026-09-15T02:00:00.000Z";
const INCOMING_HASH = "b".repeat(64);

const PROPOSAL = {
  subject: "A sealed subject",
  salutation: "Dear friend,",
  paragraphs: [
    "I read your letter at the moment it reached me.",
    "This entire proposal, including its subject, stays inside the ciphertext.",
  ],
  closing: "Until the next letter,",
  signature: "Your correspondent",
  postscript: "The postscript is sealed too.",
  referencedEvidenceIds: ["evidence-before-arrival"],
} satisfies LetterReplyProposal;
const CONTENT_HASH = hashLetterReplyProposal(PROPOSAL);

describe("CorrespondenceCryptoService startup and encryption", () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
  });

  afterEach(() => database.close());

  it("strictly validates the instance secret and atomically pins its fingerprint", () => {
    expectStartupError(
      () =>
        CorrespondenceCryptoService.initialize(database, {
          mode: "enforced",
          nowUtc: T0,
        }),
      "CORRESPONDENCE_SECRET_REQUIRED",
    );
    expect(metadataCount(database)).toBe(0);

    for (const instanceSecret of [
      "not canonical base64",
      ` ${INSTANCE_SECRET}`,
      INSTANCE_SECRET.slice(0, -1),
      Buffer.alloc(31, 0x17).toString("base64"),
    ]) {
      expectStartupError(
        () =>
          CorrespondenceCryptoService.initialize(database, {
            mode: "enforced",
            instanceSecret,
            nowUtc: T0,
          }),
        "CORRESPONDENCE_SECRET_INVALID",
      );
    }
    expect(metadataCount(database)).toBe(0);
    expect(
      CorrespondenceCryptoService.initialize(database, {
        mode: "off",
        instanceSecret: INSTANCE_SECRET,
      }),
    ).toBeUndefined();
    expect(metadataCount(database)).toBe(0);

    expect(
      CorrespondenceCryptoService.initialize(database, {
        mode: "enforced",
        instanceSecret: INSTANCE_SECRET,
        nowUtc: T0,
      }),
    ).toBeInstanceOf(CorrespondenceCryptoService);
    const metadata = database
      .prepare(
        `SELECT fingerprint_version, fingerprint, key_version, created_at_utc
         FROM correspondence_key_metadata WHERE id = 1`,
      )
      .get() as {
      fingerprint_version: number;
      fingerprint: string;
      key_version: number;
      created_at_utc: string;
    };
    expect(metadata).toMatchObject({
      fingerprint_version: 1,
      key_version: 1,
      created_at_utc: T0,
    });
    expect(metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.fingerprint).toBe(
      createHash("sha256")
        .update("chatplus-correspondence-instance-fingerprint-v1\0", "utf8")
        .update(Buffer.from(INSTANCE_SECRET, "base64"))
        .digest("hex"),
    );
    expect(metadata.fingerprint).not.toContain(INSTANCE_SECRET);
    expect(() =>
      database
        .prepare(
          "UPDATE correspondence_key_metadata SET fingerprint = ? WHERE id = 1",
        )
        .run("c".repeat(64)),
    ).toThrow(/immutable/iu);

    for (const mode of ["off", "shadow"] satisfies CorrespondenceMode[]) {
      expectStartupError(
        () => CorrespondenceCryptoService.initialize(database, { mode }),
        "CORRESPONDENCE_SECRET_REQUIRED",
      );
    }
    expectStartupError(
      () =>
        CorrespondenceCryptoService.initialize(database, {
          mode: "shadow",
          instanceSecret: OTHER_SECRET,
        }),
      "CORRESPONDENCE_SECRET_MISMATCH",
    );
    const decryptOnly = CorrespondenceCryptoService.initialize(database, {
      mode: "off",
      instanceSecret: INSTANCE_SECRET,
    });
    expect(decryptOnly).toBeInstanceOf(CorrespondenceCryptoService);
    expect(() =>
      decryptOnly?.encryptReply({
        letterId: "reply-not-authorized",
        direction: "agent_to_user",
        contentHash: CONTENT_HASH,
        authoredEffectiveAtUtc: T1,
        arrivalDueAtUtc: T3,
        proposal: PROPOSAL,
        createdAtUtc: T2,
      }),
    ).toThrow(CorrespondenceEncryptionNotAuthorizedError);
    expect(
      CorrespondenceCryptoService.initialize(database, {
        mode: "off",
        instanceSecret: INSTANCE_SECRET,
      }),
    ).toBeInstanceOf(CorrespondenceCryptoService);
  });

  it("fails every mode when encrypted rows exist without private key metadata", () => {
    seedEncryptedReply(database, fakeEncryptedBody("reply-without-metadata"), {
      agentId: "agent-without-metadata",
      incomingLetterId: "incoming-without-metadata",
      replyLetterId: "reply-without-metadata",
      threadId: "thread-without-metadata",
    });

    expectStartupError(
      () =>
        CorrespondenceCryptoService.initialize(database, {
          mode: "off",
        }),
      "CORRESPONDENCE_SECRET_REQUIRED",
    );

    for (const mode of [
      "off",
      "shadow",
      "enforced",
    ] satisfies CorrespondenceMode[]) {
      expectStartupError(
        () =>
          CorrespondenceCryptoService.initialize(database, {
            mode,
            instanceSecret: INSTANCE_SECRET,
          }),
        "CORRESPONDENCE_KEY_METADATA_MISSING",
      );
    }
  });

  it("rejects unsupported per-letter key metadata even with a matching instance key", () => {
    requireCrypto(database);
    seedEncryptedReply(
      database,
      { ...fakeEncryptedBody("reply-key-version-2"), keyVersion: 2 },
      {
        agentId: "agent-key-version-2",
        incomingLetterId: "incoming-key-version-2",
        replyLetterId: "reply-key-version-2",
        threadId: "thread-key-version-2",
      },
    );
    expectStartupError(
      () =>
        CorrespondenceCryptoService.initialize(database, {
          mode: "off",
          instanceSecret: INSTANCE_SECRET,
        }),
      "CORRESPONDENCE_KEY_METADATA_MISSING",
    );
  });

  it("encrypts the complete proposal with per-letter AES-256-GCM and fails closed on tampering", () => {
    const crypto = requireCrypto(database);
    const context = {
      letterId: "reply-encryption",
      direction: "agent_to_user" as const,
      contentHash: CONTENT_HASH,
      authoredEffectiveAtUtc: T1,
      arrivalDueAtUtc: T3,
    };
    const first = crypto.encryptReply({
      ...context,
      proposal: PROPOSAL,
      createdAtUtc: T2,
    });
    const second = crypto.encryptReply({
      ...context,
      proposal: PROPOSAL,
      createdAtUtc: T2,
    });
    expect(() =>
      crypto.encryptReply({
        ...context,
        contentHash: "0".repeat(64),
        proposal: PROPOSAL,
        createdAtUtc: T2,
      }),
    ).toThrow(/content hash mismatch/iu);

    expect(Buffer.from(first.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(first.authTag, "base64")).toHaveLength(16);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.aadHash).toBe(
      createHash("sha256")
        .update(
          canonicalCorrespondenceJson({
            arrivalDueAt: T3,
            authoredEffectiveAt: T1,
            contentHash: CONTENT_HASH,
            direction: "agent_to_user",
            letterId: "reply-encryption",
          }),
          "utf8",
        )
        .digest("hex"),
    );
    expect(JSON.stringify(first)).not.toContain(PROPOSAL.subject);
    expect(crypto.decryptReply({ ...context, encryptedBody: first })).toEqual(
      PROPOSAL,
    );

    const integrityCases = [
      {
        ...first,
        ciphertext: flipBase64Byte(first.ciphertext),
      },
      { ...first, authTag: flipBase64Byte(first.authTag) },
      { ...first, aadHash: flipHexDigit(first.aadHash) },
    ];
    for (const encryptedBody of integrityCases) {
      const error = captureOpenError(() =>
        crypto.decryptReply({ ...context, encryptedBody }),
      );
      expect(error.code).toBe("letter_integrity_error");
      expect(error.message).toBe("Letter integrity verification failed");
      expect(error.message).not.toContain(PROPOSAL.subject);
    }
    expectOpenError(
      () =>
        crypto.decryptReply({
          ...context,
          arrivalDueAtUtc: "2026-09-14T12:00:00.000Z",
          encryptedBody: first,
        }),
      "letter_integrity_error",
    );
  });
});

describe("CorrespondenceOpenService", () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
  });

  afterEach(() => database.close());

  it("authenticates inside one transaction and preserves the first open across replays", () => {
    const crypto = requireCrypto(database);
    const envelope = crypto.encryptReply({
      letterId: "reply-openable",
      direction: "agent_to_user",
      contentHash: CONTENT_HASH,
      authoredEffectiveAtUtc: T1,
      arrivalDueAtUtc: T3,
      proposal: PROPOSAL,
      createdAtUtc: T2,
    });
    seedEncryptedReply(database, envelope, {
      agentId: "agent-openable",
      incomingLetterId: "incoming-openable",
      replyLetterId: "reply-openable",
      threadId: "thread-openable",
    });
    const repository = new CorrespondenceRepository(database);
    const decryptOnly = CorrespondenceCryptoService.initialize(database, {
      mode: "off",
      instanceSecret: INSTANCE_SECRET,
    });
    if (decryptOnly === undefined) {
      throw new Error("Expected decrypt-only correspondence capability");
    }
    const firstProcess = new CorrespondenceOpenService(database, decryptOnly);
    const competingProcess = new CorrespondenceOpenService(
      database,
      decryptOnly,
    );

    expectOpenError(
      () =>
        firstProcess.openLetter({
          letterId: "reply-openable",
          agentId: "agent-openable",
          openedAtUtc: T2,
        }),
      "letter_not_arrived",
    );
    expectOpenError(
      () =>
        firstProcess.openLetter({
          letterId: "incoming-openable",
          agentId: "agent-openable",
          openedAtUtc: T4,
        }),
      "letter_not_openable",
    );
    expectOpenError(
      () =>
        firstProcess.openLetter({
          letterId: "reply-openable",
          agentId: "another-agent",
          openedAtUtc: T4,
        }),
      "not_found",
    );

    repository.markDelivered("reply-openable", T3, T4);
    // Delivery was processed at T4, then the wall clock rolled back to T2.
    // Opening remains possible and uses the persisted monotonic floor.
    const first = firstProcess.openLetter({
      letterId: "reply-openable",
      agentId: "agent-openable",
      openedAtUtc: T2,
    });
    expect(first).toEqual({
      letterId: "reply-openable",
      agentId: "agent-openable",
      openedAtUtc: T4,
      proposal: PROPOSAL,
      replayed: false,
    });
    expect(
      competingProcess.openLetter({
        letterId: "reply-openable",
        agentId: "agent-openable",
        openedAtUtc: "2026-09-15T03:00:00.000Z",
      }),
    ).toEqual({ ...first, replayed: true });
    expect(
      database
        .prepare(
          `SELECT status, subject, body, opened_at_utc
           FROM letters WHERE id = 'reply-openable'`,
        )
        .get(),
    ).toEqual({
      status: "read",
      subject: null,
      body: null,
      opened_at_utc: T4,
    });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
           WHERE idempotency_key = 'letter-open:reply-openable'`,
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back without changing delivery state when authentication fails", () => {
    const crypto = requireCrypto(database);
    const validEnvelope = crypto.encryptReply({
      letterId: "reply-corrupt",
      direction: "agent_to_user",
      contentHash: CONTENT_HASH,
      authoredEffectiveAtUtc: T1,
      arrivalDueAtUtc: T3,
      proposal: PROPOSAL,
      createdAtUtc: T2,
    });
    seedEncryptedReply(
      database,
      {
        ...validEnvelope,
        authTag: flipBase64Byte(validEnvelope.authTag),
      },
      {
        agentId: "agent-corrupt",
        incomingLetterId: "incoming-corrupt",
        replyLetterId: "reply-corrupt",
        threadId: "thread-corrupt",
      },
    );
    const repository = new CorrespondenceRepository(database);
    repository.markDelivered("reply-corrupt", T3, T4);

    const error = captureOpenError(() =>
      new CorrespondenceOpenService(database, crypto).openLetter({
        letterId: "reply-corrupt",
        agentId: "agent-corrupt",
        openedAtUtc: T4,
      }),
    );
    expect(error).toMatchObject({
      code: "letter_integrity_error",
      message: "Letter integrity verification failed",
    });
    expect(
      database
        .prepare(
          "SELECT status, opened_at_utc FROM letters WHERE id = 'reply-corrupt'",
        )
        .get(),
    ).toEqual({ status: "delivered_unread", opened_at_utc: null });
  });

  it("rolls back the read transition when the idempotent open event cannot commit", () => {
    const crypto = requireCrypto(database);
    const envelope = crypto.encryptReply({
      letterId: "reply-event-failure",
      direction: "agent_to_user",
      contentHash: CONTENT_HASH,
      authoredEffectiveAtUtc: T1,
      arrivalDueAtUtc: T3,
      proposal: PROPOSAL,
      createdAtUtc: T2,
    });
    seedEncryptedReply(database, envelope, {
      agentId: "agent-event-failure",
      incomingLetterId: "incoming-event-failure",
      replyLetterId: "reply-event-failure",
      threadId: "thread-event-failure",
    });
    new CorrespondenceRepository(database).markDelivered(
      "reply-event-failure",
      T3,
      T4,
    );
    database.exec(`
      CREATE TRIGGER fail_correspondence_open_event
      BEFORE INSERT ON domain_events
      WHEN NEW.event_type = 'letter.opened'
      BEGIN
        SELECT RAISE(ABORT, 'forced open event failure');
      END
    `);

    expect(() =>
      new CorrespondenceOpenService(database, crypto).openLetter({
        letterId: "reply-event-failure",
        agentId: "agent-event-failure",
        openedAtUtc: T4,
      }),
    ).toThrow(/forced open event failure/iu);
    expect(
      database
        .prepare(
          "SELECT status, opened_at_utc FROM letters WHERE id = 'reply-event-failure'",
        )
        .get(),
    ).toEqual({ status: "delivered_unread", opened_at_utc: null });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
           WHERE idempotency_key = 'letter-open:reply-event-failure'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});

function requireCrypto(database: Database): CorrespondenceCryptoService {
  const crypto = CorrespondenceCryptoService.initialize(database, {
    mode: "enforced",
    instanceSecret: INSTANCE_SECRET,
    nowUtc: T0,
  });
  if (crypto === undefined) throw new Error("Expected correspondence crypto");
  return crypto;
}

function seedEncryptedReply(
  database: Database,
  encryptedBody: EncryptedLetterBody,
  ids: {
    agentId: string;
    threadId: string;
    incomingLetterId: string;
    replyLetterId: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO characters(
         id, current_version, status, tier, name, source_type,
         created_at_utc, updated_at_utc
       ) VALUES (?, 1, 'published', 'daily', 'Crypto Agent', 'original', ?, ?)`,
    )
    .run(ids.agentId, T0, T0);
  database
    .prepare(
      `INSERT INTO correspondence_threads(
         id, agent_id, status, created_at_utc, updated_at_utc
       ) VALUES (?, ?, 'open', ?, ?)`,
    )
    .run(ids.threadId, ids.agentId, T0, T0);
  database
    .prepare(
      `INSERT INTO letters(
         id, thread_id, agent_id, direction, status, body, content_hash,
         transit_policy_version, transit_timezone, dispatched_at_utc,
         arrival_due_at_utc, effective_author_time_utc,
         delivered_effective_at_utc, processed_at_utc, read_at_utc,
         created_at_utc, updated_at_utc
       ) VALUES (
         ?, ?, ?, 'user_to_agent', 'read', 'An incoming letter', ?,
         'fixed_5d_v1', 'Asia/Shanghai', ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      ids.incomingLetterId,
      ids.threadId,
      ids.agentId,
      INCOMING_HASH,
      T0,
      T1,
      T0,
      T1,
      T2,
      T1,
      T0,
      T2,
    );
  database
    .prepare(
      `INSERT INTO letters(
         id, thread_id, agent_id, reply_to_letter_id, direction, status,
         content_hash, encrypted_ciphertext, encrypted_iv,
         encrypted_auth_tag, encrypted_key_version, encrypted_aad_hash,
         encrypted_created_at_utc, transit_policy_version, transit_timezone,
         dispatched_at_utc, arrival_due_at_utc, effective_author_time_utc,
         created_at_utc, updated_at_utc
       ) VALUES (
         ?, ?, ?, ?, 'agent_to_user', 'in_transit', ?, ?, ?, ?, ?, ?, ?,
         'fixed_5d_v1', 'Asia/Shanghai', ?, ?, ?, ?, ?
       )`,
    )
    .run(
      ids.replyLetterId,
      ids.threadId,
      ids.agentId,
      ids.incomingLetterId,
      CONTENT_HASH,
      encryptedBody.ciphertext,
      encryptedBody.iv,
      encryptedBody.authTag,
      encryptedBody.keyVersion,
      encryptedBody.aadHash,
      encryptedBody.createdAtUtc,
      T2,
      T3,
      T1,
      T2,
      T2,
    );
}

function fakeEncryptedBody(letterId: string): EncryptedLetterBody {
  return {
    letterId,
    ciphertext: Buffer.from("fake ciphertext", "utf8").toString("base64"),
    iv: Buffer.alloc(12, 1).toString("base64"),
    authTag: Buffer.alloc(16, 2).toString("base64"),
    keyVersion: 1,
    aadHash: "d".repeat(64),
    createdAtUtc: T2,
  };
}

function flipBase64Byte(value: string): string {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) throw new Error("Expected non-empty Base64 value");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return bytes.toString("base64");
}

function flipHexDigit(value: string): string {
  return `${value.startsWith("0") ? "1" : "0"}${value.slice(1)}`;
}

function metadataCount(database: Database): number {
  return Number(
    (
      database
        .prepare("SELECT COUNT(*) AS count FROM correspondence_key_metadata")
        .get() as { count: number }
    ).count,
  );
}

function expectStartupError(
  operation: () => unknown,
  code: CorrespondenceCryptoStartupErrorCode,
): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CorrespondenceCryptoStartupError);
  expect((caught as CorrespondenceCryptoStartupError).code).toBe(code);
}

function expectOpenError(
  operation: () => unknown,
  code: CorrespondenceOpenErrorCode,
): void {
  expect(captureOpenError(operation).code).toBe(code);
}

function captureOpenError(operation: () => unknown): CorrespondenceOpenError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CorrespondenceOpenError);
  return caught as CorrespondenceOpenError;
}
