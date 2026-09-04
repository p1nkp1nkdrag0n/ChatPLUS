import { describe, expect, it } from "vitest";

import {
  CorrespondenceMailboxQuerySchema,
  CorrespondenceMailboxResponseSchema,
  CorrespondenceReplyStateSchema,
  CorrespondenceThreadSchema,
  CorrespondenceThreadSummaryResponseSchema,
  CreateLetterDraftRequestSchema,
  DeveloperTemporalTasksResponseSchema,
  EncryptedLetterBodySchema,
  FixedTransitPolicyV1Schema,
  LetterGenerationContextV1Schema,
  LetterGenerationRunSchema,
  LetterGenerationSnapshotSchema,
  LetterReplyGenerationTaskPayloadSchema,
  LetterReplyProposalSchema,
  LetterSchema,
  LetterDetailResponseSchema,
  LetterStatusSchema,
  LetterSummaryResponseSchema,
  OpenLetterResponseSchema,
  OpenLetterRequestSchema,
  SealLetterRequestSchema,
  TemporalTaskSchema,
  UpdateLetterDraftRequestSchema,
} from "./correspondence.js";

const HASH = "a".repeat(64);
const CREATED_AT = "2026-09-03T12:00:00.000Z";
const ARRIVAL_AT = "2026-09-08T12:00:00.000Z";
const PROCESSED_AT = "2026-09-09T01:00:00.000Z";

const thread = {
  id: "thread-1",
  agentId: "agent-1",
  status: "open" as const,
  rootLetterId: "letter-1",
  latestLetterId: "letter-1",
  createdAtUtc: CREATED_AT,
  updatedAtUtc: CREATED_AT,
};

const letter = {
  id: "letter-1",
  threadId: "thread-1",
  agentId: "agent-1",
  direction: "user_to_agent" as const,
  status: "in_transit" as const,
  subject: "九月来信",
  body: "见字如面。",
  contentHash: HASH,
  transitPolicyVersion: "fixed_5d_v1" as const,
  transitTimezone: "Asia/Shanghai",
  dispatchedAtUtc: CREATED_AT,
  arrivalDueAtUtc: ARRIVAL_AT,
  effectiveAuthorTimeUtc: CREATED_AT,
  createdAtUtc: CREATED_AT,
  updatedAtUtc: CREATED_AT,
};

const encryptedBody = {
  letterId: "letter-reply-1",
  ciphertext: "YWJjZA==",
  iv: "YWJjZA==",
  authTag: "YWJjZA==",
  keyVersion: 1,
  aadHash: HASH,
  createdAtUtc: PROCESSED_AT,
};

const snapshot = {
  id: "snapshot-1",
  incomingLetterId: "letter-1",
  agentId: "agent-1",
  effectiveAtUtc: ARRIVAL_AT,
  characterVersion: 3,
  stateRevision: 8,
  contextJson: {
    schemaVersion: 1 as const,
    effectiveAtUtc: ARRIVAL_AT,
    sourceWindow: { fromUtc: CREATED_AT, throughUtc: ARRIVAL_AT },
    character: {
      version: 3,
      identity: { name: "Lin" },
      persona: { traits: ["克制", "温暖"] },
      dialogue: { verbosity: 0.6 },
      userRelationship: { addressPreference: "朋友" },
      knowledge: { hometown: "上海" },
    },
    runtimeState: { energy: 0.7 },
    relationship: { closeness: 0.6, trust: 0.7 },
    fuzzyLife: {
      dailyContext: { summary: "平静的一天" },
      intents: [],
      threads: [],
      verifiedOutcomes: [],
      causalRecords: [],
    },
    intervalDigest: { activityEvents: [], lifeOutcomes: [] },
    memoryEvidence: [],
    conversationTail: [],
    priorCorrespondence: [],
    budgets: { maxEvidenceItems: 20 },
  },
  evidenceIds: ["memory-1", "event-1"],
  contextHash: HASH,
  createdAtUtc: PROCESSED_AT,
};

const generationRun = {
  id: "run-1",
  incomingLetterId: "letter-1",
  snapshotId: "snapshot-1",
  agentId: "agent-1",
  generationEpoch: 0,
  status: "pending" as const,
  attempt: 0,
  createdAtUtc: PROCESSED_AT,
  updatedAtUtc: PROCESSED_AT,
};

const temporalTask = {
  id: "task-1",
  agentId: "agent-1",
  kind: "letter.outbound_arrival" as const,
  entityId: "letter-1",
  dueAtUtc: ARRIVAL_AT,
  priority: 10,
  status: "pending" as const,
  attempt: 0,
  maxAttempts: 3,
  idempotencyKey: "letter-arrival:letter-1",
  payload: { letterId: "letter-1" },
  createdAtUtc: CREATED_AT,
  updatedAtUtc: CREATED_AT,
};

const proposal = {
  subject: "九月回信",
  salutation: "亲爱的朋友：",
  paragraphs: ["来信已经收到。", "愿你近日安好。"],
  closing: "顺颂秋安",
  signature: "林",
  referencedEvidenceIds: ["memory-1"],
};

const summary = {
  id: "letter-reply-1",
  threadId: "thread-1",
  direction: "agent_to_user" as const,
  status: "delivered_unread" as const,
  authoredDisplayDate: "2026-09-08",
  dispatchedAtUtc: ARRIVAL_AT,
  arrivalDueAtUtc: "2026-09-13T12:00:00.000Z",
  progress: 1,
  postmark: "上海 · 9月8日",
  canOpen: true,
  canEdit: false,
};

describe("correspondence contracts", () => {
  it("accepts the strict core domain records", () => {
    expect(CorrespondenceThreadSchema.parse(thread)).toEqual(thread);
    expect(LetterSchema.parse(letter)).toEqual(letter);
    expect(EncryptedLetterBodySchema.parse(encryptedBody)).toEqual(
      encryptedBody,
    );
    expect(LetterGenerationSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(LetterGenerationRunSchema.parse(generationRun)).toEqual(
      generationRun,
    );
    expect(TemporalTaskSchema.parse(temporalTask)).toEqual(temporalTask);
    expect(LetterReplyProposalSchema.parse(proposal)).toEqual(proposal);
  });

  it("makes every object contract strict", () => {
    const cases = [
      [CorrespondenceThreadSchema, thread],
      [LetterSchema, letter],
      [EncryptedLetterBodySchema, encryptedBody],
      [LetterGenerationSnapshotSchema, snapshot],
      [LetterGenerationRunSchema, generationRun],
      [TemporalTaskSchema, temporalTask],
      [LetterReplyProposalSchema, proposal],
      [
        FixedTransitPolicyV1Schema,
        {
          version: "fixed_5d_v1",
          outboundDays: 5,
          returnDays: 5,
          progressBasis: "wall_clock",
          displayPrecision: "day",
        },
      ],
      [LetterSummaryResponseSchema, summary],
      [
        CorrespondenceThreadSummaryResponseSchema,
        {
          id: thread.id,
          agentId: thread.agentId,
          status: thread.status,
          rootLetterId: thread.rootLetterId,
          latestLetterId: thread.latestLetterId,
        },
      ],
    ] as const;

    for (const [schema, value] of cases) {
      expect(
        schema.safeParse({ ...value, unrecognizedInfrastructureField: true })
          .success,
      ).toBe(false);
    }
  });

  it("uses canonical entity IDs and UTC timestamps", () => {
    expect(
      CorrespondenceThreadSchema.safeParse({ ...thread, id: "bad id" }).success,
    ).toBe(false);
    expect(
      TemporalTaskSchema.safeParse({
        ...temporalTask,
        dueAtUtc: "2026-09-08T20:00:00+08:00",
      }).success,
    ).toBe(false);
  });

  it("keeps thread lifecycle timestamps coherent", () => {
    expect(
      CorrespondenceThreadSchema.safeParse({
        ...thread,
        status: "closed",
      }).success,
    ).toBe(false);
    expect(
      CorrespondenceThreadSchema.safeParse({
        ...thread,
        closedAtUtc: ARRIVAL_AT,
      }).success,
    ).toBe(false);
    expect(
      CorrespondenceThreadSchema.safeParse({
        ...thread,
        rootLetterId: undefined,
      }).success,
    ).toBe(false);
  });

  it("requires a complete frozen transport envelope after draft", () => {
    const draft = {
      id: "letter-draft",
      threadId: "thread-1",
      agentId: "agent-1",
      direction: "user_to_agent",
      status: "draft",
      body: "仍可修改",
      createdAtUtc: CREATED_AT,
      updatedAtUtc: CREATED_AT,
    };
    expect(LetterSchema.safeParse(draft).success).toBe(true);
    expect(
      LetterSchema.safeParse({ ...draft, contentHash: HASH }).success,
    ).toBe(false);
    expect(
      LetterSchema.safeParse({ ...letter, arrivalDueAtUtc: undefined }).success,
    ).toBe(false);
    expect(LetterSchema.safeParse({ ...letter, body: "   " }).success).toBe(
      false,
    );
  });

  it("never permits agent reply plaintext in the letter record", () => {
    const reply = {
      ...letter,
      id: "letter-reply-1",
      replyToLetterId: "letter-1",
      direction: "agent_to_user",
      subject: undefined,
      body: undefined,
      effectiveAuthorTimeUtc: ARRIVAL_AT,
      dispatchedAtUtc: ARRIVAL_AT,
      arrivalDueAtUtc: "2026-09-13T12:00:00.000Z",
      createdAtUtc: PROCESSED_AT,
      updatedAtUtc: PROCESSED_AT,
    };
    expect(LetterSchema.safeParse(reply).success).toBe(true);
    expect(LetterSchema.safeParse({ ...reply, body: "泄漏" }).success).toBe(
      false,
    );
    expect(
      LetterSchema.safeParse({ ...reply, replyToLetterId: undefined }).success,
    ).toBe(false);
  });

  it("separates effective, processed, and read times", () => {
    const delivered = {
      ...letter,
      status: "delivered_unread",
      deliveredEffectiveAtUtc: ARRIVAL_AT,
      processedAtUtc: PROCESSED_AT,
      updatedAtUtc: PROCESSED_AT,
    };
    expect(LetterSchema.safeParse(delivered).success).toBe(true);
    expect(
      LetterSchema.safeParse({
        ...delivered,
        processedAtUtc: "2026-09-08T11:59:59.000Z",
      }).success,
    ).toBe(false);
    expect(
      LetterSchema.safeParse({
        ...delivered,
        status: "read",
      }).success,
    ).toBe(false);
    expect(
      LetterSchema.safeParse({
        ...delivered,
        status: "read",
        readAtUtc: ARRIVAL_AT,
      }).success,
    ).toBe(true);
    expect(
      LetterSchema.safeParse({
        ...delivered,
        status: "read",
        readAtUtc: PROCESSED_AT,
      }).success,
    ).toBe(false);
  });

  it("distinguishes character reads from user opens", () => {
    const openedReply = {
      ...letter,
      id: "letter-reply-1",
      replyToLetterId: "letter-1",
      direction: "agent_to_user",
      status: "read",
      subject: undefined,
      body: undefined,
      effectiveAuthorTimeUtc: ARRIVAL_AT,
      dispatchedAtUtc: ARRIVAL_AT,
      arrivalDueAtUtc: "2026-09-13T12:00:00.000Z",
      deliveredEffectiveAtUtc: "2026-09-13T12:00:00.000Z",
      processedAtUtc: "2026-09-15T02:00:00.000Z",
      openedAtUtc: "2026-09-15T02:05:00.000Z",
      createdAtUtc: PROCESSED_AT,
      updatedAtUtc: "2026-09-15T02:05:00.000Z",
    };
    expect(LetterSchema.safeParse(openedReply).success).toBe(true);
    expect(
      LetterSchema.safeParse({
        ...openedReply,
        openedAtUtc: undefined,
        readAtUtc: "2026-09-15T02:05:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      LetterSchema.safeParse({
        ...letter,
        status: "read",
        deliveredEffectiveAtUtc: ARRIVAL_AT,
        processedAtUtc: PROCESSED_AT,
        openedAtUtc: PROCESSED_AT,
        updatedAtUtc: PROCESSED_AT,
      }).success,
    ).toBe(false);
  });

  it("validates encrypted material and immutable snapshot inputs", () => {
    expect(
      EncryptedLetterBodySchema.safeParse({
        ...encryptedBody,
        ciphertext: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      LetterGenerationSnapshotSchema.safeParse({
        ...snapshot,
        contextJson: [],
      }).success,
    ).toBe(false);
    expect(
      LetterGenerationSnapshotSchema.safeParse({
        ...snapshot,
        evidenceIds: ["memory-1", "memory-1"],
      }).success,
    ).toBe(false);
  });

  it("freezes the generation context at the arrival boundary", () => {
    expect(
      LetterGenerationContextV1Schema.safeParse({
        ...snapshot.contextJson,
        processedAtUtc: PROCESSED_AT,
      }).success,
    ).toBe(false);
    expect(
      LetterGenerationContextV1Schema.safeParse({
        ...snapshot.contextJson,
        sourceWindow: {
          ...snapshot.contextJson.sourceWindow,
          throughUtc: PROCESSED_AT,
        },
      }).success,
    ).toBe(false);
    expect(
      LetterGenerationSnapshotSchema.safeParse({
        ...snapshot,
        characterVersion: snapshot.characterVersion + 1,
      }).success,
    ).toBe(false);
  });

  it("keeps reply-generation task payloads minimal and strict", () => {
    const payload = {
      incomingLetterId: "letter-1",
      snapshotId: "snapshot-1",
      generationEpoch: 0,
    };
    expect(LetterReplyGenerationTaskPayloadSchema.parse(payload)).toEqual(
      payload,
    );
    expect(
      LetterReplyGenerationTaskPayloadSchema.safeParse({
        ...payload,
        snapshotHash: HASH,
      }).success,
    ).toBe(false);
  });

  it("requires claims, leases, and terminal audit fields by status", () => {
    expect(
      LetterGenerationRunSchema.safeParse({
        ...generationRun,
        status: "generating",
      }).success,
    ).toBe(false);
    expect(
      LetterGenerationRunSchema.safeParse({
        ...generationRun,
        status: "generating",
        attempt: 1,
        claimToken: "claim-1",
        claimedAtUtc: PROCESSED_AT,
        leaseExpiresAtUtc: "2026-09-09T01:05:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      LetterGenerationRunSchema.safeParse({
        ...generationRun,
        claimToken: "stale-claim",
        claimedAtUtc: PROCESSED_AT,
        leaseExpiresAtUtc: "2026-09-09T01:05:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      LetterGenerationRunSchema.safeParse({
        ...generationRun,
        status: "committed",
        committedAtUtc: PROCESSED_AT,
      }).success,
    ).toBe(false);
    expect(
      LetterGenerationRunSchema.safeParse({
        ...generationRun,
        status: "committed",
        attempt: 1,
        replyLetterId: "letter-reply-1",
        provider: "fixture",
        model: "fixture-correspondence-v1",
        resultHash: HASH,
        committedAtUtc: PROCESSED_AT,
      }).success,
    ).toBe(true);
    expect(
      LetterGenerationRunSchema.safeParse({
        ...generationRun,
        resultHash: HASH.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      TemporalTaskSchema.safeParse({
        ...temporalTask,
        status: "claimed",
      }).success,
    ).toBe(false);
    expect(
      TemporalTaskSchema.safeParse({
        ...temporalTask,
        claimToken: "stale-claim",
        claimedAtUtc: PROCESSED_AT,
        leaseExpiresAtUtc: "2026-09-09T01:05:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      TemporalTaskSchema.safeParse({
        ...temporalTask,
        attempt: 4,
      }).success,
    ).toBe(false);
    expect(
      TemporalTaskSchema.safeParse({
        ...temporalTask,
        payload: [],
      }).success,
    ).toBe(false);
    expect(
      TemporalTaskSchema.safeParse({
        ...temporalTask,
        status: "completed",
      }).success,
    ).toBe(false);
  });

  it("keeps the model proposal free of infrastructure controls", () => {
    expect(
      LetterReplyProposalSchema.safeParse({
        ...proposal,
        referencedEvidenceIds: ["memory-1", "memory-1"],
      }).success,
    ).toBe(false);
    expect(
      LetterReplyProposalSchema.safeParse({
        ...proposal,
        letterId: "letter-reply-1",
        status: "in_transit",
        arrivalDueAtUtc: ARRIVAL_AT,
        ciphertext: "YWJjZA==",
      }).success,
    ).toBe(false);
  });

  it("keeps unopened API projections free of reply previews and ciphertext", () => {
    expect(LetterSummaryResponseSchema.safeParse(summary).success).toBe(true);
    expect(
      LetterSummaryResponseSchema.safeParse({
        ...summary,
        previewText: "不应出现的回信内容",
      }).success,
    ).toBe(false);
    expect(
      LetterSummaryResponseSchema.safeParse({
        ...summary,
        ciphertext: "YWJjZA==",
      }).success,
    ).toBe(false);
  });

  it("projects reply preparation without exposing temporal-task internals", () => {
    expect(
      CorrespondenceReplyStateSchema.parse({
        kind: "waiting",
        incomingLetterId: "letter-incoming",
      }),
    ).toEqual({
      kind: "waiting",
      incomingLetterId: "letter-incoming",
    });
    expect(
      CorrespondenceReplyStateSchema.parse({
        kind: "retry_scheduled",
        incomingLetterId: "letter-incoming",
      }),
    ).toEqual({
      kind: "retry_scheduled",
      incomingLetterId: "letter-incoming",
    });
    expect(
      CorrespondenceReplyStateSchema.parse({
        kind: "failed",
        incomingLetterId: "letter-incoming",
        canRetry: true,
      }),
    ).toEqual({
      kind: "failed",
      incomingLetterId: "letter-incoming",
      canRetry: true,
    });
    expect(
      CorrespondenceReplyStateSchema.safeParse({
        kind: "failed",
        incomingLetterId: "letter-incoming",
        canRetry: true,
        taskId: "task-private",
        errorCode: "provider-private-error",
      }).success,
    ).toBe(false);
    expect(
      CorrespondenceReplyStateSchema.safeParse({
        kind: "retry_scheduled",
        incomingLetterId: "letter-incoming",
        canRetry: true,
      }).success,
    ).toBe(false);
    expect(
      CorrespondenceThreadSummaryResponseSchema.safeParse({
        id: "thread-1",
        agentId: "agent-1",
        status: "closed",
        latestLetterId: "letter-incoming",
        replyState: {
          kind: "failed",
          incomingLetterId: "letter-incoming",
          canRetry: false,
        },
      }).success,
    ).toBe(false);
    expect(
      CorrespondenceThreadSummaryResponseSchema.safeParse({
        id: "thread-1",
        agentId: "agent-1",
        status: "open",
        latestLetterId: "letter-other",
        replyState: {
          kind: "waiting",
          incomingLetterId: "letter-incoming",
        },
      }).success,
    ).toBe(false);
  });

  it("only returns decrypted content after the reply is marked read", () => {
    const opened = {
      letter: {
        ...summary,
        status: "read" as const,
        previewText: "来信已经收到。",
      },
      body: "来信已经收到。\n\n愿你近日安好。",
      subject: "九月回信",
      salutation: "亲爱的朋友：",
      closing: "顺颂秋安",
      signature: "林",
      relatedKeepsakeIds: [],
    };
    expect(OpenLetterResponseSchema.safeParse(opened).success).toBe(true);
    expect(
      OpenLetterResponseSchema.safeParse({
        ...opened,
        letter: summary,
      }).success,
    ).toBe(false);
    expect(
      OpenLetterResponseSchema.safeParse({
        ...opened,
        authTag: "YWJjZA==",
      }).success,
    ).toBe(false);
  });

  it("strictly validates correspondence HTTP requests and mailbox envelopes", () => {
    expect(CorrespondenceMailboxQuerySchema.parse({})).toEqual({ limit: 500 });
    expect(
      CorrespondenceMailboxQuerySchema.parse({
        limit: "25",
        cursor: "opaque-mailbox-cursor",
      }),
    ).toEqual({ limit: 25, cursor: "opaque-mailbox-cursor" });
    expect(
      CorrespondenceMailboxQuerySchema.safeParse({ limit: 501 }).success,
    ).toBe(false);
    expect(
      CorrespondenceMailboxQuerySchema.safeParse({
        cursor: "cursor",
        unknown: true,
      }).success,
    ).toBe(false);
    expect(
      CreateLetterDraftRequestSchema.safeParse({
        clientRequestId: "create-1",
        subject: "主题",
        body: "正文",
      }).success,
    ).toBe(true);
    expect(
      CreateLetterDraftRequestSchema.safeParse({
        clientRequestId: "create-1",
        body: "正文",
        ciphertext: "YWJjZA==",
      }).success,
    ).toBe(false);
    expect(UpdateLetterDraftRequestSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateLetterDraftRequestSchema.safeParse({ subject: null }).success,
    ).toBe(true);
    expect(
      SealLetterRequestSchema.safeParse({ clientRequestId: "seal-1" }).success,
    ).toBe(true);
    expect(OpenLetterRequestSchema.safeParse({}).success).toBe(true);
    expect(OpenLetterRequestSchema.safeParse({ force: true }).success).toBe(
      false,
    );
    expect(
      CorrespondenceMailboxResponseSchema.safeParse({
        threads: [
          {
            id: "thread-1",
            agentId: "agent-1",
            status: "open",
            rootLetterId: "letter-1",
            latestLetterId: "letter-1",
          },
        ],
        letters: [summary],
        serverTimeUtc: PROCESSED_AT,
        nextCursor: "opaque-mailbox-cursor",
      }).success,
    ).toBe(true);
  });

  it("keeps ordinary detail plaintext behind direction and opened state", () => {
    const userSummary = {
      ...summary,
      direction: "user_to_agent" as const,
      status: "in_transit" as const,
      canOpen: false,
      canEdit: false,
      previewText: "用户正文",
    };
    expect(
      LetterDetailResponseSchema.safeParse({
        letter: userSummary,
        subject: "主题",
        body: "用户正文",
      }).success,
    ).toBe(true);
    expect(
      LetterDetailResponseSchema.safeParse({
        letter: summary,
        subject: "提前泄漏",
        body: "提前泄漏",
      }).success,
    ).toBe(false);
    expect(
      LetterDetailResponseSchema.safeParse({
        letter: { ...summary, status: "read", previewText: "已启封" },
        subject: "回信",
        body: "已启封正文",
        salutation: "你好：",
        closing: "祝好",
        signature: "角色",
        relatedKeepsakeIds: [],
      }).success,
    ).toBe(true);
    expect(
      LetterDetailResponseSchema.safeParse({
        letter: { ...summary, status: "read", previewText: "已启封" },
        subject: "回信",
        body: "已启封正文",
        salutation: "你好：",
        closing: "祝好",
        signature: "角色",
        relatedKeepsakeIds: [],
        encryptedBody,
      }).success,
    ).toBe(false);
  });

  it("projects developer task leases without mutation credentials or payloads", () => {
    const claimedTask = {
      id: "task-1",
      agentId: "agent-1",
      kind: "letter.reply_generation",
      entityId: "letter-1",
      dueAtUtc: ARRIVAL_AT,
      priority: 100,
      status: "claimed",
      claimedAtUtc: ARRIVAL_AT,
      leaseExpiresAtUtc: PROCESSED_AT,
      attempt: 1,
      maxAttempts: 3,
      createdAtUtc: CREATED_AT,
      updatedAtUtc: ARRIVAL_AT,
    };
    expect(
      DeveloperTemporalTasksResponseSchema.safeParse({
        tasks: [claimedTask],
      }).success,
    ).toBe(true);
    expect(
      DeveloperTemporalTasksResponseSchema.safeParse({
        tasks: [{ ...claimedTask, claimToken: "private-lease-token" }],
      }).success,
    ).toBe(false);
    expect(
      DeveloperTemporalTasksResponseSchema.safeParse({
        tasks: [{ ...claimedTask, payload: { body: "private letter" } }],
      }).success,
    ).toBe(false);
    expect(
      DeveloperTemporalTasksResponseSchema.safeParse({
        tasks: [
          {
            ...claimedTask,
            status: "pending",
            claimedAtUtc: undefined,
            leaseExpiresAtUtc: undefined,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("keeps the three status vocabularies independent", () => {
    expect(LetterStatusSchema.safeParse("in_transit").success).toBe(true);
    expect(LetterStatusSchema.safeParse("generating").success).toBe(false);
    expect(LetterStatusSchema.safeParse("claimed").success).toBe(false);
  });
});
