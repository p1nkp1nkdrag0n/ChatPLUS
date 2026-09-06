import { createHash } from "node:crypto";

import { canonicalLetterGenerationSnapshot } from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import {
  CorrespondenceRepository,
  type CommitGenerationRunInput,
  type CorrespondenceRepositoryErrorCode,
  type LetterGenerationSnapshot,
  type SealLetterInput,
} from "./correspondence-repository.js";

const AGENT_ID = "agent-correspondence";
const T0 = "2026-09-03T12:00:00.000Z";
const T1 = "2026-09-08T12:00:00.000Z";
const T2 = "2026-09-09T01:00:00.000Z";
const T3 = "2026-09-13T12:00:00.000Z";
const T4 = "2026-09-15T02:00:00.000Z";
const CONTENT_HASH = "a".repeat(64);
const REPLY_HASH = "b".repeat(64);
const CONTEXT_HASH = "c".repeat(64);
const AAD_HASH = "d".repeat(64);
const SNAPSHOT_CONTEXT = {
  schemaVersion: 1,
  effectiveAtUtc: T1,
  sourceWindow: { fromUtc: T0, throughUtc: T1 },
  character: {
    version: 3,
    identity: { name: "Correspondent" },
    persona: { temperament: "reflective" },
    dialogue: { style: "letter" },
    userRelationship: { relationshipType: "friend" },
    knowledge: { cutoffUtc: T1 },
  },
  runtimeState: { mood: "calm" },
  relationship: { trust: 0.6 },
  fuzzyLife: {
    dailyContext: null,
    intents: [],
    threads: [],
    verifiedOutcomes: [],
    causalRecords: [],
  },
  intervalDigest: { activityEvents: [], lifeOutcomes: [] },
  memoryEvidence: [{ id: "evidence-before-arrival", effectiveAtUtc: T1 }],
  conversationTail: [],
  priorCorrespondence: [],
  budgets: { evidenceLimit: 2_000 },
} satisfies LetterGenerationSnapshot["contextJson"];

describe("CorrespondenceRepository", () => {
  let database: Database;
  let repository: CorrespondenceRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedAgent(database);
    repository = new CorrespondenceRepository(database);
  });

  afterEach(() => database.close());

  it("creates one open thread and makes seal and arrival transitions idempotent", () => {
    const thread = repository.createThread(AGENT_ID, {
      id: "thread-main",
      nowUtc: T0,
    });
    expect(repository.openThread(AGENT_ID, { nowUtc: T1 })).toEqual(thread);

    const draftInput = {
      id: "letter-user-1",
      threadId: thread.id,
      agentId: AGENT_ID,
      body: "I am writing before the trip.",
      subject: "Before departure",
      clientRequestId: "request-create-1",
      nowUtc: T0,
    } as const;
    const draft = repository.createDraftLetter(draftInput);
    expect(repository.createDraftLetter(draftInput)).toEqual(draft);
    expectRepositoryError(
      () =>
        repository.createDraftLetter({
          ...draftInput,
          id: "letter-user-conflict",
          body: "Different request body.",
        }),
      "idempotency_conflict",
    );
    expect(repository.getThread(thread.id)).toMatchObject({
      rootLetterId: draft.id,
      latestLetterId: draft.id,
    });
    expect(
      repository.updateDraftLetter(draft.id, {
        body: "I am writing before the long trip.",
        updatedAtUtc: T0,
      }).body,
    ).toBe("I am writing before the long trip.");

    const sealInput: SealLetterInput = {
      letterId: draft.id,
      contentHash: CONTENT_HASH,
      transitPolicyVersion: "fixed_5d_v1",
      transitTimezone: "Asia/Shanghai",
      dispatchedAtUtc: T0,
      arrivalDueAtUtc: T1,
      clientRequestId: "request-seal-1",
      taskId: "task-outbound-arrival",
    };
    const sealed = repository.sealLetter(sealInput);
    expect(sealed).toMatchObject({
      replayed: false,
      letter: { status: "in_transit", arrivalDueAtUtc: T1 },
      task: {
        kind: "letter.outbound_arrival",
        idempotencyKey: `letter-arrival:${draft.id}`,
      },
    });
    expect(repository.sealLetter(sealInput)).toMatchObject({
      replayed: true,
      letter: { id: draft.id },
      task: { id: sealed.task.id },
    });
    expect(count(database, "letters")).toBe(1);
    expect(count(database, "temporal_tasks")).toBe(1);

    expectRepositoryError(
      () =>
        repository.updateDraftLetter(draft.id, {
          body: "changed after seal",
          updatedAtUtc: T1,
        }),
      "immutable_letter",
    );
    expect(() =>
      database
        .prepare("UPDATE letters SET body = ? WHERE id = ?")
        .run("direct tampering", draft.id),
    ).toThrow(/immutable/iu);

    const delivered = repository.markDelivered(draft.id, T1, T2);
    expect(delivered).toMatchObject({
      status: "delivered_unread",
      deliveredEffectiveAtUtc: T1,
      processedAtUtc: T2,
    });
    expect(repository.markDelivered(draft.id, T1, T4)).toEqual(delivered);
    expectRepositoryError(
      () => repository.markRead(draft.id, T2),
      "invariant_violation",
    );
    const read = repository.markRead(draft.id, T1);
    expect(read).toMatchObject({
      status: "read",
      deliveredEffectiveAtUtc: T1,
      processedAtUtc: T2,
      readAtUtc: T1,
    });
    expect(repository.markRead(draft.id, T4)).toEqual(read);
    expect(repository.listLetters(AGENT_ID)).toEqual([read]);
  });

  it("keyset-paginates letters in stable list order without overlap", () => {
    const thread = repository.createThread(AGENT_ID, {
      id: "thread-page",
      nowUtc: T0,
    });
    const insertCancelled = database.prepare(
      `INSERT INTO letters (
         id, thread_id, agent_id, direction, status, body,
         created_at_utc, updated_at_utc
       ) VALUES (?, ?, ?, 'user_to_agent', 'cancelled', ?, ?, ?)`,
    );
    const timestamps = [T2, T2, T2, T2, T1, T1, T0];
    timestamps.forEach((createdAtUtc, index) => {
      insertCancelled.run(
        `letter-page-${index}`,
        thread.id,
        AGENT_ID,
        `cancelled ${index}`,
        createdAtUtc,
        createdAtUtc,
      );
    });

    const expectedIds = repository
      .listLetters(AGENT_ID, { limit: 500 })
      .map((letter) => letter.id);
    const firstPage = repository.listLetterPage(AGENT_ID, { limit: 3 });
    expect(firstPage.items.map((letter) => letter.id)).toEqual(
      expectedIds.slice(0, 3),
    );
    expect(firstPage.nextCursor).toBeDefined();

    // A newer concurrent insert belongs before the first-page boundary and
    // must not shift or duplicate any item in this ongoing traversal.
    insertCancelled.run(
      "letter-page-concurrent-newer",
      thread.id,
      AGENT_ID,
      "concurrent newer",
      T3,
      T3,
    );

    const collectedIds = [...firstPage.items.map((letter) => letter.id)];
    let cursor = firstPage.nextCursor;
    while (cursor !== undefined) {
      const page = repository.listLetterPage(AGENT_ID, {
        limit: 3,
        cursor,
      });
      collectedIds.push(...page.items.map((letter) => letter.id));
      cursor = page.nextCursor;
    }
    expect(collectedIds).toEqual(expectedIds);
    expect(new Set(collectedIds).size).toBe(collectedIds.length);
    expect(collectedIds).not.toContain("letter-page-concurrent-newer");
  });

  it("freezes one snapshot and commits one encrypted reply across retries", () => {
    const incoming = createReadIncoming(repository);
    const snapshotInput = {
      id: "snapshot-incoming-1",
      incomingLetterId: incoming.id,
      agentId: AGENT_ID,
      effectiveAtUtc: T1,
      characterVersion: 3,
      stateRevision: 7,
      contextJson: SNAPSHOT_CONTEXT,
      evidenceIds: ["evidence-before-arrival"],
      contextHash: CONTEXT_HASH,
      createdAtUtc: T2,
    } as const;
    expectRepositoryError(
      () =>
        repository.insertSnapshot({
          ...snapshotInput,
          id: "snapshot-wrong-effective-time",
          effectiveAtUtc: T2,
        }),
      "invariant_violation",
    );
    expect(count(database, "letter_generation_snapshots")).toBe(0);
    const snapshot = repository.insertSnapshot(snapshotInput);
    expect(repository.insertSnapshot(snapshotInput)).toEqual(snapshot);
    expectRepositoryError(
      () =>
        repository.insertSnapshot({
          ...snapshotInput,
          id: "snapshot-conflict",
          contextHash: "e".repeat(64),
        }),
      "idempotency_conflict",
    );
    expect(() =>
      database
        .prepare(
          "UPDATE letter_generation_snapshots SET state_revision = 8 WHERE id = ?",
        )
        .run(snapshot.id),
    ).toThrow(/immutable/iu);

    const firstClaim = repository.claimGenerationRun({
      id: "run-incoming-1",
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      snapshotHash: CONTEXT_HASH,
      agentId: AGENT_ID,
      generationEpoch: 0,
      claimToken: "generation-claim-1",
      nowUtc: T2,
      leaseExpiresAtUtc: "2026-09-09T01:10:00.000Z",
      provider: "fixture",
      model: "fixture-v1",
    });
    expect(firstClaim).toMatchObject({ status: "generating", attempt: 1 });
    expect(
      repository.claimGenerationRun({
        incomingLetterId: incoming.id,
        snapshotId: snapshot.id,
        snapshotHash: CONTEXT_HASH,
        agentId: AGENT_ID,
        generationEpoch: 0,
        claimToken: "generation-claim-racing",
        nowUtc: "2026-09-09T01:05:00.000Z",
        leaseExpiresAtUtc: "2026-09-09T01:15:00.000Z",
      }),
    ).toBeUndefined();

    const retry = repository.retryGenerationRun({
      runId: firstClaim!.id,
      claimToken: "generation-claim-1",
      generationEpoch: 0,
      errorCode: "provider_timeout",
      nowUtc: "2026-09-09T01:06:00.000Z",
    });
    expect(retry).toMatchObject({
      status: "retryable",
      errorCode: "provider_timeout",
    });
    expect(
      repository.retryGenerationRun({
        runId: firstClaim!.id,
        claimToken: "generation-claim-1",
        generationEpoch: 0,
        errorCode: "provider_timeout",
        nowUtc: "2026-09-09T01:06:00.000Z",
      }),
    ).toEqual(retry);

    const secondClaim = repository.claimGenerationRun({
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      snapshotHash: CONTEXT_HASH,
      agentId: AGENT_ID,
      generationEpoch: 0,
      claimToken: "generation-claim-2",
      nowUtc: "2026-09-09T01:20:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T01:30:00.000Z",
    });
    expect(secondClaim).toMatchObject({ status: "generating", attempt: 2 });

    const commitInput: CommitGenerationRunInput = {
      runId: secondClaim!.id,
      claimToken: "generation-claim-2",
      generationEpoch: 0,
      snapshotHash: CONTEXT_HASH,
      nowUtc: "2026-09-09T01:21:00.000Z",
      replyLetterId: "letter-reply-1",
      contentHash: REPLY_HASH,
      transitPolicyVersion: "fixed_5d_v1",
      transitTimezone: "Asia/Shanghai",
      effectiveAuthorTimeUtc: T1,
      arrivalDueAtUtc: T3,
      encryptedBody: {
        ciphertext: "YWJjZA==",
        iv: "MTIzNDU2Nzg5MDEy",
        authTag: "YWJjZGVmZ2hpamtsbW5vcA==",
        keyVersion: 1,
        aadHash: AAD_HASH,
        createdAtUtc: "2026-09-09T01:21:00.000Z",
      },
      taskId: "task-return-arrival",
    };
    const committed = repository.commitGenerationRun(commitInput);
    expect(committed).toMatchObject({
      replayed: false,
      run: { status: "committed", attempt: 2 },
      reply: {
        direction: "agent_to_user",
        status: "in_transit",
        replyToLetterId: incoming.id,
        contentHash: REPLY_HASH,
      },
      task: { kind: "letter.return_arrival", dueAtUtc: T3 },
    });
    expect(committed.reply.body).toBeUndefined();
    expect(committed.reply.encryptedBody).toMatchObject({
      ciphertext: "YWJjZA==",
      aadHash: AAD_HASH,
    });
    expect(repository.commitGenerationRun(commitInput)).toMatchObject({
      replayed: true,
      reply: { id: committed.reply.id },
      task: { id: committed.task.id },
    });
    expect(repository.findReplyToLetter(incoming.id)).toEqual(committed.reply);
    expect(repository.findReplyToLetter("letter-without-reply")).toBe(
      undefined,
    );
    const nextTurnDraft = {
      id: "letter-next-turn",
      threadId: incoming.threadId,
      agentId: AGENT_ID,
      replyToLetterId: committed.reply.id,
      body: "A next letter must wait until the reply is opened.",
      clientRequestId: "request-next-turn",
      nowUtc: T4,
    } as const;
    expectRepositoryError(
      () => repository.createDraftLetter(nextTurnDraft),
      "invariant_violation",
    );
    repository.markDelivered(committed.reply.id, T3, T4);
    expectRepositoryError(
      () => repository.createDraftLetter(nextTurnDraft),
      "invariant_violation",
    );
    const opened = repository.markOpened(committed.reply.id, T2);
    expect(
      repository.markOpened(committed.reply.id, "2026-09-15T03:00:00.000Z"),
    ).toEqual(opened);
    expect(opened).toMatchObject({
      status: "read",
      openedAtUtc: T4,
    });
    expect(opened.readAtUtc).toBeUndefined();
    expect(repository.createDraftLetter(nextTurnDraft)).toMatchObject({
      id: nextTurnDraft.id,
      status: "draft",
    });
    expect(count(database, "letter_generation_snapshots")).toBe(1);
    expect(count(database, "letter_generation_runs")).toBe(1);
    expect(
      scalar(
        database,
        "SELECT COUNT(*) AS count FROM letters WHERE reply_to_letter_id = ?",
        incoming.id,
      ),
    ).toBe(1);
    expect(count(database, "temporal_tasks")).toBe(2);
    expect(() =>
      database
        .prepare("DELETE FROM correspondence_threads WHERE id = ?")
        .run(incoming.threadId),
    ).toThrow(/FOREIGN KEY/iu);
    database.prepare("DELETE FROM characters WHERE id = ?").run(AGENT_ID);
    expect(count(database, "correspondence_threads")).toBe(0);
    expect(count(database, "letters")).toBe(0);
    expect(count(database, "letter_generation_snapshots")).toBe(0);
    expect(count(database, "letter_generation_runs")).toBe(0);
    expect(count(database, "temporal_tasks")).toBe(0);
  });

  it("claims due tasks with a database lease and idempotently retries/completes", () => {
    seedAgent(database, "agent-other-scope");
    const otherTask = repository.createTemporalTask({
      id: "task-other-scope",
      agentId: "agent-other-scope",
      kind: "letter.reply_generation",
      entityId: "letter-other",
      dueAtUtc: T1,
      priority: 20,
      idempotencyKey: "letter-reply-run:letter-other:v1",
      maxAttempts: 1,
      createdAtUtc: T0,
    });
    repository.claimDueTask({
      nowUtc: T2,
      leaseExpiresAtUtc: "2026-09-09T01:10:00.000Z",
      claimToken: "task-other-claim",
      agentId: "agent-other-scope",
    });
    const otherNextTask = repository.createTemporalTask({
      id: "task-other-next",
      agentId: "agent-other-scope",
      kind: "letter.generation_retry",
      entityId: "letter-other-next",
      dueAtUtc: T1,
      priority: 40,
      idempotencyKey: "letter-generation-retry:letter-other-next:v1",
      createdAtUtc: T0,
    });
    const taskInput = {
      id: "task-lease-1",
      agentId: AGENT_ID,
      kind: "letter.reply_generation" as const,
      entityId: "letter-user-1",
      dueAtUtc: T1,
      priority: 20,
      idempotencyKey: "letter-reply-run:letter-user-1:v1",
      maxAttempts: 3,
      createdAtUtc: T0,
    };
    const task = repository.createTemporalTask(taskInput);
    expect(repository.createTemporalTask(taskInput)).toEqual(task);
    expectRepositoryError(
      () => repository.createTemporalTask({ ...taskInput, priority: 21 }),
      "idempotency_conflict",
    );
    expectRepositoryError(
      () =>
        repository.createTemporalTask({
          ...taskInput,
          payload: { changed: true },
        }),
      "idempotency_conflict",
    );
    expectRepositoryError(
      () => repository.createTemporalTask({ ...taskInput, maxAttempts: 4 }),
      "idempotency_conflict",
    );

    const claimed = repository.claimDueTask({
      nowUtc: T2,
      leaseExpiresAtUtc: "2026-09-09T01:10:00.000Z",
      claimToken: "task-claim-1",
      agentId: AGENT_ID,
    });
    expect(claimed).toMatchObject({
      id: task.id,
      status: "claimed",
      claimToken: "task-claim-1",
      attempt: 1,
    });
    expect(repository.findEarliestDueTask(AGENT_ID, T2)).toMatchObject({
      id: task.id,
      status: "claimed",
      claimToken: "task-claim-1",
    });
    expect(
      repository.claimDueTask({
        nowUtc: "2026-09-09T01:01:00.000Z",
        leaseExpiresAtUtc: "2026-09-09T01:11:00.000Z",
        claimToken: "task-claim-1",
        agentId: AGENT_ID,
      }),
    ).toEqual(claimed);
    const nextTask = repository.createTemporalTask({
      id: "task-next-candidate",
      agentId: AGENT_ID,
      kind: "letter.generation_retry",
      entityId: "letter-next",
      dueAtUtc: T1,
      priority: 40,
      idempotencyKey: "letter-generation-retry:letter-next:v1",
      createdAtUtc: T0,
    });
    expect(
      repository.claimDueTask({
        taskId: task.id,
        nowUtc: "2026-09-09T01:05:00.000Z",
        leaseExpiresAtUtc: "2026-09-09T01:15:00.000Z",
        claimToken: "task-claim-racing",
        agentId: AGENT_ID,
      }),
    ).toBeUndefined();
    expect(repository.getTask(nextTask.id)).toMatchObject({
      status: "pending",
    });
    expect(
      repository.findEarliestDueTask(AGENT_ID, "2026-09-09T01:11:00.000Z"),
    ).toMatchObject({ id: task.id, status: "claimed" });

    const reclaimed = repository.claimDueTask({
      taskId: task.id,
      nowUtc: "2026-09-09T01:11:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T01:20:00.000Z",
      claimToken: "task-claim-2",
      agentId: AGENT_ID,
    });
    expect(reclaimed).toMatchObject({
      id: task.id,
      claimToken: "task-claim-2",
      attempt: 2,
    });
    expect(repository.getTask(otherTask.id)).toMatchObject({
      status: "claimed",
      claimToken: "task-other-claim",
    });
    expect(
      repository.findEarliestDueTask(
        "agent-other-scope",
        "2026-09-09T01:11:00.000Z",
      ),
    ).toMatchObject({
      id: otherTask.id,
      status: "claimed",
      attempt: 1,
    });
    expect(
      repository.claimDueTask({
        taskId: otherTask.id,
        nowUtc: "2026-09-09T01:11:00.000Z",
        leaseExpiresAtUtc: "2026-09-09T01:20:00.000Z",
        claimToken: "task-other-reaper",
        agentId: "agent-other-scope",
      }),
    ).toBeUndefined();
    expect(repository.getTask(otherTask.id)).toMatchObject({
      status: "dead_letter",
      attempt: 1,
    });
    expect(repository.getTask(otherTask.id)?.claimToken).toBeUndefined();
    expect(
      repository.findEarliestDueTask(
        "agent-other-scope",
        "2026-09-09T01:11:00.000Z",
      ),
    ).toMatchObject({ id: otherNextTask.id, status: "pending" });
    expect(
      repository.claimDueTask({
        taskId: otherNextTask.id,
        nowUtc: "2026-09-09T01:11:00.000Z",
        leaseExpiresAtUtc: "2026-09-09T01:20:00.000Z",
        claimToken: "task-other-next-claim",
        agentId: "agent-other-scope",
      }),
    ).toMatchObject({
      id: otherNextTask.id,
      status: "claimed",
      claimToken: "task-other-next-claim",
    });
    const retry = repository.retryTask({
      taskId: task.id,
      claimToken: "task-claim-2",
      errorCode: "temporary_failure",
      nowUtc: "2026-09-09T01:12:00.000Z",
      nextDueAtUtc: "2026-09-09T01:30:00.000Z",
    });
    expect(retry).toMatchObject({
      status: "retryable",
      attempt: 2,
      lastErrorCode: "temporary_failure",
    });
    expect(
      repository.retryTask({
        taskId: task.id,
        claimToken: "task-claim-2",
        errorCode: "temporary_failure",
        nowUtc: "2026-09-09T01:12:00.000Z",
        nextDueAtUtc: "2026-09-09T01:30:00.000Z",
      }),
    ).toEqual(retry);
    expectRepositoryError(
      () =>
        repository.retryTask({
          taskId: task.id,
          claimToken: "task-claim-2",
          errorCode: "temporary_failure",
          nowUtc: "2026-09-09T01:13:00.000Z",
          nextDueAtUtc: "2026-09-09T01:31:00.000Z",
        }),
      "idempotency_conflict",
    );

    const finalClaim = repository.claimDueTask({
      taskId: task.id,
      nowUtc: "2026-09-09T01:31:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T01:40:00.000Z",
      claimToken: "task-claim-3",
      agentId: AGENT_ID,
    });
    expect(finalClaim).toMatchObject({ status: "claimed", attempt: 3 });
    const completed = repository.completeTask({
      taskId: task.id,
      claimToken: "task-claim-3",
      completedAtUtc: "2026-09-09T01:32:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "completed",
      completedAtUtc: "2026-09-09T01:32:00.000Z",
    });
    expect(
      repository.completeTask({
        taskId: task.id,
        claimToken: "stale-token-is-safe-after-completion",
        completedAtUtc: T4,
      }),
    ).toEqual(completed);
    expect(repository.listTasks(AGENT_ID)).toContainEqual(completed);
  });

  it("fails non-retryable work immediately and atomically reaps an exhausted generation pair", () => {
    const incoming = createReadIncoming(repository);
    const snapshot = repository.insertSnapshot({
      id: "snapshot-failure-disposition",
      incomingLetterId: incoming.id,
      agentId: AGENT_ID,
      effectiveAtUtc: T1,
      characterVersion: 3,
      stateRevision: 7,
      contextJson: SNAPSHOT_CONTEXT,
      evidenceIds: ["evidence-before-arrival"],
      contextHash: CONTEXT_HASH,
      createdAtUtc: T2,
    });
    const nonRetryableRun = repository.claimGenerationRun({
      id: "run-non-retryable",
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contextHash,
      agentId: AGENT_ID,
      generationEpoch: 0,
      claimToken: "run-non-retryable-claim",
      nowUtc: "2026-09-09T02:00:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T02:10:00.000Z",
    });
    const failedRun = repository.retryGenerationRun({
      runId: nonRetryableRun!.id,
      claimToken: "run-non-retryable-claim",
      generationEpoch: 0,
      errorCode: "snapshot_hash_mismatch",
      resultHash: "f".repeat(64),
      nowUtc: "2026-09-09T02:01:00.000Z",
      retryable: false,
    });
    expect(failedRun).toMatchObject({
      status: "failed",
      attempt: 1,
      errorCode: "snapshot_hash_mismatch",
      resultHash: "f".repeat(64),
    });
    expect(repository.getGenerationRunForEpoch(incoming.id, 0)).toEqual(
      failedRun,
    );
    expect(
      repository.retryGenerationRun({
        runId: nonRetryableRun!.id,
        claimToken: "stale-token-on-replay",
        generationEpoch: 0,
        errorCode: "snapshot_hash_mismatch",
        resultHash: "f".repeat(64),
        nowUtc: "2026-09-09T02:02:00.000Z",
        retryable: false,
      }),
    ).toEqual(failedRun);
    expectRepositoryError(
      () =>
        repository.retryGenerationRun({
          runId: nonRetryableRun!.id,
          claimToken: "stale-token-on-conflict",
          generationEpoch: 0,
          errorCode: "snapshot_hash_mismatch",
          nowUtc: "2026-09-09T02:03:00.000Z",
        }),
      "idempotency_conflict",
    );

    const runClaim1 = repository.claimGenerationRun({
      id: "run-final-crash",
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contextHash,
      agentId: AGENT_ID,
      generationEpoch: 1,
      claimToken: "run-final-claim-1",
      nowUtc: "2026-09-09T02:10:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T02:20:00.000Z",
    });
    repository.retryGenerationRun({
      runId: runClaim1!.id,
      claimToken: "run-final-claim-1",
      generationEpoch: 1,
      errorCode: "provider_timeout",
      nowUtc: "2026-09-09T02:11:00.000Z",
    });
    const runClaim2 = repository.claimGenerationRun({
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contextHash,
      agentId: AGENT_ID,
      generationEpoch: 1,
      claimToken: "run-final-claim-2",
      nowUtc: "2026-09-09T02:30:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T02:40:00.000Z",
    });
    repository.retryGenerationRun({
      runId: runClaim2!.id,
      claimToken: "run-final-claim-2",
      generationEpoch: 1,
      errorCode: "provider_timeout",
      nowUtc: "2026-09-09T02:31:00.000Z",
    });
    const finalRunClaim = repository.claimGenerationRun({
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contextHash,
      agentId: AGENT_ID,
      generationEpoch: 1,
      claimToken: "run-final-claim-3",
      nowUtc: "2026-09-09T02:50:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T03:00:00.000Z",
    });
    expect(finalRunClaim).toMatchObject({
      status: "generating",
      attempt: 3,
    });
    const generationTask = repository.createTemporalTask({
      id: "task-final-crash",
      agentId: AGENT_ID,
      kind: "letter.generation_retry",
      entityId: incoming.id,
      dueAtUtc: "2026-09-09T02:00:00.000Z",
      priority: 20,
      idempotencyKey: `letter-generation-retry:${incoming.id}:epoch-1`,
      maxAttempts: 1,
      createdAtUtc: T2,
    });
    repository.claimDueTask({
      taskId: generationTask.id,
      agentId: AGENT_ID,
      nowUtc: "2026-09-09T02:50:00.000Z",
      leaseExpiresAtUtc: "2026-09-09T03:00:00.000Z",
      claimToken: "task-final-crash-claim",
    });
    expect(
      repository.claimDueTask({
        taskId: generationTask.id,
        agentId: AGENT_ID,
        nowUtc: "2026-09-09T03:01:00.000Z",
        leaseExpiresAtUtc: "2026-09-09T03:11:00.000Z",
        claimToken: "task-final-crash-reaper",
      }),
    ).toBeUndefined();
    expect(repository.getTask(generationTask.id)).toMatchObject({
      status: "dead_letter",
      attempt: 1,
    });
    expect(repository.getGenerationRun(finalRunClaim!.id)).toMatchObject({
      status: "failed",
      attempt: 3,
      errorCode: "generation_attempts_exhausted",
    });
    expect(repository.getGenerationRunForEpoch(incoming.id, 1)).toMatchObject({
      id: finalRunClaim!.id,
      status: "failed",
    });

    const nonRetryableTask = repository.createTemporalTask({
      id: "task-non-retryable",
      agentId: AGENT_ID,
      kind: "letter.outbound_arrival",
      entityId: "letter-non-retryable-task",
      dueAtUtc: T1,
      priority: 30,
      idempotencyKey: "letter-non-retryable-task:v1",
      createdAtUtc: T0,
    });
    repository.claimDueTask({
      taskId: nonRetryableTask.id,
      agentId: AGENT_ID,
      nowUtc: T2,
      leaseExpiresAtUtc: "2026-09-09T01:10:00.000Z",
      claimToken: "task-non-retryable-claim",
    });
    const deadTask = repository.retryTask({
      taskId: nonRetryableTask.id,
      claimToken: "task-non-retryable-claim",
      errorCode: "snapshot_hash_mismatch",
      nowUtc: "2026-09-09T01:01:00.000Z",
      retryable: false,
    });
    expect(deadTask).toMatchObject({
      status: "dead_letter",
      dueAtUtc: T1,
      attempt: 1,
      lastErrorCode: "snapshot_hash_mismatch",
    });
    expect(
      repository.retryTask({
        taskId: nonRetryableTask.id,
        claimToken: "stale-task-token",
        errorCode: "snapshot_hash_mismatch",
        nowUtc: "2026-09-09T01:02:00.000Z",
        retryable: false,
      }),
    ).toEqual(deadTask);
    expectRepositoryError(
      () =>
        repository.retryTask({
          taskId: nonRetryableTask.id,
          claimToken: "stale-task-token",
          errorCode: "snapshot_hash_mismatch",
          nowUtc: "2026-09-09T01:03:00.000Z",
          nextDueAtUtc: "2026-09-09T02:00:00.000Z",
        }),
      "idempotency_conflict",
    );
  });

  it("appends idempotent recovery epochs without rewriting failed history", () => {
    const failure = createRecoverableGenerationFailure(repository);
    database
      .prepare(
        `INSERT INTO domain_events(
           id, agent_id, stream_type, stream_id, stream_version, event_type,
           recorded_at_utc, effective_at_utc, payload_json, correlation_id,
           causation_id, idempotency_key
         ) VALUES (
           'event-shadow-observation', ?, 'correspondence_letter', ?, 4,
           'letter.reply_generation_shadow_observed', ?, ?, '{}', ?, NULL,
           'letter-reply-shadow:test:v1'
         )`,
      )
      .run(AGENT_ID, failure.incoming.id, T2, T1, failure.incoming.id);
    const first = repository.enqueueReplyGenerationRetry({
      incomingLetterId: failure.incoming.id,
      clientRequestId: "reply-retry-request-one",
      requestedAtUtc: T3,
    });

    expect(first).toMatchObject({
      incomingLetterId: failure.incoming.id,
      generationEpoch: 1,
      snapshotId: failure.snapshot.id,
      replayed: false,
      task: {
        kind: "letter.generation_retry",
        entityId: failure.incoming.id,
        status: "pending",
        idempotencyKey: `letter-generation-retry:${failure.incoming.id}:epoch-1`,
        payload: {
          incomingLetterId: failure.incoming.id,
          snapshotId: failure.snapshot.id,
          generationEpoch: 1,
        },
      },
    });
    expect(repository.getTask(failure.task.id)).toEqual(failure.task);
    expect(repository.getGenerationRun(failure.run.id)).toEqual(failure.run);

    const replay = repository.enqueueReplyGenerationRetry({
      incomingLetterId: failure.incoming.id,
      clientRequestId: "reply-retry-request-one",
      requestedAtUtc: T4,
    });
    expect(replay).toMatchObject({
      generationEpoch: 1,
      replayed: true,
      task: { id: first.task.id },
    });
    expectRepositoryError(
      () =>
        repository.enqueueReplyGenerationRetry({
          incomingLetterId: failure.incoming.id,
          clientRequestId: "reply-retry-request-two",
          requestedAtUtc: T3,
        }),
      "reply_retry_in_progress",
    );

    const retryClaimToken = "reply-retry-task-claim-one";
    expect(
      repository.claimDueTask({
        taskId: first.task.id,
        agentId: AGENT_ID,
        nowUtc: T3,
        leaseExpiresAtUtc: T4,
        claimToken: retryClaimToken,
      }),
    ).toMatchObject({ status: "claimed", claimToken: retryClaimToken });
    const retryRun = repository.claimGenerationRun({
      incomingLetterId: failure.incoming.id,
      snapshotId: failure.snapshot.id,
      snapshotHash: failure.snapshot.contextHash,
      agentId: AGENT_ID,
      generationEpoch: 1,
      claimToken: retryClaimToken,
      nowUtc: T3,
      leaseExpiresAtUtc: T4,
    });
    const failedRetryRun = repository.retryGenerationRun({
      runId: retryRun!.id,
      claimToken: retryClaimToken,
      generationEpoch: 1,
      errorCode: "second_terminal_failure",
      nowUtc: T3,
      retryable: false,
    });
    repository.retryTask({
      taskId: first.task.id,
      claimToken: retryClaimToken,
      errorCode: "second_terminal_failure",
      nowUtc: T3,
      retryable: false,
    });

    const second = repository.enqueueReplyGenerationRetry({
      incomingLetterId: failure.incoming.id,
      clientRequestId: "reply-retry-request-two",
      requestedAtUtc: T4,
    });
    expect(second).toMatchObject({
      generationEpoch: 2,
      snapshotId: failure.snapshot.id,
      replayed: false,
      task: {
        status: "pending",
        payload: {
          incomingLetterId: failure.incoming.id,
          snapshotId: failure.snapshot.id,
          generationEpoch: 2,
        },
      },
    });
    expect(repository.getGenerationRun(failedRetryRun.id)).toEqual(
      failedRetryRun,
    );
    expect(
      repository.enqueueReplyGenerationRetry({
        incomingLetterId: failure.incoming.id,
        clientRequestId: "reply-retry-request-one",
        requestedAtUtc: T4,
      }),
    ).toMatchObject({
      generationEpoch: 1,
      replayed: true,
      task: { id: first.task.id },
    });

    const requests = database
      .prepare(
        `SELECT incoming_letter_id AS incomingLetterId,
                request_hash AS requestHash,
                generation_epoch AS generationEpoch,
                snapshot_id AS snapshotId,
                previous_task_id AS previousTaskId,
                previous_run_id AS previousRunId,
                task_id AS taskId,
                source
         FROM correspondence_reply_retry_requests
         ORDER BY generation_epoch`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      incomingLetterId: failure.incoming.id,
      generationEpoch: 1,
      snapshotId: failure.snapshot.id,
      previousTaskId: failure.task.id,
      previousRunId: failure.run.id,
      taskId: first.task.id,
      source: "local_user",
    });
    expect(requests[1]).toMatchObject({
      generationEpoch: 2,
      previousTaskId: first.task.id,
      previousRunId: failedRetryRun.id,
      taskId: second.task.id,
    });
    expect(
      requests.every((request) =>
        /^[a-f0-9]{64}$/u.test(String(request.requestHash)),
      ),
    ).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("reply-retry-request");

    const events = database
      .prepare(
        `SELECT payload_json AS payloadJson,
                idempotency_key AS idempotencyKey,
                stream_version AS streamVersion
         FROM domain_events
         WHERE event_type = 'letter.reply_retry_requested'
         ORDER BY stream_version`,
      )
      .all() as Array<{
      payloadJson: string;
      idempotencyKey: string;
      streamVersion: number;
    }>;
    const eventPayloads = events.map(
      (event) => JSON.parse(event.payloadJson) as Record<string, unknown>,
    );
    expect(
      eventPayloads.every(
        (payload) => typeof payload.retryRequestId === "string",
      ),
    ).toBe(true);
    expect(eventPayloads).toEqual([
      {
        generationEpoch: 1,
        incomingLetterId: failure.incoming.id,
        retryRequestId: eventPayloads[0]!.retryRequestId,
        source: "local_user",
      },
      {
        generationEpoch: 2,
        incomingLetterId: failure.incoming.id,
        retryRequestId: eventPayloads[1]!.retryRequestId,
        source: "local_user",
      },
    ]);
    expect(
      events.every(
        (event, index) =>
          event.idempotencyKey ===
          `letter-reply-retry-request:${String(eventPayloads[index]!.retryRequestId)}`,
      ),
    ).toBe(true);
    expect(events.map((event) => event.streamVersion)).toEqual([5, 6]);
    const streamVersions = database
      .prepare(
        `SELECT stream_version AS streamVersion
         FROM domain_events
         WHERE stream_type = 'correspondence_letter' AND stream_id = ?
         ORDER BY stream_version`,
      )
      .all(failure.incoming.id) as Array<{ streamVersion: number }>;
    expect(streamVersions.map((row) => row.streamVersion)).toEqual([4, 5, 6]);
    expect(new Set(streamVersions.map((row) => row.streamVersion)).size).toBe(
      streamVersions.length,
    );
    for (const request of requests) {
      expect(JSON.stringify(events)).not.toContain(String(request.requestHash));
    }

    database
      .prepare(
        `INSERT INTO correspondence_threads(
           id, agent_id, status, created_at_utc, updated_at_utc, closed_at_utc
         ) VALUES ('thread-other-retry-target', ?, 'closed', ?, ?, ?)`,
      )
      .run(AGENT_ID, T3, T3, T3);
    database
      .prepare(
        `INSERT INTO letters(
           id, thread_id, agent_id, direction, status, body,
           created_at_utc, updated_at_utc
         ) VALUES (
           'letter-other-retry-target', 'thread-other-retry-target', ?,
           'user_to_agent', 'cancelled',
           'Another letter', ?, ?
         )`,
      )
      .run(AGENT_ID, T3, T3);
    expectRepositoryError(
      () =>
        repository.enqueueReplyGenerationRetry({
          incomingLetterId: "letter-other-retry-target",
          clientRequestId: "reply-retry-request-one",
          requestedAtUtc: T4,
        }),
      "idempotency_conflict",
    );
    expect(count(database, "correspondence_reply_retry_requests")).toBe(2);

    database.prepare("DELETE FROM characters WHERE id = ?").run(AGENT_ID);
    expect(count(database, "correspondence_reply_retry_requests")).toBe(0);
    expect(count(database, "temporal_tasks")).toBe(0);
    expect(count(database, "letter_generation_runs")).toBe(0);
  });

  it("rolls back recovery tasks when their audit event cannot commit", () => {
    const failure = createRecoverableGenerationFailure(repository);
    database.exec(`
      CREATE TRIGGER reject_reply_retry_audit
      BEFORE INSERT ON domain_events
      WHEN NEW.event_type = 'letter.reply_retry_requested'
      BEGIN
        SELECT RAISE(ABORT, 'forced reply retry audit failure');
      END;
    `);

    expect(() =>
      repository.enqueueReplyGenerationRetry({
        incomingLetterId: failure.incoming.id,
        clientRequestId: "reply-retry-rollback",
        requestedAtUtc: T3,
      }),
    ).toThrow(/forced reply retry audit failure/iu);
    expect(
      scalar(
        database,
        `SELECT COUNT(*) AS count FROM temporal_tasks
         WHERE kind = 'letter.generation_retry'`,
      ),
    ).toBe(0);
    expect(count(database, "correspondence_reply_retry_requests")).toBe(0);
  });

  it.each([
    {
      caseName: "the initial task uses the retry kind",
      taskKind: "letter.generation_retry" as const,
      taskMaxAttempts: 3,
    },
    {
      caseName: "the task changes the three-attempt budget",
      taskKind: "letter.reply_generation" as const,
      taskMaxAttempts: 4,
    },
  ])("fails closed when $caseName", ({ taskKind, taskMaxAttempts }) => {
    const failure = createRecoverableGenerationFailure(repository, {
      taskKind,
      taskMaxAttempts,
    });
    const enqueue = () =>
      repository.enqueueReplyGenerationRetry({
        incomingLetterId: failure.incoming.id,
        clientRequestId: "reply-retry-invalid-history",
        requestedAtUtc: T3,
      });

    expectRepositoryError(enqueue, "generation_not_retryable");
    expect(
      scalar(
        database,
        `SELECT COUNT(*) AS count FROM temporal_tasks
         WHERE kind = 'letter.generation_retry' AND status = 'pending'`,
      ),
    ).toBe(0);
    expect(count(database, "correspondence_reply_retry_requests")).toBe(0);
  });

  it("finds the newest append-only generation task for an incoming letter", () => {
    const incoming = createReadIncoming(repository);
    const initial = repository.createTemporalTask({
      id: "task-generation-initial",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: incoming.id,
      dueAtUtc: T1,
      priority: 20,
      idempotencyKey: `letter-reply-run:${incoming.id}:v1`,
      payload: {
        incomingLetterId: incoming.id,
        snapshotId: "snapshot-generation",
        generationEpoch: 0,
      },
      createdAtUtc: T1,
    });
    repository.claimDueTask({
      taskId: initial.id,
      agentId: AGENT_ID,
      nowUtc: T1,
      leaseExpiresAtUtc: T2,
      claimToken: "initial-generation-claim",
    });
    repository.retryTask({
      taskId: initial.id,
      claimToken: "initial-generation-claim",
      errorCode: "terminal_generation_failure",
      nowUtc: T1,
      retryable: false,
    });
    const retry = repository.createTemporalTask({
      id: "task-generation-retry",
      agentId: AGENT_ID,
      kind: "letter.generation_retry",
      entityId: incoming.id,
      dueAtUtc: T0,
      priority: 20,
      idempotencyKey: `letter-generation-retry:${incoming.id}:epoch-1`,
      payload: {
        incomingLetterId: incoming.id,
        snapshotId: "snapshot-generation",
        generationEpoch: 1,
      },
      // A clock rollback can make the append-only retry look older by time;
      // insertion order, rather than timestamps, determines the current task.
      createdAtUtc: T0,
    });

    expect(repository.findLatestGenerationTask(incoming.id)).toEqual(retry);
    expect(
      repository.findLatestGenerationTask("letter-without-generation"),
    ).toBe(undefined);
    expect(initial.id).not.toBe(retry.id);
  });
});

function createRecoverableGenerationFailure(
  repository: CorrespondenceRepository,
  options: Readonly<{
    taskKind?: "letter.reply_generation" | "letter.generation_retry";
    taskMaxAttempts?: number;
  }> = {},
) {
  const incoming = createReadIncoming(repository);
  const contextHash = createHash("sha256")
    .update(
      canonicalLetterGenerationSnapshot({
        contextJson: SNAPSHOT_CONTEXT,
        evidenceIds: ["evidence-before-arrival"],
      }),
      "utf8",
    )
    .digest("hex");
  const snapshot = repository.insertSnapshot({
    id: "snapshot-recoverable-generation",
    incomingLetterId: incoming.id,
    agentId: AGENT_ID,
    effectiveAtUtc: T1,
    characterVersion: 3,
    stateRevision: 7,
    contextJson: SNAPSHOT_CONTEXT,
    evidenceIds: ["evidence-before-arrival"],
    contextHash,
    createdAtUtc: T2,
  });
  const task = repository.createTemporalTask({
    id: "task-recoverable-generation",
    agentId: AGENT_ID,
    kind: options.taskKind ?? "letter.reply_generation",
    entityId: incoming.id,
    dueAtUtc: T1,
    priority: 20,
    idempotencyKey: `letter-reply-generation:${incoming.id}:epoch-0`,
    payload: {
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      generationEpoch: 0,
    },
    maxAttempts: options.taskMaxAttempts ?? 3,
    createdAtUtc: T2,
  });
  const claimToken = "recoverable-generation-claim";
  repository.claimDueTask({
    taskId: task.id,
    agentId: AGENT_ID,
    nowUtc: T2,
    leaseExpiresAtUtc: "2026-09-09T02:00:00.000Z",
    claimToken,
  });
  const claimedRun = repository.claimGenerationRun({
    id: "run-recoverable-generation",
    incomingLetterId: incoming.id,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.contextHash,
    agentId: AGENT_ID,
    generationEpoch: 0,
    claimToken,
    nowUtc: T2,
    leaseExpiresAtUtc: "2026-09-09T02:00:00.000Z",
  });
  const run = repository.retryGenerationRun({
    runId: claimedRun!.id,
    claimToken,
    generationEpoch: 0,
    errorCode: "terminal_generation_failure",
    nowUtc: "2026-09-09T01:01:00.000Z",
    retryable: false,
  });
  const deadTask = repository.retryTask({
    taskId: task.id,
    claimToken,
    errorCode: "terminal_generation_failure",
    nowUtc: "2026-09-09T01:01:00.000Z",
    retryable: false,
  });
  return { incoming, snapshot, task: deadTask, run };
}

function createReadIncoming(
  repository: CorrespondenceRepository,
): ReturnType<CorrespondenceRepository["getLetter"]> & { id: string } {
  const thread = repository.createThread(AGENT_ID, {
    id: "thread-generation",
    nowUtc: T0,
  });
  const draft = repository.createDraftLetter({
    id: "letter-incoming-generation",
    threadId: thread.id,
    agentId: AGENT_ID,
    body: "Tell me what your week became.",
    nowUtc: T0,
  });
  repository.sealLetter({
    letterId: draft.id,
    contentHash: CONTENT_HASH,
    transitPolicyVersion: "fixed_5d_v1",
    transitTimezone: "Asia/Shanghai",
    dispatchedAtUtc: T0,
    arrivalDueAtUtc: T1,
  });
  repository.markDelivered(draft.id, T1, T2);
  return repository.markRead(draft.id, T1);
}

function seedAgent(database: Database, agentId = AGENT_ID): void {
  database
    .prepare(
      `INSERT INTO characters(
         id, current_version, status, tier, name, source_type,
         created_at_utc, updated_at_utc
       ) VALUES (?, 3, 'published', 'high_fidelity', 'Correspondent',
         'original', ?, ?)`,
    )
    .run(agentId, T0, T0);
}

function count(database: Database, table: string): number {
  return scalar(database, `SELECT COUNT(*) AS count FROM ${table}`);
}

function scalar(
  database: Database,
  sql: string,
  ...parameters: unknown[]
): number {
  return Number(
    (database.prepare(sql).get(...parameters) as { count: number }).count,
  );
}

function expectRepositoryError(
  action: () => unknown,
  code: CorrespondenceRepositoryErrorCode,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: unknown }).code).toBe(code);
    return;
  }
  throw new Error(`Expected correspondence repository error ${code}`);
}
