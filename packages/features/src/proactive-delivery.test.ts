import { describe, expect, it } from "vitest";

import {
  evaluateProactivePostflight,
  evaluateProactivePreflight,
  isProactiveDeliverySubject,
  type ProactivePostflightInput,
  type ProactivePreflightInput,
} from "./proactive-delivery.js";

const NOW_UTC = "2026-08-21T12:00:00.000Z";

function preflight(
  overrides: Partial<ProactivePreflightInput> = {},
): ProactivePreflightInput {
  return {
    subject: {
      kind: "activity_candidate",
      status: "pending",
      earliestAtUtc: "2026-08-21T11:00:00.000Z",
      expiresAtUtc: "2026-08-22T12:00:00.000Z",
      alreadyDiscussed: false,
    },
    nowUtc: NOW_UTC,
    tierSupportsProactive: true,
    policyEnabled: true,
    generationInProgress: false,
    quietHours: false,
    sentToday: 0,
    dailyLimit: 2,
    relationshipCloseness: 0.8,
    minimumCloseness: 0.4,
    unansweredCount: 0,
    maximumUnanswered: 1,
    activeConversation: false,
    ...overrides,
  };
}

function postflight(
  overrides: Partial<ProactivePostflightInput> = {},
): ProactivePostflightInput {
  return {
    generationMatches: true,
    preflightSpecVersion: 1,
    currentSpecVersion: 1,
    preflightStateRevision: 2,
    currentStateRevision: 2,
    preflightUserArrivalEpoch: 3,
    currentUserArrivalEpoch: 3,
    inFlightUserTurns: 0,
    preflightLastUserMessageRowid: 10,
    currentLastUserMessageRowid: 10,
    preflightMessageRowid: 12,
    currentMessageRowid: 12,
    sourceStillClaimed: true,
    sourceExpired: false,
    alreadyDiscussed: false,
    ...overrides,
  };
}

describe("proactive preflight", () => {
  it("allows only an eligible delivery subject", () => {
    expect(evaluateProactivePreflight(preflight())).toEqual({ allowed: true });
    expect(
      isProactiveDeliverySubject({
        kind: "care_cue",
        status: "active",
        earliestAtUtc: NOW_UTC,
        expiresAtUtc: "2026-08-22T12:00:00.000Z",
        alreadyDiscussed: false,
      }),
    ).toBe(false);
  });

  it.each([
    ["tier_not_supported", { tierSupportsProactive: false }],
    ["policy_disabled", { policyEnabled: false }],
    ["generation_in_progress", { generationInProgress: true }],
    [
      "source_not_pending",
      {
        subject: {
          kind: "activity_candidate",
          status: "sent",
          earliestAtUtc: "2026-08-21T11:00:00.000Z",
          expiresAtUtc: "2026-08-22T12:00:00.000Z",
          alreadyDiscussed: false,
        },
      },
    ],
    [
      "source_expired",
      {
        subject: {
          kind: "activity_candidate",
          status: "pending",
          earliestAtUtc: "2026-08-20T11:00:00.000Z",
          expiresAtUtc: NOW_UTC,
          alreadyDiscussed: false,
        },
      },
    ],
    [
      "source_not_due",
      {
        subject: {
          kind: "activity_candidate",
          status: "pending",
          earliestAtUtc: "2026-08-21T13:00:00.000Z",
          expiresAtUtc: "2026-08-22T12:00:00.000Z",
          alreadyDiscussed: false,
        },
      },
    ],
    [
      "max_attempts_reached",
      {
        subject: {
          kind: "follow_up",
          status: "pending",
          earliestAtUtc: "2026-08-21T11:00:00.000Z",
          expiresAtUtc: "2026-08-22T12:00:00.000Z",
          alreadyDiscussed: false,
          attemptCount: 1,
          maxAttempts: 1,
        },
      },
    ],
    [
      "already_discussed",
      {
        subject: {
          kind: "activity_candidate",
          status: "pending",
          earliestAtUtc: "2026-08-21T11:00:00.000Z",
          expiresAtUtc: "2026-08-22T12:00:00.000Z",
          alreadyDiscussed: true,
        },
      },
    ],
    ["quiet_hours", { quietHours: true }],
    ["daily_cap_reached", { sentToday: 2 }],
    ["relationship_below_minimum", { relationshipCloseness: 0.1 }],
    ["cooldown_active", { cooldownUntilUtc: "2026-08-21T13:00:00.000Z" }],
    ["unanswered_limit_reached", { unansweredCount: 1 }],
    ["active_conversation", { activeConversation: true }],
  ] as const)("returns %s", (reasonCode, overrides) => {
    expect(
      evaluateProactivePreflight(
        preflight(overrides as Partial<ProactivePreflightInput>),
      ),
    ).toEqual({ allowed: false, reasonCode });
  });
});

describe("proactive postflight", () => {
  it("commits only an unchanged generation snapshot", () => {
    expect(evaluateProactivePostflight(postflight())).toEqual({
      allowed: true,
    });
  });

  it.each([
    ["stale_generation", { generationMatches: false }],
    ["agent_revision_changed", { currentSpecVersion: 2 }],
    ["agent_revision_changed", { currentStateRevision: 3 }],
    ["user_returned", { currentUserArrivalEpoch: 4 }],
    ["user_returned", { inFlightUserTurns: 1 }],
    ["user_returned", { currentLastUserMessageRowid: 13 }],
    ["new_message_arrived", { currentMessageRowid: 13 }],
    ["source_not_claimed", { sourceStillClaimed: false }],
    ["source_expired", { sourceExpired: true }],
    ["already_discussed", { alreadyDiscussed: true }],
    ["quiet_hours", { dynamicGateFailure: "quiet_hours" }],
    ["daily_cap_reached", { dynamicGateFailure: "daily_cap_reached" }],
    ["cooldown_active", { dynamicGateFailure: "cooldown_active" }],
    [
      "unanswered_limit_reached",
      { dynamicGateFailure: "unanswered_limit_reached" },
    ],
    ["active_conversation", { dynamicGateFailure: "active_conversation" }],
  ] as const)("returns %s", (reasonCode, overrides) => {
    expect(
      evaluateProactivePostflight(
        postflight(overrides as Partial<ProactivePostflightInput>),
      ),
    ).toEqual({ allowed: false, reasonCode });
  });

  it("prioritizes user return over a generic new-message high-water change", () => {
    expect(
      evaluateProactivePostflight(
        postflight({
          currentUserArrivalEpoch: 4,
          currentLastUserMessageRowid: 13,
          currentMessageRowid: 13,
        }),
      ),
    ).toEqual({ allowed: false, reasonCode: "user_returned" });
  });
});
