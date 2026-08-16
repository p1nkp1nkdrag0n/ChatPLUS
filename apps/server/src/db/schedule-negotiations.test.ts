import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { DatabaseStore, type StoredScheduleNegotiation } from "./store.js";

const AGENT_ID = "character-negotiation-test";
const SESSION_ID = "session-negotiation-test";
const OTHER_SESSION_ID = "session-negotiation-other";
const CREATED_AT_UTC = "2026-08-16T02:00:00.000Z";
const UPDATED_AT_UTC = "2026-08-16T02:05:00.000Z";

describe("schedule negotiation persistence", () => {
  let database: Database | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it("upserts, reads and lists the authoritative JSON record", () => {
    database = openDatabase(":memory:");
    const store = prepareStore(database);
    const collecting = negotiation({
      record: {
        offer: {
          activity: "晨跑",
          category: "exercise",
        },
        evidenceMessageIds: ["message-invitation"],
      },
    });

    expect(store.upsertScheduleNegotiation(collecting)).toEqual(collecting);
    expect(store.getScheduleNegotiationById(collecting.id)).toEqual(collecting);
    expect(store.getActiveScheduleNegotiation(SESSION_ID)).toEqual(collecting);

    const awaiting: StoredScheduleNegotiation = {
      ...collecting,
      status: "awaiting_confirmation",
      offerVersion: 1,
      record: {
        offer: {
          activity: "晨跑",
          category: "exercise",
          startAt: "明天 07:00",
          durationMinutes: 30,
        },
        evidenceMessageIds: ["message-invitation", "message-time"],
      },
      createdAtUtc: "2026-08-16T03:00:00.000Z",
      updatedAtUtc: UPDATED_AT_UTC,
    };

    expect(store.upsertScheduleNegotiation(awaiting)).toEqual({
      ...awaiting,
      createdAtUtc: CREATED_AT_UTC,
    });
    const storedAwaiting = {
      ...awaiting,
      createdAtUtc: CREATED_AT_UTC,
    };
    expect(store.getActiveScheduleNegotiation(SESSION_ID)).toEqual(
      storedAwaiting,
    );
    expect(
      store.listScheduleNegotiations({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        status: "awaiting_confirmation",
      }),
    ).toEqual([storedAwaiting]);

    const committed: StoredScheduleNegotiation = {
      ...storedAwaiting,
      status: "committed",
      updatedAtUtc: "2026-08-16T02:10:00.000Z",
    };
    store.upsertScheduleNegotiation(committed);

    expect(store.getActiveScheduleNegotiation(SESSION_ID)).toBeUndefined();
    expect(store.listScheduleNegotiations({ sessionId: SESSION_ID })).toEqual([
      committed,
    ]);
    expect(store.tableCounts().schedule_negotiations).toBe(1);
  });

  it("allows at most one active negotiation per session", () => {
    database = openDatabase(":memory:");
    const store = prepareStore(database);
    const first = negotiation();
    store.upsertScheduleNegotiation(first);

    const second = negotiation({
      id: "negotiation-second",
      status: "awaiting_confirmation",
      offerVersion: 1,
      updatedAtUtc: UPDATED_AT_UTC,
    });
    expect(() => store.upsertScheduleNegotiation(second)).toThrow(
      /UNIQUE constraint failed/u,
    );

    store.upsertScheduleNegotiation({
      ...first,
      status: "withdrawn",
      updatedAtUtc: UPDATED_AT_UTC,
    });
    expect(store.upsertScheduleNegotiation(second)).toEqual(second);

    const otherSession = negotiation({
      id: "negotiation-other-session",
      sessionId: OTHER_SESSION_ID,
    });
    expect(store.upsertScheduleNegotiation(otherSession)).toEqual(otherSession);
    expect(store.getActiveScheduleNegotiation(SESSION_ID)).toEqual(second);
    expect(store.getActiveScheduleNegotiation(OTHER_SESSION_ID)).toEqual(
      otherSession,
    );
  });

  it("claims an offer version exactly once with compare-and-set", () => {
    database = openDatabase(":memory:");
    const store = prepareStore(database);
    const awaiting = negotiation({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    store.upsertScheduleNegotiation(awaiting);
    const committed: StoredScheduleNegotiation = {
      ...awaiting,
      status: "committed",
      updatedAtUtc: UPDATED_AT_UTC,
    };

    expect(
      store.compareAndSetScheduleNegotiation(committed, {
        status: "awaiting_confirmation",
        offerVersion: 1,
      }),
    ).toBe(true);
    expect(
      store.compareAndSetScheduleNegotiation(
        {
          ...committed,
          record: { staleWriter: true },
        },
        {
          status: "awaiting_confirmation",
          offerVersion: 1,
        },
      ),
    ).toBe(false);
    expect(store.getScheduleNegotiationById(awaiting.id)).toEqual(committed);
  });

  it("survives closing and reopening a file database", () => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), "personasim-schedule-negotiations-"),
    );
    const databasePath = join(temporaryDirectory, "negotiations.sqlite");
    database = openDatabase(databasePath);
    const store = prepareStore(database);
    const original = negotiation({
      status: "awaiting_confirmation",
      offerVersion: 3,
      record: {
        offer: {
          activity: "晨跑",
          category: "exercise",
          startAt: "明天 07:00",
          durationMinutes: 30,
        },
        opaqueFutureField: { preserved: true },
      },
    });
    store.upsertScheduleNegotiation(original);
    database.close();
    database = undefined;

    database = openDatabase(databasePath);
    expect(runMigrations(database)).toEqual([]);
    const reopenedStore = new DatabaseStore(database);
    expect(reopenedStore.getScheduleNegotiationById(original.id)).toEqual(
      original,
    );
    expect(reopenedStore.getActiveScheduleNegotiation(SESSION_ID)).toEqual(
      original,
    );
  });
});

function prepareStore(database: Database): DatabaseStore {
  runMigrations(database);
  database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, 1, 'published', 'high_fidelity', ?, 'original', ?, ?)`,
    )
    .run(AGENT_ID, "林夏", CREATED_AT_UTC, CREATED_AT_UTC);
  const insertSession = database.prepare(
    `INSERT INTO sessions(
      id, agent_id, title, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?)`,
  );
  insertSession.run(
    SESSION_ID,
    AGENT_ID,
    "日程协商",
    CREATED_AT_UTC,
    CREATED_AT_UTC,
  );
  insertSession.run(
    OTHER_SESSION_ID,
    AGENT_ID,
    "另一段对话",
    CREATED_AT_UTC,
    CREATED_AT_UTC,
  );
  return new DatabaseStore(database);
}

function negotiation(
  overrides: Partial<StoredScheduleNegotiation> = {},
): StoredScheduleNegotiation {
  return {
    id: "negotiation-first",
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    status: "collecting_details",
    offerVersion: 0,
    record: {
      partialOffer: { activity: "晨跑", category: "exercise" },
      evidenceMessageIds: ["message-invitation"],
    },
    createdAtUtc: CREATED_AT_UTC,
    updatedAtUtc: CREATED_AT_UTC,
    ...overrides,
  };
}
