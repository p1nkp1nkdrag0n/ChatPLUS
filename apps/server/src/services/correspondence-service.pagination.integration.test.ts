import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import type { CorrespondenceServiceError } from "./correspondence-service.js";

const NOW_UTC = "2026-09-03T04:00:00.000Z";
const INSTANCE_SECRET = Buffer.alloc(32, 0x45).toString("base64");

describe("CorrespondenceService mailbox pagination", () => {
  let app: PersonaSimApp;

  beforeEach(async () => {
    const clock = new FakeClock(NOW_UTC);
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "correspondence-stage4",
        databasePath: ":memory:",
        clockMode: "fake",
        fakeClockStart: NOW_UTC,
        seedDemo: false,
        developerRoutes: true,
        lifePlanningMode: "fuzzy",
        correspondenceMode: "enforced",
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
    });
  });

  afterEach(async () => app.close());

  it("returns stable pages, relevant threads, and rejects a cursor from another character", async () => {
    const agent = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(agent.id);
    const otherAgent = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(otherAgent.id);
    const thread = app.personasim.correspondenceRepository.createThread(
      agent.id,
      { id: "service-page-thread", nowUtc: NOW_UTC },
    );
    const insert = app.personasim.store.database.prepare(
      `INSERT INTO letters (
         id, thread_id, agent_id, direction, status, body,
         created_at_utc, updated_at_utc
       ) VALUES (?, ?, ?, 'user_to_agent', 'cancelled', ?, ?, ?)`,
    );
    for (let index = 0; index < 5; index += 1) {
      insert.run(
        `service-page-letter-${index}`,
        thread.id,
        agent.id,
        `letter ${index}`,
        NOW_UTC,
        NOW_UTC,
      );
    }

    const first = await app.personasim.correspondence.listCorrespondence(
      agent.id,
      { limit: 2 },
    );
    expect(first.letters.map((letter) => letter.id)).toEqual([
      "service-page-letter-4",
      "service-page-letter-3",
    ]);
    expect(first.threads).toEqual([
      expect.objectContaining({ id: thread.id, agentId: agent.id }),
    ]);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toContain(agent.id);
    const firstCursor = first.nextCursor;
    if (firstCursor === undefined) throw new TypeError("first cursor missing");

    const second = await app.personasim.correspondence.listCorrespondence(
      agent.id,
      { limit: 2, cursor: firstCursor },
    );
    const secondCursor = second.nextCursor;
    if (secondCursor === undefined)
      throw new TypeError("second cursor missing");
    const third = await app.personasim.correspondence.listCorrespondence(
      agent.id,
      { limit: 2, cursor: secondCursor },
    );
    expect([
      ...first.letters,
      ...second.letters,
      ...third.letters,
    ]).toHaveLength(5);
    expect(second.letters.map((letter) => letter.id)).toEqual([
      "service-page-letter-2",
      "service-page-letter-1",
    ]);
    expect(third.letters.map((letter) => letter.id)).toEqual([
      "service-page-letter-0",
    ]);
    expect(third.nextCursor).toBeUndefined();

    await expect(
      app.personasim.correspondence.listCorrespondence(otherAgent.id, {
        limit: 2,
        cursor: firstCursor,
      }),
    ).rejects.toMatchObject({
      code: "invalid_cursor",
    } satisfies Partial<CorrespondenceServiceError>);
  });
});
