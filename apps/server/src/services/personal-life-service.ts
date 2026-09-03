import type {
  CharacterSpec,
  PersonalIntent,
  RuntimeState,
  SelfPlanBundle,
} from "@personasim/contracts";
import {
  deriveRoutineHardIntervals,
  normalizePersonalIntentCategory,
  stableId,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import { capabilitiesForTier } from "../domain/capabilities.js";
import { notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import type { Clock } from "../runtime/clock.js";
import type { SseHub } from "../sse/hub.js";
import type {
  DerivedPersonalIntentProposal,
  PersonalIntentService,
} from "./personal-intent-service.js";
import type { ScheduleService } from "./schedule-service.js";
import type {
  SelfPlanningService,
  SelfPlanningServiceResult,
} from "./self-planning-service.js";

export type PersonalLifeMode = "off" | "shadow" | "enforced";

export type PersonalLifeStatus =
  "off" | "inactive" | "already_claimed" | SelfPlanningServiceResult["status"];

export interface PersonalLifeServiceResult {
  agentId: string;
  mode: PersonalLifeMode;
  status: PersonalLifeStatus;
  expiredIntentIds: string[];
  revalidatedIntentIds: string[];
  rejectedIntentIds: string[];
  planning: SelfPlanningServiceResult | undefined;
  consumedIntentId: string | undefined;
  state: RuntimeState | undefined;
  stateChanged: boolean;
}

type IntentLifecycle = Pick<
  PersonalIntentService,
  | "listActive"
  | "upsertOrMerge"
  | "expire"
  | "markConsumed"
  | "reevaluateActiveForCurrentSpec"
>;
type SelfPlanner = Pick<SelfPlanningService, "ensureSelfInitiatedPlans">;
type ScheduleReader = Pick<ScheduleService, "list">;

const MAX_PLANNING_HOURS = 72;
type RejectedPlanningResult = Extract<
  SelfPlanningServiceResult,
  { status: "rejected" }
>;
type CommittedPlanningResult = Extract<
  SelfPlanningServiceResult,
  { status: "committed" }
>;

class DuplicatePersonalLifeClaim extends Error {
  constructor(readonly intentId: string) {
    super("Personal intent was already claimed");
  }
}

class RejectedPersonalLifePlan extends Error {
  constructor(readonly planning: RejectedPlanningResult) {
    super("Self plan failed final schedule validation");
  }
}

/**
 * Coordinates intent expiry, bounded CharacterSpec intent seeding,
 * deterministic planning, atomic consumption, and post-commit notifications.
 * Spontaneous and chat intent creation remain explicit upstream actions.
 */
export class PersonalLifeService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly intents: IntentLifecycle,
    private readonly planner: SelfPlanner,
    private readonly schedules: ScheduleReader,
    private readonly sse: SseHub,
    private readonly mode: PersonalLifeMode = "off",
  ) {}

  ensureSelfInitiatedPlans(agentId: string): PersonalLifeServiceResult {
    if (this.mode === "off") return offResult(agentId);

    const character = this.store.getCharacterSpec(agentId);
    const state = this.store.getRuntimeState(agentId);
    if (!character || !state) throw notFound("Character");
    if (
      character.status !== "published" ||
      !capabilitiesForTier(character.tier).legacyExactSchedule ||
      !character.schedulePolicy.enabled
    ) {
      return {
        agentId,
        mode: this.mode,
        status: "inactive",
        expiredIntentIds: [],
        revalidatedIntentIds: [],
        rejectedIntentIds: [],
        planning: undefined,
        consumedIntentId: undefined,
        state,
        stateChanged: false,
      };
    }

    const cursor = this.store.getCursor(agentId);
    if (!cursor) throw notFound("Simulation cursor");
    const nowUtc = this.clock.nowUtc();
    const correlationId = createEntityId("self_plan");
    const expiredIntentIds =
      this.mode === "enforced"
        ? this.expireActiveIntents(agentId, correlationId)
        : [];
    const reevaluation =
      this.mode === "enforced"
        ? this.intents.reevaluateActiveForCurrentSpec({
            agentId,
            correlationId,
            causationId: correlationId,
          })
        : { revalidatedIntentIds: [], rejectedIntentIds: [] };
    const { revalidatedIntentIds, rejectedIntentIds } = reevaluation;
    const horizonEndAtUtc = planningHorizonEnd(
      nowUtc,
      cursor.scheduleHorizonEndUtc,
    );
    const schedule = this.schedules.list(agentId, nowUtc, horizonEndAtUtc);

    const executePlanning = () => {
      let consumedIntentId: string | undefined;
      const activeIntents = this.ensureSpecDerivedIntents(
        character,
        correlationId,
      );
      const planning = this.planner.ensureSelfInitiatedPlans({
        character,
        state,
        intents: activeIntents,
        horizonEndAtUtc,
        schedule,
        hardIntervals: deriveRoutineHardIntervals(character, {
          horizonStartAtUtc: nowUtc,
          horizonEndAtUtc,
        }),
        correlationId,
        causationId: correlationId,
        ...(this.mode === "enforced"
          ? {
              transaction: "caller_owned" as const,
              beforeCommit: (bundle: SelfPlanBundle) => {
                consumedIntentId = bundle.intentId;
                const transition = this.intents.markConsumed({
                  agentId,
                  intentId: consumedIntentId,
                  correlationId,
                  causationId: correlationId,
                  idempotencyKey:
                    "personal-life:" +
                    agentId +
                    ":" +
                    consumedIntentId +
                    ":consume",
                });
                if (transition.intent.status !== "consumed") {
                  throw new Error(
                    "Claimed personal intent did not become consumed",
                  );
                }
                if (!transition.transitioned || transition.replayed) {
                  throw new DuplicatePersonalLifeClaim(consumedIntentId);
                }
              },
            }
          : {}),
      });
      if (planning.mode !== this.mode) {
        throw new Error(
          `Personal life mode ${this.mode} does not match planner mode ${planning.mode}`,
        );
      }
      if (planning.status === "rejected") {
        throw new RejectedPersonalLifePlan(planning);
      }

      const nextState = state;
      const stateChanged = false;
      if (planning.status === "committed") {
        if (consumedIntentId !== planning.bundle.intentId) {
          throw new Error(
            "Committed self plan did not hold a matching intent claim",
          );
        }
        this.recordSelfPlanCommitted(
          agentId,
          planning,
          correlationId,
          correlationId,
          nowUtc,
        );
      }
      return { planning, nextState, stateChanged, consumedIntentId };
    };

    let outcome: ReturnType<typeof executePlanning>;
    try {
      outcome =
        this.mode === "enforced"
          ? this.store.transaction(executePlanning)
          : executePlanning();
    } catch (error) {
      if (error instanceof DuplicatePersonalLifeClaim) {
        return {
          agentId,
          mode: this.mode,
          status: "already_claimed",
          expiredIntentIds,
          revalidatedIntentIds,
          rejectedIntentIds,
          planning: undefined,
          consumedIntentId: error.intentId,
          state: this.store.getRuntimeState(agentId) ?? state,
          stateChanged: false,
        };
      }
      if (error instanceof RejectedPersonalLifePlan) {
        return {
          agentId,
          mode: this.mode,
          status: "rejected",
          expiredIntentIds,
          revalidatedIntentIds,
          rejectedIntentIds,
          planning: error.planning,
          consumedIntentId: undefined,
          state: this.store.getRuntimeState(agentId) ?? state,
          stateChanged: false,
        };
      }
      throw error;
    }
    if (outcome.planning.status === "committed") {
      this.sse.publish({
        type: "schedule.updated",
        agentId,
        occurredAtUtc: nowUtc,
        data: outcome.planning.changedItems,
      });
      if (outcome.stateChanged) {
        this.sse.publish({
          type: "state.updated",
          agentId,
          occurredAtUtc: nowUtc,
          data: outcome.nextState,
        });
      }
    }
    return {
      agentId,
      mode: this.mode,
      status: outcome.planning.status,
      expiredIntentIds,
      revalidatedIntentIds,
      rejectedIntentIds,
      planning: outcome.planning,
      consumedIntentId: outcome.consumedIntentId,
      state: outcome.nextState,
      stateChanged: outcome.stateChanged,
    };
  }

  private recordSelfPlanCommitted(
    agentId: string,
    planning: CommittedPlanningResult,
    correlationId: string,
    causationId: string,
    recordedAtUtc: string,
  ): void {
    const intentId = planning.bundle.intentId;
    const row = this.store.database
      .prepare(
        `SELECT COALESCE(MAX(stream_version), 0) + 1 AS nextVersion
         FROM domain_events
         WHERE stream_type = 'self_plan' AND stream_id = ?`,
      )
      .get(intentId) as { nextVersion: number };
    const inserted = this.store.insertDomainEvent({
      agentId,
      streamType: "self_plan",
      streamId: intentId,
      streamVersion: Number(row.nextVersion),
      eventType: "self_plan.committed",
      recordedAtUtc,
      payload: {
        intentId,
        createdScheduleItemIds: planning.createdItems
          .map((item) => item.id)
          .sort(),
        changedScheduleItemIds: planning.changedItems
          .map((item) => item.id)
          .sort(),
        lostSleepMinutes: planning.lostSleepMinutes,
        sleepAdjustment: planning.bundle.sleepAdjustment ?? null,
        correlationId,
        causationId,
      },
      correlationId,
      causationId,
      idempotencyKey: `personal-life:${agentId}:${intentId}:self-plan-committed`,
    });
    if (!inserted) {
      throw new Error("Failed to record self-plan commit lineage");
    }
  }

  private expireActiveIntents(
    agentId: string,
    correlationId: string,
  ): string[] {
    const expiredIntentIds: string[] = [];
    for (const intent of this.intents.listActive(agentId)) {
      const result = this.intents.expire({
        agentId,
        intentId: intent.id,
        correlationId,
        causationId: correlationId,
        idempotencyKey: `personal-life:${agentId}:${intent.id}:expire`,
      });
      if (result.transitioned) expiredIntentIds.push(intent.id);
    }
    return expiredIntentIds;
  }

  private ensureSpecDerivedIntents(
    character: CharacterSpec,
    correlationId: string,
  ): PersonalIntent[] {
    const active = this.intents.listActive(character.id);
    if (this.mode !== "enforced" || active.length > 0) return active;

    for (const seed of deriveSpecIntentSeeds(character)) {
      this.intents.upsertOrMerge({
        agentId: character.id,
        proposal: seed.proposal,
        correlationId,
        causationId: correlationId,
        idempotencyKey: `personal-life:${character.id}:spec:${character.version}:${stableId(
          "intent_source",
          `${seed.proposal.basisKind}:${seed.basisRefId}`,
        )}`,
      });
    }
    return this.intents.listActive(character.id);
  }
}

type SpecIntentBasis = "goal" | "preference" | "routine";

interface SpecIntentSeed {
  basisRefId: string;
  proposal: DerivedPersonalIntentProposal & { basisKind: SpecIntentBasis };
}

/** At most one stable candidate per grounded CharacterSpec source kind. */
function deriveSpecIntentSeeds(character: CharacterSpec): SpecIntentSeed[] {
  const goal = highestPriority(
    character.persona.goals,
    (item) => item.priority,
  );
  const preference = highestPriority(
    character.persona.preferences,
    (item) => item.intensity,
  );
  const routine = highestPriority(character.routines, (item) => item.priority);
  const seeds: SpecIntentSeed[] = [];

  if (goal !== undefined) {
    const goalText = `${goal.title} ${goal.description}`;
    const activity = primaryGoalActivity(goal.title);
    seeds.push({
      basisRefId: goal.id,
      proposal: {
        basisKind: "goal",
        activity,
        category: normalizePersonalIntentCategory(undefined, activity),
        timingHint: specDerivedTimingHint(goalText),
        basisRefIds: [goal.id],
        reasonCode: "character_goal_intent",
        reasonSummary:
          "The published character goal deterministically seeded this intent.",
        priority: goal.priority,
        freshness: 1,
      },
    });
  }
  if (preference !== undefined) {
    const preferenceText = [
      preference.subject,
      preference.preference,
      ...preference.conditions,
    ].join(" ");
    const activity = actionablePreferenceActivity(preferenceText);
    if (activity !== undefined) {
      seeds.push({
        basisRefId: preference.id,
        proposal: {
          basisKind: "preference",
          activity,
          category: normalizePersonalIntentCategory(undefined, preferenceText),
          timingHint: specDerivedTimingHint(preferenceText),
          basisRefIds: [preference.id],
          reasonCode: "character_preference_intent",
          reasonSummary:
            "An actionable published character preference deterministically seeded this intent.",
          priority: preference.intensity,
          freshness: 1,
        },
      });
    }
  }
  if (routine !== undefined) {
    seeds.push({
      basisRefId: routine.id,
      proposal: {
        basisKind: "routine",
        activity: routine.title,
        category: normalizePersonalIntentCategory(
          routine.category,
          routine.title,
        ),
        durationHint: `${routine.preferredDurationMinutes} minutes`,
        timingHint: "within 3 days",
        basisRefIds: [routine.id],
        reasonCode: "character_routine_intent",
        reasonSummary:
          "The published character routine deterministically seeded this intent.",
        priority: routine.priority,
        freshness: 1,
      },
    });
  }

  return seeds;
}

function primaryGoalActivity(title: string): string {
  const compact = title.replace(/\s+/gu, " ").trim();
  const primaryClause =
    compact.split(
      /(?:[,，;；]\s*)?(?:同时(?:还|也)?|并且|并保证|且要|但(?:也)?)\s*/u,
      1,
    )[0] ?? compact;
  const withoutLeadingTime = primaryClause.replace(
    /^(?:在)?(?:(?:本|这|下)?周[一二三四五六日天]|(?:本|这|下)?星期[一二三四五六日天]|今天|今日|今晚|明天|明日|后天)(?:早上|早晨|上午|中午|下午|傍晚|晚上|晚间|夜里|深夜)?/u,
    "",
  );
  const withoutCompletionVerb = withoutLeadingTime.replace(
    /^(?:完成|推进|进行|做好|开展|处理|安排)/u,
    "",
  );
  const normalized =
    withoutCompletionVerb.trim() || withoutLeadingTime.trim() || primaryClause;
  return normalized.slice(0, 160);
}

const ACTIONABLE_PREFERENCE_PATTERNS: readonly RegExp[] = [
  /剪辑|编辑(?:视频|影像|照片)|(?:video|photo)\s*edit(?:ing)?/iu,
  /摄影|拍照|照相|photograph(?:y|ing)?|photo\s*shoot/iu,
  /跑步|慢跑|running|jogging/iu,
  /散步|步行|walk(?:ing)?/iu,
  /阅读|看书|read(?:ing)?/iu,
  /听(?:音乐|歌)|listen(?:ing)?\s+to\s+music|music/iu,
  /看(?:电影|影片)|watch(?:ing)?\s+(?:a\s+)?(?:movie|film)|cinema/iu,
  /玩(?:游戏)?|gaming|play(?:ing)?\s+(?:a\s+)?game/iu,
  /做饭|烹饪|下厨|cook(?:ing)?/iu,
  /冥想|meditat(?:e|ing|ion)/iu,
  /健身|锻炼|work(?:ing)?\s*out|fitness/iu,
  /写作|写(?:日记|文章|故事)|writ(?:e|ing)/iu,
  /绘画|画画|素描|paint(?:ing)?|draw(?:ing)?|sketch(?:ing)?/iu,
];

function actionablePreferenceActivity(text: string): string | undefined {
  for (const pattern of ACTIONABLE_PREFERENCE_PATTERNS) {
    const matched = pattern.exec(text)?.[0]?.replace(/\s+/gu, " ").trim();
    if (matched !== undefined && matched !== "") {
      return matched.slice(0, 160);
    }
  }
  return undefined;
}

function specDerivedTimingHint(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  const hasGroundedTiming =
    /今天|今日|今晚|明天|明日|明早|后天|周末|(?:下|本|这)?周[一二三四五六日天]|(?:下|本|这)?星期[一二三四五六日天]|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|夜里|深夜|today|tonight|tomorrow|weekend|(?:next|this)?\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|morning|noon|afternoon|evening|night|within\s+\d+\s+days?/iu.test(
      compact,
    );
  return hasGroundedTiming ? compact.slice(0, 240) : "within 3 days";
}

function highestPriority<T extends { id: string }>(
  items: readonly T[],
  priority: (item: T) => number,
): T | undefined {
  return [...items].sort((left, right) => {
    const byPriority = priority(right) - priority(left);
    if (byPriority !== 0) return byPriority;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  })[0];
}

function offResult(agentId: string): PersonalLifeServiceResult {
  return {
    agentId,
    mode: "off",
    status: "off",
    expiredIntentIds: [],
    revalidatedIntentIds: [],
    rejectedIntentIds: [],
    planning: undefined,
    consumedIntentId: undefined,
    state: undefined,
    stateChanged: false,
  };
}

function planningHorizonEnd(
  nowUtc: string,
  persistedHorizonUtc: string,
): string {
  const nowMillis = Date.parse(nowUtc);
  const persistedMillis = Date.parse(persistedHorizonUtc);
  if (!Number.isFinite(nowMillis) || !Number.isFinite(persistedMillis)) {
    throw new TypeError("Personal life planning requires valid UTC instants");
  }
  if (persistedMillis <= nowMillis) {
    throw new TypeError("Personal life planning horizon must be in the future");
  }
  return new Date(
    Math.min(persistedMillis, nowMillis + MAX_PLANNING_HOURS * 60 * 60 * 1_000),
  ).toISOString();
}
