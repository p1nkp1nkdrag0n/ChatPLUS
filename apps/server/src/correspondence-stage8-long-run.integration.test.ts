import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CorrespondenceMailboxResponse,
  LetterDetailResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";
import type { LlmLogicalCallEvent } from "./services/llm-service.js";

const DISPATCHED_AT = "2026-09-03T04:00:00.000Z";
const FOUR_DAYS_LATER = "2026-09-07T04:00:00.000Z";
const INCOMING_ARRIVAL = "2026-09-08T04:00:00.000Z";
const FUTURE_CHAT_AT = "2026-09-09T04:00:00.000Z";
const REPLY_ARRIVAL = "2026-09-13T04:00:00.000Z";
const SEVEN_DAYS_LATE = "2026-09-15T04:00:00.000Z";
const RECOVERED_AT = "2026-09-15T04:02:00.000Z";
const ROLLED_BACK_AT = "2026-09-10T04:00:00.000Z";

const PRIMARY_SECRET = Buffer.alloc(32, 0x71).toString("base64");
const SECONDARY_SECRET = Buffer.alloc(32, 0x72).toString("base64");
const BEFORE_CUTOFF = "STAGE8_CHAT_BEFORE_ARRIVAL";
const AFTER_CUTOFF = "STAGE8_CHAT_AFTER_ARRIVAL_MUST_NOT_LEAK";

describe("Stage 8 correspondence long-run matrix", () => {
  const directories = new Set<string>();
  const apps = new Set<PersonaSimApp>();

  afterEach(async () => {
    await Promise.all(
      [...apps].map(async (app) => {
        await app.close();
      }),
    );
    apps.clear();
    for (const directory of directories) {
      rmSync(directory, { recursive: true, force: true });
    }
    directories.clear();
  });

  it("holds at 80% with zero reply calls, then freezes the exact +1 day cutoff", async () => {
    const directory = createDirectory("chatplus-stage8-cutoff-");
    const databasePath = join(directory, "instance.db");
    const clock = new FakeClock(DISPATCHED_AT);
    const observations: LlmLogicalCallEvent[] = [];
    const app = await startApp({
      databasePath,
      assetStoragePath: join(directory, "assets"),
      clock,
      observations,
    });
    apps.add(app);

    const agentId = await createPublishedAgent(app);
    seedCutoffMessages(app, agentId);
    const incomingLetterId = await createAndSealLetter(
      app,
      agentId,
      "stage8-cutoff",
    );

    clock.setUtc(FOUR_DAYS_LATER);
    const early = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(early.statusCode).toBe(200);
    const earlyBody = early.json<CorrespondenceMailboxResponse>();
    expect(earlyBody.letters).toHaveLength(1);
    expect(earlyBody.letters[0]).toMatchObject({
      id: incomingLetterId,
      status: "in_transit",
    });
    expect(earlyBody.letters[0]!.progress).toBeCloseTo(0.8, 8);
    expect(letterReplyStarts(observations)).toHaveLength(0);
    expect(countRows(app, "letter_generation_runs")).toBe(0);

    clock.setUtc(INCOMING_ARRIVAL);
    const exactArrival = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(exactArrival.statusCode).toBe(200);
    const exactBody = exactArrival.json<CorrespondenceMailboxResponse>();
    expect(exactBody.letters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: incomingLetterId,
          direction: "user_to_agent",
          status: "read",
        }),
        expect.objectContaining({
          direction: "agent_to_user",
          status: "in_transit",
          canOpen: false,
        }),
      ]),
    );
    expect(letterReplyStarts(observations)).toHaveLength(1);
    const replyLetterId = exactBody.letters.find(
      (letter) => letter.direction === "agent_to_user",
    )?.id;
    expect(typeof replyLetterId).toBe("string");
    if (replyLetterId === undefined) {
      throw new Error("Expected an in-transit reply at the arrival cutoff");
    }

    const snapshot =
      app.personasim.correspondenceRepository.getSnapshotForIncomingLetter(
        incomingLetterId,
      );
    expect(snapshot).toMatchObject({
      effectiveAtUtc: INCOMING_ARRIVAL,
      characterVersion: 1,
    });
    const frozenContext = JSON.stringify(snapshot?.contextJson);
    expect(frozenContext).toContain(BEFORE_CUTOFF);
    expect(frozenContext).not.toContain(AFTER_CUTOFF);
    expect(snapshot?.createdAtUtc).toBe(INCOMING_ARRIVAL);

    const replay = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(replay.statusCode).toBe(200);
    expect(letterReplyStarts(observations)).toHaveLength(1);
    expect(countReplies(app, incomingLetterId)).toBe(1);

    const encryptedBeforeCorrection = app.personasim.store.database
      .prepare(
        `SELECT content_hash AS contentHash,
                encrypted_ciphertext AS ciphertext,
                updated_at_utc AS updatedAtUtc
           FROM letters WHERE id = ?`,
      )
      .get(replyLetterId);
    clock.setUtc(FUTURE_CHAT_AT);
    const correction =
      "STAGE8_CORRECTION_AFTER_SNAPSHOT：目的地更正为苏州，不是杭州。";
    const session = app.personasim.conversations.createSession(agentId);
    const observationStart = observations.length;
    const chat = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: {
        agentId,
        clientMessageId: "stage8-in-transit-correction",
        text: correction,
      },
    });
    expect(chat.statusCode).toBe(201);
    const chatCall = observations
      .slice(observationStart)
      .find(
        (event) => event.stage === "started" && event.purpose === "chat_turn",
      );
    expect(chatCall).toMatchObject({ stage: "started", purpose: "chat_turn" });
    if (chatCall?.stage !== "started") {
      throw new Error("Expected a chat turn observation");
    }
    expect(chatCall.prompt).toContain(replyLetterId);
    expect(chatCall.prompt).toContain('"status":"in_transit"');
    expect(chatCall.prompt).not.toMatch(
      /ciphertext|authTag|encryptedBody|愿这封回信在路上替我陪你一程/iu,
    );
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT content_hash AS contentHash,
                  encrypted_ciphertext AS ciphertext,
                  updated_at_utc AS updatedAtUtc
             FROM letters WHERE id = ?`,
        )
        .get(replyLetterId),
    ).toEqual(encryptedBeforeCorrection);

    clock.setUtc(REPLY_ARRIVAL);
    const arrived = await app.inject({
      method: "GET",
      url: `/api/letters/${replyLetterId}`,
    });
    expect(arrived.statusCode).toBe(200);
    expect(arrived.body).not.toMatch(
      /subject|body|salutation|closing|signature|ciphertext|authTag/iu,
    );
    const opened = await app.inject({
      method: "POST",
      url: `/api/letters/${replyLetterId}/open`,
      payload: {},
    });
    expect(opened.statusCode).toBe(200);
    const openedBody = opened.json<OpenLetterResponse>().body;
    expect(openedBody).not.toContain("STAGE8_CORRECTION_AFTER_SNAPSHOT");
    expect(chatCall.prompt).not.toContain(openedBody);
    expect(letterReplyStarts(observations)).toHaveLength(1);
    expect(countReplies(app, incomingLetterId)).toBe(1);
  }, 30_000);

  it("recovers a seven-day-late crashed lease into one reply while preserving all clocks and the frozen character version", async () => {
    const directory = createDirectory("chatplus-stage8-recovery-");
    const databasePath = join(directory, "instance.db");
    const assetStoragePath = join(directory, "assets");
    let clock = new FakeClock(DISPATCHED_AT);
    let app = await startApp({ databasePath, assetStoragePath, clock });
    apps.add(app);

    const original = app.personasim.characters.createDemoCharacter();
    const originalName = original.identity.name;
    app.personasim.characters.publish(original.id);
    const agentId = original.id;
    const incomingLetterId = await createAndSealLetter(
      app,
      agentId,
      "stage8-late-recovery",
    );
    await closeTracked(app);

    clock = new FakeClock(SEVEN_DAYS_LATE);
    app = await startApp({
      databasePath,
      assetStoragePath,
      clock,
      mode: "shadow",
    });
    apps.add(app);

    const snapshot =
      app.personasim.correspondenceRepository.getSnapshotForIncomingLetter(
        incomingLetterId,
      );
    expect(snapshot).toMatchObject({
      effectiveAtUtc: INCOMING_ARRIVAL,
      createdAtUtc: SEVEN_DAYS_LATE,
      characterVersion: 1,
      contextJson: {
        character: {
          identity: { name: originalName },
        },
      },
    });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT delivered_effective_at_utc AS deliveredEffectiveAtUtc,
                  processed_at_utc AS processedAtUtc,
                  read_at_utc AS readAtUtc
             FROM letters WHERE id = ?`,
        )
        .get(incomingLetterId),
    ).toEqual({
      deliveredEffectiveAtUtc: INCOMING_ARRIVAL,
      processedAtUtc: SEVEN_DAYS_LATE,
      readAtUtc: INCOMING_ARRIVAL,
    });

    const versionTwoName = `${originalName}·第二版`;
    const versionTwoDraft = app.personasim.characters.updateDraft(agentId, {
      path: "identity.name",
      value: versionTwoName,
      expectedVersion: 1,
    });
    expect(versionTwoDraft.version).toBe(2);
    app.personasim.characters.publish(agentId, 2);
    expect(app.personasim.characters.get(agentId).spec).toMatchObject({
      version: 2,
      identity: { name: versionTwoName },
    });
    expect(
      app.personasim.correspondenceRepository.getSnapshot(
        snapshot?.id ?? "missing-snapshot",
      ),
    ).toMatchObject({
      characterVersion: 1,
      contextJson: { character: { identity: { name: originalName } } },
    });

    const generationTask =
      app.personasim.correspondenceRepository.getTaskByIdempotencyKey(
        `letter-reply-run:${incomingLetterId}:v1`,
      );
    expect(generationTask).toMatchObject({
      status: "pending",
      attempt: 0,
      dueAtUtc: INCOMING_ARRIVAL,
    });
    if (generationTask === undefined) {
      throw new Error("Expected the frozen snapshot to enqueue generation");
    }
    const claimToken = "stage8-crashed-generation-claim";
    const leaseExpiresAtUtc = "2026-09-15T04:01:00.000Z";
    const claimedTask = app.personasim.correspondenceRepository.claimDueTask({
      taskId: generationTask.id,
      nowUtc: SEVEN_DAYS_LATE,
      leaseExpiresAtUtc,
      claimToken,
    });
    expect(claimedTask).toMatchObject({
      status: "claimed",
      attempt: 1,
      claimToken,
    });
    const crashedRun =
      app.personasim.correspondenceRepository.claimGenerationRun({
        incomingLetterId,
        snapshotId: snapshot?.id ?? "missing-snapshot",
        snapshotHash: snapshot?.contextHash ?? "0".repeat(64),
        agentId,
        generationEpoch: 0,
        claimToken,
        nowUtc: SEVEN_DAYS_LATE,
        leaseExpiresAtUtc,
        provider: "fixture",
        model: "personasim-fixture-v1",
      });
    expect(crashedRun).toMatchObject({
      status: "generating",
      attempt: 1,
      leaseExpiresAtUtc,
    });
    await closeTracked(app);

    const recoveredObservations: LlmLogicalCallEvent[] = [];
    clock = new FakeClock(RECOVERED_AT);
    app = await startApp({
      databasePath,
      assetStoragePath,
      clock,
      observations: recoveredObservations,
    });
    apps.add(app);

    expect(letterReplyStarts(recoveredObservations)).toHaveLength(1);
    const committedRun =
      app.personasim.correspondenceRepository.getGenerationRunForEpoch(
        incomingLetterId,
        0,
      );
    expect(committedRun).toMatchObject({
      id: crashedRun?.id,
      status: "committed",
      attempt: 2,
    });
    expect(
      app.personasim.correspondenceRepository.getTask(generationTask.id),
    ).toMatchObject({ status: "completed", attempt: 2 });
    expect(countReplies(app, incomingLetterId)).toBe(1);

    const reply = app.personasim.store.database
      .prepare(
        `SELECT id, status,
                effective_author_time_utc AS effectiveAuthorTimeUtc,
                dispatched_at_utc AS dispatchedAtUtc,
                arrival_due_at_utc AS arrivalDueAtUtc,
                delivered_effective_at_utc AS deliveredEffectiveAtUtc,
                processed_at_utc AS processedAtUtc,
                created_at_utc AS createdAtUtc
           FROM letters
          WHERE reply_to_letter_id = ? AND direction = 'agent_to_user'`,
      )
      .get(incomingLetterId) as {
      id: string;
      status: string;
      effectiveAuthorTimeUtc: string;
      dispatchedAtUtc: string;
      arrivalDueAtUtc: string;
      deliveredEffectiveAtUtc: string;
      processedAtUtc: string;
      createdAtUtc: string;
    };
    expect(typeof reply.id).toBe("string");
    expect({ ...reply, id: undefined }).toEqual({
      id: undefined,
      status: "delivered_unread",
      effectiveAuthorTimeUtc: INCOMING_ARRIVAL,
      dispatchedAtUtc: INCOMING_ARRIVAL,
      arrivalDueAtUtc: REPLY_ARRIVAL,
      deliveredEffectiveAtUtc: REPLY_ARRIVAL,
      processedAtUtc: RECOVERED_AT,
      createdAtUtc: RECOVERED_AT,
    });

    const newSession = app.personasim.conversations.createSession(agentId);
    expect(newSession.title).toContain(versionTwoName);
    const chat = await app.inject({
      method: "POST",
      url: `/api/sessions/${newSession.id}/messages`,
      payload: {
        agentId,
        clientMessageId: "stage8-version-two-chat",
        text: "这是一条只会在第二版角色下发生的新会话。",
      },
    });
    expect(chat.statusCode).toBe(201);
    expect(app.personasim.characters.get(agentId).spec.version).toBe(2);
    expect(
      app.personasim.correspondenceRepository.getSnapshot(
        snapshot?.id ?? "missing-snapshot",
      )?.characterVersion,
    ).toBe(1);

    const terminalTimesBeforeRollback = app.personasim.store.database
      .prepare(
        `SELECT status,
                delivered_effective_at_utc AS deliveredEffectiveAtUtc,
                processed_at_utc AS processedAtUtc
           FROM letters WHERE id = ?`,
      )
      .get(reply.id);
    clock.setUtc(ROLLED_BACK_AT);
    const afterRollback = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/correspondence`,
    });
    expect(afterRollback.statusCode).toBe(200);
    expect(
      afterRollback
        .json<CorrespondenceMailboxResponse>()
        .letters.find((letter) => letter.id === reply.id),
    ).toMatchObject({
      status: "delivered_unread",
      canOpen: true,
      progress: 1,
    });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT status,
                  delivered_effective_at_utc AS deliveredEffectiveAtUtc,
                  processed_at_utc AS processedAtUtc
             FROM letters WHERE id = ?`,
        )
        .get(reply.id),
    ).toEqual(terminalTimesBeforeRollback);
    expect(letterReplyStarts(recoveredObservations)).toHaveLength(1);
    expect(countReplies(app, incomingLetterId)).toBe(1);
  }, 30_000);

  it("isolates two local instances across databases, instance keys, tasks, and asset roots", async () => {
    const firstDirectory = createDirectory("chatplus-stage8-instance-a-");
    const secondDirectory = createDirectory("chatplus-stage8-instance-b-");
    const firstDatabase = join(firstDirectory, "instance.db");
    const secondDatabase = join(secondDirectory, "instance.db");
    const firstAssets = join(firstDirectory, "assets");
    const secondAssets = join(secondDirectory, "assets");
    const firstClock = new FakeClock(SEVEN_DAYS_LATE);
    const secondClock = new FakeClock(SEVEN_DAYS_LATE);

    const first = await startApp({
      databasePath: firstDatabase,
      assetStoragePath: firstAssets,
      clock: firstClock,
      instanceSecret: PRIMARY_SECRET,
      keepsakeMode: "enforced",
    });
    apps.add(first);
    const second = await startApp({
      databasePath: secondDatabase,
      assetStoragePath: secondAssets,
      clock: secondClock,
      instanceSecret: SECONDARY_SECRET,
      keepsakeMode: "enforced",
    });
    apps.add(second);

    const firstAgent = await createPublishedAgent(first);
    const secondAgent = await createPublishedAgent(second);
    seedMilestone(
      first,
      firstAgent,
      "stage8-instance-a-milestone",
      "甲实例车票",
    );
    seedMilestone(
      second,
      secondAgent,
      "stage8-instance-b-milestone",
      "乙实例明信片",
    );

    const firstEnqueued = first.personasim.keepsakes.enqueueSource({
      agentId: firstAgent,
      sourceType: "relationship_milestone",
      sourceId: "stage8-instance-a-milestone",
      requestedKind: "ticket_stub",
    });
    const secondEnqueued = second.personasim.keepsakes.enqueueSource({
      agentId: secondAgent,
      sourceType: "relationship_milestone",
      sourceId: "stage8-instance-b-milestone",
      requestedKind: "postcard",
    });
    expect(firstEnqueued.taskId).toBeDefined();
    expect(secondEnqueued.taskId).toBeDefined();

    const [firstList, secondList] = await Promise.all([
      first.inject({
        method: "GET",
        url: `/api/agents/${firstAgent}/keepsakes`,
      }),
      second.inject({
        method: "GET",
        url: `/api/agents/${secondAgent}/keepsakes`,
      }),
    ]);
    expect(firstList.statusCode).toBe(200);
    expect(secondList.statusCode).toBe(200);
    expect(firstList.body).not.toContain(secondAgent);
    expect(secondList.body).not.toContain(firstAgent);
    expect(countRows(first, "keepsakes")).toBe(1);
    expect(countRows(second, "keepsakes")).toBe(1);
    expect(
      first.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM characters WHERE id = ?")
        .get(secondAgent),
    ).toEqual({ count: 0 });
    expect(
      second.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM characters WHERE id = ?")
        .get(firstAgent),
    ).toEqual({ count: 0 });

    const firstFingerprint = first.personasim.store.database
      .prepare(
        "SELECT fingerprint FROM correspondence_key_metadata WHERE id = 1",
      )
      .get() as { fingerprint: string };
    const secondFingerprint = second.personasim.store.database
      .prepare(
        "SELECT fingerprint FROM correspondence_key_metadata WHERE id = 1",
      )
      .get() as { fingerprint: string };
    expect(firstFingerprint.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondFingerprint.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstFingerprint).not.toEqual(secondFingerprint);

    const firstFiles = assetFiles(firstAssets);
    const secondFiles = assetFiles(secondAssets);
    expect(firstFiles.filter((path) => path.endsWith(".webp"))).toHaveLength(2);
    expect(secondFiles.filter((path) => path.endsWith(".webp"))).toHaveLength(
      2,
    );
    expect(firstAssets).not.toBe(secondAssets);

    await closeTracked(first);
    await closeTracked(second);
    let mismatchedKeyError: unknown;
    try {
      await startApp({
        databasePath: firstDatabase,
        assetStoragePath: firstAssets,
        clock: firstClock,
        instanceSecret: SECONDARY_SECRET,
      });
    } catch (error) {
      mismatchedKeyError = error;
    }
    expect(mismatchedKeyError).toMatchObject({
      code: "plugin_activation_failed",
      cause: { code: "CORRESPONDENCE_SECRET_MISMATCH" },
    });
  }, 30_000);

  function createDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    directories.add(directory);
    return directory;
  }

  async function closeTracked(app: PersonaSimApp): Promise<void> {
    apps.delete(app);
    await app.close();
  }
});

async function startApp(input: {
  databasePath: string;
  assetStoragePath: string;
  clock: FakeClock;
  mode?: "off" | "shadow" | "enforced";
  instanceSecret?: string;
  keepsakeMode?: "off" | "shadow" | "enforced";
  observations?: LlmLogicalCallEvent[];
}): Promise<PersonaSimApp> {
  return buildApp({
    config: readConfig({
      nodeEnv: "test",
      profile: "correspondence-stage8",
      databasePath: input.databasePath,
      assetStoragePath: input.assetStoragePath,
      clockMode: "fake",
      fakeClockStart: input.clock.nowUtc(),
      seedDemo: false,
      developerRoutes: true,
      lifePlanningMode: "fuzzy",
      correspondenceMode: input.mode ?? "enforced",
      correspondenceExecution: "lazy",
      correspondenceTransitPolicy: "fixed_5d_v1",
      correspondenceGenerationLeaseMs: 60_000,
      correspondenceMaxOpenThreads: 1,
      keepsakeMode: input.keepsakeMode ?? "off",
      instanceSecret: input.instanceSecret ?? PRIMARY_SECRET,
      llm: {
        provider: "fixture",
        baseUrl: "https://example.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    }),
    clock: input.clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
    ...(input.observations === undefined
      ? {}
      : {
          llmObservation: {
            onLogicalCall: (event) => input.observations!.push(event),
          },
        }),
  });
}

async function createPublishedAgent(app: PersonaSimApp): Promise<string> {
  const draft = app.personasim.characters.createDemoCharacter();
  const response = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
  });
  expect(response.statusCode).toBe(200);
  return draft.id;
}

async function createAndSealLetter(
  app: PersonaSimApp,
  agentId: string,
  requestPrefix: string,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/letters`,
    payload: {
      clientRequestId: `${requestPrefix}-create`,
      subject: "阶段八长运行信件",
      body: "这封信用于验证长期运行时的时间、隐私与幂等边界。",
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
  expect(sealed.json<LetterDetailResponse>().letter).toMatchObject({
    dispatchedAtUtc: DISPATCHED_AT,
    arrivalDueAtUtc: INCOMING_ARRIVAL,
  });
  return letterId;
}

function seedCutoffMessages(app: PersonaSimApp, agentId: string): void {
  app.personasim.store.database
    .prepare(
      `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
       VALUES (?, ?, 'Stage 8 cutoff', ?, ?)`,
    )
    .run(
      `session-stage8-cutoff-${agentId}`,
      agentId,
      DISPATCHED_AT,
      FUTURE_CHAT_AT,
    );
  const insert = app.personasim.store.database.prepare(
    `INSERT INTO messages(
       id, session_id, agent_id, role, content, message_kind,
       metadata_json, created_at_utc
     ) VALUES (?, ?, ?, 'user', ?, 'user', '{}', ?)`,
  );
  const sessionId = `session-stage8-cutoff-${agentId}`;
  insert.run(
    `message-stage8-before-${agentId}`,
    sessionId,
    agentId,
    BEFORE_CUTOFF,
    FOUR_DAYS_LATER,
  );
  insert.run(
    `message-stage8-after-${agentId}`,
    sessionId,
    agentId,
    AFTER_CUTOFF,
    FUTURE_CHAT_AT,
  );
}

function seedMilestone(
  app: PersonaSimApp,
  agentId: string,
  id: string,
  title: string,
): void {
  app.personasim.store.database
    .prepare(
      `INSERT INTO relationship_milestones(
         id, agent_id, session_id, kind, title, summary, significance,
         relationship_delta_json, intervention_ids_json, decision_ids_json,
         outcome_ids_json, reflection_ids_json, source_message_ids_json,
         effective_local_date, effective_period, temporal_precision,
         recorded_at_utc, idempotency_key, schema_version, milestone_json
       ) VALUES (?, ?, NULL, 'meaningful_support', ?, ?, 0.9, NULL,
                 '["stage8-intervention"]', '[]', '[]', '[]', ?,
                 '2026-09-15', NULL, 'day',
                 ?, ?, 1, ?)`,
    )
    .run(
      id,
      agentId,
      title,
      `${title}只属于当前本地实例。`,
      JSON.stringify([`source-message-${id}`]),
      SEVEN_DAYS_LATE,
      `milestone:${id}`,
      JSON.stringify({ tags: [id] }),
    );
}

function letterReplyStarts(
  observations: readonly LlmLogicalCallEvent[],
): LlmLogicalCallEvent[] {
  return observations.filter(
    (event) => event.stage === "started" && event.purpose === "letter_reply",
  );
}

function countRows(app: PersonaSimApp, table: string): number {
  return Number(
    (
      app.personasim.store.database
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number }
    ).count,
  );
}

function countReplies(app: PersonaSimApp, incomingLetterId: string): number {
  return Number(
    (
      app.personasim.store.database
        .prepare(
          `SELECT COUNT(*) AS count FROM letters
            WHERE reply_to_letter_id = ? AND direction = 'agent_to_user'`,
        )
        .get(incomingLetterId) as { count: number }
    ).count,
  );
}

function assetFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).map(String);
}
