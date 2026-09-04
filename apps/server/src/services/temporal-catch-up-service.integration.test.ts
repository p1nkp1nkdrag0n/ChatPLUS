import { calculateTransitProgress } from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock } from "../runtime/clock.js";
import {
  TemporalCatchUpService,
  type ExternalTemporalTaskHandler,
  type TemporalCatchUpRepository,
} from "./temporal-catch-up-service.js";

const AGENT_ID = "agent-temporal-catch-up";
const T0 = "2026-09-03T12:00:00.000Z";
const SEPTEMBER_7 = "2026-09-07T12:00:00.000Z";
const T1 = "2026-09-08T12:00:00.000Z";
const T2 = "2026-09-09T01:00:00.000Z";
const T3 = "2026-09-13T12:00:00.000Z";
const T4 = "2026-09-15T02:00:00.000Z";
const T5 = "2026-09-15T03:00:00.000Z";
const CONTENT_HASH = "a".repeat(64);
const REPLY_HASH = "b".repeat(64);
const AAD_HASH = "d".repeat(64);

class RecordingLifeAdvancer {
  readonly calls: { agentId: string; toUtc: string }[] = [];
  failAtUtc: string | undefined;

  advance(agentId: string, toUtc: string): void {
    this.calls.push({ agentId, toUtc });
    if (toUtc === this.failAtUtc) {
      throw new Error(`life advance failed at ${toUtc}`);
    }
  }
}

describe("TemporalCatchUpService", () => {
  let database: Database;
  let repository: CorrespondenceRepository;
  let actors: ActorQueue;
  let clock: FakeClock;
  let life: RecordingLifeAdvancer;
  let claimSequence: number;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedAgent(database);
    repository = new CorrespondenceRepository(database);
    actors = new ActorQueue();
    clock = new FakeClock(T4);
    life = new RecordingLifeAdvancer();
    claimSequence = 0;
  });

  afterEach(() => database.close());

  it("shows 80% on September 7 without claiming work or invoking a model", async () => {
    const { letter, task } = createOutboundLetter(repository);
    clock.setUtc(SEPTEMBER_7);
    const execute = vi.fn(() => Promise.resolve({ proposal: "unused" }));
    const service = createService({
      handler: {
        execute,
        commit: () => undefined,
      },
    });

    const result = await service.catchUpAgent(AGENT_ID);

    expect(result).toEqual({
      agentId: AGENT_ID,
      observedNowUtc: SEPTEMBER_7,
      completedTaskIds: [],
      retriedTaskIds: [],
      externalExecutionCount: 0,
      finalAdvancedToUtc: SEPTEMBER_7,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(repository.getTask(task.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(repository.getLetter(letter.id)).toMatchObject({
      status: "in_transit",
    });
    expect(
      calculateTransitProgress({
        dispatchedAtUtc: T0,
        arrivalDueAtUtc: T1,
        observedAtUtc: SEPTEMBER_7,
      }),
    ).toBeCloseTo(0.8);
    expect(life.calls).toEqual([{ agentId: AGENT_ID, toUtc: SEPTEMBER_7 }]);
  });

  it("handles September 15 catch-up, external generation, and overdue return arrival in one pass", async () => {
    const {
      threadId,
      letter: incoming,
      task: outboundTask,
    } = createOutboundLetter(repository);
    repository.createTemporalTask({
      id: "task-reply-generation",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: incoming.id,
      dueAtUtc: T1,
      priority: 20,
      idempotencyKey: `letter-reply-run:${incoming.id}:v1`,
      payload: { incomingLetterId: incoming.id },
      createdAtUtc: T0,
    });
    seedInTransitReply(database, threadId, incoming.id);

    const executeLockCounts: number[] = [];
    const commitLockCounts: number[] = [];
    const execute = vi.fn(() => {
      executeLockCounts.push(actors.activeActors);
      return Promise.resolve({ encryptedReplyReady: true });
    });
    const handler: ExternalTemporalTaskHandler = {
      prepare: ({ task }) => {
        repository.markRead(task.entityId, task.dueAtUtc);
        return { replyLetterId: "letter-reply-1" };
      },
      execute,
      commit: ({ prepared, observedNowUtc }) => {
        commitLockCounts.push(actors.activeActors);
        const replyLetterId = (prepared as { readonly replyLetterId: string })
          .replyLetterId;
        repository.createTemporalTask({
          id: "task-return-arrival",
          agentId: AGENT_ID,
          kind: "letter.return_arrival",
          entityId: replyLetterId,
          dueAtUtc: T3,
          priority: 30,
          idempotencyKey: `letter-arrival:${replyLetterId}`,
          payload: { letterId: replyLetterId },
          createdAtUtc: observedNowUtc,
        });
      },
    };
    const service = createService({ handler });

    const result = await service.catchUpAgent(AGENT_ID, T4);

    expect(result.completedTaskIds).toEqual([
      outboundTask.id,
      "task-reply-generation",
      "task-return-arrival",
    ]);
    expect(result.retriedTaskIds).toEqual([]);
    expect(result.externalExecutionCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executeLockCounts).toEqual([0]);
    expect(commitLockCounts).toEqual([1]);
    expect(repository.getLetter(incoming.id)).toMatchObject({
      status: "read",
      deliveredEffectiveAtUtc: T1,
      processedAtUtc: T4,
      readAtUtc: T1,
    });
    expect(repository.getLetter("letter-reply-1")).toMatchObject({
      status: "delivered_unread",
      deliveredEffectiveAtUtc: T3,
      processedAtUtc: T4,
    });
    expect(repository.getTask("task-return-arrival")).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(life.calls.map((call) => call.toUtc)).toEqual([T1, T1, T3, T4]);
  });

  it("does not claim, skip, or advance past a failed life boundary", async () => {
    const { letter, task: firstTask } = createOutboundLetter(repository);
    const laterTask = repository.createTemporalTask({
      id: "task-later-generation",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: letter.id,
      dueAtUtc: T2,
      priority: 20,
      idempotencyKey: "letter-reply-run:later:v1",
      payload: { incomingLetterId: letter.id },
      createdAtUtc: T0,
    });
    life.failAtUtc = T1;
    const createClaimToken = vi.fn(() => "claim-must-not-be-created");
    const execute = vi.fn(() => Promise.resolve(undefined));
    const service = createService({
      createClaimToken,
      handler: { execute, commit: () => undefined },
    });

    await expect(service.catchUpAgent(AGENT_ID, T4)).rejects.toThrow(
      `life advance failed at ${T1}`,
    );

    expect(createClaimToken).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(repository.getTask(firstTask.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(repository.getTask(laterTask.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(life.calls).toEqual([{ agentId: AGENT_ID, toUtc: T1 }]);
  });

  it("orders all due work by due time, priority, then task ID", async () => {
    const tasks = [
      {
        id: "task-later",
        dueAtUtc: T2,
        priority: 1,
      },
      {
        id: "task-same-b",
        dueAtUtc: T1,
        priority: 20,
      },
      {
        id: "task-priority",
        dueAtUtc: T1,
        priority: 10,
      },
      {
        id: "task-same-a",
        dueAtUtc: T1,
        priority: 20,
      },
    ] as const;
    for (const task of tasks) {
      repository.createTemporalTask({
        ...task,
        agentId: AGENT_ID,
        kind: "letter.reply_generation",
        entityId: task.id,
        idempotencyKey: `generation:${task.id}`,
        payload: { source: task.id },
        createdAtUtc: T0,
      });
    }
    const executionOrder: string[] = [];
    const service = createService({
      handler: {
        execute: ({ task }) => {
          executionOrder.push(task.id);
          return Promise.resolve(undefined);
        },
        commit: () => undefined,
      },
    });

    const result = await service.catchUpAgent(AGENT_ID, T4);

    const expectedOrder = [
      "task-priority",
      "task-same-a",
      "task-same-b",
      "task-later",
    ];
    expect(executionOrder).toEqual(expectedOrder);
    expect(result.completedTaskIds).toEqual(expectedOrder);
    expect(life.calls.map((call) => call.toUtc)).toEqual([T1, T1, T1, T2, T4]);
  });

  it("re-reads after an exact-candidate race and stops at the newly active head", async () => {
    const first = repository.createTemporalTask({
      id: "task-raced-first",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-raced-first",
      dueAtUtc: T1,
      priority: 10,
      idempotencyKey: "generation:raced-first",
      payload: { source: "first" },
      createdAtUtc: T0,
    });
    const second = repository.createTemporalTask({
      id: "task-after-race",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-after-race",
      dueAtUtc: T2,
      priority: 10,
      idempotencyKey: "generation:after-race",
      payload: { source: "second" },
      createdAtUtc: T0,
    });
    let injectRace = true;
    const serviceClaimTaskIds: (string | undefined)[] = [];
    const racedRepository = createRepositoryAdapter({
      claimDueTask: (input) => {
        serviceClaimTaskIds.push(input.taskId);
        if (injectRace) {
          injectRace = false;
          expect(input.taskId).toBe(first.id);
          expect(
            repository.claimDueTask({
              ...input,
              taskId: first.id,
              claimToken: "claim-rival-process",
            })?.id,
          ).toBe(first.id);
        }
        return repository.claimDueTask(input);
      },
    });
    const executionOrder: string[] = [];
    const service = createService({
      repositoryOverride: racedRepository,
      handler: {
        execute: ({ task }) => {
          executionOrder.push(task.id);
          return Promise.resolve(undefined);
        },
        commit: () => undefined,
      },
    });

    const result = await service.catchUpAgent(AGENT_ID, T4);

    expect(serviceClaimTaskIds).toEqual([first.id]);
    expect(executionOrder).toEqual([]);
    expect(result.completedTaskIds).toEqual([]);
    expect(result.blockedTaskId).toBe(first.id);
    expect(result.finalAdvancedToUtc).toBe(T1);
    expect(repository.getTask(first.id)).toMatchObject({
      status: "claimed",
      claimToken: "claim-rival-process",
    });
    expect(repository.getTask(second.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(life.calls.map((call) => call.toUtc)).toEqual([T1]);
  });

  it("stops at an active claimed queue head without advancing to observed time or later work", async () => {
    const blocked = repository.createTemporalTask({
      id: "task-active-barrier",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-active-barrier",
      dueAtUtc: T1,
      priority: 10,
      idempotencyKey: "generation:active-barrier",
      payload: { source: "blocked" },
      createdAtUtc: T0,
    });
    const later = repository.createTemporalTask({
      id: "task-behind-active-barrier",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-behind-active-barrier",
      dueAtUtc: T2,
      priority: 10,
      idempotencyKey: "generation:behind-active-barrier",
      payload: { source: "later" },
      createdAtUtc: T0,
    });
    repository.claimDueTask({
      taskId: blocked.id,
      agentId: AGENT_ID,
      kinds: ["letter.reply_generation"],
      nowUtc: T1,
      leaseExpiresAtUtc: T5,
      claimToken: "claim-active-owner",
    });
    const execute = vi.fn(() => Promise.resolve(undefined));
    const service = createService({
      handler: { execute, commit: () => undefined },
    });

    const result = await service.catchUpAgent(AGENT_ID, T4);

    expect(result).toEqual({
      agentId: AGENT_ID,
      observedNowUtc: T4,
      completedTaskIds: [],
      retriedTaskIds: [],
      externalExecutionCount: 0,
      blockedTaskId: blocked.id,
      finalAdvancedToUtc: T1,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(repository.getTask(blocked.id)).toMatchObject({
      status: "claimed",
      claimToken: "claim-active-owner",
    });
    expect(repository.getTask(later.id)).toMatchObject({
      status: "pending",
      attempt: 0,
    });
    expect(life.calls).toEqual([]);
  });

  it("reaps an expired final-attempt claim, then continues in queue order", async () => {
    const exhausted = repository.createTemporalTask({
      id: "task-exhausted-after-crash",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-exhausted-after-crash",
      dueAtUtc: T1,
      priority: 10,
      idempotencyKey: "generation:exhausted-after-crash",
      payload: { source: "exhausted" },
      maxAttempts: 1,
      createdAtUtc: T0,
    });
    const later = repository.createTemporalTask({
      id: "task-after-exhausted",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-after-exhausted",
      dueAtUtc: T2,
      priority: 10,
      idempotencyKey: "generation:after-exhausted",
      payload: { source: "later" },
      createdAtUtc: T0,
    });
    repository.claimDueTask({
      taskId: exhausted.id,
      agentId: AGENT_ID,
      kinds: ["letter.reply_generation"],
      nowUtc: T1,
      leaseExpiresAtUtc: T2,
      claimToken: "claim-crashed-final-attempt",
    });
    const executionOrder: string[] = [];
    const service = createService({
      handler: {
        execute: ({ task }) => {
          executionOrder.push(task.id);
          return Promise.resolve(undefined);
        },
        commit: () => undefined,
      },
    });

    const result = await service.catchUpAgent(AGENT_ID, T4);

    expect(repository.getTask(exhausted.id)).toMatchObject({
      status: "dead_letter",
      attempt: 1,
    });
    expect(repository.getTask(later.id)).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(executionOrder).toEqual([later.id]);
    expect(result.completedTaskIds).toEqual([later.id]);
    expect(result.blockedTaskId).toBeUndefined();
    expect(result.finalAdvancedToUtc).toBe(T4);
    expect(life.calls.map((call) => call.toUtc)).toEqual([T1, T2, T4]);
  });

  it("converges when a crash separates deterministic delivery from task completion", async () => {
    const { letter, task } = createOutboundLetter(repository);
    let simulateCrash = true;
    const crashRepository = createRepositoryAdapter({
      completeTask: (input) => {
        if (simulateCrash) {
          throw new Error("simulated process crash before task completion");
        }
        return repository.completeTask(input);
      },
      retryTask: (input) => {
        if (simulateCrash) {
          simulateCrash = false;
          throw new Error("simulated process termination before retry cleanup");
        }
        return repository.retryTask(input);
      },
    });
    const service = createService({ repositoryOverride: crashRepository });

    await expect(service.catchUpAgent(AGENT_ID, T4)).rejects.toThrow(
      "simulated process termination",
    );
    expect(repository.getLetter(letter.id)).toMatchObject({
      status: "delivered_unread",
      deliveredEffectiveAtUtc: T1,
      processedAtUtc: T4,
    });
    expect(repository.getTask(task.id)).toMatchObject({
      status: "claimed",
      attempt: 1,
    });
    expect(life.calls.map((call) => call.toUtc)).toEqual([T1]);

    const replay = await service.catchUpAgent(AGENT_ID, T5);

    expect(replay.completedTaskIds).toEqual([task.id]);
    expect(repository.getTask(task.id)).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(repository.getLetter(letter.id)).toMatchObject({
      status: "delivered_unread",
      deliveredEffectiveAtUtc: T1,
      processedAtUtc: T4,
    });
    expect(life.calls.map((call) => call.toUtc)).toEqual([T1, T1, T5]);
  });

  it("serializes concurrent public catch-up passes without duplicate execution", async () => {
    const task = repository.createTemporalTask({
      id: "task-concurrent-generation",
      agentId: AGENT_ID,
      kind: "letter.reply_generation",
      entityId: "letter-concurrent",
      dueAtUtc: T1,
      priority: 20,
      idempotencyKey: "generation:concurrent",
      payload: { source: "concurrent" },
      createdAtUtc: T0,
    });
    let releaseExecution = (): void => undefined;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let reportExecutionEntered = (): void => undefined;
    const executionEntered = new Promise<void>((resolve) => {
      reportExecutionEntered = resolve;
    });
    const execute = vi.fn(async () => {
      expect(actors.activeActors).toBe(0);
      reportExecutionEntered();
      await executionGate;
      return { ok: true };
    });
    const service = createService({
      handler: { execute, commit: () => undefined },
    });

    const first = service.catchUpAgent(AGENT_ID, T4);
    await executionEntered;
    let secondSettled = false;
    const second = service.catchUpAgent(AGENT_ID, T4).then((result) => {
      secondSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseExecution();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(firstResult.completedTaskIds).toEqual([task.id]);
    expect(secondResult.completedTaskIds).toEqual([]);
    expect(repository.getTask(task.id)).toMatchObject({
      status: "completed",
      attempt: 1,
    });

    const repeated = await service.catchUpAgent(AGENT_ID, T4);
    expect(repeated.completedTaskIds).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  function createService(
    options: {
      handler?: ExternalTemporalTaskHandler;
      createClaimToken?: () => string;
      repositoryOverride?: TemporalCatchUpRepository;
    } = {},
  ): TemporalCatchUpService {
    return new TemporalCatchUpService(
      options.repositoryOverride ?? repository,
      life,
      actors,
      clock,
      {
        ...(options.handler === undefined
          ? {}
          : { externalTaskHandler: options.handler }),
        createClaimToken:
          options.createClaimToken ??
          ((task) => `claim-${task.id}-${(claimSequence += 1)}`),
        leaseMs: 30 * 60 * 1_000,
      },
    );
  }

  function createRepositoryAdapter(
    overrides: Partial<TemporalCatchUpRepository>,
  ): TemporalCatchUpRepository {
    return {
      findEarliestDueTask: (agentId, observedNowUtc, kinds) =>
        repository.findEarliestDueTask(agentId, observedNowUtc, kinds),
      claimDueTask: (input) => repository.claimDueTask(input),
      completeTask: (input) => repository.completeTask(input),
      retryTask: (input) => repository.retryTask(input),
      getLetter: (letterId) => repository.getLetter(letterId),
      markDelivered: (input) => repository.markDelivered(input),
      ...overrides,
    };
  }
});

function createOutboundLetter(repository: CorrespondenceRepository): {
  threadId: string;
  letter: NonNullable<ReturnType<CorrespondenceRepository["getLetter"]>>;
  task: NonNullable<ReturnType<CorrespondenceRepository["getTask"]>>;
} {
  const thread = repository.createThread(AGENT_ID, {
    id: "thread-main",
    nowUtc: T0,
  });
  const draft = repository.createDraftLetter({
    id: "letter-user-1",
    threadId: thread.id,
    agentId: AGENT_ID,
    subject: "September letter",
    body: "I am writing before the trip.",
    nowUtc: T0,
  });
  const sealed = repository.sealLetter({
    letterId: draft.id,
    contentHash: CONTENT_HASH,
    transitPolicyVersion: "fixed_5d_v1",
    transitTimezone: "Asia/Shanghai",
    dispatchedAtUtc: T0,
    arrivalDueAtUtc: T1,
    effectiveAuthorTimeUtc: T0,
    taskId: "task-outbound-arrival",
    taskPriority: 10,
    clientRequestId: "request-seal-1",
  });
  return { threadId: thread.id, letter: sealed.letter, task: sealed.task };
}

function seedInTransitReply(
  database: Database,
  threadId: string,
  incomingLetterId: string,
): void {
  database
    .prepare(
      `INSERT INTO letters(
         id, thread_id, agent_id, reply_to_letter_id, direction, status,
         content_hash, encrypted_ciphertext, encrypted_iv, encrypted_auth_tag,
         encrypted_key_version, encrypted_aad_hash, encrypted_created_at_utc,
         transit_policy_version, transit_timezone, dispatched_at_utc,
         arrival_due_at_utc, effective_author_time_utc,
         created_at_utc, updated_at_utc
       ) VALUES (
         ?, ?, ?, ?, 'agent_to_user', 'in_transit', ?, ?, ?, ?, ?, ?, ?,
         'fixed_5d_v1', 'Asia/Shanghai', ?, ?, ?, ?, ?
       )`,
    )
    .run(
      "letter-reply-1",
      threadId,
      AGENT_ID,
      incomingLetterId,
      REPLY_HASH,
      "YWJjZA==",
      "MTIzNDU2Nzg5MDEy",
      "YWJjZGVmZ2hpamtsbW5vcA==",
      1,
      AAD_HASH,
      T2,
      T1,
      T3,
      T1,
      T2,
      T2,
    );
}

function seedAgent(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
         id, current_version, status, tier, name, source_type,
         created_at_utc, updated_at_utc
       ) VALUES (?, 1, 'published', 'high_fidelity', 'Correspondent',
         'original', ?, ?)`,
    )
    .run(AGENT_ID, T0, T0);
}
