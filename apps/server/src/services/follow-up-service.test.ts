import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { FakeClock } from "../runtime/clock.js";
import { FollowUpRepository } from "./follow-up-repository.js";
import { FollowUpService } from "./follow-up-service.js";

const AGENT_ID = "agent-followup-service";
const SESSION_ID = "session-followup-service";
const NOW_UTC = "2026-08-21T04:00:00.000Z";

describe("FollowUpService", () => {
  let database: Database;
  let clock: FakeClock;
  let repository: FollowUpRepository;
  let service: FollowUpService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedAgent(database);
    clock = new FakeClock(NOW_UTC);
    repository = new FollowUpRepository(database);
    service = new FollowUpService(repository, clock);
  });

  afterEach(() => {
    if (database.open) database.close();
  });

  it("normalizes grounded candidates, persists them, and deduplicates globally", () => {
    insertMessage(database, {
      id: "message-portfolio-source",
      role: "user",
      content: "I have a portfolio review tomorrow.",
      createdAtUtc: NOW_UTC,
    });
    const input = {
      agentId: AGENT_ID,
      sourceMessageId: "message-portfolio-source",
      timezone: "Asia/Shanghai",
      candidate: {
        subjectType: "user_event" as const,
        contextSummary: "The user has a portfolio review tomorrow.",
        expectedOutcomeDescription: "How the portfolio review went.",
        timingHint: "tomorrow afternoon",
        evidenceQuotes: ["portfolio review tomorrow"],
        reasonCode: "future_user_event",
        reasonSummary: "The user stated a bounded future event.",
      },
    };

    const first = service.createFollowUp(input);
    const duplicate = service.createFollowUp(input);
    expect(first).toMatchObject({
      accepted: true,
      inserted: true,
      followUp: {
        status: "pending",
        maxAttempts: 1,
        attemptCount: 0,
        sourceMessageId: "message-portfolio-source",
        earliestAtUtc: "2026-08-22T12:00:00.000Z",
      },
    });
    expect(duplicate).toMatchObject({
      accepted: true,
      inserted: false,
    });
    if (!first.accepted || !duplicate.accepted) {
      throw new Error("Expected accepted follow-up candidates");
    }
    expect(duplicate.followUp.id).toBe(first.followUp.id);
    expect(
      service.createFollowUp({
        ...input,
        candidate: {
          ...input.candidate,
          evidenceQuotes: ["not present in the source"],
        },
      }),
    ).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "missing_grounded_quote" },
    });
    expect(countRows(database, "follow_up_intents")).toBe(1);
  });

  it("resolves or cancels only explicit same-subject user messages", () => {
    insertMessage(database, {
      id: "message-defense-source",
      role: "user",
      content: "My thesis defense is tomorrow.",
      createdAtUtc: NOW_UTC,
    });
    const created = service.createFollowUp({
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
    if (!created.accepted) throw new Error("Follow-up should be accepted");

    insertMessage(database, {
      id: "message-unrelated",
      role: "user",
      content: "The interview passed.",
      createdAtUtc: "2026-08-21T05:00:00.000Z",
    });
    expect(
      service.handleUserMessage({
        agentId: AGENT_ID,
        messageId: "message-unrelated",
      }),
    ).toEqual({
      resolvedFollowUpIds: [],
      cancelledFollowUpIds: [],
      dismissedCareCueIds: [],
    });
    expect(repository.getFollowUp(created.followUp.id)?.status).toBe("pending");

    insertMessage(database, {
      id: "message-defense-result",
      role: "user",
      content: "The thesis defense passed and is over.",
      createdAtUtc: "2026-08-22T18:00:00.000Z",
    });
    clock.setUtc("2026-08-22T18:00:00.000Z");
    expect(
      service.handleUserMessage({
        agentId: AGENT_ID,
        messageId: "message-defense-result",
      }),
    ).toMatchObject({ resolvedFollowUpIds: [created.followUp.id] });
    expect(repository.getFollowUp(created.followUp.id)).toMatchObject({
      status: "resolved",
      resolutionMessageId: "message-defense-result",
    });

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
    if (!race.accepted) throw new Error("Race follow-up should be accepted");
    insertMessage(database, {
      id: "message-race-cancelled",
      role: "user",
      content: "The city race was cancelled, so I will not attend.",
      createdAtUtc: "2026-08-22T18:02:00.000Z",
    });
    expect(
      service.handleUserMessage({
        agentId: AGENT_ID,
        messageId: "message-race-cancelled",
      }),
    ).toMatchObject({ cancelledFollowUpIds: [race.followUp.id] });
    expect(repository.getFollowUp(race.followUp.id)?.status).toBe("cancelled");
  });

  it("selects relevant CareCues and counts only an actual assistant mention", () => {
    insertMessage(database, {
      id: "message-care-source",
      role: "user",
      content: "I am preparing my portfolio this week.",
      createdAtUtc: NOW_UTC,
    });
    const created = service.createCareCue({
      agentId: AGENT_ID,
      sourceMessageId: "message-care-source",
      timezone: "UTC",
      ttlDays: 7,
      maxMentions: 1,
      candidate: {
        contextSummary: "The user is preparing a portfolio this week.",
        mentionGuidance: "Ask how the portfolio is progressing in context.",
        evidenceQuotes: ["preparing my portfolio this week"],
        reasonCode: "natural_future_context",
        reasonSummary: "This can be mentioned in a related conversation.",
      },
    });
    expect(created).toMatchObject({
      accepted: true,
      inserted: true,
      careCue: { status: "active", maxMentions: 1, mentionCount: 0 },
    });
    if (!created.accepted) throw new Error("Care cue should be accepted");

    expect(
      service.selectCareCues({
        agentId: AGENT_ID,
        userText: "I am adjusting the portfolio layout.",
      }),
    ).toHaveLength(1);
    expect(
      service.selectCareCues({
        agentId: AGENT_ID,
        userText: "I went running today.",
      }),
    ).toEqual([]);

    insertMessage(database, {
      id: "message-assistant-no-mention",
      role: "assistant",
      content: "That sounds like a productive afternoon.",
      createdAtUtc: "2026-08-21T04:01:00.000Z",
    });
    expect(
      service.recordCareCueMentions({
        agentId: AGENT_ID,
        messageId: "message-assistant-no-mention",
        cueIds: [created.careCue.id],
      }),
    ).toEqual([]);
    expect(repository.getCareCue(created.careCue.id)?.mentionCount).toBe(0);

    insertMessage(database, {
      id: "message-assistant-mention",
      role: "assistant",
      content: "How is the portfolio layout progressing?",
      createdAtUtc: "2026-08-21T04:02:00.000Z",
    });
    expect(
      service.recordCareCueMentions({
        agentId: AGENT_ID,
        messageId: "message-assistant-mention",
        cueIds: [created.careCue.id, created.careCue.id],
      }),
    ).toEqual([created.careCue.id]);
    expect(repository.getCareCue(created.careCue.id)).toMatchObject({
      status: "exhausted",
      mentionCount: 1,
      lastMentionedMessageId: "message-assistant-mention",
    });
  });

  it("dismisses a related CareCue and expires untouched lifecycle records", () => {
    insertMessage(database, {
      id: "message-running-source",
      role: "user",
      content: "I am training for a running race.",
      createdAtUtc: NOW_UTC,
    });
    const created = service.createCareCue({
      agentId: AGENT_ID,
      sourceMessageId: "message-running-source",
      timezone: "UTC",
      ttlDays: 1,
      candidate: {
        contextSummary: "The user is training for a running race.",
        mentionGuidance: "Ask about running only in a related context.",
        evidenceQuotes: ["training for a running race"],
        reasonCode: "natural_future_context",
        reasonSummary: "The cue is relevant to a later running discussion.",
      },
    });
    if (!created.accepted) throw new Error("Care cue should be accepted");

    insertMessage(database, {
      id: "message-dismiss-running",
      role: "user",
      content: "Please do not ask about running again.",
      createdAtUtc: "2026-08-21T04:10:00.000Z",
    });
    expect(
      service.handleUserMessage({
        agentId: AGENT_ID,
        messageId: "message-dismiss-running",
      }),
    ).toMatchObject({ dismissedCareCueIds: [created.careCue.id] });
    expect(repository.getCareCue(created.careCue.id)).toMatchObject({
      status: "dismissed",
      dismissedByMessageId: "message-dismiss-running",
    });

    insertMessage(database, {
      id: "message-expiry-source",
      role: "user",
      content: "My design review is tomorrow.",
      createdAtUtc: "2026-08-21T04:11:00.000Z",
    });
    const expiring = service.createFollowUp({
      agentId: AGENT_ID,
      sourceMessageId: "message-expiry-source",
      timezone: "UTC",
      candidate: {
        subjectType: "user_event",
        contextSummary: "The user's design review is tomorrow.",
        expectedOutcomeDescription: "How the design review went.",
        timingHint: "tomorrow afternoon",
        evidenceQuotes: ["design review is tomorrow"],
        reasonCode: "future_user_event",
        reasonSummary: "A bounded event can be followed up once.",
      },
    });
    if (!expiring.accepted) throw new Error("Follow-up should be accepted");
    clock.setUtc("2026-08-26T19:00:00.000Z");
    expect(service.expire(AGENT_ID).followUps).toBe(1);
    expect(repository.getFollowUp(expiring.followUp.id)?.status).toBe(
      "expired",
    );
  });

  it.each([
    "user_goal",
    "user_event",
    "shared_commitment",
    "character_commitment",
  ] as const)(
    "rejects analysis and unaccepted suggestion through the public %s creation path",
    (subjectType) => {
      const source =
        "我现在想具体想一想了，请帮我分析一下：怎样区分真正做错了，和只是被反复修改弄得烦。";
      insertMessage(database, {
        id: "analysis",
        role: "user",
        content: source,
        createdAtUtc: NOW_UTC,
      });
      insertMessage(database, {
        id: "suggestion",
        role: "assistant",
        content: "你可以明天试试写清单。",
        createdAtUtc: NOW_UTC,
      });
      const result = service.createFollowUp({
        agentId: AGENT_ID,
        sourceMessageId:
          subjectType === "character_commitment" ? "suggestion" : "analysis",
        timezone: "UTC",
        candidate: {
          subjectType,
          contextSummary: source,
          expectedOutcomeDescription: "用户明天完成清单后反馈结果",
          timingHint: "tomorrow",
          evidenceQuotes: [source],
          reasonCode: "proposal",
          reasonSummary: "proposal",
        },
      });
      expect(result.accepted).toBe(false);
      expect(countRows(database, "follow_up_intents")).toBe(0);
    },
  );

  it("does not treat acknowledgement as adoption, then accepts an explicit later plan with a conservative persisted basis", () => {
    insertMessage(database, {
      id: "suggestion",
      role: "assistant",
      content: "你可以列清单，再散步。",
      createdAtUtc: NOW_UTC,
    });
    for (const [id, text, expected] of [
      ["thanks", "谢谢，我懂了。", false],
      ["try", "明天我试试你说的清单。", true],
    ] as const) {
      insertMessage(database, {
        id,
        role: "user",
        content: text,
        createdAtUtc: NOW_UTC,
      });
      const result = service.createFollowUp({
        agentId: AGENT_ID,
        sourceMessageId: id,
        timezone: "UTC",
        candidate: {
          subjectType: "user_event",
          contextSummary: text,
          expectedOutcomeDescription: "用户完成清单、散步并反馈成功",
          timingHint: "tomorrow",
          evidenceQuotes: [text],
          reasonCode: "proposal",
          reasonSummary: "proposal",
        },
      });
      expect(result.accepted).toBe(expected);
      if (result.accepted) {
        expect(result.followUp.grounding).toMatchObject({
          version: 1,
          basis: {
            basisKind: "user_plan",
            modality: "planned",
            sourceMessageIds: ["try"],
          },
          sources: [{ id: "try", role: "user" }],
        });
        expect(result.followUp.expectedOutcomeDescription).not.toContain(
          "散步",
        );
        expect(result.followUp.expectedOutcomeDescription).toContain(
          "不预设执行或成功",
        );
        expect(repository.isFollowUpEvidenceCurrent(result.followUp.id)).toBe(
          true,
        );
        database
          .prepare("UPDATE messages SET content = ? WHERE id = 'try'")
          .run("我不打算试清单了。");
        expect(repository.isFollowUpEvidenceCurrent(result.followUp.id)).toBe(
          false,
        );
        expect(repository.getFollowUp(result.followUp.id)?.status).toBe(
          "pending",
        );
      }
    }
    expect(countRows(database, "follow_up_intents")).toBe(1);
  });

  it("validates final assistant commitments and requires both stored sides for shared commitments", () => {
    const user = "我们明天会一起检查清单。";
    insertMessage(database, {
      id: "shared-user",
      role: "user",
      content: user,
      createdAtUtc: NOW_UTC,
    });
    const input = {
      agentId: AGENT_ID,
      sourceMessageId: "shared-user",
      timezone: "UTC",
      candidate: {
        subjectType: "shared_commitment" as const,
        contextSummary: user,
        expectedOutcomeDescription: "双方检查清单",
        timingHint: "tomorrow",
        evidenceQuotes: [user],
        reasonCode: "proposal",
        reasonSummary: "proposal",
      },
    };
    expect(service.createFollowUp(input)).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "missing_shared_commitment_evidence" },
    });
    insertMessage(database, {
      id: "shared-assistant",
      role: "assistant",
      content: "好，我们明天会一起检查清单。",
      createdAtUtc: NOW_UTC,
    });
    const accepted = service.createFollowUp(input);
    expect(accepted).toMatchObject({
      accepted: true,
      followUp: {
        grounding: {
          basis: { sourceMessageIds: ["shared-user", "shared-assistant"] },
        },
      },
    });
    database
      .prepare(
        "UPDATE messages SET content = '我现在不能作出这个承诺。' WHERE id = 'shared-assistant'",
      )
      .run();
    if (!accepted.accepted) throw new Error("Expected shared commitment");
    expect(repository.isFollowUpEvidenceCurrent(accepted.followUp.id)).toBe(
      false,
    );
    expect(
      service.createFollowUp({
        ...input,
        sourceMessageId: "shared-assistant",
        candidate: {
          ...input.candidate,
          subjectType: "character_commitment",
          evidenceQuotes: ["我明天会整理笔记。"],
        },
      }),
    ).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "missing_grounded_quote" },
    });
  });

  it("does not preserve imagined work in CareCue guidance and excludes legacy or changed evidence", () => {
    const source = "我只是想分析一下最近工作的烦躁。";
    insertMessage(database, {
      id: "care-analysis",
      role: "user",
      content: source,
      createdAtUtc: NOW_UTC,
    });
    const created = service.createCareCue({
      agentId: AGENT_ID,
      sourceMessageId: "care-analysis",
      timezone: "UTC",
      candidate: {
        contextSummary: source,
        mentionGuidance: "问用户做完清单后的效果，并提醒他继续散步",
        evidenceQuotes: [source],
        reasonCode: "proposal",
        reasonSummary: "proposal",
      },
    });
    expect(created.accepted).toBe(true);
    if (!created.accepted) throw new Error("Expected care context");
    expect(created.careCue.mentionGuidance).not.toContain("清单");
    expect(
      service.selectCareCues({ agentId: AGENT_ID, userText: "工作烦躁" }),
    ).toHaveLength(1);
    database
      .prepare("UPDATE care_cues SET grounding_json = NULL WHERE id = ?")
      .run(created.careCue.id);
    expect(
      service.selectCareCues({ agentId: AGENT_ID, userText: "工作烦躁" }),
    ).toEqual([]);
    expect(repository.getCareCue(created.careCue.id)?.status).toBe("active");
  });

  it("revalidates a specific legitimate legacy row using its original date while leaving the T8 row pending and unsendable", () => {
    const event = "明天下午有面试。";
    const analysis = "请帮我分析怎样区分真正做错了和修改带来的烦躁。";
    for (const [id, content] of [
      ["legacy-event", event],
      ["legacy-t8", analysis],
    ] as const) {
      insertMessage(database, {
        id,
        role: "user",
        content,
        createdAtUtc: NOW_UTC,
      });
      repository.insertFollowUp({
        id: `${id}-followup`,
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        subjectType: "user_event",
        contextSummary: content,
        expectedOutcomeDescription: "用户完成清单并反馈结果",
        sourceMessageId: id,
        earliestAtUtc: "2026-08-22T10:00:00.000Z",
        expiresAtUtc: "2026-08-25T10:00:00.000Z",
        dedupeKey: id,
        createdAtUtc: NOW_UTC,
      });
      expect(repository.isFollowUpEvidenceCurrent(`${id}-followup`)).toBe(
        false,
      );
    }
    clock.setUtc("2026-08-22T09:00:00.000Z");
    const restored = service.revalidateFollowUp({
      agentId: AGENT_ID,
      id: "legacy-event-followup",
      timezone: "Asia/Shanghai",
    });
    expect(restored).toMatchObject({
      accepted: true,
      inserted: false,
      followUp: {
        status: "pending",
        earliestAtUtc: "2026-08-22T10:00:00.000Z",
        grounding: { basis: { basisKind: "user_event" } },
      },
    });
    expect(repository.isFollowUpEvidenceCurrent("legacy-event-followup")).toBe(
      true,
    );
    const rejected = service.revalidateFollowUp({
      agentId: AGENT_ID,
      id: "legacy-t8-followup",
      timezone: "Asia/Shanghai",
    });
    expect(rejected).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "unsupported_follow_up_basis" },
    });
    expect(repository.getFollowUp("legacy-t8-followup")).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
    expect(repository.isFollowUpEvidenceCurrent("legacy-t8-followup")).toBe(
      false,
    );
  });

  it.each(["needs_review", "superseded"])(
    "uses the shared validity boundary when unchanged message evidence becomes %s",
    (status) => {
      const text = "明天下午有面试。";
      insertMessage(database, {
        id: "reviewed-source",
        role: "user",
        content: text,
        createdAtUtc: NOW_UTC,
      });
      const input = {
        agentId: AGENT_ID,
        sourceMessageId: "reviewed-source",
        timezone: "UTC",
        candidate: {
          subjectType: "user_event" as const,
          contextSummary: text,
          expectedOutcomeDescription: "面试的情况",
          timingHint: "tomorrow",
          evidenceQuotes: [text],
          reasonCode: "proposal",
          reasonSummary: "proposal",
        },
      };
      const created = service.createFollowUp(input);
      if (!created.accepted) throw new Error("Expected verified event");
      database
        .prepare(
          "INSERT INTO memories(id, agent_id, type, content, tags_json, importance, confidence, source_message_id, created_at_utc, status) VALUES ('reviewed-memory', ?, 'event', ?, '[]', 0.5, 1, 'reviewed-source', ?, ?)",
        )
        .run(AGENT_ID, text, NOW_UTC, status);
      database
        .prepare(
          "INSERT INTO memory_evidence(id, memory_id, source_type, source_id, recorded_at_utc, evidence_json) VALUES ('reviewed-evidence', 'reviewed-memory', 'message', 'reviewed-source', ?, '{}')",
        )
        .run(NOW_UTC);
      expect(repository.getSourceMessage("reviewed-source")?.text).toBe(text);
      expect(repository.isFollowUpEvidenceCurrent(created.followUp.id)).toBe(
        false,
      );
      expect(service.createFollowUp(input)).toMatchObject({
        accepted: false,
        rejection: { reasonCode: "source_needs_review" },
      });
      expect(
        service.revalidateFollowUp({
          agentId: AGENT_ID,
          id: created.followUp.id,
          timezone: "UTC",
        }),
      ).toMatchObject({
        accepted: false,
        rejection: { reasonCode: "source_needs_review" },
      });
      expect(repository.getFollowUp(created.followUp.id)?.status).toBe(
        "pending",
      );
    },
  );
});

function seedAgent(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, 1, 'published', 'high_fidelity', ?, 'original', ?, ?)`,
    )
    .run(AGENT_ID, "FollowUp Agent", NOW_UTC, NOW_UTC);
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
      ) VALUES (?, ?, 'FollowUp service test', ?, ?)`,
    )
    .run(SESSION_ID, AGENT_ID, NOW_UTC, NOW_UTC);
}

function insertMessage(
  database: Database,
  input: {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAtUtc: string;
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
      messageKind: input.role === "user" ? "user" : "assistant_reply",
    });
}

function countRows(database: Database, table: string): number {
  if (table !== "follow_up_intents") throw new Error("Unexpected table");
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM follow_up_intents")
    .get() as { count: number };
  return Number(row.count);
}
