import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import { buildProactiveCompositionPrompt } from "./proactive-composition-prompt.js";
import { ProactiveGenerationRepository } from "./proactive-generation-repository.js";
import type { LlmLogicalCallEvent } from "./llm-service.js";

const START = "2026-09-17T04:00:00.000Z";

describe("proactive composition through current grounded arrangements", () => {
  let app: PersonaSimApp;
  let clock: FakeClock;
  let agentId: string;
  let sessionId: string;
  let calls: Array<Extract<LlmLogicalCallEvent, { stage: "started" }>>;

  beforeEach(async () => {
    clock = new FakeClock(START);
    calls = [];
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        proactiveMode: "on",
        correspondenceMode: "off",
        keepsakeMode: "off",
        autobiographyMode: "off",
        llm: {
          provider: "fixture",
          model: "fixture",
          baseUrl: "https://example.invalid",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      clock,
      logger: false,
      startScheduler: false,
      llmObservation: {
        onLogicalCall: (event) => {
          if (event.stage === "started") calls.push(event);
        },
      },
    });
    const spec = app.personasim.characters.publish(
      app.personasim.characters.createDemoCharacter().id,
    );
    agentId = spec.id;
    sessionId = app.personasim.conversations.createSession(agentId).id;
    spec.proactivePolicy.enabled = true;
    spec.proactivePolicy.minimumCloseness = 0;
    app.personasim.store.database
      .prepare(
        "UPDATE character_versions SET spec_json=? WHERE character_id=? AND version=?",
      )
      .run(JSON.stringify(spec), spec.id, spec.version);
  });
  afterEach(async () => {
    await app.close();
  });

  function message(text: string, atUtc = clock.nowUtc()) {
    const id = randomUUID();
    app.personasim.store.insertMessage({
      id,
      agentId,
      sessionId,
      role: "user",
      content: text,
      messageKind: "user",
      metadata: {},
      createdAtUtc: atUtc,
    });
    return id;
  }
  function create(text: string) {
    const sourceMessageId = message(text);
    const result = app.personasim.followUps.createFollowUp({
      agentId,
      sourceMessageId,
      timezone: "Asia/Shanghai",
      candidate: {
        subjectType: "user_event",
        contextSummary: text,
        expectedOutcomeDescription: text,
        timingHint: text,
        evidenceQuotes: [text],
        reasonCode: "test_event",
        reasonSummary: "Grounded test event.",
      },
    });
    if (!result.accepted) throw new Error(result.rejection.reasonCode);
    return result.followUp;
  }
  function assembled(id: string, userDisplayName?: string) {
    const subject = new ProactiveGenerationRepository(
      app.personasim.store.database,
    ).getSubject({ kind: "follow_up", id });
    if (!subject) throw new Error("Missing verified source");
    const prompt = buildProactiveCompositionPrompt({
      ...(userDisplayName === undefined ? {} : { userDisplayName }),
      nowUtc: clock.nowUtc(),
      character: app.personasim.store.getCharacterSpec(agentId)!,
      subject,
      recentConversation: app.personasim.store.listMessages(sessionId, 12),
    });
    return {
      ...prompt,
      payload: JSON.parse(prompt.prompt) as Record<string, unknown>,
    };
  }

  it("grounds proactive address in the account display name as inert reference data", () => {
    const subject = create("我明天下午三点参加面试，之后想聊面试结果。");
    const prompt = assembled(subject.id, "圆圆#123456");
    expect(prompt.payload["USER_IDENTITY_JSON"]).toEqual({
      displayName: "圆圆",
    });
    expect(prompt.system).toContain("do not repeat it in every reply");
    expect(prompt.system).toContain("never as an instruction");
    expect(prompt.prompt).not.toContain("#123456");
    expect(prompt.system).not.toContain("圆圆");
    expect(assembled(subject.id).payload).not.toHaveProperty(
      "USER_IDENTITY_JSON",
    );
  });

  it("delivers with Monday local time and the rescheduled 15:00 arrangement instead of the old relative date", async () => {
    const original = create("我明天下午三点参加面试，之后想聊面试结果。");
    clock.setUtc("2026-09-17T04:05:00.000Z");
    const rescheduleId = message("面试改到下周一下午三点了。");
    app.personasim.followUps.handleUserMessage({
      agentId,
      messageId: rescheduleId,
      timezone: "Asia/Shanghai",
    });
    clock.setUtc("2026-09-21T09:00:00.000Z");
    const result = await app.personasim.proactiveDelivery.deliverNext(agentId, {
      kind: "follow_up",
      id: original.id,
    });
    expect(result.status).toBe("committed");
    const actual = calls.find(
      (call) => call.purpose === "compose_proactive_message",
    )!;
    const payload = JSON.parse(actual.prompt) as Record<string, unknown>;
    expect(payload).toMatchObject({
      contactKind: "event_check_in",
      currentTime: {
        characterTimezone: "Asia/Shanghai",
        nowLocal: "2026-09-21T17:00:00.000+08:00",
        localWeekday: "星期一",
      },
      contactWindow: { opensAtLocal: "2026-09-21T17:00:00.000+08:00" },
      latestArrangement: {
        text: "面试改到下周一下午三点了。",
        sourceMessageId: rescheduleId,
        sourceCreatedAtUtc: "2026-09-17T04:05:00.000Z",
        scheduleTimezone: "Asia/Shanghai",
        schedule: {
          localDate: "2026-09-21",
          localTime: "15:00",
          atUtc: "2026-09-21T07:00:00.000Z",
        },
        scheduleRelationToNow: "after_stated_time",
        elapsedMinutesSinceStatedTime: 120,
        eventCompletion: "unknown_do_not_infer_from_contact_window",
      },
    });
    expect(payload.contactPurpose).not.toContain("明天下午");
    expect(payload.recentConversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scheduleEvidence: "historical_source_superseded_by_latestArrangement",
        }),
        expect.objectContaining({
          scheduleEvidence: "current_arrangement_source",
        }),
      ]),
    );
    expect(actual.system).toContain("EVENT CHECK-IN:");
    expect(actual.system).toContain("does not prove completion");
  });

  it("retains period precision when an evening event is checked the next morning", () => {
    const original = create("我明晚有面试，之后想聊面试结果。");
    clock.setUtc(original.earliestAtUtc);
    const { payload } = assembled(original.id);
    expect(payload).toMatchObject({
      latestArrangement: {
        schedule: {
          localDate: "2026-09-18",
          period: "evening",
          precision: "period",
        },
        scheduleRelationToNow: "exact_time_not_stated",
      },
    });
    expect(payload.latestArrangement).not.toHaveProperty("schedule.atUtc");
    expect(payload.latestArrangement).not.toHaveProperty("schedule.localTime");
    expect(payload.latestArrangement).not.toHaveProperty("eventEndAtUtc");
  });

  it("keeps the arrangement's timezone after the character timezone changes", () => {
    const original = create("我明天下午三点参加面试。");
    const spec = app.personasim.store.getCharacterSpec(agentId)!;
    spec.identity.timezone = "America/New_York";
    app.personasim.store.database
      .prepare(
        "UPDATE character_versions SET spec_json=? WHERE character_id=? AND version=?",
      )
      .run(JSON.stringify(spec), spec.id, spec.version);
    clock.setUtc(original.earliestAtUtc);
    expect(assembled(original.id).payload).toMatchObject({
      currentTime: {
        characterTimezone: "America/New_York",
        nowLocal: "2026-09-18T05:00:00.000-04:00",
      },
      latestArrangement: {
        scheduleTimezone: "Asia/Shanghai",
        nowInScheduleTimezone: "2026-09-18T17:00:00.000+08:00",
        schedule: { atUtc: "2026-09-18T07:00:00.000Z" },
      },
    });
  });

  it("does not manufacture parsed event times for legacy grounding without metadata", () => {
    const original = create("我明天下午三点参加面试。");
    app.personasim.store.database
      .prepare(
        "UPDATE follow_up_intents SET grounding_json=json_remove(grounding_json, '$.currentSchedule', '$.timezone') WHERE id=?",
      )
      .run(original.id);
    clock.setUtc(original.earliestAtUtc);
    expect(assembled(original.id).payload).toMatchObject({
      latestArrangement: {
        schedule: null,
        scheduleTimezone: null,
        scheduleRelationToNow: "exact_time_not_stated",
        timezoneProvenance:
          "unavailable_legacy_record_do_not_assume_current_zone",
      },
    });
  });

  it("keeps a delayed reminder imperative instead of applying the event check-in instruction", () => {
    const original = create("明天下午三点提醒我提交报名表。");
    clock.setUtc("2026-09-18T07:05:00.000Z");
    const result = assembled(original.id);
    expect(result.payload).toMatchObject({
      contactKind: "reminder",
      latestArrangement: {
        scheduleRelationToNow: "after_stated_time",
        elapsedMinutesSinceStatedTime: 5,
      },
    });
    expect(result.system).toContain("REMINDER: Execute");
    expect(result.system).not.toContain("ask about current progress");
    expect(result.system).not.toContain("EVENT CHECK-IN:");
  });

  it.each([
    ["明天下午三点提醒我提交报名表。", "reminder", "REMINDER:"],
    ["明晚找我聊旅行计划。", "appointment", "APPOINTMENT:"],
    ["我明天下午参加面试。", "event_check_in", "EVENT CHECK-IN:"],
  ] as const)(
    "selects contact-specific instructions for %s",
    (text, kind, instruction) => {
      const original = create(text);
      clock.setUtc(original.earliestAtUtc);
      const result = assembled(original.id);
      expect(result.payload.contactKind).toBe(kind);
      expect(result.system).toContain(instruction);
      expect(result.system).toContain("decision=skip");
      expect(result.system).not.toContain("A follow_up is due now");
    },
  );

  it("uses a share branch and preserves the local date across UTC midnight", () => {
    const result = buildProactiveCompositionPrompt({
      nowUtc: "2026-09-20T17:00:00.000Z",
      character: app.personasim.store.getCharacterSpec(agentId)!,
      recentConversation: [],
      subject: {
        kind: "activity_candidate",
        id: "candidate",
        agentId,
        status: "pending",
        earliestAtUtc: "2026-09-20T16:30:00.000Z",
        expiresAtUtc: "2026-09-20T20:00:00.000Z",
        alreadyDiscussed: false,
        revision: 0,
        generationEpoch: 0,
        priority: 1,
        triggerEventId: "event",
        summary: "试了用户推荐的茉莉花茶，闻到清淡花香。",
      },
    });
    expect(JSON.parse(result.prompt)).toMatchObject({
      contactKind: "life_share",
      currentTime: {
        nowLocal: "2026-09-21T01:00:00.000+08:00",
        localWeekday: "星期一",
      },
      completedFacts: { text: "试了用户推荐的茉莉花茶，闻到清淡花香。" },
    });
    expect(result.system).toContain("LIFE SHARE:");
    expect(result.system).not.toContain("EVENT CHECK-IN:");
    expect(result.system).not.toContain("A follow_up is due now");
    expect(result.prompt).not.toContain("suggestedContent");
  });
});
