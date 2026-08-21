import type {
  CharacterSpec,
  ScheduleEffectProposal,
  ScheduleItem,
  ScheduleMutationBundle,
  SelfPlanBundle,
  ServerScheduleItemDraft,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import type { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import type { LlmService } from "./llm-service.js";
import { ScheduleService } from "./schedule-service.js";

const AGENT_ID = "agent-1";
const NOW = "2026-06-01T08:00:00.000Z";

function characterSpec(): CharacterSpec {
  return {
    id: AGENT_ID,
    version: 3,
    status: "published",
    tier: "high_fidelity",
    identity: { timezone: "UTC" },
    schedulePolicy: {
      enabled: true,
      horizonHours: 72,
      maxCommittedHoursPerDay: 10,
      sleepWindow: { startLocal: "23:00", endLocal: "07:00" },
    },
  } as unknown as CharacterSpec;
}

function scheduleItem(
  id: string,
  startAtUtc: string,
  endAtUtc: string,
  rigidity: ScheduleItem["rigidity"] = "flexible",
): ScheduleItem {
  return {
    id,
    agentId: AGENT_ID,
    title: "existing activity",
    description: "fixture",
    category: "work",
    startAtUtc,
    endAtUtc,
    timezone: "UTC",
    rigidity,
    priority: 0.7,
    source: "initial_plan",
    adherenceProbability: 0.9,
    narrativeImportance: 0.5,
    shareable: true,
    stateEffects: {},
    status: "planned",
    revision: 2,
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function draft(
  startAtUtc: string,
  endAtUtc: string,
  title = "server planned activity",
): ServerScheduleItemDraft {
  return {
    title,
    description: "fixture",
    category: "leisure",
    startAtUtc,
    endAtUtc,
    timezone: "UTC",
    rigidity: "flexible",
    priority: 0.6,
    adherenceProbability: 0.8,
    narrativeImportance: 0.6,
    shareable: true,
    stateEffects: { energy: -0.05 },
  };
}

function harness(initial: readonly ScheduleItem[] = []) {
  const items = structuredClone(initial) as ScheduleItem[];
  let transactionCalls = 0;
  const store = {
    getCharacterSpec: (agentId: string) =>
      agentId === AGENT_ID ? characterSpec() : undefined,
    listSchedule: (agentId: string) =>
      structuredClone(items.filter((item) => item.agentId === agentId)),
    transaction: <T>(work: () => T): T => {
      transactionCalls += 1;
      return work();
    },
    insertScheduleItem: (item: ScheduleItem) => {
      items.push(structuredClone(item));
    },
    updateScheduleItem: (item: ScheduleItem) => {
      const index = items.findIndex((candidate) => candidate.id === item.id);
      if (index < 0) throw new Error("missing schedule item");
      items[index] = structuredClone(item);
    },
  } as unknown as DatabaseStore;
  const service = new ScheduleService(
    store,
    new FakeClock(NOW),
    {} as LlmService,
  );
  return {
    service,
    items: () => structuredClone(items),
    transactionCalls: () => transactionCalls,
  };
}

describe("ScheduleService server-owned bundles", () => {
  it("owns source and persistence metadata for a self-initiated create", () => {
    const test = harness();
    const bundle: SelfPlanBundle = {
      intentId: "intent-1",
      activity: draft("2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z"),
    };

    const result = test.service.applySelfPlanBundle(AGENT_ID, bundle, {
      correlationId: "correlation-1",
      causationId: "claim-1",
    });

    expect(result.ok).toBe(true);
    expect(result.createdItems).toHaveLength(1);
    expect(result.changedItems).toEqual(result.createdItems);
    expect(result.createdItems[0]).toMatchObject({
      agentId: AGENT_ID,
      sourceIntentId: "intent-1",
      correlationId: "correlation-1",
      causationId: "claim-1",
      source: "self_initiated",
      status: "planned",
      revision: 0,
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    });
    expect(result.createdItems[0]?.id).toMatch(/^schedule_/u);
    expect(test.items()).toEqual(result.createdItems);
    expect(test.transactionCalls()).toBe(1);
  });

  it("commits against the final projection rather than mutation order", () => {
    const existing = scheduleItem(
      "flexible-1",
      "2026-06-01T10:00:00.000Z",
      "2026-06-01T11:00:00.000Z",
    );
    const test = harness([existing]);
    const bundle: ScheduleMutationBundle = {
      owner: "manual",
      create: [
        draft(
          "2026-06-01T10:00:00.000Z",
          "2026-06-01T11:00:00.000Z",
          "replacement",
        ),
      ],
      cancel: [{ itemId: existing.id, expectedRevision: existing.revision }],
    };

    const result = test.service.applyMutationBundle(AGENT_ID, bundle);

    expect(result.ok).toBe(true);
    expect(result.createdItems).toEqual([
      expect.objectContaining({ title: "replacement", source: "manual" }),
    ]);
    expect(result.updatedItems).toEqual([
      expect.objectContaining({
        id: existing.id,
        status: "cancelled",
        revision: existing.revision + 1,
      }),
    ]);
    expect(result.changedItems).toHaveLength(2);
    expect(result.projectedItems).toHaveLength(2);
    expect(test.items()).toEqual(expect.arrayContaining(result.projectedItems));
  });

  it("does not partially write when any mutation fails validation", () => {
    const fixed = scheduleItem(
      "fixed-1",
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T13:00:00.000Z",
      "fixed",
    );
    const test = harness([fixed]);
    const before = test.items();
    const bundle: ScheduleMutationBundle = {
      owner: "manual",
      create: [draft("2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z")],
      cancel: [{ itemId: fixed.id }],
    };

    const result = test.service.applyMutationBundle(AGENT_ID, bundle);

    expect(result).toMatchObject({
      ok: false,
      reason: "validation_failed",
      createdItems: [],
      updatedItems: [],
      changedItems: [],
    });
    expect(result.errors.map((error) => error.code)).toContain(
      "FIXED_ITEM_IMMUTABLE",
    );
    expect(result.projectedItems).toEqual(before);
    expect(test.items()).toEqual(before);
  });

  it("owns source for legacy model effects at persistence", () => {
    const test = harness();
    const effect: ScheduleEffectProposal = {
      operation: "create",
      item: {
        ...draft("2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z"),
        source: "manual",
        sourceRoutineId: "forged-routine-id",
      },
      reasonCode: "accepted_invitation",
      reasonSummary: "fixture",
    };

    expect(test.service.validateEffects(AGENT_ID, [effect], NOW)).toEqual({
      valid: true,
      effects: [effect],
    });
    const changed = test.service.applyValidatedEffects(AGENT_ID, [effect], NOW);

    expect(changed).toHaveLength(1);
    expect(changed[0]?.source).toBe("user_invitation");
    expect(changed[0]).not.toHaveProperty("sourceRoutineId");
    expect(test.items()[0]?.source).toBe("user_invitation");
  });

  it("rejects mixed legacy and bundle writes and supports caller transactions", () => {
    const legacyEffect: ScheduleEffectProposal = {
      operation: "create",
      item: {
        ...draft("2026-06-01T14:00:00.000Z", "2026-06-01T15:00:00.000Z"),
        source: "user_invitation",
      },
      reasonCode: "user_request",
      reasonSummary: "fixture",
    };
    const mixed = harness();
    const bundle: ScheduleMutationBundle = {
      owner: "manual",
      create: [draft("2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z")],
    };

    const rejected = mixed.service.applyMutationBundle(AGENT_ID, bundle, {
      legacyEffects: [legacyEffect],
    });

    expect(rejected).toMatchObject({
      ok: false,
      reason: "mixed_write_modes",
      changedItems: [],
    });
    expect(mixed.items()).toEqual([]);

    const composed = harness();
    const committed = composed.service.applyMutationBundle(AGENT_ID, bundle, {
      transaction: "caller_owned",
    });
    expect(committed.ok).toBe(true);
    expect(composed.transactionCalls()).toBe(0);
    expect(composed.items()).toHaveLength(1);
  });
});
