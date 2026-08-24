import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ScheduleItem } from "../domain/schemas.js";
import { openDatabase, type Database } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { DatabaseStore, type StoredScheduleNegotiation } from "./store.js";

const AGENT_ID = "agent-historical-read";
const SESSION_ID = "session-historical-read";
const NOW_UTC = "2026-09-14T04:00:00.000Z";

describe("authorized historical shared schedule lookup", () => {
  let database: Database;
  let store: DatabaseStore;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedOwner(database);
    store = new DatabaseStore(database);
  });

  afterEach(() => {
    database.close();
  });

  it("returns compact item-to-command lineage for an exact committed entity", () => {
    const item = historicalItem({
      id: "schedule-authorized-north-bank",
      title: "和用户在“北岸书店”喝茶",
      status: "partial",
    });
    store.insertScheduleItem(item);
    insertNegotiation(store, {
      id: "negotiation-authorized-north-bank",
      status: "committed",
      offerVersion: 2,
    });
    insertCommandEvent(store, {
      negotiationId: "negotiation-authorized-north-bank",
      offerVersion: 2,
      changedItemIds: [item.id],
      idempotencyKey: "historical-authorized",
    });
    const eventId = String(
      store
        .listDomainEvents(AGENT_ID, 10)
        .find((event) => event["eventType"] === "schedule.command_committed")?.[
        "id"
      ],
    );

    const matches = store.listAuthorizedHistoricalSharedSchedulesByEntity({
      agentId: AGENT_ID,
      entityText: "北岸书店",
      nowUtc: NOW_UTC,
      limit: 3,
    });

    expect(matches).toEqual([
      {
        item,
        authorization: {
          authorizedItemId: item.id,
          scheduleCommandEventId: eventId,
          negotiationId: "negotiation-authorized-north-bank",
          offerVersion: 2,
          negotiationStatus: "committed",
        },
      },
    ]);
    expect(
      store.listAuthorizedHistoricalSharedSchedulesByEntity({
        agentId: AGENT_ID,
        entityText: "书店",
        nowUtc: NOW_UTC,
        limit: 3,
      }),
    ).toEqual([]);
  });

  it("rejects an orphan item and an event whose changed ids point elsewhere", () => {
    const orphan = historicalItem({
      id: "schedule-orphan-north-bank",
      title: "和用户在北岸书店喝茶",
    });
    store.insertScheduleItem(orphan);
    const differentItem = historicalItem({
      id: "schedule-a-different-item",
      title: "和用户在世纪公园散步",
    });
    store.insertScheduleItem(differentItem);
    insertNegotiation(store, {
      id: "negotiation-wrong-item",
      status: "committed",
      offerVersion: 1,
    });
    insertCommandEvent(store, {
      negotiationId: "negotiation-wrong-item",
      offerVersion: 1,
      changedItemIds: [differentItem.id],
      idempotencyKey: "historical-wrong-item",
    });

    expect(
      store.listAuthorizedHistoricalSharedSchedulesByEntity({
        agentId: AGENT_ID,
        entityText: "北岸书店",
        nowUtc: NOW_UTC,
        limit: 3,
      }),
    ).toEqual([]);
  });

  it("bounds results and ranks a fuller entity match before the most recent related item", () => {
    const items = [
      historicalItem({
        id: "schedule-ranked-exact",
        title: "北岸书店",
        startAtUtc: "2026-08-20T06:00:00.000Z",
        endAtUtc: "2026-08-20T06:45:00.000Z",
      }),
      ...[21, 22, 23].map((day) =>
        historicalItem({
          id: `schedule-ranked-${String(day)}`,
          title: "和用户在北岸书店喝茶",
          startAtUtc: `2026-08-${String(day)}T06:00:00.000Z`,
          endAtUtc: `2026-08-${String(day)}T06:45:00.000Z`,
        }),
      ),
    ];
    for (const [index, item] of items.entries()) {
      const negotiationId = `negotiation-ranked-${String(index)}`;
      store.insertScheduleItem(item);
      insertNegotiation(store, {
        id: negotiationId,
        status: "committed",
        offerVersion: 1,
      });
      insertCommandEvent(store, {
        negotiationId,
        offerVersion: 1,
        changedItemIds: [item.id],
        idempotencyKey: `historical-ranked-${String(index)}`,
      });
    }

    const matches = store.listAuthorizedHistoricalSharedSchedulesByEntity({
      agentId: AGENT_ID,
      entityText: "北岸书店",
      nowUtc: NOW_UTC,
      limit: 2,
    });

    expect(matches.map((match) => match.item.id)).toEqual([
      "schedule-ranked-exact",
      "schedule-ranked-23",
    ]);
  });

  it.each([
    {
      label: "withdrawn negotiation",
      status: "withdrawn" as const,
      negotiationVersion: 1,
      eventVersion: 1,
    },
    {
      label: "offer-version mismatch",
      status: "committed" as const,
      negotiationVersion: 2,
      eventVersion: 1,
    },
  ])(
    "rejects lineage with $label",
    ({ status, negotiationVersion, eventVersion }) => {
      const item = historicalItem({
        id: `schedule-invalid-lineage-${status}-${String(negotiationVersion)}`,
        title: "和用户在北岸书店喝茶",
      });
      const negotiationId = `negotiation-invalid-${status}-${String(negotiationVersion)}`;
      store.insertScheduleItem(item);
      insertNegotiation(store, {
        id: negotiationId,
        status,
        offerVersion: negotiationVersion,
      });
      insertCommandEvent(store, {
        negotiationId,
        offerVersion: eventVersion,
        changedItemIds: [item.id],
        idempotencyKey: `historical-invalid-${status}-${String(negotiationVersion)}`,
      });

      expect(
        store.listAuthorizedHistoricalSharedSchedulesByEntity({
          agentId: AGENT_ID,
          entityText: "北岸书店",
          nowUtc: NOW_UTC,
          limit: 3,
        }),
      ).toEqual([]);
    },
  );
});

describe("018 schedule command event lookup migration", () => {
  it("creates the agent/type/recorded-at index used by lineage lookup", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(migrationSql("001_initial.sql"));
      database.exec(migrationSql("018_schedule_command_event_lookup.sql"));

      const index = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get("domain_events_agent_type_recorded_idx") as
        { sql: string } | undefined;
      expect(index?.sql.replace(/\s+/gu, " ")).toContain(
        "(agent_id, event_type, recorded_at_utc DESC)",
      );
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM domain_events
           WHERE agent_id = ? AND event_type = ?
           ORDER BY recorded_at_utc DESC LIMIT 3`,
        )
        .all(AGENT_ID, "schedule.command_committed") as Array<{
        detail: string;
      }>;
      expect(plan.map((row) => row.detail).join(" ")).toContain(
        "domain_events_agent_type_recorded_idx",
      );
    } finally {
      database.close();
    }
  });
});

function seedOwner(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, 1, 'published', 'high_fidelity', ?, 'original', ?, ?)`,
    )
    .run(AGENT_ID, "历史读取测试角色", NOW_UTC, NOW_UTC);
  database
    .prepare(
      `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(SESSION_ID, AGENT_ID, "历史读取测试", NOW_UTC, NOW_UTC);
}

function historicalItem(
  overrides: Pick<ScheduleItem, "id" | "title"> &
    Partial<
      Pick<
        ScheduleItem,
        "status" | "rigidity" | "source" | "startAtUtc" | "endAtUtc"
      >
    >,
): ScheduleItem {
  return {
    id: overrides.id,
    agentId: AGENT_ID,
    title: overrides.title,
    description: "双方当时已确认的共同安排。",
    category: "social",
    startAtUtc: overrides.startAtUtc ?? "2026-08-25T06:00:00.000Z",
    endAtUtc: overrides.endAtUtc ?? "2026-08-25T06:45:00.000Z",
    timezone: "Asia/Shanghai",
    rigidity: overrides.rigidity ?? "committed",
    priority: 0.8,
    status: overrides.status ?? "completed",
    source: overrides.source ?? "user_invitation",
    adherenceProbability: 0.9,
    narrativeImportance: 0.65,
    shareable: true,
    stateEffects: {},
    revision: 1,
    createdAtUtc: "2026-08-23T04:00:00.000Z",
    updatedAtUtc: "2026-08-25T07:00:00.000Z",
  };
}

function insertNegotiation(
  store: DatabaseStore,
  input: Pick<StoredScheduleNegotiation, "id" | "status" | "offerVersion">,
): void {
  store.upsertScheduleNegotiation({
    ...input,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    record: { policyVersion: 1 },
    createdAtUtc: "2026-08-23T04:00:00.000Z",
    updatedAtUtc: "2026-08-23T04:05:00.000Z",
  });
}

function insertCommandEvent(
  store: DatabaseStore,
  input: {
    negotiationId: string;
    offerVersion: number;
    changedItemIds: string[];
    idempotencyKey: string;
  },
): void {
  store.insertDomainEvent({
    agentId: AGENT_ID,
    streamType: "schedule",
    streamId: AGENT_ID,
    streamVersion: store.nextDomainEventStreamVersion("schedule", AGENT_ID),
    eventType: "schedule.command_committed",
    recordedAtUtc: "2026-08-23T04:05:00.000Z",
    effectiveAtUtc: "2026-08-25T06:00:00.000Z",
    payload: {
      negotiationId: input.negotiationId,
      offerVersion: input.offerVersion,
      operation: "create",
      changedItemIds: input.changedItemIds,
    },
    idempotencyKey: input.idempotencyKey,
  });
}

function migrationSql(name: string): string {
  return readFileSync(new URL("./migrations/" + name, import.meta.url), "utf8");
}
