import { validateWorldEffects } from "@personasim/features";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseStore, StoredActivityEvent } from "../db/store.js";
import type { SimulationCapabilities } from "../domain/capabilities.js";
import type {
  CharacterSpec,
  RuntimeState,
  ScheduleEffectProposal,
  ScheduleItem,
} from "../domain/schemas.js";
import type { ScheduleService } from "./schedule-service.js";
import type { ActiveScheduleNegotiation } from "./schedule-negotiation-service.js";
import {
  isRecentSettledActivityQuery,
  TurnExecutionService,
} from "./turn-execution-service.js";
import type { ResolvedTurnObservation } from "./turn-understanding-service.js";

const NOW = "2026-08-23T04:00:00.000Z";

describe("TurnExecutionService", () => {
  it("fails closed when write-mode options are omitted", () => {
    const getActive = vi.fn(() => undefined);
    const validateEffectsPartial = vi.fn(() => ({
      accepted: [],
      rejections: [],
    }));
    const service = new TurnExecutionService(
      { getActiveScheduleNegotiation: getActive } as unknown as DatabaseStore,
      { validateEffectsPartial } as unknown as ScheduleService,
    );

    const outcome = service.execute(
      executionInput(sharedActivityObservation()),
    );

    expect(outcome.worldEffectsMode).toBe("off");
    expect(outcome.worldEffectWritesEnabled).toBe(false);
    expect(outcome.scheduleWritesEnabled).toBe(false);
    expect(outcome.scheduleOutcome).toEqual({
      kind: "rejected",
      reasonCode: "schedule_writer_not_enforced",
    });
    expect(validateEffectsPartial).not.toHaveBeenCalled();
  });

  it("does not enter schedule negotiation for an ordinary conversation", () => {
    const harness = createHarness("enforced");

    const outcome = harness.service.execute(
      executionInput(conversationObservation()),
    );

    expect(harness.getActive).not.toHaveBeenCalled();
    expect(outcome.scheduleOutcome).toEqual({ kind: "none" });
    expect(outcome.negotiationPlan).toBeUndefined();
    expect(outcome.validation).toEqual({ accepted: [], rejections: [] });
  });

  it("answers a just-finished query from the latest terminal event even when another goal activity has started", () => {
    const harness = createHarness("enforced");
    const completedItem = {
      ...scheduleItem(),
      id: "schedule-finished-creation",
      title: "早晨创作时间",
      startAtUtc: "2026-08-23T02:45:00.000Z",
      endAtUtc: "2026-08-23T03:45:00.000Z",
      status: "completed" as const,
    };
    const currentGoalItem = {
      ...scheduleItem(),
      id: "schedule-current-documentary",
      title: "一部关于城市夜归人的纪录短片",
      startAtUtc: NOW,
      endAtUtc: "2026-08-23T05:00:00.000Z",
      status: "in_progress" as const,
      source: "self_initiated" as const,
    };
    harness.listActivityEvents.mockReturnValue([
      activityEvent({
        id: "event-current-started",
        scheduleItemId: currentGoalItem.id,
        eventType: "started",
        occurredAtUtc: NOW,
        summary: "开始了一部关于城市夜归人的纪录短片",
      }),
      activityEvent({
        id: "event-finished-completed",
        scheduleItemId: completedItem.id,
        eventType: "completed",
        occurredAtUtc: completedItem.endAtUtc,
        summary: "完成了早晨创作时间",
      }),
    ]);
    harness.getScheduleItem.mockImplementation((id) =>
      id === completedItem.id
        ? completedItem
        : id === currentGoalItem.id
          ? currentGoalItem
          : undefined,
    );

    const outcome = harness.service.execute({
      ...executionInput(conversationObservation()),
      userText: "刚才那项活动结束了吗？",
      state: {
        ...runtimeState(),
        currentActivityId: currentGoalItem.id,
      },
      authoritativeSchedule: [currentGoalItem],
    });

    expect(outcome.replyDirectives.mode).toBe("answer");
    expect(outcome.replyDirectives.authoritativeFacts).toEqual([
      {
        kind: "activity",
        sourceId: "event-finished-completed",
        activityEventType: "completed",
        text: "最近一次已结算活动“早晨创作时间”已经结束，结果为已完成。",
        requiredAnchors: ["早晨创作时间", "已完成"],
      },
    ]);
    expect(
      JSON.stringify(outcome.replyDirectives.authoritativeFacts),
    ).not.toContain(currentGoalItem.title);
  });

  it.each([
    "明天那项活动结束了吗？",
    "刚才那项活动挺有趣。",
    "这项活动什么时候结束？",
  ])(
    "does not treat an ordinary or future activity question as a recent terminal query: %s",
    (text) => {
      expect(isRecentSettledActivityQuery(text)).toBe(false);
    },
  );

  it("does not create an activity fact when no recent terminal event exists", () => {
    const harness = createHarness("enforced");
    harness.listActivityEvents.mockReturnValue([
      activityEvent({
        id: "event-current-started-only",
        scheduleItemId: "schedule-current-only",
        eventType: "started",
        occurredAtUtc: NOW,
        summary: "开始了当前活动",
      }),
      activityEvent({
        id: "event-terminal-too-old",
        scheduleItemId: "schedule-old",
        eventType: "completed",
        occurredAtUtc: "2026-08-22T20:00:00.000Z",
        summary: "完成了很久以前的活动",
      }),
    ]);

    const outcome = harness.service.execute({
      ...executionInput(conversationObservation()),
      userText: "刚才那项活动结束了吗？",
    });

    expect(outcome.replyDirectives.authoritativeFacts).toEqual([]);
    expect(outcome.replyDirectives.mode).toBe("casual");
  });

  it("downgrades a non-dry mutation when the schedule writer is shadow", () => {
    const harness = createHarness("shadow");

    const outcome = harness.service.execute(
      executionInput(sharedActivityObservation()),
    );

    expect(outcome.scheduleOutcome).toEqual({
      kind: "rejected",
      reasonCode: "schedule_writer_not_enforced",
    });
    expect(outcome.scheduleWritesEnabled).toBe(false);
    expect(outcome.negotiationPlan).toBeUndefined();
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "schedule_writer_not_enforced",
      }),
    );
  });

  it("retains a would-be pending plan only for an explicit dry-run", () => {
    const harness = createHarness("shadow");

    const outcome = harness.service.execute({
      ...executionInput(sharedActivityObservation()),
      dryRun: true,
    });

    expect(outcome.scheduleOutcome).toMatchObject({
      kind: "pending_confirmation",
      offerVersion: 1,
    });
    expect(outcome.scheduleWritesEnabled).toBe(false);
    expect(outcome.negotiationPlan).toMatchObject({
      actionKind: "accept_user_offer",
      rejections: [],
    });
    expect(harness.validateEffectsPartial).toHaveBeenCalledOnce();
  });

  it("maps an explicit offer with an ambiguous time to clarification without a schedule effect", () => {
    const harness = createHarness("enforced");
    const observation: ResolvedTurnObservation = {
      ...sharedActivityObservation(),
      scheduleIntent: {
        kind: "create_shared_activity",
        activityQuote: { text: "一起散步" },
        participantQuote: { text: "我们" },
        missingFields: ["time"],
      },
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText: "我们找时间一起散步吧。",
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "needs_clarification",
      missingFields: ["time"],
    });
    expect(outcome.validation.accepted).toEqual([]);
    expect(outcome.negotiationPlan?.effect).toBeUndefined();
  });

  it("rejects an offer that fails authoritative schedule preflight", () => {
    const harness = createHarness("enforced");
    harness.validateEffectsPartial.mockImplementationOnce(
      (_agentId, effects) => ({
        accepted: [],
        rejections: [
          {
            index: 0,
            code: "schedule_conflict",
            message: "The proposed time conflicts with an existing item.",
            proposal: effects[0]!,
          },
        ],
      }),
    );

    const outcome = harness.service.execute(
      executionInput(sharedActivityObservation()),
    );

    expect(outcome.scheduleOutcome).toEqual({
      kind: "rejected",
      reasonCode: "schedule_conflict",
    });
    expect(outcome.negotiationPlan).toBeUndefined();
    expect(outcome.validation.accepted).toEqual([]);
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({ reasonCode: "schedule_conflict" }),
    );
  });

  it("preserves the uniquely named committed baseline for an unsupported reschedule", () => {
    const harness = createHarness("enforced");
    const userText = "把已经确认的北岸书店喝茶改到晚一小时。";
    const committed = {
      ...scheduleItem(),
      id: "schedule-north-bank-committed",
      title: "和用户北岸书店喝茶",
    };
    const unrelated = {
      ...scheduleItem(),
      id: "schedule-century-park-committed",
      title: "和用户世纪公园散步",
    };

    const outcome = harness.service.execute({
      ...executionInput(unsupportedRescheduleObservation(userText)),
      userText,
      authoritativeSchedule: [unrelated, committed],
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "rejected",
      reasonCode: "unsupported_schedule_operation",
    });
    expect(outcome.replyDirectives.authoritativeFacts).toHaveLength(1);
    const [fact] = outcome.replyDirectives.authoritativeFacts;
    expect(fact).toMatchObject({
      kind: "schedule",
      sourceId: committed.id,
      scheduleAuthorityState: "committed",
      scheduleMutationDisposition: "unchanged",
      requiredAnchors: [
        "原已确认安排保持不变",
        "本次改期未执行",
        committed.title,
      ],
    });
    expect(fact?.text).toContain("原已确认安排保持不变；本次改期未执行");
    expect(fact?.text).toContain(committed.title);
    expect(fact?.text).not.toContain(unrelated.title);
    expect(outcome.replyDirectives.mustNotClaim).not.toContain(
      "schedule_committed",
    );
    expect(outcome.replyDirectives.mustNotClaim).toContain(
      "schedule_cancelled",
    );
  });

  it.each([
    {
      label: "no exact entity match",
      userText: "把已经确认的南岸咖啡馆喝咖啡改到晚一小时。",
      schedules: [
        {
          ...scheduleItem(),
          id: "schedule-north-bank-only",
          title: "和用户北岸书店喝茶",
        },
      ],
    },
    {
      label: "multiple exact entity matches",
      userText: "把已经确认的北岸书店喝茶改到晚一小时。",
      schedules: [
        {
          ...scheduleItem(),
          id: "schedule-north-bank-first",
          title: "和用户北岸书店喝茶",
        },
        {
          ...scheduleItem(),
          id: "schedule-north-bank-second",
          title: "和用户北岸书店喝茶",
        },
      ],
    },
  ])("does not guess an unsupported mutation baseline: $label", (testCase) => {
    const harness = createHarness("enforced");
    const outcome = harness.service.execute({
      ...executionInput(unsupportedRescheduleObservation(testCase.userText)),
      userText: testCase.userText,
      authoritativeSchedule: testCase.schedules,
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "rejected",
      reasonCode: "unsupported_schedule_operation",
    });
    expect(outcome.replyDirectives.authoritativeFacts).toEqual([]);
    expect(outcome.replyDirectives.mustNotClaim).toContain(
      "schedule_committed",
    );
  });

  it("returns authoritative read-only items without preparing a mutation", () => {
    const harness = createHarness("enforced");
    const item = scheduleItem();

    const outcome = harness.service.execute({
      ...executionInput(scheduleQueryObservation()),
      authoritativeSchedule: [item],
    });

    expect(harness.getActive).not.toHaveBeenCalled();
    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [item.id],
    });
    expect(outcome.replyDirectives.authoritativeFacts).toEqual([
      expect.objectContaining({
        kind: "schedule",
        sourceId: item.id,
        scheduleAuthorityState: "committed",
        scheduleMutationDisposition: "unchanged",
      }),
    ]);
    const [fact] = outcome.replyDirectives.authoritativeFacts;
    expect(fact?.text).toContain("这是当前已确认并生效的共同安排");
    expect(fact?.requiredAnchors).toContain("当前已确认并生效");
    expect(outcome.negotiationPlan).toBeUndefined();
  });

  it("does not label an ordinary future item as a committed shared baseline", () => {
    const harness = createHarness("enforced");
    const item = {
      ...scheduleItem(),
      source: "self_initiated" as const,
      rigidity: "flexible" as const,
      shareable: false,
    };

    const outcome = harness.service.execute({
      ...executionInput(scheduleQueryObservation()),
      authoritativeSchedule: [item],
    });
    const [fact] = outcome.replyDirectives.authoritativeFacts;

    expect(fact?.text).not.toContain("当前已确认并生效");
    expect(fact?.requiredAnchors).not.toContain("当前已确认并生效");
    expect(fact?.scheduleAuthorityState).toBeUndefined();
    expect(fact?.scheduleMutationDisposition).toBeUndefined();
  });

  it("keeps a schedule query read-only even when an offer is active", () => {
    const harness = createHarness("shadow");
    const item = scheduleItem();

    const outcome = harness.service.execute({
      ...executionInput(scheduleQueryObservation()),
      authoritativeSchedule: [item],
      activeNegotiation: {} as ActiveScheduleNegotiation,
    });

    expect(harness.getActive).not.toHaveBeenCalled();
    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [item.id],
    });
    expect(outcome.negotiationPlan).toBeUndefined();
  });

  it("materializes an authoritative empty fact for a read-only query with no items", () => {
    const harness = createHarness("enforced");

    const outcome = harness.service.execute(
      executionInput(scheduleQueryObservation()),
    );

    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [],
    });
    expect(outcome.replyDirectives.authoritativeFacts).toHaveLength(1);
    const [fact] = outcome.replyDirectives.authoritativeFacts;
    expect(fact?.kind).toBe("schedule");
    expect(fact?.text).toContain("没有");
    expect(fact?.requiredAnchors).toEqual(["没有", "日程安排"]);
  });

  it("reads a completed historical shared commitment only for a precise committed entity query", () => {
    const harness = createHarness("enforced");
    const historical = {
      ...scheduleItem(),
      id: "schedule-historical-north-bank",
      title: "和用户在北岸书店喝茶",
      startAtUtc: "2026-08-25T06:00:00.000Z",
      endAtUtc: "2026-08-25T06:45:00.000Z",
      status: "completed" as const,
    };

    const outcome = harness.service.execute({
      ...executionInput(committedEntityScheduleQueryObservation()),
      nowUtc: "2026-09-14T04:00:00.000Z",
      authoritativeSchedule: [historical],
      historicalScheduleReadAuthorizations: [
        historicalAuthorization(historical.id),
      ],
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [historical.id],
    });
    expect(outcome.replyDirectives.authoritativeFacts).toHaveLength(1);
    const fact = outcome.replyDirectives.authoritativeFacts[0];
    expect(fact).toMatchObject({
      kind: "schedule",
      sourceId: historical.id,
    });
    expect(fact?.text).toContain("北岸书店");
    expect(fact?.text).toContain("记录的执行结果：已完成");
    expect(fact?.requiredAnchors).toEqual(
      expect.arrayContaining([
        "和用户在北岸书店喝茶",
        "14:45",
        "当时已确认",
        "已完成",
      ]),
    );
    expect(fact?.requiredAnchors).not.toContain("当前已确认并生效");
    expect(fact).toMatchObject({
      scheduleAuthorityState: "committed",
      scheduleMutationDisposition: "unchanged",
    });
  });

  it("bounds historical entity readback and ranks exact then recent matches", () => {
    const harness = createHarness("enforced");
    const historical = [
      {
        ...scheduleItem(),
        id: "schedule-exact-oldest",
        title: "和用户北岸书店",
        startAtUtc: "2026-08-20T06:00:00.000Z",
        endAtUtc: "2026-08-20T06:45:00.000Z",
        status: "completed" as const,
      },
      ...[21, 22, 23, 24].map((day) => ({
        ...scheduleItem(),
        id: `schedule-related-${String(day)}`,
        title: "和用户在北岸书店喝茶",
        startAtUtc: `2026-08-${String(day)}T06:00:00.000Z`,
        endAtUtc: `2026-08-${String(day)}T06:45:00.000Z`,
        status: "completed" as const,
      })),
    ];

    const outcome = harness.service.execute({
      ...executionInput(committedEntityScheduleQueryObservation()),
      nowUtc: "2026-09-14T04:00:00.000Z",
      authoritativeSchedule: historical,
      historicalScheduleReadAuthorizations: historical.map((item) =>
        historicalAuthorization(item.id),
      ),
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [
        "schedule-exact-oldest",
        "schedule-related-24",
        "schedule-related-23",
      ],
    });
    expect(outcome.replyDirectives.authoritativeFacts).toHaveLength(3);
  });

  it.each([
    {
      label: "entity-less committed query",
      frame: {
        kind: "query_existing" as const,
        statusScope: "committed" as const,
        targetScope: "shared" as const,
        evidenceSpans: [],
      },
      item: {},
    },
    {
      label: "non-committed status scope",
      frame: {
        kind: "query_existing" as const,
        entityText: "北岸书店",
        statusScope: "any" as const,
        targetScope: "shared" as const,
        evidenceSpans: [],
      },
      item: {},
    },
    {
      label: "non-shared target scope",
      frame: {
        kind: "query_existing" as const,
        entityText: "北岸书店",
        statusScope: "committed" as const,
        targetScope: "all" as const,
        evidenceSpans: [],
      },
      item: {},
    },
    {
      label: "cancelled shared item",
      frame: {
        kind: "query_existing" as const,
        entityText: "北岸书店",
        statusScope: "committed" as const,
        targetScope: "shared" as const,
        evidenceSpans: [],
      },
      item: { status: "cancelled" as const },
    },
    {
      label: "non-shared historical item",
      frame: {
        kind: "query_existing" as const,
        entityText: "北岸书店",
        statusScope: "committed" as const,
        targetScope: "shared" as const,
        evidenceSpans: [],
      },
      item: { source: "self_initiated" as const },
    },
    {
      label: "non-committed historical item",
      frame: {
        kind: "query_existing" as const,
        entityText: "北岸书店",
        statusScope: "committed" as const,
        targetScope: "shared" as const,
        evidenceSpans: [],
      },
      item: { rigidity: "flexible" as const },
    },
  ])("does not leak historical items for $label", ({ frame, item }) => {
    const harness = createHarness("enforced");
    const historical = {
      ...scheduleItem(),
      id: "schedule-historical-hidden",
      title: "和用户在北岸书店喝茶",
      startAtUtc: "2026-08-25T06:00:00.000Z",
      endAtUtc: "2026-08-25T06:45:00.000Z",
      status: "completed" as const,
      ...item,
    };
    const observation: ResolvedTurnObservation = {
      ...scheduleQueryObservation(),
      scheduleFrame: frame,
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      nowUtc: "2026-09-14T04:00:00.000Z",
      authoritativeSchedule: [historical],
      historicalScheduleReadAuthorizations: [
        historicalAuthorization(historical.id),
      ],
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [],
    });
    expect(outcome.replyDirectives.authoritativeFacts).toHaveLength(1);
    expect(
      outcome.replyDirectives.authoritativeFacts[0]?.sourceId,
    ).toBeUndefined();
    expect(outcome.replyDirectives.authoritativeFacts[0]?.text).toContain(
      "没有",
    );
  });

  it.each(["书店", "公园"])(
    "rejects the over-broad historical entity %s even with a lineage authorization",
    (entityText) => {
      const harness = createHarness("enforced");
      const historical = {
        ...scheduleItem(),
        id: `schedule-over-broad-${entityText}`,
        title: `和用户在北岸${entityText}喝茶`,
        startAtUtc: "2026-08-25T06:00:00.000Z",
        endAtUtc: "2026-08-25T06:45:00.000Z",
        status: "partial" as const,
      };
      const observation: ResolvedTurnObservation = {
        ...scheduleQueryObservation(),
        scheduleFrame: {
          kind: "query_existing",
          entityText,
          statusScope: "committed",
          targetScope: "shared",
          evidenceSpans: [],
        },
      };

      const outcome = harness.service.execute({
        ...executionInput(observation),
        nowUtc: "2026-09-14T04:00:00.000Z",
        authoritativeSchedule: [historical],
        historicalScheduleReadAuthorizations: [
          historicalAuthorization(historical.id),
        ],
      });

      expect(outcome.scheduleOutcome).toEqual({
        kind: "read_only",
        itemIds: [],
      });
    },
  );

  it("falls back to the exact active assertion in an explicit correction", () => {
    const harness = createHarness("enforced", "enforced");
    const userText =
      "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。";
    const active = "我可以接受少量香菜，但不喜欢整把香菜。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "conversation",
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_preference", content: "用户从不吃香菜" },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: active,
        namespace: "user_model",
        attribution: "user_explicit",
        reasonCode: "explicit_source_memory_fallback",
        evidence: [
          expect.objectContaining({
            sourceId: "message-user-execution",
            quote: active,
          }),
        ],
      }),
    ]);
  });

  it("falls back to the affirmative projection of a direct contrast correction", () => {
    const harness = createHarness("enforced", "enforced");
    const userText =
      "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。";
    const active = "小林是我高中同学。她搬到苏州。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "conversation",
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          {
            type: "user_fact",
            content: "小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变",
          },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: active,
        namespace: "user_model",
        attribution: "user_explicit",
        reasonCode: "explicit_source_memory_fallback",
        evidence: [
          expect.objectContaining({
            sourceId: "message-user-execution",
            quote: userText,
          }),
        ],
      }),
    ]);
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "ungrounded_memory_candidate",
        field: "memory_candidate",
      }),
    );
  });

  it("rejects a historical item when lineage authorizes a different id", () => {
    const harness = createHarness("enforced");
    const historical = {
      ...scheduleItem(),
      id: "schedule-unproven-north-bank",
      title: "和用户在北岸书店喝茶",
      startAtUtc: "2026-08-25T06:00:00.000Z",
      endAtUtc: "2026-08-25T06:45:00.000Z",
      status: "completed" as const,
    };

    const outcome = harness.service.execute({
      ...executionInput(committedEntityScheduleQueryObservation()),
      nowUtc: "2026-09-14T04:00:00.000Z",
      authoritativeSchedule: [historical],
      historicalScheduleReadAuthorizations: [
        historicalAuthorization("schedule-a-different-item"),
      ],
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [],
    });
  });

  it("keeps ordinary future reads unchanged when historical readback is inapplicable", () => {
    const harness = createHarness("enforced");
    const future = {
      ...scheduleItem(),
      startAtUtc: "2026-09-14T11:00:00.000Z",
      endAtUtc: "2026-09-14T12:00:00.000Z",
    };

    const outcome = harness.service.execute({
      ...executionInput(scheduleQueryObservation()),
      nowUtc: "2026-09-14T04:00:00.000Z",
      authoritativeSchedule: [future],
    });

    expect(outcome.scheduleOutcome).toEqual({
      kind: "read_only",
      itemIds: [future.id],
    });
  });

  it("keeps ordinary conversation isolated while an offer is active", () => {
    const harness = createHarness("shadow");

    const outcome = harness.service.execute({
      ...executionInput(conversationObservation()),
      activeNegotiation: {} as ActiveScheduleNegotiation,
    });

    expect(outcome.scheduleOutcome).toEqual({ kind: "none" });
    expect(outcome.negotiationPlan).toBeUndefined();
    expect(outcome.proposalRejections).not.toContainEqual(
      expect.objectContaining({ reasonCode: "schedule_writer_not_enforced" }),
    );
  });

  it("rejects ordinary-weather world effects even in shadow audit", () => {
    const harness = createHarness("enforced", "shadow");
    const input = executionInput(worldEffectObservation());

    const outcome = harness.service.execute(input);

    expect(outcome.worldEffectsMode).toBe("shadow");
    expect(outcome.worldEffectWritesEnabled).toBe(false);
    expect(outcome.acceptedWorldEffects).toEqual({
      memoryCandidates: [],
      personalIntentCandidates: [],
    });
    const rejectionCodes = outcome.proposalRejections.map(
      (rejection) => rejection.reasonCode,
    );
    expect(rejectionCodes).toContain("state_delta_not_eligible_for_turn");
    expect(rejectionCodes).toContain(
      "relationship_delta_not_eligible_for_turn",
    );
    expect(outcome.stateChanged).toBe(false);
    expect(outcome.nextState).toEqual(input.state);
  });

  it("does not evaluate world effects when the live mode is off", () => {
    const harness = createHarness("enforced", "off");
    const input = executionInput(worldEffectObservation());

    const outcome = harness.service.execute(input);

    expect(outcome.worldEffectsMode).toBe("off");
    expect(outcome.worldEffectWritesEnabled).toBe(false);
    expect(outcome.acceptedWorldEffects).toEqual({
      memoryCandidates: [],
      personalIntentCandidates: [],
    });
    expect(outcome.stateChanged).toBe(false);
    expect(outcome.nextState).toEqual(input.state);
  });

  it("projects validated world effects only when enforcement owns the write", () => {
    const harness = createHarness("enforced", "enforced");

    const outcome = harness.service.execute({
      ...executionInput(worldEffectObservation()),
      userText: "你刚才那句话让我很难过，我们把关系说开吧。",
    });

    expect(outcome.worldEffectsMode).toBe("enforced");
    expect(outcome.worldEffectWritesEnabled).toBe(true);
    expect(outcome.stateChanged).toBe(true);
    expect(outcome.nextState.energy).toBe(0.5);
    expect(outcome.nextState.relationship.trust).toBe(0.52);
    expect(outcome.nextState.revision).toBe(1);
  });

  it("keeps an ordinary weather turn reply-only when enforcement is enabled", () => {
    const harness = createHarness("enforced", "enforced");
    const input = executionInput(worldEffectObservation());

    const outcome = harness.service.execute(input);

    expect(outcome.acceptedWorldEffects).toEqual({
      memoryCandidates: [],
      personalIntentCandidates: [],
    });
    expect(outcome.stateChanged).toBe(false);
    expect(outcome.nextState).toEqual(input.state);
  });

  it("rejects a model memory proposal when the turn has no stable fact signal", () => {
    const harness = createHarness("enforced", "enforced");
    const observation = {
      ...conversationObservation(),
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_fact", content: "用户觉得今天天气不错" },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText: "今天天气真不错。",
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([]);
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "memory_not_eligible_for_turn",
        field: "memory_candidate",
      }),
    );
  });

  it("accepts only memory candidates grounded enough to survive persistence", () => {
    const harness = createHarness("enforced", "enforced");
    const observation = {
      ...conversationObservation(),
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_preference", content: "用户喜欢茉莉花茶" },
          { type: "user_fact", content: "用户养了一只叫月亮的猫" },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText: "我喜欢茉莉花茶。",
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toHaveLength(1);
    expect(outcome.acceptedWorldEffects.memoryCandidates[0]).toMatchObject({
      content: "用户喜欢茉莉花茶",
      sourceMessageIds: ["message-user-execution"],
      evidence: [
        expect.objectContaining({
          sourceType: "message",
          sourceId: "message-user-execution",
          quote: "我喜欢茉莉花茶。",
        }),
      ],
    });
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "ungrounded_memory_candidate",
        field: "memory_candidate",
      }),
    );
  });

  it("uses the explicit user source when DeepSeek-style candidates miss the exact identifier", () => {
    const harness = createHarness("enforced", "enforced");
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "explicit_memory",
      routerReasonCodes: ["explicit_memory_request"],
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_fact", content: "用户喜欢茉莉花茶" },
          { type: "user_fact", content: "用户住在苏州" },
          { type: "user_preference", content: "用户习惯早晨跑步" },
        ],
      }),
    };
    const userText =
      "我只告诉很信任的人一个习惯：每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。另请记住这个事实。";

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toHaveLength(1);
    expect(outcome.acceptedWorldEffects.memoryCandidates[0]).toMatchObject({
      kind: "semantic",
      content: userText,
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      reasonCode: "explicit_source_memory_fallback",
      sourceMessageIds: ["message-user-execution"],
      evidence: [
        expect.objectContaining({
          sourceType: "message",
          sourceId: "message-user-execution",
          quote: userText,
        }),
      ],
    });
    expect(outcome.proposalRejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: "ungrounded_memory_candidate" }),
        expect.objectContaining({ reasonCode: "ungrounded_memory_candidate" }),
        expect.objectContaining({ reasonCode: "ungrounded_memory_candidate" }),
      ]),
    );
  });

  it("keeps a grounded model candidate unchanged when it covers the current identifier", () => {
    const harness = createHarness("enforced", "enforced");
    const userText =
      "请记住，我每次重要演讲前都会把蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "explicit_memory",
      routerReasonCodes: ["explicit_memory_request"],
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [{ type: "user_fact", content: userText }],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toHaveLength(1);
    expect(outcome.acceptedWorldEffects.memoryCandidates[0]).toMatchObject({
      content: userText,
      reasonCode: "model_memory_candidate",
    });
  });

  it("prioritizes the exact source fallback without exceeding the candidate limit", () => {
    const harness = createHarness("enforced", "enforced");
    const userText =
      "请记住，我喜欢茉莉花茶；每次重要演讲前，我把蓝色玻璃鲸放在左口袋，代号是 BGW-7419。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "explicit_memory",
      routerReasonCodes: ["explicit_memory_request"],
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_preference", content: "我喜欢茉莉花茶" },
        ],
      }),
    };
    const input = executionInput(observation);

    const outcome = harness.service.execute({
      ...input,
      userText,
      capabilities: { ...input.capabilities, memoryCandidatesPerTurn: 1 },
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: userText,
        reasonCode: "explicit_source_memory_fallback",
      }),
    ]);
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "memory_candidate_displaced_by_explicit_source_fallback",
      }),
    );
  });

  it("falls back after every no-identifier candidate fails preflight", () => {
    const harness = createHarness("enforced", "enforced");
    const userText = "请记住，我最喜欢茉莉花茶。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "explicit_memory",
      routerReasonCodes: ["explicit_memory_request"],
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_fact", content: "用户养了一只叫月亮的猫" },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: userText,
        reasonCode: "explicit_source_memory_fallback",
      }),
    ]);
  });

  it.each([
    {
      label: "the exact LPM asserted fact",
      userText:
        "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。",
      proposedContent: "用户会在重要发言前随身携带一枚松针纪念物",
    },
    {
      label: "the exact Xiaolin asserted fact",
      userText: "我大学同学叫小林，她最近刚搬到苏州。",
      proposedContent: "用户的大学同学小林最近迁居苏州",
    },
  ])(
    "recovers $label from the authoritative source when a model-valid conversation candidate varies too far",
    ({ userText, proposedContent }) => {
      const harness = createHarness("enforced", "enforced");
      const observation: ResolvedTurnObservation = {
        ...conversationObservation(),
        route: "conversation",
        worldEffectsValidation: validateWorldEffects({
          memoryCandidates: [
            { type: "user_fact", content: proposedContent },
            {
              type: "user_fact",
              content: `${proposedContent}，而且用户已经结婚`,
            },
          ],
        }),
      };

      const outcome = harness.service.execute({
        ...executionInput(observation),
        userText,
      });

      expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
        expect.objectContaining({
          content: userText,
          reasonCode: "explicit_source_memory_fallback",
        }),
      ]);
      expect(outcome.proposalRejections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reasonCode: "ungrounded_memory_candidate",
          }),
          expect.objectContaining({
            reasonCode: "ungrounded_memory_candidate",
          }),
        ]),
      );
    },
  );

  it("replaces a grounded partial person memory with the complete authoritative multi-proposition source even when the candidate cap has room", () => {
    const harness = createHarness("enforced", "enforced");
    const userText = "我大学同学叫小林，她最近刚搬到苏州。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_fact", content: "用户大学同学叫小林" },
        ],
      }),
    };
    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: userText,
        reasonCode: "explicit_source_memory_fallback",
        evidence: [
          expect.objectContaining({
            sourceType: "message",
            sourceId: "message-user-execution",
            quote: userText,
          }),
        ],
      }),
    ]);
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "memory_candidate_displaced_by_explicit_source_fallback",
      }),
    );
  });

  it("does not treat an explicit-memory framing clause as an uncovered durable fact", () => {
    const harness = createHarness("enforced", "enforced");
    const userText = "再记一个饮食偏好：我通常不吃香菜。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "explicit_memory",
      routerReasonCodes: ["explicit_memory_request"],
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_preference", content: "我通常不吃香菜" },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: "我通常不吃香菜",
        reasonCode: "model_memory_candidate",
      }),
    ]);
    expect(outcome.proposalRejections).not.toContainEqual(
      expect.objectContaining({
        reasonCode: "memory_candidate_displaced_by_explicit_source_fallback",
      }),
    );
  });

  it("keeps a grounded model memory when it covers every authoritative person proposition", () => {
    const harness = createHarness("enforced", "enforced");
    const userText = "我大学同学叫小林，她最近刚搬到苏州。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [{ type: "user_fact", content: userText }],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: userText,
        reasonCode: "model_memory_candidate",
      }),
    ]);
    expect(outcome.proposalRejections).not.toContainEqual(
      expect.objectContaining({
        reasonCode: "memory_candidate_displaced_by_explicit_source_fallback",
      }),
    );
  });

  it("projects an authoritative correction before replacing an incomplete model memory", () => {
    const harness = createHarness("enforced", "enforced");
    const userText =
      "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。";
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_fact", content: "小林是用户的高中同学" },
        ],
      }),
    };
    const input = executionInput(observation);

    const outcome = harness.service.execute({
      ...input,
      userText,
      capabilities: { ...input.capabilities, memoryCandidatesPerTurn: 1 },
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        content: "小林是我高中同学。她搬到苏州。",
        reasonCode: "explicit_source_memory_fallback",
      }),
    ]);
    expect(
      outcome.acceptedWorldEffects.memoryCandidates[0]?.content,
    ).not.toContain("大学同学");
  });

  it.each([
    "假设我大学同学叫小林，她最近刚搬到苏州。",
    "张伟说，他大学同学叫小林，她最近刚搬到苏州。",
    "撤回这条：我大学同学叫小林，她最近刚搬到苏州。",
    "我纠正一下：张伟说，小林不是我的大学同学，是我高中同学。她搬到苏州。",
  ])(
    "does not use authoritative-coverage replacement for a guarded source: %s",
    (userText) => {
      const harness = createHarness("enforced", "enforced");
      const observation: ResolvedTurnObservation = {
        ...conversationObservation(),
        worldEffectsValidation: validateWorldEffects({
          memoryCandidates: [
            { type: "user_fact", content: "用户大学同学叫小林" },
          ],
        }),
      };
      const input = executionInput(observation);

      const outcome = harness.service.execute({
        ...input,
        userText,
        capabilities: { ...input.capabilities, memoryCandidatesPerTurn: 1 },
      });

      expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([]);
      expect(
        outcome.acceptedWorldEffects.memoryCandidates.some(
          (candidate) =>
            candidate.reasonCode === "explicit_source_memory_fallback",
        ),
      ).toBe(false);
    },
  );

  it.each([
    "请记住，我的蓝色玻璃鲸是不是放在左口袋？",
    "假设我每次演讲前把蓝色玻璃鲸放在左口袋，请记住这个例子。",
    "小林说她大学同学搬到苏州了。",
    "撤回前面的说法：我大学同学叫小林。",
    "我大学同学不叫小林。",
    "我纠正一下：我每天喝咖啡。",
    "假设我纠正一下前面的说法。准确说法是，我每天喝咖啡；这里只是举例。",
    "小林说她纠正一下前面的说法。准确说法是，她每天喝咖啡。",
    "张伟说：“我纠正一下前面的说法。准确说法是，我每天喝咖啡。”",
    "我纠正一下：张伟说，准确说法是，我每天喝咖啡。",
    "我纠正一下：朋友阿杰说，准确说法是，我每天喝咖啡。",
    "我纠正一下：准确说法是，朋友阿杰说，我每天喝咖啡。",
    "我纠正一下前面的说法。准确说法是，我每天喝咖啡；这条也撤回。",
    "我改口：我喜欢咖啡。",
    "我想改口：我的生日是 8 月 2 日。",
    "我纠正一下：准确说法是，我喜欢咖啡；这条不要记录。",
    "我纠正一下：准确说法是，我喜欢咖啡；别把这条记下来。",
    "我纠正一下：准确说法是，我要是每天喝咖啡就会失眠。",
    "我纠正一下：准确说法是，我万一每天喝咖啡就会失眠。",
    "我纠正一下：准确说法是，我倘若每天喝咖啡就会失眠。",
    "假设我纠正一下：小林不是我的大学同学，是我高中同学。",
    "我纠正一下：张伟说，小林不是我的大学同学，是我高中同学。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。以上是据张伟所说。",
    "我纠正一下：小林不是我的大学同学，是我高中同学；这条不要记录。",
    "把你说成没有孩子并不准确。",
  ])(
    "does not create an explicit-source memory from a question or hypothesis: %s",
    (userText) => {
      const harness = createHarness("enforced", "enforced");
      const observation: ResolvedTurnObservation = {
        ...conversationObservation(),
        route: "conversation",
        worldEffectsValidation: validateWorldEffects({}),
      };

      const outcome = harness.service.execute({
        ...executionInput(observation),
        userText,
      });

      expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([]);
    },
  );

  it.each([
    {
      source: "我纠正一下：张伟说，准确说法是，我每天喝咖啡。",
      candidate: "用户每天喝咖啡",
    },
    {
      source: "我纠正一下：朋友阿杰说，准确说法是，我每天喝咖啡。",
      candidate: "用户每天喝咖啡",
    },
    {
      source: "我纠正一下：准确说法是，朋友阿杰说，我每天喝咖啡。",
      candidate: "用户每天喝咖啡",
    },
    {
      source: "我改口：我喜欢咖啡。",
      candidate: "用户喜欢咖啡",
    },
    {
      source: "我想改口：我的生日是 8 月 2 日。",
      candidate: "用户的生日是 8 月 2 日",
    },
    {
      source: "我纠正一下：准确说法是，我喜欢咖啡；这条不要记录。",
      candidate: "用户喜欢咖啡",
    },
    {
      source: "我纠正一下：准确说法是，我喜欢咖啡；别把这条记下来。",
      candidate: "用户喜欢咖啡",
    },
    {
      source: "我纠正一下：准确说法是，我要是每天喝咖啡就会失眠。",
      candidate: "用户每天喝咖啡就会失眠",
    },
    {
      source: "假设我纠正一下：小林不是我的大学同学，是我高中同学。",
      candidate: "小林是用户的高中同学",
    },
    {
      source: "我纠正一下：张伟说，小林不是我的大学同学，是我高中同学。",
      candidate: "小林是用户的高中同学",
    },
    {
      source:
        "我纠正一下：小林不是我的大学同学，是我高中同学。以上是据张伟所说。",
      candidate: "小林是用户的高中同学",
    },
    {
      source: "我纠正一下：小林不是我的大学同学，是我高中同学；这条不要记录。",
      candidate: "小林是用户的高中同学",
    },
  ])(
    "rejects a model memory candidate from a guarded correction source: $source",
    ({ source, candidate }) => {
      const harness = createHarness("enforced", "enforced");
      const observation: ResolvedTurnObservation = {
        ...conversationObservation(),
        route: "conversation",
        worldEffectsValidation: validateWorldEffects({
          memoryCandidates: [{ type: "user_fact", content: candidate }],
        }),
      };

      const outcome = harness.service.execute({
        ...executionInput(observation),
        userText: source,
      });

      expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([]);
      expect(outcome.proposalRejections).toContainEqual(
        expect.objectContaining({
          reasonCode: "ungrounded_memory_candidate",
          field: "memory_candidate",
        }),
      );
    },
  );

  it.each([
    "根据张伟的说法。",
    "按张伟的说法。",
    "这是张伟告诉我的。",
    "这句话是张伟告诉我的。",
    "听我妈妈讲的。",
    "据张伟讲。",
    "这是转引张伟的话。",
    "信息来源是张伟。",
  ])("fails closed on an unrecognized direct-contrast tail: %s", (tail) => {
    const harness = createHarness("enforced", "enforced");
    const source = `我纠正一下：小林不是我的大学同学，是我高中同学。${tail}`;
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "conversation",
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_fact", content: "小林是用户的高中同学" },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText: source,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([]);
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "ungrounded_memory_candidate",
        field: "memory_candidate",
      }),
    );
  });

  it.each([
    "根据张伟的说法。",
    "按张伟的说法。",
    "这是张伟告诉我的。",
    "听我妈妈讲的。",
    "据张伟讲。",
    "信息来源是张伟。",
  ])("rejects third-party attribution after an accuracy marker: %s", (tail) => {
    const harness = createHarness("enforced", "enforced");
    const source = `我纠正一下：准确说法是，我喜欢咖啡。${tail}`;
    const observation: ResolvedTurnObservation = {
      ...conversationObservation(),
      route: "conversation",
      worldEffectsValidation: validateWorldEffects({
        memoryCandidates: [
          { type: "user_preference", content: "用户喜欢咖啡" },
        ],
      }),
    };

    const outcome = harness.service.execute({
      ...executionInput(observation),
      userText: source,
    });

    expect(outcome.acceptedWorldEffects.memoryCandidates).toEqual([]);
    expect(outcome.proposalRejections).toContainEqual(
      expect.objectContaining({
        reasonCode: "ungrounded_memory_candidate",
        field: "memory_candidate",
      }),
    );
  });
});

function createHarness(
  mode: "shadow" | "enforced",
  liveWorldEffectsMode: "off" | "shadow" | "enforced" = "enforced",
) {
  const getActive = vi.fn(() => undefined);
  const listActivityEvents = vi.fn(() => [] as StoredActivityEvent[]);
  const getScheduleItem = vi.fn((id: string): ScheduleItem | undefined => {
    void id;
    return undefined;
  });
  const validateEffectsPartial = vi.fn(
    (
      _agentId: string,
      effects: ScheduleEffectProposal[],
    ): ReturnType<ScheduleService["validateEffectsPartial"]> => ({
      accepted: [...effects],
      rejections: [],
    }),
  );
  const store = {
    getActiveScheduleNegotiation: getActive,
    listScheduleNegotiations: vi.fn(() => []),
    listActivityEvents,
    getScheduleItem,
    database: {
      prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
    },
  };
  const schedules = { validateEffectsPartial };
  return {
    getActive,
    listActivityEvents,
    getScheduleItem,
    validateEffectsPartial,
    service: new TurnExecutionService(
      store as unknown as DatabaseStore,
      schedules as unknown as ScheduleService,
      {
        scheduleNegotiationMode: mode,
        liveWorldEffectsMode,
      },
    ),
  };
}

function executionInput(
  observation: ResolvedTurnObservation,
): Parameters<TurnExecutionService["execute"]>[0] {
  return {
    sessionId: "session-execution",
    agentId: "agent-execution",
    userText:
      observation.route === "schedule_mutation"
        ? "我们明天 19:00 一起散步吧。"
        : observation.route === "schedule_query"
          ? "看看我接下来的日程。"
          : "今天天气不错。",
    userMessageId: "message-user-execution",
    clientMessageId: "client-execution",
    assistantMessageId: "message-assistant-execution",
    nowUtc: NOW,
    spec: characterSpec(),
    state: runtimeState(),
    capabilities: capabilities(),
    recentMessages: [],
    authoritativeSchedule: [],
    observation,
  };
}

function conversationObservation(): ResolvedTurnObservation {
  return {
    origin: "model_valid",
    route: "conversation",
    scheduleIntent: { kind: "none" },
    validatedEvidence: [],
    rejectedFields: [],
    worldEffectsValidation: validateWorldEffects({}),
    topics: [],
    confidence: 0.9,
    routerReasonCodes: ["ordinary_conversation"],
  };
}

function sharedActivityObservation(): ResolvedTurnObservation {
  return {
    origin: "model_valid",
    route: "schedule_mutation",
    scheduleIntent: {
      kind: "create_shared_activity",
      activityQuote: { text: "一起散步" },
      timeQuote: { text: "明天 19:00" },
      participantQuote: { text: "我们" },
      missingFields: [],
    },
    validatedEvidence: [
      { text: "我们", start: 0, end: 2 },
      { text: "明天 19:00", start: 2, end: 10 },
      { text: "一起散步", start: 11, end: 15 },
    ],
    rejectedFields: [],
    worldEffectsValidation: validateWorldEffects({}),
    topics: [],
    confidence: 0.95,
    routerReasonCodes: ["explicit_schedule_mutation_candidate"],
  };
}

function unsupportedRescheduleObservation(
  userText: string,
): ResolvedTurnObservation {
  return {
    origin: "deterministic",
    route: "schedule_mutation",
    scheduleIntent: {
      kind: "unsupported_mutation",
      operation: "reschedule",
      evidenceQuotes: [{ text: userText }],
    },
    validatedEvidence: [{ text: userText, start: 0, end: userText.length }],
    rejectedFields: [],
    worldEffectsValidation: validateWorldEffects({}),
    topics: [],
    confidence: 1,
    routerReasonCodes: ["high_precision_unsupported_schedule_mutation"],
  };
}

function worldEffectObservation(): ResolvedTurnObservation {
  return {
    ...conversationObservation(),
    worldEffectsValidation: validateWorldEffects({
      stateDelta: { energy: -0.1 },
      relationshipDelta: { trust: 0.02 },
    }),
  };
}

function scheduleQueryObservation(): ResolvedTurnObservation {
  return {
    origin: "model_valid",
    route: "schedule_query",
    scheduleIntent: {
      kind: "query_schedule",
      evidenceQuotes: [{ text: "看看我接下来的日程" }],
    },
    validatedEvidence: [{ text: "看看我接下来的日程", start: 0, end: 9 }],
    rejectedFields: [],
    worldEffectsValidation: validateWorldEffects({}),
    topics: [],
    confidence: 0.95,
    routerReasonCodes: ["explicit_schedule_query"],
  };
}

function committedEntityScheduleQueryObservation(): ResolvedTurnObservation {
  return {
    ...scheduleQueryObservation(),
    scheduleFrame: {
      kind: "query_existing",
      entityText: "北岸书店",
      statusScope: "committed",
      targetScope: "shared",
      evidenceSpans: [
        {
          text: "当前真正生效的北岸书店安排是什么？",
          start: 0,
          end: 18,
        },
      ],
    },
  };
}

function characterSpec(): CharacterSpec {
  return {
    id: "agent-execution",
    version: 1,
    status: "published",
    tier: "high_fidelity",
    identity: { timezone: "Asia/Shanghai" },
    schedulePolicy: { enabled: true },
    persona: { goals: [], preferences: [] },
    routines: [],
  } as unknown as CharacterSpec;
}

function runtimeState(): RuntimeState {
  return {
    agentId: "agent-execution",
    asOfUtc: NOW,
    moodValence: 0,
    moodArousal: 0.5,
    energy: 0.6,
    stress: 0.2,
    socialBattery: 0.6,
    focus: 0.7,
    sleepDebtMinutes: 0,
    relationship: {
      userId: "local-user",
      closeness: 0.5,
      trust: 0.5,
      familiarity: 0.5,
      recentInteractionValence: 0,
    },
    revision: 0,
  };
}

function capabilities(): SimulationCapabilities {
  return {
    schedule: true,
    offlineSettlement: true,
    dynamicState: true,
    longTermMemory: true,
    relationshipDynamics: true,
    relationshipDeltaScale: 1,
    proactiveDialogue: true,
    personaGuard: true,
    activityEnrichment: true,
    memoryCandidatesPerTurn: 8,
  };
}

function scheduleItem(): ScheduleItem {
  return {
    id: "schedule-read-item",
    agentId: "agent-execution",
    title: "晚间散步",
    description: "",
    category: "exercise",
    startAtUtc: "2026-08-23T11:00:00.000Z",
    endAtUtc: "2026-08-23T12:00:00.000Z",
    timezone: "Asia/Shanghai",
    rigidity: "committed",
    priority: 0.8,
    status: "planned",
    source: "user_invitation",
    adherenceProbability: 0.9,
    narrativeImportance: 0.6,
    shareable: true,
    stateEffects: {},
    revision: 0,
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function activityEvent(
  input: Pick<
    StoredActivityEvent,
    "id" | "scheduleItemId" | "eventType" | "occurredAtUtc" | "summary"
  >,
): StoredActivityEvent {
  return {
    ...input,
    agentId: "agent-execution",
    outcomeFacts: [],
    stateDelta: {},
    origin: "deterministic",
    idempotencyKey: `activity:${input.id}`,
  };
}

function historicalAuthorization(authorizedItemId: string) {
  return {
    authorizedItemId,
    scheduleCommandEventId: `event-for-${authorizedItemId}`,
    negotiationId: `negotiation-for-${authorizedItemId}`,
    offerVersion: 1,
    negotiationStatus: "committed" as const,
  };
}
