import type {
  CharacterSpec,
  PersonalIntent,
  RuntimeState,
  ScheduleItem,
  SelfPlanBundle,
} from "@personasim/contracts";
import {
  planSelfInitiatedActivity,
  type PersonalIntentLike,
  type ScheduleIntervalLike,
  type SelfPlanningResult,
} from "@personasim/features";

import type { Clock } from "../runtime/clock.js";
import type {
  ApplyScheduleBundleOptions,
  ScheduleBundleApplyResult,
  ScheduleBundleFailureReason,
  ScheduleBundleTransactionMode,
  ScheduleService,
} from "./schedule-service.js";

export type SelfPlanningMode = "shadow" | "enforced";

export interface EnsureSelfInitiatedPlansInput {
  character: CharacterSpec;
  state: RuntimeState;
  /** Intents are supplied by the caller after its own query and expiry pass. */
  intents: readonly PersonalIntent[];
  horizonEndAtUtc: string;
  schedule: readonly ScheduleItem[];
  hardIntervals?: readonly ScheduleIntervalLike[];
  bufferMinutes?: number;
  minimumActivityMinutes?: number;
  minimumSleepMinutes?: number;
  transaction?: ScheduleBundleTransactionMode;
  correlationId?: string;
  causationId?: string;
  beforeCommit?: (bundle: SelfPlanBundle) => void;
}

interface SelfPlanningServiceResultBase {
  mode: SelfPlanningMode;
  planning: SelfPlanningResult;
  changedItems: ScheduleItem[];
  createdItems: ScheduleItem[];
  lostSleepMinutes: number;
}

export type SelfPlanningFailureReason =
  "no_eligible_intent" | "no_free_slot" | ScheduleBundleFailureReason;

export type SelfPlanningServiceResult =
  | (SelfPlanningServiceResultBase & {
      status: "no_plan";
      failureReason: "no_eligible_intent" | "no_free_slot";
    })
  | (SelfPlanningServiceResultBase & {
      status: "shadowed";
      bundle: SelfPlanBundle;
    })
  | (SelfPlanningServiceResultBase & {
      status: "committed";
      bundle: SelfPlanBundle;
      commit: ScheduleBundleApplyResult & { ok: true };
    })
  | (SelfPlanningServiceResultBase & {
      status: "rejected";
      bundle: SelfPlanBundle;
      failureReason: ScheduleBundleFailureReason;
      commit: ScheduleBundleApplyResult & { ok: false };
    });

type SelfPlanCommitter = Pick<ScheduleService, "applySelfPlanBundle">;

/**
 * Pure orchestration around the deterministic planner. The service performs no
 * intent lookup and no model/network work. In enforced mode, its only mutation
 * is one atomic ScheduleService call after planning has completed.
 */
export class SelfPlanningService {
  constructor(
    private readonly schedules: SelfPlanCommitter,
    private readonly clock: Clock,
    private readonly mode: SelfPlanningMode = "shadow",
  ) {}

  ensureSelfInitiatedPlans(
    input: EnsureSelfInitiatedPlansInput,
  ): SelfPlanningServiceResult {
    const planning = planSelfInitiatedActivity({
      character: input.character,
      state: input.state,
      intents: input.intents.map(toPlannerIntent),
      existingItems: input.schedule,
      nowUtc: this.clock.nowUtc(),
      horizonEndAtUtc: input.horizonEndAtUtc,
      ...(input.hardIntervals === undefined
        ? {}
        : { hardIntervals: input.hardIntervals }),
      ...(input.bufferMinutes === undefined
        ? {}
        : { bufferMinutes: input.bufferMinutes }),
      ...(input.minimumActivityMinutes === undefined
        ? {}
        : { minimumActivityMinutes: input.minimumActivityMinutes }),
      ...(input.minimumSleepMinutes === undefined
        ? {}
        : { minimumSleepMinutes: input.minimumSleepMinutes }),
    });

    if (planning.bundle === undefined) {
      return {
        status: "no_plan",
        mode: this.mode,
        failureReason:
          planning.rankedCandidates.length === 0
            ? "no_eligible_intent"
            : "no_free_slot",
        planning,
        changedItems: [],
        createdItems: [],
        lostSleepMinutes: 0,
      };
    }

    if (this.mode === "shadow") {
      return {
        status: "shadowed",
        mode: this.mode,
        bundle: planning.bundle,
        planning,
        changedItems: [],
        createdItems: [],
        lostSleepMinutes: 0,
      };
    }

    input.beforeCommit?.(planning.bundle);
    const commit = this.schedules.applySelfPlanBundle(
      input.character.id,
      planning.bundle,
      commitOptions(input),
    );
    if (!commit.ok) {
      return {
        status: "rejected",
        mode: this.mode,
        bundle: planning.bundle,
        failureReason: commit.reason,
        planning,
        commit,
        changedItems: [],
        createdItems: [],
        lostSleepMinutes: 0,
      };
    }
    return {
      status: "committed",
      mode: this.mode,
      bundle: planning.bundle,
      planning,
      commit,
      changedItems: commit.changedItems,
      createdItems: commit.createdItems,
      lostSleepMinutes: commit.lostSleepMinutes,
    };
  }
}

function commitOptions(
  input: EnsureSelfInitiatedPlansInput,
): ApplyScheduleBundleOptions {
  return {
    ...(input.transaction === undefined
      ? {}
      : { transaction: input.transaction }),
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
    ...(input.causationId === undefined
      ? {}
      : { causationId: input.causationId }),
    ...(input.minimumSleepMinutes === undefined
      ? {}
      : { minimumSleepMinutes: input.minimumSleepMinutes }),
  };
}

function toPlannerIntent(intent: PersonalIntent): PersonalIntentLike {
  return {
    id: intent.id,
    agentId: intent.agentId,
    activity: intent.activity,
    category: intent.category,
    desiredDurationMinutes: intent.desiredDurationMinutes,
    priority: intent.priority,
    freshness: intent.freshness,
    status: intent.status,
    specVersion: intent.specVersion,
    createdAtUtc: intent.createdAtUtc,
    ...(intent.earliestAtUtc === undefined
      ? {}
      : { earliestAtUtc: intent.earliestAtUtc }),
    ...(intent.latestAtUtc === undefined
      ? {}
      : { latestAtUtc: intent.latestAtUtc }),
  };
}
