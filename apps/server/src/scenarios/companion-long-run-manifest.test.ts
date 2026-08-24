import { describe, expect, it } from "vitest";

import type { CompanionLongRunManifest } from "./companion-long-run-types.js";
import {
  COMPANION_LONG_RUN_SCENARIO_VERSION,
  companionLongRunManifest,
  getCompanionLongRunTurn,
  materializeCompanionLongRunTurn,
  renderCompanionLongRunTemplate,
  validateCompanionLongRunManifest,
} from "./companion-long-run-manifest.js";

describe("companion long-run v1 manifest", () => {
  it("contains exactly 100 ordered, fixed logical inputs with complete defaults", () => {
    expect(COMPANION_LONG_RUN_SCENARIO_VERSION).toBe("companion-long-run-v1");
    expect(validateCompanionLongRunManifest(companionLongRunManifest)).toEqual(
      [],
    );
    expect(companionLongRunManifest.turns).toHaveLength(100);
    expect(companionLongRunManifest.turns.map((turn) => turn.number)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(
      new Set(
        companionLongRunManifest.turns.map((turn) => turn.userTextTemplate),
      ).size,
    ).toBe(100);
    for (const turn of companionLongRunManifest.turns) {
      expect(turn.expected.hardAssertionCodes).toContain("Q0");
      expect(turn.expected.hardAssertionCodes).toContain(
        turn.expected.mainGoalActivated ? "G1" : "G0",
      );
      expect(turn.expected.softMetricTags).toContain(
        "objective_reply_alignment",
      );
    }

    expect(getCompanionLongRunTurn(1).userTextTemplate).toBe(
      "早上好，今天窗外有点阴，感觉像要下雨。你那边呢？",
    );
    expect(getCompanionLongRunTurn(11).userTextTemplate).toContain("LPM-4827");
    expect(getCompanionLongRunTurn(31).userTextTemplate).toContain(
      "${sharedSlotA.localLabel}",
    );
    expect(getCompanionLongRunTurn(100).userTextTemplate).toBe(
      "我们聊了这么久。请用自然的两三句话说说你确定记得的我，不要列清单，不确定的别说。",
    );
  });

  it("encodes sessions, restart, replay, dynamic slots, clock moves, and settlement", () => {
    expect(getCompanionLongRunTurn(31).actionsBefore).toEqual([
      {
        kind: "allocate_free_slot",
        key: "sharedSlotA",
        durationMinutes: 45,
      },
    ]);
    expect(getCompanionLongRunTurn(40).actionsBefore).toEqual([
      {
        kind: "allocate_free_slot",
        key: "sharedSlotB",
        durationMinutes: 60,
      },
    ]);
    expect(getCompanionLongRunTurn(47).actionsBefore).toEqual([
      {
        kind: "set_clock_from_schedule_item",
        selector: "work",
        relation: "after_start",
        offsetMinutes: 15,
      },
    ]);
    expect(getCompanionLongRunTurn(51).actionsBefore).toEqual([
      { kind: "advance_clock", durationMinutes: 480 },
      { kind: "settle_agent" },
    ]);
    expect(getCompanionLongRunTurn(54).actionsBefore).toEqual([
      { kind: "advance_clock", durationMinutes: 1_080 },
      { kind: "settle_agent" },
    ]);
    expect(getCompanionLongRunTurn(76).actionsBefore).toEqual([
      { kind: "create_session", key: "B" },
    ]);
    expect(getCompanionLongRunTurn(81).actionsBefore).toEqual([
      { kind: "restart_app", preserveDatabase: true },
    ]);
    expect(getCompanionLongRunTurn(82).actionsBefore).toEqual([
      { kind: "repeat_same_client_message_id" },
    ]);
    expect(getCompanionLongRunTurn(84).actionsBefore).toEqual([
      { kind: "create_session", key: "C" },
    ]);
    expect(getCompanionLongRunTurn(75).sessionKey).toBe("A");
    expect(getCompanionLongRunTurn(76).sessionKey).toBe("B");
    expect(getCompanionLongRunTurn(84).sessionKey).toBe("C");
  });

  it("matches the documented goal and schedule authority checkpoints", () => {
    const activatedGoalTurns = companionLongRunManifest.turns
      .filter((turn) => turn.expected.mainGoalActivated)
      .map((turn) => turn.number);
    expect(activatedGoalTurns).toEqual([68, 69, 72, 98]);

    const pending = getCompanionLongRunTurn(31).expected;
    expect(pending).toMatchObject({
      scheduleExpectation: "pending_only",
      scheduleRef: "A",
    });
    expect(pending.hardAssertionCodes).toContain("S-PENDING");

    const committed = getCompanionLongRunTurn(33).expected;
    expect(committed).toMatchObject({
      scheduleExpectation: "commit_exactly_one",
      scheduleRef: "A",
    });
    expect(committed.hardAssertionCodes).toContain("S-COMMIT1");

    const withdrawn = getCompanionLongRunTurn(41).expected;
    expect(withdrawn).toMatchObject({
      scheduleExpectation: "withdraw_pending",
      scheduleRef: "B",
    });
    expect(withdrawn.hardAssertionCodes).toContain("S-WITHDRAW");
    expect(withdrawn.hardAssertionCodes).toContain("NO-SCHEDULE-ITEM");
    expect(getCompanionLongRunTurn(82).expected.hardAssertionCodes).toEqual(
      expect.arrayContaining([
        "X-IDEMPOTENT",
        "M-RECALL-DURABLE",
        "S0",
        "ROUTER-PRECISION",
        "G0",
        "Q0",
      ]),
    );
  });

  it("materializes declared slot variables and fails closed on missing values", () => {
    const values = {
      "sharedSlotA.localLabel": "2026 年 9 月 21 日 15:00",
      "sharedSlotA.durationMinutes": 45,
      "sharedSlotB.localLabel": "2026 年 9 月 22 日 10:00",
      "sharedSlotB.durationMinutes": 60,
    } as const;
    const materialized = materializeCompanionLongRunTurn(
      getCompanionLongRunTurn(31),
      values,
    );
    expect(materialized.userText).toContain("2026 年 9 月 21 日 15:00");
    expect(materialized.userText).toContain("预计 45 分钟");
    expect(materialized.expected.requiredAnchors).toContain(
      "2026 年 9 月 21 日 15:00",
    );
    expect(materialized.userText).not.toContain("${");

    expect(() =>
      renderCompanionLongRunTemplate("${sharedSlotA.localLabel}", {}),
    ).toThrow(/sharedSlotA\.localLabel/);
  });

  it("reports undeclared variables instead of silently accepting manifest drift", () => {
    const first = getCompanionLongRunTurn(1);
    const invalid = {
      ...companionLongRunManifest,
      turns: [
        { ...first, userTextTemplate: "${unknown.value}" },
        ...companionLongRunManifest.turns.slice(1),
      ],
    } satisfies CompanionLongRunManifest;

    expect(validateCompanionLongRunManifest(invalid)).toContain(
      "turn 1 uses undeclared template key unknown.value",
    );
  });
});
