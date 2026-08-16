import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScheduleNegotiationAction } from "@personasim/contracts";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import type { StoredScheduleNegotiation } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z"; // 10:00 Asia/Shanghai
const RUN_START_UTC = "2026-08-16T23:00:00.000Z"; // next day 07:00
const RUN_END_UTC = "2026-08-16T23:30:00.000Z";
const DIRECT_AGREEMENT = "那说好了明天早上七点一起跑半小时";

const ACCEPTED_REPLY_VARIANTS = [
  "好。",
  "可以，明早见。",
  "没问题，我会准时到。",
  "当然。你要我带水吗？",
] as const;

describe("server-owned schedule negotiation", () => {
  let app: PersonaSimApp | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
    vi.restoreAllMocks();
  });

  it.each(ACCEPTED_REPLY_VARIANTS)(
    "commits the same direct user offer independently of reply wording: %s",
    async (replyText) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, (input) => {
        expect(input.prompt).toContain("SCHEDULE_NEGOTIATION_CONTRACT");
        expect(input.prompt).not.toContain("SCHEDULE_EFFECTS_CONTRACT");
        const decision = {
          text: replyText,
          scheduleAction: acceptUserOffer(),
        };
        expect(decision).not.toHaveProperty("scheduleEffects");
        return decision;
      });

      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        `direct-offer-${ACCEPTED_REPLY_VARIANTS.indexOf(replyText)}`,
        DIRECT_AGREEMENT,
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toHaveLength(1);
      const created = body.scheduleChanges[0]!;
      expect(created).toMatchObject({
        category: "exercise",
        status: "planned",
        rigidity: "committed",
        source: "user_invitation",
        startAtUtc: RUN_START_UTC,
        endAtUtc: RUN_END_UTC,
      });
      expect(body.assistantMessage.metadata).toMatchObject({
        decisionPath: "full",
        rejectedProposalCount: 0,
        repairAttempted: false,
      });
      expect(app.personasim.store.listSchedule(character.id)).toHaveLength(
        scheduleBefore.length + 1,
      );
      expect(app.personasim.store.getScheduleItem(created.id)).toEqual(created);

      const negotiations = app.personasim.store.listScheduleNegotiations({
        sessionId,
      });
      expect(negotiations).toHaveLength(1);
      expect(negotiations[0]).toMatchObject({
        status: "committed",
        offerVersion: 1,
      });
      expect(readNegotiationState(negotiations[0]!)).toMatchObject({
        status: "committed",
        offerVersion: 1,
        offer: {
          version: 1,
          category: "exercise",
          startAtUtc: RUN_START_UTC,
          durationMinutes: 30,
        },
      });

      const commandEvents = app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed");
      expect(commandEvents).toHaveLength(1);
      expect(commandEvents[0]?.payload).toMatchObject({
        negotiationId: negotiations[0]?.id,
        offerVersion: 1,
        operation: "create",
        changedItemIds: [created.id],
      });
      expect(
        calls.filter((input) => input.purpose === "chat_turn"),
      ).toHaveLength(1);
    },
  );

  it.each([
    {
      label:
        "uses the category default when the only amount is a relative start",
      userText: "2小时后一起跑",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "2小时后",
        evidenceQuotes: ["2小时后一起跑"],
      },
      startAtUtc: "2026-08-16T04:00:00.000Z",
      endAtUtc: "2026-08-16T04:30:00.000Z",
    },
    {
      label: "grounds 一个半小时 as ninety minutes",
      userText: "那说好了明天下午三点一起跑一个半小时",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "明天下午三点",
        durationMinutes: 90,
        evidenceQuotes: ["明天下午三点一起跑一个半小时"],
      },
      startAtUtc: "2026-08-17T07:00:00.000Z",
      endAtUtc: "2026-08-17T08:30:00.000Z",
    },
    {
      label: "grounds 两小时半 as one hundred fifty minutes",
      userText: "那说好了明天下午三点一起跑两小时半",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "明天下午三点",
        durationMinutes: 150,
        evidenceQuotes: ["明天下午三点一起跑两小时半"],
      },
      startAtUtc: "2026-08-17T07:00:00.000Z",
      endAtUtc: "2026-08-17T09:30:00.000Z",
    },
    {
      label: "grounds 一刻钟 as fifteen minutes",
      userText: "那说好了明天下午三点一起跑一刻钟",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "明天下午三点",
        durationMinutes: 15,
        evidenceQuotes: ["明天下午三点一起跑一刻钟"],
      },
      startAtUtc: "2026-08-17T07:00:00.000Z",
      endAtUtc: "2026-08-17T07:15:00.000Z",
    },
  ] as const)("$label", async ({ userText, offer, startAtUtc, endAtUtc }) => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "好。",
      scheduleAction: { kind: "accept_user_offer", offer },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      `duration-${offer.durationMinutes ?? "default"}`,
      userText,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([
      expect.objectContaining({
        category: "exercise",
        startAtUtc,
        endAtUtc,
      }),
    ]);
    expect(body.assistantMessage.metadata).toMatchObject({
      decisionPath: "full",
      rejectedProposalCount: 0,
      repairAttempted: false,
    });
  });

  it("commits 今晚十二点半 at local midnight rather than noon", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "好。",
      scheduleAction: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起跑步",
          category: "exercise",
          startAt: "今晚十二点半",
          durationMinutes: 30,
          evidenceQuotes: ["今晚十二点半一起跑半小时"],
        },
      },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    for (const item of app.personasim.store.listSchedule(character.id)) {
      if (
        item.category === "sleep" &&
        item.startAtUtc < "2026-08-16T17:00:00.000Z" &&
        item.endAtUtc > "2026-08-16T16:30:00.000Z"
      ) {
        app.personasim.store.updateScheduleItem({
          ...item,
          status: "cancelled",
          revision: item.revision + 1,
          updatedAtUtc: START_UTC,
        });
      }
    }
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "midnight-direct-accept",
      "那说好了今晚十二点半一起跑半小时",
    );

    expect(response.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toEqual([
      expect.objectContaining({
        category: "exercise",
        startAtUtc: "2026-08-16T16:30:00.000Z",
        endAtUtc: "2026-08-16T17:00:00.000Z",
      }),
    ]);
  });

  it("grounds an English word duration instead of applying the category default", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "Okay.",
      scheduleAction: {
        kind: "accept_user_offer",
        offer: {
          activity: "meet",
          category: "social",
          startAt: "tomorrow at 3 pm",
          evidenceQuotes: ["meet tomorrow at 3 pm for one hour"],
        },
      },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "english-word-duration",
      "Let's meet tomorrow at 3 pm for one hour.",
    );

    expect(response.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toEqual([
      expect.objectContaining({
        category: "social",
        startAtUtc: "2026-08-17T07:00:00.000Z",
        endAtUtc: "2026-08-17T08:00:00.000Z",
      }),
    ]);
  });

  it.each([
    {
      label: "does not read run out of brunch",
      userText: "Let's have brunch tomorrow at 3 pm.",
      offer: {
        activity: "run",
        category: "exercise",
        startAt: "tomorrow at 3 pm",
        evidenceQuotes: ["Let's have brunch tomorrow at 3 pm"],
      },
    },
    {
      label: "does not read show out of shower",
      userText: "Let's take a shower tomorrow at 3 pm.",
      offer: {
        activity: "watch a show",
        category: "leisure",
        startAt: "tomorrow at 3 pm",
        evidenceQuotes: ["Let's take a shower tomorrow at 3 pm"],
      },
    },
  ] as const)("$label", async ({ userText, offer }) => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "Okay.",
      scheduleAction: { kind: "accept_user_offer", offer },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      `lexical-grounding-${offer.category}`,
      userText,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.metadata).toMatchObject({
      rejectedProposalCount: 1,
      repairAttempted: true,
    });
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listRejectedProposals(character.id, 20),
    ).toEqual([
      expect.objectContaining({ reasonCode: "activity_not_grounded" }),
    ]);
  });

  it.each([
    {
      label: "multiple candidate clocks",
      userText: "那明天七点或八点一起跑半小时",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "明天七点",
        durationMinutes: 30,
        evidenceQuotes: ["明天七点或八点一起跑半小时"],
      },
      reasonCode: "ambiguous_start_time",
    },
    {
      label: "clock range without an explicit duration",
      userText: "那明天下午三点到五点一起跑",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "明天下午三点",
        evidenceQuotes: ["明天下午三点到五点一起跑"],
      },
      reasonCode: "ambiguous_start_time",
    },
    {
      label: "alternative relative starts",
      userText: "半小时后或一小时后一起跑",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "半小时后",
        evidenceQuotes: ["半小时后或一小时后一起跑"],
      },
      reasonCode: "ambiguous_start_time",
    },
    {
      label: "Chinese duration range",
      userText: "那明天下午三点一起跑一到两小时",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "明天下午三点",
        durationMinutes: 120,
        evidenceQuotes: ["明天下午三点一起跑一到两小时"],
      },
      reasonCode: "ambiguous_duration",
    },
    {
      label: "colloquial Chinese duration range",
      userText: "那明天下午三点一起跑一两个小时",
      offer: {
        activity: "一起跑步",
        category: "exercise",
        startAt: "明天下午三点",
        durationMinutes: 720,
        evidenceQuotes: ["明天下午三点一起跑一两个小时"],
      },
      reasonCode: "ambiguous_duration",
    },
    {
      label: "unparsed explicit duration",
      userText: "Let's meet tomorrow at 3 pm for a couple of hours.",
      offer: {
        activity: "meet",
        category: "social",
        startAt: "tomorrow at 3 pm",
        evidenceQuotes: ["meet tomorrow at 3 pm for a couple of hours"],
      },
      reasonCode: "unparsed_duration",
    },
    {
      label: "mixed parsed and unparsed durations",
      userText:
        "Let's meet tomorrow at 3 pm for one hour or a couple of hours.",
      offer: {
        activity: "meet",
        category: "social",
        startAt: "tomorrow at 3 pm",
        evidenceQuotes: [
          "meet tomorrow at 3 pm for one hour or a couple of hours",
        ],
      },
      reasonCode: "unparsed_duration",
    },
  ] as const)(
    "rejects $label instead of choosing material terms",
    async ({ userText, offer, reasonCode }) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, () => ({
        text: "好。",
        scheduleAction: { kind: "accept_user_offer", offer },
      }));
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        `ambiguous-${reasonCode}-${offer.durationMinutes ?? "clock"}`,
        userText,
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.metadata).toMatchObject({
        rejectedProposalCount: 1,
        repairAttempted: true,
      });
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.listRejectedProposals(character.id, 20),
      ).toEqual([expect.objectContaining({ reasonCode })]);
    },
  );

  it("replays a committed command once and rejects client id reuse with different content", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      expect(input.prompt).toContain("SCHEDULE_NEGOTIATION_CONTRACT");
      return {
        text: "好，明早见。",
        scheduleAction: acceptUserOffer(),
      };
    });

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const clientMessageId = "idempotent-negotiated-command";

    const firstResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      DIRECT_AGREEMENT,
    );
    expect(firstResponse.statusCode).toBe(201);
    const firstBody = jsonBody<ChatTurnResult>(firstResponse);
    expect(firstBody.idempotentReplay).toBe(false);
    expect(firstBody.scheduleChanges).toHaveLength(1);

    const scheduleAfterFirst = app.personasim.store.listSchedule(character.id);
    const negotiationsAfterFirst =
      app.personasim.store.listScheduleNegotiations({ sessionId });
    const eventsAfterFirst = app.personasim.store.listDomainEvents(
      character.id,
      100,
    );
    const messagesAfterFirst = app.personasim.store.listMessages(sessionId);
    expect(
      eventsAfterFirst.filter(
        (event) => event.eventType === "schedule.command_committed",
      ),
    ).toHaveLength(1);
    expect(calls.filter((input) => input.purpose === "chat_turn")).toHaveLength(
      1,
    );

    const replayResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      DIRECT_AGREEMENT,
    );
    expect(replayResponse.statusCode).toBe(200);
    const replayBody = jsonBody<ChatTurnResult>(replayResponse);
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.scheduleChanges).toEqual([]);
    expect(replayBody.userMessage.id).toBe(firstBody.userMessage.id);
    expect(replayBody.assistantMessage.id).toBe(firstBody.assistantMessage.id);
    expect(calls.filter((input) => input.purpose === "chat_turn")).toHaveLength(
      1,
    );
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleAfterFirst,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual(negotiationsAfterFirst);
    expect(app.personasim.store.listDomainEvents(character.id, 100)).toEqual(
      eventsAfterFirst,
    );
    expect(app.personasim.store.listMessages(sessionId)).toEqual(
      messagesAfterFirst,
    );

    const conflictResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      "还是改成明早八点吧",
    );
    expect(conflictResponse.statusCode).toBe(409);
    expect(
      jsonBody<{ error: { code: string } }>(conflictResponse).error.code,
    ).toBe("idempotency_key_reused");
    expect(calls.filter((input) => input.purpose === "chat_turn")).toHaveLength(
      1,
    );
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleAfterFirst,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual(negotiationsAfterFirst);
    expect(app.personasim.store.listDomainEvents(character.id, 100)).toEqual(
      eventsAfterFirst,
    );
    expect(app.personasim.store.listMessages(sessionId)).toEqual(
      messagesAfterFirst,
    );
  });

  it("keeps HTTP, projection, audit events and SSE notifications aligned", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "好。",
      scheduleAction: acceptUserOffer(),
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const publish = vi.spyOn(app.personasim.sse, "publish");
    const clientMessageId = "negotiation-observable-commit";

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      DIRECT_AGREEMENT,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    const created = body.scheduleChanges[0]!;
    expect(app.personasim.store.getScheduleItem(created.id)).toEqual(created);
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      "message.created",
      "schedule.updated",
    ]);
    expect(publish.mock.calls[0]?.[0].data).toEqual(body.assistantMessage);
    expect(publish.mock.calls[1]?.[0].data).toEqual(body.scheduleChanges);

    const events = app.personasim.store
      .listDomainEvents(character.id, 100)
      .filter((event) => event.correlationId === clientMessageId);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      "conversation.turn_committed",
      "schedule.command_committed",
      "schedule.negotiation_offer_accepted",
    ]);
    expect(
      events.every(
        (event) =>
          event.correlationId === clientMessageId &&
          event.causationId === body.userMessage.id,
      ),
    ).toBe(true);
    const negotiationEvent = events.find(
      (event) => event.eventType === "schedule.negotiation_offer_accepted",
    )!;
    const commandEvent = events.find(
      (event) => event.eventType === "schedule.command_committed",
    )!;
    const turnEvent = events.find(
      (event) => event.eventType === "conversation.turn_committed",
    )!;
    const negotiationPayload = negotiationEvent.payload as {
      negotiationId: string;
      offerVersion: number;
    };
    expect(commandEvent.payload).toMatchObject({
      negotiationId: negotiationPayload.negotiationId,
      offerVersion: negotiationPayload.offerVersion,
      changedItemIds: [created.id],
    });
    expect(turnEvent.payload).toMatchObject({
      userMessageId: body.userMessage.id,
      assistantMessageId: body.assistantMessage.id,
      scheduleItemIds: [created.id],
    });
  });

  it("rolls back messages, negotiation and schedule when command audit insertion fails", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "好。",
      scheduleAction: acceptUserOffer(),
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);
    const messagesBefore = app.personasim.store.listMessages(sessionId);
    const eventsBefore = app.personasim.store.listDomainEvents(
      character.id,
      100,
    );
    const publish = vi.spyOn(app.personasim.sse, "publish");
    const insertDomainEvent = app.personasim.store.insertDomainEvent.bind(
      app.personasim.store,
    );
    vi.spyOn(app.personasim.store, "insertDomainEvent").mockImplementation(
      (event) =>
        event.eventType === "schedule.command_committed"
          ? false
          : insertDomainEvent(event),
    );

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "negotiation-command-audit-failure",
      DIRECT_AGREEMENT,
    );

    expect(response.statusCode).toBe(500);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(app.personasim.store.listMessages(sessionId)).toEqual(
      messagesBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(app.personasim.store.listDomainEvents(character.id, 100)).toEqual(
      eventsBefore,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("revalidates against the latest schedule inside the commit transaction", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    let agentId = "";
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        calls.push(input);
        if (input.purpose === "chat_turn") {
          return Promise.resolve({
            text: "明早我去不了。",
            scheduleAction: acceptUserOffer(),
          } as never);
        }
        if (input.purpose === "repair_chat_turn") {
          app!.personasim.store.insertScheduleItem({
            id: "schedule-concurrent-fixed-conflict",
            agentId,
            title: "并发写入的固定安排",
            description: "模拟模型生成与事务提交之间出现的新冲突。",
            category: "work",
            startAtUtc: RUN_START_UTC,
            endAtUtc: RUN_END_UTC,
            timezone: "Asia/Shanghai",
            rigidity: "fixed",
            priority: 1,
            source: "manual",
            adherenceProbability: 1,
            narrativeImportance: 0.5,
            shareable: false,
            stateEffects: {},
            status: "planned",
            revision: 1,
            createdAtUtc: START_UTC,
            updatedAtUtc: START_UTC,
          });
          return Promise.resolve({ text: "我先重新确认一下时间。" } as never);
        }
        if (input.fixture !== undefined) {
          return Promise.resolve(input.fixture as never);
        }
        return Promise.reject(new Error(`No fixture for ${input.purpose}`));
      },
    );
    const character = await createAndPublishHighFidelity(app);
    agentId = character.id;
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const messagesBefore = app.personasim.store.listMessages(sessionId);
    const clientMessageId = "schedule-changed-before-commit";

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      DIRECT_AGREEMENT,
    );

    expect(response.statusCode).toBe(409);
    expect(jsonBody<{ error: { code: string } }>(response).error.code).toBe(
      "schedule_changed_during_negotiation",
    );
    expect(app.personasim.store.listMessages(sessionId)).toEqual(
      messagesBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(
      app.personasim.store.getScheduleItem(
        "schedule-concurrent-fixed-conflict",
      ),
    ).toBeDefined();
    expect(
      app.personasim.store
        .listSchedule(character.id)
        .filter((item) => item.title === "和用户跑步"),
    ).toEqual([]);
    expect(
      app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.correlationId === clientMessageId),
    ).toEqual([]);
  });

  it("does not let the same affirmative reply authorize a missing action", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "好。",
      scheduleAction: { kind: "none" },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "same-text-no-action",
      DIRECT_AGREEMENT,
    );

    expect(response.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(
      app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed"),
    ).toEqual([]);
  });

  it.each([
    {
      label: "different activity in the same category",
      action: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起健身",
          category: "exercise",
          startAt: "明天 07:00",
          evidenceQuotes: ["明天早上七点一起跑半小时"],
        },
      },
      reasonCode: "activity_not_grounded",
    },
    {
      label: "model-invented duration",
      action: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起跑步",
          category: "exercise",
          startAt: "明天 07:00",
          durationMinutes: 120,
          evidenceQuotes: ["明天早上七点一起跑半小时"],
        },
      },
      reasonCode: "duration_not_grounded",
    },
    {
      label: "non-verbatim evidence with appended time",
      action: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起跑步",
          category: "exercise",
          startAt: "后天 09:00",
          evidenceQuotes: ["明天早上七点一起跑半小时，改成后天九点也可以"],
        },
      },
      reasonCode: "ungrounded_negotiation_offer",
    },
  ] as const)(
    "rejects $label even when the reply text is affirmative",
    async ({ action, reasonCode }) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, () => ({
        text: "好。",
        scheduleAction: action,
      }));
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        `rejected-${reasonCode}`,
        DIRECT_AGREEMENT,
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).not.toBe("好。");
      expect(body.assistantMessage.metadata).toMatchObject({
        decisionPath: "fallback",
        repairAttempted: true,
        rejectedProposalCount: 1,
      });
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.listScheduleNegotiations({ sessionId }),
      ).toEqual([]);
      expect(
        app.personasim.store.listRejectedProposals(character.id, 20),
      ).toEqual([
        expect.objectContaining({
          sessionId,
          reasonCode,
        }),
      ]);
    },
  );

  it("repairs a recorded-agreement reply when the structured action is none", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        calls.push(input);
        if (input.purpose === "chat_turn") {
          expect(input.prompt).toContain("SCHEDULE_NEGOTIATION_CONTRACT");
          return Promise.resolve({
            text: "好，我记下了",
            scheduleAction: { kind: "none" },
          } as never);
        }
        if (input.purpose === "repair_chat_turn") {
          return Promise.resolve({ text: "好，我还是记下了" } as never);
        }
        if (input.fixture !== undefined) {
          return Promise.resolve(input.fixture as never);
        }
        return Promise.reject(new Error(`No fixture for ${input.purpose}`));
      },
    );

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "reply-cannot-authorize-schedule",
      DIRECT_AGREEMENT,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(body.assistantMessage.content).not.toContain("记下了");
    expect(body.assistantMessage.metadata).toMatchObject({
      decisionPath: "fallback",
      repairAttempted: true,
      rejectedProposalCount: 0,
    });
    expect(body.decision.reasonCode).toBe("persona_chat_fallback");
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(
      app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed"),
    ).toEqual([]);
  });

  it("persists one proposed offer and commits that exact version from a short confirmation", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const actions: ScheduleNegotiationAction[] = [];
    let turn = 0;
    mockLlm(app.personasim.llm, calls, (input) => {
      turn += 1;
      expect(input.prompt).toContain("SCHEDULE_NEGOTIATION_CONTRACT");
      if (turn === 1) {
        const action: ScheduleNegotiationAction = {
          kind: "propose_offer",
          offer: {
            activity: "一起跑步",
            category: "exercise",
            startAt: "明天 07:00",
            durationMinutes: 30,
            evidenceQuotes: ["陪我跑步"],
          },
        };
        actions.push(action);
        return {
          text: "我建议明早七点跑半小时，你看可以吗？",
          scheduleAction: action,
        };
      }

      expect(input.prompt).toContain('"offerVersion":1');
      expect(input.prompt).toContain('"startLocal":"2026-08-17 07:00"');
      const action: ScheduleNegotiationAction = {
        kind: "accept_pending_offer",
        evidenceQuotes: ["👌"],
      };
      actions.push(action);
      return { text: "行。", scheduleAction: action };
    });

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const proposalResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      "negotiated-proposal",
      "明早可以陪我跑步吗？",
    );
    expect(proposalResponse.statusCode).toBe(201);
    const proposalBody = jsonBody<ChatTurnResult>(proposalResponse);
    expect(proposalBody.scheduleChanges).toEqual([]);
    expect(proposalBody.assistantMessage.content).toContain(
      "【待确认日程】2026-08-17 07:00，跑步，30 分钟",
    );
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );

    const pending =
      app.personasim.store.getActiveScheduleNegotiation(sessionId);
    expect(pending).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    const pendingState = readNegotiationState(pending!);
    expect(pendingState).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
      offer: {
        version: 1,
        category: "exercise",
        startAtUtc: RUN_START_UTC,
        durationMinutes: 30,
      },
    });

    const confirmationResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      "negotiated-confirmation",
      "👌",
    );
    expect(confirmationResponse.statusCode).toBe(201);
    const confirmationBody = jsonBody<ChatTurnResult>(confirmationResponse);
    expect(confirmationBody.scheduleChanges).toHaveLength(1);
    expect(confirmationBody.scheduleChanges[0]).toMatchObject({
      category: "exercise",
      startAtUtc: RUN_START_UTC,
      endAtUtc: RUN_END_UTC,
    });
    expect(app.personasim.store.getActiveScheduleNegotiation(sessionId)).toBe(
      undefined,
    );

    const committed = app.personasim.store.getScheduleNegotiationById(
      pending!.id,
    );
    expect(committed).toMatchObject({
      status: "committed",
      offerVersion: 1,
    });
    const committedState = readNegotiationState(committed!);
    expect(committedState.offer).toEqual(pendingState.offer);
    expect(committedState).toMatchObject({
      status: "committed",
      offerVersion: 1,
    });

    expect(actions).toHaveLength(2);
    expect(actions[1]).toEqual({
      kind: "accept_pending_offer",
      evidenceQuotes: ["👌"],
    });
    expect(Object.keys(actions[1]!)).toEqual(["kind", "evidenceQuotes"]);
    expect(calls.filter((input) => input.purpose === "chat_turn")).toHaveLength(
      2,
    );
  });

  it("retains the canonical pending-offer display after repairing the natural reply", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        calls.push(input);
        if (input.purpose === "chat_turn") {
          return Promise.resolve({
            text: "好，我记下了。",
            scheduleAction: {
              kind: "propose_offer",
              offer: {
                activity: "一起跑步",
                category: "exercise",
                startAt: "明天 07:00",
                durationMinutes: 30,
                evidenceQuotes: ["陪我跑步"],
              },
            },
          } as never);
        }
        if (input.purpose === "repair_chat_turn") {
          return Promise.resolve({ text: "我先把具体方案说清楚。" } as never);
        }
        if (input.fixture !== undefined) {
          return Promise.resolve(input.fixture as never);
        }
        return Promise.reject(new Error(`No fixture for ${input.purpose}`));
      },
    );
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "proposal-display-survives-repair",
      "明早陪我跑步吗？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.content).not.toContain("记下了");
    expect(body.assistantMessage.content).toContain(
      "【待确认日程】2026-08-17 07:00，跑步，30 分钟",
    );
    expect(body.assistantMessage.metadata).toMatchObject({
      repairAttempted: true,
      decisionPath: "reply_only",
    });
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
  });

  it("does not let fixture reply keywords bypass the enforced writer", async () => {
    app = (
      await createNegotiationTestApp({
        provider: "fixture",
      })
    ).app;
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-enforced-no-legacy-writer",
      "今晚要不要一起参加学校的晚会？",
    );

    expect(response.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(
      app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed"),
    ).toEqual([]);
  });

  it("treats chat effects off as a hard stop for fixture schedule writes", async () => {
    app = (
      await createNegotiationTestApp({
        provider: "fixture",
        mode: "legacy",
        chatEffectsMode: "off",
      })
    ).app;
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-off-no-schedule-writer",
      "今晚要不要一起参加学校的晚会？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.metadata).toMatchObject({
      decisionPath: "reply_only",
    });
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
  });

  it("preserves the legacy writer when shadow mode is selected", async () => {
    app = (
      await createNegotiationTestApp({
        provider: "fixture",
        mode: "shadow",
      })
    ).app;
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-shadow-keeps-legacy-writer",
      "今晚要不要一起参加学校的晚会？",
    );

    expect(response.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toHaveLength(2);
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
  });

  it("resumes and commits the exact pending offer after a file-database restart", async () => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), "personasim-negotiation-restart-"),
    );
    const databasePath = join(temporaryDirectory, "personasim.sqlite");
    const clock = new FakeClock(START_UTC);
    app = (await createNegotiationTestApp({ databasePath, clock })).app;
    const firstCalls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, firstCalls, () => ({
      text: "我提议明早七点跑半小时，你愿意吗？",
      scheduleAction: {
        kind: "propose_offer",
        offer: {
          activity: "一起跑步",
          category: "exercise",
          startAt: "明天 07:00",
          durationMinutes: 30,
          evidenceQuotes: ["陪我跑步"],
        },
      },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const proposal = await sendMessage(
      app,
      sessionId,
      character.id,
      "restart-proposal",
      "明早陪我跑步吗？",
    );
    expect(proposal.statusCode).toBe(201);
    const proposalBody = jsonBody<ChatTurnResult>(proposal);
    expect(proposalBody.scheduleChanges).toEqual([]);
    expect(proposalBody.assistantMessage.content).toContain(
      "【待确认日程】2026-08-17 07:00，跑步，30 分钟",
    );
    const pending =
      app.personasim.store.getActiveScheduleNegotiation(sessionId);
    expect(pending).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    const pendingState = readNegotiationState(pending!);
    const pendingOffer = pendingState.offer;
    expect(pendingOffer).toMatchObject({
      version: 1,
      startAtUtc: RUN_START_UTC,
      durationMinutes: 30,
    });

    await app.close();
    app = undefined;
    vi.restoreAllMocks();

    app = (await createNegotiationTestApp({ databasePath, clock })).app;
    const secondCalls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, secondCalls, (input) => {
      expect(input.prompt).toContain('"offerVersion":1');
      expect(input.prompt).toContain('"startLocal":"2026-08-17 07:00"');
      return {
        text: "好。",
        scheduleAction: {
          kind: "accept_pending_offer",
          evidenceQuotes: ["👌"],
        },
      };
    });

    const confirmation = await sendMessage(
      app,
      sessionId,
      character.id,
      "restart-confirmation",
      "👌",
    );
    expect(confirmation.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(confirmation);
    expect(body.scheduleChanges).toHaveLength(1);
    expect(body.scheduleChanges[0]).toMatchObject({
      startAtUtc: RUN_START_UTC,
      endAtUtc: RUN_END_UTC,
      category: "exercise",
    });
    expect(app.personasim.store.listSchedule(character.id)).toHaveLength(
      scheduleBefore.length + 1,
    );
    const committed = app.personasim.store.getScheduleNegotiationById(
      pending!.id,
    );
    expect(committed).toMatchObject({
      id: pending!.id,
      status: "committed",
      offerVersion: 1,
    });
    expect(readNegotiationState(committed!).offer).toEqual(pendingOffer);
    expect(
      app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed"),
    ).toHaveLength(1);
    expect(secondCalls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });
});

function acceptUserOffer(): ScheduleNegotiationAction {
  return {
    kind: "accept_user_offer",
    offer: {
      activity: "一起跑步",
      category: "exercise",
      startAt: "明天 07:00",
      evidenceQuotes: ["明天早上七点一起跑半小时"],
    },
  };
}

function readNegotiationState(negotiation: StoredScheduleNegotiation): {
  status: string;
  offerVersion: number;
  offer?: {
    version: number;
    category: string;
    startAtUtc: string;
    durationMinutes: number;
  };
} {
  return negotiation.record["negotiation"] as {
    status: string;
    offerVersion: number;
    offer?: {
      version: number;
      category: string;
      startAtUtc: string;
      durationMinutes: number;
    };
  };
}

function mockLlm(
  llm: LlmService,
  calls: Array<GenerateObjectInput<unknown>>,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) => {
    calls.push(input);
    if (input.purpose !== "chat_turn") {
      if (input.fixture === undefined) {
        return Promise.reject(
          new Error(`No fixture for purpose ${input.purpose}`),
        );
      }
      return Promise.resolve(input.fixture as never);
    }
    return Promise.resolve(responder(input) as never);
  });
}

async function createNegotiationTestApp(
  options: {
    databasePath?: string;
    clock?: FakeClock;
    provider?: "fixture" | "openai-compatible";
    mode?: "legacy" | "shadow" | "enforced";
    chatEffectsMode?: "off" | "gated";
  } = {},
): Promise<{
  app: PersonaSimApp;
  clock: FakeClock;
}> {
  const clock = options.clock ?? new FakeClock(START_UTC);
  const databasePath = options.databasePath ?? ":memory:";
  const provider = options.provider ?? "openai-compatible";
  const config = readConfig({
    nodeEnv: "test",
    databasePath,
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: options.chatEffectsMode ?? "gated",
    scheduleNegotiationMode: options.mode ?? "enforced",
    llm: {
      provider,
      baseUrl: "https://example.invalid",
      apiKey: "test-api-key",
      model:
        provider === "fixture" ? "personasim-fixture-v1" : "test-live-model",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  const app = await buildApp({
    config,
    database: openDatabase(databasePath),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  return { app, clock };
}

async function createAndPublishHighFidelity(
  app: PersonaSimApp,
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "林夏",
      worldSetting: "当代城市生活",
      workOrRole: "研究生与独立插画师",
      coreTraits: ["认真", "有主见", "温暖"],
      centralContradiction: "既重视创作计划，也珍惜重要关系",
      primaryGoal: "完成毕业作品",
      relationshipToUser: "熟悉的朋友",
      dialogueStyle: "自然、简洁、偶尔冷幽默",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode).toBe(201);
  const draft = jsonBody<{ character: { id: string; version: number } }>(
    generated,
  ).character;
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode).toBe(200);
  return jsonBody<{ character: { id: string; version: number } }>(published)
    .character;
}

async function createSession(
  app: PersonaSimApp,
  agentId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/sessions`,
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return jsonBody<{ session: { id: string } }>(response).session.id;
}

function sendMessage(
  app: PersonaSimApp,
  sessionId: string,
  agentId: string,
  clientMessageId: string,
  text: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    payload: { agentId, clientMessageId, text },
  });
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
