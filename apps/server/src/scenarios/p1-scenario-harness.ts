// P1-15 executable scenario harness.
import {
  MemorySchema,
  type AutobiographyRevisionProposal,
  type ContinuityEvidenceRef,
  type Memory,
} from "@personasim/contracts";
import {
  assembleChatPrompt,
  buildAutobiographyProjection,
  estimateCheckpointTokens,
  selectConversationRetentionWindow,
  validateAutobiographyRevision,
} from "@personasim/features";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock } from "../runtime/clock.js";
import { AutobiographyService } from "../services/autobiography-service.js";
import {
  CheckpointService,
  type CheckpointAutobiographyModel,
  type CheckpointAutobiographyModelInput,
} from "../services/checkpoint-service.js";
import { ContinuityIndexService } from "../services/continuity-index-service.js";
import { ContinuityMemoryRepository } from "../services/continuity-memory-repository.js";
import { ContinuityRepository } from "../services/continuity-repository.js";
import { ConversationActivityTracker } from "../services/conversation-activity-tracker.js";
import { DateDigestService } from "../services/date-digest-service.js";
import { FollowUpRepository } from "../services/follow-up-repository.js";
import { FollowUpService } from "../services/follow-up-service.js";
import { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import { ProactiveGenerationRepository } from "../services/proactive-generation-repository.js";
import {
  ProactiveGenerationService,
  type ProactiveGenerationPolicy,
} from "../services/proactive-generation-service.js";

export const P1_SCENARIO_NAMES = [
  "party-invite",
  "self-initiated",
  "night-life",
  "false-memory",
  "offline-72h",
  "trip-share",
  "user-followup",
  "30-day-life",
  "checkpoint-conflict",
  "date-recall",
] as const;

export type P1ScenarioName = (typeof P1_SCENARIO_NAMES)[number];

export interface P1ScenarioAssertion {
  code: string;
  passed: true;
  detail: string;
}

export interface P1ScenarioReport {
  scenario: P1ScenarioName;
  acceptanceCriterion: string;
  initialCharacter: unknown;
  initialState: unknown;
  initialSchedule: unknown[];
  input: unknown;
  proposal: unknown;
  acceptedEffects: unknown[];
  rejectedEffects: unknown[];
  domainEvents: unknown[];
  finalState: unknown;
  memories: unknown[];
  proactiveCandidates: unknown[];
  tokenCost: {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    modelCalls: number;
  };
  assertions: P1ScenarioAssertion[];
}

const AGENT_ID = "agent-p1-scenario";
const SESSION_ID = "session-p1-scenario";
const NOW_UTC = "2026-08-21T12:00:00.000Z";
const RETENTION_POLICY = {
  fullVerbatimHours: 0,
  softTokenLimit: 256,
  hardTokenLimit: 512,
  minimumTailTokens: 1,
  minimumRecentTurns: 1,
} as const;

const ACCEPTANCE_CRITERIA: Record<P1ScenarioName, string> = {
  "party-invite": "planned facts never become occurred facts",
  "self-initiated": "proactive generation cannot overtake a returning user",
  "night-life": "checkpoint compression retains original messages",
  "false-memory": "a reliable later conflict supersedes the older memory",
  "offline-72h": "prompt size stays bounded by retained context, not history",
  "trip-share": "autobiography entries retain a verified evidence chain",
  "user-followup": "FollowUpIntent resolves or cancels conservatively",
  "30-day-life": "30 days under FakeClock remain stable and bounded",
  "checkpoint-conflict": "derived continuity indexes are fully rebuildable",
  "date-recall": "date recall never returns facts outside the resolved range",
};

export function isP1ScenarioName(value: string): value is P1ScenarioName {
  return (P1_SCENARIO_NAMES as readonly string[]).includes(value);
}

export async function runP1Scenario(
  scenario: P1ScenarioName,
): Promise<P1ScenarioReport> {
  switch (scenario) {
    case "party-invite":
      return runPlannedIsNotOccurred();
    case "self-initiated":
      return runUserOvertakeFence();
    case "night-life":
      return runOriginalMessageRetention();
    case "false-memory":
      return runMemorySupersede();
    case "offline-72h":
      return runBoundedPrompt();
    case "trip-share":
      return runAutobiographyEvidence();
    case "user-followup":
      return runFollowUpLifecycle();
    case "30-day-life":
      return runThirtyDayContinuity();
    case "checkpoint-conflict":
      return runIndexRebuild();
    case "date-recall":
      return runDateRecall();
  }
}

function runPlannedIsNotOccurred(): P1ScenarioReport {
  const evidence = {
    id: "evidence-party-plan",
    sourceType: "message_archive" as const,
    sourceId: "message-party-plan",
    text: "I plan to attend the party tomorrow evening.",
    sourceReport:
      "我在对话中说过：「I plan to attend the party tomorrow evening.」",
    temporalStatus: "planned" as const,
    reliability: "reported" as const,
  };
  const occurredProposal = {
    summaryFirstPerson: "I attended the party.",
    entries: [
      {
        entryKind: "important_experience" as const,
        content: "I attended the party.",
        temporalStatus: "occurred" as const,
        evidence: [evidenceRef(evidence)],
      },
    ],
  };
  const plannedProposal = {
    summaryFirstPerson: evidence.sourceReport,
    entries: [
      {
        entryKind: "active_goal" as const,
        content: evidence.sourceReport,
        temporalStatus: "planned" as const,
        evidence: [evidenceRef(evidence)],
      },
    ],
  };
  const rejected = validateAutobiographyRevision({
    proposal: occurredProposal,
    evidenceCatalog: [evidence],
  });
  const accepted = validateAutobiographyRevision({
    proposal: plannedProposal,
    evidenceCatalog: [evidence],
  });
  invariant(
    !rejected.accepted &&
      rejected.issues.some(
        (issue) => issue.code === "occurred_without_occurrence_evidence",
      ),
    "planned evidence was incorrectly accepted as an occurred event",
  );
  invariant(accepted.accepted, "the truthful planned projection was rejected");
  const projection = buildAutobiographyProjection({
    proposal: plannedProposal,
    validation: accepted,
  });
  invariant(
    projection?.activeGoals.length === 1,
    "the accepted planned fact was not projected as an active goal",
  );

  return makeReport("party-invite", {
    initialState: { temporalStatus: "planned" },
    input: evidence.text,
    proposal: occurredProposal,
    acceptedEffects: [projection],
    rejectedEffects: rejected.issues,
    finalState: { temporalStatus: "planned" },
    assertions: [
      passed(
        "planned_not_occurred",
        "Occurrence requires reliable occurred/in-progress evidence.",
      ),
    ],
  });
}

function runBoundedPrompt(): P1ScenarioReport {
  const shortHistory = promptHistory(20);
  const hugeHistory = promptHistory(10_000);
  const shortPrompt = assembleChatPrompt(promptInput(shortHistory));
  const hugePrompt = assembleChatPrompt(promptInput(hugeHistory));
  const shortSize = shortPrompt.system.length + shortPrompt.prompt.length;
  const hugeSize = hugePrompt.system.length + hugePrompt.prompt.length;
  invariant(
    hugePrompt.prompt === shortPrompt.prompt,
    "prompt changed when only discarded historical messages were added",
  );
  invariant(hugeSize === shortSize, "prompt grew with total message count");
  invariant(hugeSize < 40_000, "prompt exceeded the executable upper bound");

  return makeReport("offline-72h", {
    initialState: { historyMessages: shortHistory.length },
    input: { historyMessages: hugeHistory.length, maxRecentMessages: 20 },
    proposal: { promptCharacters: hugeSize },
    acceptedEffects: [{ retainedMessages: 20 }],
    rejectedEffects: [{ discardedMessages: hugeHistory.length - 20 }],
    finalState: {
      shortHistoryPromptCharacters: shortSize,
      hugeHistoryPromptCharacters: hugeSize,
    },
    tokenCost: {
      estimatedInputTokens: estimateCheckpointTokens(
        hugePrompt.system + hugePrompt.prompt,
      ),
      estimatedOutputTokens: 0,
      modelCalls: 0,
    },
    assertions: [
      passed(
        "prompt_history_bounded",
        "20 and 10,000-message histories produce the same bounded prompt tail.",
      ),
    ],
  });
}
async function runUserOvertakeFence(): Promise<P1ScenarioReport> {
  return withDatabase(async (database) => {
    seedAgent(database);
    seedProactiveCandidate(database);
    const clock = new FakeClock(NOW_UTC);
    const tracker = new ConversationActivityTracker(database);
    const repository = new ProactiveGenerationRepository(database);
    const service = new ProactiveGenerationService(
      repository,
      tracker,
      new ActorQueue(),
      clock,
      () => eligibleProactivePolicy(),
    );
    const composeStarted = deferred<void>();
    const releaseCompose = deferred<void>();
    const generation = service.generate({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      compose: async () => {
        invariant(
          !database.inTransaction,
          "proactive composition ran inside a database transaction",
        );
        composeStarted.resolve();
        await releaseCompose.promise;
        return "This generated message must be fenced as stale.";
      },
    });
    await composeStarted.promise;
    const lease = tracker.beginUserTurn(AGENT_ID);
    releaseCompose.resolve();
    const outcome = await generation;
    lease.end();
    const proactiveMessageCount = countRows(
      database,
      "messages",
      "message_kind = 'assistant_proactive'",
    );
    invariant(
      outcome.status === "discarded" && outcome.reasonCode === "user_returned",
      "a user arrival did not invalidate in-flight proactive generation",
    );
    invariant(
      proactiveMessageCount === 0,
      "a stale proactive message crossed the postflight fence",
    );

    return makeReport("self-initiated", {
      initialState: { userArrivalEpoch: 0, generationEpoch: 0 },
      input: { userArrivedDuringCompose: true },
      proposal: "This generated message must be fenced as stale.",
      rejectedEffects: [outcome],
      domainEvents: readDomainEvents(database),
      finalState: {
        activity: tracker.snapshot(AGENT_ID),
        proactiveMessageCount,
      },
      proactiveCandidates: readRows(
        database,
        "SELECT id, status, generation_epoch, claim_token FROM proactive_candidates",
      ),
      assertions: [
        passed(
          "user_overtake_fenced",
          "Postflight discarded generation after the arrival epoch changed.",
        ),
        passed(
          "compose_outside_transaction",
          "Async composition ran outside the actor transaction.",
        ),
      ],
      modelCalls: 1,
    });
  });
}

async function runOriginalMessageRetention(): Promise<P1ScenarioReport> {
  return withDatabase(async (database) => {
    seedAgent(database);
    insertLargeTurns(database, 5, "night market memory");
    const rawBefore = messageCount(database);
    const fixture = createCheckpointFixture(database, new FakeClock(NOW_UTC));
    const result = await fixture.checkpoints.createIfNeeded({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    const rawAfter = messageCount(database);
    const archivedAfter = fixture.repository.listArchivedMessages(SESSION_ID);
    invariant(result.status === "committed", "checkpoint was not committed");
    invariant(rawAfter === rawBefore, "checkpoint removed original messages");
    invariant(
      archivedAfter.length === rawBefore,
      "the verbatim archive does not mirror all original messages",
    );

    return makeReport("night-life", {
      initialState: { rawMessageCount: rawBefore },
      input: { requestedCheckpoint: true },
      proposal: result,
      acceptedEffects: [result],
      domainEvents: readDomainEvents(database),
      finalState: {
        rawMessageCount: rawAfter,
        archivedMessageCount: archivedAfter.length,
      },
      memories: readRows(
        database,
        "SELECT id, summary_first_person, source_evidence_ids_json FROM autobiography_snapshots",
      ),
      assertions: [
        passed(
          "original_messages_retained",
          `${rawAfter} raw messages remain after checkpoint commit.`,
        ),
      ],
      modelCalls: 1,
    });
  });
}

async function runMemorySupersede(): Promise<P1ScenarioReport> {
  return withDatabase((database) => {
    seedAgent(database);
    const store = new DatabaseStore(database);
    persistLifecycleMemory(database, {
      id: "memory-old-goal",
      content: "I plan to prepare for the entrance exam.",
      recordedAtUtc: "2026-07-01T00:00:00.000Z",
      disposition: "affirmed",
    });
    persistLifecycleMemory(database, {
      id: "memory-new-cancellation",
      content: "I decided to cancel the entrance exam plan.",
      recordedAtUtc: "2026-08-20T00:00:00.000Z",
      disposition: "cancelled",
    });
    const lifecycle = new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(NOW_UTC),
    );
    const result = lifecycle.reconcile({
      existingMemoryId: "memory-old-goal",
      incomingMemoryId: "memory-new-cancellation",
    });
    const oldMemory = database
      .prepare(
        "SELECT status, superseded_by_id FROM memories WHERE id = 'memory-old-goal'",
      )
      .get() as { status: string; superseded_by_id: string | null };
    invariant(
      result.reconciliation.kind === "supersede",
      "the reliable later cancellation did not supersede the old claim",
    );
    invariant(
      oldMemory.status === "superseded" &&
        oldMemory.superseded_by_id === "memory-new-cancellation",
      "the supersede transition was not persisted",
    );

    return makeReport("false-memory", {
      initialState: { oldMemoryStatus: "active" },
      input: {
        existingMemoryId: "memory-old-goal",
        incomingMemoryId: "memory-new-cancellation",
      },
      proposal: result.reconciliation,
      acceptedEffects: [oldMemory],
      domainEvents: readDomainEvents(database),
      finalState: oldMemory,
      memories: readRows(
        database,
        "SELECT id, status, superseded_by_id FROM memories ORDER BY id",
      ),
      assertions: [
        passed(
          "conflict_superseded",
          "The later explicit cancellation is the persisted winner.",
        ),
      ],
    });
  });
}

async function runAutobiographyEvidence(): Promise<P1ScenarioReport> {
  return withDatabase(async (database) => {
    seedAgent(database);
    insertLargeTurns(database, 5, "mountain trip evidence");
    const fixture = createCheckpointFixture(database, new FakeClock(NOW_UTC));
    const result = await fixture.checkpoints.createIfNeeded({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    invariant(result.status === "committed", "checkpoint was not committed");
    const autobiography = fixture.repository.getLatestAutobiography(AGENT_ID);
    invariant(autobiography !== undefined, "autobiography was not persisted");
    const evidenceIds = autobiography.snapshot.sourceEvidenceIds;
    const entryEvidenceIds = autobiography.entries.flatMap(
      (entry) => entry.sourceEvidenceIds,
    );
    const cardEvidenceIds = result.eventCards.flatMap(
      (card) => card.sourceEvidenceIds,
    );
    invariant(evidenceIds.length > 0, "autobiography has no source evidence");
    invariant(
      evidenceIds.every(
        (id) => entryEvidenceIds.includes(id) && cardEvidenceIds.includes(id),
      ),
      "autobiography, entries, and event cards do not share evidence lineage",
    );
    const archiveIds = new Set(
      fixture.repository
        .listArchivedMessages(SESSION_ID)
        .map((item) => item.id),
    );
    invariant(
      autobiography.entries.every((entry) =>
        entry.evidence.every(
          (ref) =>
            ref.sourceType === "message_archive" &&
            archiveIds.has(ref.sourceId),
        ),
      ),
      "autobiography evidence does not point to retained verbatim messages",
    );

    return makeReport("trip-share", {
      initialState: { autobiographyRevision: 0 },
      input: { conversationTopic: "mountain trip" },
      proposal: result,
      acceptedEffects: autobiography.entries,
      domainEvents: readDomainEvents(database),
      finalState: autobiography.snapshot,
      memories: autobiography.entries,
      assertions: [
        passed(
          "autobiography_evidence_chain",
          "Snapshot, entry, card, and message archive share verified ids.",
        ),
      ],
      modelCalls: 1,
    });
  });
}
async function runFollowUpLifecycle(): Promise<P1ScenarioReport> {
  return withDatabase((database) => {
    seedAgent(database);
    const clock = new FakeClock(NOW_UTC);
    const repository = new FollowUpRepository(database);
    const service = new FollowUpService(repository, clock);

    insertMessage(database, {
      id: "message-defense-source",
      role: "user",
      content: "My thesis defense is tomorrow.",
      createdAtUtc: NOW_UTC,
    });
    const defense = service.createFollowUp({
      agentId: AGENT_ID,
      sourceMessageId: "message-defense-source",
      timezone: "UTC",
      candidate: {
        subjectType: "user_event",
        contextSummary: "The user's thesis defense is tomorrow.",
        expectedOutcomeDescription: "Whether the thesis defense passed.",
        timingHint: "tomorrow afternoon",
        evidenceQuotes: ["thesis defense is tomorrow"],
        reasonCode: "future_user_event",
        reasonSummary: "A bounded event can be followed up once.",
      },
    });
    invariant(defense.accepted, "defense FollowUpIntent was rejected");

    insertMessage(database, {
      id: "message-unrelated",
      role: "user",
      content: "The interview went well.",
      createdAtUtc: "2026-08-21T13:00:00.000Z",
    });
    const unrelated = service.handleUserMessage({
      agentId: AGENT_ID,
      messageId: "message-unrelated",
    });
    invariant(
      unrelated.resolvedFollowUpIds.length === 0 &&
        unrelated.cancelledFollowUpIds.length === 0,
      "an unrelated message resolved a FollowUpIntent",
    );

    insertMessage(database, {
      id: "message-defense-result",
      role: "user",
      content: "The thesis defense passed and is over.",
      createdAtUtc: "2026-08-22T18:00:00.000Z",
    });
    clock.setUtc("2026-08-22T18:00:00.000Z");
    const resolved = service.handleUserMessage({
      agentId: AGENT_ID,
      messageId: "message-defense-result",
    });
    invariant(
      resolved.resolvedFollowUpIds.includes(defense.followUp.id),
      "an explicit same-subject outcome did not resolve the FollowUpIntent",
    );

    insertMessage(database, {
      id: "message-race-source",
      role: "user",
      content: "The city race is tomorrow.",
      createdAtUtc: "2026-08-22T18:01:00.000Z",
    });
    const race = service.createFollowUp({
      agentId: AGENT_ID,
      sourceMessageId: "message-race-source",
      timezone: "UTC",
      candidate: {
        subjectType: "user_event",
        contextSummary: "The user plans to attend the city race.",
        expectedOutcomeDescription: "How the city race went.",
        timingHint: "tomorrow evening",
        evidenceQuotes: ["city race is tomorrow"],
        reasonCode: "future_user_event",
        reasonSummary: "A bounded event can be followed up once.",
      },
    });
    invariant(race.accepted, "race FollowUpIntent was rejected");
    insertMessage(database, {
      id: "message-race-cancelled",
      role: "user",
      content: "The city race was cancelled, so I will not attend.",
      createdAtUtc: "2026-08-22T18:02:00.000Z",
    });
    const cancelled = service.handleUserMessage({
      agentId: AGENT_ID,
      messageId: "message-race-cancelled",
    });
    invariant(
      cancelled.cancelledFollowUpIds.includes(race.followUp.id),
      "an explicit same-subject cancellation did not cancel the FollowUpIntent",
    );
    const rows = readRows(
      database,
      "SELECT id, status, max_attempts, attempt_count, resolution_message_id FROM follow_up_intents ORDER BY id",
    );
    invariant(
      rows.every((row) => row["max_attempts"] === 1),
      "a FollowUpIntent exceeded maxAttempts=1",
    );

    return makeReport("user-followup", {
      initialState: { pendingFollowUps: 0 },
      input: [
        "The thesis defense passed and is over.",
        "The city race was cancelled.",
      ],
      proposal: [defense, race],
      acceptedEffects: [resolved, cancelled],
      rejectedEffects: [unrelated],
      domainEvents: readDomainEvents(database),
      finalState: rows,
      proactiveCandidates: rows,
      assertions: [
        passed(
          "followup_conservative_resolution",
          "Only explicit same-subject result/cancellation messages transition intents.",
        ),
        passed("followup_max_attempts_one", "Every intent has maxAttempts=1."),
      ],
    });
  });
}

async function runThirtyDayContinuity(): Promise<P1ScenarioReport> {
  return withDatabase(async (database) => {
    const startUtc = "2026-07-22T12:00:00.000Z";
    seedAgent(database, startUtc);
    const clock = new FakeClock(startUtc);
    const fixture = createCheckpointFixture(database, clock);
    let committedCheckpoints = 0;
    let maximumLiveTailTokens = 0;
    const checkpointStatuses: string[] = [];

    for (let day = 0; day < 30; day += 1) {
      const userId = `message-day-${day}-user`;
      const createdAtUtc = clock.nowUtc();
      insertMessage(database, {
        id: userId,
        role: "user",
        content: `day ${day} mountain routine `.repeat(12),
        createdAtUtc,
      });
      insertMessage(database, {
        id: `message-day-${day}-assistant`,
        role: "assistant",
        content: `day ${day} mountain routine reply `.repeat(12),
        createdAtUtc: new Date(Date.parse(createdAtUtc) + 60_000).toISOString(),
        inReplyToMessageId: userId,
      });
      const checkpoint = await fixture.checkpoints.createIfNeeded({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      });
      checkpointStatuses.push(checkpoint.status);
      invariant(
        checkpoint.status === "skipped" || checkpoint.status === "committed",
        `30-day checkpoint entered unexpected state: ${checkpoint.status}`,
      );
      if (checkpoint.status === "committed") committedCheckpoints += 1;

      const latest =
        fixture.repository.getLatestCommittedCheckpoint(SESSION_ID);
      const selection = selectConversationRetentionWindow({
        messages: fixture.repository.listArchivedMessages(SESSION_ID),
        nowUtc: clock.nowUtc(),
        policy: RETENTION_POLICY,
        ...(latest === undefined
          ? {}
          : { checkpointThroughMessageId: latest.throughMessageId }),
      });
      maximumLiveTailTokens = Math.max(
        maximumLiveTailTokens,
        selection.liveTailTokenEstimate,
      );
      invariant(
        selection.liveTailTokenEstimate <= RETENTION_POLICY.hardTokenLimit,
        `live tail exceeded hard limit on day ${day}`,
      );
      clock.advance({ days: 1 });
    }

    const expectedEndUtc = "2026-08-21T12:00:00.000Z";
    const rawMessages = messageCount(database);
    const archivedMessages =
      fixture.repository.listArchivedMessages(SESSION_ID).length;
    invariant(
      clock.nowUtc() === expectedEndUtc,
      "FakeClock drifted over 30 days",
    );
    invariant(rawMessages === 60, "30-day run lost or duplicated raw messages");
    invariant(
      archivedMessages === rawMessages,
      "30-day archive diverged from the original-message ledger",
    );
    invariant(
      committedCheckpoints > 0,
      "30-day run never committed a checkpoint",
    );

    return makeReport("30-day-life", {
      initialState: { clockUtc: startUtc, rawMessages: 0 },
      input: { days: 30, turnsPerDay: 1 },
      proposal: { checkpointStatuses },
      acceptedEffects: [{ committedCheckpoints }],
      domainEvents: readDomainEvents(database),
      finalState: {
        clockUtc: clock.nowUtc(),
        rawMessages,
        archivedMessages,
        maximumLiveTailTokens,
        committedCheckpoints,
      },
      memories: readRows(
        database,
        "SELECT id, revision, source_evidence_ids_json FROM autobiography_snapshots ORDER BY revision",
      ),
      assertions: [
        passed("fake_clock_30_days", "FakeClock advanced exactly 30 UTC days."),
        passed(
          "continuity_ledger_stable",
          "All 60 original messages remain raw and archived.",
        ),
        passed(
          "continuity_tail_bounded",
          `Maximum live tail was ${maximumLiveTailTokens}/${RETENTION_POLICY.hardTokenLimit} tokens.`,
        ),
      ],
      modelCalls: committedCheckpoints,
    });
  });
}

async function runIndexRebuild(): Promise<P1ScenarioReport> {
  return withDatabase(async (database) => {
    seedAgent(database);
    insertLargeTurns(database, 5, "mountain checkpoint conflict");
    const fixture = createCheckpointFixture(database, new FakeClock(NOW_UTC));
    const checkpoint = await fixture.checkpoints.createIfNeeded({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    invariant(
      checkpoint.status === "committed",
      "checkpoint was not committed",
    );
    const rawMessageCount = messageCount(database);
    database
      .prepare("DELETE FROM message_archive WHERE agent_id = ?")
      .run(AGENT_ID);
    database
      .prepare("DELETE FROM event_cards WHERE agent_id = ?")
      .run(AGENT_ID);
    invariant(
      fixture.index.searchVerbatim({
        agentId: AGENT_ID,
        query: "mountain",
      }).length === 0,
      "verbatim index deletion fixture failed",
    );
    const first = fixture.index.rebuildAgent(AGENT_ID);
    const firstVerbatim = fixture.index.searchVerbatim({
      agentId: AGENT_ID,
      query: "mountain",
    });
    const firstCards = fixture.index.searchEventCards({
      agentId: AGENT_ID,
      query: "mountain",
    });
    const second = fixture.index.rebuildAgent(AGENT_ID);
    invariant(
      first.archivedMessageCount === rawMessageCount &&
        second.archivedMessageCount === rawMessageCount,
      "message archive could not be rebuilt exactly from source messages",
    );
    invariant(
      first.eventCardCount > 0 &&
        second.eventCardCount === first.eventCardCount,
      "event-card rebuild is empty or non-idempotent",
    );
    invariant(
      firstVerbatim.length > 0 && firstCards.length > 0,
      "rebuilt indexes are not searchable",
    );
    invariant(
      messageCount(database) === rawMessageCount,
      "index rebuild mutated source messages",
    );

    return makeReport("checkpoint-conflict", {
      initialState: {
        rawMessageCount,
        archivedMessageCount: 0,
        eventCardCount: 0,
      },
      input: { rebuildAgentId: AGENT_ID },
      proposal: first,
      acceptedEffects: [first, second],
      domainEvents: readDomainEvents(database),
      finalState: {
        rawMessageCount: messageCount(database),
        verbatimHits: firstVerbatim.length,
        eventCardHits: firstCards.length,
        rebuild: second,
      },
      memories: firstCards,
      assertions: [
        passed(
          "derived_indexes_rebuildable",
          "Two rebuilds produced identical counts and searchable results.",
        ),
      ],
    });
  });
}

async function runDateRecall(): Promise<P1ScenarioReport> {
  return withDatabase((database) => {
    seedAgent(database);
    insertActivity(
      database,
      "activity-inside",
      "2026-08-20T10:00:00.000Z",
      "Completed a reliable mountain walk.",
    );
    insertActivity(
      database,
      "activity-before-range",
      "2026-08-19T23:59:59.999Z",
      "This event is just before the range.",
    );
    insertActivity(
      database,
      "activity-after-range",
      "2026-08-21T00:00:00.000Z",
      "This event is exactly at the exclusive end.",
    );
    const service = new DateDigestService(
      new ContinuityMemoryRepository(new DatabaseStore(database)),
    );
    const result = service.query({
      agentId: AGENT_ID,
      text: "yesterday",
      nowUtc: NOW_UTC,
      timezone: "UTC",
    });
    invariant(
      result.resolution.kind === "resolved",
      "date query was unresolved",
    );
    invariant(result.digest !== undefined, "date query produced no digest");
    const range = result.resolution;
    const items = result.digest.items;
    invariant(
      items.map((item) => item.sourceId).join(",") === "activity-inside",
      "date digest included an out-of-range fact",
    );
    invariant(
      items.every((item) => {
        const at = Date.parse(item.occurredStartAtUtc);
        return at >= Date.parse(range.fromUtc) && at < Date.parse(range.toUtc);
      }),
      "date digest violated its half-open range",
    );

    return makeReport("date-recall", {
      initialState: { activities: 3 },
      input: { text: "yesterday", nowUtc: NOW_UTC, timezone: "UTC" },
      proposal: result.resolution,
      acceptedEffects: items,
      rejectedEffects: [
        { sourceId: "activity-before-range" },
        { sourceId: "activity-after-range" },
      ],
      finalState: result.digest,
      assertions: [
        passed(
          "date_range_safe",
          "Only facts within [fromUtc, toUtc) entered the digest.",
        ),
      ],
    });
  });
}
type ReportFields = Partial<
  Omit<P1ScenarioReport, "scenario" | "acceptanceCriterion" | "tokenCost">
> & {
  modelCalls?: number;
  tokenCost?: P1ScenarioReport["tokenCost"];
};

function makeReport(
  scenario: P1ScenarioName,
  fields: ReportFields,
): P1ScenarioReport {
  const input = fields.input ?? null;
  const proposal = fields.proposal ?? null;
  return {
    scenario,
    acceptanceCriterion: ACCEPTANCE_CRITERIA[scenario],
    initialCharacter: fields.initialCharacter ?? {
      id: AGENT_ID,
      name: "P1 Scenario Character",
      tier: "high_fidelity",
    },
    initialState: fields.initialState ?? {},
    initialSchedule: fields.initialSchedule ?? [],
    input,
    proposal,
    acceptedEffects: fields.acceptedEffects ?? [],
    rejectedEffects: fields.rejectedEffects ?? [],
    domainEvents: fields.domainEvents ?? [],
    finalState: fields.finalState ?? {},
    memories: fields.memories ?? [],
    proactiveCandidates: fields.proactiveCandidates ?? [],
    tokenCost: fields.tokenCost ?? {
      estimatedInputTokens: estimateCheckpointTokens(JSON.stringify(input)),
      estimatedOutputTokens: estimateCheckpointTokens(JSON.stringify(proposal)),
      modelCalls: fields.modelCalls ?? 0,
    },
    assertions: fields.assertions ?? [],
  };
}

function passed(code: string, detail: string): P1ScenarioAssertion {
  return { code, passed: true, detail };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`P1 scenario invariant failed: ${message}`);
}

function evidenceRef(input: {
  id: string;
  sourceType: "message_archive";
  sourceId: string;
}): {
  id: string;
  sourceType: "message_archive";
  sourceId: string;
} {
  return {
    id: input.id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  };
}

function promptHistory(
  count: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content:
      index % 2 === 0
        ? "A bounded user history message."
        : "A bounded assistant history message.",
  }));
}

function promptInput(
  recentMessages: Array<{
    role: "user" | "assistant";
    content: string;
  }>,
): Parameters<typeof assembleChatPrompt>[0] {
  return {
    character: {
      id: AGENT_ID,
      version: 1,
      tier: "high_fidelity",
      sourceType: "original",
      identity: {
        name: "P1 Scenario Character",
        workOrRole: "continuity tester",
        worldSetting: "a deterministic simulation",
        selfDescription: "I notice details and preserve evidence.",
        timezone: "UTC",
      },
      persona: {
        traits: [],
        values: [],
        contradictions: [],
        goals: [],
        preferences: [],
        boundaries: [],
      },
      dialogue: {
        verbosity: 0.5,
        averageMessageLength: 120,
        averageChunksPerTurn: 1,
        formality: 0.4,
        directness: 0.7,
      },
      userRelationship: {},
      routines: [],
      schedulePolicy: {},
      proactivePolicy: {},
      knowledge: {
        knownFacts: [],
        uncertainFacts: [],
        forbiddenMetaKnowledge: [],
      },
      sources: [],
    },
    state: {
      agentId: AGENT_ID,
      asOfUtc: NOW_UTC,
      moodValence: 0,
      moodArousal: 0.5,
      energy: 0.7,
      stress: 0.2,
      socialBattery: 0.7,
      focus: 0.7,
      sleepDebtMinutes: 0,
      locationContext: "home",
      revision: 0,
    },
    schedule: [],
    memories: [],
    recentMessages,
    nowUtc: NOW_UTC,
    userMessage: "How are you?",
    maxRecentMessages: 20,
    maxMemories: 12,
  };
}

class ScenarioCheckpointModel implements CheckpointAutobiographyModel {
  async generateAutobiography(
    input: CheckpointAutobiographyModelInput,
  ): Promise<AutobiographyRevisionProposal> {
    await Promise.resolve();
    const evidence = input.evidence[0];
    if (evidence === undefined) {
      throw new Error("Scenario checkpoint requires verified evidence.");
    }
    const content = evidence.text.replace(/\s+/gu, " ").trim().slice(0, 240);
    return {
      summaryFirstPerson: content,
      entries: [
        {
          entryKind: "important_experience",
          content,
          temporalStatus: "unknown",
          evidence: [toContinuityEvidenceRef(evidence)],
        },
      ],
    };
  }
}

function toContinuityEvidenceRef(
  evidence: CheckpointAutobiographyModelInput["evidence"][number],
): ContinuityEvidenceRef {
  return {
    id: evidence.id,
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    ...(evidence.quote === undefined ? {} : { quote: evidence.quote }),
    ...(evidence.contextSummary === undefined
      ? {}
      : { contextSummary: evidence.contextSummary }),
    ...(evidence.temporalStatus === undefined
      ? {}
      : { temporalStatus: evidence.temporalStatus }),
    reliability: evidence.reliability,
    recordedAtUtc: evidence.recordedAtUtc,
  };
}

function createCheckpointFixture(
  database: Database,
  clock: FakeClock,
): {
  repository: ContinuityRepository;
  index: ContinuityIndexService;
  checkpoints: CheckpointService;
} {
  const repository = new ContinuityRepository(new DatabaseStore(database));
  const autobiography = new AutobiographyService(repository);
  const index = new ContinuityIndexService(repository, clock);
  return {
    repository,
    index,
    checkpoints: new CheckpointService(
      repository,
      clock,
      new ScenarioCheckpointModel(),
      autobiography,
      index,
      RETENTION_POLICY,
    ),
  };
}

async function withDatabase<T>(
  operation: (database: Database) => T | Promise<T>,
): Promise<T> {
  const database = openDatabase(":memory:");
  runMigrations(database);
  try {
    return await operation(database);
  } finally {
    if (database.open) database.close();
  }
}

function seedAgent(database: Database, createdAtUtc = NOW_UTC): void {
  database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, 1, 'published', 'high_fidelity', ?, 'original', ?, ?)`,
    )
    .run(AGENT_ID, "P1 Scenario Character", createdAtUtc, createdAtUtc);
  database
    .prepare(
      `INSERT INTO runtime_states(
        agent_id, state_json, revision, updated_at_utc
      ) VALUES (?, '{}', 0, ?)`,
    )
    .run(AGENT_ID, createdAtUtc);
  database
    .prepare(
      `INSERT INTO sessions(
        id, agent_id, title, created_at_utc, updated_at_utc
      ) VALUES (?, ?, 'P1 scenario', ?, ?)`,
    )
    .run(SESSION_ID, AGENT_ID, createdAtUtc, createdAtUtc);
}

function insertMessage(
  database: Database,
  input: {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAtUtc: string;
    inReplyToMessageId?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO messages(
        id, session_id, agent_id, role, content, message_kind,
        in_reply_to_message_id, metadata_json, created_at_utc
      ) VALUES (
        @id, @sessionId, @agentId, @role, @content, @messageKind,
        @inReplyToMessageId, '{}', @createdAtUtc
      )`,
    )
    .run({
      ...input,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      messageKind: input.role === "user" ? "user" : "assistant_reply",
      inReplyToMessageId: input.inReplyToMessageId ?? null,
    });
}

function insertLargeTurns(
  database: Database,
  count: number,
  topic: string,
): void {
  const start = Date.parse("2026-08-20T01:00:00.000Z");
  for (let index = 0; index < count; index += 1) {
    const userId = `large-turn-${index}-user`;
    const createdAt = start + index * 3_600_000;
    insertMessage(database, {
      id: userId,
      role: "user",
      content: `turn ${index} ${topic} `.repeat(45),
      createdAtUtc: new Date(createdAt).toISOString(),
    });
    insertMessage(database, {
      id: `large-turn-${index}-assistant`,
      role: "assistant",
      content: `turn ${index} ${topic} reply `.repeat(45),
      createdAtUtc: new Date(createdAt + 60_000).toISOString(),
      inReplyToMessageId: userId,
    });
  }
}

function seedProactiveCandidate(database: Database): void {
  database
    .prepare(
      `INSERT INTO activity_events(
        id, agent_id, event_type, occurred_at_utc, summary,
        outcome_facts_json, state_delta_json, origin, idempotency_key,
        event_json
      ) VALUES (
        'event-proactive-scenario', ?, 'completed', ?,
        'Completed a city walk.', '[]', '{}', 'deterministic',
        'event:proactive-scenario', '{}'
      )`,
    )
    .run(AGENT_ID, "2026-08-21T11:00:00.000Z");
  database
    .prepare(
      `INSERT INTO proactive_candidates(
        id, agent_id, trigger_event_id, intent, summary, draft_message,
        earliest_at_utc, expires_at_utc, priority, cooldown_key, status,
        created_at_utc
      ) VALUES (
        'candidate-proactive-scenario', ?, 'event-proactive-scenario',
        'share_experience', 'Completed a city walk.',
        'The city walk was worth sharing.', ?, ?, 0.9,
        'share:walk:2026-08-21', 'pending', ?
      )`,
    )
    .run(
      AGENT_ID,
      "2026-08-21T11:30:00.000Z",
      "2026-08-23T12:00:00.000Z",
      NOW_UTC,
    );
}

function eligibleProactivePolicy(): ProactiveGenerationPolicy {
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
function persistLifecycleMemory(
  database: Database,
  input: {
    id: string;
    content: string;
    recordedAtUtc: string;
    disposition: "affirmed" | "cancelled";
  },
): void {
  const memory = MemorySchema.parse({
    id: input.id,
    agentId: AGENT_ID,
    kind: "commitment",
    content: input.content,
    importance: 0.6,
    confidence: 0.95,
    tags: ["entrance-exam"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "situational",
    claim: {
      subjectKey: "goal:entrance_exam",
      disposition: input.disposition,
      recordedAtUtc: input.recordedAtUtc,
    },
    status: "active",
    dedupeKey: `dedupe:${input.id}`,
    createdAtUtc: input.recordedAtUtc,
    updatedAtUtc: input.recordedAtUtc,
  });
  persistMemory(database, memory);
}

function persistMemory(database: Database, memory: Memory): void {
  const temporal = memory.temporalMetadata;
  database
    .prepare(
      `INSERT INTO memories(
        id, agent_id, type, content, tags_json, importance, confidence,
        source_message_id, source_event_id, created_at_utc, valid_until_utc,
        memory_json, namespace, certainty, attribution, stability, status,
        mentioned_at_utc, planned_start_at_utc, planned_end_at_utc,
        occurred_start_at_utc, occurred_end_at_utc, recorded_at_utc,
        temporal_certainty, temporal_status, claim_subject_key,
        claim_disposition, superseded_by_id, merged_into_id,
        last_reinforced_at_utc, lifecycle_updated_at_utc
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    )
    .run(
      memory.id,
      memory.agentId,
      memory.kind,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.confidence,
      memory.sourceMessageIds[0] ?? null,
      memory.sourceActivityEventIds[0] ?? null,
      memory.createdAtUtc,
      memory.expiresAtUtc ?? null,
      JSON.stringify(memory),
      memory.namespace ?? "runtime_simulation",
      memory.certainty ?? "uncertain",
      memory.attribution ?? "mixed",
      memory.stability ?? "situational",
      memory.status,
      temporal?.mentionedAtUtc ?? null,
      temporal?.plannedStartAtUtc ?? null,
      temporal?.plannedEndAtUtc ?? null,
      temporal?.occurredStartAtUtc ?? null,
      temporal?.occurredEndAtUtc ?? null,
      temporal?.recordedAtUtc ?? memory.createdAtUtc,
      temporal?.temporalCertainty ?? "unknown",
      temporal?.temporalStatus ?? "unknown",
      memory.claim?.subjectKey ?? null,
      memory.claim?.disposition ?? null,
      memory.supersededById ?? null,
      memory.mergedIntoId ?? null,
      memory.lastReinforcedAtUtc ?? memory.createdAtUtc,
      memory.lifecycleUpdatedAtUtc ?? memory.createdAtUtc,
    );
}

function insertActivity(
  database: Database,
  id: string,
  occurredAtUtc: string,
  summary: string,
): void {
  database
    .prepare(
      `INSERT INTO activity_events(
        id, agent_id, event_type, occurred_at_utc, summary,
        outcome_facts_json, state_delta_json, origin, idempotency_key,
        event_json
      ) VALUES (?, ?, 'completed', ?, ?, '[]', '{}', 'deterministic', ?, '{}')`,
    )
    .run(id, AGENT_ID, occurredAtUtc, summary, `activity:${id}`);
}

function messageCount(database: Database): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM messages WHERE agent_id = ?")
    .get(AGENT_ID) as { count: number };
  return Number(row.count);
}

function countRows(
  database: Database,
  table: "messages",
  where: "message_kind = 'assistant_proactive'",
): number {
  invariant(
    table === "messages" && where === "message_kind = 'assistant_proactive'",
    "unexpected count query",
  );
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE message_kind = 'assistant_proactive'",
    )
    .get() as { count: number };
  return Number(row.count);
}

function readRows(
  database: Database,
  sql: string,
): Array<Record<string, unknown>> {
  return database.prepare(sql).all() as Array<Record<string, unknown>>;
}

function readDomainEvents(database: Database): Array<Record<string, unknown>> {
  return readRows(
    database,
    `SELECT event_type, stream_type, stream_id, effective_at_utc,
            recorded_at_utc, payload_json
     FROM domain_events ORDER BY rowid`,
  );
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
