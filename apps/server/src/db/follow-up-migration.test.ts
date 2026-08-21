import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase, type Database } from "./connection.js";

const NOW_UTC = "2026-08-21T04:00:00.000Z";
const AGENT_ID = "agent-followup-migration";
const SESSION_ID = "session-followup-migration";
const USER_MESSAGE_ID = "message-followup-source";
const CANDIDATE_ID = "candidate-followup-migration";

describe("012 follow-up and proactive generation migration", () => {
  it("creates one-shot FollowUp and bounded CareCue lifecycle constraints", () => {
    const database = migratedDatabase();
    try {
      insertFollowUp(database);
      expect(
        database
          .prepare(
            "SELECT max_attempts AS maxAttempts, attempt_count AS attemptCount, generation_epoch AS generationEpoch FROM follow_up_intents WHERE id = ?",
          )
          .get("followup-1"),
      ).toEqual({
        maxAttempts: 1,
        attemptCount: 0,
        generationEpoch: 0,
      });

      expect(() =>
        insertFollowUp(database, {
          id: "followup-invalid-attempts",
          dedupeKey: "followup:v1:invalid-attempts",
          maxAttempts: 2,
        }),
      ).toThrow();
      expect(() =>
        insertFollowUp(database, {
          id: "followup-duplicate",
          dedupeKey: "followup:v1:review",
        }),
      ).toThrow();

      insertCareCue(database);
      expect(() =>
        insertCareCue(database, {
          id: "care-cue-invalid",
          dedupeKey: "carecue:v1:invalid",
          status: "active",
          mentionCount: 1,
          maxMentions: 1,
        }),
      ).toThrow();
      expect(
        database
          .prepare(
            "SELECT status, max_mentions AS maxMentions, mention_count AS mentionCount FROM care_cues WHERE id = ?",
          )
          .get("care-cue-1"),
      ).toEqual({
        status: "active",
        maxMentions: 1,
        mentionCount: 0,
      });
    } finally {
      database.close();
    }
  });

  it("extends existing candidates and messages without replacing their tables", () => {
    const database = migratedDatabase();
    try {
      insertFollowUp(database);
      const candidate = database
        .prepare(
          "SELECT generation_epoch AS generationEpoch, sent_message_id AS sentMessageId FROM proactive_candidates WHERE id = ?",
        )
        .get(CANDIDATE_ID);
      expect(candidate).toEqual({
        generationEpoch: 0,
        sentMessageId: null,
      });

      database
        .prepare(
          "INSERT INTO messages(id, session_id, agent_id, role, content, message_kind, trigger_follow_up_intent_id, created_at_utc) VALUES (?, ?, ?, 'assistant', ?, 'assistant_proactive', ?, ?)",
        )
        .run(
          "message-followup-proactive",
          SESSION_ID,
          AGENT_ID,
          "How did the portfolio review go?",
          "followup-1",
          "2026-08-22T12:00:00.000Z",
        );
      expect(
        database
          .prepare(
            "SELECT trigger_follow_up_intent_id AS triggerFollowUpIntentId FROM messages WHERE id = ?",
          )
          .get("message-followup-proactive"),
      ).toEqual({ triggerFollowUpIntentId: "followup-1" });

      const generationColumns = database
        .prepare("PRAGMA table_info(proactive_generation_runs)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(generationColumns).not.toContain("care_cue_id");
    } finally {
      database.close();
    }
  });

  it("fences generations by source epoch and permits only one active run per agent", () => {
    const database = migratedDatabase();
    try {
      insertFollowUp(database);
      insertGeneration(database, {
        id: "generation-candidate-1",
        sourceKind: "activity_candidate",
        proactiveCandidateId: CANDIDATE_ID,
        generationEpoch: 1,
        claimToken: "claim-candidate-1",
      });

      expect(() =>
        insertGeneration(database, {
          id: "generation-followup-concurrent",
          sourceKind: "follow_up",
          followUpIntentId: "followup-1",
          generationEpoch: 1,
          claimToken: "claim-followup-concurrent",
        }),
      ).toThrow();

      database
        .prepare(
          "UPDATE proactive_generation_runs SET status = 'stale_discarded', reason_code = 'user_returned', completed_at_utc = ? WHERE id = ?",
        )
        .run("2026-08-21T04:01:00.000Z", "generation-candidate-1");

      insertGeneration(database, {
        id: "generation-followup-1",
        sourceKind: "follow_up",
        followUpIntentId: "followup-1",
        generationEpoch: 1,
        claimToken: "claim-followup-1",
      });
      expect(() =>
        insertGeneration(database, {
          id: "generation-followup-duplicate-epoch",
          sourceKind: "follow_up",
          followUpIntentId: "followup-1",
          generationEpoch: 1,
          claimToken: "claim-followup-duplicate",
        }),
      ).toThrow();
      expect(() =>
        insertGeneration(database, {
          id: "generation-invalid-sources",
          sourceKind: "follow_up",
          proactiveCandidateId: CANDIDATE_ID,
          followUpIntentId: "followup-1",
          generationEpoch: 2,
          claimToken: "claim-invalid-sources",
        }),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});

function migratedDatabase(): Database {
  const database = openDatabase(":memory:");
  database.exec(migrationSql("001_initial.sql"));
  seedFoundation(database);
  database.exec(migrationSql("009_proactive_claim.sql"));
  database.exec(migrationSql("012_followup_care_proactive_generation.sql"));
  return database;
}

function seedFoundation(database: Database): void {
  database
    .prepare(
      "INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc) VALUES (?, 1, 'published', 'high_fidelity', 'FollowUp Migration', 'original', ?, ?)",
    )
    .run(AGENT_ID, NOW_UTC, NOW_UTC);
  database
    .prepare(
      "INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc) VALUES (?, ?, 'FollowUp Migration', ?, ?)",
    )
    .run(SESSION_ID, AGENT_ID, NOW_UTC, NOW_UTC);
  database
    .prepare(
      "INSERT INTO messages(id, session_id, agent_id, role, content, message_kind, created_at_utc) VALUES (?, ?, ?, 'user', 'I have a portfolio review tomorrow.', 'user', ?)",
    )
    .run(USER_MESSAGE_ID, SESSION_ID, AGENT_ID, NOW_UTC);
  database
    .prepare(
      "INSERT INTO activity_events(id, agent_id, event_type, occurred_at_utc, summary, outcome_facts_json, state_delta_json, origin, idempotency_key, event_json) VALUES (?, ?, 'completed', ?, 'Completed a walk.', '[]', '{}', 'deterministic', ?, '{}')",
    )
    .run(
      "activity-followup-migration",
      AGENT_ID,
      NOW_UTC,
      "activity-followup-migration",
    );
  database
    .prepare(
      "INSERT INTO proactive_candidates(id, agent_id, trigger_event_id, intent, summary, earliest_at_utc, expires_at_utc, priority, cooldown_key, status, created_at_utc) VALUES (?, ?, ?, 'share_experience', 'Completed a walk.', ?, ?, 0.8, 'walk:2026-08-21', 'pending', ?)",
    )
    .run(
      CANDIDATE_ID,
      AGENT_ID,
      "activity-followup-migration",
      NOW_UTC,
      "2026-08-22T04:00:00.000Z",
      NOW_UTC,
    );
}

function insertFollowUp(
  database: Database,
  overrides: {
    id?: string;
    dedupeKey?: string;
    maxAttempts?: number;
  } = {},
): void {
  database
    .prepare(
      "INSERT INTO follow_up_intents(id, agent_id, session_id, subject_type, context_summary, expected_outcome_description, source_message_id, earliest_at_utc, expires_at_utc, status, max_attempts, attempt_count, dedupe_key, created_at_utc, updated_at_utc) VALUES (?, ?, ?, 'user_event', 'Portfolio review tomorrow.', 'How the review went.', ?, ?, ?, 'pending', ?, 0, ?, ?, ?)",
    )
    .run(
      overrides.id ?? "followup-1",
      AGENT_ID,
      SESSION_ID,
      USER_MESSAGE_ID,
      "2026-08-22T10:00:00.000Z",
      "2026-08-25T10:00:00.000Z",
      overrides.maxAttempts ?? 1,
      overrides.dedupeKey ?? "followup:v1:review",
      NOW_UTC,
      NOW_UTC,
    );
}

function insertCareCue(
  database: Database,
  overrides: {
    id?: string;
    dedupeKey?: string;
    status?: string;
    mentionCount?: number;
    maxMentions?: number;
  } = {},
): void {
  database
    .prepare(
      "INSERT INTO care_cues(id, agent_id, session_id, context_summary, mention_guidance, source_message_id, expires_at_utc, status, max_mentions, mention_count, dedupe_key, created_at_utc, updated_at_utc) VALUES (?, ?, ?, 'The user is preparing a portfolio.', 'Mention only in a related context.', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      overrides.id ?? "care-cue-1",
      AGENT_ID,
      SESSION_ID,
      USER_MESSAGE_ID,
      "2026-09-01T04:00:00.000Z",
      overrides.status ?? "active",
      overrides.maxMentions ?? 1,
      overrides.mentionCount ?? 0,
      overrides.dedupeKey ?? "carecue:v1:portfolio",
      NOW_UTC,
      NOW_UTC,
    );
}

function insertGeneration(
  database: Database,
  input: {
    id: string;
    sourceKind: "activity_candidate" | "follow_up";
    proactiveCandidateId?: string;
    followUpIntentId?: string;
    generationEpoch: number;
    claimToken: string;
  },
): void {
  database
    .prepare(
      "INSERT INTO proactive_generation_runs(id, agent_id, source_kind, proactive_candidate_id, follow_up_intent_id, generation_epoch, claim_token, status, session_id, preflight_spec_version, preflight_state_revision, preflight_source_revision, preflight_message_rowid, preflight_last_user_message_rowid, preflight_user_arrival_epoch, started_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', ?, 1, 0, 0, 1, 1, 0, ?)",
    )
    .run(
      input.id,
      AGENT_ID,
      input.sourceKind,
      input.proactiveCandidateId ?? null,
      input.followUpIntentId ?? null,
      input.generationEpoch,
      input.claimToken,
      SESSION_ID,
      NOW_UTC,
    );
}

function migrationSql(name: string): string {
  return readFileSync(new URL("./migrations/" + name, import.meta.url), "utf8");
}
