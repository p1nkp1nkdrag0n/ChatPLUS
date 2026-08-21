import {
  applyRelationshipDelta,
  hasScheduleIntent,
  normalizePersonalIntentCandidate,
  type ModelEffectRejection,
  type ReplyStrategy,
} from "@personasim/features";

import type { DatabaseStore, StoredMessage } from "../db/store.js";
import type { SimulationCapabilities } from "../domain/capabilities.js";
import type {
  AgentTurnDecision,
  CharacterSpec,
  RuntimeState,
} from "../domain/schemas.js";
import type { ReplyRepairService } from "./reply-repair-service.js";
import type {
  PartialProposalValidation,
  ScheduleService,
} from "./schedule-service.js";
import {
  ScheduleNegotiationService,
  type PreparedScheduleNegotiation,
  type ScheduleNegotiationRejection,
} from "./schedule-negotiation-service.js";
import {
  sentenceUnits,
  type ResolvedTurn,
  type TurnDecisionEffectContext,
  type TurnDecisionService,
} from "./turn-decision-service.js";

export type ChatTurnDecisionPath =
  "full" | "partial" | "effects_rejected" | "reply_only" | "fallback";

export interface WorldEffectServiceOptions {
  chatEffectsMode?: "off" | "gated";
  scheduleNegotiationMode?: "legacy" | "shadow" | "enforced";
}

export interface TurnProposalRejection {
  reasonCode: string;
  reasonSummary: string;
  raw: unknown;
}

export interface PreparedWorldEffectTurn {
  decision: AgentTurnDecision;
  validation: PartialProposalValidation;
  negotiationPlan?: PreparedScheduleNegotiation;
  proposalRejections: TurnProposalRejection[];
  decisionPath: ChatTurnDecisionPath;
  nextState: RuntimeState;
  stateChanged: boolean;
  repairAttempted: boolean;
  usedFallback: boolean;
}

/** Prepares validated world effects and next state without durable writes. */
export class WorldEffectService {
  private readonly scheduleNegotiations: ScheduleNegotiationService;

  constructor(
    store: DatabaseStore,
    schedules: ScheduleService,
    private readonly decisions: TurnDecisionService,
    private readonly repairs: ReplyRepairService,
    private readonly options: WorldEffectServiceOptions = {},
  ) {
    this.scheduleNegotiations = new ScheduleNegotiationService(
      store,
      schedules,
    );
  }

  prepareDecisionContext(input: {
    sessionId: string;
    nowUtc: string;
    userText: string;
    spec: CharacterSpec;
    capabilities: SimulationCapabilities;
    providerName: string;
  }): TurnDecisionEffectContext {
    const scheduleNegotiationEligible =
      this.options.scheduleNegotiationMode !== undefined &&
      this.options.scheduleNegotiationMode !== "legacy" &&
      this.options.chatEffectsMode !== "off" &&
      input.capabilities.schedule &&
      input.spec.tier === "high_fidelity" &&
      input.spec.schedulePolicy.enabled &&
      input.providerName !== "fixture";
    const negotiationEnforced =
      this.options.scheduleNegotiationMode === "enforced" &&
      this.options.chatEffectsMode !== "off" &&
      input.capabilities.schedule &&
      input.spec.tier === "high_fidelity" &&
      input.spec.schedulePolicy.enabled;
    const activeNegotiation = scheduleNegotiationEligible
      ? this.scheduleNegotiations.getActive(input.sessionId, input.nowUtc)
      : undefined;
    const effectsEligible =
      !negotiationEnforced &&
      this.options.chatEffectsMode !== "off" &&
      input.capabilities.schedule &&
      input.spec.tier === "high_fidelity" &&
      input.spec.schedulePolicy.enabled &&
      hasScheduleIntent(input.userText);
    return {
      effectsEligible,
      scheduleNegotiationEligible,
      negotiationEnforced,
      ...(activeNegotiation === undefined ? {} : { activeNegotiation }),
    };
  }

  async resolve(input: {
    sessionId: string;
    agentId: string;
    userText: string;
    userMessageId: string;
    clientMessageId: string;
    assistantMessageId: string;
    nowUtc: string;
    spec: CharacterSpec;
    state: RuntimeState;
    capabilities: SimulationCapabilities;
    recentMessages: StoredMessage[];
    replyStrategy: ReplyStrategy;
    effects: TurnDecisionEffectContext;
    turn: ResolvedTurn;
  }): Promise<PreparedWorldEffectTurn> {
    let { decision, inspection, repairAttempted } = input.turn;
    let usedFallback = input.turn.usedFallback;
    let negotiationPlan: PreparedScheduleNegotiation | undefined;
    if (input.effects.scheduleNegotiationEligible) {
      const provisionalUserMessage: StoredMessage = {
        id: input.userMessageId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        role: "user",
        content: input.userText,
        messageKind: "user",
        clientMessageId: input.clientMessageId,
        metadata: {},
        createdAtUtc: input.nowUtc,
      };
      const scheduleAction = materializeAcceptedScheduleAction({
        action: input.turn.scheduleAction,
        userText: input.userText,
        assistantText: decision.reply.text,
        hasActiveNegotiation: input.effects.activeNegotiation !== undefined,
      });
      negotiationPlan = this.scheduleNegotiations.prepare({
        agentId: input.agentId,
        sessionId: input.sessionId,
        timezone: input.spec.identity.timezone,
        nowUtc: input.nowUtc,
        userMessage: provisionalUserMessage,
        assistantMessageId: input.assistantMessageId,
        recentMessages: input.recentMessages,
        action: scheduleAction,
      });
      if (this.options.scheduleNegotiationMode === "enforced") {
        const negotiationRejection = negotiationPlan.rejections[0];
        const committedWorldEffects =
          input.turn.worldEffectsAudit?.mode === "enforced"
            ? input.turn.worldEffectsAudit.validation.effects
            : undefined;
        const controlledReply = scheduleNegotiationOutcomeDecision(
          input.spec,
          negotiationPlan,
          this.decisions,
        );
        if (controlledReply !== undefined) {
          decision = this.decisions.attachValidatedWorldEffects(
            controlledReply,
            committedWorldEffects,
          );
          repairAttempted ||= negotiationRejection !== undefined;
          usedFallback = false;
        }
        if (
          negotiationPlan.effect === undefined &&
          negotiationPlan.actionKind !== "none"
        ) {
          decision = {
            ...decision,
            memoryCandidates: decision.memoryCandidates.filter(
              (candidate) => candidate.kind !== "commitment",
            ),
          };
        }
        const negotiationReason = scheduleNegotiationDecisionReason(
          negotiationPlan,
          decision,
        );
        decision = {
          ...decision,
          scheduleEffects:
            negotiationPlan.effect === undefined
              ? []
              : [negotiationPlan.effect],
          reasonCode: negotiationReason.reasonCode,
          reasonSummary: negotiationReason.reasonSummary,
        };
        inspection = this.decisions.inspect({
          agentId: input.agentId,
          spec: input.spec,
          decision,
          nowUtc: input.nowUtc,
          capabilities: input.capabilities,
        });
        appendNegotiationReplyIssues(
          inspection,
          decision.reply.text,
          negotiationPlan.effect !== undefined,
        );
        if (inspection.issues.length > 0 && controlledReply === undefined) {
          repairAttempted = true;
          const repaired = await this.repairs.repairPersonaReply({
            spec: input.spec,
            userText: input.userText,
            invalidResponse: {
              text: decision.reply.text,
              toneTags: decision.reply.toneTags,
            },
            issues: inspection.issues,
            replyStrategy: input.replyStrategy,
          });
          const repairedBase = repaired
            ? this.decisions.materializeReply(
                repaired,
                input.spec,
                input.replyStrategy,
              )
            : safeNegotiatedDecision(
                input.spec,
                negotiationPlan.effect !== undefined,
                this.decisions,
              );
          if (repaired === undefined) usedFallback = true;
          decision = this.decisions.attachValidatedWorldEffects(
            {
              ...repairedBase,
              scheduleEffects:
                negotiationPlan.effect === undefined
                  ? []
                  : [negotiationPlan.effect],
              reasonCode:
                negotiationPlan.effect === undefined
                  ? repairedBase.reasonCode
                  : "schedule_negotiation_committed",
              reasonSummary:
                negotiationPlan.effect === undefined
                  ? repairedBase.reasonSummary
                  : "\u7ed3\u6784\u5316\u7ea6\u5b9a\u5df2\u901a\u8fc7\u670d\u52a1\u7aef\u6821\u9a8c\u5e76\u5f62\u6210\u65e5\u7a0b\u547d\u4ee4\u3002",
            },
            committedWorldEffects,
          );
          inspection = this.decisions.inspect({
            agentId: input.agentId,
            spec: input.spec,
            decision,
            nowUtc: input.nowUtc,
            capabilities: input.capabilities,
          });
          appendNegotiationReplyIssues(
            inspection,
            decision.reply.text,
            negotiationPlan.effect !== undefined,
          );
          if (inspection.issues.length > 0) {
            usedFallback = true;
            const fallback = safeNegotiatedDecision(
              input.spec,
              negotiationPlan.effect !== undefined,
              this.decisions,
            );
            decision = this.decisions.attachValidatedWorldEffects(
              {
                ...fallback,
                scheduleEffects:
                  negotiationPlan.effect === undefined
                    ? []
                    : [negotiationPlan.effect],
                reasonCode:
                  negotiationPlan.effect === undefined
                    ? fallback.reasonCode
                    : "schedule_negotiation_committed",
                reasonSummary:
                  negotiationPlan.effect === undefined
                    ? fallback.reasonSummary
                    : "\u7ed3\u6784\u5316\u7ea6\u5b9a\u5df2\u901a\u8fc7\u670d\u52a1\u7aef\u6821\u9a8c\u5e76\u5f62\u6210\u65e5\u7a0b\u547d\u4ee4\u3002",
              },
              committedWorldEffects,
            );
            inspection = this.decisions.inspect({
              agentId: input.agentId,
              spec: input.spec,
              decision,
              nowUtc: input.nowUtc,
              capabilities: input.capabilities,
            });
          }
        }
        if (negotiationPlan.presentationText !== undefined) {
          decision = appendNegotiationPresentation(
            decision,
            negotiationPlan.presentationText,
          );
        }
      }
    }

    const validation = inspection.validation;
    const personalIntentRejections: ModelEffectRejection[] = [];
    const groundedPersonalIntentCandidates: NonNullable<
      AgentTurnDecision["personalIntentCandidates"]
    > = [];
    for (const candidate of decision.personalIntentCandidates ?? []) {
      const normalized = normalizePersonalIntentCandidate({
        candidate,
        agentId: input.agentId,
        spec: input.spec,
        currentUserMessage: {
          id: input.userMessageId,
          text: input.userText,
        },
        nowUtc: input.nowUtc,
        timezone: input.spec.identity.timezone,
      });
      if (normalized.accepted) {
        groundedPersonalIntentCandidates.push(candidate);
      } else {
        personalIntentRejections.push({
          raw: candidate,
          reasonCode: normalized.rejection.reasonCode,
          reasonSummary: normalized.rejection.reasonSummary,
        });
      }
    }
    decision = {
      ...decision,
      personalIntentCandidates: groundedPersonalIntentCandidates,
    };

    const proposalRejections: TurnProposalRejection[] = [
      ...input.turn.modelRejections.map((rejection) => ({
        reasonCode: rejection.reasonCode,
        reasonSummary: rejection.reasonSummary,
        raw: rejection.raw,
      })),
      ...personalIntentRejections,
      ...validation.rejections.map((rejection) => ({
        reasonCode: rejection.code,
        reasonSummary: rejection.message,
        raw: rejection.proposal,
      })),
      ...(this.options.scheduleNegotiationMode === "enforced"
        ? (negotiationPlan?.rejections ?? [])
        : []),
    ];
    const proposedCount = decision.scheduleEffects.length;
    const acceptedCount = validation.accepted.length;
    const decisionPath: ChatTurnDecisionPath = usedFallback
      ? "fallback"
      : proposedCount === 0 && proposalRejections.length === 0
        ? "reply_only"
        : acceptedCount === proposedCount && proposalRejections.length === 0
          ? "full"
          : acceptedCount > 0
            ? "partial"
            : "effects_rejected";
    const nextState = applyTurnState(
      input.state,
      decision.stateDelta,
      decision.relationshipDelta,
      input.nowUtc,
      input.capabilities,
    );
    return {
      decision,
      validation,
      ...(negotiationPlan === undefined ? {} : { negotiationPlan }),
      proposalRejections,
      decisionPath,
      nextState,
      stateChanged: nextState.revision !== input.state.revision,
      repairAttempted,
      usedFallback,
    };
  }
}
function materializeAcceptedScheduleAction(input: {
  action: ResolvedTurn["scheduleAction"];
  userText: string;
  assistantText: string;
  hasActiveNegotiation: boolean;
}): ResolvedTurn["scheduleAction"] {
  if (input.action.kind !== "none" || input.hasActiveNegotiation) {
    return input.action;
  }

  const unsupportedMutation =
    /取消|删除|改期|推迟|提前|改到|挪到|cancel|delete|reschedule|move\s+(?:it|this)/iu.test(
      input.userText,
    );
  const explicitSharedInvite =
    /一起|约(?:我|你|个)?|见面|陪我|来参加|我们.{0,40}(?:定|去|参加|散步|见)|你.{0,8}(?:能|会|愿意).{0,4}(?:来|去|参加)|together|meet|join\s+me|with\s+me/iu.test(
      input.userText,
    );
  const groundedTiming =
    /今天|今日|今晚|明天|明日|明早|后天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*[:：点]\s*\d{0,2}|today|tonight|tomorrow|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/iu.test(
      input.userText,
    );
  const assistantRefused =
    /不能|不行|没法|做不到|抱歉|无法|去不了|来不了|can(?:not|'t)|won't|sorry/iu.test(
      input.assistantText,
    );
  const assistantAccepted =
    /(?:^|[，。！？!\s])(?:好(?:的|啊|呀)?|行|没问题|可以|愿意|确认)(?=[，。！？!\s]|$)|我(?:会|可以|愿意|来)(?=[，。！？!\s]|$)|到时候见|sure|yes|i(?:'ll|\s+will)|can\s+do/iu.test(
      input.assistantText,
    );
  const assistantGroundsOffer =
    /今天|今晚|明天|明早|后天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*[:：点]\s*\d{0,2}|today|tonight|tomorrow|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/iu.test(
      input.assistantText,
    ) &&
    /一起|散步|跑步|晚会|见面|吃饭|喝咖啡|看电影|逛|活动|together|walk|run|party|meet|dinner|coffee|movie/iu.test(
      input.assistantText,
    );

  if (
    unsupportedMutation ||
    !hasScheduleIntent(input.userText) ||
    !explicitSharedInvite ||
    !groundedTiming ||
    assistantRefused ||
    !assistantAccepted ||
    !assistantGroundsOffer
  ) {
    return input.action;
  }

  const evidence = input.userText.replace(/\s+/gu, " ").trim().slice(0, 500);
  return {
    kind: "accept_user_offer",
    offer: {
      activity: evidence.slice(0, 160),
      category: "other",
      startAt: evidence.slice(0, 120),
      evidenceQuotes: [evidence],
    },
  };
}

function safeNegotiatedDecision(
  spec: CharacterSpec,
  committed: boolean,
  decisions: TurnDecisionService,
): AgentTurnDecision {
  if (!committed) return decisions.safePersonaDecision(spec);
  const text =
    spec.dialogue.warmth >= 0.6
      ? "\u597d\uff0c\u8fd9\u4e2a\u7ea6\u5b9a\u5df2\u7ecf\u786e\u8ba4\u4e86\u3002"
      : "\u53ef\u4ee5\uff0c\u8fd9\u4e2a\u7ea6\u5b9a\u5df2\u7ecf\u786e\u8ba4\u3002";
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6
          ? ["\u81ea\u7136", "\u786e\u8ba4"]
          : ["\u81ea\u7136", "\u514b\u5236"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "schedule_negotiation_reply_fallback",
    reasonSummary:
      "\u4f7f\u7528\u4e0e\u670d\u52a1\u7aef\u63d0\u4ea4\u7ed3\u679c\u4e00\u81f4\u7684\u5b89\u5168\u56de\u590d\u3002",
  };
}

function scheduleNegotiationOutcomeDecision(
  spec: CharacterSpec,
  plan: PreparedScheduleNegotiation,
  decisions: TurnDecisionService,
): AgentTurnDecision | undefined {
  const rejection = plan.rejections[0];
  if (rejection !== undefined) {
    return rejectedScheduleNegotiationDecision(spec, rejection);
  }
  if (plan.effect !== undefined) {
    return safeNegotiatedDecision(spec, true, decisions);
  }
  let text: string | undefined;
  switch (plan.actionKind) {
    case "accept_user_offer":
      text =
        "\u6211\u613f\u610f\u5148\u6309\u4e0b\u9762\u7684\u65b9\u6848\u548c\u4f60\u786e\u8ba4\u3002\u4f60\u786e\u8ba4\u540e\uff0c\u6211\u518d\u4fee\u6539\u65e5\u7a0b\u3002";
      break;
    case "propose_offer":
      text =
        "\u6211\u6574\u7406\u4e86\u4e00\u4efd\u5f85\u786e\u8ba4\u65b9\u6848\u3002\u4f60\u786e\u8ba4\u540e\uff0c\u6211\u518d\u4fee\u6539\u65e5\u7a0b\u3002";
      break;
    case "request_details":
      text =
        "\u76ee\u524d\u8fd8\u7f3a\u5c11\u660e\u786e\u7684\u6d3b\u52a8\u6216\u5f00\u59cb\u65f6\u95f4\uff0c\u6240\u4ee5\u6211\u6ca1\u6709\u4fee\u6539\u65e5\u7a0b\u3002";
      break;
    case "decline_offer":
      text =
        "\u8fd9\u6b21\u6211\u6ca1\u6709\u63a5\u53d7\u8be5\u65e5\u7a0b\u63d0\u8bae\uff0c\u56e0\u6b64\u65e5\u7a0b\u6ca1\u6709\u53d8\u5316\u3002";
      break;
    case "withdraw_offer":
      text =
        "\u597d\u7684\uff0c\u5f85\u786e\u8ba4\u65b9\u6848\u5df2\u7ecf\u53d6\u6d88\uff0c\u65e5\u7a0b\u6ca1\u6709\u53d8\u5316\u3002";
      break;
    case "accept_pending_offer":
      text =
        "\u8fd9\u6b21\u786e\u8ba4\u6ca1\u6709\u5f62\u6210\u53ef\u63d0\u4ea4\u7684\u65e5\u7a0b\u4fee\u6539\uff0c\u65e5\u7a0b\u4fdd\u6301\u4e0d\u53d8\u3002";
      break;
    case "none":
      if (plan.presentationText === undefined) return undefined;
      text =
        "\u5f85\u786e\u8ba4\u65b9\u6848\u4ecd\u672a\u5e94\u7528\u3002\u8bf7\u53ea\u56de\u590d\u201c\u786e\u8ba4\u201d\u6216\u201c\u53d6\u6d88\u201d\u3002";
      break;
  }
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6
          ? ["\u81ea\u7136", "\u8bf4\u660e"]
          : ["\u81ea\u7136", "\u514b\u5236"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: `schedule_negotiation_${plan.actionKind}`,
    reasonSummary:
      "\u56de\u590d\u7531\u670d\u52a1\u7aef\u534f\u5546\u7ed3\u679c\u751f\u6210\uff0c\u4e0d\u4f7f\u7528\u81ea\u7136\u6587\u6848\u6388\u6743\u65e5\u7a0b\u4fee\u6539\u3002",
  };
}

function scheduleNegotiationDecisionReason(
  plan: PreparedScheduleNegotiation,
  decision: AgentTurnDecision,
): { reasonCode: string; reasonSummary: string } {
  const rejection = plan.rejections[0];
  if (rejection !== undefined) {
    return {
      reasonCode: rejection.reasonCode,
      reasonSummary: rejection.reasonSummary,
    };
  }
  if (plan.effect !== undefined) {
    return {
      reasonCode: "schedule_negotiation_committed",
      reasonSummary:
        "\u7528\u6237\u660e\u786e\u786e\u8ba4\u540e\uff0c\u670d\u52a1\u7aef\u5df2\u63d0\u4ea4\u89c4\u8303\u5316\u65e5\u7a0b\u547d\u4ee4\u3002",
    };
  }
  switch (plan.actionKind) {
    case "accept_user_offer":
    case "propose_offer":
      return {
        reasonCode: "schedule_negotiation_awaiting_confirmation",
        reasonSummary:
          "\u670d\u52a1\u7aef\u5df2\u751f\u6210\u5f85\u786e\u8ba4\u65b9\u6848\uff0c\u5c1a\u672a\u4fee\u6539\u65e5\u7a0b\u3002",
      };
    case "request_details":
      return {
        reasonCode: "schedule_negotiation_needs_details",
        reasonSummary:
          "\u6d3b\u52a8\u6216\u5f00\u59cb\u65f6\u95f4\u4e0d\u5b8c\u6574\uff0c\u5c1a\u672a\u751f\u6210\u53ef\u786e\u8ba4\u65b9\u6848\u3002",
      };
    case "decline_offer":
      return {
        reasonCode: "schedule_negotiation_declined",
        reasonSummary:
          "\u89d2\u8272\u62d2\u7edd\u4e86\u672c\u6b21\u65e5\u7a0b\u63d0\u8bae\u3002",
      };
    case "withdraw_offer":
      return {
        reasonCode: "schedule_negotiation_withdrawn",
        reasonSummary:
          "\u7528\u6237\u53d6\u6d88\u4e86\u5f85\u786e\u8ba4\u65b9\u6848\u3002",
      };
    case "accept_pending_offer":
      return {
        reasonCode: "schedule_negotiation_not_committed",
        reasonSummary:
          "\u672c\u6b21\u786e\u8ba4\u672a\u5f62\u6210\u53ef\u63d0\u4ea4\u547d\u4ee4\uff0c\u65e5\u7a0b\u4fdd\u6301\u4e0d\u53d8\u3002",
      };
    case "none":
      if (plan.presentationText !== undefined) {
        return {
          reasonCode: "schedule_negotiation_awaiting_confirmation",
          reasonSummary:
            "\u5f85\u786e\u8ba4\u65b9\u6848\u4ecd\u7136\u6709\u6548\uff0c\u5c1a\u672a\u4fee\u6539\u65e5\u7a0b\u3002",
        };
      }
      return {
        reasonCode: decision.reasonCode,
        reasonSummary: decision.reasonSummary,
      };
  }
}

function rejectedScheduleNegotiationDecision(
  spec: CharacterSpec,
  rejection: ScheduleNegotiationRejection,
): AgentTurnDecision {
  const reason = scheduleNegotiationRejectionText(rejection.reasonCode);
  const text = `\u3010\u672a\u4fee\u6539\u65e5\u7a0b\u3011${reason}`;
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6
          ? ["\u81ea\u7136", "\u8bf4\u660e"]
          : ["\u81ea\u7136", "\u514b\u5236"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: rejection.reasonCode,
    reasonSummary: rejection.reasonSummary,
  };
}

function scheduleNegotiationRejectionText(reasonCode: string): string {
  switch (reasonCode) {
    case "missing_pending_offer":
      return "\u5f53\u524d\u6ca1\u6709\u53ef\u786e\u8ba4\u7684\u65e5\u7a0b\u65b9\u6848\u3002\u8bf7\u5148\u8bf4\u660e\u6d3b\u52a8\u548c\u65f6\u95f4\uff0c\u6211\u4f1a\u5148\u751f\u6210\u5f85\u786e\u8ba4\u65b9\u6848\u3002";
    case "expired_pending_offer":
    case "offer_expired":
      return "\u5f85\u786e\u8ba4\u65b9\u6848\u5df2\u7ecf\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u8bf4\u660e\u6d3b\u52a8\u548c\u65f6\u95f4\u3002";
    case "confirmation_not_affirmative":
    case "ungrounded_pending_confirmation":
    case "confirmation_not_subsequent":
      return "\u6ca1\u6709\u8bc6\u522b\u5230\u660e\u786e\u4e14\u4e0d\u6539\u53d8\u6761\u6b3e\u7684\u80af\u5b9a\u7b54\u590d\u3002\u8bf7\u53ea\u56de\u590d\u201c\u786e\u8ba4\u201d\uff0c\u6216\u56de\u590d\u201c\u53d6\u6d88\u201d\u3002";
    case "stale_offer_version":
      return "\u5f85\u786e\u8ba4\u65b9\u6848\u5df2\u7ecf\u66f4\u65b0\uff0c\u8bf7\u91cd\u65b0\u67e5\u770b\u6700\u65b0\u65b9\u6848\u540e\u518d\u786e\u8ba4\u3002";
    case "ambiguous_pending_offer":
      return "\u5f53\u524d\u5b58\u5728\u591a\u4e2a\u53ef\u80fd\u7684\u5f85\u786e\u8ba4\u65b9\u6848\uff0c\u65e0\u6cd5\u5b89\u5168\u786e\u5b9a\u8981\u4fee\u6539\u54ea\u4e00\u9879\u3002";
    case "ambiguous_start_time":
    case "time_not_grounded":
      return "\u5f00\u59cb\u65f6\u95f4\u4e0d\u552f\u4e00\u6216\u65e0\u6cd5\u5b89\u5168\u89e3\u6790\uff0c\u8bf7\u660e\u786e\u4e00\u4e2a\u5177\u4f53\u65e5\u671f\u548c\u65f6\u95f4\u3002";
    case "ambiguous_duration":
      return "\u65f6\u957f\u5b58\u5728\u591a\u4e2a\u53ef\u80fd\u503c\uff0c\u8bf7\u660e\u786e\u4e00\u4e2a\u65f6\u957f\u3002";
    case "unparsed_duration":
      return "\u65e0\u6cd5\u5b89\u5168\u89e3\u6790\u4f60\u7ed9\u51fa\u7684\u65f6\u957f\uff0c\u8bf7\u6362\u4e00\u79cd\u660e\u786e\u8bf4\u6cd5\u3002";
    case "activity_not_grounded":
      return "\u6ca1\u6709\u8bc6\u522b\u51fa\u552f\u4e00\u7684\u6d3b\u52a8\u5185\u5bb9\uff0c\u8bf7\u660e\u786e\u8981\u5b89\u6392\u4ec0\u4e48\u6d3b\u52a8\u3002";
    case "current_turn_not_grounded":
    case "ungrounded_negotiation_offer":
      return "\u65b9\u6848\u7f3a\u5c11\u5f53\u524d\u5bf9\u8bdd\u4e2d\u7684\u660e\u786e\u4f9d\u636e\uff0c\u8bf7\u91cd\u65b0\u8bf4\u660e\u6d3b\u52a8\u548c\u65f6\u95f4\u3002";
    case "invalid_negotiation_offer":
      return "\u65b9\u6848\u4fe1\u606f\u4e0d\u5b8c\u6574\u6216\u683c\u5f0f\u65e0\u6548\uff0c\u8bf7\u91cd\u65b0\u8bf4\u660e\u6d3b\u52a8\u548c\u65f6\u95f4\u3002";
    case "unsupported_schedule_operation":
      return "\u5f53\u524d\u5b89\u5168\u786e\u8ba4\u6d41\u7a0b\u53ea\u652f\u6301\u65b0\u589e\u5171\u540c\u5b89\u6392\uff0c\u6682\u4e0d\u652f\u6301\u53d6\u6d88\u6216\u6539\u671f\u5df2\u6709\u65e5\u7a0b\u3002";
    default:
      return `\u65b9\u6848\u672a\u901a\u8fc7\u65e5\u7a0b\u6821\u9a8c\uff08${reasonCode}\uff09\uff0c\u56e0\u6b64\u6ca1\u6709\u4fee\u6539\u65e5\u7a0b\u3002`;
  }
}

function appendNegotiationPresentation(
  decision: AgentTurnDecision,
  presentationText: string,
): AgentTurnDecision {
  const text = `${decision.reply.text.trim()}\n${presentationText}`.trim();
  return {
    ...decision,
    reply: {
      ...decision.reply,
      text,
      chunks: [text],
    },
  };
}

function replyClaimsRecordedAgreement(text: string): boolean {
  return sentenceUnits(text).some((clause) => {
    if (
      /[?\uff1f]|\u600e\u4e48\u6837|\u53ef\u4ee5\u5417|\u597d\u5417|\u884c\u5417|\u8981\u4e0d\u8981/u.test(
        clause,
      )
    ) {
      return false;
    }
    return /(?:\u6211.{0,4}(?:\u8bb0\u4e0b|\u8bb0\u4f4f)(?:\u4e86|\u5566)|\u8bf4\u597d(?:\u4e86)?|\u8bf4\u5b9a(?:\u4e86)?|\u7ea6\u5b9a(?:\u597d|\u4e86)|\u5df2\u7ecf\u786e\u8ba4|\u6211.{0,4}(?:\u4f1a|\u4e00\u5b9a\u4f1a)?\u51c6\u65f6\u5230|(?:\u660e\u5929|\u660e\u65e9|\u4eca\u665a|\u540e\u5929).{0,16}(?:\u89c1|\u7b49\u4f60))/iu.test(
      clause,
    );
  });
}

function replyRejectsCommittedAgreement(text: string): boolean {
  return /(?:(?:\u6211|\u8fd9\u6b21|\u660e\u5929|\u660e\u65e9).{0,6}(?:\u4e0d\u80fd|\u6ca1\u6cd5|\u4e0d).{0,4}(?:\u53bb|\u6765|\u53c2\u52a0|\u89c1|\u8dd1)|\u53bb\u4e0d\u4e86|\u7b97\u4e86|\u6539\u5929\u518d\u8bf4|\u6211\u62d2\u7edd|i (?:can't|cannot|won't) (?:go|come|make it)|no[,\uff0c ]+i (?:can't|won't))/iu.test(
    text,
  );
}

function appendNegotiationReplyIssues(
  inspection: { issues: unknown[] },
  text: string,
  committed: boolean,
): void {
  if (!committed && replyClaimsRecordedAgreement(text)) {
    inspection.issues.push({
      code: "uncommitted_schedule_agreement",
      message: "Reply claims an agreement without a committed command.",
    });
  }
  if (committed && replyRejectsCommittedAgreement(text)) {
    inspection.issues.push({
      code: "negotiation_reply_contradiction",
      message: "Reply rejects an agreement represented by a committed command.",
    });
  }
}

function applyTurnState(
  state: RuntimeState,
  delta: AgentTurnDecision["stateDelta"],
  relationshipDelta: AgentTurnDecision["relationshipDelta"],
  nowUtc: string,
  capabilities: SimulationCapabilities,
): RuntimeState {
  const next = structuredClone(state);
  if (delta === undefined && relationshipDelta === undefined) return next;
  if (!capabilities.dynamicState && !capabilities.relationshipDynamics) {
    return next;
  }
  if (capabilities.dynamicState) {
    if (delta?.moodValence !== undefined) {
      next.moodValence = clampSigned(next.moodValence + delta.moodValence);
    }
    if (delta?.moodArousal !== undefined) {
      next.moodArousal = clamp01(next.moodArousal + delta.moodArousal);
    }
    if (delta?.energy !== undefined) {
      next.energy = clamp01(next.energy + delta.energy);
    }
    if (delta?.stress !== undefined) {
      next.stress = clamp01(next.stress + delta.stress);
    }
    if (delta?.socialBattery !== undefined) {
      next.socialBattery = clamp01(next.socialBattery + delta.socialBattery);
    }
    if (delta?.focus !== undefined) {
      next.focus = clamp01(next.focus + delta.focus);
    }
  }
  if (capabilities.relationshipDynamics) {
    const scale = capabilities.relationshipDeltaScale;
    next.relationship = applyRelationshipDelta(
      {
        userId: next.relationship.userId,
        closeness: next.relationship.closeness,
        trust: next.relationship.trust,
        familiarity: next.relationship.familiarity,
        recentInteractionValence: next.relationship.recentInteractionValence,
        ...(next.relationship.lastInteractionAtUtc
          ? { lastInteractionAtUtc: next.relationship.lastInteractionAtUtc }
          : {}),
      },
      {
        ...(relationshipDelta?.closeness === undefined
          ? {}
          : { closeness: relationshipDelta.closeness * scale }),
        ...(relationshipDelta?.trust === undefined
          ? {}
          : { trust: relationshipDelta.trust * scale }),
        familiarity: (relationshipDelta?.familiarity ?? 0.006) * scale,
        ...(relationshipDelta?.recentInteractionValence === undefined
          ? {}
          : {
              recentInteractionValence:
                relationshipDelta.recentInteractionValence * scale,
            }),
      },
      nowUtc,
    ).state;
  }
  next.asOfUtc = nowUtc;
  next.revision += 1;
  return next;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
