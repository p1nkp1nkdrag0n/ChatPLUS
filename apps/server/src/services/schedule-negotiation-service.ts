import { DateTime } from "luxon";
import {
  ScheduleEffectProposalSchema,
  type ScheduleEffectProposal,
  type ScheduleNegotiationAction,
  type ScheduleNegotiationOffer,
} from "@personasim/contracts";
import {
  createScheduleNegotiation,
  parseModelTime,
  reduceScheduleNegotiation,
  type CanonicalScheduleOffer,
  type PartialScheduleOfferDetails,
  type ScheduleNegotiation,
  type ScheduleNegotiationTransition,
} from "@personasim/features";

import type {
  DatabaseStore,
  StoredMessage,
  StoredScheduleNegotiation,
} from "../db/store.js";
import { createEntityId } from "../domain/id.js";
import type { ScheduleService } from "./schedule-service.js";

const NEGOTIATION_TTL_MINUTES = 30;
export const SCHEDULE_NEGOTIATION_POLICY_VERSION = 2;

const DEFAULT_DURATION_MINUTES: Record<string, number> = {
  sleep: 480,
  work: 60,
  study: 60,
  meal: 60,
  exercise: 30,
  social: 90,
  travel: 60,
  leisure: 60,
  self_care: 45,
  errand: 60,
  other: 60,
};

type ActivityFamily = {
  id: string;
  label: string;
  pattern: RegExp;
};

const ACTIVITY_FAMILIES: Record<string, readonly ActivityFamily[]> = {
  sleep: [
    { id: "sleep", label: "睡觉", pattern: /睡觉|睡眠|\bsleep\b/iu },
    { id: "nap", label: "午休", pattern: /午休|小憩|\bnap\b/iu },
  ],
  work: [
    { id: "work", label: "工作", pattern: /工作|上班|加班|\bwork\b/iu },
    { id: "meeting", label: "开会", pattern: /开会|会议|\bmeeting\b/iu },
    { id: "writing", label: "写稿", pattern: /写稿|写作|\bwriting\b/iu },
  ],
  study: [
    { id: "study", label: "学习", pattern: /学习|复习|功课|\bstudy\b/iu },
    { id: "self-study", label: "自习", pattern: /自习/iu },
    { id: "class", label: "上课", pattern: /上课|课程|\bclass\b/iu },
  ],
  meal: [
    {
      id: "breakfast",
      label: "吃早餐",
      pattern: /早餐|早饭|\bbreakfast\b/iu,
    },
    { id: "lunch", label: "吃午餐", pattern: /午餐|午饭|\blunch\b/iu },
    { id: "dinner", label: "吃晚餐", pattern: /晚餐|晚饭|\bdinner\b/iu },
    { id: "meal", label: "吃饭", pattern: /吃饭|用餐|\bmeal\b/iu },
  ],
  exercise: [
    {
      id: "run",
      label: "跑步",
      pattern:
        /跑步|晨跑|夜跑|一起跑|陪(?:我|你)?跑|跑\s*(?:半|[零〇一二两三四五六七八九十\d.]+)\s*(?:个)?\s*(?:小时|分钟)|\b(?:run|runs|running|jog|jogs|jogging)\b/iu,
    },
    { id: "gym", label: "健身", pattern: /健身|\bgym\b/iu },
    {
      id: "walk",
      label: "散步",
      pattern: /散步|\b(?:walk|walks|walking)\b/iu,
    },
    { id: "exercise", label: "运动", pattern: /运动|锻炼|\bexercise\b/iu },
  ],
  social: [
    { id: "meet", label: "见面", pattern: /见面|碰面|\bmeet\b/iu },
    {
      id: "tea",
      label: "喝茶",
      pattern: /喝茶|品茶|下午茶|\btea\b/iu,
    },
    { id: "coffee", label: "喝咖啡", pattern: /喝咖啡|咖啡|\bcoffee\b/iu },
    {
      id: "party",
      label: "参加聚会",
      pattern: /聚会|晚会|派对|\bparty\b|\bgather(?:ing)?\b/iu,
    },
  ],
  travel: [
    {
      id: "travel",
      label: "旅行",
      pattern: /旅行|旅游|\btravel\b|\btrip\b/iu,
    },
    {
      id: "outing",
      label: "出游",
      pattern: /出游|远足|\bouting\b|\bhike\b/iu,
    },
  ],
  leisure: [
    { id: "movie", label: "看电影", pattern: /电影|\bmovie\b/iu },
    { id: "game", label: "玩游戏", pattern: /游戏|\bgame\b/iu },
    {
      id: "show",
      label: "看剧",
      pattern: /看剧|追剧|\bshow\b|\bseries\b/iu,
    },
  ],
  self_care: [
    {
      id: "rest",
      label: "休息",
      pattern: /休息|放松|\brest\b|\brelax\b/iu,
    },
    { id: "bath", label: "泡澡", pattern: /泡澡|洗澡|\bbath\b/iu },
    {
      id: "skin-care",
      label: "护肤",
      pattern: /护肤|\bskin(?:[\s-]?care)\b/iu,
    },
  ],
  errand: [
    {
      id: "groceries",
      label: "买菜",
      pattern: /买菜|\b(?:grocery|groceries)\b/iu,
    },
    { id: "shopping", label: "购物", pattern: /采购|购物|\bshopping\b/iu },
    {
      id: "errand",
      label: "办事",
      pattern: /办事|\berrand\b|\bchore\b/iu,
    },
  ],
};

const ALL_ACTIVITY_FAMILIES = Object.entries(ACTIVITY_FAMILIES).flatMap(
  ([category, families]) => families.map((family) => ({ ...family, category })),
);

export type ScheduleNegotiationRejection = {
  reasonCode: string;
  reasonSummary: string;
  raw: unknown;
};

export type PreparedScheduleNegotiation = {
  actionKind: ScheduleNegotiationAction["kind"];
  updates: StoredScheduleNegotiation[];
  expectedActive?: Pick<
    StoredScheduleNegotiation,
    "id" | "status" | "offerVersion"
  >;
  transition?: ScheduleNegotiationTransition;
  effect?: ScheduleEffectProposal;
  presentationText?: string;
  rejections: ScheduleNegotiationRejection[];
};

export type ActiveScheduleNegotiation = {
  stored: StoredScheduleNegotiation;
  state: ScheduleNegotiation;
  expired: boolean;
};

export class ScheduleNegotiationService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly schedules: ScheduleService,
  ) {}

  getActive(
    sessionId: string,
    nowUtc: string,
  ): ActiveScheduleNegotiation | undefined {
    const stored = this.store.getActiveScheduleNegotiation(sessionId);
    if (stored === undefined) return undefined;
    const state = negotiationStateFromStored(stored);
    if (state === undefined) return undefined;
    return {
      stored,
      state,
      expired:
        DateTime.fromISO(state.updatedAtUtc)
          .plus({ minutes: NEGOTIATION_TTL_MINUTES })
          .toMillis() <= DateTime.fromISO(nowUtc).toMillis(),
    };
  }

  prepare(input: {
    agentId: string;
    sessionId: string;
    timezone: string;
    nowUtc: string;
    userMessage: StoredMessage;
    assistantMessageId: string;
    recentMessages: readonly StoredMessage[];
    action: ScheduleNegotiationAction;
    allowTextActionInference: boolean;
  }): PreparedScheduleNegotiation {
    const rejections: ScheduleNegotiationRejection[] = [];
    const updates: StoredScheduleNegotiation[] = [];
    let active = this.getActive(input.sessionId, input.nowUtc);
    const explicitCancellation = isExplicitScheduleCancellation(
      input.userMessage.content,
    );
    if (input.allowTextActionInference && explicitCancellation) {
      input = { ...input, action: { kind: "withdraw_offer" } };
    } else if (input.allowTextActionInference && active !== undefined) {
      if (isUnambiguousScheduleConfirmation(input.userMessage.content)) {
        input = {
          ...input,
          action: {
            kind: "accept_pending_offer",
            evidenceQuotes: [input.userMessage.content],
          },
        };
      }
    }
    const initialActive = active;
    const finish = (
      plan: PreparedScheduleNegotiation,
    ): PreparedScheduleNegotiation =>
      initialActive !== undefined &&
      plan.updates.some((update) => update.id === initialActive.stored.id)
        ? {
            ...plan,
            expectedActive: activeIdentity(initialActive.stored),
          }
        : plan;

    if (active?.expired) {
      const expired = reduceScheduleNegotiation({
        state: active.state,
        action: { type: "expire", reasonCode: "negotiation_ttl_elapsed" },
        evidence: {
          current: {
            evidenceId: input.userMessage.id,
            observedAtUtc: input.nowUtc,
          },
        },
      });
      updates.push(toStoredNegotiation(expired.state, active.stored, input));
      active = undefined;
      if (input.action.kind === "accept_pending_offer") {
        rejections.push({
          reasonCode: "expired_pending_offer",
          reasonSummary: "The pending schedule offer has expired.",
          raw: input.action,
        });
        return finish({
          actionKind: input.action.kind,
          updates,
          transition: expired.transition,
          rejections,
        });
      }
    }

    if (
      active !== undefined &&
      isQuestionShapedScheduleControl(input.userMessage.content)
    ) {
      rejections.push({
        reasonCode: "confirmation_not_affirmative",
        reasonSummary:
          "A question about confirmation or cancellation is not an explicit decision.",
        raw: input.action,
      });
      return finish({
        actionKind: input.action.kind,
        updates,
        ...(active.state.offer === undefined
          ? {}
          : {
              presentationText: formatPendingOffer(
                active.state.offer,
                input.timezone,
              ),
            }),
        rejections,
      });
    }

    // `none` is the explicit no-op dialogue action. Inspecting arbitrary
    // non-schedule prose for unsupported mutation words before honoring the
    // no-op caused false positives such as "答辩结束后想吃…请记住". Genuine
    // cancellation is already promoted to withdraw_offer above; non-none
    // schedule actions still pass through the unsupported-operation guard.
    if (input.action.kind === "none") {
      return finish({
        actionKind: input.action.kind,
        updates,
        ...(active?.state.offer === undefined
          ? {}
          : {
              presentationText: formatPendingOffer(
                active.state.offer,
                input.timezone,
              ),
            }),
        rejections,
      });
    }

    if (
      !explicitCancellation &&
      UNSUPPORTED_SCHEDULE_OPERATION_PATTERN.test(input.userMessage.content)
    ) {
      rejections.push({
        reasonCode: "unsupported_schedule_operation",
        reasonSummary:
          "The negotiated writer currently supports new shared activities only, not cancel or reschedule commands.",
        raw: input.action,
      });
      return finish({
        actionKind: input.action.kind,
        updates,
        ...(active?.state.offer === undefined
          ? {}
          : {
              presentationText: formatPendingOffer(
                active.state.offer,
                input.timezone,
              ),
            }),
        rejections,
      });
    }

    if (
      input.action.kind === "decline_offer" ||
      input.action.kind === "withdraw_offer"
    ) {
      if (active === undefined) {
        if (input.action.kind === "withdraw_offer") {
          rejections.push({
            reasonCode: "missing_pending_offer",
            reasonSummary:
              "There is no active pending schedule offer to withdraw.",
            raw: input.action,
          });
        }
        return finish({
          actionKind: input.action.kind,
          updates,
          presentationText:
            input.action.kind === "decline_offer"
              ? "【未修改日程】角色没有接受这次日程提议。"
              : "【未修改日程】当前没有可取消的待确认方案。",
          rejections,
        });
      }
      const reduced = reduceScheduleNegotiation({
        state: active.state,
        action:
          input.action.kind === "decline_offer"
            ? { type: "decline", reasonCode: "character_declined" }
            : { type: "withdraw", reasonCode: "user_withdrew" },
        evidence: {
          current: {
            evidenceId: input.userMessage.id,
            observedAtUtc: input.nowUtc,
          },
        },
      });
      updates.push(toStoredNegotiation(reduced.state, active.stored, input));
      return finish({
        actionKind: input.action.kind,
        updates,
        transition: reduced.transition,
        presentationText:
          input.action.kind === "decline_offer"
            ? "【未修改日程】角色没有接受这次日程提议。"
            : "【未修改日程】待确认方案已取消，日程保持不变。",
        rejections,
      });
    }

    if (input.action.kind === "accept_pending_offer") {
      if (active === undefined) {
        rejections.push({
          reasonCode: "missing_pending_offer",
          reasonSummary:
            "A confirmation cannot change the schedule without one active offer.",
          raw: input.action,
        });
        return finish({ actionKind: input.action.kind, updates, rejections });
      }
      if (!isUnambiguousScheduleConfirmation(input.userMessage.content)) {
        rejections.push({
          reasonCode: "confirmation_not_affirmative",
          reasonSummary:
            "The pending offer requires an explicit affirmative reply without changed terms.",
          raw: input.action,
        });
        return finish({ actionKind: input.action.kind, updates, rejections });
      }
      if (
        !input.action.evidenceQuotes.every((quote) =>
          evidenceQuoteIsExact(quote, input.userMessage.content),
        )
      ) {
        rejections.push({
          reasonCode: "ungrounded_pending_confirmation",
          reasonSummary:
            "A pending offer can only be accepted with an exact quote from the current user message.",
          raw: input.action,
        });
        return finish({ actionKind: input.action.kind, updates, rejections });
      }
      return finish({
        ...this.acceptPending({
          ...input,
          action: input.action,
          active,
          updates,
          rejections,
        }),
      });
    }

    const evidenceQuotes = input.action.offer?.evidenceQuotes ?? [];
    const evidence = resolveOfferEvidence(
      evidenceQuotes,
      input.userMessage,
      input.recentMessages,
    );
    if (
      evidenceQuotes.length > 0 &&
      evidence.length !== evidenceQuotes.length
    ) {
      rejections.push({
        reasonCode: "ungrounded_negotiation_offer",
        reasonSummary:
          "The structured schedule offer was not grounded in a user message.",
        raw: input.action,
      });
      return finish({ actionKind: input.action.kind, updates, rejections });
    }
    const groundedClockRange =
      input.action.kind === "accept_user_offer"
        ? resolveGroundedClockRange(evidence, input.timezone)
        : undefined;
    if (
      input.action.kind === "accept_user_offer" &&
      groundedClockRange === undefined &&
      evidence.some((item) => hasAmbiguousStartExpression(item.quote))
    ) {
      rejections.push({
        reasonCode: "ambiguous_start_time",
        reasonSummary:
          "A direct acceptance cannot choose between multiple or ranged start times.",
        raw: input.action,
      });
      return finish({ actionKind: input.action.kind, updates, rejections });
    }
    if (
      input.action.kind === "accept_user_offer" &&
      evidence.some((item) => hasAmbiguousDurationExpression(item.quote))
    ) {
      rejections.push({
        reasonCode: "ambiguous_duration",
        reasonSummary:
          "A direct acceptance cannot choose a duration from a range or alternative.",
        raw: input.action,
      });
      return finish({ actionKind: input.action.kind, updates, rejections });
    }

    const state =
      active?.state ??
      createScheduleNegotiation({
        negotiationId: createEntityId("negotiation"),
        evidence: {
          evidenceId: input.userMessage.id,
          observedAtUtc: input.nowUtc,
        },
      });
    const stored = active?.stored;

    if (input.action.kind === "request_details") {
      const details = partialDetails(
        evidence.length === 0 ? undefined : input.action.offer,
        input.timezone,
        input.nowUtc,
      );
      const reduced = reduceScheduleNegotiation({
        state,
        action: { type: "collect_details", details },
        evidence: {
          current: {
            evidenceId: input.assistantMessageId,
            observedAtUtc: input.nowUtc,
          },
        },
      });
      updates.push(toStoredNegotiation(reduced.state, stored, input));
      return finish({
        actionKind: input.action.kind,
        updates,
        transition: reduced.transition,
        presentationText:
          "【未修改日程】信息还不完整，请补充明确的活动和开始时间。确认前不会修改日程。",
        rejections,
      });
    }

    const acceptedUserOffer =
      input.action.kind === "accept_user_offer"
        ? canonicalizeAcceptedUserOffer(
            evidence,
            input.timezone,
            groundedClockRange,
          )
        : undefined;
    if (acceptedUserOffer?.ok === false) {
      rejections.push({
        reasonCode: acceptedUserOffer.reasonCode,
        reasonSummary: acceptedUserOffer.reasonSummary,
        raw: input.action,
      });
      return finish({ actionKind: input.action.kind, updates, rejections });
    }
    let canonical =
      acceptedUserOffer?.ok === true
        ? acceptedUserOffer.offer
        : canonicalizeOffer(input.action.offer, input.timezone, input.nowUtc);
    if (canonical === undefined) {
      rejections.push({
        reasonCode: "invalid_negotiation_offer",
        reasonSummary:
          "The structured schedule offer could not be converted to canonical terms.",
        raw: input.action,
      });
      return finish({ actionKind: input.action.kind, updates, rejections });
    }
    if (input.action.kind !== "accept_user_offer") {
      const groundedActivity = resolveGroundedActivity(
        canonical.category,
        canonical.activity,
        evidence,
      );
      if (groundedActivity === undefined) {
        rejections.push({
          reasonCode: "activity_not_grounded",
          reasonSummary:
            "The offered activity was not supported by the cited user messages.",
          raw: input.action,
        });
        return finish({ actionKind: input.action.kind, updates, rejections });
      }
      canonical = { ...canonical, activity: groundedActivity };
    }
    if (input.action.kind === "accept_user_offer") {
      if (!evidence.some((item) => item.message.id === input.userMessage.id)) {
        rejections.push({
          reasonCode: "current_turn_not_grounded",
          reasonSummary:
            "A direct acceptance must cite the current user message.",
          raw: input.action,
        });
        return finish({ actionKind: input.action.kind, updates, rejections });
      }
      const groundedDuration = resolveGroundedDuration(
        evidence,
        groundedClockRange?.durationMinutes,
      );
      if (groundedDuration.kind === "ambiguous") {
        rejections.push({
          reasonCode: "ambiguous_duration",
          reasonSummary:
            "A directly accepted offer must have at most one stated duration.",
          raw: input.action,
        });
        return finish({ actionKind: input.action.kind, updates, rejections });
      }
      if (groundedDuration.kind === "unparsed") {
        rejections.push({
          reasonCode: "unparsed_duration",
          reasonSummary:
            "The user stated a duration that the server could not resolve safely.",
          raw: input.action,
        });
        return finish({ actionKind: input.action.kind, updates, rejections });
      }
      canonical = {
        ...canonical,
        durationMinutes:
          groundedDuration.kind === "one"
            ? groundedDuration.value
            : (DEFAULT_DURATION_MINUTES[canonical.category] ?? 60),
      };
    }

    const presented = reduceScheduleNegotiation({
      state,
      action: {
        type: "present_offer",
        offer: canonical,
        validUntilUtc: DateTime.fromISO(input.nowUtc)
          .plus({ minutes: NEGOTIATION_TTL_MINUTES })
          .toUTC()
          .toISO()!,
        supportingEvidenceIds: evidence.map((item) => item.message.id),
      },
      evidence: {
        current: {
          evidenceId: input.assistantMessageId,
          observedAtUtc: input.nowUtc,
        },
      },
    });

    updates.push(toStoredNegotiation(presented.state, stored, input));
    return finish({
      actionKind: input.action.kind,
      updates,
      transition: presented.transition,
      presentationText: formatPendingOffer(
        presented.state.offer!,
        input.timezone,
      ),
      rejections,
    });
  }

  private acceptPending(input: {
    agentId: string;
    sessionId: string;
    timezone: string;
    nowUtc: string;
    userMessage: StoredMessage;
    assistantMessageId: string;
    recentMessages: readonly StoredMessage[];
    action: Extract<
      ScheduleNegotiationAction,
      { kind: "accept_pending_offer" }
    >;
    active: ActiveScheduleNegotiation;
    updates: StoredScheduleNegotiation[];
    rejections: ScheduleNegotiationRejection[];
  }): PreparedScheduleNegotiation {
    const offer = input.active.state.offer;
    if (offer === undefined) {
      input.rejections.push({
        reasonCode: "missing_pending_offer",
        reasonSummary: "The active negotiation has no complete offer.",
        raw: input.action,
      });
      return {
        actionKind: input.action.kind,
        updates: input.updates,
        rejections: input.rejections,
      };
    }
    const effect = offerToEffect(offer);
    const validation = this.schedules.validateEffectsPartial(
      input.agentId,
      [effect],
      input.nowUtc,
    );
    if (validation.accepted.length !== 1) {
      const conflicted = reduceScheduleNegotiation({
        state: input.active.state,
        action: {
          type: "mark_conflicted",
          reasonCode: validation.rejections[0]?.code ?? "schedule_conflict",
        },
        evidence: {
          current: {
            evidenceId: input.userMessage.id,
            observedAtUtc: input.nowUtc,
          },
        },
      });
      input.updates.push(
        toStoredNegotiation(conflicted.state, input.active.stored, input),
      );
      input.rejections.push(
        ...validation.rejections.map((item) => ({
          reasonCode: item.code,
          reasonSummary: item.message,
          raw: item.proposal,
        })),
      );
      return {
        actionKind: input.action.kind,
        updates: input.updates,
        transition: conflicted.transition,
        rejections: input.rejections,
      };
    }
    const accepted = reduceScheduleNegotiation({
      state: input.active.state,
      action: {
        type: "accept_pending",
        offerVersion: input.active.state.offerVersion,
      },
      evidence: {
        current: {
          evidenceId: input.userMessage.id,
          observedAtUtc: input.nowUtc,
        },
      },
    });
    input.updates.push(
      toStoredNegotiation(accepted.state, input.active.stored, input),
    );
    if (!accepted.readyToCommit) {
      input.rejections.push({
        reasonCode: accepted.transition.reason,
        reasonSummary:
          "The pending offer could not be committed from this confirmation.",
        raw: input.action,
      });
    }
    return {
      actionKind: input.action.kind,
      updates: input.updates,
      transition: accepted.transition,
      ...(accepted.readyToCommit ? { effect } : {}),
      ...(accepted.readyToCommit
        ? { presentationText: formatCommittedOffer(offer, input.timezone) }
        : {}),
      rejections: input.rejections,
    };
  }
}

export function buildScheduleNegotiationContract(input: {
  active?: ActiveScheduleNegotiation;
  timezone: string;
  nowUtc: string;
  legacyEffectsEnabled?: boolean;
}): string {
  const activeNegotiation = input.active?.expired
    ? null
    : input.active === undefined
      ? null
      : {
          status: input.active.state.status,
          offerVersion: input.active.state.offerVersion,
          knownDetails: {
            ...input.active.state.details,
            ...(input.active.state.details.startAtUtc === undefined
              ? {}
              : {
                  startLocal: DateTime.fromISO(
                    input.active.state.details.startAtUtc,
                  )
                    .setZone(input.timezone)
                    .toFormat("yyyy-MM-dd HH:mm"),
                }),
          },
          offer:
            input.active.state.offer === undefined
              ? null
              : {
                  activity: input.active.state.offer.activity,
                  category: input.active.state.offer.category,
                  startLocal: DateTime.fromISO(
                    input.active.state.offer.startAtUtc,
                  )
                    .setZone(input.timezone)
                    .toFormat("yyyy-MM-dd HH:mm"),
                  durationMinutes: input.active.state.offer.durationMinutes,
                  validUntilUtc: input.active.state.offer.validUntilUtc,
                },
        };
  return [
    "SCHEDULE_NEGOTIATION_CONTRACT",
    "Return exactly one replyDecision.scheduleAction on every schedule-negotiation turn; never omit it. The natural reply wording never authorizes a schedule change.",
    "Allowed kinds: none, request_details, propose_offer, accept_user_offer, accept_pending_offer, decline_offer, withdraw_offer.",
    "accept_user_offer has this model-side shape: kind plus offer containing activity, category, startAt, optional durationMinutes, and evidenceQuotes. accept_pending_offer has only kind plus evidenceQuotes. Use exact current-user quotes for evidenceQuotes.",
    "Use accept_user_offer only when the character is willing to accept a user-supplied activity and start time. It creates a server-canonical pending offer and never changes the schedule in the same turn. Include the semantic offer and verbatim evidenceQuotes copied from user messages; the server derives the authoritative activity, time, and duration from those quotes.",
    "Use propose_offer when the character introduces or changes any material term. It also creates only a pending offer and never changes the schedule in the same turn.",
    "Only a later, separate user turn may return accept_pending_offer. Use it only when the current user gives an unambiguous affirmative answer to the single active offer without changing any term. Include evidenceQuotes copied exactly from the current user message, but do not restate or modify the offer in this action.",
    "This negotiated writer currently supports creating a new shared activity only. Never turn a request to cancel or reschedule an existing item into a create offer; return none and clearly explain that it is unsupported.",
    "For accept_user_offer, copy relative or local time wording from the evidence instead of inventing an ISO date. Omit durationMinutes when the user did not state a duration.",
    input.legacyEffectsEnabled
      ? "Use request_details when activity or start time is missing. Use none for unrelated conversation. Also return scheduleEffects under the appended legacy contract; the shadow evaluator and legacy writer are validated independently."
      : "Use request_details when activity or start time is missing. Use none only for unrelated conversation. Omit top-level scheduleEffects; the negotiated writer ignores legacy effects.",
    "The natural reply must match scheduleAction: accept_user_offer and propose_offer must ask for confirmation and must not claim the schedule was changed. Never claim an agreement was recorded for none, request_details, decline_offer, or withdraw_offer.",
    `Character timezone: ${input.timezone}`,
    `Character local date/time: ${DateTime.fromISO(input.nowUtc)
      .setZone(input.timezone)
      .toFormat("yyyy-MM-dd HH:mm ZZZZ")}`,
    "ACTIVE_SCHEDULE_NEGOTIATION_JSON",
    JSON.stringify(activeNegotiation),
  ].join("\n");
}

function canonicalizeOffer(
  offer: ScheduleNegotiationOffer,
  timezone: string,
  nowUtc: string,
): CanonicalScheduleOffer | undefined {
  const startAtUtc = parseModelTime(offer.startAt, { timezone, nowUtc });
  if (startAtUtc === undefined) return undefined;
  return {
    operation: "create",
    activity: offer.activity.trim(),
    category: offer.category,
    startAtUtc,
    durationMinutes:
      offer.durationMinutes ?? DEFAULT_DURATION_MINUTES[offer.category] ?? 60,
    timezone,
  };
}

type AcceptedUserOfferResolution =
  | { ok: true; offer: CanonicalScheduleOffer }
  | {
      ok: false;
      reasonCode: "activity_not_grounded" | "time_not_grounded";
      reasonSummary: string;
    };

type GroundedClockRange = {
  startAtUtc: string;
  durationMinutes: number;
};

/**
 * A direct user offer is only an input to the confirmation flow. The model
 * chooses the dialogue act, while the server derives every material term from
 * exact user evidence before showing the pending offer back to the user.
 */
function canonicalizeAcceptedUserOffer(
  evidence: readonly ResolvedEvidence[],
  timezone: string,
  groundedClockRange?: GroundedClockRange,
): AcceptedUserOfferResolution {
  const groundedActivities = uniqueActivityFamilies(
    evidence.flatMap((item) => matchingActivityFamilies(item.quote)),
  );
  if (groundedActivities.length !== 1) {
    return {
      ok: false,
      reasonCode: "activity_not_grounded",
      reasonSummary:
        "The user evidence must identify exactly one supported activity.",
    };
  }
  const startAtUtc =
    groundedClockRange?.startAtUtc ?? resolveGroundedStart(evidence, timezone);
  if (startAtUtc === undefined) {
    return {
      ok: false,
      reasonCode: "time_not_grounded",
      reasonSummary:
        "The user evidence must identify exactly one resolvable start time.",
    };
  }
  const activity = groundedActivities[0]!;
  return {
    ok: true,
    offer: {
      operation: "create",
      activity: groundedActivityLabel(activity, evidence),
      category: activity.category,
      startAtUtc,
      durationMinutes:
        groundedClockRange?.durationMinutes ??
        DEFAULT_DURATION_MINUTES[activity.category] ??
        60,
      timezone,
    },
  };
}

function partialDetails(
  offer: Extract<
    ScheduleNegotiationAction,
    { kind: "request_details" }
  >["offer"],
  timezone: string,
  nowUtc: string,
): PartialScheduleOfferDetails {
  if (offer === undefined) return {};
  const startAtUtc =
    offer.startAt === undefined
      ? undefined
      : parseModelTime(offer.startAt, { timezone, nowUtc });
  return {
    ...(offer.activity === undefined ? {} : { activity: offer.activity }),
    ...(offer.category === undefined ? {} : { category: offer.category }),
    ...(startAtUtc === undefined ? {} : { startAtUtc }),
    ...(offer.durationMinutes === undefined
      ? {}
      : { durationMinutes: offer.durationMinutes }),
    timezone,
  };
}

type ResolvedEvidence = {
  quote: string;
  message: StoredMessage;
};

function resolveOfferEvidence(
  quotes: readonly string[],
  userMessage: StoredMessage,
  recentMessages: readonly StoredMessage[],
): ResolvedEvidence[] {
  const candidates = [
    userMessage,
    ...[...recentMessages]
      .reverse()
      .filter((message) => message.role === "user"),
  ];
  const resolved: ResolvedEvidence[] = [];
  for (const quote of quotes) {
    const message = candidates.find((candidate) =>
      evidenceQuoteIsExact(quote, candidate.content),
    );
    if (message !== undefined) resolved.push({ quote, message });
  }
  return resolved;
}

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
}

function evidenceQuoteIsExact(quote: string, message: string): boolean {
  const normalizedQuote = normalizeEvidenceText(quote);
  return (
    normalizedQuote.length > 0 &&
    normalizeEvidenceText(message).includes(normalizedQuote)
  );
}

const AFFIRMATIVE_CONFIRMATIONS = new Set([
  "好",
  "好的",
  "好呀",
  "好啊",
  "行",
  "行的",
  "可以",
  "当然可以",
  "没问题",
  "确认",
  "确认安排",
  "确定",
  "同意",
  "就按这个",
  "就按这个来",
  "按这个来",
  "就这么办",
  "说定了",
  "ok",
  "okay",
  "yes",
  "sure",
  "confirm",
  "confirmed",
  "agreed",
  "soundsgood",
  "👌",
  "👍",
]);

const UNSUPPORTED_SCHEDULE_OPERATION_PATTERN =
  /(?:取消|删(?:掉|除)?|撤(?:销|掉)?|去掉|作废|不(?:去|参加)(?:了)?|(?:把|将).{0,40}(?:改|换|挪|调|移|推|延|提|删|撤|取消|去掉)|(?:改|换|挪|调|移)(?:到|成|为|期|时间|个时间)|推迟|延后|延到|提前|\b(?:cancel|remove|delete|drop|undo|withdraw|reschedul(?:e|ing)|postpone|shift)\b|\b(?:move|change)\b.{0,40}\b(?:to|into|from)\b|\bpush\s+back\b|\bbring\s+forward\b)/iu;
const QUESTION_MARK_PATTERN = /[?？﹖؟⁇⁈⁉]/u;

function isUnambiguousScheduleConfirmation(text: string): boolean {
  const compatibilityNormalized = text.normalize("NFKC");
  if (QUESTION_MARK_PATTERN.test(compatibilityNormalized)) return false;
  const normalized = normalizeEvidenceText(compatibilityNormalized).replace(
    /^(?:嗯+|好吧)/u,
    "",
  );
  return AFFIRMATIVE_CONFIRMATIONS.has(normalized);
}

const EXPLICIT_SCHEDULE_CANCELLATIONS = new Set([
  "取消",
  "取消这个",
  "算了",
  "不确认",
  "不要了",
  "不用了",
  "放弃",
  "先不定了",
  "改天再说",
  "cancel",
  "no",
  "nevermind",
]);

function isExplicitScheduleCancellation(text: string): boolean {
  const compatibilityNormalized = text.normalize("NFKC");
  if (QUESTION_MARK_PATTERN.test(compatibilityNormalized)) return false;
  return EXPLICIT_SCHEDULE_CANCELLATIONS.has(
    normalizeEvidenceText(compatibilityNormalized),
  );
}

function isQuestionShapedScheduleControl(text: string): boolean {
  const compatibilityNormalized = text.normalize("NFKC");
  if (!QUESTION_MARK_PATTERN.test(compatibilityNormalized)) return false;
  const normalized = normalizeEvidenceText(compatibilityNormalized);
  return (
    AFFIRMATIVE_CONFIRMATIONS.has(normalized) ||
    EXPLICIT_SCHEDULE_CANCELLATIONS.has(normalized)
  );
}

function resolveGroundedActivity(
  category: string,
  offeredActivity: string,
  evidence: readonly ResolvedEvidence[],
): string | undefined {
  const offered = matchingActivityFamilies(offeredActivity);
  if (offered.length !== 1) return undefined;
  const grounded = uniqueActivityFamilies(
    evidence.flatMap((item) => matchingActivityFamilies(item.quote)),
  );
  if (grounded.length !== 1) return undefined;
  const offeredFamily = offered[0]!;
  const groundedFamily = grounded[0]!;
  return category === offeredFamily.category &&
    category === groundedFamily.category &&
    offeredFamily.id === groundedFamily.id
    ? groundedActivityLabel(groundedFamily, evidence)
    : undefined;
}

function matchingActivityFamilies(text: string) {
  return ALL_ACTIVITY_FAMILIES.filter((family) => family.pattern.test(text));
}

function uniqueActivityFamilies(
  families: readonly (ActivityFamily & { category: string })[],
) {
  return [
    ...new Map(
      families.map((family) => [`${family.category}:${family.id}`, family]),
    ).values(),
  ];
}

const QUOTED_VENUE_PATTERN = /[“"「『]([^“”"「」『』\r\n]{1,60})[”"」』]/gu;
const VENUE_SIGNAL_PATTERN =
  /书店|咖啡馆|咖啡店|茶馆|公园|餐厅|饭店|影院|电影院|健身房|图书馆|博物馆|展馆|商场|中心|bookstore|caf[eé]|tea\s*house|park|restaurant|cinema|gym|library|museum|mall/iu;

function groundedActivityLabel(
  family: ActivityFamily,
  evidence: readonly ResolvedEvidence[],
): string {
  let selected:
    | {
        venue: string;
        observedAtMs: number;
      }
    | undefined;
  for (const item of evidence) {
    const observedAtMs = Date.parse(item.message.createdAtUtc);
    for (const match of item.quote.matchAll(QUOTED_VENUE_PATTERN)) {
      const venue = (match[1] ?? "").trim();
      if (!VENUE_SIGNAL_PATTERN.test(venue)) continue;
      if (
        selected === undefined ||
        !Number.isFinite(selected.observedAtMs) ||
        !Number.isFinite(observedAtMs) ||
        observedAtMs >= selected.observedAtMs
      ) {
        selected = { venue, observedAtMs };
      }
    }
  }
  if (selected === undefined) return family.label;
  return (
    family.pattern.test(selected.venue)
      ? selected.venue
      : `${selected.venue}${family.label}`
  ).slice(0, 160);
}
function resolveGroundedStart(
  evidence: readonly ResolvedEvidence[],
  timezone: string,
): string | undefined {
  const candidates = new Set<string>();
  for (const item of evidence) {
    const startAtUtc = parseModelTime(item.quote, {
      timezone,
      nowUtc: item.message.createdAtUtc,
    });
    if (startAtUtc !== undefined) candidates.add(startAtUtc);
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

const START_REFERENCE_PATTERN =
  /\d{4}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?|(?:in\s+\d+(?:\.\d+)?\s+(?:hours?|minutes?)|(?:半|\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]{1,3})\s*(?:个)?\s*(?:小时|分钟)\s*(?:后|以后|之后)|\d+(?:\.\d+)?\s*(?:hours?|minutes?)\s*(?:later|from\s+now))|\d{1,2}(?::\d{2})?\s*(?:am|pm)|(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*\d{1,2}|[点时](?:(?:半|一刻|三刻)|\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*分?)?)/giu;

const NUMERIC_CLOCK_RANGE_PATTERN =
  /(?:(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)\s*)?([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\s*(am|pm)?\s*(?:到|至|[-—–~～]|\bto\b)\s*(?:(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜晚)\s*)?([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)\s*(am|pm)?/giu;

function resolveGroundedClockRange(
  evidence: readonly ResolvedEvidence[],
  timezone: string,
): GroundedClockRange | undefined {
  const candidates = new Map<string, GroundedClockRange>();
  let sawRange = false;
  for (const item of evidence) {
    const matches = [...item.quote.matchAll(NUMERIC_CLOCK_RANGE_PATTERN)];
    if (matches.length === 0) continue;
    if (matches.length !== 1) return undefined;
    sawRange = true;

    const match = matches[0]!;
    const matchStart = match.index ?? 0;
    const residual = `${item.quote.slice(0, matchStart)} ${item.quote.slice(
      matchStart + match[0].length,
    )}`;
    if ([...residual.matchAll(START_REFERENCE_PATTERN)].length > 0) {
      return undefined;
    }

    const startHourRaw = Number(match[2]);
    const startPeriod = `${match[1] ?? ""} ${match[4] ?? ""}`.trim();
    const startExpression = `${item.quote.slice(0, matchStart)} ${
      match[1] ?? ""
    }${match[2]}:${match[3]}${match[4] ?? ""}`;
    const startAtUtc = parseModelTime(startExpression, {
      timezone,
      nowUtc: item.message.createdAtUtc,
    });
    if (startAtUtc === undefined) return undefined;

    const startLocal = DateTime.fromISO(startAtUtc).setZone(timezone);
    if (!startLocal.isValid) return undefined;
    const endHourRaw = Number(match[6]);
    const endMinute = Number(match[7]);
    const endPeriod = `${match[5] ?? ""} ${match[8] ?? ""}`.trim();
    const endHour = resolveRangeEndHour({
      endHourRaw,
      endPeriod,
      startHourRaw,
      startPeriod,
      startLocalHour: startLocal.hour,
    });
    if (endHour === undefined) return undefined;

    let endLocal = startLocal.startOf("day").set({
      hour: endHour,
      minute: endMinute,
    });
    if (endLocal <= startLocal) endLocal = endLocal.plus({ days: 1 });
    const durationMinutes = Math.round(
      endLocal.diff(startLocal, "minutes").minutes,
    );
    if (durationMinutes <= 0 || durationMinutes > 1_440) return undefined;

    const candidate = { startAtUtc, durationMinutes };
    candidates.set(`${startAtUtc}|${durationMinutes}`, candidate);
  }
  return sawRange && candidates.size === 1
    ? [...candidates.values()][0]
    : undefined;
}

function resolveRangeEndHour(input: {
  endHourRaw: number;
  endPeriod: string;
  startHourRaw: number;
  startPeriod: string;
  startLocalHour: number;
}): number | undefined {
  if (input.endHourRaw < 0 || input.endHourRaw > 23) return undefined;
  if (input.endPeriod !== "") {
    return applyClockPeriod(input.endHourRaw, input.endPeriod);
  }
  if (
    input.startPeriod !== "" &&
    input.startLocalHour >= 12 &&
    input.startHourRaw <= input.endHourRaw &&
    input.endHourRaw < 12
  ) {
    return input.endHourRaw + 12;
  }
  return input.endHourRaw;
}

function applyClockPeriod(hour: number, period: string): number | undefined {
  if (hour < 0 || hour > 23) return undefined;
  if (/^(?:am|凌晨|清晨|早上|上午)$/iu.test(period)) {
    return hour === 12 ? 0 : hour;
  }
  if (/^(?:pm|中午|下午|傍晚)$/iu.test(period)) {
    return hour < 12 ? hour + 12 : hour;
  }
  if (/^(?:晚上|夜里|夜晚)$/u.test(period)) {
    if (hour === 12) return 0;
    return hour < 12 ? hour + 12 : hour;
  }
  return undefined;
}

function hasAmbiguousStartExpression(text: string): boolean {
  const references = [...text.matchAll(START_REFERENCE_PATTERN)];
  if (references.length > 1) return true;
  return /(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*\d{1,2}|[点时])?\s*(?:或(?:者)?|还是|到|至|[-~～]|\bor\b|\bto\b)\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*\d{1,2}|[点时]|am\b|pm\b)/iu.test(
    text,
  );
}

function hasAmbiguousDurationExpression(text: string): boolean {
  if (
    /(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]{1,3})\s*(?:个\s*)?(?:半\s*)?(?:到|至|或(?:者)?|还是|[-~～]|\bto\b|\bor\b)\s*(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]{1,3})\s*(?:个\s*)?(?:小时|钟头|分钟|hours?|hrs?|minutes?|mins?)/iu.test(
      text,
    )
  ) {
    return true;
  }
  return /[一二两三四五六七八九]{2}\s*(?:个\s*)?(?:小时|钟头|分钟)/u.test(text);
}

function resolveGroundedDuration(
  evidence: readonly ResolvedEvidence[],
  rangeDurationMinutes?: number,
):
  | { kind: "none" }
  | { kind: "one"; value: number }
  | { kind: "ambiguous" }
  | { kind: "unparsed" } {
  const candidates = new Set<number>(
    rangeDurationMinutes === undefined ? [] : [rangeDurationMinutes],
  );
  let sawUnparsedDuration = false;
  for (const item of evidence) {
    const extraction = extractDurationEvidence(item.quote);
    for (const duration of extraction.values) {
      candidates.add(duration);
    }
    if (containsUnparsedDurationExpression(item.quote, extraction.spans)) {
      sawUnparsedDuration = true;
    }
  }
  if (sawUnparsedDuration) return { kind: "unparsed" };
  if (candidates.size === 0) return { kind: "none" };
  if (candidates.size !== 1) return { kind: "ambiguous" };
  return { kind: "one", value: [...candidates][0]! };
}

function extractDurationEvidence(text: string): {
  values: number[];
  spans: Array<{ start: number; end: number }>;
} {
  const values = new Set<number>();
  const occupied: Array<{ start: number; end: number }> = [];
  const add = (value: number, start: number, end: number): void => {
    if (isRelativeTimeSpan(text, start, end)) {
      occupied.push({ start, end });
      return;
    }
    if (Number.isInteger(value) && value > 0 && value <= 1_440) {
      values.add(value);
      occupied.push({ start, end });
    }
  };

  for (const match of text.matchAll(
    /(\d+(?:\.\d+)?)\s*(?:个\s*)?(半\s*)?(小时|钟头|hours?|hrs?)(?:\s*(半))?/giu,
  )) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const hasHalf = match[2] !== undefined || match[4] !== undefined;
    if (hasHalf && !Number.isInteger(amount)) continue;
    add(
      Math.round((amount + (hasHalf ? 0.5 : 0)) * 60),
      match.index,
      match.index + match[0].length,
    );
  }

  for (const match of text.matchAll(
    /([零〇一二两三四五六七八九十]{1,3})\s*(?:个\s*)?(半\s*)?(小时|钟头)(?:\s*(半))?/gu,
  )) {
    const amount = parseChineseNumber(match[1]!);
    if (amount === undefined || amount <= 0) continue;
    const hasHalf = match[2] !== undefined || match[4] !== undefined;
    add(
      Math.round((amount + (hasHalf ? 0.5 : 0)) * 60),
      match.index,
      match.index + match[0].length,
    );
  }

  for (const match of text.matchAll(/半\s*(?:个\s*)?(?:小时|钟头)/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!occupied.some((range) => rangesOverlap(range, { start, end }))) {
      add(30, start, end);
    }
  }

  for (const match of text.matchAll(
    /(\d+(?:\.\d+)?)\s*(分钟|minutes?|mins?)/giu,
  )) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    add(Math.round(amount), match.index, match.index + match[0].length);
  }

  for (const match of text.matchAll(
    /([零〇一二两三四五六七八九十]{1,3})\s*分钟/gu,
  )) {
    const amount = parseChineseNumber(match[1]!);
    if (amount === undefined || amount <= 0) continue;
    add(amount, match.index, match.index + match[0].length);
  }

  for (const match of text.matchAll(/\bhalf\s+(?:an?\s+)?hour\b/giu)) {
    add(30, match.index, match.index + match[0].length);
  }

  const englishNumbers: Record<string, number> = {
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };
  for (const match of text.matchAll(
    /\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(\s+and\s+a\s+half)?\s+(hours?|hrs?|minutes?|mins?)\b/giu,
  )) {
    const range = { start: match.index, end: match.index + match[0].length };
    if (occupied.some((item) => rangesOverlap(item, range))) continue;
    const amount = englishNumbers[match[1]!.toLocaleLowerCase()];
    if (amount === undefined) continue;
    const withHalf = match[2] !== undefined ? amount + 0.5 : amount;
    const unit = match[3]!.toLocaleLowerCase();
    add(
      Math.round(/hour|hr/u.test(unit) ? withHalf * 60 : withHalf),
      range.start,
      range.end,
    );
  }

  for (const match of text.matchAll(/([一二两三四])\s*刻钟/gu)) {
    const amount = parseChineseNumber(match[1]!);
    if (amount === undefined) continue;
    add(amount * 15, match.index, match.index + match[0].length);
  }

  return { values: [...values], spans: occupied };
}

function containsUnparsedDurationExpression(
  text: string,
  spans: readonly { start: number; end: number }[],
): boolean {
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  const remaining: string[] = [];
  let cursor = 0;
  for (const span of ordered) {
    if (span.start > cursor) remaining.push(text.slice(cursor, span.start));
    cursor = Math.max(cursor, span.end);
  }
  remaining.push(text.slice(cursor));
  return /小时|钟头|分钟|刻钟|\bhours?\b|\bhrs?\b|\bminutes?\b|\bmins?\b/iu.test(
    remaining.join(" "),
  );
}

function isRelativeTimeSpan(text: string, start: number, end: number): boolean {
  return (
    /(?:^|\s)in\s*$/iu.test(text.slice(0, start)) ||
    /^\s*(?:后|以后|之后|later\b|from\s+now\b)/iu.test(text.slice(end))
  );
}

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && right.start < left.end;
}

function parseChineseNumber(value: string): number | undefined {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (value === "十") return 10;
  const ten = value.indexOf("十");
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : digits[value[ten - 1] ?? ""];
    const ones = ten === value.length - 1 ? 0 : digits[value[ten + 1] ?? ""];
    return tens === undefined || ones === undefined
      ? undefined
      : tens * 10 + ones;
  }
  if (value.length === 1) return digits[value];
  const parsed = [...value].map((digit) => digits[digit]);
  return parsed.some((digit) => digit === undefined)
    ? undefined
    : Number(parsed.join(""));
}

function offerToEffect(offer: CanonicalScheduleOffer): ScheduleEffectProposal {
  const activity = offer.activity.replace(/^(?:一起|和用户|与用户)\s*/u, "");
  return ScheduleEffectProposalSchema.parse({
    operation: "create",
    item: {
      title: `和用户${activity}`.slice(0, 160),
      description: `通过对话确认的共同安排：${activity}`.slice(0, 1_000),
      category: offer.category,
      startAtUtc: offer.startAtUtc,
      endAtUtc: DateTime.fromISO(offer.startAtUtc)
        .plus({ minutes: offer.durationMinutes })
        .toUTC()
        .toISO()!,
      timezone: offer.timezone,
      rigidity: "committed",
      priority: 0.8,
      source: "user_invitation",
      adherenceProbability: 0.9,
      narrativeImportance: 0.65,
      shareable: true,
      stateEffects: {},
    },
    reasonCode: "negotiated_schedule_create",
    reasonSummary: "角色接受了有对话证据支持的日程约定。",
  });
}

function formatPendingOffer(
  offer: CanonicalScheduleOffer,
  timezone: string,
): string {
  const local = DateTime.fromISO(offer.startAtUtc).setZone(timezone);
  const startLocal = local.toFormat("yyyy-MM-dd HH:mm");
  return `【待确认日程】${startLocal}，${offer.activity}，${offer.durationMinutes} 分钟（${timezone}，UTC${local.toFormat("ZZ")}）。日程尚未修改；请明确回复“确认”应用该方案，或回复“取消”放弃。`;
}

function formatCommittedOffer(
  offer: CanonicalScheduleOffer,
  timezone: string,
): string {
  const local = DateTime.fromISO(offer.startAtUtc).setZone(timezone);
  const startLocal = local.toFormat("yyyy-MM-dd HH:mm");
  return `【日程已修改】${startLocal}，${offer.activity}，${offer.durationMinutes} 分钟（${timezone}，UTC${local.toFormat("ZZ")}）。`;
}

function negotiationStateFromStored(
  stored: StoredScheduleNegotiation,
): ScheduleNegotiation | undefined {
  const value = stored.record["negotiation"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<ScheduleNegotiation>;
  if (
    candidate.id !== stored.id ||
    candidate.status !== stored.status ||
    candidate.offerVersion !== stored.offerVersion ||
    !Array.isArray(candidate.evidenceIds) ||
    typeof candidate.createdAtUtc !== "string" ||
    typeof candidate.updatedAtUtc !== "string" ||
    typeof candidate.details !== "object" ||
    candidate.details === null
  ) {
    return undefined;
  }
  return candidate as ScheduleNegotiation;
}

function toStoredNegotiation(
  state: ScheduleNegotiation,
  existing: StoredScheduleNegotiation | undefined,
  input: { agentId: string; sessionId: string },
): StoredScheduleNegotiation {
  const existingPolicyVersion = existing?.record["policyVersion"];
  const policyVersion =
    existing !== undefined &&
    existing.offerVersion === state.offerVersion &&
    typeof existingPolicyVersion === "number" &&
    Number.isInteger(existingPolicyVersion)
      ? existingPolicyVersion
      : SCHEDULE_NEGOTIATION_POLICY_VERSION;
  return {
    id: state.id,
    agentId: input.agentId,
    sessionId: input.sessionId,
    status: state.status,
    offerVersion: state.offerVersion,
    record: {
      negotiation: state,
      policyVersion,
    },
    createdAtUtc: existing?.createdAtUtc ?? state.createdAtUtc,
    updatedAtUtc: state.updatedAtUtc,
  };
}

function activeIdentity(
  stored: StoredScheduleNegotiation,
): Pick<StoredScheduleNegotiation, "id" | "status" | "offerVersion"> {
  return {
    id: stored.id,
    status: stored.status,
    offerVersion: stored.offerVersion,
  };
}
