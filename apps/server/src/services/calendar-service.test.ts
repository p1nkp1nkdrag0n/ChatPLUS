import { FakeClock } from "@personasim/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { ApiError } from "../domain/errors.js";
import { CalendarRepository } from "../repositories/calendar-repository.js";
import { CalendarService } from "./calendar-service.js";

const NOW = "2026-08-21T04:00:00.000Z";
const AGENT_ONE = "agent_calendar_one";
const AGENT_TWO = "agent_calendar_two";

describe("CalendarRepository and CalendarService", () => {
  let database: Database;
  let clock: FakeClock;
  let service: CalendarService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedCharacter(database, AGENT_ONE);
    seedCharacter(database, AGENT_TWO);
    clock = new FakeClock(NOW);
    service = new CalendarService(new CalendarRepository(database), clock);
  });

  afterEach(() => {
    database.close();
  });

  it("persists scoped entries without leaking another agent's dates", () => {
    service.create({
      draft: {
        scope: "public_system",
        title: "Public holiday",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: true,
        recurrence: "yearly",
      },
      source: "system_dataset",
    });
    service.create({
      agentId: AGENT_ONE,
      draft: {
        scope: "user_private",
        title: "Therapy appointment",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: false,
        startLocalTime: "10:00",
        endLocalTime: "11:00",
        recurrence: "none",
      },
    });
    service.create({
      agentId: AGENT_TWO,
      draft: {
        scope: "character_world",
        title: "Agent two birthday",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: true,
        recurrence: "yearly",
      },
      source: "character_spec",
    });

    expect(
      service.list({ agentId: AGENT_ONE }).map((entry) => entry.title),
    ).toEqual(["Public holiday", "Therapy appointment"]);
    expect(
      service.list({ agentId: AGENT_TWO }).map((entry) => entry.title),
    ).toEqual(["Public holiday", "Agent two birthday"]);

    const unrelated = service.selectPromptContext({
      agentId: AGENT_ONE,
      query: "How are you?",
      dateRange: {
        startLocalDateInclusive: "2026-08-21",
        endLocalDateExclusive: "2026-08-22",
      },
      explicitDateQuery: false,
    });
    expect(unrelated.map((item) => item.label)).toEqual([
      "all-day | Public holiday",
    ]);

    const relevant = service.selectPromptContext({
      agentId: AGENT_ONE,
      query: "When is my therapy appointment?",
      explicitDateQuery: false,
    });
    expect(relevant.map((item) => item.label)).toEqual([
      "10:00-11:00 | Therapy appointment",
    ]);
    expect(relevant[0]?.label).not.toContain(AGENT_ONE);
  });

  it("uses optimistic revisions for updates and archives", () => {
    const created = service.create({
      agentId: AGENT_ONE,
      draft: {
        scope: "character_world",
        title: "Research day",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: true,
        recurrence: "none",
      },
      source: "character_spec",
    });

    clock.advance({ minutes: 1 });
    const updated = service.update({
      agentId: AGENT_ONE,
      entryId: created.id,
      expectedRevision: 0,
      draft: {
        scope: "character_world",
        title: "Research afternoon",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: false,
        startLocalTime: "13:00",
        endLocalTime: "17:00",
        recurrence: "none",
      },
    });
    expect(updated).toMatchObject({
      revision: 1,
      title: "Research afternoon",
      updatedAtUtc: "2026-08-21T04:01:00.000Z",
    });

    expectApiError(
      () =>
        service.update({
          agentId: AGENT_ONE,
          entryId: created.id,
          expectedRevision: 0,
          draft: {
            scope: "character_world",
            title: "Stale update",
            localDate: "2026-08-21",
            timezone: "Asia/Shanghai",
            allDay: true,
            recurrence: "none",
          },
        }),
      "calendar_revision_conflict",
      409,
    );

    const archived = service.archive({
      agentId: AGENT_ONE,
      entryId: created.id,
      expectedRevision: 1,
    });
    expect(archived).toMatchObject({ status: "archived", revision: 2 });
    expect(service.list({ agentId: AGENT_ONE, status: "active" })).toEqual([]);
  });

  it("enforces scope ownership and dedupe constraints", () => {
    expect(() =>
      service.create({
        draft: {
          scope: "user_private",
          title: "Missing owner",
          localDate: "2026-08-21",
          timezone: "Asia/Shanghai",
          allDay: true,
          recurrence: "none",
        },
      }),
    ).toThrow();

    const input = {
      agentId: AGENT_ONE,
      draft: {
        scope: "user_private" as const,
        title: "Private anniversary",
        localDate: "2026-08-21",
        timezone: "Asia/Shanghai",
        allDay: true,
        recurrence: "yearly" as const,
      },
    };
    service.create(input);
    expect(() => service.create(input)).toThrow();

    expectApiError(
      () =>
        service.get(
          service.list({ agentId: AGENT_ONE })[0]?.id ?? "missing",
          AGENT_TWO,
        ),
      "not_found",
      404,
    );
  });
});

function seedCharacter(database: Database, id: string): void {
  database
    .prepare(
      "INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc) VALUES (?, 1, 'published', 'daily', ?, 'original', ?, ?)",
    )
    .run(id, id, NOW, NOW);
}

function expectApiError(
  action: () => unknown,
  code: string,
  statusCode: number,
): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApiError);
  if (!(thrown instanceof ApiError)) {
    throw new TypeError("Expected ApiError");
  }
  expect(thrown).toMatchObject({ code, statusCode });
}
