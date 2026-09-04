import { createHash } from "node:crypto";

import type { LetterGenerationContextV1 } from "@personasim/contracts";
import {
  canonicalLetterContent,
  canonicalLetterGenerationSnapshot,
} from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { CorrespondenceRepository } from "./correspondence-repository.js";

const AGENT_ID = "agent-repository-validation";
const SENT_AT = "2026-09-03T12:00:00.000Z";
const ARRIVAL_AT = "2026-09-08T12:00:00.000Z";
const PROCESSED_AT = "2026-09-09T01:00:00.000Z";

describe("CorrespondenceRepository write-boundary validation", () => {
  let database: Database;
  let repository: CorrespondenceRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedAgent(database);
    repository = new CorrespondenceRepository(database);
  });

  afterEach(() => database.close());

  it("rejects invalid delivery and claim times before any row is mutated", () => {
    const { letterId, taskId } = seedInTransitLetter(repository);

    expect(() =>
      repository.markDelivered({
        letterId,
        effectiveAtUtc: ARRIVAL_AT,
        processedAtUtc: "not-a-date",
      }),
    ).toThrow(/processedAtUtc/u);
    expect(
      database
        .prepare(
          `SELECT status, delivered_effective_at_utc, processed_at_utc
           FROM letters WHERE id = ?`,
        )
        .get(letterId),
    ).toEqual({
      status: "in_transit",
      delivered_effective_at_utc: null,
      processed_at_utc: null,
    });

    expect(() =>
      repository.claimDueTask({
        taskId,
        agentId: AGENT_ID,
        nowUtc: "not-a-date",
        leaseExpiresAtUtc: "2026-09-09T01:30:00.000Z",
        claimToken: "claim-invalid-time",
      }),
    ).toThrow(/nowUtc/u);
    expect(
      database
        .prepare(
          `SELECT status, claim_token, claimed_at_utc
           FROM temporal_tasks WHERE id = ?`,
        )
        .get(taskId),
    ).toEqual({
      status: "pending",
      claim_token: null,
      claimed_at_utc: null,
    });
  });

  it("uses canonical JSON for task idempotency and rejects undefined payloads", () => {
    const first = repository.createTemporalTask({
      id: "task-canonical-payload",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-canonical-payload",
      dueAtUtc: ARRIVAL_AT,
      priority: 20,
      idempotencyKey: "canonical-task-payload",
      payload: { é: 2, a: { 中: true, z: false } },
      createdAtUtc: SENT_AT,
    });
    const replay = repository.createTemporalTask({
      id: first.id,
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-canonical-payload",
      dueAtUtc: ARRIVAL_AT,
      priority: 20,
      idempotencyKey: "canonical-task-payload",
      payload: { a: { z: false, 中: true }, é: 2 },
      createdAtUtc: SENT_AT,
    });

    expect(replay).toEqual(first);
    expect(() =>
      repository.createTemporalTask({
        id: "task-invalid-json",
        agentId: AGENT_ID,
        kind: "letter.reply_generation",
        entityId: "letter-invalid-json",
        dueAtUtc: ARRIVAL_AT,
        priority: 20,
        idempotencyKey: "invalid-task-payload",
        payload: { forbidden: undefined },
        createdAtUtc: SENT_AT,
      }),
    ).toThrow();
    expect(repository.getTask("task-invalid-json")).toBeUndefined();
  });

  it("replays an immutable snapshot despite nested object insertion order", () => {
    const { letterId } = seedInTransitLetter(repository);
    repository.markDelivered({
      letterId,
      effectiveAtUtc: ARRIVAL_AT,
      processedAtUtc: PROCESSED_AT,
    });
    repository.markRead({ letterId, readAtUtc: ARRIVAL_AT });
    const firstContext = context({ é: "accent", a: "first" });
    const replayContext = context({ a: "first", é: "accent" });
    const evidenceIds = ["evidence-before-arrival"];
    const contextHash = sha256(
      canonicalLetterGenerationSnapshot({
        contextJson: firstContext,
        evidenceIds,
      }),
    );
    const first = repository.insertSnapshot({
      id: "snapshot-canonical-replay",
      incomingLetterId: letterId,
      agentId: AGENT_ID,
      effectiveAtUtc: ARRIVAL_AT,
      characterVersion: 1,
      stateRevision: 0,
      contextJson: firstContext,
      evidenceIds,
      contextHash,
      createdAtUtc: PROCESSED_AT,
    });

    const replay = repository.insertSnapshot({
      id: first.id,
      incomingLetterId: letterId,
      agentId: AGENT_ID,
      effectiveAtUtc: ARRIVAL_AT,
      characterVersion: 1,
      stateRevision: 0,
      contextJson: replayContext,
      evidenceIds,
      contextHash,
      createdAtUtc: PROCESSED_AT,
    });

    expect(replay.id).toBe(first.id);
    expect(replay.contextHash).toBe(contextHash);
  });
});

function seedInTransitLetter(repository: CorrespondenceRepository): {
  letterId: string;
  taskId: string;
} {
  const thread = repository.createThread(AGENT_ID, {
    id: "thread-repository-validation",
    nowUtc: SENT_AT,
  });
  const subject = "边界校验";
  const body = "这封信用于验证持久化边界。";
  const letter = repository.createDraftLetter({
    id: "letter-repository-validation",
    threadId: thread.id,
    agentId: AGENT_ID,
    subject,
    body,
    nowUtc: SENT_AT,
  });
  const sealed = repository.sealLetter({
    letterId: letter.id,
    contentHash: sha256(canonicalLetterContent({ subject, body })),
    transitPolicyVersion: "fixed_5d_v1",
    transitTimezone: "Asia/Shanghai",
    dispatchedAtUtc: SENT_AT,
    arrivalDueAtUtc: ARRIVAL_AT,
    effectiveAuthorTimeUtc: SENT_AT,
    taskId: "task-repository-validation",
  });
  return { letterId: sealed.letter.id, taskId: sealed.task.id };
}

function context(identity: Record<string, string>): LetterGenerationContextV1 {
  return {
    schemaVersion: 1,
    effectiveAtUtc: ARRIVAL_AT,
    sourceWindow: { fromUtc: SENT_AT, throughUtc: ARRIVAL_AT },
    character: {
      version: 1,
      identity,
      persona: {},
      dialogue: {},
      userRelationship: {},
      knowledge: {},
    },
    runtimeState: {},
    relationship: {},
    fuzzyLife: {
      dailyContext: null,
      intents: [],
      threads: [],
      verifiedOutcomes: [],
      causalRecords: [],
    },
    intervalDigest: { activityEvents: [], lifeOutcomes: [] },
    memoryEvidence: [],
    conversationTail: [],
    priorCorrespondence: [],
    budgets: {},
  };
}

function seedAgent(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
         id, current_version, status, tier, name, source_type,
         created_at_utc, updated_at_utc
       ) VALUES (?, 1, 'published', 'high_fidelity', 'Boundary Agent',
         'original', ?, ?)`,
    )
    .run(AGENT_ID, SENT_AT, SENT_AT);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
