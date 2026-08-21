import type {
  CharacterSpec,
  PersonalIntent,
  RuntimeState,
  ScheduleItem,
  SelfPlanBundle,
} from "@personasim/contracts";
import { describe, expect, it, vi } from "vitest";

import { FakeClock } from "../runtime/clock.js";
import {
  SelfPlanningService,
  type EnsureSelfInitiatedPlansInput,
} from "./self-planning-service.js";
import type {
  ApplyScheduleBundleOptions,
  ScheduleBundleApplyResult,
  ScheduleService,
} from "./schedule-service.js";

const AGENT_ID = "agent-1";
const NOW = "2026-06-01T08:00:00.000Z";
const HORIZON_END = "2026-06-01T18:00:00.000Z";

function character(): CharacterSpec {
  return {
    id: AGENT_ID,
    version: 3,
    identity: {
      timezone: "UTC",
      workOrRole: "student",
      worldSetting: "city",
      selfDescription: "Enjoys reading and photography.",
    },
    persona: {
      goals: [],
      preferences: [],
      traits: [],
      values: [],
    },
    dialogue: {
      frequentPhrases: [],
      greetingPatterns: [],
      comfortingPatterns: [],
    },
    routines: [],
  } as unknown as CharacterSpec;
}

function state(): RuntimeState {
  return {
    agentId: AGENT_ID,
    moodValence: 0.2,
    energy: 0.65,
    stress: 0.3,
    socialBattery: 0.6,
    focus: 0.7,
    sleepDebtMinutes: 0,
  } as unknown as RuntimeState;
}

function intent(
  id: string,
  overrides: Partial<PersonalIntent> = {},
): PersonalIntent {
  return {
    id,
    agentId: AGENT_ID,
    activity: `Activity ${id}`,
    category: "leisure",
    desiredDurationMinutes: 60,
    basisKind: "preference",
    basisRefIds: [],
    evidenceMessageIds: [],
    priority: 0.5,
    freshness: 0.5,
    status: "pending",
    dedupeKey: `intent:${id}`,
    specVersion: 3,
    schemaVersion: 1,
    attemptCount: 0,
    createdAtUtc: "2026-06-01T07:00:00.000Z",
    updatedAtUtc: "2026-06-01T07:00:00.000Z",
    ...overrides,
  };
}

function input(
  intents: readonly PersonalIntent[],
  schedule: readonly ScheduleItem[] = [],
): EnsureSelfInitiatedPlansInput {
  return {
    character: character(),
    state: state(),
    intents,
    horizonEndAtUtc: HORIZON_END,
    schedule,
    bufferMinutes: 0,
  };
}

function materialized(bundle: SelfPlanBundle): ScheduleItem {
  return {
    ...bundle.activity,
    id: "schedule-created",
    agentId: AGENT_ID,
    source: "self_initiated",
    status: "planned",
    revision: 0,
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function successfulCommit(bundle: SelfPlanBundle): ScheduleBundleApplyResult {
  const created = materialized(bundle);
  return {
    ok: true,
    errors: [],
    projectedItems: [created],
    createdItems: [created],
    updatedItems: [],
    changedItems: [created],
    lostSleepMinutes: 0,
  };
}

function committer(
  implementation: (
    agentId: string,
    bundle: SelfPlanBundle,
    options?: ApplyScheduleBundleOptions,
  ) => ScheduleBundleApplyResult,
) {
  const applySelfPlanBundle = vi.fn(implementation);
  return {
    applySelfPlanBundle,
    schedules: {
      applySelfPlanBundle,
    } as unknown as Pick<ScheduleService, "applySelfPlanBundle">,
  };
}

describe("SelfPlanningService", () => {
  it("returns deterministic shadow audit without writing", () => {
    const commit = committer(() => {
      throw new Error("shadow mode must not commit");
    });
    const service = new SelfPlanningService(
      commit.schedules,
      new FakeClock(NOW),
      "shadow",
    );
    const request = input([
      intent("preferred", { priority: 0.9 }),
      intent("second", { priority: 0.8 }),
    ]);

    const first = service.ensureSelfInitiatedPlans(request);
    const replay = service.ensureSelfInitiatedPlans(request);

    expect(first.status).toBe("shadowed");
    expect(first.changedItems).toEqual([]);
    expect(first.planning).toEqual(replay.planning);
    expect(first.planning.selectedIntentId).toBe("preferred");
    expect(commit.applySelfPlanBundle).not.toHaveBeenCalled();
  });

  it("commits at most the single selected bundle in enforced mode", () => {
    const commit = committer((_agentId, bundle) => successfulCommit(bundle));
    const service = new SelfPlanningService(
      commit.schedules,
      new FakeClock(NOW),
      "enforced",
    );

    const result = service.ensureSelfInitiatedPlans(
      input([
        intent("preferred", { priority: 0.9 }),
        intent("second", { priority: 0.8 }),
      ]),
    );

    expect(result.status).toBe("committed");
    expect(result.changedItems).toEqual([
      expect.objectContaining({ source: "self_initiated" }),
    ]);
    expect(commit.applySelfPlanBundle).toHaveBeenCalledTimes(1);
    expect(commit.applySelfPlanBundle.mock.calls[0]?.[1].intentId).toBe(
      "preferred",
    );
  });

  it("reports no_free_slot explicitly and never asks for a commit", () => {
    const commit = committer(() => {
      throw new Error("an absent plan must not commit");
    });
    const service = new SelfPlanningService(
      commit.schedules,
      new FakeClock(NOW),
      "enforced",
    );
    const blocking: ScheduleItem = {
      ...materialized({
        intentId: "blocker-intent",
        activity: {
          title: "blocking activity",
          description: "fixture",
          category: "work",
          startAtUtc: NOW,
          endAtUtc: HORIZON_END,
          timezone: "UTC",
          rigidity: "flexible",
          priority: 0.7,
          adherenceProbability: 0.9,
          narrativeImportance: 0.5,
          shareable: false,
          stateEffects: {},
        },
      }),
      id: "blocking-schedule",
      source: "initial_plan",
    };

    const result = service.ensureSelfInitiatedPlans(
      input([intent("blocked")], [blocking]),
    );

    expect(result).toMatchObject({
      status: "no_plan",
      failureReason: "no_free_slot",
      changedItems: [],
    });
    expect(commit.applySelfPlanBundle).not.toHaveBeenCalled();
  });

  it("surfaces atomic commit rejection without claiming changed items", () => {
    const rejected: ScheduleBundleApplyResult = {
      ok: false,
      reason: "validation_failed",
      errors: [
        {
          code: "OVERLAP_FIXED",
          path: "bundle",
          message: "fixture conflict",
        },
      ],
      projectedItems: [],
      createdItems: [],
      updatedItems: [],
      changedItems: [],
      lostSleepMinutes: 0,
    };
    const commit = committer(() => rejected);
    const service = new SelfPlanningService(
      commit.schedules,
      new FakeClock(NOW),
      "enforced",
    );

    const result = service.ensureSelfInitiatedPlans(
      input([intent("rejected")]),
    );

    expect(result).toMatchObject({
      status: "rejected",
      failureReason: "validation_failed",
      changedItems: [],
      createdItems: [],
    });
    expect(commit.applySelfPlanBundle).toHaveBeenCalledTimes(1);
  });
});
