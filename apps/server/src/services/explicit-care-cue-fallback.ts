import {
  CareCueCandidateSchema,
  type CareCueCandidate,
} from "@personasim/contracts";
import { classifyNonAuthoritativeUserFactSourceStatuses } from "@personasim/features";

const FUTURE_TIME_PATTERN =
  /(?:今天|今日|今晚|明天|明日|后天|下周(?:[一二三四五六日天])?|下星期(?:[一二三四五六日天])?|本周(?:[一二三四五六日天])?|这周(?:[一二三四五六日天])?|周[一二三四五六日天]|星期[一二三四五六日天]|月底|月初|today|tonight|tomorrow|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))/iu;
const CARE_EVENT_PATTERN =
  /(?:公开分享|分享|答辩|面试|考试|汇报|演讲|手术|复诊|体检|比赛|作品集|提交|交稿|发布|会议|返工|回校|出差|presentation|defen[cs]e|interview|exam|speech|surgery|appointment|competition|submission|meeting)/iu;
const FIRST_PERSON_EVENT_PATTERN =
  /(?:我.{0,24}(?:要|会|将|准备|打算|得|需要|参加|进行|做|有).{0,24}(?:公开分享|分享|答辩|面试|考试|汇报|演讲|手术|复诊|体检|比赛|作品集|提交|交稿|发布|会议|返工|回校|出差)|我的.{0,16}(?:公开分享|分享|答辩|面试|考试|汇报|演讲|手术|复诊|体检|比赛|作品集|提交|交稿|发布|会议)|\bi\s+(?:will|am\s+going\s+to|have\s+to|need\s+to).{0,48}(?:present|defend|interview|take\s+an?\s+exam|give\s+a\s+speech|have\s+surgery|attend\s+an?\s+appointment|compete|submit|meet))/iu;
const NON_USER_EVENT_OWNER_PATTERN =
  /(?:我(?:的)?)?(?:朋友|同事|同学|家人|室友|伴侣|对象|孩子|父母|妈妈|爸爸|姐姐|哥哥|弟弟|妹妹).{0,48}(?:公开分享|分享|答辩|面试|考试|汇报|演讲|手术|复诊|体检|比赛|作品集|提交|交稿|发布|会议|返工|回校|出差)/iu;
const NEGATED_USER_EVENT_PATTERN =
  /我.{0,20}(?:(?:不|不用|无需|不必)(?:再)?(?:需要|会|要|参加|进行|做|去|接受|有)|(?:没有|没)(?:有|要|参加|进行|做|去|接受)?).{0,24}(?:公开分享|分享|答辩|面试|考试|汇报|演讲|手术|复诊|体检|比赛|作品集|提交|交稿|发布|会议|返工|回校|出差)/iu;
const FIRST_PERSON_CARE_PATTERN =
  /(?:我(?:现在|此刻|这一刻|这会儿)?(?:只|更)?(?:想|希望|需要)(?:要)?(?:先)?(?:被(?:好好)?(?:听见|倾听|理解)|(?:让)?你(?:先)?(?:听我(?:说(?:完)?)?|倾听我|陪(?:着)?我|安慰我))|我(?:希望|想让|请|需要)你.{0,16}(?:先)?(?:听我(?:说(?:完)?)?|倾听我|陪(?:着)?我|安慰我)|(?:请)?先.{0,12}(?:听我(?:说(?:完)?)?|问我|陪(?:着)?我|安慰我)|\bi\s+(?:only\s+)?(?:want|need|would\s+like)\s+(?:you\s+)?to\s+(?:listen|hear\s+me|stay\s+with\s+me|comfort\s+me))/iu;
const POLITE_CARE_REQUEST_PATTERN =
  /(?:你)?(?:可以|能|能不能|可不可以|愿意|方便)?(?:先)?(?:听我(?:说(?:完)?)?|倾听我|陪(?:着)?我|安慰我).{0,4}(?:吗|么)[?？]?/iu;
const ADVICE_BOUNDARY_PATTERN =
  /(?:(?:不要|别|不用|无需|不必)(?:马上|立刻|急着|着急|一上来就|先)?(?:就)?(?:给我|给|提|提供|讲|说)?(?:任何)?(?:建议|道理|大道理|说教|解决方案)|\b(?:do\s+not|don't)\s+(?:immediately\s+|right\s+away\s+)?(?:give|offer)\s+(?:me\s+)?advice\b)/iu;
const EXPLICIT_DURABLE_CARE_PATTERN =
  /(?:(?:请)?(?:记住|记得|记下)|(?:我的|这种)(?:关怀|关心)(?:方式|偏好)|\b(?:remember|keep\s+in\s+mind)\b)/iu;
const DIRECT_CARE_COMMAND_PATTERN =
  /(?:请(?:主动)?(?:先)?(?:问我|听我(?:说(?:完)?)?|倾听我|陪(?:着)?我|安慰我)|(?:请)?先(?:问我|听我(?:说(?:完)?)?|倾听我|陪(?:着)?我|安慰我))/iu;
const SPECULATIVE_FRAME_START_PATTERN =
  /(?:^|[，,。！？!?；;：:\s])(?:假设|假定|假如|假若|假想(?:一下)?|试想(?:一下)?|想象(?:一下)?|设想|如果|要是|万一|倘若|打个比方|举个例子|比如说)|\b(?:hypothetically|assume|assuming|suppose|supposing|imagine|for\s+example|if)\b|\b(?:this|that)\s+(?:is|was)\s+(?:a\s+)?hypothetical(?:\s+(?:scenario|example))?\b/iu;
const META_SPECULATIVE_LISTEN_REQUEST_PATTERN =
  /(?:(?:请|麻烦)?(?:你)?(?:先)?听我说(?:完)?(?:一下)?\s*(?:以下|这个|这一个|一个|下面|接下来)?\s*(?:的)?\s*(?:假设|假定|假想|设想|例子|场景)|(?:please\s+)?(?:listen|hear\s+me)\s+(?:to|through)\s+(?:this|the\s+following)\s+(?:hypothetical|scenario|example))/iu;
const TARGETED_CHECK_IN_PATTERN =
  /(?:请)?(?:主动|到时|届时)?(?:再)?(?:问我|来问我|跟我确认|向我确认)/u;
const HARD_NON_AUTHORITATIVE_CARE_PATTERN =
  /(?:并不是真的|不是真实事实|这不是事实|这件事没有发生|从未发生过|并没有这回事|不是我说的|撤回|收回|撤销|作废|刚才那条不算数)|\b(?:this\s+is\s+not\s+(?:true|real)|this\s+never\s+happened|i\s+(?:retract|withdraw|take\s+back)\s+(?:that|this|it))\b/iu;
const CARE_RETRACTION_PATTERN =
  /(?:(?:我)?(?:不是|并不是|并非|没有|没)(?:在)?说.{0,64}(?:只想被听见|先听我|不要马上给建议|关怀方式)|(?:不再|已经不).{0,32}(?:只想被听见|希望你先听|需要你先听)|(?:别|不要|不用|无需)(?:替我)?(?:记|记住|保存).{0,80}(?:只想被听见|先听我|不要马上给建议|关怀|关心|偏好|这件事)|(?:不要|别|不用|无需|不必)(?:先)?(?:听我|问我|陪我|安慰我)|(?:你)?(?:可以|请)(?:马上|直接|立刻).{0,12}(?:给|提|提供).{0,8}建议)/iu;
const CARE_QUERY_PATTERN =
  /(?:是不是|是否|会不会|难道).{0,48}(?:只想被听见|先听我|不要马上给建议)|(?:只想被听见|先听我|不要马上给建议).{0,24}[?？]/iu;
const THIRD_PARTY_ATTRIBUTION_PATTERN =
  /(?:他|她|ta|他们|她们|朋友|同事|同学|家人|室友|小[\p{Script=Han}]{1,3}|[\p{Script=Han}]{1,4}老师)(?:刚才|刚刚|曾经)?(?:说|表示|告诉我|写道|发消息说)[：:,，]?/iu;
const GENERIC_SPEECH_ATTRIBUTION_PATTERN =
  /([\p{Script=Han}]{2,4})(?:刚才|刚刚|曾经)?(?:说|表示|告诉我|写道|发消息说)[：:,，]?/giu;
const QUOTED_SPEECH_ATTRIBUTION_PATTERN =
  /[\p{Script=Han}]{2,4}(?:刚才|刚刚|曾经)?(?:说|表示|写道|告诉我|发消息说)[：:,，]?\s*[“‘「『《〈"']/iu;
const NON_NAME_SPEECH_PREFIX_PATTERN =
  /^(?:我|我.{0,3}|坦白|老实|总的来|具体来|严格来|一般来|现在来|相对来|换句话|.*(?:听我|问我|让我|跟我|对我|向我))$/u;
const EXAMPLE_FRAME_PATTERN =
  /(?:打个比方|打个比喻|比如|例如|举个例子|这里只是举例|只是举例|仅作示例|假设一个例子)/iu;

/**
 * Distinguishes a direct durable-care command with a conditional response
 * branch from a hypothetical care scenario. The direct command must precede
 * the first speculative frame; this admits "请主动问我……；如果仍然……" but
 * not "如果/万一我……，请记住……".
 */
export function hasAuthoritativeExplicitDurableCareDirective(
  userText: string,
): boolean {
  const nonAuthoritativeStatuses =
    classifyNonAuthoritativeUserFactSourceStatuses(userText);
  const hasHypotheticalSource =
    nonAuthoritativeStatuses.includes("hypothetical");
  if (
    !EXPLICIT_DURABLE_CARE_PATTERN.test(userText) ||
    nonAuthoritativeStatuses.some((status) => status !== "hypothetical") ||
    META_SPECULATIVE_LISTEN_REQUEST_PATTERN.test(userText) ||
    HARD_NON_AUTHORITATIVE_CARE_PATTERN.test(userText) ||
    CARE_RETRACTION_PATTERN.test(userText) ||
    EXAMPLE_FRAME_PATTERN.test(userText) ||
    hasThirdPartyAttribution(userText)
  ) {
    return false;
  }

  const directCommand = DIRECT_CARE_COMMAND_PATTERN.exec(userText);
  if (
    directCommand === null ||
    isInsideQuotation(userText, directCommand.index)
  ) {
    return false;
  }
  const speculativeFrame = SPECULATIVE_FRAME_START_PATTERN.exec(userText);
  // The shared classifier is authoritative. If it sees a hypothetical frame
  // that this positional locator cannot safely bind, fail closed instead of
  // treating the durable instruction as an asserted user preference.
  if (hasHypotheticalSource && speculativeFrame === null) return false;
  if (speculativeFrame === null) return true;
  if (directCommand.index >= speculativeFrame.index) return false;

  const directFragment = fragmentBeforeSpeculativeFrame(
    userText,
    directCommand.index,
    speculativeFrame.index,
  );
  return (
    FUTURE_TIME_PATTERN.test(directFragment) &&
    (CARE_EVENT_PATTERN.test(directFragment) ||
      TARGETED_CHECK_IN_PATTERN.test(directFragment))
  );
}

/**
 * Produces a server-owned care proposal only for an explicit, current-user
 * response preference. A natural-language preference needs both a concrete
 * first-person future event and the listen-first/no-advice boundary. Explicit
 * durable instructions ("请记住……") keep the existing narrower path.
 */
export function deriveExplicitCareCueCandidate(
  userText: string,
): CareCueCandidate | undefined {
  const fragments = evidenceFragments(userText);
  const nonAuthoritativeStatuses =
    classifyNonAuthoritativeUserFactSourceStatuses(userText);
  const hasHypotheticalSource =
    nonAuthoritativeStatuses.includes("hypothetical");
  const careMatch = FIRST_PERSON_CARE_PATTERN.exec(userText);
  const durableCareInstruction = EXPLICIT_DURABLE_CARE_PATTERN.test(userText);
  const politeCareRequest = POLITE_CARE_REQUEST_PATTERN.test(userText);
  const authoritativeConditionalDurableCare =
    durableCareInstruction &&
    hasHypotheticalSource &&
    hasAuthoritativeExplicitDurableCareDirective(userText);
  if (
    careMatch === null ||
    nonAuthoritativeStatuses.some((status) => status !== "hypothetical") ||
    META_SPECULATIVE_LISTEN_REQUEST_PATTERN.test(userText) ||
    HARD_NON_AUTHORITATIVE_CARE_PATTERN.test(userText) ||
    CARE_RETRACTION_PATTERN.test(userText) ||
    (CARE_QUERY_PATTERN.test(userText) && !politeCareRequest) ||
    (hasHypotheticalSource && !authoritativeConditionalDurableCare) ||
    EXAMPLE_FRAME_PATTERN.test(userText) ||
    hasThirdPartyAttribution(userText) ||
    isInsideQuotation(userText, careMatch.index)
  ) {
    return undefined;
  }

  const careEvidenceIndex = fragments.findIndex((fragment) =>
    FIRST_PERSON_CARE_PATTERN.test(fragment),
  );
  const adviceEvidenceIndex = fragments.findIndex((fragment) =>
    ADVICE_BOUNDARY_PATTERN.test(fragment),
  );
  const ownedSubjectIndex = fragments.findIndex(
    (fragment) =>
      FUTURE_TIME_PATTERN.test(fragment) &&
      CARE_EVENT_PATTERN.test(fragment) &&
      FIRST_PERSON_EVENT_PATTERN.test(fragment) &&
      !NON_USER_EVENT_OWNER_PATTERN.test(fragment) &&
      !NEGATED_USER_EVENT_PATTERN.test(fragment),
  );
  const politeSubjectIndex = fragments.findIndex(
    (fragment) =>
      CARE_EVENT_PATTERN.test(fragment) &&
      POLITE_CARE_REQUEST_PATTERN.test(fragment) &&
      !NON_USER_EVENT_OWNER_PATTERN.test(fragment) &&
      !NEGATED_USER_EVENT_PATTERN.test(fragment),
  );
  const subjectEvidenceIndex =
    ownedSubjectIndex >= 0 ? ownedSubjectIndex : politeSubjectIndex;
  const careEvidence = fragments[careEvidenceIndex];
  const adviceEvidence = fragments[adviceEvidenceIndex];
  const subjectEvidence = fragments[subjectEvidenceIndex];
  const explicitDurablePreference =
    durableCareInstruction &&
    (!hasHypotheticalSource || authoritativeConditionalDurableCare) &&
    careEvidence !== undefined;
  const eventBoundPreference =
    subjectEvidence !== undefined &&
    careEvidence !== undefined &&
    adviceEvidence !== undefined &&
    Math.abs(careEvidenceIndex - adviceEvidenceIndex) <= 1 &&
    (subjectEvidenceIndex === careEvidenceIndex ||
      (subjectEvidenceIndex < careEvidenceIndex &&
        careEvidenceIndex - subjectEvidenceIndex <= 1));
  if (!explicitDurablePreference && !eventBoundPreference) return undefined;

  const contextEvidence = subjectEvidence ?? careEvidence;
  if (contextEvidence === undefined) return undefined;
  const evidenceQuotes = [contextEvidence, careEvidence, adviceEvidence]
    .filter((quote): quote is string => quote !== undefined)
    .filter((quote, index, all) => all.indexOf(quote) === index)
    .slice(0, 8);
  // A natural listen-first request describes how to respond now, even when its
  // subject is a future event. Keep exact scheduled timing only for the legacy
  // explicit "remember this care method" path.
  const hasTiming =
    explicitDurablePreference &&
    !eventBoundPreference &&
    FUTURE_TIME_PATTERN.test(userText);

  return CareCueCandidateSchema.parse({
    contextSummary: contextEvidence,
    mentionGuidance: eventBoundPreference
      ? "当用户再次谈到这项事件或相关感受时，先倾听并确认感受，不要马上给建议。"
      : "在后续相关语境中，先按用户指定的方式关心，不要立刻讲道理。",
    evidenceQuotes,
    reasonCode: "explicit_user_care_preference",
    reasonSummary: eventBoundPreference
      ? "用户在当前消息中明确陈述了与具体事件绑定的一人称关怀偏好。"
      : "用户明确要求记住一种有边界的关怀方式。",
    ...(hasTiming ? { timingHint: compactText(userText, 240) } : {}),
  });
}

function fragmentBeforeSpeculativeFrame(
  text: string,
  commandIndex: number,
  frameIndex: number,
): string {
  const prefixBeforeCommand = text.slice(0, commandIndex);
  const previousBoundary = Math.max(
    prefixBeforeCommand.lastIndexOf("。"),
    prefixBeforeCommand.lastIndexOf("！"),
    prefixBeforeCommand.lastIndexOf("？"),
    prefixBeforeCommand.lastIndexOf("!"),
    prefixBeforeCommand.lastIndexOf("?"),
    prefixBeforeCommand.lastIndexOf("；"),
    prefixBeforeCommand.lastIndexOf(";"),
    prefixBeforeCommand.lastIndexOf("\n"),
    prefixBeforeCommand.lastIndexOf("\r"),
  );
  return text.slice(previousBoundary + 1, frameIndex).trim();
}

function evidenceFragments(text: string): string[] {
  return [...text.matchAll(/[^。！？!?；;\r\n]+/gu)]
    .map((match) => compactText(match[0], 500))
    .filter((fragment) => fragment.length > 0);
}

function compactText(text: string, maximum: number): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : compact.slice(0, maximum);
}

function isInsideQuotation(text: string, index: number): boolean {
  const prefix = text.slice(0, index);
  if (prefix.lastIndexOf("“") > prefix.lastIndexOf("”")) return true;
  if (prefix.lastIndexOf("‘") > prefix.lastIndexOf("’")) return true;
  if (prefix.lastIndexOf("「") > prefix.lastIndexOf("」")) return true;
  if (prefix.lastIndexOf("『") > prefix.lastIndexOf("』")) return true;
  if (prefix.lastIndexOf("《") > prefix.lastIndexOf("》")) return true;
  if (prefix.lastIndexOf("〈") > prefix.lastIndexOf("〉")) return true;
  return (prefix.match(/["']/gu)?.length ?? 0) % 2 === 1;
}

function hasThirdPartyAttribution(text: string): boolean {
  if (
    THIRD_PARTY_ATTRIBUTION_PATTERN.test(text) ||
    QUOTED_SPEECH_ATTRIBUTION_PATTERN.test(text)
  ) {
    return true;
  }
  for (const match of text.matchAll(GENERIC_SPEECH_ATTRIBUTION_PATTERN)) {
    const speaker = match[1];
    if (
      speaker !== undefined &&
      !NON_NAME_SPEECH_PREFIX_PATTERN.test(speaker)
    ) {
      return true;
    }
  }
  return false;
}
