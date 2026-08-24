export interface ScheduleEvidenceSpan {
  text: string;
  start: number;
  end: number;
}

export type ScheduleDialogueFrame =
  | {
      kind: "new_shared_offer";
      activityText: string;
      timeText: string;
      locationText?: string;
      durationMinutes?: number;
      proposalPolarity: "affirmative";
      commitAuthorization: "pending_only" | "unspecified";
      evidenceSpans: ScheduleEvidenceSpan[];
    }
  | {
      kind: "request_details";
      activityText: string;
      missingFields: Array<"time">;
      evidenceSpans: ScheduleEvidenceSpan[];
    }
  | {
      kind: "query_existing";
      entityText?: string;
      statusScope: "pending" | "committed" | "any";
      targetScope: "shared" | "all";
      evidenceSpans: ScheduleEvidenceSpan[];
    }
  | {
      kind: "confirm_active";
      evidenceSpans: ScheduleEvidenceSpan[];
    }
  | {
      kind: "withdraw_active";
      evidenceSpans: ScheduleEvidenceSpan[];
    }
  | {
      kind: "unsupported_mutation";
      operation: "reschedule" | "delete" | "update";
      evidenceSpans: ScheduleEvidenceSpan[];
    }
  | {
      kind: "none";
      reasonCode: string;
    };

export interface ResolveScheduleDialogueFrameInput {
  userText: string;
  hasActiveNegotiation?: boolean;
}

const EXACT_CONFIRMATION_PATTERN =
  /^(?:确认|确认安排|确定|同意这个安排|confirm)[。.!！]?$/iu;
const EXPLICIT_WITHDRAW_PATTERN =
  /^(?:取消|取消这个(?:安排)?|取消刚才(?:这个|的)?.{0,24}(?:方案|安排|邀约)|放弃(?:这个|刚才的)?.{0,24}(?:方案|安排|邀约)|算了|不要了|先不定了|改天再说|cancel)[。.!！]?$/iu;

const THIRD_PARTY_OR_QUOTED_FRAME_PATTERN =
  /(?:他说|她说|他们说|小[一-鿿]{1,3}说|有人说|同事说|朋友说|室友说|老师说|对方说|听说|转述|引用|据说|(?:别人|他人).{0,16}(?:说|发.{0,6}消息)|[A-Z][A-Z'.-]{1,30}\s+said\b|\b(?:he|she|they|someone else)\s+(?:said|messaged)\b|\b(?:quote|quoted)\b|[“"「『][^”"」』]{0,160}(?:日程|安排|今天|明天|后天|一起|见面|吃饭|\b(?:calendar|schedule|today|tomorrow|together|meet)\b)[^”"」』]{0,160}[”"」』])/iu;
const UNCERTAIN_PROPOSAL_PATTERN =
  /(?:也许|可能|或许|还没决定|尚未决定|还不确定|再看看|先别安排|不要安排|没有答应|没答应|\b(?:maybe|perhaps|not\s+(?:sure|decided))\b)/iu;
const CONDITIONAL_PATTERN = /(?:如果|假如|要是|万一|\bif\b)/iu;
const SCHEDULE_CONTEXT_PATTERN =
  /(?:日程|行程|安排|约好|约会|会议|活动|答应|确认|取消|改期|改到|推迟|提前|冲突|撞期|今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|周末|一起|见面|散步|走走|吃饭|\b(?:calendar|schedule|appointment|meeting|tomorrow|weekend|reschedule|conflict)\b)/iu;
const FORGED_HISTORY_OVERRIDE_PATTERN =
  /(?:(?:明明|硬说|假装).{0,40}(?:答应过|约好|已经.{0,12}(?:记进|写进|加进))|(?:忽略|无视|别管|不要管).{0,28}(?:日程|行程|记录|保存).{0,48}(?:直接|就)?.{0,8}(?:说|声称|告诉我)|(?:直接|就).{0,8}(?:说|声称|告诉我).{0,32}(?:我们|你).{0,20}(?:已经|早就).{0,16}(?:约好|答应|安排好|记进|写进|加进)|\b(?:ignore|disregard)\b.{0,40}\b(?:calendar|schedule|records?)\b.{0,60}\b(?:say|claim|tell me)\b|\b(?:pretend|act as if)\b.{0,80}\b(?:agreed|scheduled|on (?:the )?calendar)\b)/iu;

const DIRECT_SHARED_PROPOSAL_PATTERN =
  /(?:我(?:想|想要|希望|打算|要).{0,100}(?:和|跟|与)你一起|(?:和|跟|与)我一起|我们.{0,24}一起|(?:哪天|什么时候).{0,24}一起|邀请你.{0,80}(?:一起|见面))/iu;
const SHARED_ACTIVITY_PATTERN =
  /(?:一起.{0,24}(?:去|来|吃|喝|看|逛|散步|走走|见面|参加|玩|聊|跑)|(?:喝茶|喝咖啡|散步|走走|跑步|见面|吃饭|看电影))/iu;
const CONTINUATION_PATTERN =
  /(?:那就|就|好，?那就).{0,20}(?:定在|约在|安排在).{0,100}(?:公园|书店|咖啡馆|咖啡店|茶馆|餐厅|饭店|影院|健身房|图书馆|博物馆|见面|喝茶|散步|走|跑)/iu;

const SPECIFIC_TIME_PATTERN =
  /(?:\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*(?:上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*[:：]\s*\d{2}|\d{4}-\d{1,2}-\d{1,2}(?:[T\s]\d{1,2}:\d{2})?|(?:今天|明天|后天|大后天|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天]).{0,16}(?:上午|中午|下午|傍晚|晚上|早上|清晨)?\s*(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*\d{2}|点(?:半|\d{1,2}分?)?))/iu;
const DURATION_PATTERN = /(\d{1,4})\s*分钟/iu;
const LOCATION_PATTERN =
  /[“"「『]?([\p{Script=Han}A-Za-z0-9·_-]{0,20}(?:书店|公园|咖啡馆|咖啡店|茶馆|餐厅|饭店|影院|电影院|健身房|图书馆|博物馆|展馆|商场))[”"」』]?/iu;

const PENDING_READ_PATTERN =
  /(?:(?:是不是|是否|有没有).{0,40}(?:写进|写入|加入).{0,12}日程|(?:待确认|待定).{0,24}(?:安排|方案|邀约)|(?:安排|方案|邀约).{0,24}(?:待确认|待定|尚未写入|还没写入))/iu;
const COMMITTED_READ_PATTERN =
  /(?:(?:刚|已经|已|真正|当前).{0,20}(?:确认|生效).{0,24}(?:安排|日程|方案)|(?:刚确认|真正生效|已确认|共同安排).{0,24}(?:是什么|有哪些|还在吗)|(?:北岸书店|公园).{0,24}(?:真正生效|共同安排|安排是什么))/iu;
const WITHDRAWN_READ_PATTERN =
  /(?:刚才|之前).{0,16}(?:取消|撤回|放弃).{0,24}(?:安排|方案|邀约).{0,12}(?:还在|是什么|吗)/iu;
const HYPOTHETICAL_CONFLICT_READ_PATTERN =
  /(?:(?:只是|我只是)?(?:问问|查询).{0,20})?(?:如果|假如|要是).{0,64}(?:改到|改晚|推迟|延后|提前|挪到).{0,40}(?:会不会|是否|有没有|有无).{0,16}(?:冲突|撞期|重叠)/iu;

const RESCHEDULE_PATTERN =
  /(?:(?:把|将).{0,60}(?:改到|改期|挪到|推迟|延后|提前)|\b(?:reschedule|postpone|move)\b)/iu;
const DELETE_PATTERN =
  /(?:(?:把|将).{0,60}(?:删掉|删除|取消|撤销)|\b(?:delete|remove|cancel)\b)/iu;

/**
 * Resolves only schedule frames whose authority is provable from the current
 * user text and server-owned active-negotiation presence. It does not parse a
 * canonical time and never commits a schedule item.
 */
export function resolveScheduleDialogueFrame(
  input: ResolveScheduleDialogueFrameInput,
): ScheduleDialogueFrame {
  const span = wholeMessageSpan(input.userText);
  if (span === undefined) {
    return { kind: "none", reasonCode: "empty_message" };
  }
  const text = span.text.normalize("NFKC");

  if (EXACT_CONFIRMATION_PATTERN.test(text)) {
    return input.hasActiveNegotiation === true
      ? { kind: "confirm_active", evidenceSpans: [span] }
      : { kind: "none", reasonCode: "confirmation_without_active_offer" };
  }
  if (EXPLICIT_WITHDRAW_PATTERN.test(text)) {
    return {
      kind: "withdraw_active",
      evidenceSpans: [span],
    };
  }

  const hypotheticalConflictQuery = resolveHypotheticalConflictQuery(
    text,
    span,
  );
  if (hypotheticalConflictQuery !== undefined) {
    return hypotheticalConflictQuery;
  }

  const directMatch = DIRECT_SHARED_PROPOSAL_PATTERN.exec(text);
  const query = resolveQueryFrame(text, span);
  if (query !== undefined && directQueryPrecedesConditionalAside(text)) {
    return query;
  }
  if (isNonAuthorizingFrame(text, directMatch?.index)) {
    return { kind: "none", reasonCode: "non_authorizing_schedule_frame" };
  }

  if (query !== undefined) return query;

  if (RESCHEDULE_PATTERN.test(text)) {
    return {
      kind: "unsupported_mutation",
      operation: "reschedule",
      evidenceSpans: [span],
    };
  }
  if (DELETE_PATTERN.test(text)) {
    return {
      kind: "unsupported_mutation",
      operation: "delete",
      evidenceSpans: [span],
    };
  }

  const continuation =
    input.hasActiveNegotiation === true && CONTINUATION_PATTERN.test(text);
  const affirmativeProposal =
    (directMatch !== null && SHARED_ACTIVITY_PATTERN.test(text)) ||
    continuation;
  if (!affirmativeProposal) {
    return { kind: "none", reasonCode: "no_high_precision_schedule_frame" };
  }

  const timeSpan = matchSpan(input.userText, SPECIFIC_TIME_PATTERN);
  const locationSpan = matchSpan(input.userText, LOCATION_PATTERN, 1);
  const duration = DURATION_PATTERN.exec(text);
  const durationMinutes = duration === null ? undefined : Number(duration[1]);
  if (timeSpan === undefined) {
    return {
      kind: "request_details",
      activityText: span.text,
      missingFields: ["time"],
      evidenceSpans: [span],
    };
  }

  return {
    kind: "new_shared_offer",
    activityText: span.text,
    timeText: timeSpan.text,
    ...(locationSpan === undefined
      ? {}
      : { locationText: cleanEntityText(locationSpan.text) }),
    ...(durationMinutes === undefined ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0 ||
    durationMinutes > 1_440
      ? {}
      : { durationMinutes }),
    proposalPolarity: "affirmative",
    commitAuthorization:
      /(?:待.{0,4}确认|先等我确认|不要.{0,12}(?:写入|写进|加入).{0,8}日程)/u.test(
        text,
      )
        ? "pending_only"
        : "unspecified",
    evidenceSpans: uniqueSpans([span, timeSpan]),
  };
}

function resolveHypotheticalConflictQuery(
  text: string,
  span: ScheduleEvidenceSpan,
): Extract<ScheduleDialogueFrame, { kind: "query_existing" }> | undefined {
  if (!HYPOTHETICAL_CONFLICT_READ_PATTERN.test(text)) return undefined;
  const entityText = entityTextFrom(text);
  return {
    ...(entityText === undefined ? {} : { entityText }),
    kind: "query_existing",
    statusScope: "committed",
    targetScope: "shared",
    evidenceSpans: [span],
  };
}

function isNonAuthorizingFrame(
  text: string,
  proposalIndex: number | undefined,
): boolean {
  if (!SCHEDULE_CONTEXT_PATTERN.test(text)) return false;
  return (
    THIRD_PARTY_OR_QUOTED_FRAME_PATTERN.test(text) ||
    UNCERTAIN_PROPOSAL_PATTERN.test(text) ||
    FORGED_HISTORY_OVERRIDE_PATTERN.test(text) ||
    conditionalPrecedesProposal(text, proposalIndex)
  );
}

function directQueryPrecedesConditionalAside(text: string): boolean {
  if (
    THIRD_PARTY_OR_QUOTED_FRAME_PATTERN.test(text) ||
    UNCERTAIN_PROPOSAL_PATTERN.test(text) ||
    FORGED_HISTORY_OVERRIDE_PATTERN.test(text)
  ) {
    return false;
  }
  const conditional = CONDITIONAL_PATTERN.exec(text);
  if (conditional === null) return true;
  const queryIndex = [
    PENDING_READ_PATTERN,
    COMMITTED_READ_PATTERN,
    WITHDRAWN_READ_PATTERN,
  ]
    .map((pattern) => pattern.exec(text)?.index)
    .filter((index): index is number => index !== undefined)
    .sort((left, right) => left - right)[0];
  return queryIndex !== undefined && queryIndex < conditional.index;
}

function resolveQueryFrame(
  text: string,
  span: ScheduleEvidenceSpan,
): Extract<ScheduleDialogueFrame, { kind: "query_existing" }> | undefined {
  const pending = PENDING_READ_PATTERN.test(text);
  const committed = COMMITTED_READ_PATTERN.test(text);
  const withdrawn = WITHDRAWN_READ_PATTERN.test(text);
  if (!pending && !committed && !withdrawn) return undefined;
  const entityText = entityTextFrom(text);
  return {
    kind: "query_existing",
    ...(entityText === undefined ? {} : { entityText }),
    statusScope: pending ? "pending" : committed ? "committed" : "any",
    targetScope:
      /(?:共同|我们|刚才|刚确认|待确认|待定|真正生效|北岸书店|公园)/u.test(text)
        ? "shared"
        : "all",
    evidenceSpans: [span],
  };
}

function conditionalPrecedesProposal(
  text: string,
  proposalIndex: number | undefined,
): boolean {
  const conditional = CONDITIONAL_PATTERN.exec(text);
  if (conditional === null) return false;
  return proposalIndex === undefined || conditional.index < proposalIndex;
}

function wholeMessageSpan(text: string): ScheduleEvidenceSpan | undefined {
  const first = text.search(/\S/u);
  if (first < 0) return undefined;
  const last = text.search(/\s*$/u);
  const end = last < first ? text.length : last;
  return { text: text.slice(first, end), start: first, end };
}

function matchSpan(
  original: string,
  pattern: RegExp,
  capture = 0,
): ScheduleEvidenceSpan | undefined {
  const normalized = original.normalize("NFKC");
  // NFKC keeps the schedule fixtures' code-unit offsets stable. Refuse the
  // optional narrow span if a caller supplied compatibility characters that
  // changed length; the whole-message evidence remains authoritative.
  if (normalized.length !== original.length) return undefined;
  const match = pattern.exec(normalized);
  const value = match?.[capture];
  if (match === null || value === undefined || value.trim() === "") {
    return undefined;
  }
  const relative = match[0].indexOf(value);
  const start = (match.index ?? 0) + Math.max(0, relative);
  return {
    text: original.slice(start, start + value.length),
    start,
    end: start + value.length,
  };
}

function entityTextFrom(text: string): string | undefined {
  const match = LOCATION_PATTERN.exec(text);
  const value = match?.[1];
  if (value === undefined) return undefined;
  const cleaned = cleanEntityText(value);
  return cleaned === "" ? undefined : cleaned;
}

function cleanEntityText(value: string): string {
  return value
    .replace(
      /^.*(?:刚才的|当前真正生效的|真正生效的|已经确认的|已确认的|如果|假如|要是|那个|这个|把)/u,
      "",
    )
    .replace(/^(?:去|在)/u, "")
    .replace(/[“”"「」『』]/gu, "")
    .trim();
}

function uniqueSpans(
  spans: readonly ScheduleEvidenceSpan[],
): ScheduleEvidenceSpan[] {
  const seen = new Set<string>();
  return spans.filter((span) => {
    const key = `${String(span.start)}:${String(span.end)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
