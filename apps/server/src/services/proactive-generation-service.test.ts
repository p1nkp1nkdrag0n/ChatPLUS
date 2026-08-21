import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock } from "../runtime/clock.js";
import { ConversationActivityTracker } from "./conversation-activity-tracker.js";
import {
  ProactiveGenerationRepository,
  type ProactiveSubjectRef,
} from "./proactive-generation-repository.js";
import {
  ProactiveGenerationService,
  type ProactiveGenerationPolicy,
} from "./proactive-generation-service.js";

const AGENT_ID = "agent-proactive-generation";
const SESSION_ID = "session-proactive-generation";
const EVENT_ID = "event-proactive-generation";
const CANDIDATE_ID = "candidate-proactive-generation";
const NOW_UTC = "2026-08-21T12:00:00.000Z";

describe("ProactiveGenerationService", () => {
  let database: Database;
  let clock: FakeClock;
  let repository: ProactiveGenerationRepository;
  let tracker: ConversationActivityTracker;
  let actorQueue: ActorQueue;
  let policy: ProactiveGenerationPolicy;
  let service: ProactiveGenerationService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedAgent(database);
    seedActivityCandidate(database);
    clock = new FakeClock(NOW_UTC);
    repository = new ProactiveGenerationRepository(database);
    tracker = new ConversationActivityTracker(database);
    actorQueue = new ActorQueue();
    policy = eligiblePolicy();
    service = new ProactiveGenerationService(
      repository,
      tracker,
      actorQueue,
      clock,
      () => policy,
    );
  });

  afterEach(() => {
    if (database.open) database.close();
  });

  it("claims, composes outside the actor transaction, and commits once", async () => {
    let composeInTransaction: boolean | undefined;
    const outcome = await service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: (context) => {
        composeInTransaction = database.inTransaction;
        expect(context).toMatchObject({
          agentId: AGENT_ID,
          sessionId: SESSION_ID,
          generationEpoch: 1,
          subject: { kind: "activity_candidate", id: CANDIDATE_ID },
        });
        return "The city walk was unexpectedly inspiring.";
      },
    });

    expect(composeInTransaction).toBe(false);
    expect(outcome).toMatchObject({
      status: "committed",
      message: {
        agentId: AGENT_ID,
        content: "The city walk was unexpectedly inspiring.",
        triggerEventId: EVENT_ID,
      },
    });
    const candidate = readCandidate(database);
    expect(candidate).toMatchObject({
      status: "sent",
      generationEpoch: 1,
      revision: 2,
    });
    expect(candidate.sentMessageId).toEqual(expect.any(String));
    expect(readOnlyRun(database)).toMatchObject({
      status: "committed",
      generationEpoch: 1,
      messageId: candidate.sentMessageId,
    });
    expect(proactiveMessageCount(database)).toBe(1);

    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "must not run",
      }),
    ).resolves.toEqual({
      status: "not_claimed",
      reasonCode: "no_delivery_subject",
    });
    expect(proactiveMessageCount(database)).toBe(1);
  });

  it("preserves delivery idempotency after reopening the same SQLite file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personasim-proactive-"));
    const databasePath = join(directory, "proactive.sqlite");
    const firstDatabase = openDatabase(databasePath);
    runMigrations(firstDatabase);
    seedAgent(firstDatabase);
    seedActivityCandidate(firstDatabase);
    const sharedClock = new FakeClock(NOW_UTC);
    const firstService = new ProactiveGenerationService(
      new ProactiveGenerationRepository(firstDatabase),
      new ConversationActivityTracker(firstDatabase),
      new ActorQueue(),
      sharedClock,
      () => eligiblePolicy(),
    );

    const first = await firstService.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: () => "The city walk held up after reopening.",
    });
    expect(first.status).toBe("committed");
    expect(proactiveMessageCount(firstDatabase)).toBe(1);
    firstDatabase.close();

    const reopened = openDatabase(databasePath);
    runMigrations(reopened);
    const reopenedService = new ProactiveGenerationService(
      new ProactiveGenerationRepository(reopened),
      new ConversationActivityTracker(reopened),
      new ActorQueue(),
      sharedClock,
      () => eligiblePolicy(),
    );
    await expect(
      reopenedService.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "must not run",
      }),
    ).resolves.toEqual({
      status: "not_claimed",
      reasonCode: "no_delivery_subject",
    });
    expect(proactiveMessageCount(reopened)).toBe(1);
    expect(readCandidate(reopened)).toMatchObject({
      status: "sent",
      revision: 2,
    });
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("releases the actor during compose and rejects a user arrival epoch overtake", async () => {
    const started = deferred<void>();
    const releaseCompose = deferred<void>();
    const first = service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        expect(database.inTransaction).toBe(false);
        started.resolve();
        await releaseCompose.promise;
        return "A stale generated message.";
      },
    });
    await started.promise;

    let actorProgressed = false;
    await actorQueue.runExclusive(AGENT_ID, () => {
      actorProgressed = true;
    });
    expect(actorProgressed).toBe(true);
    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "must not run",
      }),
    ).resolves.toEqual({
      status: "not_claimed",
      reasonCode: "generation_in_progress",
    });

    const userTurn = tracker.beginUserTurn(AGENT_ID);
    releaseCompose.resolve();
    await expect(first).resolves.toMatchObject({
      status: "discarded",
      reasonCode: "user_returned",
    });
    userTurn.end();
    expect(readCandidate(database)).toMatchObject({
      status: "pending",
      generationEpoch: 1,
      claimToken: null,
    });
    expect(readOnlyRun(database)).toMatchObject({
      status: "stale_discarded",
      reasonCode: "user_returned",
    });
    expect(proactiveMessageCount(database)).toBe(0);
  });

  it("uses persisted user and all-message high-water marks during postflight", async () => {
    const userStarted = deferred<void>();
    const releaseUser = deferred<void>();
    const userGeneration = service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        userStarted.resolve();
        await releaseUser.promise;
        return "Discard after persisted user message.";
      },
    });
    await userStarted.promise;
    insertMessage(database, {
      id: "message-user-overtake",
      role: "user",
      messageKind: "user",
      content: "I returned while generation was running.",
    });
    releaseUser.resolve();
    await expect(userGeneration).resolves.toMatchObject({
      status: "discarded",
      reasonCode: "user_returned",
    });

    const retryStarted = deferred<void>();
    const releaseRetry = deferred<void>();
    const retry = service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        retryStarted.resolve();
        await releaseRetry.promise;
        return "Discard after another message.";
      },
    });
    await retryStarted.promise;
    insertMessage(database, {
      id: "message-system-overtake",
      role: "system",
      messageKind: "system_notice",
      content: "A system notice arrived.",
    });
    releaseRetry.resolve();
    await expect(retry).resolves.toMatchObject({
      status: "discarded",
      reasonCode: "new_message_arrived",
    });
    expect(proactiveMessageCount(database)).toBe(0);
    expect(readCandidate(database).generationEpoch).toBe(2);
  });

  it("fences agent revisions and source expiry at postflight", async () => {
    const revisionStarted = deferred<void>();
    const releaseRevision = deferred<void>();
    const revisionGeneration = service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        revisionStarted.resolve();
        await releaseRevision.promise;
        return "Discard after state change.";
      },
    });
    await revisionStarted.promise;
    database
      .prepare(
        "UPDATE runtime_states SET revision = revision + 1 WHERE agent_id = ?",
      )
      .run(AGENT_ID);
    releaseRevision.resolve();
    await expect(revisionGeneration).resolves.toMatchObject({
      status: "discarded",
      reasonCode: "agent_revision_changed",
    });

    const expiryStarted = deferred<void>();
    const releaseExpiry = deferred<void>();
    const expiryGeneration = service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        expiryStarted.resolve();
        await releaseExpiry.promise;
        return "Discard after expiry.";
      },
    });
    await expiryStarted.promise;
    clock.setUtc("2026-08-24T12:00:00.000Z");
    releaseExpiry.resolve();
    await expect(expiryGeneration).resolves.toMatchObject({
      status: "discarded",
      reasonCode: "source_expired",
    });
    expect(proactiveMessageCount(database)).toBe(0);
  });

  it("records compose failure, releases the claim, and permits a new epoch", async () => {
    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => {
          throw new Error("fixture compose failure");
        },
      }),
    ).resolves.toMatchObject({
      status: "failed",
      reasonCode: "compose_failed",
    });
    expect(readOnlyRun(database)).toMatchObject({
      status: "failed",
      reasonCode: "compose_failed",
    });
    expect(readCandidate(database)).toMatchObject({
      status: "pending",
      generationEpoch: 1,
      claimToken: null,
    });

    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "A successful retry on a new epoch.",
      }),
    ).resolves.toMatchObject({ status: "committed" });
    expect(readCandidate(database)).toMatchObject({
      status: "sent",
      generationEpoch: 2,
    });
    expect(proactiveMessageCount(database)).toBe(1);
  });

  it("terminalizes a claim when postflight infrastructure fails", async () => {
    let policyLoads = 0;
    const failingService = new ProactiveGenerationService(
      repository,
      tracker,
      actorQueue,
      clock,
      () => {
        policyLoads += 1;
        if (policyLoads > 1) {
          throw new Error("fixture postflight policy failure");
        }
        return policy;
      },
    );

    await expect(
      failingService.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "Content whose postflight will fail.",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      reasonCode: "postflight_failed",
    });
    expect(readOnlyRun(database)).toMatchObject({
      status: "failed",
      reasonCode: "postflight_failed",
    });
    expect(readCandidate(database)).toMatchObject({
      status: "pending",
      claimToken: null,
    });
  });

  it("sends a FollowUpIntent at most once and links its message", async () => {
    database
      .prepare("DELETE FROM proactive_candidates WHERE id = ?")
      .run(CANDIDATE_ID);
    insertMessage(database, {
      id: "message-followup-source",
      role: "user",
      messageKind: "user",
      content: "My thesis defense is this afternoon.",
      createdAtUtc: "2026-08-20T12:00:00.000Z",
    });
    seedFollowUp(database);

    const outcome = await service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      subject: { kind: "follow_up", id: "followup-generation" },
      compose: () => "How did your thesis defense go?",
    });
    expect(outcome).toMatchObject({
      status: "committed",
      message: {
        triggerFollowUpIntentId: "followup-generation",
      },
    });
    const storedFollowUp = readFollowUp(database);
    expect(storedFollowUp).toMatchObject({
      status: "sent",
      maxAttempts: 1,
      attemptCount: 1,
      generationEpoch: 1,
    });
    expect(typeof storedFollowUp.sentMessageId).toBe("string");
    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        subject: { kind: "follow_up", id: "followup-generation" },
        compose: () => "must not send twice",
      }),
    ).resolves.toEqual({
      status: "not_claimed",
      reasonCode: "source_not_pending",
    });
    expect(proactiveMessageCount(database)).toBe(1);
  });

  it("blocks active conversations and structurally rejects CareCue delivery", async () => {
    const lease = tracker.beginUserTurn(AGENT_ID);
    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "must not run",
      }),
    ).resolves.toEqual({
      status: "not_claimed",
      reasonCode: "active_conversation",
    });
    lease.end();

    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        subject: {
          kind: "care_cue",
          id: "carecue-never-deliver",
        } as unknown as ProactiveSubjectRef,
        compose: () => "must not run",
      }),
    ).resolves.toEqual({
      status: "not_claimed",
      reasonCode: "subject_not_found",
    });
    expect(countGenerationRuns(database)).toBe(0);
  });
});

function eligiblePolicy(): ProactiveGenerationPolicy {
  return {
    tierSupportsProactive: true,
    policyEnabled: true,
    quietHours: false,
    timezone: "UTC",
    dailyLimit: 2,
    relationshipCloseness: 0.9,
    minimumCloseness: 0.4,
    maximumUnanswered: 2,
    activeConversationWindowMs: 0,
  };
}

function seedAgent(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, 1, 'published', 'high_fidelity', ?, 'original', ?, ?)`,
    )
    .run(AGENT_ID, "Generation Agent", NOW_UTC, NOW_UTC);
  database
    .prepare(
      `INSERT INTO runtime_states(
        agent_id, state_json, revision, updated_at_utc
      ) VALUES (?, '{}', 0, ?)`,
    )
    .run(AGENT_ID, NOW_UTC);
  database
    .prepare(
      `INSERT INTO sessions(
        id, agent_id, title, created_at_utc, updated_at_utc
      ) VALUES (?, ?, 'Generation test', ?, ?)`,
    )
    .run(SESSION_ID, AGENT_ID, NOW_UTC, NOW_UTC);
}

function seedActivityCandidate(database: Database): void {
  database
    .prepare(
      `INSERT INTO activity_events(
        id, agent_id, event_type, occurred_at_utc, summary,
        outcome_facts_json, state_delta_json, origin, idempotency_key,
        event_json
      ) VALUES (
        ?, ?, 'completed', ?, 'Completed a city walk.', '[]', '{}',
        'deterministic', 'event:proactive-generation', '{}'
      )`,
    )
    .run(EVENT_ID, AGENT_ID, "2026-08-21T11:00:00.000Z");
  database
    .prepare(
      `INSERT INTO proactive_candidates(
        id, agent_id, trigger_event_id, intent, summary, draft_message,
        earliest_at_utc, expires_at_utc, priority, cooldown_key, status,
        created_at_utc
      ) VALUES (
        ?, ?, ?, 'share_experience', 'Completed a city walk.',
        'The city walk was worth sharing.', ?, ?, 0.9,
        'share:walk:2026-08-21', 'pending', ?
      )`,
    )
    .run(
      CANDIDATE_ID,
      AGENT_ID,
      EVENT_ID,
      "2026-08-21T11:30:00.000Z",
      "2026-08-23T12:00:00.000Z",
      NOW_UTC,
    );
}

function seedFollowUp(database: Database): void {
  database
    .prepare(
      `INSERT INTO follow_up_intents(
        id, agent_id, session_id, subject_type, context_summary,
        expected_outcome_description, source_message_id, earliest_at_utc,
        expires_at_utc, status, max_attempts, attempt_count, dedupe_key,
        revision, generation_epoch, created_at_utc, updated_at_utc
      ) VALUES (
        'followup-generation', ?, ?, 'user_event',
        'The user had a thesis defense.',
        'How the thesis defense went.', 'message-followup-source',
        '2026-08-21T11:00:00.000Z', '2026-08-22T12:00:00.000Z',
        'pending', 1, 0, 'followup:generation', 0, 0, ?, ?
      )`,
    )
    .run(AGENT_ID, SESSION_ID, NOW_UTC, NOW_UTC);
}

function insertMessage(
  database: Database,
  input: {
    id: string;
    role: "user" | "assistant" | "system";
    messageKind: "user" | "assistant_reply" | "system_notice";
    content: string;
    createdAtUtc?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO messages(
        id, session_id, agent_id, role, content, message_kind,
        metadata_json, created_at_utc
      ) VALUES (
        @id, @sessionId, @agentId, @role, @content, @messageKind, '{}',
        @createdAtUtc
      )`,
    )
    .run({
      ...input,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      createdAtUtc: input.createdAtUtc ?? NOW_UTC,
    });
}

function readCandidate(database: Database): {
  status: string;
  generationEpoch: number;
  revision: number;
  claimToken: string | null;
  sentMessageId: string | null;
} {
  const row = database
    .prepare(
      `SELECT status, generation_epoch AS generationEpoch, revision,
              claim_token AS claimToken, sent_message_id AS sentMessageId
       FROM proactive_candidates WHERE id = ?`,
    )
    .get(CANDIDATE_ID) as ReturnType<typeof readCandidate>;
  return row;
}

function readFollowUp(database: Database): {
  status: string;
  maxAttempts: number;
  attemptCount: number;
  generationEpoch: number;
  sentMessageId: string | null;
} {
  return database
    .prepare(
      `SELECT status, max_attempts AS maxAttempts,
              attempt_count AS attemptCount,
              generation_epoch AS generationEpoch,
              sent_message_id AS sentMessageId
       FROM follow_up_intents WHERE id = 'followup-generation'`,
    )
    .get() as ReturnType<typeof readFollowUp>;
}

function readOnlyRun(database: Database): {
  status: string;
  generationEpoch: number;
  messageId: string | null;
  reasonCode: string | null;
} {
  return database
    .prepare(
      `SELECT status, generation_epoch AS generationEpoch,
              message_id AS messageId, reason_code AS reasonCode
       FROM proactive_generation_runs
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as ReturnType<typeof readOnlyRun>;
}

function proactiveMessageCount(database: Database): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE message_kind = 'assistant_proactive'`,
    )
    .get() as { count: number };
  return Number(row.count);
}

function countGenerationRuns(database: Database): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM proactive_generation_runs")
    .get() as { count: number };
  return Number(row.count);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}
