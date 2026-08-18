import { describe, expect, it } from "vitest";

import {
  PersonaChatDecisionSchema,
  ScheduleNegotiationActionKindSchema,
  ScheduleNegotiationActionSchema,
  ScheduleNegotiationOfferSchema,
} from "./index.js";

const completeOffer = {
  activity: "晨跑",
  category: "exercise",
  startAt: "明天早餐前 07:00",
  durationMinutes: 30,
  evidenceQuotes: ["明天早餐前七点一起跑半小时"],
} as const;

describe("schedule negotiation contracts", () => {
  it("defines the bounded create-only action kinds", () => {
    expect(ScheduleNegotiationActionKindSchema.options).toEqual([
      "none",
      "request_details",
      "propose_offer",
      "accept_user_offer",
      "accept_pending_offer",
      "decline_offer",
      "withdraw_offer",
    ]);
  });

  it("accepts complete offers for proposals and accepted user offers", () => {
    for (const kind of ["propose_offer", "accept_user_offer"] as const) {
      const parsed = ScheduleNegotiationActionSchema.parse({
        kind,
        offer: completeOffer,
      });
      expect(parsed.kind).toBe(kind);
    }
  });

  it("requires startAt for proposals and accepted user offers", () => {
    const incompleteOffer = Object.fromEntries(
      Object.entries(completeOffer).filter(([key]) => key !== "startAt"),
    );

    for (const kind of ["propose_offer", "accept_user_offer"] as const) {
      expect(
        ScheduleNegotiationActionSchema.safeParse({
          kind,
          offer: incompleteOffer,
        }).success,
      ).toBe(false);
    }
  });

  it("allows the server to supply a versioned default duration", () => {
    const offerWithoutDuration = Object.fromEntries(
      Object.entries(completeOffer).filter(
        ([key]) => key !== "durationMinutes",
      ),
    );

    for (const kind of ["propose_offer", "accept_user_offer"] as const) {
      expect(
        ScheduleNegotiationActionSchema.safeParse({
          kind,
          offer: offerWithoutDuration,
        }).success,
      ).toBe(true);
    }
  });

  it("allows request_details to carry only the details already known", () => {
    expect(
      ScheduleNegotiationActionSchema.safeParse({
        kind: "request_details",
        offer: {
          activity: "晨跑",
          evidenceQuotes: ["明天一起跑步吧"],
        },
      }).success,
    ).toBe(true);
    expect(
      ScheduleNegotiationActionSchema.safeParse({
        kind: "request_details",
      }).success,
    ).toBe(true);
  });

  it("keeps pending acceptance bound to server-owned offer terms", () => {
    expect(
      ScheduleNegotiationActionSchema.safeParse({
        kind: "accept_pending_offer",
      }).success,
    ).toBe(false);
    expect(
      ScheduleNegotiationActionSchema.safeParse({
        kind: "accept_pending_offer",
        evidenceQuotes: ["好，就这么定了"],
      }).success,
    ).toBe(true);
    expect(
      ScheduleNegotiationActionSchema.safeParse({
        kind: "accept_pending_offer",
        evidenceQuotes: ["好，就这么定了"],
        offer: completeOffer,
      }).success,
    ).toBe(false);
  });

  it("rejects unexpected offer fields and invalid bounded values", () => {
    expect(
      ScheduleNegotiationOfferSchema.safeParse({
        ...completeOffer,
        operation: "create",
      }).success,
    ).toBe(false);
    expect(
      ScheduleNegotiationOfferSchema.safeParse({
        ...completeOffer,
        durationMinutes: 0,
      }).success,
    ).toBe(false);
    expect(
      ScheduleNegotiationOfferSchema.safeParse({
        ...completeOffer,
        category: "meeting",
      }).success,
    ).toBe(false);
    expect(
      ScheduleNegotiationOfferSchema.safeParse({
        ...completeOffer,
        evidenceQuotes: [],
      }).success,
    ).toBe(false);
  });

  it("does not allow offer payloads on non-offer actions", () => {
    for (const kind of ["none", "decline_offer", "withdraw_offer"] as const) {
      expect(
        ScheduleNegotiationActionSchema.safeParse({
          kind,
          offer: completeOffer,
        }).success,
      ).toBe(false);
    }
  });

  it("defaults missing or unknown model actions to none", () => {
    for (const input of [
      { text: "普通回复" },
      { text: "普通回复", scheduleAction: { kind: "unknown_action" } },
      {
        reply: {
          text: "普通回复",
          scheduleAction: { kind: "accept_user_offer" },
        },
      },
    ]) {
      expect(PersonaChatDecisionSchema.parse(input).scheduleAction).toEqual({
        kind: "none",
      });
    }
  });

  it("preserves valid top-level and nested model actions", () => {
    expect(
      PersonaChatDecisionSchema.parse({
        text: "好，明早一起跑。",
        scheduleAction: {
          kind: "accept_user_offer",
          offer: completeOffer,
        },
      }).scheduleAction,
    ).toEqual({ kind: "accept_user_offer", offer: completeOffer });

    expect(
      PersonaChatDecisionSchema.parse({
        reply: {
          text: "几点出发？",
          scheduleAction: {
            kind: "request_details",
            offer: { activity: "晨跑" },
          },
        },
      }).scheduleAction,
    ).toEqual({
      kind: "request_details",
      offer: { activity: "晨跑" },
    });
  });

  it("keeps legacy scheduleEffects unchanged while adding scheduleAction", () => {
    const scheduleEffects = [{ operation: "create", item: { title: "晨跑" } }];
    const parsed = PersonaChatDecisionSchema.parse({
      text: "好。",
      scheduleEffects,
    });

    expect(parsed.scheduleAction).toEqual({ kind: "none" });
    expect(parsed.scheduleEffects).toEqual(scheduleEffects);
  });
});
