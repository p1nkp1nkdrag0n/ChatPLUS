import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CorrespondenceMailboxResponse,
  DeveloperTemporalTasksResponse,
  LetterDetailResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import {
  canonicalCorrespondenceJson,
  canonicalLetterContent,
} from "@personasim/features";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";
import type { LlmLogicalCallEvent } from "./services/llm-service.js";
import { SseHub } from "./sse/hub.js";

const INSTANCE_SECRET = Buffer.alloc(32, 0x5a).toString("base64");
const SEPTEMBER_3 = "2026-09-03T04:00:00.000Z";
const SEPTEMBER_9 = "2026-09-09T04:00:00.000Z";
const SEPTEMBER_10 = "2026-09-10T04:00:00.000Z";
const SEPTEMBER_15 = "2026-09-15T04:00:00.000Z";
const SEPTEMBER_16 = "2026-09-16T04:00:00.000Z";

describe("correspondence HTTP lifecycle", () => {
  let directory: string | undefined;
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app !== undefined) await app.close();
    app = undefined;
    if (directory !== undefined)
      rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("paginates beyond the legacy 500-letter cap with an agent-bound opaque cursor", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-correspondence-page-"));
    const databasePath = join(directory, "correspondence.db");
    const clock = new FakeClock(SEPTEMBER_3);
    app = await startApp(databasePath, "enforced", clock, []);
    const agentId = await createPublishedAgent(app);
    const otherAgentId = await createPublishedAgent(app);
    const thread = app.personasim.correspondenceRepository.createThread(
      agentId,
      {
        id: "mailbox-pagination-thread",
        nowUtc: SEPTEMBER_3,
      },
    );
    const insert = app.personasim.store.database.prepare(
      `INSERT INTO letters (
         id, thread_id, agent_id, direction, status, body,
         created_at_utc, updated_at_utc
       ) VALUES (?, ?, ?, 'user_to_agent', 'cancelled', ?, ?, ?)`,
    );
    app.personasim.store.database.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        insert.run(
          `mailbox-letter-${String(index).padStart(4, "0")}`,
          thread.id,
          agentId,
          `${"摘要".repeat(50)}MAILBOX_BODY_SECRET_TAIL_${index}`,
          SEPTEMBER_3,
          SEPTEMBER_3,
        );
      }
    })();

    const firstResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.headers["cache-control"]).toBe("no-store");
    const firstPage = firstResponse.json<CorrespondenceMailboxResponse>();
    expect(firstPage.letters).toHaveLength(500);
    expect(firstPage.nextCursor).toBeDefined();
    expect(firstPage.threads).toEqual([
      expect.objectContaining({ id: thread.id, agentId }),
    ]);
    expect(firstResponse.body).not.toContain("MAILBOX_BODY_SECRET_TAIL");

    const secondResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence?cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    });
    expect(secondResponse.statusCode).toBe(200);
    const secondPage = secondResponse.json<CorrespondenceMailboxResponse>();
    expect(secondPage.letters).toHaveLength(1);
    expect(secondPage).not.toHaveProperty("nextCursor");
    const expectedIds = Array.from(
      { length: 501 },
      (_, index) => `mailbox-letter-${String(index).padStart(4, "0")}`,
    ).reverse();
    const collectedIds = [...firstPage.letters, ...secondPage.letters].map(
      (letter) => letter.id,
    );
    expect(collectedIds).toEqual(expectedIds);
    expect(new Set(collectedIds).size).toBe(501);

    const malformed = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence?cursor=not-a-valid-cursor`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "invalid_cursor" },
    });

    const crossAgent = await app.inject({
      method: "GET",
      url: `/api/agents/${otherAgentId}/correspondence?cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    });
    expect(crossAgent.statusCode).toBe(400);
    expect(crossAgent.json()).toMatchObject({
      error: { code: "invalid_cursor" },
    });
    expect(crossAgent.body).not.toContain(agentId);
  });

  it("preserves the sealed five-day lifecycle across shadow, restart, open concurrency, and off mode", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-correspondence-http-"));
    const databasePath = join(directory, "correspondence.db");
    const initialObservations: LlmLogicalCallEvent[] = [];
    let clock = new FakeClock(SEPTEMBER_3);
    app = await startApp(databasePath, "enforced", clock, initialObservations);

    const draftCharacter = app.personasim.characters.createDemoCharacter();
    const agentId = draftCharacter.id;
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${agentId}/publish`,
    });
    expect(published.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "create-stage4-1",
        subject: "阶段四主题",
        body: "PRIVATE-USER-TEXT：这是需要经过五天运输的正文。",
      },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<LetterDetailResponse>();
    const letterId = createdBody.letter.id;
    expect(createdBody).toMatchObject({
      letter: {
        direction: "user_to_agent",
        status: "draft",
        canEdit: true,
      },
      subject: "阶段四主题",
      body: "PRIVATE-USER-TEXT：这是需要经过五天运输的正文。",
    });
    expect(JSON.stringify(createdBody)).not.toMatch(
      /ciphertext|authTag|encryptedBody/iu,
    );

    const createReplay = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "create-stage4-1",
        subject: "阶段四主题",
        body: "PRIVATE-USER-TEXT：这是需要经过五天运输的正文。",
      },
    });
    expect(createReplay.statusCode).toBe(201);
    expect(createReplay.json<LetterDetailResponse>().letter.id).toBe(letterId);

    const createConflict = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "create-stage4-1",
        subject: "阶段四主题",
        body: "同一个请求号不能换正文",
      },
    });
    expect(createConflict.statusCode).toBe(409);
    expect(createConflict.json()).toMatchObject({
      error: { code: "idempotency_conflict" },
    });

    const activeTurnConflict = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "create-stage4-2",
        body: "第二封信还不能开始。",
      },
    });
    expect(activeTurnConflict.statusCode).toBe(409);
    expect(activeTurnConflict.json()).toMatchObject({
      error: { code: "correspondence_turn_in_progress" },
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/letters/${letterId}`,
      payload: {
        subject: "阶段四主题（修订）",
        body: "PRIVATE-USER-TEXT-UPDATED：正文由服务端封缄。",
      },
    });
    expect(updated.statusCode).toBe(200);

    const sealed = await app.inject({
      method: "POST",
      url: `/api/letters/${letterId}/seal`,
      payload: { clientRequestId: "seal-stage4-1" },
    });
    expect(sealed.statusCode).toBe(200);
    const sealedBody = sealed.json<LetterDetailResponse>();
    expect(sealedBody.letter).toMatchObject({
      status: "in_transit",
      dispatchedAtUtc: SEPTEMBER_3,
      arrivalDueAtUtc: "2026-09-08T04:00:00.000Z",
    });
    const persistedSeal = app.personasim.store.database
      .prepare(
        `SELECT content_hash AS contentHash, transit_policy_version AS policy,
                transit_timezone AS timezone
         FROM letters WHERE id = ?`,
      )
      .get(letterId) as {
      contentHash: string;
      policy: string;
      timezone: string;
    };
    expect(persistedSeal).toEqual({
      contentHash: createHash("sha256")
        .update(
          canonicalLetterContent({
            subject: "阶段四主题（修订）",
            body: "PRIVATE-USER-TEXT-UPDATED：正文由服务端封缄。",
          }),
          "utf8",
        )
        .digest("hex"),
      policy: "fixed_5d_v1",
      timezone: "Asia/Shanghai",
    });

    const fourDays = await app.inject({
      method: "POST",
      url: "/api/developer/clock/advance",
      payload: { days: 4 },
    });
    expect(fourDays.statusCode).toBe(200);
    expect(initialObservations).toHaveLength(0);
    const eightyPercent = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(eightyPercent.statusCode).toBe(200);
    const eightyPercentBody =
      eightyPercent.json<CorrespondenceMailboxResponse>();
    expect(eightyPercentBody.letters).toHaveLength(1);
    expect(eightyPercentBody.letters[0]).toMatchObject({
      id: letterId,
      status: "in_transit",
    });
    expect(eightyPercentBody.letters[0]!.progress).toBeCloseTo(0.8, 8);
    expect(initialObservations).toHaveLength(0);

    const sealReplay = await app.inject({
      method: "POST",
      url: `/api/letters/${letterId}/seal`,
      payload: { clientRequestId: "seal-stage4-1" },
    });
    expect(sealReplay.statusCode).toBe(200);
    expect(sealReplay.json<LetterDetailResponse>().letter).toMatchObject({
      dispatchedAtUtc: SEPTEMBER_3,
      arrivalDueAtUtc: "2026-09-08T04:00:00.000Z",
    });

    await app.close();
    app = undefined;

    const shadowObservations: LlmLogicalCallEvent[] = [];
    clock = new FakeClock(SEPTEMBER_9);
    app = await startApp(databasePath, "shadow", clock, shadowObservations);
    expect(shadowObservations).toHaveLength(0);
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM letter_generation_snapshots")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM letter_generation_runs")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
           WHERE event_type = 'letter.reply_generation_shadow_observed'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    const shadowWrite = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "shadow-write-1",
        body: "shadow不能写信",
      },
    });
    expect(shadowWrite.statusCode).toBe(409);
    expect(shadowWrite.json()).toMatchObject({
      error: { code: "correspondence_shadow_mode" },
    });

    await app.close();
    app = undefined;

    const generationObservations: LlmLogicalCallEvent[] = [];
    clock = new FakeClock(SEPTEMBER_9);
    app = await startApp(
      databasePath,
      "enforced",
      clock,
      generationObservations,
    );
    expect(
      generationObservations.filter(
        (event) =>
          event.stage === "started" && event.purpose === "letter_reply",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(generationObservations)).not.toContain(
      "PRIVATE-USER-TEXT",
    );
    expect(JSON.stringify(generationObservations)).not.toContain(
      "愿这封回信在路上替我陪你一程",
    );
    expect(generationObservations[0]).toMatchObject({
      system: "[redacted:letter_reply]",
      prompt: "[redacted:letter_reply]",
    });

    const generatedMailbox = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(generatedMailbox.statusCode).toBe(200);
    const generatedBody =
      generatedMailbox.json<CorrespondenceMailboxResponse>();
    const replySummary = generatedBody.letters.find(
      (letter) => letter.direction === "agent_to_user",
    );
    expect(replySummary).toMatchObject({
      status: "in_transit",
      canOpen: false,
    });
    expect(replySummary).not.toHaveProperty("previewText");
    const replyLetterId = replySummary!.id;

    const replyBeforeOpen = await app.inject({
      method: "GET",
      url: `/api/letters/${replyLetterId}`,
    });
    expect(replyBeforeOpen.statusCode).toBe(200);
    const replyBeforeOpenText = replyBeforeOpen.body;
    expect(replyBeforeOpenText).not.toMatch(
      /subject|body|salutation|closing|signature|ciphertext|authTag|encrypted/iu,
    );
    expect(replyBeforeOpenText).not.toContain("愿这封回信在路上替我陪你一程");
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT subject, body,
                  encrypted_ciphertext IS NOT NULL AS hasCiphertext
           FROM letters WHERE id = ?`,
        )
        .get(replyLetterId),
    ).toEqual({ subject: null, body: null, hasCiphertext: 1 });

    const developerTasks = await app.inject({
      method: "GET",
      url: `/api/developer/agents/${agentId}/temporal-tasks`,
    });
    expect(developerTasks.statusCode).toBe(200);
    expect(developerTasks.body).not.toMatch(
      /claimToken|ciphertext|authTag|encryptedBody/iu,
    );
    const developerCalls = await app.inject({
      method: "GET",
      url: "/api/developer/llm-calls",
    });
    expect(developerCalls.statusCode).toBe(200);
    expect(developerCalls.body).not.toContain("PRIVATE-USER-TEXT");
    expect(developerCalls.body).not.toContain("愿这封回信在路上替我陪你一程");

    await app.close();
    app = undefined;

    clock = new FakeClock(SEPTEMBER_15);
    app = await startApp(databasePath, "off", clock, []);
    const pausedOpen = await app.inject({
      method: "POST",
      url: `/api/letters/${replyLetterId}/open`,
      payload: {},
    });
    expect(pausedOpen.statusCode).toBe(409);
    expect(pausedOpen.json()).toMatchObject({
      error: { code: "correspondence_processing_paused" },
    });
    expect(
      app.personasim.store.database
        .prepare("SELECT status FROM letters WHERE id = ?")
        .get(replyLetterId),
    ).toEqual({ status: "in_transit" });

    await app.close();
    app = undefined;

    const publishSpy = vi.spyOn(SseHub.prototype, "publish");
    clock = new FakeClock(SEPTEMBER_15);
    app = await startApp(databasePath, "enforced", clock, []);
    expect(
      publishSpy.mock.calls.some(
        ([event]) =>
          event.type === "letter.arrived" &&
          event.agentId === agentId &&
          (event.data as { letterId?: string }).letterId === replyLetterId,
      ),
    ).toBe(true);
    const arrivedEvent = publishSpy.mock.calls.find(
      ([event]) => event.type === "letter.arrived",
    )?.[0];
    expect(arrivedEvent?.data).toEqual({
      invalidate: ["correspondence", "letter", "messages", "timeline"],
      letterId: replyLetterId,
    });

    const arrivedMailbox = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    const arrivedReply = arrivedMailbox
      .json<CorrespondenceMailboxResponse>()
      .letters.find((letter) => letter.id === replyLetterId);
    expect(arrivedReply).toMatchObject({
      status: "delivered_unread",
      canOpen: true,
      progress: 1,
    });
    expect(arrivedReply).not.toHaveProperty("previewText");

    const [firstOpen, competingOpen] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/letters/${replyLetterId}/open`,
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/api/letters/${replyLetterId}/open`,
        payload: {},
      }),
    ]);
    expect(firstOpen.statusCode).toBe(200);
    expect(competingOpen.statusCode).toBe(200);
    expect(firstOpen.headers["cache-control"]).toBe("no-store");
    expect(competingOpen.json<OpenLetterResponse>()).toEqual(
      firstOpen.json<OpenLetterResponse>(),
    );
    expect(firstOpen.json<OpenLetterResponse>()).toMatchObject({
      letter: { id: replyLetterId, status: "read" },
      subject: "回复：阶段四主题（修订）",
      salutation: "亲爱的朋友：",
      closing: "顺颂安好",
      signature: "回信人",
    });
    expect(firstOpen.body).toContain("PRIVATE-USER-TEXT-UPDATED");
    expect(
      publishSpy.mock.calls.filter(([event]) => event.type === "letter.opened"),
    ).toHaveLength(1);
    const openedAt = (
      app.personasim.store.database
        .prepare(
          "SELECT opened_at_utc AS openedAtUtc FROM letters WHERE id = ?",
        )
        .get(replyLetterId) as { openedAtUtc: string }
    ).openedAtUtc;
    expect(openedAt).toBe(SEPTEMBER_15);
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
           WHERE idempotency_key = ?`,
        )
        .get(`letter-open:${replyLetterId}`),
    ).toEqual({ count: 1 });

    const openedDetail = await app.inject({
      method: "GET",
      url: `/api/letters/${replyLetterId}`,
    });
    expect(openedDetail.statusCode).toBe(200);
    const openedDetailBody = openedDetail.json<LetterDetailResponse>();
    expect(openedDetailBody).toMatchObject({
      letter: { status: "read" },
      subject: "回复：阶段四主题（修订）",
      salutation: "亲爱的朋友：",
      closing: "顺颂安好",
      signature: "回信人",
    });
    expect(typeof openedDetailBody.letter.previewText).toBe("string");

    const nextTurn = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "create-stage4-next-turn",
        body: "启封上一封回信后，仍沿用同一个开放线程开始下一轮信件。",
      },
    });
    expect(nextTurn.statusCode).toBe(201);
    expect(nextTurn.json<LetterDetailResponse>().letter).toMatchObject({
      threadId: createdBody.letter.threadId,
      direction: "user_to_agent",
      status: "draft",
    });

    await app.close();
    app = undefined;
    vi.restoreAllMocks();

    clock = new FakeClock(SEPTEMBER_16);
    app = await startApp(databasePath, "off", clock, []);
    const offHistory = await app.inject({
      method: "GET",
      url: `/api/letters/${replyLetterId}`,
    });
    expect(offHistory.statusCode).toBe(200);
    expect(offHistory.body).toContain("PRIVATE-USER-TEXT-UPDATED");
    const offReplay = await app.inject({
      method: "POST",
      url: `/api/letters/${replyLetterId}/open`,
      payload: {},
    });
    expect(offReplay.statusCode).toBe(200);
    expect(offReplay.headers["cache-control"]).toBe("no-store");
    expect(
      app.personasim.store.database
        .prepare(
          "SELECT opened_at_utc AS openedAtUtc FROM letters WHERE id = ?",
        )
        .get(replyLetterId),
    ).toEqual({ openedAtUtc: openedAt });
    const disabledWrite = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/letters`,
      payload: {
        clientRequestId: "off-write-1",
        body: "off mode不能创建新信。",
      },
    });
    expect(disabledWrite.statusCode).toBe(409);
    expect(disabledWrite.json()).toMatchObject({
      error: { code: "correspondence_disabled" },
    });
  }, 30_000);

  it("keeps HTTP opening monotonic after the clock rolls back behind processed delivery", async () => {
    directory = mkdtempSync(
      join(tmpdir(), "chatplus-correspondence-rollback-"),
    );
    const databasePath = join(directory, "correspondence.db");
    const clock = new FakeClock(SEPTEMBER_3);
    app = await startApp(databasePath, "enforced", clock, []);

    const agentId = await createPublishedAgent(app);
    await createAndSealLetter(
      app,
      agentId,
      "clock-rollback-open",
      "PRIVATE-CLOCK-ROLLBACK：回拨后仍应安全启封。",
    );

    clock.setUtc(SEPTEMBER_9);
    const generatedMailbox = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(generatedMailbox.statusCode).toBe(200);
    const reply = generatedMailbox
      .json<CorrespondenceMailboxResponse>()
      .letters.find((letter) => letter.direction === "agent_to_user");
    expect(reply).toMatchObject({ status: "in_transit", canOpen: false });

    clock.setUtc(SEPTEMBER_15);
    const arrivedMailbox = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(arrivedMailbox.statusCode).toBe(200);
    expect(
      arrivedMailbox
        .json<CorrespondenceMailboxResponse>()
        .letters.find((letter) => letter.id === reply!.id),
    ).toMatchObject({
      status: "delivered_unread",
      canOpen: true,
    });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT status,
                  delivered_effective_at_utc AS deliveredEffectiveAtUtc,
                  processed_at_utc AS processedAtUtc,
                  opened_at_utc AS openedAtUtc,
                  updated_at_utc AS updatedAtUtc
           FROM letters WHERE id = ?`,
        )
        .get(reply!.id),
    ).toEqual({
      status: "delivered_unread",
      deliveredEffectiveAtUtc: "2026-09-13T04:00:00.000Z",
      processedAtUtc: SEPTEMBER_15,
      openedAtUtc: null,
      updatedAtUtc: SEPTEMBER_15,
    });

    clock.setUtc(SEPTEMBER_10);
    const visibleAfterRollback = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(visibleAfterRollback.statusCode).toBe(200);
    expect(
      visibleAfterRollback
        .json<CorrespondenceMailboxResponse>()
        .letters.find((letter) => letter.id === reply!.id),
    ).toMatchObject({ status: "delivered_unread", canOpen: true });

    const [firstOpen, concurrentReplay] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/letters/${reply!.id}/open`,
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/api/letters/${reply!.id}/open`,
        payload: {},
      }),
    ]);
    expect(firstOpen.statusCode).toBe(200);
    expect(concurrentReplay.statusCode).toBe(200);
    expect(concurrentReplay.json<OpenLetterResponse>()).toEqual(
      firstOpen.json<OpenLetterResponse>(),
    );

    expect(
      app.personasim.store.database
        .prepare(
          `SELECT status,
                  delivered_effective_at_utc AS deliveredEffectiveAtUtc,
                  processed_at_utc AS processedAtUtc,
                  opened_at_utc AS openedAtUtc,
                  updated_at_utc AS updatedAtUtc
           FROM letters WHERE id = ?`,
        )
        .get(reply!.id),
    ).toEqual({
      status: "read",
      deliveredEffectiveAtUtc: "2026-09-13T04:00:00.000Z",
      processedAtUtc: SEPTEMBER_15,
      openedAtUtc: SEPTEMBER_15,
      updatedAtUtc: SEPTEMBER_15,
    });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT recorded_at_utc AS recordedAtUtc,
                  effective_at_utc AS effectiveAtUtc,
                  payload_json AS payloadJson
           FROM domain_events WHERE idempotency_key = ?`,
        )
        .get(`letter-open:${reply!.id}`),
    ).toEqual({
      recordedAtUtc: SEPTEMBER_15,
      effectiveAtUtc: SEPTEMBER_15,
      payloadJson: canonicalCorrespondenceJson({
        letterId: reply!.id,
        openedAtUtc: SEPTEMBER_15,
      }),
    });

    clock.setUtc(SEPTEMBER_3);
    const laterReplay = await app.inject({
      method: "POST",
      url: `/api/letters/${reply!.id}/open`,
      payload: {},
    });
    expect(laterReplay.statusCode).toBe(200);
    expect(laterReplay.json<OpenLetterResponse>()).toEqual(
      firstOpen.json<OpenLetterResponse>(),
    );
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
           WHERE idempotency_key = ?`,
        )
        .get(`letter-open:${reply!.id}`),
    ).toEqual({ count: 1 });
  }, 30_000);

  it("catches up direct detail reads and emits only safe retry invalidations", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-correspondence-detail-"));
    const databasePath = join(directory, "correspondence.db");
    const clock = new FakeClock(SEPTEMBER_3);
    app = await startApp(databasePath, "enforced", clock, []);

    const firstAgentId = await createPublishedAgent(app);
    const secondAgentId = await createPublishedAgent(app);
    const firstIncomingId = await createAndSealLetter(
      app,
      firstAgentId,
      "direct-detail-success",
      "PRIVATE-DIRECT-DETAIL：只应在安全边界内出现。",
    );
    const secondIncomingId = await createAndSealLetter(
      app,
      secondAgentId,
      "direct-detail-retry",
      "PRIVATE-RETRY-SOURCE：不能进入SSE或任务检查器。",
    );

    clock.setUtc(SEPTEMBER_9);
    const firstDirectRead = await app.inject({
      method: "GET",
      url: `/api/letters/${firstIncomingId}`,
    });
    expect(firstDirectRead.statusCode).toBe(200);
    const firstReply = app.personasim.store.database
      .prepare(
        `SELECT id FROM letters
         WHERE reply_to_letter_id = ? AND direction = 'agent_to_user'`,
      )
      .get(firstIncomingId) as { id: string } | undefined;
    expect(firstReply).toBeDefined();

    const repository = app.personasim.correspondenceRepository;
    const currentThread = repository.findOpenThread(firstAgentId);
    expect(currentThread?.latestLetterId).toBe(firstReply!.id);
    const listThreadsByIds = repository.listThreadsByIds.bind(repository);
    vi.spyOn(repository, "listThreadsByIds").mockImplementationOnce(
      (agentId, threadIds) =>
        listThreadsByIds(agentId, threadIds).map((thread) =>
          thread.id === currentThread!.id
            ? { ...thread, latestLetterId: firstIncomingId }
            : thread,
        ),
    );
    const staleThreadMailbox = await app.inject({
      method: "GET",
      url: `/api/agents/${firstAgentId}/correspondence`,
    });
    expect(staleThreadMailbox.statusCode).toBe(200);
    expect(
      staleThreadMailbox
        .json<CorrespondenceMailboxResponse>()
        .threads.find((thread) => thread.id === currentThread!.id),
    ).not.toHaveProperty("replyState");

    const prematureOpen = await app.inject({
      method: "POST",
      url: `/api/letters/${firstReply!.id}/open`,
      payload: {},
    });
    expect(prematureOpen.statusCode).toBe(409);
    expect(prematureOpen.json()).toMatchObject({
      error: { code: "letter_not_arrived" },
    });

    const publishSpy = vi.spyOn(SseHub.prototype, "publish");
    vi.spyOn(app.personasim.llm, "generateObject").mockRejectedValueOnce(
      new Error("simulated provider outage"),
    );
    const retryingDirectRead = await app.inject({
      method: "GET",
      url: `/api/letters/${secondIncomingId}`,
    });
    expect(retryingDirectRead.statusCode).toBe(200);

    const retryEvents = publishSpy.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "letter.generation.retryable");
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]?.data).toMatchObject({
      invalidate: ["correspondence", "letter", "messages", "timeline"],
      letterId: secondIncomingId,
    });
    expect(
      typeof (retryEvents[0]?.data as { taskId?: unknown } | undefined)?.taskId,
    ).toBe("string");
    expect(
      publishSpy.mock.calls.some(
        ([event]) =>
          event.type === "letter.arrived" && event.agentId === secondAgentId,
      ),
    ).toBe(false);
    expect(JSON.stringify(retryEvents)).not.toMatch(
      /PRIVATE-RETRY-SOURCE|ciphertext|authTag|claimToken/iu,
    );

    const developerTasks = await app.inject({
      method: "GET",
      url: `/api/developer/agents/${secondAgentId}/temporal-tasks`,
    });
    expect(developerTasks.statusCode).toBe(200);
    const developerBody = developerTasks.json<DeveloperTemporalTasksResponse>();
    expect(
      developerBody.tasks.some(
        (task) =>
          task.kind === "letter.reply_generation" &&
          task.status === "retryable",
      ),
    ).toBe(true);
    expect(developerTasks.body).not.toMatch(
      /PRIVATE-RETRY-SOURCE|claimToken|payload|idempotencyKey/iu,
    );
    const retryingMailbox = await app.inject({
      method: "GET",
      url: `/api/agents/${secondAgentId}/correspondence`,
    });
    expect(retryingMailbox.statusCode).toBe(200);
    expect(
      retryingMailbox
        .json<CorrespondenceMailboxResponse>()
        .threads.find((thread) => thread.status === "open")?.replyState,
    ).toEqual({
      kind: "waiting",
      incomingLetterId: secondIncomingId,
    });
    expect(retryingMailbox.body).not.toMatch(
      /simulated provider outage|letter_reply_model_failed|taskId|runId|snapshotId/iu,
    );

    publishSpy.mockClear();
    clock.setUtc(SEPTEMBER_15);
    const arrivedDirectDetail = await app.inject({
      method: "GET",
      url: `/api/letters/${firstReply!.id}`,
    });
    expect(arrivedDirectDetail.statusCode).toBe(200);
    expect(arrivedDirectDetail.json<LetterDetailResponse>()).toMatchObject({
      letter: {
        id: firstReply!.id,
        direction: "agent_to_user",
        status: "delivered_unread",
        canOpen: true,
      },
    });
    expect(arrivedDirectDetail.body).not.toMatch(
      /subject|body|salutation|closing|signature|PRIVATE-DIRECT-DETAIL|ciphertext|authTag/iu,
    );
    expect(
      publishSpy.mock.calls.some(
        ([event]) =>
          event.type === "letter.arrived" &&
          (event.data as { letterId?: string }).letterId === firstReply!.id,
      ),
    ).toBe(true);
  }, 30_000);

  it("projects a terminal reply failure without leaking task or model details", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-correspondence-failed-"));
    const databasePath = join(directory, "correspondence.db");
    const clock = new FakeClock(SEPTEMBER_3);
    app = await startApp(databasePath, "enforced", clock, []);
    const agentId = await createPublishedAgent(app);
    const incomingLetterId = await createAndSealLetter(
      app,
      agentId,
      "terminal-reply-failure",
      "PRIVATE-FAILED-LETTER-BODY",
    );
    vi.spyOn(app.personasim.llm, "generateObject").mockResolvedValueOnce({
      subject: "不会提交的回信",
      salutation: "你好。",
      paragraphs: ["这份输出必须被证据边界拒绝。"],
      closing: "祝安。",
      signature: "Correspondent",
      referencedEvidenceIds: ["future-evidence-private-id"],
    });

    clock.setUtc(SEPTEMBER_9);
    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });

    expect(response.statusCode).toBe(200);
    const mailbox = response.json<CorrespondenceMailboxResponse>();
    expect(mailbox.threads).toEqual([
      expect.objectContaining({
        agentId,
        status: "open",
        latestLetterId: incomingLetterId,
        replyState: {
          kind: "failed",
          incomingLetterId,
          canRetry: true,
        },
      }),
    ]);
    expect(response.body).not.toMatch(
      /future-evidence-private-id|letter_reply_evidence_out_of_scope|taskId|runId|snapshotId|provider|model|claimToken|idempotencyKey|ciphertext|authTag|resultHash/iu,
    );
    const failedTask =
      app.personasim.correspondenceRepository.findLatestGenerationTask(
        incomingLetterId,
      );
    expect(failedTask).toMatchObject({
      status: "dead_letter",
      lastErrorCode: "letter_reply_evidence_out_of_scope",
    });

    const foreignAgentId = await createPublishedAgent(app);
    const foreignTask =
      app.personasim.correspondenceRepository.createTemporalTask({
        id: "foreign-agent-generation-task",
        agentId: foreignAgentId,
        kind: "letter.generation_retry",
        entityId: incomingLetterId,
        dueAtUtc: SEPTEMBER_9,
        priority: 20,
        idempotencyKey: `foreign-agent-generation:${incomingLetterId}`,
        payload: failedTask!.payload,
        createdAtUtc: SEPTEMBER_9,
      });
    app.personasim.correspondenceRepository.claimDueTask({
      taskId: foreignTask.id,
      agentId: foreignAgentId,
      nowUtc: SEPTEMBER_9,
      leaseExpiresAtUtc: SEPTEMBER_10,
      claimToken: "foreign-agent-generation-claim",
    });
    app.personasim.correspondenceRepository.retryTask({
      taskId: foreignTask.id,
      claimToken: "foreign-agent-generation-claim",
      errorCode: "foreign_agent_task",
      nowUtc: SEPTEMBER_9,
      retryable: false,
    });
    const foreignTaskResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(
      foreignTaskResponse
        .json<CorrespondenceMailboxResponse>()
        .threads.find((thread) => thread.status === "open")?.replyState,
    ).toEqual({
      kind: "failed",
      incomingLetterId,
      canRetry: false,
    });

    await app.close();
    app = undefined;
    app = await startApp(databasePath, "off", clock, []);
    const pausedResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(
      pausedResponse
        .json<CorrespondenceMailboxResponse>()
        .threads.find((thread) => thread.status === "open")?.replyState,
    ).toEqual({
      kind: "failed",
      incomingLetterId,
      canRetry: false,
    });
  });
});

async function createPublishedAgent(app: PersonaSimApp): Promise<string> {
  const agentId = app.personasim.characters.createDemoCharacter().id;
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${agentId}/publish`,
  });
  expect(published.statusCode).toBe(200);
  return agentId;
}

async function createAndSealLetter(
  app: PersonaSimApp,
  agentId: string,
  requestPrefix: string,
  body: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/letters`,
    payload: {
      clientRequestId: `${requestPrefix}-create`,
      subject: "直达详情测试",
      body,
    },
  });
  expect(created.statusCode).toBe(201);
  const letterId = created.json<LetterDetailResponse>().letter.id;
  const sealed = await app.inject({
    method: "POST",
    url: `/api/letters/${letterId}/seal`,
    payload: { clientRequestId: `${requestPrefix}-seal` },
  });
  expect(sealed.statusCode).toBe(200);
  return letterId;
}

async function startApp(
  databasePath: string,
  correspondenceMode: "off" | "shadow" | "enforced",
  clock: FakeClock,
  observations: LlmLogicalCallEvent[],
): Promise<PersonaSimApp> {
  return buildApp({
    config: readConfig({
      nodeEnv: "test",
      profile: "correspondence-stage4",
      databasePath,
      clockMode: "fake",
      fakeClockStart: clock.nowUtc(),
      seedDemo: false,
      developerRoutes: true,
      lifePlanningMode: "fuzzy",
      correspondenceMode,
      correspondenceExecution: "lazy",
      correspondenceTransitPolicy: "fixed_5d_v1",
      correspondenceGenerationLeaseMs: 1_800_000,
      correspondenceMaxOpenThreads: 1,
      instanceSecret: INSTANCE_SECRET,
      llm: {
        provider: "fixture",
        baseUrl: "https://example.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    }),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
    llmObservation: {
      onLogicalCall: (event) => observations.push(event),
    },
  });
}
