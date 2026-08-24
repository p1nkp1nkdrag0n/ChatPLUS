import type { ScheduleIntentProposal, TurnRoute } from "@personasim/contracts";

import {
  resolveScheduleDialogueFrame,
  type ScheduleDialogueFrame,
} from "./schedule-dialogue-frame.js";

export type ScheduleCapability = "none" | "read_only" | "read_write";
export type TurnScheduleAccess = "none" | "read" | "mutation_candidate";
export type ActiveNegotiationControl = "confirm" | "decline" | "none";

export type TurnRouteReasonCode =
  | "active_negotiation_exact_confirmation"
  | "active_negotiation_exact_decline"
  | "high_precision_schedule_control"
  | "high_precision_schedule_offer"
  | "high_precision_schedule_query"
  | "high_precision_schedule_request_details"
  | "high_precision_unsupported_schedule_mutation"
  | "explicit_schedule_query"
  | "explicit_schedule_mutation_candidate"
  | "explicit_memory_request"
  | "explicit_continuity_request"
  | "mixed_intents"
  | "non_authorizing_schedule_frame"
  | "ordinary_conversation"
  | "schedule_read_unavailable"
  | "schedule_mutation_unavailable";

export interface RouteTurnInput {
  userText: string;
  /** Only presence is relevant. Expired negotiations are treated as absent. */
  activeNegotiation?: unknown;
  scheduleCapability?: ScheduleCapability;
}

export interface TurnRouteDecision {
  route: TurnRoute;
  needsModelUnderstanding: boolean;
  scheduleAccess: TurnScheduleAccess;
  deterministicScheduleIntent: ScheduleIntentProposal;
  reasonCodes: TurnRouteReasonCode[];
  scheduleFrame?: ScheduleDialogueFrame;
}

const QUESTION_MARK_PATTERN = /[?？﹖؟⁇⁈⁉]/u;
const QUOTE_MARK_PATTERN = /["'“”‘’「」『』]/u;

const EXACT_CONFIRMATIONS = new Set([
  "确认",
  "确定",
  "就这样",
  "可以确认",
  "同意这个安排",
  "confirm",
]);

const EXACT_DECLINES = new Set([
  "拒绝",
  "不同意",
  "不确认",
  "取消这个安排",
  "算了",
  "不要了",
  "先不定了",
  "改天再说",
  "decline",
  "reject",
  "cancel",
  "no",
  "nevermind",
]);

const SCHEDULE_CUE_PATTERN =
  /(?:日程|行程|安排|约会|会议|活动|有空|忙不忙|忙吗|明天|今晚|后天|下周|答应|确认|取消|改期|散步|见面|一起|\b(?:calendar|schedule|appointment|meeting|available|tomorrow|tonight|confirm|cancel|reschedule)\b)/iu;

const NON_AUTHORIZING_FRAME_PATTERN =
  /(?:他说|她说|他们说|小[一-鿿]{1,3}说|有人说|同事说|朋友说|室友说|老师说|对方说|听说|转述|引用|(?:别人|他人).{0,16}(?:说|发.{0,6}消息)|如果|假如|要是|万一|还没决定|尚未决定|还不确定|再看看|先别安排|不要安排|没有答应|没答应|只是想想|(?:明明|硬说|假装).{0,40}(?:答应过|约好|已经.{0,12}(?:记进|写进|加进))|(?:忽略|无视|别管|不要管).{0,28}(?:日程|行程|记录|保存).{0,48}(?:说|声称|告诉我)|(?:直接|就).{0,8}(?:说|声称|告诉我).{0,32}(?:我们|你).{0,20}(?:已经|早就).{0,16}(?:约好|答应|安排好|记进|写进|加进)|[A-Z][A-Z'.-]{1,30}\s+said\b|\b(?:he|she|they|someone else)\s+(?:said|messaged)\b|\b(?:quote|quoted|if|maybe|hypothetically)\b|\bnot\s+(?:sure|decided)\b|\b(?:ignore|disregard)\b.{0,40}\b(?:calendar|schedule|records?)\b|\b(?:pretend|act as if)\b.{0,80}\b(?:agreed|scheduled|on (?:the )?calendar)\b|[“"「『][^”"」』]{0,160}(?:日程|安排|今天|明天|后天|一起|见面|吃饭|\b(?:calendar|schedule|today|tomorrow|together|meet)\b)[^”"」』]{0,160}[”"」』])/iu;

/** Normalization used only for whole-message control tokens. */
export function normalizeScheduleControlText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
}

function canBeWholeMessageControl(text: string): boolean {
  const normalized = text.normalize("NFKC");
  return (
    normalized.trim().length > 0 &&
    !QUESTION_MARK_PATTERN.test(normalized) &&
    !QUOTE_MARK_PATTERN.test(normalized)
  );
}

/** Exact confirmation is deliberately narrower than conversational agreement. */
export function isExactScheduleConfirmation(text: string): boolean {
  return (
    canBeWholeMessageControl(text) &&
    EXACT_CONFIRMATIONS.has(normalizeScheduleControlText(text))
  );
}

/** Exact decline/cancellation only applies to the currently pending offer. */
export function isExactScheduleDecline(text: string): boolean {
  return (
    canBeWholeMessageControl(text) &&
    EXACT_DECLINES.has(normalizeScheduleControlText(text))
  );
}

export function classifyActiveNegotiationControl(
  text: string,
): ActiveNegotiationControl {
  if (isExactScheduleConfirmation(text)) return "confirm";
  if (isExactScheduleDecline(text)) return "decline";
  return "none";
}

export function isExplicitScheduleReadRequest(text: string): boolean {
  const normalized = text.normalize("NFKC");
  return (
    /(?:看看|查看|查(?:一下)?|告诉我|列出|显示).{0,16}(?:日程|行程|安排|约会|会议)/iu.test(
      normalized,
    ) ||
    /(?:日程|行程|安排|约会|会议).{0,18}(?:是什么|有什么|有哪些|有啥|怎么|怎样|何时|什么时候|吗|没|没有|\?|？)/iu.test(
      normalized,
    ) ||
    /(?:我|你|我们).{0,10}(?:什么时候有空|何时有空|有空吗|忙不忙|忙吗)/u.test(
      normalized,
    ) ||
    /(?:是不是|是否|有没有).{0,12}(?:已经)?(?:答应|约好|定好|安排好)/u.test(
      normalized,
    ) ||
    /\b(?:show|check|list|what(?:'s| is)|when|are (?:you|we))\b.{0,40}\b(?:calendar|schedule|appointments?|meetings?|available|free)\b/iu.test(
      normalized,
    )
  );
}

export function isNonAuthorizingScheduleFrame(text: string): boolean {
  const normalized = text.normalize("NFKC");
  if (!SCHEDULE_CUE_PATTERN.test(normalized)) return false;
  if (affirmativeProposalPrecedesConditional(normalized)) return false;
  return NON_AUTHORIZING_FRAME_PATTERN.test(normalized);
}

function affirmativeProposalPrecedesConditional(text: string): boolean {
  const proposal =
    /我(?:想|想要|希望|打算|要).{0,100}(?:和|跟|与)你一起/iu.exec(text);
  if (proposal === null) return false;
  const thirdParty = /(?:他说|她说|他们说|有人说|听说|转述|引用|据说)/u.exec(
    text,
  );
  if (thirdParty !== null && thirdParty.index < proposal.index) return false;
  const uncertain =
    /(?:也许|可能|或许|还没决定|尚未决定|再看看|先别安排)/u.exec(text);
  if (uncertain !== null && uncertain.index <= proposal.index) return false;
  const conditional = /(?:如果|假如|要是|万一|\bif\b)/iu.exec(text);
  return conditional === null || proposal.index < conditional.index;
}

/**
 * Finds only direct read/write candidates. It never returns a command and
 * explicitly excludes quoted, hypothetical, and undecided statements.
 */
export function isExplicitScheduleMutationCandidate(text: string): boolean {
  const normalized = text.normalize("NFKC");
  if (isNonAuthorizingScheduleFrame(normalized)) return false;

  return (
    /(?:一起|和我|跟我).{0,24}(?:去|来|吃|喝|看|逛|散步|见面|参加|玩|聊|聚)/u.test(
      normalized,
    ) ||
    /(?:帮我|请|给我|给我们)?.{0,6}(?:安排|预约|预订|定下|约在|加入|加到).{0,24}(?:日程|行程|安排|时间|今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天])/u.test(
      normalized,
    ) ||
    /(?:取消|删除|删掉|撤销|改期|改到|挪到|推迟|延后).{0,24}(?:日程|行程|安排|约会|会议|活动)/u.test(
      normalized,
    ) ||
    /(?:日程|行程|安排|约会|会议|活动).{0,24}(?:取消|删除|删掉|撤销|改期|改到|挪到|推迟|延后)/u.test(
      normalized,
    ) ||
    /\b(?:let(?:'s| us)|join me|meet me)\b/iu.test(normalized) ||
    /\b(?:schedule|book|add)\b.{0,40}\b(?:calendar|appointment|meeting|time)\b/iu.test(
      normalized,
    ) ||
    /\b(?:cancel|delete|remove|reschedule|postpone|move)\b.{0,40}\b(?:appointment|meeting|schedule|event)\b/iu.test(
      normalized,
    )
  );
}

export function isExplicitMemoryRequest(text: string): boolean {
  return /(?:请|帮我)?(?:记住|记得|别忘|记下来|存一下)|\b(?:remember|keep in mind|make a note|note that)\b/iu.test(
    text.normalize("NFKC"),
  );
}

export function isExplicitContinuityRequest(text: string): boolean {
  return /(?:以后|之后|到时候|下次).{0,16}(?:问我|再问|提醒|跟进|关心)|(?:提醒我|到时叫我)|\b(?:follow up|check (?:in|back)|remind me)\b/iu.test(
    text.normalize("NFKC"),
  );
}

export function isExplicitMemoryOrContinuityRequest(
  text: string,
): "explicit_memory" | "continuity" | undefined {
  if (isExplicitMemoryRequest(text)) return "explicit_memory";
  if (isExplicitContinuityRequest(text)) return "continuity";
  return undefined;
}

function hasActiveNegotiation(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (
    typeof value === "object" &&
    "expired" in value &&
    (value as { expired?: unknown }).expired === true
  ) {
    return false;
  }
  return true;
}

function scheduleAccessFor(
  kind: "read" | "mutation",
  capability: ScheduleCapability,
): TurnScheduleAccess {
  if (kind === "read") {
    return capability === "none" ? "none" : "read";
  }
  return capability === "read_write" ? "mutation_candidate" : "none";
}

function unavailableReason(
  kind: "read" | "mutation",
  capability: ScheduleCapability,
): TurnRouteReasonCode[] {
  if (kind === "read" && capability === "none") {
    return ["schedule_read_unavailable"];
  }
  if (kind === "mutation" && capability !== "read_write") {
    return ["schedule_mutation_unavailable"];
  }
  return [];
}

export function routeTurn(input: RouteTurnInput): TurnRouteDecision {
  const userText = input.userText.trim();
  const capability = input.scheduleCapability ?? "read_write";
  const scheduleFrame = resolveScheduleDialogueFrame({
    userText,
    hasActiveNegotiation: hasActiveNegotiation(input.activeNegotiation),
  });
  const frameDecision = routeFromScheduleFrame(scheduleFrame, capability);
  if (frameDecision !== undefined) return frameDecision;
  if (
    scheduleFrame.kind === "none" &&
    scheduleFrame.reasonCode === "non_authorizing_schedule_frame"
  ) {
    return {
      route: "conversation",
      needsModelUnderstanding: true,
      scheduleAccess: "none",
      deterministicScheduleIntent: { kind: "none" },
      reasonCodes: ["non_authorizing_schedule_frame"],
    };
  }
  const activeControl = hasActiveNegotiation(input.activeNegotiation)
    ? classifyActiveNegotiationControl(userText)
    : "none";

  if (activeControl !== "none") {
    const isConfirmation = activeControl === "confirm";
    return {
      route: "schedule_mutation",
      needsModelUnderstanding: false,
      scheduleAccess: scheduleAccessFor("mutation", capability),
      deterministicScheduleIntent: {
        kind: isConfirmation
          ? "confirm_pending_offer"
          : "decline_pending_offer",
        evidenceQuotes: [{ text: userText }],
      },
      reasonCodes: [
        isConfirmation
          ? "active_negotiation_exact_confirmation"
          : "active_negotiation_exact_decline",
        ...unavailableReason("mutation", capability),
      ],
    };
  }

  const scheduleRead = isExplicitScheduleReadRequest(userText);
  const scheduleMutation = isExplicitScheduleMutationCandidate(userText);
  const memoryOrContinuity = isExplicitMemoryOrContinuityRequest(userText);
  const nonAuthorizingScheduleFrame = isNonAuthorizingScheduleFrame(userText);

  if (
    (scheduleRead && scheduleMutation) ||
    ((scheduleRead || scheduleMutation) && memoryOrContinuity !== undefined)
  ) {
    const accessKind = scheduleMutation ? "mutation" : "read";
    return {
      route: "mixed",
      needsModelUnderstanding: true,
      scheduleAccess: scheduleAccessFor(accessKind, capability),
      deterministicScheduleIntent: { kind: "none" },
      reasonCodes: [
        "mixed_intents",
        ...unavailableReason(accessKind, capability),
      ],
    };
  }

  if (scheduleRead) {
    return {
      route: "schedule_query",
      needsModelUnderstanding: true,
      scheduleAccess: scheduleAccessFor("read", capability),
      deterministicScheduleIntent: {
        kind: "query_schedule",
        evidenceQuotes: [{ text: userText.slice(0, 500) }],
      },
      reasonCodes: [
        "explicit_schedule_query",
        ...unavailableReason("read", capability),
      ],
    };
  }

  if (scheduleMutation) {
    return {
      route: "schedule_mutation",
      needsModelUnderstanding: true,
      scheduleAccess: scheduleAccessFor("mutation", capability),
      deterministicScheduleIntent: { kind: "none" },
      reasonCodes: [
        "explicit_schedule_mutation_candidate",
        ...unavailableReason("mutation", capability),
      ],
    };
  }

  if (memoryOrContinuity !== undefined) {
    return {
      route: memoryOrContinuity,
      needsModelUnderstanding: true,
      scheduleAccess: "none",
      deterministicScheduleIntent: { kind: "none" },
      reasonCodes: [
        memoryOrContinuity === "explicit_memory"
          ? "explicit_memory_request"
          : "explicit_continuity_request",
      ],
    };
  }

  if (nonAuthorizingScheduleFrame) {
    return {
      route: "conversation",
      needsModelUnderstanding: true,
      scheduleAccess: "none",
      deterministicScheduleIntent: { kind: "none" },
      reasonCodes: ["non_authorizing_schedule_frame"],
    };
  }

  return {
    route: "conversation",
    needsModelUnderstanding: true,
    scheduleAccess: "none",
    deterministicScheduleIntent: { kind: "none" },
    reasonCodes: ["ordinary_conversation"],
  };
}

function routeFromScheduleFrame(
  frame: ScheduleDialogueFrame,
  capability: ScheduleCapability,
): TurnRouteDecision | undefined {
  const scheduleFrame = frame;
  switch (frame.kind) {
    case "none":
      return undefined;
    case "query_existing":
      return {
        route: "schedule_query",
        needsModelUnderstanding: false,
        scheduleAccess: scheduleAccessFor("read", capability),
        deterministicScheduleIntent: {
          kind: "query_schedule",
          evidenceQuotes: frame.evidenceSpans.map((span) => ({
            text: span.text,
          })),
        },
        reasonCodes: [
          "high_precision_schedule_query",
          ...unavailableReason("read", capability),
        ],
        scheduleFrame,
      };
    case "confirm_active":
      return scheduleControlDecision(
        "confirm_pending_offer",
        frame,
        capability,
      );
    case "withdraw_active":
      return scheduleControlDecision(
        "decline_pending_offer",
        frame,
        capability,
      );
    case "new_shared_offer":
      return {
        route: "schedule_mutation",
        needsModelUnderstanding: false,
        scheduleAccess: scheduleAccessFor("mutation", capability),
        deterministicScheduleIntent:
          capability === "read_write"
            ? {
                kind: "create_shared_activity",
                activityQuote: { text: frame.activityText },
                timeQuote: { text: frame.timeText },
                ...(frame.durationMinutes === undefined
                  ? {}
                  : { durationMinutes: frame.durationMinutes }),
                missingFields: [],
              }
            : { kind: "none" },
        reasonCodes: [
          "high_precision_schedule_offer",
          ...unavailableReason("mutation", capability),
        ],
        scheduleFrame,
      };
    case "request_details":
      return {
        route: "schedule_mutation",
        needsModelUnderstanding: false,
        scheduleAccess: scheduleAccessFor("mutation", capability),
        deterministicScheduleIntent:
          capability === "read_write"
            ? {
                kind: "create_shared_activity",
                activityQuote: { text: frame.activityText },
                missingFields: ["time"],
              }
            : { kind: "none" },
        reasonCodes: [
          "high_precision_schedule_request_details",
          ...unavailableReason("mutation", capability),
        ],
        scheduleFrame,
      };
    case "unsupported_mutation":
      return {
        route: "schedule_mutation",
        needsModelUnderstanding: false,
        scheduleAccess: scheduleAccessFor("mutation", capability),
        deterministicScheduleIntent:
          capability === "read_write"
            ? {
                kind: "unsupported_mutation",
                operation:
                  frame.operation === "update" ? "other" : frame.operation,
                evidenceQuotes: frame.evidenceSpans.map((span) => ({
                  text: span.text,
                })),
              }
            : { kind: "none" },
        reasonCodes: [
          "high_precision_unsupported_schedule_mutation",
          ...unavailableReason("mutation", capability),
        ],
        scheduleFrame,
      };
  }
}

function scheduleControlDecision(
  kind: "confirm_pending_offer" | "decline_pending_offer",
  frame: Extract<
    ScheduleDialogueFrame,
    { kind: "confirm_active" | "withdraw_active" }
  >,
  capability: ScheduleCapability,
): TurnRouteDecision {
  return {
    route: "schedule_mutation",
    needsModelUnderstanding: false,
    scheduleAccess: scheduleAccessFor("mutation", capability),
    deterministicScheduleIntent:
      capability === "read_write"
        ? {
            kind,
            evidenceQuotes: frame.evidenceSpans.map((span) => ({
              text: span.text,
            })),
          }
        : { kind: "none" },
    reasonCodes: [
      "high_precision_schedule_control",
      ...unavailableReason("mutation", capability),
    ],
    scheduleFrame: frame,
  };
}
