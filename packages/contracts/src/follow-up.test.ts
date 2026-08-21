import { describe, expect, it } from "vitest";

import {
  CareCueSchema,
  FollowUpCandidateSchema,
  FollowUpIntentSchema,
  ProactiveDeliverySubjectSchema,
  ProactiveGenerationRunSchema,
} from "./follow-up.js";

const NOW_UTC = "2026-08-21T04:00:00.000Z";

function followUp(overrides: Record<string, unknown> = {}) {
  return {
    id: "followup-1",
    agentId: "agent-1",
    sessionId: "session-1",
    subjectType: "user_event",
    contextSummary: "The user has a portfolio review tomorrow.",
    expectedOutcomeDescription: "How the portfolio review went.",
    sourceMessageId: "message-user-1",
    earliestAtUtc: "2026-08-22T12:00:00.000Z",
    expiresAtUtc: "2026-08-25T12:00:00.000Z",
    status: "pending",
    maxAttempts: 1,
    attemptCount: 0,
    dedupeKey: "followup:v1:review",
    revision: 0,
    generationEpoch: 0,
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
    ...overrides,
  };
}

function careCue(overrides: Record<string, unknown> = {}) {
  return {
    id: "cue-1",
    agentId: "agent-1",
    sessionId: "session-1",
    contextSummary: "The user is preparing a portfolio.",
    mentionGuidance: "Ask naturally only when the portfolio is relevant.",
    sourceMessageId: "message-user-1",
    expiresAtUtc: "2026-09-01T04:00:00.000Z",
    status: "active",
    maxMentions: 1,
    mentionCount: 0,
    dedupeKey: "carecue:v1:portfolio",
    revision: 0,
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
    ...overrides,
  };
}

function generationRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "generation-1",
    agentId: "agent-1",
    sourceKind: "activity_candidate",
    proactiveCandidateId: "candidate-1",
    generationEpoch: 1,
    claimToken: "claim-1",
    status: "generating",
    sessionId: "session-1",
    preflightSpecVersion: 1,
    preflightStateRevision: 2,
    preflightSourceRevision: 3,
    preflightMessageRowid: 4,
    preflightLastUserMessageRowid: 2,
    preflightUserArrivalEpoch: 5,
    startedAtUtc: NOW_UTC,
    ...overrides,
  };
}

describe("FollowUp and CareCue contracts", () => {
  it("keeps ownership, exact time, status, and retry policy out of model candidates", () => {
    const candidate = {
      subjectType: "user_event",
      contextSummary: "The user has a portfolio review tomorrow.",
      expectedOutcomeDescription: "How the portfolio review went.",
      timingHint: "tomorrow afternoon",
      evidenceQuotes: ["portfolio review tomorrow"],
      reasonCode: "future_user_event",
      reasonSummary: "The user stated a bounded future event.",
    };
    expect(FollowUpCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(
      FollowUpCandidateSchema.safeParse({
        ...candidate,
        id: "model-id",
        earliestAtUtc: "2026-08-22T12:00:00.000Z",
        maxAttempts: 2,
      }).success,
    ).toBe(false);
  });

  it("enforces exactly one attempt and sent-message linkage", () => {
    expect(FollowUpIntentSchema.safeParse(followUp()).success).toBe(true);
    expect(
      FollowUpIntentSchema.safeParse(followUp({ maxAttempts: 2 })).success,
    ).toBe(false);
    expect(
      FollowUpIntentSchema.safeParse(
        followUp({ status: "sent", attemptCount: 1 }),
      ).success,
    ).toBe(false);
    expect(
      FollowUpIntentSchema.safeParse(
        followUp({
          status: "sent",
          attemptCount: 1,
          sentMessageId: "message-proactive-1",
        }),
      ).success,
    ).toBe(true);
  });

  it("requires evidence for resolution and cancellation", () => {
    expect(
      FollowUpIntentSchema.safeParse(followUp({ status: "resolved" })).success,
    ).toBe(false);
    expect(
      FollowUpIntentSchema.safeParse(
        followUp({
          status: "cancelled",
          resolutionMessageId: "message-user-2",
        }),
      ).success,
    ).toBe(true);
  });

  it("enforces CareCue exhaustion and dismissal invariants", () => {
    expect(CareCueSchema.safeParse(careCue()).success).toBe(true);
    expect(CareCueSchema.safeParse(careCue({ mentionCount: 1 })).success).toBe(
      false,
    );
    expect(
      CareCueSchema.safeParse(careCue({ status: "exhausted", mentionCount: 1 }))
        .success,
    ).toBe(true);
    expect(
      CareCueSchema.safeParse(careCue({ status: "dismissed" })).success,
    ).toBe(false);
    expect(
      CareCueSchema.safeParse(
        careCue({
          status: "dismissed",
          dismissedByMessageId: "message-user-2",
        }),
      ).success,
    ).toBe(true);
  });

  it("keeps CareCue out of the proactive delivery subject union", () => {
    expect(
      ProactiveDeliverySubjectSchema.safeParse({
        kind: "care_cue",
        careCueId: "cue-1",
        revision: 0,
        generationEpoch: 0,
        earliestAtUtc: "2026-08-22T12:00:00.000Z",
        expiresAtUtc: "2026-08-25T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      ProactiveDeliverySubjectSchema.safeParse({
        kind: "follow_up",
        followUpIntentId: "followup-1",
        revision: 0,
        generationEpoch: 0,
        earliestAtUtc: "2026-08-22T12:00:00.000Z",
        expiresAtUtc: "2026-08-25T12:00:00.000Z",
        maxAttempts: 1,
        attemptCount: 0,
      }).success,
    ).toBe(true);
  });
});

describe("Proactive generation contract", () => {
  it("requires exactly one source matching sourceKind", () => {
    expect(
      ProactiveGenerationRunSchema.safeParse(generationRun()).success,
    ).toBe(true);
    expect(
      ProactiveGenerationRunSchema.safeParse(
        generationRun({ followUpIntentId: "followup-1" }),
      ).success,
    ).toBe(false);
    expect(
      ProactiveGenerationRunSchema.safeParse(
        generationRun({
          sourceKind: "follow_up",
          proactiveCandidateId: undefined,
          followUpIntentId: "followup-1",
        }),
      ).success,
    ).toBe(true);
  });

  it("requires terminal time, reason, and committed message linkage", () => {
    expect(
      ProactiveGenerationRunSchema.safeParse(
        generationRun({ status: "stale_discarded" }),
      ).success,
    ).toBe(false);
    expect(
      ProactiveGenerationRunSchema.safeParse(
        generationRun({
          status: "stale_discarded",
          reasonCode: "user_returned",
          completedAtUtc: "2026-08-21T04:01:00.000Z",
        }),
      ).success,
    ).toBe(true);
    expect(
      ProactiveGenerationRunSchema.safeParse(
        generationRun({
          status: "committed",
          completedAtUtc: "2026-08-21T04:01:00.000Z",
        }),
      ).success,
    ).toBe(false);
  });
});
