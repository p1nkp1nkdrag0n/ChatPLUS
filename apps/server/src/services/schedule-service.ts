import { DateTime } from "luxon";
import {
  plan72HoursDetailed,
  validateScheduleProposals,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import { capabilitiesForTier } from "../domain/capabilities.js";
import {
  toFeatureScheduleEffects,
  toFeatureScheduleItems,
} from "../domain/feature-adapters.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import {
  schedulePlanSchema,
  scheduleItemDraftSchema,
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
    if (
      (!capabilitiesForTier(spec.tier).schedule ||
        !spec.schedulePolicy.enabled) &&
      effects.length > 0
    ) {
      return {
        valid: false,
        issues: [
          {
            index: 0,
            code: "schedule_disabled",
            message: "Scheduling is disabled for this character.",
          },
        ],
      };
    }
    const result = validateScheduleProposals(
      toFeatureScheduleEffects(effects),
      {
        agentId,
        nowUtc,
        timezone: spec.identity.timezone,
        existingItems: toFeatureScheduleItems(this.store.listSchedule(agentId)),
        policy: spec.schedulePolicy,
        horizonHours: 72,
      },
    );
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

  applyValidatedEffects(
    agentId: string,
    effects: ScheduleEffectProposal[],
    nowUtc: string,
  ): ScheduleItem[] {
    const changed: ScheduleItem[] = [];
    for (const effect of effects) {
      if (effect.operation === "create") {
        const item = materializeScheduleItem(agentId, effect.item, nowUtc);
        this.store.insertScheduleItem(item);
        changed.push(item);
        continue;
      }
      if (effect.operation === "cancel") {
        const item = this.store.getScheduleItem(effect.itemId);
        if (!item || item.agentId !== agentId) throw notFound("Schedule item");
        item.status = "cancelled";
        item.revision += 1;
        item.updatedAtUtc = nowUtc;
        this.store.updateScheduleItem(item);
        changed.push(item);
        continue;
      }
      const item = this.store.getScheduleItem(effect.itemId);
      if (!item || item.agentId !== agentId) throw notFound("Schedule item");
      item.startAtUtc = canonicalUtc(effect.newStartAtUtc);
      item.endAtUtc = canonicalUtc(effect.newEndAtUtc);
      item.source = "runtime_replan";
      item.revision += 1;
      item.updatedAtUtc = nowUtc;
      this.store.updateScheduleItem(item);
      changed.push(item);
    }
    return changed;
  }
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
