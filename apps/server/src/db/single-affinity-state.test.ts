import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeState } from "@personasim/contracts";

import { openDatabase, type Database } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { DatabaseStore } from "./store.js";

const NOW = "2026-09-11T00:00:00.000Z";

function initialState(): RuntimeState {
  return {
    agentId: "agent-affinity",
    asOfUtc: NOW,
    moodValence: 0,
    moodArousal: 0.5,
    energy: 0.7,
    stress: 0.2,
    socialBattery: 0.7,
    focus: 0.6,
    sleepDebtMinutes: 0,
    relationship: { userId: "local-user", closeness: 0.1 },
    revision: 0,
  };
}

describe("single affinity persistence on a fresh database", () => {
  let database: Database;
  let store: DatabaseStore;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    database
      .prepare(
        `INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc)
         VALUES('agent-affinity',1,'published','daily','知夏','original',?,?)`,
      )
      .run(NOW, NOW);
  });

  afterEach(() => database.close());

  it("rejects retired fields on insert, update and CAS without partially writing state", () => {
    const obsolete = {
      ...initialState(),
      relationship: { ...initialState().relationship, trust: 0.9 },
    } as RuntimeState;
    expect(() => store.insertInitialState(obsolete, NOW)).toThrow();
    expect(
      database.prepare("SELECT count(*) AS n FROM runtime_states").get(),
    ).toEqual({ n: 0 });
    expect(
      database.prepare("SELECT count(*) AS n FROM simulation_cursors").get(),
    ).toEqual({ n: 0 });

    store.insertInitialState(initialState(), NOW);
    expect(() => store.updateRuntimeState(obsolete)).toThrow();
    expect(() => store.compareAndSetRuntimeState(obsolete, 0)).toThrow();
    expect(store.getRuntimeState("agent-affinity")).toEqual(initialState());
  });

  it("unlocks the existing five achievements once at closeness thresholds", () => {
    store.insertInitialState(initialState(), NOW);
    const state = initialState();
    for (const threshold of [0.3, 0.5, 0.7, 0.9, 1]) {
      state.relationship.closeness = threshold;
      state.revision += 1;
      expect(store.compareAndSetRuntimeState(state, state.revision - 1)).toBe(
        true,
      );
    }
    const unlocks = database
      .prepare(
        "SELECT definition_key, evidence_json FROM achievement_unlocks ORDER BY sequence",
      )
      .all() as Array<{ definition_key: string; evidence_json: string }>;
    expect(unlocks.map((row) => row.definition_key)).toEqual([
      "relationship.30",
      "relationship.50",
      "relationship.70",
      "relationship.90",
      "relationship.100",
    ]);
    expect(JSON.parse(unlocks[0]!.evidence_json)).toMatchObject({
      beforeCloseness: 0.1,
      afterCloseness: 0.3,
      threshold: 0.3,
    });
    state.revision += 1;
    store.updateRuntimeState(state);
    state.relationship.closeness = 0.1;
    state.revision += 1;
    store.updateRuntimeState(state);
    state.relationship.closeness = 1;
    state.revision += 1;
    store.updateRuntimeState(state);
    expect(
      database.prepare("SELECT count(*) AS n FROM achievement_unlocks").get(),
    ).toEqual({ n: 5 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
