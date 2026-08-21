import type { PersonalIntent } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  buildPersonalIntentDedupeKey,
  canConsumePersonalIntent,
  evaluatePersonalIntentExpiry,
  evaluatePersonalIntentSpecVersion,
  expirePersonalIntent,
  groundPersonalIntent,
  normalizePersonalIntentCandidate,
  parsePersonalIntentTimingHint,
  resolvePersonalIntentDedupe,
  type PersonalIntentSpecSnapshot,
} from "./personal-intent.js";

const SPEC: PersonalIntentSpecSnapshot = {
  version: 2,
  persona: {
    goals: [
      {
        id: "goal-health",
        title: "Stay healthy",
        description: "Exercise every week",
      },
    ],
    preferences: [
      {
        id: "preference-photo",
        subject: "Photography",
        preference: "Likes city and riverside night photography",
        conditions: [],
      },
      {
        id: "preference-music",
        subject: "Music",
        preference: "Likes listening to classical music at home",
        conditions: [],
      },
    ],
  },
  routines: [
    {
      id: "routine-run",
      title: "Morning run",
      category: "exercise",
      recurrence: "every weekday",
    },
  ],
};

function makeIntent(overrides: Partial<PersonalIntent> = {}): PersonalIntent {
  return {
    id: "intent-1",
    agentId: "agent-1",
    activity: "Riverside night photography",
    category: "leisure",
    desiredDurationMinutes: 60,
    latestAtUtc: "2026-08-30T00:00:00.000Z",
    basisKind: "chat",
    basisRefIds: [],
    evidenceMessageIds: ["message-1"],
    priority: 0.6,
    freshness: 0.8,
    status: "pending",
    dedupeKey: buildPersonalIntentDedupeKey({
      agentId: "agent-1",
      activity: "Riverside night photography",
      category: "leisure",
      basisKind: "chat",
    }),
    specVersion: 2,
    schemaVersion: 1,
    attemptCount: 0,
    createdAtUtc: "2026-08-20T00:00:00.000Z",
    updatedAtUtc: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("PersonalIntent grounding", () => {
  it("rejects an invalid goal ref", () => {
    const result = groundPersonalIntent(
      {
        activity: "Weekly exercise",
        category: "exercise",
        basisKind: "goal",
        basisRefIds: ["goal-missing"],
      },
      { spec: SPEC },
    );

    expect(result).toMatchObject({
      ok: false,
      rejection: { reasonCode: "invalid_basis_ref" },
    });
  });

  it("rejects an existing but unrelated preference ref", () => {
    const result = groundPersonalIntent(
      {
        activity: "Morning run",
        category: "exercise",
        basisKind: "preference",
        basisRefIds: ["preference-music"],
      },
      { spec: SPEC },
    );

    expect(result).toMatchObject({
      ok: false,
      rejection: { reasonCode: "unrelated_basis_ref" },
    });
  });

  it("grounds relevant goal, preference, and routine refs", () => {
    const goal = groundPersonalIntent(
      {
        activity: "Weekly exercise",
        category: "exercise",
        basisKind: "goal",
        basisRefIds: ["goal-health"],
      },
      { spec: SPEC },
    );
    const preference = groundPersonalIntent(
      {
        activity: "Riverside night photography",
        category: "leisure",
        basisKind: "preference",
        basisRefIds: ["preference-photo"],
      },
      { spec: SPEC },
    );
    const routine = groundPersonalIntent(
      {
        activity: "Morning run",
        category: "exercise",
        basisKind: "routine",
        basisRefIds: ["routine-run"],
      },
      { spec: SPEC },
    );

    expect([goal.ok, preference.ok, routine.ok]).toEqual([true, true, true]);
  });

  it("rejects ungrounded and too-short chat quotes", () => {
    const context = {
      spec: SPEC,
      currentUserMessage: {
        id: "message-1",
        text: "\u6211\u6700\u8fd1\u53d1\u73b0\u6cb3\u8fb9\u591c\u666f\u5f88\u597d\u770b\u3002",
      },
    };
    const ungrounded = groundPersonalIntent(
      {
        activity: "\u6cb3\u8fb9\u591c\u666f\u6444\u5f71",
        category: "leisure",
        basisKind: "chat",
        evidenceQuotes: ["\u5c71\u9876\u65e5\u51fa\u5f88\u597d\u770b"],
      },
      context,
    );
    const tooShort = groundPersonalIntent(
      {
        activity: "\u6cb3\u8fb9\u591c\u666f\u6444\u5f71",
        category: "leisure",
        basisKind: "chat",
        evidenceQuotes: ["\u6211"],
      },
      context,
    );

    expect(ungrounded).toMatchObject({
      ok: false,
      rejection: { reasonCode: "ungrounded_evidence_quote" },
    });
    expect(tooShort).toMatchObject({
      ok: false,
      rejection: { reasonCode: "meaningless_evidence_quote" },
    });
  });

  it("keeps spontaneous generation closed unless every P0 guard passes", () => {
    const input = {
      activity: "Take an unplanned walk in the park",
      category: "exercise" as const,
      basisKind: "spontaneous" as const,
    };

    expect(groundPersonalIntent(input, { spec: SPEC })).toMatchObject({
      ok: false,
      rejection: { reasonCode: "spontaneous_disabled" },
    });
    expect(
      groundPersonalIntent(input, {
        spec: SPEC,
        spontaneousPolicy: {
          enabled: true,
          budgetAvailable: true,
          categoryAllowlist: ["exercise"],
          riskAllowed: true,
          frequencyAllowed: true,
          personaBoundaryAllowed: true,
          scheduleAllowed: true,
        },
      }).ok,
    ).toBe(true);
  });
});

describe("PersonalIntent normalization and lifecycle", () => {
  it("normalizes category and duration and resolves a fuzzy timing window", () => {
    const result = normalizePersonalIntentCandidate({
      candidate: {
        activity: "  \u6cb3\u8fb9\u591c\u666f\u6444\u5f71  ",
        durationHint: "\u534a\u5c0f\u65f6",
        timingHint: "\u660e\u5929\u665a\u4e0a",
        basisKind: "chat",
        evidenceQuotes: ["\u6cb3\u8fb9\u591c\u666f\u5f88\u597d\u770b"],
        reasonCode: "chat_inspiration",
        reasonSummary: "The user inspired a photography activity.",
      },
      agentId: "agent-1",
      spec: SPEC,
      currentUserMessage: {
        id: "message-1",
        text: "\u6211\u6700\u8fd1\u53d1\u73b0\u6cb3\u8fb9\u591c\u666f\u5f88\u597d\u770b\u3002",
      },
      nowUtc: "2026-08-21T04:00:00.000Z",
      timezone: "Asia/Shanghai",
    });

    expect(result).toMatchObject({
      accepted: true,
      intent: {
        activity: "\u6cb3\u8fb9\u591c\u666f\u6444\u5f71",
        category: "leisure",
        desiredDurationMinutes: 30,
        earliestAtUtc: "2026-08-22T10:00:00.000Z",
        latestAtUtc: "2026-08-22T15:00:00.000Z",
        evidenceMessageIds: ["message-1"],
      },
    });
  });
  it("keeps a Sunday-evening goal inside the matching local window", () => {
    expect(
      parsePersonalIntentTimingHint("周日晚完成社区纪录片放映", {
        nowUtc: "2026-08-21T04:00:00.000Z",
        timezone: "Asia/Shanghai",
      }),
    ).toEqual({
      earliestAtUtc: "2026-08-23T10:00:00.000Z",
      latestAtUtc: "2026-08-23T15:00:00.000Z",
    });
    expect(
      parsePersonalIntentTimingHint("下周日晚上继续剪辑", {
        nowUtc: "2026-08-21T04:00:00.000Z",
        timezone: "Asia/Shanghai",
      }),
    ).toEqual({
      earliestAtUtc: "2026-08-30T10:00:00.000Z",
      latestAtUtc: "2026-08-30T15:00:00.000Z",
    });
  });

  it("merges an active duplicate instead of creating a second intent", () => {
    const key = buildPersonalIntentDedupeKey({
      agentId: "agent-1",
      activity: "Riverside   photography",
      category: "leisure",
      basisKind: "chat",
    });
    expect(key).toBe(
      buildPersonalIntentDedupeKey({
        agentId: "agent-1",
        activity: "Riverside photography",
        category: "leisure",
        basisKind: "chat",
      }),
    );
    const existing = makeIntent({ dedupeKey: key });
    const incoming = makeIntent({
      id: "intent-2",
      dedupeKey: key,
      evidenceMessageIds: ["message-2"],
      priority: 0.9,
      freshness: 1,
    });

    const result = resolvePersonalIntentDedupe(
      [existing],
      incoming,
      "2026-08-21T00:00:00.000Z",
    );

    expect(result).toMatchObject({
      action: "merge",
      duplicateId: "intent-1",
      intent: {
        id: "intent-1",
        priority: 0.9,
        evidenceMessageIds: ["message-1", "message-2"],
      },
    });
  });

  it("expires elapsed pending intents and prevents their consumption", () => {
    const intent = makeIntent({
      latestAtUtc: "2026-08-20T12:00:00.000Z",
    });
    const nowUtc = "2026-08-21T00:00:00.000Z";

    expect(evaluatePersonalIntentExpiry(intent, nowUtc)).toMatchObject({
      expired: true,
      reasonCode: "latest_window_elapsed",
    });
    expect(canConsumePersonalIntent(intent, nowUtc)).toBe(false);
    expect(expirePersonalIntent(intent, nowUtc)).toMatchObject({
      status: "expired",
      updatedAtUtc: nowUtc,
    });
  });

  it("re-evaluates source refs when the CharacterSpec version changes", () => {
    const intent = makeIntent({
      basisKind: "preference",
      basisRefIds: ["preference-photo"],
      specVersion: 1,
    });

    expect(evaluatePersonalIntentSpecVersion(intent, SPEC)).toMatchObject({
      outcome: "revalidated",
      targetSpecVersion: 2,
    });
  });
});
