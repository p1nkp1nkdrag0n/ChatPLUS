import type {
  AutobiographyRevisionProposal,
  ContinuityEvidenceRef,
} from "@personasim/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import { AutobiographyService } from "./autobiography-service.js";
import {
  CheckpointService,
  checkpointSourceHash,
  type CheckpointAutobiographyModelInput,
} from "./checkpoint-service.js";
import { ContinuityIndexService } from "./continuity-index-service.js";
import { ContinuityRepository } from "./continuity-repository.js";

const AGENT = "checkpoint-interaction";
const SESSION = "checkpoint-interaction-session";
const NOW = "2026-09-07T12:00:00.000Z";
const VALID = "明白了，是他对别人说的，跟你没关系。";
const INVALID =
  "你之前一直记得先听我说不急着给建议，那份是你主动给的，跟这事是两码事。";

describe("interaction projection during checkpoint consolidation", () => {
  let database: Database;
  let store: DatabaseStore;
  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    database
      .prepare(
        `INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc)
      VALUES (?, 1, 'published', 'daily', 'Interaction', 'original', ?, ?)`,
      )
      .run(AGENT, NOW, NOW);
    database
      .prepare(
        `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
      VALUES (?, ?, 'Interaction', ?, ?)`,
      )
      .run(SESSION, AGENT, NOW, NOW);
  });
  afterEach(() => database.close());

  function insertTurn(index: number, userText: string, assistantText: string) {
    const stamp = `2026-09-07T0${index}:00:00.000Z`;
    store.insertMessage({
      id: `user-${index}`,
      sessionId: SESSION,
      agentId: AGENT,
      role: "user",
      messageKind: "user",
      content: userText,
      createdAtUtc: stamp,
      metadata: {},
    });
    store.insertMessage({
      id: `assistant-${index}`,
      sessionId: SESSION,
      agentId: AGENT,
      role: "assistant",
      messageKind: "assistant_reply",
      inReplyToMessageId: `user-${index}`,
      content: assistantText,
      createdAtUtc: stamp.replace(":00:00", ":01:00"),
      metadata: {},
    });
  }

  it("keeps raw hash fencing, excludes the old error from model evidence, and prevents the model from restoring it as a report", async () => {
    insertTurn(
      1,
      "以后聊工作时，请先听我说，不要急着给建议。",
      "明白，聊工作时我就先听着。",
    );
    insertTurn(
      2,
      "我有个朋友说‘以后少追问我’，那是他跟别人说的，不是在替我提要求。",
      VALID + INVALID,
    );
    insertTurn(
      3,
      "今天去散步了。".repeat(60),
      "沿着河边走走，路上看到了些什么。".repeat(30),
    );
    const repository = new ContinuityRepository(store);
    const rawBefore = repository.listArchivedMessages(SESSION);
    let generatedInput: CheckpointAutobiographyModelInput | undefined;
    const clock = new FakeClock(NOW);
    const checkpoint = new CheckpointService(
      repository,
      clock,
      {
        generateAutobiography(input): Promise<AutobiographyRevisionProposal> {
          generatedInput = structuredClone(input);
          expect(JSON.stringify(input)).not.toContain(INVALID);
          const evidence = input.evidence.find(
            (item) => item.sourceId === "assistant-2",
          )!;
          expect(evidence).toBeDefined();
          // A faulty model tries to revive the old statement under a valid source ID.
          // Existing report preservation must keep the projected source's actual text.
          return Promise.resolve({
            summaryFirstPerson: INVALID,
            entries: [
              {
                entryKind: "relationship_change",
                content: INVALID,
                temporalStatus: "unknown",
                evidence: [
                  {
                    id: evidence.id,
                    sourceType: evidence.sourceType,
                    sourceId: evidence.sourceId,
                    ...(evidence.quote === undefined
                      ? {}
                      : { quote: evidence.quote }),
                    ...(evidence.contextSummary === undefined
                      ? {}
                      : { contextSummary: evidence.contextSummary }),
                    ...(evidence.temporalStatus === undefined
                      ? {}
                      : { temporalStatus: evidence.temporalStatus }),
                    reliability: evidence.reliability,
                    recordedAtUtc: evidence.recordedAtUtc,
                  } satisfies ContinuityEvidenceRef,
                ],
              },
            ],
          });
        },
      },
      new AutobiographyService(repository),
      new ContinuityIndexService(repository, clock),
      {
        fullVerbatimHours: 0,
        softTokenLimit: 256,
        hardTokenLimit: 512,
        minimumTailTokens: 1,
        minimumRecentTurns: 1,
      },
    );
    const result = await checkpoint.createIfNeeded({
      agentId: AGENT,
      sessionId: SESSION,
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "committed",
    });
    expect(
      generatedInput?.messages.find((message) => message.id === "assistant-2")
        ?.content,
    ).toBe(VALID);
    const stored = repository.getLatestAutobiography(AGENT)!;
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(INVALID);
    expect(stored.snapshot.summaryFirstPerson).toBe(
      `我在对话中说过：「${VALID}」`,
    );
    const committed = repository.getLatestCommittedCheckpoint(SESSION)!;
    expect(committed.sourceHash).toBe(
      checkpointSourceHash(rawBefore.slice(0, 4)),
    );
    expect(committed.artifact).toMatchObject({
      interactionProjection: {
        policyVersion: "directed_interaction_v1",
        annotations: [{ messageId: "assistant-2", excludedText: INVALID }],
      },
    });
    expect(repository.listArchivedMessages(SESSION)).toEqual(rawBefore);
    expect(
      database
        .prepare("SELECT content FROM messages WHERE id = 'assistant-2'")
        .get(),
    ).toEqual({ content: VALID + INVALID });
    if (result.status === "committed") {
      expect(result.eventCards).toHaveLength(1);
      expect(result.eventCards[0]?.summary).not.toContain(INVALID);
    }
  });
});
