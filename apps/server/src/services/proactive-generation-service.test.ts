import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock } from "../runtime/clock.js";
import { ConversationActivityTracker } from "./conversation-activity-tracker.js";
import { FollowUpRepository } from "./follow-up-repository.js";
import { FollowUpService } from "./follow-up-service.js";
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
const TEST_GENERATION_LEASE_MS = 60_000;

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

  it("recovers an abandoned generation lease after reopening the database", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "personasim-proactive-crash-"),
    );
    const databasePath = join(directory, "proactive.sqlite");
    const firstDatabase = openDatabase(databasePath);
    let reopenedDatabase: Database | undefined;
    try {
      runMigrations(firstDatabase);
      seedAgent(firstDatabase);
      seedActivityCandidate(firstDatabase);
      const firstRepository = new ProactiveGenerationRepository(firstDatabase);
      const firstTracker = new ConversationActivityTracker(firstDatabase);
      const revisions = firstRepository.readAgentRevisions(AGENT_ID);
      const subject = firstRepository.findNextDueSubject(AGENT_ID, NOW_UTC);
      if (revisions === undefined || subject === undefined) {
        throw new Error("Crash recovery fixture is incomplete.");
      }
      const activity = firstTracker.snapshot(AGENT_ID);
      const abandoned = firstRepository.transaction(() =>
        firstRepository.claimSubject({
          runId: "generation-abandoned-before-restart",
          claimToken: "claim-abandoned-before-restart",
          subject,
          sessionId: SESSION_ID,
          specVersion: revisions.specVersion,
          stateRevision: revisions.stateRevision,
          messageRowid: activity.messageRowid,
          lastUserMessageRowid: activity.lastUserMessageRowid,
          userArrivalEpoch: activity.userArrivalEpoch,
          snapshot: { fixture: "crash-before-postflight" },
          startedAtUtc: NOW_UTC,
        }),
      );
      expect(abandoned?.run.status).toBe("generating");
      firstDatabase.close();

      const restartedClock = new FakeClock(NOW_UTC);
      restartedClock.advance({ minutes: 2 });
      reopenedDatabase = openDatabase(databasePath);
      runMigrations(reopenedDatabase);
      const restartedService = new ProactiveGenerationService(
        new ProactiveGenerationRepository(reopenedDatabase),
        new ConversationActivityTracker(reopenedDatabase),
        new ActorQueue(),
        restartedClock,
        () => eligiblePolicy(),
        { generationLeaseMs: TEST_GENERATION_LEASE_MS },
      );

      await expect(
        restartedService.generate({
          agentId: AGENT_ID,
          sessionId: SESSION_ID,
          compose: () => "Recovered safely after the previous process stopped.",
        }),
      ).resolves.toMatchObject({ status: "committed" });
      expect(readGenerationRuns(reopenedDatabase)).toMatchObject([
        {
          id: "generation-abandoned-before-restart",
          status: "stale_discarded",
          generationEpoch: 1,
          reasonCode: "generation_lease_expired",
          messageId: null,
        },
        {
          status: "committed",
          generationEpoch: 2,
          reasonCode: null,
        },
      ]);
      expect(readCandidate(reopenedDatabase)).toMatchObject({
        status: "sent",
        generationEpoch: 2,
      });
      expect(proactiveMessageCount(reopenedDatabase)).toBe(1);
    } finally {
      if (firstDatabase.open) firstDatabase.close();
      if (reopenedDatabase?.open) reopenedDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fences generated content that returns after its lease expires", async () => {
    const leasedService = new ProactiveGenerationService(
      repository,
      tracker,
      actorQueue,
      clock,
      () => policy,
      { generationLeaseMs: TEST_GENERATION_LEASE_MS },
    );
    const composeStarted = deferred<void>();
    const releaseCompose = deferred<void>();
    const expiredGeneration = leasedService.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        composeStarted.resolve();
        await releaseCompose.promise;
        return "This result arrived after its generation lease.";
      },
    });
    await composeStarted.promise;
    clock.advance({ minutes: 2 });
    releaseCompose.resolve();

    await expect(expiredGeneration).resolves.toMatchObject({
      status: "discarded",
      reasonCode: "generation_lease_expired",
    });
    expect(readOnlyRun(database)).toMatchObject({
      status: "stale_discarded",
      reasonCode: "generation_lease_expired",
      messageId: null,
    });
    expect(readCandidate(database)).toMatchObject({
      status: "pending",
      generationEpoch: 1,
      claimToken: null,
      sentMessageId: null,
    });
    expect(proactiveMessageCount(database)).toBe(0);

    await expect(
      leasedService.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "A fresh generation epoch may commit.",
      }),
    ).resolves.toMatchObject({ status: "committed" });
    expect(readCandidate(database)).toMatchObject({
      status: "sent",
      generationEpoch: 2,
    });
    expect(proactiveMessageCount(database)).toBe(1);
  });

  it("rolls back a partial commit when the sent audit fails and permits retry", async () => {
    const composeStarted = deferred<void>();
    const releaseCompose = deferred<void>();
    const generation = service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        composeStarted.resolve();
        await releaseCompose.promise;
        return "This write will be rolled back with its failed audit.";
      },
    });
    await composeStarted.promise;
    database.exec(
      `CREATE TRIGGER reject_proactive_sent_audit
       BEFORE INSERT ON domain_events
       WHEN NEW.event_type = 'conversation.proactive_message_sent'
       BEGIN
         SELECT RAISE(ABORT, 'fixture proactive sent audit failure');
       END`,
    );
    releaseCompose.resolve();
    const failed = await generation;
    database.exec("DROP TRIGGER reject_proactive_sent_audit");

    expect(failed).toMatchObject({
      status: "failed",
      reasonCode: "postflight_failed",
    });
    expect(readOnlyRun(database)).toMatchObject({
      status: "failed",
      reasonCode: "postflight_failed",
      messageId: null,
    });
    expect(readCandidate(database)).toMatchObject({
      status: "pending",
      generationEpoch: 1,
      revision: 1,
      claimToken: null,
      sentMessageId: null,
    });
    expect(proactiveMessageCount(database)).toBe(0);
    expect(
      domainEventCount(database, "conversation.proactive_message_sent"),
    ).toBe(0);

    await expect(
      service.generate({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        compose: () => "The retry commits as a new fenced epoch.",
      }),
    ).resolves.toMatchObject({ status: "committed" });
    expect(readCandidate(database)).toMatchObject({
      status: "sent",
      generationEpoch: 2,
    });
    expect(proactiveMessageCount(database)).toBe(1);
    expect(
      domainEventCount(database, "conversation.proactive_message_sent"),
    ).toBe(1);
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

    database
      .prepare(
        "UPDATE proactive_candidates SET expires_at_utc = ? WHERE id = ?",
      )
      .run("2026-08-21T12:01:00.000Z", CANDIDATE_ID);

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
    clock.setUtc("2026-08-21T12:02:00.000Z");
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
      content: "My thesis defense is tomorrow morning.",
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

  it("keeps legacy pending rows unsendable without pretending the user cancelled", async () => {
    database
      .prepare("DELETE FROM proactive_candidates WHERE id = ?")
      .run(CANDIDATE_ID);
    insertMessage(database, {
      id: "message-followup-source",
      role: "user",
      messageKind: "user",
      content: "My thesis defense is tomorrow morning.",
      createdAtUtc: "2026-08-20T12:00:00.000Z",
    });
    seedFollowUp(database);
    const snapshot = repository.getSubject({
      kind: "follow_up",
      id: "followup-generation",
    });
    expect(snapshot).toBeDefined();
    database
      .prepare(
        "UPDATE follow_up_intents SET grounding_json = NULL WHERE id = 'followup-generation'",
      )
      .run();
    expect(repository.findNextDueSubject(AGENT_ID, NOW_UTC)).toBeUndefined();
    let composeCalls = 0;
    const outcome = await service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      subject: { kind: "follow_up", id: "followup-generation" },
      compose: () => {
        composeCalls += 1;
        return "How did it go?";
      },
    });
    expect(outcome.status).toBe("not_claimed");
    expect(composeCalls).toBe(0);
    expect(readFollowUp(database)).toMatchObject({
      status: "pending",
      generationEpoch: 0,
      attemptCount: 0,
    });
    if (snapshot === undefined)
      throw new Error("Expected previous valid source");
    expect(
      repository.claimSubject({
        runId: "legacy-bypass",
        claimToken: "claim",
        subject: snapshot,
        sessionId: SESSION_ID,
        specVersion: 1,
        stateRevision: 0,
        messageRowid: 0,
        lastUserMessageRowid: 0,
        userArrivalEpoch: 0,
        snapshot: {},
        startedAtUtc: NOW_UTC,
      }),
    ).toBeUndefined();
    const restored = new FollowUpService(
      new FollowUpRepository(database),
      clock,
    ).revalidateFollowUp({
      agentId: AGENT_ID,
      id: "followup-generation",
      timezone: "UTC",
    });
    expect(restored.accepted).toBe(true);
    expect(repository.findNextDueSubject(AGENT_ID, NOW_UTC)?.id).toBe(
      "followup-generation",
    );
  });

  it("rechecks source evidence after composition before a proactive follow-up is sent", async () => {
    database
      .prepare("DELETE FROM proactive_candidates WHERE id = ?")
      .run(CANDIDATE_ID);
    insertMessage(database, {
      id: "message-followup-source",
      role: "user",
      messageKind: "user",
      content: "My thesis defense is tomorrow morning.",
      createdAtUtc: "2026-08-20T12:00:00.000Z",
    });
    seedFollowUp(database);
    const outcome = await service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      subject: { kind: "follow_up", id: "followup-generation" },
      compose: () => {
        expect(database.inTransaction).toBe(false);
        database
          .prepare(
            "UPDATE messages SET content = 'That was a hypothetical defense.' WHERE id = 'message-followup-source'",
          )
          .run();
        return "How did your defense go?";
      },
    });
    expect(outcome.status).not.toBe("committed");
    expect(readFollowUp(database)).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE trigger_follow_up_intent_id = 'followup-generation'",
        )
        .get(),
    ).toEqual({ count: 0 });
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
  const source = "My thesis defense is tomorrow morning.";
  const created = new FollowUpService(
    new FollowUpRepository(database),
    new FakeClock("2026-08-20T12:00:00.000Z"),
  ).createFollowUp({
    agentId: AGENT_ID,
    sourceMessageId: "message-followup-source",
    timezone: "UTC",
    candidate: {
      subjectType: "user_event",
      contextSummary: source,
      expectedOutcomeDescription: "How the thesis defense went.",
      timingHint: "tomorrow morning",
      evidenceQuotes: [source],
      reasonCode: "future_user_event",
      reasonSummary: "A real source event.",
    },
  });
  if (!created.accepted) throw new Error("Expected verified follow-up fixture");
  database
    .prepare(
      "UPDATE follow_up_intents SET id = 'followup-generation' WHERE id = ?",
    )
    .run(created.followUp.id);
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

function readGenerationRuns(database: Database): Array<{
  id: string;
  status: string;
  generationEpoch: number;
  messageId: string | null;
  reasonCode: string | null;
}> {
  return database
    .prepare(
      `SELECT id, status, generation_epoch AS generationEpoch,
              message_id AS messageId, reason_code AS reasonCode
       FROM proactive_generation_runs ORDER BY rowid`,
    )
    .all() as ReturnType<typeof readGenerationRuns>;
}

function domainEventCount(database: Database, eventType: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?")
    .get(eventType) as { count: number };
  return Number(row.count);
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
