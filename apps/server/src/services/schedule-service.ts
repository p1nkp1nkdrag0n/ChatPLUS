import type {
  ScheduleMutationBundle,
  SelfPlanBundle,
} from "@personasim/contracts";
import { DateTime } from "luxon";
import {
  plan72HoursDetailed,
  validateFinalScheduleProjection,
  type FinalScheduleProjectionError,
  type ScheduleItemLike,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import { capabilitiesForTier } from "../domain/capabilities.js";
import { toFeatureScheduleItems } from "../domain/feature-adapters.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import {
  schedulePlanSchema,
  scheduleItemDraftSchema,
  scheduleItemSchema,
  type CharacterSpec,
  type ScheduleEffectProposal,
  type ScheduleItem,
  type ScheduleItemDraft,
  type SchedulePlanProposal,
} from "../domain/schemas.js";
import { canonicalUtc, compareUtc } from "../domain/time.js";
import type { Clock } from "../runtime/clock.js";
import type { LlmService } from "./llm-service.js";

export type ProposalValidation =
  | { valid: true; effects: ScheduleEffectProposal[] }
  | {
      valid: false;
      issues: Array<{ index: number; code: string; message: string }>;
    };

export type PartialProposalValidation = {
  accepted: ScheduleEffectProposal[];
  rejections: Array<{
    index: number;
    code: string;
    message: string;
    proposal: ScheduleEffectProposal;
  }>;
};

export type ScheduleBundleTransactionMode = "auto" | "caller_owned";

export interface ApplyScheduleBundleOptions {
  /**
   * The default opens a local transaction. Use caller_owned only while
   * already inside a wider database transaction.
   */
  transaction?: ScheduleBundleTransactionMode;
  nowUtc?: string;
  minimumSleepMinutes?: number;
  correlationId?: string;
  causationId?: string;
  /**
   * Ownership guard for transitional callers. A legacy effect and a
   * server-owned bundle may never write in the same invocation.
   */
  legacyEffects?: readonly ScheduleEffectProposal[];
}

export type ScheduleBundleFailureReason =
  "mixed_write_modes" | "schedule_disabled" | "validation_failed";

export type ScheduleBundleError =
  | FinalScheduleProjectionError
  | {
      code: "MIXED_SCHEDULE_WRITE_MODES" | "SCHEDULE_DISABLED";
      path: string;
      message: string;
    };

interface ScheduleBundleApplyBase {
  errors: ScheduleBundleError[];
  projectedItems: ScheduleItem[];
  createdItems: ScheduleItem[];
  updatedItems: ScheduleItem[];
  changedItems: ScheduleItem[];
  lostSleepMinutes: number;
}

export type ScheduleBundleApplyResult =
  | (ScheduleBundleApplyBase & { ok: true })
  | (ScheduleBundleApplyBase & {
      ok: false;
      reason: ScheduleBundleFailureReason;
    });

type ServerOwnedScheduleBundle = ScheduleMutationBundle | SelfPlanBundle;

export class ScheduleService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
  ) {}

  list(agentId: string, fromUtc?: string, toUtc?: string): ScheduleItem[] {
    if (!this.store.getCharacterSummary(agentId)) throw notFound("Character");
    return this.store.listSchedule(agentId, {
      ...(fromUtc ? { fromUtc } : {}),
      ...(toUtc ? { toUtc } : {}),
    });
  }

  async ensure72Hours(
    agentId: string,
    force = false,
  ): Promise<{
    created: ScheduleItem[];
    horizonEndUtc: string;
    fallbackUsed: boolean;
  }> {
    const spec = this.store.getCharacterSpec(agentId);
    const cursor = this.store.getCursor(agentId);
    if (!spec || !cursor) throw notFound("Character");
    const nowUtc = this.clock.nowUtc();
    if (
      spec.status !== "published" ||
      !capabilitiesForTier(spec.tier).schedule ||
      !spec.schedulePolicy.enabled
    ) {
      return {
        created: [],
        horizonEndUtc: cursor.scheduleHorizonEndUtc,
        fallbackUsed: false,
      };
    }
    const targetEndUtc = DateTime.fromISO(nowUtc, { setZone: true })
      .plus({ hours: 72 })
      .toUTC()
      .toISO()!;
    const remainingHours = DateTime.fromISO(cursor.scheduleHorizonEndUtc).diff(
      DateTime.fromISO(nowUtc),
      "hours",
    ).hours;
    if (
      !force &&
      remainingHours >= spec.schedulePolicy.extendWhenRemainingHoursBelow
    ) {
      return {
        created: [],
        horizonEndUtc: cursor.scheduleHorizonEndUtc,
        fallbackUsed: false,
      };
    }

    const existing = this.store.listSchedule(agentId, {
      fromUtc: nowUtc,
      toUtc: targetEndUtc,
    });
    const startUtc =
      existing.length === 0
        ? nowUtc
        : compareUtc(cursor.scheduleHorizonEndUtc, nowUtc) >= 0
          ? cursor.scheduleHorizonEndUtc
          : nowUtc;
    const deterministicPlan = buildDeterministicPlan(
      spec,
      nowUtc,
      startUtc,
      targetEndUtc,
      existing,
    );
    let plan = deterministicPlan;
    let fallbackUsed = false;
    try {
      plan = await this.llm.generateObject({
        purpose: "plan_schedule",
        agentId,
        system:
          "Plan only the missing part of a fictional character schedule. Use UTC ISO instants, preserve fixed items, include sleep and meals, avoid overlaps, and never alter historical activities.",
        prompt:
          `Character policy: ${JSON.stringify({
            identity: spec.identity,
            routines: spec.routines,
            schedulePolicy: spec.schedulePolicy,
          })}\nMissing range: ${startUtc} through ${targetEndUtc}.\n` +
          `Existing immutable items: ${JSON.stringify(existing)}\n` +
          `Return one strict JSON object with exactly these top-level fields: ` +
          `{"horizonStartAtUtc":${JSON.stringify(startUtc)},` +
          `"horizonEndAtUtc":${JSON.stringify(targetEndUtc)},` +
          '"reasonCode":"schedule_plan","reasonSummary":"A concise outcome summary no longer than 240 characters","items":ScheduleItemDraft[]}. ' +
          `Copy horizonStartAtUtc and horizonEndAtUtc exactly as shown; do not omit, round, translate, or replace them. ` +
          `Do not add other top-level fields or Markdown fences.`,
        schema: schedulePlanSchema,
        fixture: deterministicPlan,
      });
    } catch {
      fallbackUsed = true;
      plan = deterministicPlan;
    }

    let drafts = plan.items.filter(
      (item) =>
        compareUtc(item.startAtUtc, startUtc) >= 0 &&
        compareUtc(item.endAtUtc, targetEndUtc) <= 0,
    );
    const planIssues = [
      ...validatePlanCoverage(plan, drafts, startUtc, targetEndUtc),
      ...validateDraftSet(spec, drafts, existing, nowUtc, targetEndUtc),
    ];
    if (planIssues.length > 0) {
      fallbackUsed = true;
      drafts = deterministicPlan.items;
      const fallbackIssues = [
        ...validatePlanCoverage(
          deterministicPlan,
          drafts,
          startUtc,
          targetEndUtc,
        ),
        ...validateDraftSet(spec, drafts, existing, nowUtc, targetEndUtc),
      ];
      if (fallbackIssues.length > 0) {
        throw new ApiError(
          500,
          "schedule_fallback_invalid",
          "The deterministic schedule failed validation.",
          {
            issues: fallbackIssues,
          },
        );
      }
    }

    const createdAtUtc = this.clock.nowUtc();
    const created = drafts.map((draft) =>
      materializeScheduleItem(agentId, draft, createdAtUtc),
    );
    this.store.transaction(() => {
      for (const item of created) this.store.insertScheduleItem(item);
      const latestEnd = created.reduce(
        (latest, item) =>
          compareUtc(item.endAtUtc, latest) > 0 ? item.endAtUtc : latest,
        cursor.scheduleHorizonEndUtc,
      );
      this.store.updateCursor({
        ...cursor,
        scheduleHorizonEndUtc:
          compareUtc(latestEnd, targetEndUtc) > 0 ? latestEnd : targetEndUtc,
        revision: cursor.revision + 1,
      });
      if (created.length > 0) {
        this.store.insertDomainEvent({
          agentId,
          streamType: "schedule",
          streamId: agentId,
          streamVersion: cursor.revision + 1,
          eventType:
            existing.length === 0
              ? "schedule.initialized"
              : "schedule.extended",
          recordedAtUtc: createdAtUtc,
          payload: {
            count: created.length,
            startUtc,
            targetEndUtc,
            fallbackUsed,
          },
          idempotencyKey: `schedule:${agentId}:horizon:${targetEndUtc}`,
        });
      }
    });
    return { created, horizonEndUtc: targetEndUtc, fallbackUsed };
  }

  validateEffects(
    agentId: string,
    effects: ScheduleEffectProposal[],
    nowUtc = this.clock.nowUtc(),
  ): ProposalValidation {
    const spec = this.store.getCharacterSpec(agentId);
    if (!spec) throw notFound("Character");
    const result = this.validateBatch(agentId, spec, effects, nowUtc);
    if (result.valid) return { valid: true, effects };
    return {
      valid: false,
      issues: result.errors.map((error, index) => ({
        index,
        code: error.code.toLowerCase(),
        message: error.message,
      })),
    };
  }

  /**
   * Validates proposals one by one against a growing accepted prefix. A
   * rejected proposal only drops itself, so one invalid effect can never
   * void the others or the conversational reply it travelled with.
   */
  validateEffectsPartial(
    agentId: string,
    effects: ScheduleEffectProposal[],
    nowUtc = this.clock.nowUtc(),
  ): PartialProposalValidation {
    const spec = this.store.getCharacterSpec(agentId);
    if (!spec) throw notFound("Character");
    const accepted: ScheduleEffectProposal[] = [];
    const rejections: PartialProposalValidation["rejections"] = [];
    for (const effect of effects) {
      const result = this.validateBatch(
        agentId,
        spec,
        [...accepted, effect],
        nowUtc,
      );
      if (result.valid) {
        accepted.push(effect);
        continue;
      }
      const first = result.errors[0];
      rejections.push({
        index: accepted.length + rejections.length,
        code: (first?.code ?? "proposal_rejected").toLowerCase(),
        message: first?.message ?? "The proposal failed schedule validation.",
        proposal: effect,
      });
    }
    return { accepted, rejections };
  }

  private validateBatch(
    agentId: string,
    spec: CharacterSpec,
    effects: ScheduleEffectProposal[],
    nowUtc: string,
  ):
    | { valid: true }
    | { valid: false; errors: Array<{ code: string; message: string }> } {
    if (effects.length === 0) return { valid: true };
    if (
      !capabilitiesForTier(spec.tier).schedule ||
      !spec.schedulePolicy.enabled
    ) {
      return {
        valid: false,
        errors: [
          {
            code: "schedule_disabled",
            message: "Scheduling is disabled for this character.",
          },
        ],
      };
    }
    const result = validateFinalScheduleProjection(
      legacyEffectsAsMutationBundle(effects),
      {
        agentId,
        nowUtc,
        timezone: spec.identity.timezone,
        existingItems: toFeatureScheduleItems(this.store.listSchedule(agentId)),
        policy: spec.schedulePolicy,
        horizonHours: 72,
      },
    );
    if (result.valid) return { valid: true };
    return {
      valid: false,
      errors: result.errors.map((error) => ({
        code: error.code,
        message: error.message,
      })),
    };
  }

  applyMutationBundle(
    agentId: string,
    bundle: ScheduleMutationBundle,
    options: ApplyScheduleBundleOptions = {},
  ): ScheduleBundleApplyResult {
    return this.applyServerOwnedBundle(agentId, bundle, options);
  }

  applySelfPlanBundle(
    agentId: string,
    bundle: SelfPlanBundle,
    options: ApplyScheduleBundleOptions = {},
  ): ScheduleBundleApplyResult {
    return this.applyServerOwnedBundle(agentId, bundle, options);
  }

  private applyServerOwnedBundle(
    agentId: string,
    bundle: ServerOwnedScheduleBundle,
    options: ApplyScheduleBundleOptions,
  ): ScheduleBundleApplyResult {
    const apply = (): ScheduleBundleApplyResult => {
      const spec = this.store.getCharacterSpec(agentId);
      if (!spec) throw notFound("Character");
      const existing = this.store.listSchedule(agentId);

      if ((options.legacyEffects?.length ?? 0) > 0) {
        return bundleFailure("mixed_write_modes", existing, {
          code: "MIXED_SCHEDULE_WRITE_MODES",
          path: "bundle",
          message:
            "Legacy schedule effects and a server-owned bundle are mutually exclusive",
        });
      }
      if (
        !capabilitiesForTier(spec.tier).schedule ||
        !spec.schedulePolicy.enabled
      ) {
        return bundleFailure("schedule_disabled", existing, {
          code: "SCHEDULE_DISABLED",
          path: "bundle",
          message: "Scheduling is disabled for this character",
        });
      }

      const nowUtc = options.nowUtc ?? this.clock.nowUtc();
      const projection = validateFinalScheduleProjection(bundle, {
        agentId,
        nowUtc,
        timezone: spec.identity.timezone,
        existingItems: toFeatureScheduleItems(existing),
        policy: spec.schedulePolicy,
        horizonHours: spec.schedulePolicy.horizonHours,
        ...(options.minimumSleepMinutes === undefined
          ? {}
          : { minimumSleepMinutes: options.minimumSleepMinutes }),
      });
      if (!projection.ok) {
        return {
          ok: false,
          reason: "validation_failed",
          errors: projection.errors,
          projectedItems: existing,
          createdItems: [],
          updatedItems: [],
          changedItems: [],
          lostSleepMinutes: 0,
        };
      }

      // The validator owns the candidate projection. Persistence metadata is
      // regenerated here so no planner can choose ids, timestamps, or revision.
      const lineage =
        "intentId" in bundle
          ? {
              sourceIntentId: bundle.intentId,
              correlationId: options.correlationId ?? bundle.intentId,
              causationId: options.causationId ?? bundle.intentId,
            }
          : {};
      const createdItems = projection.createdItems.map((item) =>
        materializeProjectedCreate(agentId, item, nowUtc, lineage),
      );
      const updatedItems = projection.changedItems.map((item) =>
        materializeProjectedUpdate(item, nowUtc),
      );
      const createdByProjectionId = new Map(
        projection.createdItems.map((item, index) => [
          item.id,
          createdItems[index]!,
        ]),
      );
      const updatedById = new Map(updatedItems.map((item) => [item.id, item]));
      const existingById = new Map(existing.map((item) => [item.id, item]));
      const projectedItems = projection.projectedItems.map(
        (item) =>
          createdByProjectionId.get(item.id) ??
          updatedById.get(item.id) ??
          existingById.get(item.id) ??
          scheduleItemSchema.parse(item),
      );

      for (const item of createdItems) this.store.insertScheduleItem(item);
      for (const item of updatedItems) this.store.updateScheduleItem(item);
      return {
        ok: true,
        errors: [],
        projectedItems,
        createdItems,
        updatedItems,
        changedItems: [...createdItems, ...updatedItems],
        lostSleepMinutes: projection.lostSleepMinutes,
      };
    };

    return options.transaction === "caller_owned"
      ? apply()
      : this.store.transaction(apply);
  }

  applyValidatedEffects(
    agentId: string,
    effects: ScheduleEffectProposal[],
    nowUtc: string,
  ): ScheduleItem[] {
    if (effects.length === 0) return [];
    const result = this.applyServerOwnedBundle(
      agentId,
      legacyEffectsAsMutationBundle(effects),
      {
        nowUtc,
        transaction: this.store.database?.inTransaction
          ? "caller_owned"
          : "auto",
      },
    );
    if (!result.ok) {
      throw new ApiError(
        409,
        "schedule_projection_rejected",
        "The validated schedule effects no longer produce a valid final projection.",
        result.errors,
      );
    }
    return result.changedItems;
  }
}

function legacyEffectsAsMutationBundle(
  effects: readonly ScheduleEffectProposal[],
): ScheduleMutationBundle {
  const create: NonNullable<ScheduleMutationBundle["create"]> = [];
  const reschedule: NonNullable<ScheduleMutationBundle["reschedule"]> = [];
  const cancel: NonNullable<ScheduleMutationBundle["cancel"]> = [];

  for (const effect of effects) {
    if (effect.operation === "create") {
      create.push({
        title: effect.item.title,
        description: effect.item.description,
        category: effect.item.category,
        startAtUtc: effect.item.startAtUtc,
        endAtUtc: effect.item.endAtUtc,
        timezone: effect.item.timezone,
        rigidity: effect.item.rigidity,
        priority: effect.item.priority,
        adherenceProbability: effect.item.adherenceProbability,
        narrativeImportance: effect.item.narrativeImportance,
        shareable: effect.item.shareable,
        stateEffects: effect.item.stateEffects,
      });
      continue;
    }
    if (effect.operation === "reschedule") {
      reschedule.push({
        itemId: effect.itemId,
        newStartAtUtc: effect.newStartAtUtc,
        newEndAtUtc: effect.newEndAtUtc,
      });
      continue;
    }
    cancel.push({ itemId: effect.itemId });
  }

  return {
    owner: "user_negotiation",
    ...(create.length === 0 ? {} : { create }),
    ...(reschedule.length === 0 ? {} : { reschedule }),
    ...(cancel.length === 0 ? {} : { cancel }),
  };
}

function buildDeterministicPlan(
  spec: CharacterSpec,
  nowUtc: string,
  startUtc: string,
  endUtc: string,
  existing: ScheduleItem[],
): SchedulePlanProposal {
  const planned = plan72HoursDetailed({
    character: spec,
    nowUtc,
    existingItems: toFeatureScheduleItems(existing),
    horizonHours: 72,
  });
  const drafts = planned.createdItems.map((item) =>
    scheduleItemDraftSchema.parse(stripItemMetadata(item)),
  );
  return {
    horizonStartAtUtc: startUtc,
    horizonEndAtUtc: endUtc,
    items: drafts.sort((left, right) =>
      compareUtc(left.startAtUtc, right.startAtUtc),
    ),
    reasonCode: "deterministic_schedule",
    reasonSummary: "根据角色日常习惯生成可重复的未来七十二小时日程。",
  };
}

function stripItemMetadata(item: object): Record<string, unknown> {
  const draft = structuredClone(item) as unknown as Record<string, unknown>;
  for (const field of [
    "id",
    "agentId",
    "status",
    "revision",
    "createdAtUtc",
    "updatedAtUtc",
    "sourceIntentId",
    "correlationId",
    "causationId",
  ]) {
    delete draft[field];
  }
  return draft;
}

function materializeScheduleItem(
  agentId: string,
  draft: ScheduleItemDraft,
  nowUtc: string,
  forcedId?: string,
): ScheduleItem {
  return {
    ...draft,
    id: forcedId ?? createEntityId("schedule"),
    agentId,
    startAtUtc: canonicalUtc(draft.startAtUtc),
    endAtUtc: canonicalUtc(draft.endAtUtc),
    status: "planned",
    revision: 0,
    createdAtUtc: nowUtc,
    updatedAtUtc: nowUtc,
  };
}

function bundleFailure(
  reason: ScheduleBundleFailureReason,
  existing: ScheduleItem[],
  error: ScheduleBundleError,
): ScheduleBundleApplyResult {
  return {
    ok: false,
    reason,
    errors: [error],
    projectedItems: existing,
    createdItems: [],
    updatedItems: [],
    changedItems: [],
    lostSleepMinutes: 0,
  };
}

function materializeProjectedCreate(
  agentId: string,
  item: ScheduleItemLike,
  nowUtc: string,
  lineage: Partial<
    Pick<ScheduleItem, "sourceIntentId" | "correlationId" | "causationId">
  > = {},
): ScheduleItem {
  const draft = scheduleItemDraftSchema.parse(stripItemMetadata(item));
  return scheduleItemSchema.parse({
    ...materializeScheduleItem(agentId, draft, nowUtc),
    ...lineage,
  });
}

function materializeProjectedUpdate(
  item: ScheduleItemLike,
  nowUtc: string,
): ScheduleItem {
  return scheduleItemSchema.parse({
    ...item,
    startAtUtc: canonicalUtc(item.startAtUtc),
    endAtUtc: canonicalUtc(item.endAtUtc),
    updatedAtUtc: nowUtc,
  });
}

function validateDraftSet(
  spec: CharacterSpec,
  drafts: ScheduleItemDraft[],
  existing: ScheduleItem[],
  nowUtc: string,
  limitUtc: string,
): Array<{ code: string; message: string }> {
  const issues: Array<{ code: string; message: string }> = [];
  const materialized: ScheduleItem[] = [];
  drafts.forEach((draft, index) => {
    const issue = validateFutureDraft(draft, nowUtc, limitUtc, true);
    if (issue)
      issues.push({ code: `${issue.code}:${index}`, message: issue.message });
    const item = materializeScheduleItem(
      spec.id,
      draft,
      nowUtc,
      `draft-${index}`,
    );
    const conflict = findConflict(item, [...existing, ...materialized]);
    if (conflict)
      issues.push({
        code: `overlap:${index}`,
        message: `${item.title} overlaps ${conflict.title}.`,
      });
    materialized.push(item);
  });
  const commitment = validateCommitmentLimits(spec, [
    ...existing,
    ...materialized,
  ]);
  if (commitment) issues.push(commitment);
  if (
    drafts.length > 0 &&
    ![...existing, ...materialized].some((item) => item.category === "sleep")
  ) {
    issues.push({
      code: "sleep_missing",
      message: "The plan does not include sleep.",
    });
  }
  return issues;
}

function validatePlanCoverage(
  plan: SchedulePlanProposal,
  drafts: ScheduleItemDraft[],
  startUtc: string,
  endUtc: string,
): Array<{ code: string; message: string }> {
  const issues: Array<{ code: string; message: string }> = [];
  if (compareUtc(startUtc, endUtc) < 0 && drafts.length === 0) {
    issues.push({
      code: "empty_plan",
      message: "The missing schedule range must contain activities.",
    });
  }
  if (
    compareUtc(plan.horizonStartAtUtc, startUtc) !== 0 ||
    compareUtc(plan.horizonEndAtUtc, endUtc) !== 0
  ) {
    issues.push({
      code: "horizon_mismatch",
      message:
        "The proposed schedule envelope must exactly match the requested horizon.",
    });
  }
  return issues;
}

function validateFutureDraft(
  draft: Pick<ScheduleItemDraft, "startAtUtc" | "endAtUtc">,
  nowUtc: string,
  limitUtc: string,
  allowStartedRange = false,
): { code: string; message: string } | undefined {
  if (compareUtc(draft.startAtUtc, draft.endAtUtc) >= 0) {
    return {
      code: "invalid_interval",
      message: "Start time must be before end time.",
    };
  }
  if (
    (!allowStartedRange && compareUtc(draft.startAtUtc, nowUtc) <= 0) ||
    compareUtc(draft.endAtUtc, nowUtc) <= 0
  ) {
    return {
      code: "not_future",
      message: "Schedule changes must be in the future.",
    };
  }
  if (compareUtc(draft.endAtUtc, limitUtc) > 0) {
    return {
      code: "outside_horizon",
      message: "Schedule changes must remain within 72 hours.",
    };
  }
  return undefined;
}

function findConflict(
  candidate: ScheduleItem,
  items: ScheduleItem[],
  ignoreId?: string,
): ScheduleItem | undefined {
  return items.find(
    (item) =>
      item.id !== ignoreId &&
      item.status !== "cancelled" &&
      compareUtc(candidate.startAtUtc, item.endAtUtc) < 0 &&
      compareUtc(candidate.endAtUtc, item.startAtUtc) > 0,
  );
}

function validateCommitmentLimits(
  spec: CharacterSpec,
  items: ScheduleItem[],
): { code: string; message: string } | undefined {
  const totals = new Map<string, number>();
  for (const item of items) {
    if (item.status === "cancelled" || item.rigidity !== "committed") continue;
    const start = DateTime.fromISO(item.startAtUtc).setZone(
      spec.identity.timezone,
    );
    const hours = DateTime.fromISO(item.endAtUtc).diff(
      DateTime.fromISO(item.startAtUtc),
      "hours",
    ).hours;
    totals.set(
      start.toISODate()!,
      (totals.get(start.toISODate()!) ?? 0) + hours,
    );
  }
  for (const [day, hours] of totals) {
    if (hours > spec.schedulePolicy.maxCommittedHoursPerDay + 0.001) {
      return {
        code: "commitment_limit",
        message: `${day} exceeds the character's daily committed-hour limit.`,
      };
    }
  }
  return undefined;
}
