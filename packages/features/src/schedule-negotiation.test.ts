import { describe, expect, it } from "vitest";

import {
  type CanonicalScheduleOffer,
  createScheduleNegotiation,
  type RecentScheduleNegotiationEvidence,
  reduceScheduleNegotiation,
  type ScheduleNegotiation,
} from "./schedule-negotiation.js";

const T0 = "2026-08-17T00:00:00.000Z";
const T1 = "2026-08-17T00:01:00.000Z";
const T2 = "2026-08-17T00:02:00.000Z";
const T3 = "2026-08-17T00:03:00.000Z";

function evidence(evidenceId: string, observedAtUtc: string) {
  return { evidenceId, observedAtUtc };
}

function offer(
  overrides: Partial<CanonicalScheduleOffer> = {},
): CanonicalScheduleOffer {
  return {
    operation: "create",
    activity: "一起跑步",
    category: "exercise",
    startAtUtc: "2026-08-18T23:00:00.000Z",
    durationMinutes: 30,
    timezone: "Asia/Shanghai",
    ...overrides,
  };
}

function awaitingNegotiation(): ScheduleNegotiation {
  const initial = createScheduleNegotiation({
    negotiationId: "negotiation-1",
    evidence: evidence("request-1", T0),
  });
  return reduceScheduleNegotiation({
    state: initial,
    action: { type: "present_offer", offer: offer() },
    evidence: { current: evidence("offer-1", T1) },
  }).state;
}

describe("schedule negotiation", () => {
  it("commits one canonical pending offer and preserves its minute duration", () => {
    const pending = awaitingNegotiation();
    const result = reduceScheduleNegotiation({
      state: pending,
      action: { type: "accept_pending" },
      evidence: { current: evidence("accept-1", T2), recent: [] },
    });

    expect(pending.status).toBe("awaiting_confirmation");
    expect(pending.offerVersion).toBe(1);
    expect(result.state.status).toBe("committed");
    expect(result.transition.reason).toBe("offer_accepted");
    expect(result.readyToCommit).toBe(true);
    expect(result.offerToCommit).toMatchObject({
      operation: "create",
      version: 1,
      durationMinutes: 30,
    });
  });

  it("rejects confirmation of a superseded offer version", () => {
    const first = awaitingNegotiation();
    const second = reduceScheduleNegotiation({
      state: first,
      action: {
        type: "present_offer",
        offer: offer({ durationMinutes: 45 }),
      },
      evidence: { current: evidence("offer-2", T2) },
    }).state;

    const stale = reduceScheduleNegotiation({
      state: second,
      action: { type: "accept_pending", offerVersion: 1 },
      evidence: { current: evidence("accept-old", T3) },
    });

    expect(second.offerVersion).toBe(2);
    expect(second.offer?.durationMinutes).toBe(45);
    expect(stale.state).toBe(second);
    expect(stale.transition.reason).toBe("stale_offer_version");
    expect(stale.readyToCommit).toBe(false);
  });

  it("never revives a withdrawn negotiation", () => {
    const pending = awaitingNegotiation();
    const withdrawn = reduceScheduleNegotiation({
      state: pending,
      action: { type: "withdraw", reasonCode: "user_withdrew" },
      evidence: { current: evidence("withdraw-1", T2) },
    }).state;

    const reproposed = reduceScheduleNegotiation({
      state: withdrawn,
      action: { type: "present_offer", offer: offer() },
      evidence: { current: evidence("offer-after-withdraw", T3) },
    });
    const accepted = reduceScheduleNegotiation({
      state: withdrawn,
      action: { type: "accept_pending", offerVersion: 1 },
      evidence: { current: evidence("accept-after-withdraw", T3) },
    });

    expect(withdrawn.status).toBe("withdrawn");
    expect(reproposed.state).toBe(withdrawn);
    expect(accepted.state).toBe(withdrawn);
    expect(reproposed.transition.reason).toBe("terminal_state");
    expect(accepted.transition.reason).toBe("terminal_state");
    expect(accepted.readyToCommit).toBe(false);
  });

  it("accepts a short confirmation only for one valid awaiting offer", () => {
    const pending = awaitingNegotiation();
    const otherPending: RecentScheduleNegotiationEvidence = {
      evidenceId: "other-offer-1",
      negotiationId: "negotiation-2",
      observedAtUtc: T1,
      status: "awaiting_confirmation",
      offerVersion: 1,
      offerValidUntilUtc: "2026-08-17T01:00:00.000Z",
    };

    const ambiguous = reduceScheduleNegotiation({
      state: pending,
      action: { type: "accept_pending" },
      evidence: {
        current: evidence("accept-ambiguous", T2),
        recent: [otherPending],
      },
    });
    expect(ambiguous.transition.reason).toBe("ambiguous_pending_offer");
    expect(ambiguous.readyToCommit).toBe(false);

    const unique = reduceScheduleNegotiation({
      state: pending,
      action: { type: "accept_pending" },
      evidence: {
        current: evidence("accept-unique", T3),
        recent: [
          otherPending,
          {
            ...otherPending,
            evidenceId: "other-withdraw-1",
            observedAtUtc: T2,
            status: "withdrawn",
          },
        ],
      },
    });
    expect(unique.state.status).toBe("committed");
    expect(unique.readyToCommit).toBe(true);
  });

  it("expires an offer instead of committing it after its validity window", () => {
    const initial = createScheduleNegotiation({
      negotiationId: "negotiation-expiring",
      evidence: evidence("request-expiring", T0),
    });
    const pending = reduceScheduleNegotiation({
      state: initial,
      action: {
        type: "present_offer",
        offer: offer(),
        validUntilUtc: T2,
      },
      evidence: { current: evidence("offer-expiring", T1) },
    }).state;

    const result = reduceScheduleNegotiation({
      state: pending,
      action: { type: "accept_pending" },
      evidence: { current: evidence("accept-expired", T3) },
    });

    expect(result.state.status).toBe("expired");
    expect(result.transition.reason).toBe("offer_expired");
    expect(result.readyToCommit).toBe(false);
  });
});
