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
const EARLY_MORNING_UTC = "2026-08-16T21:59:39.371Z"; // 05:59 Asia/Shanghai
const NEXT_MORNING_RUN_START_UTC = "2026-08-17T23:00:00.000Z";
const NEXT_MORNING_RUN_END_UTC = "2026-08-17T23:30:00.000Z";
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
    "presents and later commits the same direct user offer independently of reply wording: %s",
    async (replyText) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let turn = 0;
      mockLlm(app.personasim.llm, calls, (input) => {
        expect(input.prompt).toContain("SCHEDULE_NEGOTIATION_CONTRACT");
        expect(input.prompt).not.toContain("SCHEDULE_EFFECTS_CONTRACT");
        turn += 1;
        const decision = {
          text: turn === 1 ? replyText : "好。",
          scheduleAction: turn === 1 ? acceptUserOffer() : acceptPendingOffer(),
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
      expect(body.scheduleChanges).toEqual([]);
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(body.assistantMessage.content).toContain(
        "【待确认日程】2026-08-17 07:00，跑步，30 分钟",
      );
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });

      const confirmation = await sendMessage(
        app,
        sessionId,
        character.id,
        `direct-confirmation-${ACCEPTED_REPLY_VARIANTS.indexOf(replyText)}`,
        "没问题",
      );
      expect(confirmation.statusCode).toBe(201);
      const confirmationBody = jsonBody<ChatTurnResult>(confirmation);
      expect(confirmationBody.scheduleChanges).toHaveLength(1);
      const created = confirmationBody.scheduleChanges[0]!;
      expect(created).toMatchObject({
        category: "exercise",
        status: "planned",
        rigidity: "committed",
        source: "user_invitation",
        startAtUtc: RUN_START_UTC,
        endAtUtc: RUN_END_UTC,
      });
      expect(confirmationBody.assistantMessage.metadata).toMatchObject({
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
      ).toHaveLength(2);
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
    let turn = 0;
    mockLlm(app.personasim.llm, calls, () => {
      turn += 1;
      return {
        text: "好。",
        scheduleAction:
          turn === 1
            ? { kind: "accept_user_offer", offer }
            : acceptPendingOffer(),
      };
    });
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
    const offeredBody = jsonBody<ChatTurnResult>(response);
    expect(offeredBody.scheduleChanges).toEqual([]);
    const pending =
      app.personasim.store.getActiveScheduleNegotiation(sessionId);
    expect(readNegotiationState(pending!)).toMatchObject({
      status: "awaiting_confirmation",
      offer: {
        startAtUtc,
        durationMinutes:
          (Date.parse(endAtUtc) - Date.parse(startAtUtc)) / 60_000,
      },
    });

    const confirmation = await sendMessage(
      app,
      sessionId,
      character.id,
      `duration-confirmation-${offer.durationMinutes ?? "default"}`,
      "没问题",
    );
    expect(confirmation.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(confirmation);
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
    let turn = 0;
    mockLlm(app.personasim.llm, calls, () => {
      turn += 1;
      return {
        text: "好。",
        scheduleAction:
          turn === 1
            ? {
                kind: "accept_user_offer",
                offer: {
                  activity: "一起跑步",
                  category: "exercise",
                  startAt: "今晚十二点半",
                  durationMinutes: 30,
                  evidenceQuotes: ["今晚十二点半一起跑半小时"],
                },
              }
            : acceptPendingOffer(),
      };
    });
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
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toEqual([]);
    expect(
      readNegotiationState(
        app.personasim.store.getActiveScheduleNegotiation(sessionId)!,
      ).offer,
    ).toMatchObject({
      startAtUtc: "2026-08-16T16:30:00.000Z",
      durationMinutes: 30,
    });

    const confirmation = await sendMessage(
      app,
      sessionId,
      character.id,
      "midnight-confirmation",
      "没问题",
    );
    expect(confirmation.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(confirmation).scheduleChanges).toEqual([
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
    let turn = 0;
    mockLlm(app.personasim.llm, calls, () => {
      turn += 1;
      return {
        text: "Okay.",
        scheduleAction:
          turn === 1
            ? {
                kind: "accept_user_offer",
                offer: {
                  activity: "meet",
                  category: "social",
                  startAt: "tomorrow at 3 pm",
                  evidenceQuotes: ["meet tomorrow at 3 pm for one hour"],
                },
              }
            : acceptPendingOffer("yes"),
      };
    });
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
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toEqual([]);

    const confirmation = await sendMessage(
      app,
      sessionId,
      character.id,
      "english-word-confirmation",
      "yes",
    );
    expect(confirmation.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(confirmation).scheduleChanges).toEqual([
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
    let turn = 0;
    mockLlm(app.personasim.llm, calls, (input) => {
      expect(input.prompt).toContain("SCHEDULE_NEGOTIATION_CONTRACT");
      turn += 1;
      return {
        text: "好，明早见。",
        scheduleAction: turn === 1 ? acceptUserOffer() : acceptPendingOffer(),
      };
    });

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const clientMessageId = "idempotent-negotiated-command";

    const proposalResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      "idempotent-negotiated-proposal",
      DIRECT_AGREEMENT,
    );
    expect(proposalResponse.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(proposalResponse).scheduleChanges).toEqual(
      [],
    );

    const firstResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      "没问题",
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
      2,
    );

    const replayResponse = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      "没问题",
    );
    expect(replayResponse.statusCode).toBe(200);
    const replayBody = jsonBody<ChatTurnResult>(replayResponse);
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.scheduleChanges).toEqual([]);
    expect(replayBody.userMessage.id).toBe(firstBody.userMessage.id);
    expect(replayBody.assistantMessage.id).toBe(firstBody.assistantMessage.id);
    expect(calls.filter((input) => input.purpose === "chat_turn")).toHaveLength(
      2,
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
      2,
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
    let turn = 0;
    mockLlm(app.personasim.llm, calls, () => {
      turn += 1;
      return {
        text: "好。",
        scheduleAction: turn === 1 ? acceptUserOffer() : acceptPendingOffer(),
      };
    });
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const proposal = await sendMessage(
      app,
      sessionId,
      character.id,
      "negotiation-observable-proposal",
      DIRECT_AGREEMENT,
    );
    expect(proposal.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(proposal).scheduleChanges).toEqual([]);
    const publish = vi.spyOn(app.personasim.sse, "publish");
    const clientMessageId = "negotiation-observable-commit";

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      "没问题",
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
      "conversation.world_effects_shadow_evaluated",
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
    let turn = 0;
    mockLlm(app.personasim.llm, calls, () => {
      turn += 1;
      return {
        text: "好。",
        scheduleAction: turn === 1 ? acceptUserOffer() : acceptPendingOffer(),
      };
    });
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const proposal = await sendMessage(
      app,
      sessionId,
      character.id,
      "negotiation-command-audit-proposal",
      DIRECT_AGREEMENT,
    );
    expect(proposal.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(proposal).scheduleChanges).toEqual([]);
    const scheduleBefore = app.personasim.store.listSchedule(character.id);
    const messagesBefore = app.personasim.store.listMessages(sessionId);
    const negotiationsBefore = app.personasim.store.listScheduleNegotiations({
      sessionId,
    });
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
      "没问题",
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
    ).toEqual(negotiationsBefore);
    expect(app.personasim.store.listDomainEvents(character.id, 100)).toEqual(
      eventsBefore,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("revalidates against the latest schedule inside the commit transaction", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    let chatTurn = 0;
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        calls.push(input);
        if (input.purpose === "chat_turn") {
          chatTurn += 1;
          return Promise.resolve(
            canonicalChatEnvelopeFixture({
              text: chatTurn === 1 ? "我先列出来请你确认。" : "明早我去不了。",
              scheduleAction:
                chatTurn === 1 ? acceptUserOffer() : acceptPendingOffer(),
            }) as never,
          );
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
    const proposal = await sendMessage(
      app,
      sessionId,
      character.id,
      "schedule-changed-proposal",
      DIRECT_AGREEMENT,
    );
    expect(proposal.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(proposal).scheduleChanges).toEqual([]);
    const pendingBefore = app.personasim.store.listScheduleNegotiations({
      sessionId,
    });
    const messagesBefore = app.personasim.store.listMessages(sessionId);
    const clientMessageId = "schedule-changed-before-commit";
    const originalTransaction = app.personasim.store.transaction.bind(
      app.personasim.store,
    );
    let injectConcurrentConflict = true;
    vi.spyOn(app.personasim.store, "transaction").mockImplementation((work) => {
      if (injectConcurrentConflict) {
        injectConcurrentConflict = false;
        app!.personasim.store.insertScheduleItem({
          id: "schedule-concurrent-fixed-conflict",
          agentId: character.id,
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
      }
      return originalTransaction(work);
    });

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      "没问题",
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
    ).toEqual(pendingBefore);
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

  it("keeps ordinary future-oriented memory text as a no-op when scheduleAction is none", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const modelReply =
      "记住了，你答辩后更想安静复盘，不参加庆功宴。\n" +
      "我之后会按这个偏好陪你聊。";
    mockLlm(app.personasim.llm, calls, () => ({
      text: modelReply,
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
      "ordinary-memory-no-schedule",
      "答辩结束后我不参加庆功宴，我更想找个安静的地方复盘。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe(modelReply);
    expect(body.assistantMessage.content).not.toContain("【未修改日程】");
    expect(body.assistantMessage.metadata.reasonCode).not.toBe(
      "unsupported_schedule_operation",
    );
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });

  it("preserves a model readback of an authoritative committed schedule over a real HTTP turn", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const modelReply =
      "我们已经确认了明天 11:30 在北岸书店喝茶，时长 45 分钟。";
    mockLlm(app.personasim.llm, calls, () => ({
      text: modelReply,
      scheduleAction: { kind: "none" },
    }));
    const character = await createAndPublishHighFidelity(app);
    insertCommittedTeaSchedule(app, character.id);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);
    const negotiationCountBefore =
      app.personasim.store.listScheduleNegotiations({
        agentId: character.id,
      }).length;
    const commandCountBefore = countScheduleCommandEvents(app, character.id);

    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(
      new URL(`/api/sessions/${sessionId}/messages`, origin),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: character.id,
          clientMessageId: "authoritative-readback-http",
          text: "我们刚确认的共同安排是什么？请告诉我具体时间和地点。",
        }),
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as ChatTurnResult;
    expect(body.assistantMessage.content).toBe(modelReply);
    expect(body.assistantMessage.content).not.toContain("【未修改日程】");
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({
        agentId: character.id,
      }),
    ).toHaveLength(negotiationCountBefore);
    expect(countScheduleCommandEvents(app, character.id)).toBe(
      commandCountBefore,
    );
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });

  it("does not authorize a readback when the only committed invitation is beyond 72 hours", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const modelReply =
      "我们已经确认了 8 月 20 日 11:30 在北岸书店喝茶，时长 45 分钟。";
    mockLlm(app.personasim.llm, calls, () => ({
      text: modelReply,
      scheduleAction: { kind: "none" },
    }));
    const character = await createAndPublishHighFidelity(app);
    app.personasim.store.insertScheduleItem({
      id: "schedule-distant-authoritative-readback-tea",
      agentId: character.id,
      title: "和用户在北岸书店喝茶",
      description: "72 小时窗口之外的已确认共同安排。",
      category: "social",
      startAtUtc: "2026-08-20T03:30:00.000Z",
      endAtUtc: "2026-08-20T04:15:00.000Z",
      timezone: "Asia/Shanghai",
      rigidity: "committed",
      priority: 0.9,
      source: "user_invitation",
      adherenceProbability: 1,
      narrativeImportance: 0.9,
      shareable: true,
      stateEffects: {},
      status: "planned",
      revision: 1,
      createdAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
    });
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);
    const negotiationCountBefore =
      app.personasim.store.listScheduleNegotiations({
        agentId: character.id,
      }).length;
    const commandCountBefore = countScheduleCommandEvents(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "distant-authoritative-readback",
      "我们已经确认的共同安排是什么？请告诉我具体时间和地点。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("【未修改日程】");
    expect(body.assistantMessage.content).not.toContain(modelReply);
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({
        agentId: character.id,
      }),
    ).toHaveLength(negotiationCountBefore);
    expect(countScheduleCommandEvents(app, character.id)).toBe(
      commandCountBefore,
    );
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });

  it("still replaces an explicit schedule write claim during an authoritative readback", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const modelReply =
      "我们已经确认了明天 11:30 在北岸书店喝茶，我也刚把它写入日程了。";
    mockLlm(app.personasim.llm, calls, () => ({
      text: modelReply,
      scheduleAction: { kind: "none" },
    }));
    const character = await createAndPublishHighFidelity(app);
    insertCommittedTeaSchedule(app, character.id);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);
    const negotiationCountBefore =
      app.personasim.store.listScheduleNegotiations({
        agentId: character.id,
      }).length;
    const commandCountBefore = countScheduleCommandEvents(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "authoritative-readback-false-write",
      "我们刚确认的共同安排是什么？请告诉我具体时间和地点。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("【未修改日程】");
    expect(body.assistantMessage.content).not.toContain(modelReply);
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({
        agentId: character.id,
      }),
    ).toHaveLength(negotiationCountBefore);
    expect(countScheduleCommandEvents(app, character.id)).toBe(
      commandCountBefore,
    );
  });

  it("rejects a schedule commitment memory when action none commits no command", async () => {
    app = (await createNegotiationTestApp({ liveWorldEffectsMode: "enforced" }))
      .app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "我没有修改日程。",
      scheduleAction: { kind: "none" },
      worldEffects: {
        memoryCandidates: [
          {
            type: "commitment",
            content: "明天 11:30 和用户在北岸书店喝茶。",
            importance: 0.9,
            confidence: 0.95,
            tags: ["共同安排"],
          },
        ],
      },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);
    const commitmentCountBefore = countCommitmentMemories(app, character.id);
    const commandCountBefore = countScheduleCommandEvents(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "schedule-commitment-with-none",
      "我们明天 11:30 一起去北岸书店喝茶，可以吗？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.metadata).toMatchObject({
      rejectedProposalCount: 1,
      decisionPath: "effects_rejected",
    });
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(countScheduleCommandEvents(app, character.id)).toBe(
      commandCountBefore,
    );
    expect(countCommitmentMemories(app, character.id)).toBe(
      commitmentCountBefore,
    );
    expect(
      app.personasim.store.listRejectedProposals(character.id, 20),
    ).toEqual([
      expect.objectContaining({
        reasonCode: "uncommitted_schedule_commitment",
      }),
    ]);
  });

  it("retains a non-schedule commitment memory when action none is appropriate", async () => {
    app = (await createNegotiationTestApp({ liveWorldEffectsMode: "enforced" }))
      .app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const commitment = "用户承诺在论文完成后把最终稿发给角色。";
    mockLlm(app.personasim.llm, calls, () => ({
      text: "我会记住这个承诺。",
      scheduleAction: { kind: "none" },
      worldEffects: {
        memoryCandidates: [
          {
            type: "commitment",
            content: commitment,
            importance: 0.8,
            confidence: 0.95,
            tags: ["论文承诺"],
          },
        ],
      },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const commitmentCountBefore = countCommitmentMemories(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "ordinary-non-schedule-commitment",
      "我会在论文完成后把最终稿发给你，请记住这个承诺。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.content).toBe("我会记住这个承诺。");
    expect(body.assistantMessage.metadata).toMatchObject({
      rejectedProposalCount: 0,
      decisionPath: "reply_only",
    });
    expect(countCommitmentMemories(app, character.id)).toBe(
      commitmentCountBefore + 1,
    );
    const stored = app.personasim.store.database
      .prepare(
        "SELECT content FROM memories WHERE agent_id = ? AND type = 'commitment' ORDER BY created_at_utc DESC LIMIT 1",
      )
      .get(character.id) as { content: string } | undefined;
    expect(stored?.content).toBe(commitment);
    expect(
      app.personasim.store.listRejectedProposals(character.id, 20),
    ).toEqual([]);
  });

  it("creates only a pending offer from an explicit structured acceptance", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const invitation =
      "这是一个明确的共同邀约：我想在2026年08月17日 11:30和你一起去梧桐路 23 号的“北岸书店”喝茶，预计 45 分钟。你愿意吗？如果愿意，请先把它作为待我确认的共同安排，不要声称已经写入日程。";
    mockLlm(app.personasim.llm, calls, () => ({
      text: "很乐意。2026年8月17日11:30一起去北岸书店喝茶，算作待你确认的共同安排。",
      scheduleAction: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起去北岸书店喝茶",
          category: "social",
          startAt: "2026年08月17日 11:30",
          durationMinutes: 45,
          evidenceQuotes: [invitation],
        },
      },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "grounded-tea-invitation-acceptance",
      invitation,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(body.assistantMessage.metadata["scheduleActionAudit"]).toEqual({
      origin: "model_explicit_valid",
      kind: "accept_user_offer",
    });
    expect(body.assistantMessage.content).toContain("【待确认日程】");
    expect(body.assistantMessage.content).not.toContain("已经确认");
    const pending =
      app.personasim.store.getActiveScheduleNegotiation(sessionId);
    expect(pending).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    expect(readNegotiationState(pending!).offer).toMatchObject({
      activity: "北岸书店喝茶",
      startAtUtc: "2026-08-17T03:30:00.000Z",
      durationMinutes: 45,
    });
    expect(
      app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed"),
    ).toEqual([]);
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });

  it("does not infer an enforced schedule acceptance from prose when the structured action is none", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "我很乐意，先把这次喝茶作为待你确认的共同安排。",
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
      "prose-only-tea-acceptance",
      "我想在2026年08月17日 11:30和你一起去“北岸书店”喝茶，预计 45 分钟。你愿意吗？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.content).not.toContain("【待确认日程】");
    expect(body.assistantMessage.metadata["scheduleActionAudit"]).toEqual({
      origin: "model_explicit_valid",
      kind: "none",
    });
    expect(app.personasim.store.listSchedule(character.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    expect(
      app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter(
          (event) =>
            event.eventType === "schedule.negotiation_offer_presented" ||
            event.eventType === "schedule.command_committed",
        ),
    ).toEqual([]);
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });

  it.each([
    {
      label: "missing",
      output: {
        text: "我很乐意，先把它作为待确认安排。",
      },
    },
    {
      label: "invalid",
      output: {
        text: "我很乐意，先把它作为待确认安排。",
        scheduleAction: { kind: "accept_user_offer" },
      },
    },
    {
      label: "misplaced under worldEffects",
      output: {
        replyDecision: {
          text: "我很乐意，先把它作为待确认安排。",
        },
        worldEffects: {
          scheduleAction: {
            kind: "accept_user_offer",
            offer: {
              activity: "北岸书店喝茶",
              category: "social",
              startAt: "2026年08月17日 11:30",
              evidenceQuotes: ["2026年08月17日 11:30去北岸书店喝茶"],
            },
          },
        },
      },
    },
  ] as const)(
    "fails closed when an enforced provider scheduleAction is $label",
    async ({ label, output }) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, () => output);
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        `invalid-enforced-action-${label.replaceAll(" ", "-")}`,
        "我想在2026年08月17日 11:30和你一起去“北岸书店”喝茶，预计45分钟。你愿意吗？",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).not.toContain("【待确认日程】");
      expect(body.assistantMessage.metadata["scheduleActionAudit"]).toEqual({
        origin: "model_unavailable",
        kind: "none",
      });
      expect(
        app.personasim.store.listScheduleNegotiations({ sessionId }),
      ).toEqual([]);
      const chatCall = calls.find((call) => call.purpose === "chat_turn");
      expect(
        chatCall?.schema.safeParse(canonicalChatEnvelopeFixture(output))
          .success,
      ).toBe(false);
    },
  );

  it.each([
    {
      label: "uses the final corrected quoted venue",
      clientMessageId: "corrected-venue-grounding",
      userText:
        "地点不是“南站茶馆”，而是“北岸书店”。我想在2026年08月17日 11:30和你喝茶，预计45分钟。",
      expectedActivity: "北岸书店喝茶",
    },
    {
      label:
        "does not duplicate an activity already present in the quoted venue",
      clientMessageId: "deduplicated-venue-activity",
      userText: "我想在2026年08月17日 11:30和你去“北岸书店喝茶”，预计45分钟。",
      expectedActivity: "北岸书店喝茶",
    },
  ] as const)(
    "grounds the activity label safely when it $label",
    async ({ clientMessageId, expectedActivity, userText }) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, () => ({
        text: "好，先作为待确认安排。",
        scheduleAction: {
          kind: "accept_user_offer",
          offer: {
            activity: "一起喝茶",
            category: "social",
            startAt: "2026年08月17日 11:30",
            durationMinutes: 45,
            evidenceQuotes: [userText],
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
        clientMessageId,
        userText,
      );

      expect(response.statusCode).toBe(201);
      expect(
        readNegotiationState(
          app.personasim.store.getActiveScheduleNegotiation(sessionId)!,
        ).offer,
      ).toMatchObject({ activity: expectedActivity });
    },
  );

  it.each([
    {
      label: "different activity in the same category",
      clientMessageId: "canonicalized-activity",
      action: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起健身",
          category: "exercise",
          startAt: "明天 07:00",
          evidenceQuotes: ["明天早上七点一起跑半小时"],
        },
      },
    },
    {
      label: "model-invented duration",
      clientMessageId: "canonicalized-duration",
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
    },
  ] as const)(
    "canonicalizes $label from current user evidence instead of model fields",
    async ({ action, clientMessageId }) => {
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
        clientMessageId,
        DIRECT_AGREEMENT,
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.metadata).toMatchObject({
        decisionPath: "reply_only",
        repairAttempted: false,
        rejectedProposalCount: 0,
      });
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });
      expect(readNegotiationState(pending!).offer).toMatchObject({
        activity: "跑步",
        category: "exercise",
        startAtUtc: RUN_START_UTC,
        durationMinutes: 30,
      });
      expect(
        app.personasim.store.listRejectedProposals(character.id, 20),
      ).toEqual([]);
    },
  );

  it("rejects non-verbatim evidence with appended terms even when the reply is affirmative", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋；共同安排我还在核对。",
      scheduleAction: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起跑步",
          category: "exercise",
          startAt: "后天 09:00",
          evidenceQuotes: ["明天早上七点一起跑半小时，改成后天九点也可以"],
        },
      },
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const scheduleBefore = app.personasim.store.listSchedule(character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "rejected-ungrounded-negotiation-offer",
      DIRECT_AGREEMENT,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.metadata).toMatchObject({
      repairAttempted: true,
      rejectedProposalCount: 1,
    });
    expect(body.assistantMessage.content).toContain("BGW-7419");
    expect(body.assistantMessage.content).toContain("蓝色玻璃鲸");
    expect(body.assistantMessage.content).toContain("左口袋");
    expect(body.assistantMessage.content).toContain("【未修改日程】");
    expect(body.assistantMessage.content).toContain("方案缺少");
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
        reasonCode: "ungrounded_negotiation_offer",
      }),
    ]);
  });

  it.each([
    {
      label: "recorded agreement",
      modelText: "好，我记下了",
      forbiddenText: "记下了",
    },
    {
      label: "written calendar",
      modelText: "已经写入日程。",
      forbiddenText: "已经写入日程",
    },
    {
      label: "updated calendar",
      modelText: "日程已更新。",
      forbiddenText: "日程已更新",
    },
    {
      label: "cancelled schedule",
      modelText: "好，已经取消了。",
      forbiddenText: "已经取消",
    },
  ])(
    "replaces a false $label claim when the structured action is none",
    async ({ modelText, forbiddenText }) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
        (input) => {
          calls.push(input);
          if (input.purpose === "chat_turn") {
            expect(input.prompt).toContain("SCHEDULE_NEGOTIATION_CONTRACT");
            return Promise.resolve(
              canonicalChatEnvelopeFixture({
                text: modelText,
                scheduleAction: { kind: "none" },
              }) as never,
            );
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
      expect(body.assistantMessage.content).toContain("【未修改日程】");
      expect(body.assistantMessage.content).not.toContain(forbiddenText);
      expect(body.assistantMessage.metadata).toMatchObject({
        decisionPath: "reply_only",
        repairAttempted: false,
        rejectedProposalCount: 0,
      });
      expect(body.decision.reasonCode).toBe("schedule_negotiation_none");
      expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
      expect(
        app.personasim.store.listScheduleNegotiations({ sessionId }),
      ).toEqual([]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toEqual([]);
    },
  );

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

  it("replaces a contradictory proposal reply with the canonical pending-offer display without model repair", async () => {
    app = (await createNegotiationTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        calls.push(input);
        if (input.purpose === "chat_turn") {
          return Promise.resolve(
            canonicalChatEnvelopeFixture({
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
            }) as never,
          );
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
      repairAttempted: false,
      decisionPath: "reply_only",
    });
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
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
        mode: "shadow",
      })
    ).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, () => ({
      text: "好呀，我愿意一起去。学习的事我来重新安排。",
      scheduleAction: {
        kind: "accept_user_offer",
        offer: {
          activity: "一起参加晚会",
          category: "social",
          startAt: "今晚 19:00",
          evidenceQuotes: ["今晚要不要一起去参加学校的晚会"],
        },
      },
      scheduleEffects: [
        {
          operation: "move",
          itemTitle: "晚间自习",
          newStart: "明天 15:45",
          justificationQuote: "可以把学习挪到明天",
        },
      ],
    }));
    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "shadow-keeps-legacy-writer",
      "今晚要不要一起去参加学校的晚会？可以把学习挪到明天。",
    );

    expect(response.statusCode).toBe(201);
    expect(jsonBody<ChatTurnResult>(response).scheduleChanges).toHaveLength(1);
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual([]);
    const events = app.personasim.store.listDomainEvents(character.id, 100);
    expect(
      events.filter(
        (event) => event.eventType === "schedule.command_committed",
      ),
    ).toEqual([]);
    expect(
      events.filter(
        (event) =>
          event.correlationId === "shadow-keeps-legacy-writer" &&
          event.eventType === "schedule.negotiation_shadow_evaluated",
      ),
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "explicit none confirmation",
      userText: "确认",
      output: {
        text: "我看到了你的确认。",
        scheduleAction: { kind: "none" },
      },
      expectedOrigin: "model_explicit_valid",
    },
    {
      label: "missing confirmation",
      userText: "确认",
      output: {
        text: "我看到了你的确认。",
      },
      expectedOrigin: "model_unavailable",
    },
    {
      label: "invalid confirmation",
      userText: "确认",
      output: {
        text: "我看到了你的确认。",
        scheduleAction: {
          kind: "accept_pending_offer",
          evidenceQuotes: [],
        },
      },
      expectedOrigin: "model_unavailable",
    },
    {
      label: "explicit none cancellation",
      userText: "取消",
      output: {
        text: "我看到了你的取消请求。",
        scheduleAction: { kind: "none" },
      },
      expectedOrigin: "model_explicit_valid",
    },
    {
      label: "missing cancellation",
      userText: "取消",
      output: {
        text: "我看到了你的取消请求。",
      },
      expectedOrigin: "model_unavailable",
    },
    {
      label: "invalid cancellation",
      userText: "取消",
      output: {
        text: "我看到了你的取消请求。",
        scheduleAction: {
          kind: "accept_pending_offer",
          evidenceQuotes: [],
        },
      },
      expectedOrigin: "model_unavailable",
    },
  ] as const)(
    "does not let confirmation or cancellation text bypass an active enforced model action that is $label",
    async ({ label, userText, output, expectedOrigin }) => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let confirmationPhase = false;
      mockLlm(app.personasim.llm, calls, () => {
        return confirmationPhase
          ? output
          : {
              text: "可以，我们先确认这个方案。",
              scheduleAction: acceptUserOffer(),
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const offered = await sendMessage(
        app,
        sessionId,
        character.id,
        "active-fail-closed-offer-" + label.replaceAll(" ", "-"),
        DIRECT_AGREEMENT,
      );
      expect(offered.statusCode).toBe(201);
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });

      confirmationPhase = true;
      const confirmationId =
        "active-fail-closed-confirm-" + label.replaceAll(" ", "-");
      const confirmed = await sendMessage(
        app,
        sessionId,
        character.id,
        confirmationId,
        userText,
      );

      expect(confirmed.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(confirmed);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.metadata["scheduleActionAudit"]).toEqual({
        origin: expectedOrigin,
        kind: "none",
      });
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter(
            (event) =>
              event.correlationId === confirmationId &&
              event.eventType === "schedule.command_committed",
          ),
      ).toEqual([]);
    },
  );

  describe("strict two-phase confirmation", () => {
    it("keeps a direct accept_user_offer pending and commits it only after explicit confirmation", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let turn = 0;
      mockLlm(app.personasim.llm, calls, () => {
        turn += 1;
        return turn === 1
          ? {
              text: "可以。",
              scheduleAction: acceptUserOffer(),
            }
          : {
              text: "好。",
              scheduleAction: {
                kind: "accept_pending_offer",
                evidenceQuotes: ["没问题"],
              },
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);
      const publish = vi.spyOn(app.personasim.sse, "publish");

      const offered = await sendMessage(
        app,
        sessionId,
        character.id,
        "strict-direct-offer",
        DIRECT_AGREEMENT,
      );

      expect(offered.statusCode).toBe(201);
      const offeredBody = jsonBody<ChatTurnResult>(offered);
      expect(offeredBody.scheduleChanges).toEqual([]);
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(offeredBody.assistantMessage.content).toContain(
        "【待确认日程】2026-08-17 07:00，跑步，30 分钟",
      );
      expect(offeredBody.assistantMessage.content).toContain("日程尚未修改");
      expect(offeredBody.assistantMessage.content).not.toContain(
        "【日程已修改】",
      );
      expect(
        publish.mock.calls.filter(
          ([event]) => event.type === "schedule.updated",
        ),
      ).toEqual([]);

      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });
      expect(readNegotiationState(pending!)).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
        offer: {
          version: 1,
          category: "exercise",
          startAtUtc: RUN_START_UTC,
          durationMinutes: 30,
        },
      });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter(
            (event) =>
              event.correlationId === "strict-direct-offer" &&
              event.eventType === "schedule.negotiation_offer_presented",
          ),
      ).toHaveLength(1);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toEqual([]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .find(
            (event) =>
              event.correlationId === "strict-direct-offer" &&
              event.eventType === "conversation.turn_committed",
          )?.payload,
      ).toMatchObject({ scheduleItemIds: [] });

      publish.mockClear();
      const confirmed = await sendMessage(
        app,
        sessionId,
        character.id,
        "strict-direct-confirmation",
        "没问题",
      );

      expect(confirmed.statusCode).toBe(201);
      const confirmedBody = jsonBody<ChatTurnResult>(confirmed);
      expect(confirmedBody.scheduleChanges).toEqual([
        expect.objectContaining({
          category: "exercise",
          startAtUtc: RUN_START_UTC,
          endAtUtc: RUN_END_UTC,
          source: "user_invitation",
        }),
      ]);
      expect(confirmedBody.assistantMessage.content).toContain(
        "【日程已修改】2026-08-17 07:00，跑步，30 分钟",
      );
      expect(publish.mock.calls.map(([event]) => event.type)).toContain(
        "schedule.updated",
      );
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toBeUndefined();
      expect(
        app.personasim.store.getScheduleNegotiationById(pending!.id),
      ).toMatchObject({
        status: "committed",
        offerVersion: 1,
      });
      const commandEvents = app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed");
      expect(commandEvents).toHaveLength(1);
      expect(commandEvents[0]?.payload).toMatchObject({
        negotiationId: pending!.id,
        offerVersion: 1,
        changedItemIds: [confirmedBody.scheduleChanges[0]!.id],
      });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .find(
            (event) =>
              event.correlationId === "strict-direct-confirmation" &&
              event.eventType === "conversation.turn_committed",
          )?.payload,
      ).toMatchObject({
        scheduleItemIds: [confirmedBody.scheduleChanges[0]!.id],
      });

      const replay = await sendMessage(
        app,
        sessionId,
        character.id,
        "strict-direct-confirmation",
        "没问题",
      );
      expect(replay.statusCode).toBe(200);
      expect(jsonBody<ChatTurnResult>(replay)).toMatchObject({
        idempotentReplay: true,
        scheduleChanges: [],
      });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toHaveLength(1);
      expect(app.personasim.store.listSchedule(character.id)).toHaveLength(
        scheduleBefore.length + 1,
      );
    });

    it("fails closed when confirmation text conflicts with model none and preserves the pending policy version", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let confirmationPhase = false;
      mockLlm(app.personasim.llm, calls, () => {
        return confirmationPhase
          ? {
              text: "收到。",
              scheduleAction: { kind: "none" },
            }
          : {
              text: "我先列出方案，请你确认。",
              scheduleAction: acceptUserOffer(),
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const offered = await sendMessage(
        app,
        sessionId,
        character.id,
        "server-normalized-confirmation-offer",
        DIRECT_AGREEMENT,
      );
      expect(offered.statusCode).toBe(201);
      expect(jsonBody<ChatTurnResult>(offered).scheduleChanges).toEqual([]);
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });

      // Simulate a pending offer created under the previous policy. Confirming
      // it under the current runtime must retain the policy that formed it.
      app.personasim.store.upsertScheduleNegotiation({
        ...pending!,
        record: { ...pending!.record, policyVersion: 1 },
      });

      confirmationPhase = true;
      const confirmed = await sendMessage(
        app,
        sessionId,
        character.id,
        "server-normalized-confirmation-none",
        "没问题",
      );

      expect(confirmed.statusCode).toBe(201);
      const confirmedBody = jsonBody<ChatTurnResult>(confirmed);
      expect(confirmedBody.scheduleChanges).toEqual([]);
      expect(confirmedBody.assistantMessage.content).not.toContain(
        "【日程已修改】",
      );
      expect(
        confirmedBody.assistantMessage.metadata["scheduleActionAudit"],
      ).toEqual({
        origin: "model_explicit_valid",
        kind: "none",
      });
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      const stillPending = app.personasim.store.getScheduleNegotiationById(
        pending!.id,
      );
      expect(stillPending).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
        record: { policyVersion: 1 },
      });
      const commandEvents = app.personasim.store
        .listDomainEvents(character.id, 100)
        .filter((event) => event.eventType === "schedule.command_committed");
      expect(commandEvents).toEqual([]);
    });

    it("fails closed when cancellation text conflicts with model acceptance", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let cancellationPhase = false;
      mockLlm(app.personasim.llm, calls, () => {
        return cancellationPhase
          ? {
              text: "好。",
              scheduleAction: {
                kind: "accept_pending_offer",
                evidenceQuotes: ["取消"],
              },
            }
          : {
              text: "我先列出方案，请你确认。",
              scheduleAction: acceptUserOffer(),
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const offered = await sendMessage(
        app,
        sessionId,
        character.id,
        "server-normalized-cancellation-offer",
        DIRECT_AGREEMENT,
      );
      expect(offered.statusCode).toBe(201);
      expect(jsonBody<ChatTurnResult>(offered).scheduleChanges).toEqual([]);
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({ status: "awaiting_confirmation" });
      const publish = vi.spyOn(app.personasim.sse, "publish");

      cancellationPhase = true;
      const cancelled = await sendMessage(
        app,
        sessionId,
        character.id,
        "server-normalized-cancellation",
        "取消",
      );

      expect(cancelled.statusCode).toBe(201);
      const cancelledBody = jsonBody<ChatTurnResult>(cancelled);
      expect(cancelledBody.scheduleChanges).toEqual([]);
      expect(cancelledBody.assistantMessage.content).toContain(
        "【未修改日程】",
      );
      expect(cancelledBody.assistantMessage.content).toContain(
        "没有识别到明确且不改变条款的肯定答复",
      );
      expect(
        cancelledBody.assistantMessage.metadata["scheduleActionAudit"],
      ).toEqual({
        origin: "model_explicit_valid",
        kind: "accept_pending_offer",
      });
      expect(cancelledBody.assistantMessage.content).not.toContain(
        "【日程已修改】",
      );
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        publish.mock.calls.filter(
          ([event]) => event.type === "schedule.updated",
        ),
      ).toEqual([]);
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toMatchObject({
        id: pending!.id,
        status: "awaiting_confirmation",
        offerVersion: 1,
      });
      const unchanged = app.personasim.store.getScheduleNegotiationById(
        pending!.id,
      );
      expect(unchanged).toMatchObject({ status: "awaiting_confirmation" });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toEqual([]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .find(
            (event) =>
              event.correlationId === "server-normalized-cancellation" &&
              event.eventType === "conversation.turn_committed",
          )?.payload,
      ).toMatchObject({ scheduleItemIds: [] });
    });

    it("withdraws an active offer only when the model explicitly returns withdraw_offer", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let cancellationPhase = false;
      mockLlm(app.personasim.llm, calls, () =>
        cancellationPhase
          ? {
              text: "好，取消这份待确认方案。",
              scheduleAction: { kind: "withdraw_offer" },
            }
          : {
              text: "我先列出方案，请你确认。",
              scheduleAction: acceptUserOffer(),
            },
      );
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const offered = await sendMessage(
        app,
        sessionId,
        character.id,
        "explicit-withdraw-offer",
        DIRECT_AGREEMENT,
      );
      expect(offered.statusCode).toBe(201);
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });

      cancellationPhase = true;
      const cancelled = await sendMessage(
        app,
        sessionId,
        character.id,
        "explicit-withdraw-confirmation",
        "取消",
      );

      expect(cancelled.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(cancelled);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).toContain("待确认方案已经取消");
      expect(body.assistantMessage.content).not.toContain("【日程已修改】");
      expect(body.assistantMessage.metadata["scheduleActionAudit"]).toEqual({
        origin: "model_explicit_valid",
        kind: "withdraw_offer",
      });
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toBeUndefined();
      const withdrawn = app.personasim.store.getScheduleNegotiationById(
        pending!.id,
      );
      expect(withdrawn).toMatchObject({ status: "withdrawn" });
      expect(readNegotiationState(withdrawn!)).toMatchObject({
        status: "withdrawn",
        terminalReasonCode: "user_withdrew",
      });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toEqual([]);
    });

    it("uses early-morning user evidence as truth instead of a model supplied ISO date and duration", async () => {
      app = (
        await createNegotiationTestApp({
          clock: new FakeClock(EARLY_MORNING_UTC),
        })
      ).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let turn = 0;
      mockLlm(app.personasim.llm, calls, () => {
        turn += 1;
        return turn === 1
          ? {
              text: "我先把时间列出来，请你确认。",
              scheduleAction: {
                kind: "accept_user_offer",
                offer: {
                  activity: "一起跑步",
                  category: "exercise",
                  // Both fields deliberately reproduce the bad live-model output.
                  startAt: "2026-08-17T07:00:00+08:00",
                  durationMinutes: 60,
                  evidenceQuotes: ["明早七点跑步"],
                },
              },
            }
          : {
              text: "好。",
              scheduleAction: {
                kind: "accept_pending_offer",
                evidenceQuotes: ["没问题"],
              },
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const offered = await sendMessage(
        app,
        sessionId,
        character.id,
        "early-morning-offer",
        "明早七点跑步",
      );

      expect(offered.statusCode).toBe(201);
      const offeredBody = jsonBody<ChatTurnResult>(offered);
      expect(offeredBody.scheduleChanges).toEqual([]);
      expect(offeredBody.assistantMessage.content).toContain(
        "【待确认日程】2026-08-18 07:00，跑步，30 分钟",
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
      expect(readNegotiationState(pending!)).toMatchObject({
        status: "awaiting_confirmation",
        offer: {
          startAtUtc: NEXT_MORNING_RUN_START_UTC,
          durationMinutes: 30,
        },
      });

      const confirmed = await sendMessage(
        app,
        sessionId,
        character.id,
        "early-morning-confirmation",
        "没问题",
      );

      expect(confirmed.statusCode).toBe(201);
      const confirmedBody = jsonBody<ChatTurnResult>(confirmed);
      expect(confirmedBody.scheduleChanges).toEqual([
        expect.objectContaining({
          startAtUtc: NEXT_MORNING_RUN_START_UTC,
          endAtUtc: NEXT_MORNING_RUN_END_UTC,
          category: "exercise",
        }),
      ]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toHaveLength(1);
    });

    it("rejects cancel or reschedule intent instead of turning it into a new item", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, () => ({
        text: "好。",
        scheduleAction: {
          kind: "accept_user_offer",
          offer: {
            activity: "跑步",
            category: "exercise",
            startAt: "明天八点",
            durationMinutes: 30,
            evidenceQuotes: ["跑步", "明天八点"],
          },
        },
      }));
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        "unsupported-reschedule",
        "把跑步改到明天八点",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).toContain("【未修改日程】");
      expect(body.assistantMessage.content).toContain("暂不支持取消或改期");
      expect(body.assistantMessage.metadata.reasonCode).toBe(
        "unsupported_schedule_operation",
      );
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
      { id: "delete-cn", userText: "删掉明天八点的跑步" },
      { id: "revoke-cn", userText: "撤销明天八点的跑步" },
      { id: "move-cn", userText: "把跑步换到后天九点" },
      { id: "remove-en", userText: "remove tomorrow's 8am run" },
      { id: "shift-en", userText: "shift tomorrow's run to 9am" },
    ])(
      "rejects unsupported existing-item operation before trusting the model: $userText",
      async ({ id, userText }) => {
        app = (await createNegotiationTestApp()).app;
        const calls: Array<GenerateObjectInput<unknown>> = [];
        mockLlm(app.personasim.llm, calls, () => ({
          text: "好。",
          scheduleAction: {
            kind: "accept_user_offer",
            offer: {
              activity: "跑步",
              category: "exercise",
              startAt: "明天八点",
              durationMinutes: 30,
              evidenceQuotes: [userText],
            },
          },
        }));
        const character = await createAndPublishHighFidelity(app);
        const sessionId = await createSession(app, character.id);
        calls.length = 0;
        const scheduleBefore = app.personasim.store.listSchedule(character.id);

        const response = await sendMessage(
          app,
          sessionId,
          character.id,
          `unsupported-operation-${id}`,
          userText,
        );

        expect(response.statusCode).toBe(201);
        const body = jsonBody<ChatTurnResult>(response);
        expect(body.scheduleChanges).toEqual([]);
        expect(body.assistantMessage.content).toContain("【未修改日程】");
        expect(body.assistantMessage.content).toContain("暂不支持取消或改期");
        expect(body.assistantMessage.metadata.reasonCode).toBe(
          "unsupported_schedule_operation",
        );
        expect(app.personasim.store.listSchedule(character.id)).toEqual(
          scheduleBefore,
        );
        expect(
          app.personasim.store.listScheduleNegotiations({ sessionId }),
        ).toEqual([]);
      },
    );

    it("rejects an attempted reschedule from the full user message while keeping an active offer unchanged", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let turn = 0;
      mockLlm(app.personasim.llm, calls, () => {
        turn += 1;
        return turn === 1
          ? {
              text: "我先列出方案，请你确认。",
              scheduleAction: acceptUserOffer(),
            }
          : {
              text: "行，改成八点。",
              scheduleAction: {
                kind: "propose_offer",
                offer: {
                  activity: "跑步",
                  category: "exercise",
                  startAt: "明天八点",
                  durationMinutes: 30,
                  evidenceQuotes: [DIRECT_AGREEMENT, "明天八点"],
                },
              },
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const offered = await sendMessage(
        app,
        sessionId,
        character.id,
        "active-reschedule-offer",
        DIRECT_AGREEMENT,
      );
      expect(offered.statusCode).toBe(201);
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({
        status: "awaiting_confirmation",
        offerVersion: 1,
      });

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        "active-reschedule-attempt",
        "把时间改成明天八点",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).toContain("【未修改日程】");
      expect(body.assistantMessage.content).toContain("暂不支持取消或改期");
      expect(body.assistantMessage.metadata.reasonCode).toBe(
        "unsupported_schedule_operation",
      );
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toMatchObject({
        id: pending!.id,
        status: "awaiting_confirmation",
        offerVersion: 1,
      });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toEqual([]);
    });

    it("reports a missing pending offer instead of claiming that a bare cancellation succeeded", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, () => ({
        text: "好，已经取消了。",
        scheduleAction: { kind: "withdraw_offer" },
      }));
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        "cancellation-without-pending",
        "取消",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).toContain("【未修改日程】");
      expect(body.assistantMessage.content).toContain(
        "当前没有可确认的日程方案",
      );
      expect(body.assistantMessage.content).not.toContain("已经取消");
      expect(body.assistantMessage.metadata.reasonCode).toBe(
        "missing_pending_offer",
      );
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.listScheduleNegotiations({ sessionId }),
      ).toEqual([]);
    });

    it("keeps the confirmation prompt controlled while an offer is pending", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let turn = 0;
      mockLlm(app.personasim.llm, calls, () => {
        turn += 1;
        return turn === 1
          ? {
              text: "我先列出方案，请你确认。",
              scheduleAction: acceptUserOffer(),
            }
          : {
              text: "喜欢。你还要我推荐一种颜色吗？",
              scheduleAction: { kind: "none" },
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      await sendMessage(
        app,
        sessionId,
        character.id,
        "controlled-pending-offer",
        DIRECT_AGREEMENT,
      );
      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        "controlled-pending-reminder",
        "你喜欢蓝色吗？",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).toContain(
        "待确认方案仍未应用。请只回复“确认”或“取消”",
      );
      expect(body.assistantMessage.content).toContain("【待确认日程】");
      expect(body.assistantMessage.content).not.toContain("推荐一种颜色");
      expect(body.assistantMessage.metadata.reasonCode).toBe(
        "schedule_negotiation_awaiting_confirmation",
      );
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toMatchObject({ status: "awaiting_confirmation", offerVersion: 1 });
    });

    it("rejects an affirmative action when there is no pending offer", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls, () => ({
        text: "好。",
        scheduleAction: {
          kind: "accept_pending_offer",
          evidenceQuotes: ["没问题"],
        },
      }));
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        "confirmation-without-pending",
        "没问题",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(body.assistantMessage.content).toContain("【未修改日程】");
      expect(body.assistantMessage.content).toContain(
        "当前没有可确认的日程方案",
      );
      expect(body.assistantMessage.content).not.toContain("【日程已修改】");
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.listScheduleNegotiations({ sessionId }),
      ).toEqual([]);
      expect(
        app.personasim.store.listRejectedProposals(character.id, 20),
      ).toEqual([
        expect.objectContaining({ reasonCode: "missing_pending_offer" }),
      ]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .find(
            (event) =>
              event.correlationId === "confirmation-without-pending" &&
              event.eventType === "conversation.turn_committed",
          )?.payload,
      ).toMatchObject({ scheduleItemIds: [] });
    });

    it("rejects a negative confirmation without writing or closing the pending offer", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let turn = 0;
      mockLlm(app.personasim.llm, calls, () => {
        turn += 1;
        return turn === 1
          ? {
              text: "明早七点跑半小时，你看可以吗？",
              scheduleAction: proposeRunOffer(),
            }
          : {
              text: "好。",
              scheduleAction: {
                kind: "accept_pending_offer",
                evidenceQuotes: ["不行"],
              },
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;
      const scheduleBefore = app.personasim.store.listSchedule(character.id);

      const proposal = await sendMessage(
        app,
        sessionId,
        character.id,
        "declined-proposal",
        "明早可以陪我跑步吗？",
      );
      expect(proposal.statusCode).toBe(201);
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({ status: "awaiting_confirmation" });

      const declined = await sendMessage(
        app,
        sessionId,
        character.id,
        "declined-confirmation",
        "不行",
      );

      expect(declined.statusCode).toBe(201);
      const declinedBody = jsonBody<ChatTurnResult>(declined);
      expect(declinedBody.scheduleChanges).toEqual([]);
      expect(declinedBody.assistantMessage.content).toContain("【未修改日程】");
      expect(declinedBody.assistantMessage.content).toContain(
        "没有识别到明确且不改变条款的肯定答复",
      );
      expect(declinedBody.assistantMessage.content).not.toContain(
        "【日程已修改】",
      );
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBefore,
      );
      expect(
        app.personasim.store.getActiveScheduleNegotiation(sessionId),
      ).toMatchObject({
        id: pending!.id,
        status: "awaiting_confirmation",
        offerVersion: 1,
      });
      expect(
        app.personasim.store.listRejectedProposals(character.id, 20),
      ).toEqual([
        expect.objectContaining({
          correlationId: "declined-confirmation",
          reasonCode: "confirmation_not_affirmative",
        }),
      ]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toEqual([]);
    });

    it.each([
      {
        id: "changed-terms",
        label: "changed terms",
        userText: "七点还是八点都行",
      },
      {
        id: "confirmation-question",
        label: "question-shaped confirmation",
        userText: "确定？",
      },
      {
        id: "compatibility-question",
        label: "NFKC-compatible question-shaped confirmation",
        userText: "确定﹖",
      },
      {
        id: "cancellation-question",
        label: "question-shaped cancellation",
        userText: "取消？",
      },
    ])(
      "rejects $label even when the model returns accept_pending_offer",
      async ({ id, userText }) => {
        app = (await createNegotiationTestApp()).app;
        const calls: Array<GenerateObjectInput<unknown>> = [];
        let turn = 0;
        mockLlm(app.personasim.llm, calls, () => {
          turn += 1;
          return turn === 1
            ? {
                text: "明早七点跑半小时，你看可以吗？",
                scheduleAction: proposeRunOffer(),
              }
            : {
                text: "好。",
                scheduleAction: {
                  kind: "accept_pending_offer",
                  evidenceQuotes: [userText],
                },
              };
        });
        const character = await createAndPublishHighFidelity(app);
        const sessionId = await createSession(app, character.id);
        calls.length = 0;
        const scheduleBefore = app.personasim.store.listSchedule(character.id);

        const proposal = await sendMessage(
          app,
          sessionId,
          character.id,
          `ambiguous-proposal-${id}`,
          "明早可以陪我跑步吗？",
        );
        expect(proposal.statusCode).toBe(201);
        const pending =
          app.personasim.store.getActiveScheduleNegotiation(sessionId);
        expect(pending).toMatchObject({ status: "awaiting_confirmation" });

        const correlationId = `ambiguous-confirmation-${id}`;
        const ambiguous = await sendMessage(
          app,
          sessionId,
          character.id,
          correlationId,
          userText,
        );

        expect(ambiguous.statusCode).toBe(201);
        const ambiguousBody = jsonBody<ChatTurnResult>(ambiguous);
        expect(ambiguousBody.scheduleChanges).toEqual([]);
        expect(ambiguousBody.assistantMessage.content).toContain(
          "【未修改日程】",
        );
        expect(ambiguousBody.assistantMessage.content).toContain(
          "没有识别到明确且不改变条款的肯定答复",
        );
        expect(ambiguousBody.assistantMessage.content).not.toContain(
          "【日程已修改】",
        );
        expect(app.personasim.store.listSchedule(character.id)).toEqual(
          scheduleBefore,
        );
        const stillPending =
          app.personasim.store.getActiveScheduleNegotiation(sessionId);
        expect(stillPending).toMatchObject({
          id: pending!.id,
          status: "awaiting_confirmation",
          offerVersion: 1,
        });
        expect(
          app.personasim.store.listRejectedProposals(character.id, 20),
        ).toEqual([
          expect.objectContaining({
            correlationId,
            reasonCode: "confirmation_not_affirmative",
          }),
        ]);
        const events = app.personasim.store.listDomainEvents(character.id, 100);
        expect(
          events.filter(
            (event) => event.eventType === "schedule.command_committed",
          ),
        ).toEqual([]);
        expect(
          events.filter(
            (event) =>
              event.correlationId === correlationId &&
              typeof event.eventType === "string" &&
              event.eventType.startsWith("schedule.negotiation_"),
          ),
        ).toEqual([]);
      },
    );

    it("marks a pending offer conflicted when the slot is occupied before confirmation", async () => {
      app = (await createNegotiationTestApp()).app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      let turn = 0;
      mockLlm(app.personasim.llm, calls, () => {
        turn += 1;
        return turn === 1
          ? {
              text: "明早七点跑半小时，你看可以吗？",
              scheduleAction: proposeRunOffer(),
            }
          : {
              text: "我先重新确认一下时间。",
              scheduleAction: {
                kind: "accept_pending_offer",
                evidenceQuotes: ["没问题"],
              },
            };
      });
      const character = await createAndPublishHighFidelity(app);
      const sessionId = await createSession(app, character.id);
      calls.length = 0;

      const proposal = await sendMessage(
        app,
        sessionId,
        character.id,
        "conflicted-proposal",
        "明早可以陪我跑步吗？",
      );
      expect(proposal.statusCode).toBe(201);
      const pending =
        app.personasim.store.getActiveScheduleNegotiation(sessionId);
      expect(pending).toMatchObject({ status: "awaiting_confirmation" });

      app.personasim.store.insertScheduleItem({
        id: "schedule-strict-two-phase-conflict",
        agentId: character.id,
        title: "确认前新增的固定安排",
        description: "占用待确认时段。",
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
      const scheduleBeforeConfirmation = app.personasim.store.listSchedule(
        character.id,
      );

      const conflicted = await sendMessage(
        app,
        sessionId,
        character.id,
        "conflicted-confirmation",
        "没问题",
      );

      expect(conflicted.statusCode).toBe(201);
      const conflictedBody = jsonBody<ChatTurnResult>(conflicted);
      expect(conflictedBody.scheduleChanges).toEqual([]);
      expect(conflictedBody.assistantMessage.content).toContain(
        "【未修改日程】",
      );
      expect(conflictedBody.assistantMessage.content).toContain(
        "方案未通过日程校验（overlap_fixed）",
      );
      expect(conflictedBody.assistantMessage.content).toContain("没有修改日程");
      expect(conflictedBody.assistantMessage.content).not.toContain(
        "【日程已修改】",
      );
      expect(app.personasim.store.listSchedule(character.id)).toEqual(
        scheduleBeforeConfirmation,
      );
      const stored = app.personasim.store.getScheduleNegotiationById(
        pending!.id,
      );
      expect(stored).toMatchObject({ status: "conflicted" });
      expect(readNegotiationState(stored!)).toMatchObject({
        status: "conflicted",
        terminalReasonCode: "overlap_fixed",
      });
      expect(
        app.personasim.store.listRejectedProposals(character.id, 20),
      ).toEqual([expect.objectContaining({ reasonCode: "overlap_fixed" })]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .find(
            (event) =>
              event.correlationId === "conflicted-confirmation" &&
              event.eventType === "schedule.negotiation_conflicted",
          )?.payload,
      ).toMatchObject({
        transition: { reason: "conflicted" },
      });
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .filter((event) => event.eventType === "schedule.command_committed"),
      ).toEqual([]);
      expect(
        app.personasim.store
          .listDomainEvents(character.id, 100)
          .find(
            (event) =>
              event.correlationId === "conflicted-confirmation" &&
              event.eventType === "conversation.turn_committed",
          )?.payload,
      ).toMatchObject({ scheduleItemIds: [] });
    });
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

function insertCommittedTeaSchedule(app: PersonaSimApp, agentId: string): void {
  app.personasim.store.insertScheduleItem({
    id: "schedule-authoritative-readback-tea",
    agentId,
    title: "和用户在北岸书店喝茶",
    description: "双方已确认的共同安排。",
    category: "social",
    startAtUtc: "2026-08-17T03:30:00.000Z",
    endAtUtc: "2026-08-17T04:15:00.000Z",
    timezone: "Asia/Shanghai",
    rigidity: "committed",
    priority: 0.9,
    source: "user_invitation",
    adherenceProbability: 1,
    narrativeImportance: 0.9,
    shareable: true,
    stateEffects: {},
    status: "planned",
    revision: 1,
    createdAtUtc: START_UTC,
    updatedAtUtc: START_UTC,
  });
}

function countScheduleCommandEvents(
  app: PersonaSimApp,
  agentId: string,
): number {
  return app.personasim.store
    .listDomainEvents(agentId, 500)
    .filter((event) => event["eventType"] === "schedule.command_committed")
    .length;
}

function countCommitmentMemories(app: PersonaSimApp, agentId: string): number {
  const row = app.personasim.store.database
    .prepare(
      "SELECT COUNT(*) AS count FROM memories WHERE agent_id = ? AND type = 'commitment'",
    )
    .get(agentId) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

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

function proposeRunOffer(): ScheduleNegotiationAction {
  return {
    kind: "propose_offer",
    offer: {
      activity: "一起跑步",
      category: "exercise",
      startAt: "明天 07:00",
      durationMinutes: 30,
      evidenceQuotes: ["明早可以陪我跑步吗"],
    },
  };
}

function acceptPendingOffer(
  evidenceQuote = "没问题",
): ScheduleNegotiationAction {
  return {
    kind: "accept_pending_offer",
    evidenceQuotes: [evidenceQuote],
  };
}

function readNegotiationState(negotiation: StoredScheduleNegotiation): {
  status: string;
  offerVersion: number;
  terminalReasonCode?: string;
  offer?: {
    version: number;
    activity: string;
    category: string;
    startAtUtc: string;
    durationMinutes: number;
  };
} {
  return negotiation.record["negotiation"] as {
    status: string;
    offerVersion: number;
    terminalReasonCode?: string;
    offer?: {
      version: number;
      activity: string;
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
    return Promise.resolve(
      canonicalChatEnvelopeFixture(responder(input)) as never,
    );
  });
}

function canonicalChatEnvelopeFixture(output: unknown): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return { replyDecision: output, worldEffects: {} };
  }
  const record = output as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "replyDecision")) {
    return output;
  }
  const replyDecision: Record<string, unknown> = {};
  for (const key of [
    "text",
    "toneTags",
    "deliveryMode",
    "chunks",
    "scheduleAction",
  ] as const) {
    if (record[key] !== undefined) replyDecision[key] = record[key];
  }
  const nestedReply =
    record["reply"] === undefined ? replyDecision : record["reply"];
  const worldEffects =
    typeof record["worldEffects"] === "object" &&
    record["worldEffects"] !== null &&
    !Array.isArray(record["worldEffects"])
      ? record["worldEffects"]
      : {};
  return {
    replyDecision: nestedReply,
    worldEffects,
    ...(record["scheduleEffects"] === undefined
      ? {}
      : { scheduleEffects: record["scheduleEffects"] }),
  };
}

async function createNegotiationTestApp(
  options: {
    databasePath?: string;
    clock?: FakeClock;
    provider?: "fixture" | "openai-compatible";
    mode?: "legacy" | "shadow" | "enforced";
    chatEffectsMode?: "off" | "gated";
    liveWorldEffectsMode?: "off" | "shadow" | "enforced";
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
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: options.liveWorldEffectsMode ?? "shadow",
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
