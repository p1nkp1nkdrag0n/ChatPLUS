import { createHash } from "node:crypto";

import type {
  LetterGenerationContextV1,
  LetterReplyProposal,
  TemporalTask,
} from "@personasim/contracts";
import {
  canonicalCorrespondenceJson,
  canonicalLetterContent,
  canonicalLetterGenerationSnapshot,
  canonicalLetterReplyContent,
} from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock } from "../runtime/clock.js";
import {
  LetterReplyGenerationService,
  type LetterReplyEncryptor,
  type LetterReplyModel,
  type LetterReplyModelRequest,
} from "./letter-reply-generation-service.js";
import { TemporalCatchUpService } from "./temporal-catch-up-service.js";

const AGENT_ID = "agent-letter-generation";
const T0 = "2026-09-03T12:00:00.000Z";
const ARRIVAL = "2026-09-08T12:00:00.000Z";
const PROCESSED = "2026-09-09T01:00:00.000Z";
const RETRY_DUE = "2026-09-09T01:01:00.000Z";
const SECOND_OBSERVED = "2026-09-09T01:02:00.000Z";
const ACTIVE_RUN_LEASE = "2026-09-09T01:30:00.000Z";
const AFTER_ACTIVE_RUN = "2026-09-09T01:31:00.000Z";
const THIRD_DUE = "2026-09-09T01:04:00.000Z";
const THIRD_LEASE_END = "2026-09-09T01:05:00.000Z";
const AFTER_CRASH = "2026-09-09T01:06:00.000Z";

const proposal: LetterReplyProposal = {
  subject: "九月回信",
  salutation: "亲爱的朋友：",
  paragraphs: ["你的来信我在抵达的那一刻认真读过。", "愿你一路平安。"],
  closing: "顺颂秋安",
  signature: "林",
  referencedEvidenceIds: ["evidence-before-arrival"],
};

interface RecordedModelCall {
  readonly purpose: string;
  readonly system: string;
  readonly prompt: string;
  readonly agentId: string;
  readonly maxRetries?: number;
  readonly maxOutputTokens?: number;
}

class ScriptedLetterReplyModel implements LetterReplyModel {
  readonly calls: RecordedModelCall[] = [];

  constructor(
    private readonly responder: (
      call: RecordedModelCall,
      index: number,
    ) => unknown,
  ) {}

  async generateObject<T>(input: LetterReplyModelRequest<T>): Promise<T> {
    const call: RecordedModelCall = {
      purpose: input.purpose,
      system: input.system,
      prompt: input.prompt,
      agentId: input.agentId,
      ...(input.maxRetries === undefined
        ? {}
        : { maxRetries: input.maxRetries }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
    };
    const index = this.calls.push(call) - 1;
    return input.schema.parse(await this.responder(call, index));
  }
}

class FixtureEncryptor implements LetterReplyEncryptor {
  readonly encryptReply = vi.fn<LetterReplyEncryptor["encryptReply"]>(
    (input) => ({
      letterId: input.letterId,
      ciphertext: "ZW5jcnlwdGVk",
      iv: "MTIzNDU2Nzg5MDEy",
      authTag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
      keyVersion: 1,
      aadHash: "d".repeat(64),
      createdAtUtc: input.createdAtUtc,
    }),
  );
}

class RecordingLifeAdvancer {
  readonly calls: string[] = [];

  advance(_agentId: string, toUtc: string): void {
    this.calls.push(toUtc);
  }
}

describe("LetterReplyGenerationService", () => {
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
    clock = new FakeClock(PROCESSED);
    life = new RecordingLifeAdvancer();
    claimSequence = 0;
  });

  afterEach(() => database.close());

  it("generates on September 9 only from the September 8 snapshot", async () => {
    const seeded = seedReadyGeneration(repository);
    const futureFact = "future-evidence-from-september-9";
    const model = new ScriptedLetterReplyModel((call) => {
      expect(call.purpose).toBe("letter_reply");
      expect(call.prompt).toContain(ARRIVAL);
      expect(call.prompt).toContain("evidence-before-arrival");
      expect(call.prompt).not.toContain(PROCESSED);
      expect(call.prompt).not.toContain(futureFact);
      return proposal;
    });
    const encryptor = new FixtureEncryptor();
    const { catchUp } = createGenerationHarness(model, encryptor);

    const result = await catchUp.catchUpAgent(AGENT_ID, PROCESSED);

    expect(result.completedTaskIds).toEqual([seeded.task.id]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.system).toContain("complete correspondence letter");
    const run = repository.getGenerationRunForEpoch(seeded.incoming.id, 0);
    expect(run).toMatchObject({
      status: "committed",
      attempt: 1,
      snapshotId: seeded.snapshot.id,
    });
    expect(typeof run?.replyLetterId).toBe("string");
    const reply = repository.getLetter(run?.replyLetterId ?? "missing");
    expect(reply).toMatchObject({
      direction: "agent_to_user",
      status: "in_transit",
      effectiveAuthorTimeUtc: ARRIVAL,
      arrivalDueAtUtc: "2026-09-13T12:00:00.000Z",
    });
    expect(reply?.subject).toBeUndefined();
    expect(reply?.body).toBeUndefined();
    expect(reply?.contentHash).toBe(
      sha256(canonicalLetterReplyContent(proposal)),
    );
    const rawReply = database
      .prepare(
        "SELECT subject, body, encrypted_ciphertext FROM letters WHERE id = ?",
      )
      .get(reply?.id ?? "missing") as
      | {
          subject: string | null;
          body: string | null;
          encrypted_ciphertext: string;
        }
      | undefined;
    expect(rawReply).toMatchObject({
      subject: null,
      body: null,
      encrypted_ciphertext: "ZW5jcnlwdGVk",
    });
  });

  it("allows a reply to cite the immutable incoming letter and snapshot evidence", async () => {
    const seeded = seedReadyGeneration(repository);
    const model = new ScriptedLetterReplyModel(() => ({
      ...proposal,
      referencedEvidenceIds: [seeded.incoming.id, "evidence-before-arrival"],
    }));
    const encryptor = new FixtureEncryptor();
    const { catchUp } = createGenerationHarness(model, encryptor);

    const result = await catchUp.catchUpAgent(AGENT_ID, PROCESSED);

    expect(result.completedTaskIds).toEqual([seeded.task.id]);
    expect(
      repository.getGenerationRunForEpoch(seeded.incoming.id, 0),
    ).toMatchObject({
      status: "committed",
      attempt: 1,
      snapshotId: seeded.snapshot.id,
    });
    expect(encryptor.encryptReply).toHaveBeenCalledOnce();
    expect(countReplies(database)).toBe(1);
  });

  it("notifies one best-effort post-commit hook without allowing its failure to undo the reply", async () => {
    const seeded = seedReadyGeneration(repository);
    const model = new ScriptedLetterReplyModel(() => proposal);
    const encryptor = new FixtureEncryptor();
    const generation = createGenerationService(model, encryptor);
    const hook = vi.fn(() => {
      throw new Error("simulated keepsake enqueue failure");
    });
    generation.setReplyCommittedHandler(hook);
    const catchUp = new TemporalCatchUpService(
      repository,
      life,
      actors,
      clock,
      {
        externalTaskHandler: generation.createExternalHandler(),
        createClaimToken: (task) => `claim-${task.id}-${(claimSequence += 1)}`,
        leaseMs: 30 * 60 * 1_000,
      },
    );

    await catchUp.catchUpAgent(AGENT_ID, PROCESSED);
    await Promise.resolve();
    await Promise.resolve();

    const run = repository.getGenerationRunForEpoch(seeded.incoming.id, 0);
    const reply = repository.getLetter(run?.replyLetterId ?? "missing");
    expect(run).toMatchObject({ status: "committed" });
    expect(reply).toMatchObject({
      status: "in_transit",
      direction: "agent_to_user",
    });
    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      incomingLetterId: seeded.incoming.id,
      replyLetterId: reply?.id,
    });

    await catchUp.catchUpAgent(AGENT_ID, PROCESSED);
    await Promise.resolve();
    expect(hook).toHaveBeenCalledOnce();
    expect(countReplies(database)).toBe(1);
  });

  it("retries the same logical run with an identical snapshot and evidence", async () => {
    const seeded = seedReadyGeneration(repository);
    const model = new ScriptedLetterReplyModel((_call, index) => {
      if (index === 0) {
        const error = new Error("temporary provider timeout") as Error & {
          code: string;
        };
        error.code = "network_timeout";
        throw error;
      }
      return {
        ...proposal,
        referencedEvidenceIds: [seeded.incoming.id],
      };
    });
    const encryptor = new FixtureEncryptor();
    const { catchUp } = createGenerationHarness(model, encryptor);
    const frozenSnapshot = structuredClone(
      repository.getSnapshot(seeded.snapshot.id),
    );

    const first = await catchUp.catchUpAgent(AGENT_ID, PROCESSED);

    expect(first.retriedTaskIds).toEqual([seeded.task.id]);
    expect(repository.getTask(seeded.task.id)).toMatchObject({
      status: "retryable",
      attempt: 1,
      dueAtUtc: RETRY_DUE,
    });
    const firstRun = repository.getGenerationRunForEpoch(seeded.incoming.id, 0);
    expect(firstRun).toMatchObject({
      status: "retryable",
      attempt: 1,
      snapshotId: seeded.snapshot.id,
      errorCode: "network_timeout",
    });

    const second = await catchUp.catchUpAgent(AGENT_ID, SECOND_OBSERVED);

    expect(second.completedTaskIds).toEqual([seeded.task.id]);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.prompt).toBe(model.calls[0]?.prompt);
    expect(repository.getSnapshot(seeded.snapshot.id)).toEqual(frozenSnapshot);
    expect(
      repository.getGenerationRunForEpoch(seeded.incoming.id, 0),
    ).toMatchObject({
      id: firstRun?.id,
      status: "committed",
      attempt: 2,
      snapshotId: seeded.snapshot.id,
    });
    expect(countReplies(database)).toBe(1);
  });

  it("fails closed on a drifted active run claim and resumes only after its lease", async () => {
    const seeded = seedReadyGeneration(repository);
    const model = new ScriptedLetterReplyModel(() => proposal);
    const encryptor = new FixtureEncryptor();
    const generation = createGenerationService(model, encryptor);
    const oldTask = claimTask(
      repository,
      seeded.task.id,
      PROCESSED,
      ACTIVE_RUN_LEASE,
      "claim-run-drift",
    );
    const prepared = generation.preflight({
      task: oldTask,
      observedNowUtc: PROCESSED,
    });
    expect(prepared.status).toBe("claimed");

    // Simulate legacy/corrupt drift where the task claim was released but its
    // generation-run lease remained active. Normal code updates the run first.
    repository.retryTask({
      taskId: oldTask.id,
      claimToken: oldTask.claimToken!,
      errorCode: "simulated_claim_drift",
      nowUtc: PROCESSED,
      nextDueAtUtc: RETRY_DUE,
      retryable: true,
    });
    const { catchUp } = createGenerationHarness(model, encryptor);

    const blockedAttempt = await catchUp.catchUpAgent(
      AGENT_ID,
      SECOND_OBSERVED,
    );

    expect(blockedAttempt.retriedTaskIds).toEqual([seeded.task.id]);
    expect(model.calls).toEqual([]);
    expect(repository.getTask(seeded.task.id)).toMatchObject({
      status: "retryable",
      attempt: 2,
      dueAtUtc: "2026-09-09T01:30:00.001Z",
    });
    expect(
      repository.getGenerationRunForEpoch(seeded.incoming.id, 0),
    ).toMatchObject({
      status: "generating",
      attempt: 1,
      claimToken: "claim-run-drift",
      leaseExpiresAtUtc: ACTIVE_RUN_LEASE,
    });

    const recovered = await catchUp.catchUpAgent(AGENT_ID, AFTER_ACTIVE_RUN);

    expect(recovered.completedTaskIds).toEqual([seeded.task.id]);
    expect(model.calls).toHaveLength(1);
    expect(
      repository.getGenerationRunForEpoch(seeded.incoming.id, 0),
    ).toMatchObject({ status: "committed", attempt: 2 });
    expect(countReplies(database)).toBe(1);
  });

  it("rejects evidence outside the frozen snapshot without encrypting a reply", async () => {
    const seeded = seedReadyGeneration(repository);
    const model = new ScriptedLetterReplyModel(() => ({
      ...proposal,
      referencedEvidenceIds: [seeded.incoming.id, "evidence-after-arrival"],
    }));
    const encryptor = new FixtureEncryptor();
    const { catchUp } = createGenerationHarness(model, encryptor);

    const result = await catchUp.catchUpAgent(AGENT_ID, PROCESSED);

    expect(result.retriedTaskIds).toEqual([seeded.task.id]);
    expect(repository.getTask(seeded.task.id)).toMatchObject({
      status: "dead_letter",
      attempt: 1,
      lastErrorCode: "letter_reply_evidence_out_of_scope",
    });
    expect(
      repository.getGenerationRunForEpoch(seeded.incoming.id, 0),
    ).toMatchObject({
      status: "failed",
      errorCode: "letter_reply_evidence_out_of_scope",
    });
    expect(encryptor.encryptReply).not.toHaveBeenCalled();
    expect(countReplies(database)).toBe(0);
  });

  it("discards a late old-claim result after a newer claim commits", async () => {
    const seeded = seedReadyGeneration(repository);
    let resolveOld: (value: unknown) => void = () => undefined;
    const oldGate = new Promise<unknown>((resolve) => {
      resolveOld = resolve;
    });
    const newerProposal: LetterReplyProposal = {
      ...proposal,
      paragraphs: ["这是新 claim 唯一允许提交的回信。"],
    };
    const oldProposal: LetterReplyProposal = {
      ...proposal,
      paragraphs: ["这是租约过期后的旧结果，不应提交。"],
    };
    const model = new ScriptedLetterReplyModel((_call, index) =>
      index === 0 ? oldGate : newerProposal,
    );
    const encryptor = new FixtureEncryptor();
    const generation = createGenerationService(model, encryptor);
    const oldTask = claimTask(
      repository,
      seeded.task.id,
      PROCESSED,
      RETRY_DUE,
      "claim-old",
    );
    const oldPrepared = generation.preflight({
      task: oldTask,
      observedNowUtc: PROCESSED,
    });
    const oldExecutionPromise = generation.compose(oldPrepared);
    await Promise.resolve();

    const newTask = claimTask(
      repository,
      seeded.task.id,
      SECOND_OBSERVED,
      "2026-09-09T01:32:00.000Z",
      "claim-new",
    );
    const newPrepared = generation.preflight({
      task: newTask,
      observedNowUtc: SECOND_OBSERVED,
    });
    const newExecution = await generation.compose(newPrepared);
    expect(
      generation.postflight(newPrepared, newExecution, SECOND_OBSERVED).status,
    ).toBe("committed");
    repository.completeTask({
      taskId: newTask.id,
      claimToken: newTask.claimToken!,
      completedAtUtc: SECOND_OBSERVED,
    });

    resolveOld(oldProposal);
    const oldExecution = await oldExecutionPromise;
    expect(
      generation.postflight(oldPrepared, oldExecution, SECOND_OBSERVED),
    ).toEqual({ status: "discarded_stale_claim" });
    expect(countReplies(database)).toBe(1);
    expect(encryptor.encryptReply).toHaveBeenCalledTimes(1);
    expect(
      repository.getGenerationRunForEpoch(seeded.incoming.id, 0),
    ).toMatchObject({ status: "committed", attempt: 2 });
  });

  it("fails closed on encryption errors and stores only the result hash", async () => {
    const seeded = seedReadyGeneration(repository);
    const model = new ScriptedLetterReplyModel(() => proposal);
    const encryptor: LetterReplyEncryptor = {
      encryptReply: () => {
        throw new Error("crypto unavailable");
      },
    };
    const { catchUp } = createGenerationHarness(model, encryptor);

    const result = await catchUp.catchUpAgent(AGENT_ID, PROCESSED);

    expect(result.retriedTaskIds).toEqual([seeded.task.id]);
    const failedRun = repository.getGenerationRunForEpoch(
      seeded.incoming.id,
      0,
    );
    expect(failedRun).toMatchObject({
      status: "failed",
      attempt: 1,
      errorCode: "letter_reply_encryption_failed",
      resultHash: sha256(canonicalCorrespondenceJson(proposal)),
    });
    expect(failedRun?.replyLetterId).toBeUndefined();
    expect(repository.getTask(seeded.task.id)).toMatchObject({
      status: "dead_letter",
      attempt: 1,
      lastErrorCode: "letter_reply_encryption_failed",
    });
    expect(countReplies(database)).toBe(0);
    expect(
      JSON.stringify(
        repository.getGenerationRunForEpoch(seeded.incoming.id, 0),
      ),
    ).not.toContain(proposal.paragraphs[0]);
  });

  it("atomically reaps a crashed final task attempt and its generating run", async () => {
    const seeded = seedReadyGeneration(repository);
    const model = new ScriptedLetterReplyModel(() => {
      throw new Error("model must not be called by exhausted reaping");
    });
    const encryptor = new FixtureEncryptor();
    const generation = createGenerationService(model, encryptor);

    let task = claimTask(
      repository,
      seeded.task.id,
      PROCESSED,
      RETRY_DUE,
      "claim-attempt-1",
    );
    let prepared = generation.preflight({ task, observedNowUtc: PROCESSED });
    retryRunAndTask(repository, prepared, task, RETRY_DUE, PROCESSED);

    task = claimTask(
      repository,
      seeded.task.id,
      SECOND_OBSERVED,
      "2026-09-09T01:03:00.000Z",
      "claim-attempt-2",
    );
    prepared = generation.preflight({ task, observedNowUtc: SECOND_OBSERVED });
    retryRunAndTask(repository, prepared, task, THIRD_DUE, SECOND_OBSERVED);

    task = claimTask(
      repository,
      seeded.task.id,
      THIRD_DUE,
      THIRD_LEASE_END,
      "claim-attempt-3",
    );
    prepared = generation.preflight({ task, observedNowUtc: THIRD_DUE });
    expect(prepared.status).toBe("claimed");
    const runId = prepared.run.id;
    const { catchUp } = createGenerationHarness(model, encryptor);

    const result = await catchUp.catchUpAgent(AGENT_ID, AFTER_CRASH);

    expect(result.completedTaskIds).toEqual([]);
    expect(result.retriedTaskIds).toEqual([]);
    expect(model.calls).toEqual([]);
    expect(repository.getTask(seeded.task.id)).toMatchObject({
      status: "dead_letter",
      attempt: 3,
    });
    expect(repository.getGenerationRun(runId)).toMatchObject({
      status: "failed",
      attempt: 3,
      errorCode: "generation_attempts_exhausted",
    });
    expect(life.calls).toEqual([THIRD_DUE, AFTER_CRASH]);
  });

  function createGenerationHarness(
    model: LetterReplyModel,
    encryptor: LetterReplyEncryptor,
  ): {
    generation: LetterReplyGenerationService;
    catchUp: TemporalCatchUpService;
  } {
    const generation = createGenerationService(model, encryptor);
    const catchUp = new TemporalCatchUpService(
      repository,
      life,
      actors,
      clock,
      {
        externalTaskHandler: generation.createExternalHandler(),
        createClaimToken: (task) => `claim-${task.id}-${(claimSequence += 1)}`,
        leaseMs: 30 * 60 * 1_000,
      },
    );
    return { generation, catchUp };
  }

  function createGenerationService(
    model: LetterReplyModel,
    encryptor: LetterReplyEncryptor,
  ): LetterReplyGenerationService {
    return new LetterReplyGenerationService(repository, model, encryptor, {
      provider: "fixture",
      model: "fixture-letter-v1",
      providerRepairAttempts: 1,
    });
  }
});

function seedReadyGeneration(repository: CorrespondenceRepository): {
  incoming: NonNullable<ReturnType<CorrespondenceRepository["getLetter"]>>;
  snapshot: NonNullable<ReturnType<CorrespondenceRepository["getSnapshot"]>>;
  task: TemporalTask;
} {
  const thread = repository.createThread(AGENT_ID, {
    id: "thread-generation",
    nowUtc: T0,
  });
  const subject = "九月来信";
  const body = "等你读到时，我大概已经出发了。";
  const draft = repository.createDraftLetter({
    id: "letter-incoming-generation",
    threadId: thread.id,
    agentId: AGENT_ID,
    subject,
    body,
    nowUtc: T0,
  });
  const sealed = repository.sealLetter({
    letterId: draft.id,
    contentHash: sha256(canonicalLetterContent({ subject, body })),
    transitPolicyVersion: "fixed_5d_v1",
    transitTimezone: "Asia/Shanghai",
    dispatchedAtUtc: T0,
    arrivalDueAtUtc: ARRIVAL,
    effectiveAuthorTimeUtc: T0,
    taskId: "task-unused-outbound",
    taskPriority: 10,
    clientRequestId: "seal-generation",
  });
  repository.markDelivered(draft.id, ARRIVAL, PROCESSED);
  const incoming = repository.markRead(draft.id, ARRIVAL);
  const claimedOutbound = repository.claimDueTask({
    taskId: sealed.task.id,
    agentId: AGENT_ID,
    kinds: ["letter.outbound_arrival"],
    nowUtc: PROCESSED,
    leaseExpiresAtUtc: "2026-09-09T01:30:00.000Z",
    claimToken: "setup-outbound-arrival",
  });
  if (claimedOutbound?.claimToken === undefined) {
    throw new Error("Could not claim the seeded outbound-arrival task");
  }
  repository.completeTask({
    taskId: claimedOutbound.id,
    claimToken: claimedOutbound.claimToken,
    completedAtUtc: PROCESSED,
  });
  const contextJson = generationContext();
  const evidenceIds = ["evidence-before-arrival"];
  const contextHash = sha256(
    canonicalLetterGenerationSnapshot({ contextJson, evidenceIds }),
  );
  const snapshot = repository.insertSnapshot({
    id: "snapshot-generation",
    incomingLetterId: incoming.id,
    agentId: AGENT_ID,
    effectiveAtUtc: ARRIVAL,
    characterVersion: 3,
    stateRevision: 8,
    contextJson,
    evidenceIds,
    contextHash,
    createdAtUtc: PROCESSED,
  });
  const task = repository.createTemporalTask({
    id: "task-reply-generation",
    agentId: AGENT_ID,
    kind: "letter.reply_generation",
    entityId: incoming.id,
    dueAtUtc: ARRIVAL,
    priority: 20,
    idempotencyKey: `letter-reply-generation:${incoming.id}:0`,
    payload: {
      incomingLetterId: incoming.id,
      snapshotId: snapshot.id,
      generationEpoch: 0,
    },
    maxAttempts: 3,
    createdAtUtc: PROCESSED,
  });
  return { incoming, snapshot, task };
}

function generationContext(): LetterGenerationContextV1 {
  return {
    schemaVersion: 1,
    effectiveAtUtc: ARRIVAL,
    sourceWindow: { fromUtc: T0, throughUtc: ARRIVAL },
    character: {
      version: 3,
      identity: { name: "林" },
      persona: { coreTraits: ["克制", "温暖"] },
      dialogue: { verbosity: 0.7 },
      userRelationship: { preferredAddress: "朋友" },
      knowledge: {},
    },
    runtimeState: { energy: 0.7 },
    relationship: { closeness: 0.75, trust: 0.8 },
    fuzzyLife: {
      dailyContext: { summary: "抵达日清晨很安静" },
      intents: [{ text: "也许去散步", status: "planned" }],
      threads: [],
      verifiedOutcomes: [],
      causalRecords: [],
    },
    intervalDigest: { activityEvents: [], lifeOutcomes: [] },
    memoryEvidence: [
      { id: "evidence-before-arrival", fact: "曾一起在秋天散步" },
    ],
    conversationTail: [],
    priorCorrespondence: [],
    budgets: { maxEvidenceItems: 20, stationeryType: "standard" },
  };
}

function claimTask(
  repository: CorrespondenceRepository,
  taskId: string,
  nowUtc: string,
  leaseExpiresAtUtc: string,
  claimToken: string,
): TemporalTask {
  const task = repository.claimDueTask({
    taskId,
    agentId: AGENT_ID,
    kinds: ["letter.reply_generation", "letter.generation_retry"],
    nowUtc,
    leaseExpiresAtUtc,
    claimToken,
  });
  if (task === undefined) throw new Error(`Could not claim ${taskId}`);
  return task;
}

function retryRunAndTask(
  repository: CorrespondenceRepository,
  prepared: ReturnType<LetterReplyGenerationService["preflight"]>,
  task: TemporalTask,
  nextDueAtUtc: string,
  nowUtc: string,
): void {
  if (prepared.status !== "claimed" || task.claimToken === undefined) {
    throw new Error("Expected a claimed generation attempt");
  }
  repository.retryGenerationRun({
    runId: prepared.run.id,
    claimToken: prepared.run.claimToken!,
    generationEpoch: prepared.payload.generationEpoch,
    errorCode: "network_timeout",
    nowUtc,
    retryable: true,
  });
  repository.retryTask({
    taskId: task.id,
    claimToken: task.claimToken,
    errorCode: "network_timeout",
    nowUtc,
    nextDueAtUtc,
    retryable: true,
  });
}

function countReplies(database: Database): number {
  return (
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM letters WHERE direction = 'agent_to_user'",
      )
      .get() as { count: number }
  ).count;
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
