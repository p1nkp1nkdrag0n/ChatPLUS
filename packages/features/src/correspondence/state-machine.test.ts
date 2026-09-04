import {
  type Letter,
  type LetterGenerationRunStatus,
  type LetterStatus,
  type TemporalTaskStatus,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  CorrespondenceStateMachineError,
  allowedLetterGenerationRunStatusTransitions,
  allowedLetterStatusTransitions,
  allowedTemporalTaskStatusTransitions,
  assertLetterGenerationRunStatusTransition,
  assertLetterStatusTransition,
  assertLetterUpdateAllowed,
  assertTemporalTaskStatusTransition,
  canTransitionLetterGenerationRunStatus,
  canTransitionLetterStatus,
  canTransitionTemporalTaskStatus,
  transitionLetterGenerationRunStatus,
  transitionLetterStatus,
  transitionTemporalTaskStatus,
} from "./state-machine.js";

const LETTER_STATUSES = [
  "draft",
  "sealed",
  "in_transit",
  "delivered_unread",
  "read",
  "cancelled",
] as const satisfies readonly LetterStatus[];

const GENERATION_RUN_STATUSES = [
  "pending",
  "generating",
  "retryable",
  "committed",
  "failed",
  "discarded",
] as const satisfies readonly LetterGenerationRunStatus[];

const TEMPORAL_TASK_STATUSES = [
  "pending",
  "claimed",
  "completed",
  "retryable",
  "dead_letter",
] as const satisfies readonly TemporalTaskStatus[];

const EXPECTED_LETTER_TRANSITIONS: Readonly<
  Record<LetterStatus, readonly LetterStatus[]>
> = {
  draft: ["sealed", "in_transit", "cancelled"],
  sealed: ["in_transit"],
  in_transit: ["delivered_unread"],
  delivered_unread: ["read"],
  read: [],
  cancelled: [],
};

const EXPECTED_GENERATION_TRANSITIONS: Readonly<
  Record<LetterGenerationRunStatus, readonly LetterGenerationRunStatus[]>
> = {
  pending: ["generating", "failed", "discarded"],
  generating: ["retryable", "committed", "failed", "discarded"],
  retryable: ["generating", "failed", "discarded"],
  committed: [],
  failed: [],
  discarded: [],
};

const EXPECTED_TASK_TRANSITIONS: Readonly<
  Record<TemporalTaskStatus, readonly TemporalTaskStatus[]>
> = {
  pending: ["claimed", "dead_letter"],
  claimed: ["completed", "retryable", "dead_letter"],
  completed: [],
  retryable: ["claimed", "dead_letter"],
  dead_letter: [],
};

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const sealedLetter: Letter = {
  id: "letter-1",
  threadId: "thread-1",
  agentId: "agent-1",
  direction: "user_to_agent",
  status: "sealed",
  subject: "九月来信",
  body: "封缄后的正文。",
  contentHash: HASH_A,
  transitPolicyVersion: "fixed_5d_v1",
  transitTimezone: "Asia/Shanghai",
  dispatchedAtUtc: "2026-09-03T12:00:00.000Z",
  arrivalDueAtUtc: "2026-09-08T12:00:00.000Z",
  effectiveAuthorTimeUtc: "2026-09-03T12:00:00.000Z",
  createdAtUtc: "2026-09-03T11:55:00.000Z",
  updatedAtUtc: "2026-09-03T12:00:00.000Z",
};

function expectStateMachineFailure(
  action: () => void,
  expected: Readonly<{
    code: string;
    details?: Readonly<Record<string, unknown>>;
  }>,
): void {
  try {
    action();
    throw new Error("Expected the state-machine operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CorrespondenceStateMachineError);
    expect(error).toMatchObject(expected);
  }
}

describe("correspondence state machine", () => {
  it("covers every legal and illegal letter transition", () => {
    for (const from of LETTER_STATUSES) {
      expect(allowedLetterStatusTransitions(from)).toEqual(
        EXPECTED_LETTER_TRANSITIONS[from],
      );
      for (const to of LETTER_STATUSES) {
        const expected = EXPECTED_LETTER_TRANSITIONS[from].includes(to);
        expect(canTransitionLetterStatus(from, to)).toBe(expected);
        if (expected) {
          expect(() => assertLetterStatusTransition(from, to)).not.toThrow();
          expect(transitionLetterStatus(from, to)).toBe(to);
        } else {
          expect(() => assertLetterStatusTransition(from, to)).toThrow(
            CorrespondenceStateMachineError,
          );
        }
      }
    }
  });

  it("covers every legal and illegal generation-run transition", () => {
    for (const from of GENERATION_RUN_STATUSES) {
      expect(allowedLetterGenerationRunStatusTransitions(from)).toEqual(
        EXPECTED_GENERATION_TRANSITIONS[from],
      );
      for (const to of GENERATION_RUN_STATUSES) {
        const expected = EXPECTED_GENERATION_TRANSITIONS[from].includes(to);
        expect(canTransitionLetterGenerationRunStatus(from, to)).toBe(expected);
        if (expected) {
          expect(() =>
            assertLetterGenerationRunStatusTransition(from, to),
          ).not.toThrow();
          expect(transitionLetterGenerationRunStatus(from, to)).toBe(to);
        } else {
          expect(() =>
            assertLetterGenerationRunStatusTransition(from, to),
          ).toThrow(CorrespondenceStateMachineError);
        }
      }
    }
  });

  it("covers every legal and illegal temporal-task transition", () => {
    for (const from of TEMPORAL_TASK_STATUSES) {
      expect(allowedTemporalTaskStatusTransitions(from)).toEqual(
        EXPECTED_TASK_TRANSITIONS[from],
      );
      for (const to of TEMPORAL_TASK_STATUSES) {
        const expected = EXPECTED_TASK_TRANSITIONS[from].includes(to);
        expect(canTransitionTemporalTaskStatus(from, to)).toBe(expected);
        if (expected) {
          expect(() =>
            assertTemporalTaskStatusTransition(from, to),
          ).not.toThrow();
          expect(transitionTemporalTaskStatus(from, to)).toBe(to);
        } else {
          expect(() => assertTemporalTaskStatusTransition(from, to)).toThrow(
            CorrespondenceStateMachineError,
          );
        }
      }
    }
  });

  it("allows draft content edits and a single seal transition", () => {
    const draft: Letter = {
      id: "letter-draft",
      threadId: "thread-1",
      agentId: "agent-1",
      direction: "user_to_agent",
      status: "draft",
      subject: "旧主题",
      body: "旧正文",
      createdAtUtc: "2026-09-03T11:55:00.000Z",
      updatedAtUtc: "2026-09-03T11:55:00.000Z",
    };

    expect(() =>
      assertLetterUpdateAllowed(draft, {
        subject: "新主题",
        body: "新正文",
        contentHash: HASH_A,
        transitPolicyVersion: "fixed_5d_v1",
        transitTimezone: "Asia/Shanghai",
        dispatchedAtUtc: "2026-09-03T12:00:00.000Z",
        arrivalDueAtUtc: "2026-09-08T12:00:00.000Z",
        effectiveAuthorTimeUtc: "2026-09-03T12:00:00.000Z",
        status: "sealed",
        updatedAtUtc: "2026-09-03T12:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it.each([
    ["subject", { subject: "改写主题" }],
    ["body", { body: "改写正文" }],
    ["contentHash", { contentHash: HASH_B }],
    ["transitPolicyVersion", { transitPolicyVersion: undefined }],
    ["transitTimezone", { transitTimezone: "Asia/Tokyo" }],
    ["dispatchedAtUtc", { dispatchedAtUtc: "2026-09-03T12:01:00.000Z" }],
    ["arrivalDueAtUtc", { arrivalDueAtUtc: "2026-09-08T12:01:00.000Z" }],
    [
      "effectiveAuthorTimeUtc",
      { effectiveAuthorTimeUtc: "2026-09-03T11:59:00.000Z" },
    ],
  ] as const)("rejects sealed changes to %s", (field, changes) => {
    try {
      assertLetterUpdateAllowed(sealedLetter, changes);
      throw new Error(
        "Expected the immutable field guard to reject the update",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(CorrespondenceStateMachineError);
      expect(error).toMatchObject({
        code: "immutable_letter_field",
        details: { from: "sealed", field },
      });
    }
  });

  it("allows operational state and audit updates without weakening sealing", () => {
    expect(() =>
      assertLetterUpdateAllowed(sealedLetter, {
        status: "in_transit",
        updatedAtUtc: "2026-09-03T12:00:01.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertLetterUpdateAllowed(sealedLetter, {
        body: sealedLetter.body,
        contentHash: sealedLetter.contentHash,
      }),
    ).not.toThrow();
  });

  it("allows delivery and direction-specific read/open times exactly once", () => {
    const deliveredAt = "2026-09-08T12:00:00.000Z";
    const processedAt = "2026-09-09T01:00:00.000Z";
    expect(() =>
      assertLetterUpdateAllowed(
        { ...sealedLetter, status: "in_transit" },
        {
          status: "delivered_unread",
          deliveredEffectiveAtUtc: deliveredAt,
          processedAtUtc: processedAt,
        },
      ),
    ).not.toThrow();

    const incomingDelivered: Letter = {
      ...sealedLetter,
      status: "delivered_unread",
      deliveredEffectiveAtUtc: deliveredAt,
      processedAtUtc: processedAt,
      updatedAtUtc: processedAt,
    };
    expect(() =>
      assertLetterUpdateAllowed(incomingDelivered, {
        status: "read",
        readAtUtc: processedAt,
      }),
    ).not.toThrow();

    const replyDelivered: Letter = {
      ...incomingDelivered,
      id: "letter-reply-1",
      replyToLetterId: incomingDelivered.id,
      direction: "agent_to_user",
      subject: undefined,
      body: undefined,
    };
    expect(() =>
      assertLetterUpdateAllowed(replyDelivered, {
        status: "read",
        openedAtUtc: processedAt,
      }),
    ).not.toThrow();

    const openedReply: Letter = {
      ...replyDelivered,
      status: "read",
      openedAtUtc: processedAt,
    };
    expectStateMachineFailure(
      () =>
        assertLetterUpdateAllowed(openedReply, {
          openedAtUtc: "2026-09-09T01:01:00.000Z",
        }),
      {
        code: "immutable_letter_field",
        details: { from: "read", field: "openedAtUtc" },
      },
    );
  });

  it.each([
    [
      "deliveredEffectiveAtUtc",
      { deliveredEffectiveAtUtc: "2026-09-08T12:01:00.000Z" },
    ],
    ["processedAtUtc", { processedAtUtc: "2026-09-09T01:01:00.000Z" }],
    ["readAtUtc", { readAtUtc: "2026-09-09T01:01:00.000Z" }],
  ] as const)("never rewrites the established %s fact", (field, changes) => {
    const readLetter: Letter = {
      ...sealedLetter,
      status: "read",
      deliveredEffectiveAtUtc: "2026-09-08T12:00:00.000Z",
      processedAtUtc: "2026-09-09T01:00:00.000Z",
      readAtUtc: "2026-09-09T01:00:00.000Z",
      updatedAtUtc: "2026-09-09T01:00:00.000Z",
    };
    expectStateMachineFailure(
      () => assertLetterUpdateAllowed(readLetter, changes),
      {
        code: "immutable_letter_field",
        details: { from: "read", field },
      },
    );
    expectStateMachineFailure(
      () => assertLetterUpdateAllowed(readLetter, { [field]: undefined }),
      {
        code: "immutable_letter_field",
        details: { from: "read", field },
      },
    );
  });

  it("rejects audit timestamps outside their lifecycle transition", () => {
    expectStateMachineFailure(
      () =>
        assertLetterUpdateAllowed(
          { ...sealedLetter, status: "in_transit" },
          { deliveredEffectiveAtUtc: "2026-09-08T12:00:00.000Z" },
        ),
      { code: "immutable_letter_field" },
    );
  });

  it("keeps identity immutable even while a letter is a draft", () => {
    const draft = { ...sealedLetter, status: "draft" as const };
    try {
      assertLetterUpdateAllowed(draft, { agentId: "agent-2" });
      throw new Error("Expected the identity guard to reject the update");
    } catch (error) {
      expect(error).toMatchObject({
        code: "immutable_letter_field",
        details: { from: "draft", field: "agentId" },
      });
    }
  });

  it("rejects illegal aggregate lifecycle skips with an explicit code", () => {
    try {
      assertLetterUpdateAllowed(sealedLetter, { status: "read" });
      throw new Error("Expected the status guard to reject the update");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_letter_status_transition",
        entity: "letter",
        details: { from: "sealed", to: "read" },
      });
    }
  });
});
