import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Database } from "../db/connection.js";
import { DatabaseStore } from "../db/store.js";
import {
  loadDailyRelationshipUsage,
  relationshipBaselineEligibility,
} from "./relationship-effect-usage.js";

const AT = "2026-09-11T10:00:00.000Z";
const ZONE = "Asia/Shanghai";
const files: string[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0))
    if (database.open) database.close();
  for (const file of files.splice(0))
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(file + suffix)) unlinkSync(file + suffix);
});
function storeAt(file = ":memory:"): DatabaseStore {
  const database = openDatabase(file);
  databases.push(database);
  database.exec(`CREATE TABLE IF NOT EXISTS domain_events(agent_id TEXT, effective_at_utc TEXT, event_type TEXT, payload_json TEXT);
    CREATE TABLE IF NOT EXISTS activity_events(agent_id TEXT, occurred_at_utc TEXT, event_json TEXT);
    CREATE TABLE IF NOT EXISTS messages(agent_id TEXT, role TEXT, message_kind TEXT, created_at_utc TEXT, content TEXT);`);
  return new DatabaseStore(database);
}
function chat(
  store: DatabaseStore,
  baseline: number,
  proposal: number,
  atUtc = AT,
  mode = "committed",
) {
  store.database
    .prepare("INSERT INTO domain_events VALUES (?, ?, ?, ?)")
    .run(
      "agent",
      atUtc,
      `conversation.world_effects_${mode}`,
      JSON.stringify({
        relationship: {
          baselineDelta: { closeness: baseline },
          appliedProposalDelta: { closeness: proposal },
        },
        wouldApply: {
          relationship: { appliedProposalDelta: { closeness: 0.9 } },
        },
      }),
    );
}
function eligible(
  store: DatabaseStore,
  userText = "今天读了一本新书",
  atUtc = AT,
) {
  return relationshipBaselineEligibility({
    store,
    agentId: "agent",
    timezone: ZONE,
    atUtc,
    userText,
    usedFallback: false,
    evidence: "neutral",
  });
}

describe("persisted single-affinity budget", () => {
  it("rebuilds signed chat and activity movement but cumulative baseline after reopening", () => {
    const file = join(
      tmpdir(),
      `single-affinity-budget-${randomUUID()}.sqlite`,
    );
    files.push(file);
    const first = storeAt(file);
    chat(first, 0.001, 0.02);
    chat(first, 0, -0.03);
    chat(first, 0.001, 0, AT, "shadow_evaluated");
    first.database
      .prepare("INSERT INTO activity_events VALUES (?, ?, ?)")
      .run(
        "agent",
        AT,
        JSON.stringify({
          effectTrace: {
            relationship: {
              baselineDelta: { closeness: 0 },
              appliedProposalDelta: { closeness: 0.006 },
            },
          },
        }),
      );
    expect(loadDailyRelationshipUsage(first, "agent", ZONE, AT)).toEqual({
      closeness: -0.002,
      baselineCloseness: 0.002,
    });
    first.database.close();
    const reopened = storeAt(file);
    expect(loadDailyRelationshipUsage(reopened, "agent", ZONE, AT)).toEqual({
      closeness: -0.002,
      baselineCloseness: 0.002,
    });
    expect(eligible(reopened)).toEqual({ eligible: false, reason: "cooldown" });
  });

  it("uses local-day boundaries and excludes another character's awards", () => {
    const store = storeAt();
    chat(store, 0.001, 0.02, "2026-09-11T15:59:59.000Z");
    store.database
      .prepare("INSERT INTO domain_events VALUES (?, ?, ?, ?)")
      .run(
        "other",
        AT,
        "conversation.world_effects_committed",
        JSON.stringify({ applied: { relationshipDelta: { closeness: 0.04 } } }),
      );
    expect(
      loadDailyRelationshipUsage(
        store,
        "agent",
        ZONE,
        "2026-09-11T15:59:59.000Z",
      ),
    ).toEqual({ closeness: 0.021, baselineCloseness: 0.001 });
    expect(
      loadDailyRelationshipUsage(
        store,
        "agent",
        ZONE,
        "2026-09-11T16:00:00.000Z",
      ),
    ).toEqual({ closeness: 0, baselineCloseness: 0 });
  });

  it("blocks normalized same-day repeats across sessions and empty repetitive content", () => {
    const store = storeAt();
    store.database
      .prepare("INSERT INTO messages VALUES (?, 'user', 'user', ?, ?)")
      .run("agent", AT, "今天，读了一本新书！");
    expect(eligible(store, "今天 读了一本新书")).toEqual({
      eligible: false,
      reason: "duplicate_content",
    });
    for (const text of ["", "？！", "嗯", "哈哈哈哈"])
      expect(eligible(store, text).reason).toBe("empty_or_repetitive");
    expect(
      eligible(store, "今天读了一本新书", "2026-09-12T10:00:00.000Z"),
    ).toEqual({ eligible: true, reason: "eligible" });
  });

  it("keeps a 60-second reward cooldown while allowing normal later interactions", () => {
    const store = storeAt();
    chat(store, 0.001, 0);
    expect(
      eligible(store, "我想再聊聊", "2026-09-11T10:00:59.000Z").reason,
    ).toBe("cooldown");
    expect(
      eligible(store, "我想再聊聊", "2026-09-11T10:01:00.000Z").eligible,
    ).toBe(true);
    for (const evidence of ["rupture_or_boundary", "explicit_repair"] as const)
      expect(
        relationshipBaselineEligibility({
          store,
          agentId: "agent",
          timezone: ZONE,
          atUtc: AT,
          userText: "我们聊聊吧",
          usedFallback: false,
          evidence,
        }),
      ).toEqual({ eligible: false, reason: evidence });
    expect(
      relationshipBaselineEligibility({
        store,
        agentId: "agent",
        timezone: ZONE,
        atUtc: AT,
        userText: "我们聊聊吧",
        usedFallback: true,
        evidence: "neutral",
      }).reason,
    ).toBe("fallback");
  });
});
