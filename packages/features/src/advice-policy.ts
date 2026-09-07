import type { ConversationContextPlan } from "@personasim/contracts";

export const ADVICE_POLICY_VERSION = "advice_load_v2";
export type AdvicePolicy = "requested" | "none_now" | "optional_light";
export type AdvicePolicyInput = Pick<
  ConversationContextPlan,
  | "adviceRequested"
  | "detailedAnalysisRequested"
  | "supportStyle"
  | "helpTiming"
  | "intent"
>;

/** Current requests authorize help; a request to finish speaking defers that authorization. */
export function deriveAdvicePolicy(plan: AdvicePolicyInput): AdvicePolicy {
  if (
    plan.helpTiming === "after_user_finishes" ||
    plan.supportStyle === "listen_then_help"
  )
    return "none_now";
  if (plan.intent === "uncertain") return "optional_light";
  if (plan.adviceRequested || plan.detailedAnalysisRequested)
    return "requested";
  if (plan.supportStyle === "listen" || plan.intent === "venting")
    return "none_now";
  return "optional_light";
}

export interface AdviceAction {
  text: string;
  /** Offsets in the original reply, including when preceding quotations were masked. */
  start: number;
  end: number;
  strength: "optional" | "directive";
  burden: "light" | "substantial";
}

export interface AdviceLoadIssue {
  code:
    | "ADVICE_NOT_REQUESTED_NOW"
    | "ADVICE_LOAD_EXCEEDS_LIGHT"
    | "UNREQUESTED_DIRECTIVE"
    | "ADVICE_ACTION_UNRESOLVED";
  text: string;
  start: number;
  end: number;
}

export interface UnsupportedAdviceCandidate {
  text: string;
  start: number;
  end: number;
  strength: AdviceAction["strength"];
  /** A possible frame is audit evidence, not enough to declare a violation. */
  certainty: "explicit" | "possible";
  reason: "unparsed_action" | "unresolved_action_frame" | "ambiguous_frame";
}

export interface AdviceLoadInspection {
  policyVersion: typeof ADVICE_POLICY_VERSION;
  policy: AdvicePolicy;
  passed: boolean;
  /** Counts recognized concrete actions only; inspect coverage before using zero. */
  actionCount: number;
  actions: AdviceAction[];
  issues: AdviceLoadIssue[];
  reviewRequired: boolean;
  coverage: {
    status: "no_action_frame" | "resolved" | "partial" | "unresolved";
    unsupportedCandidates: UnsupportedAdviceCandidate[];
  };
}

// These are bounded action phrases, not a bag of words: imperative eligibility,
// actor, modality and clause scope are checked separately before any are counted.
const ACTION =
  /(?:出门|出去|下楼)(?:走(?:一圈|一走|走|几步|十分钟)?|散步|转转)|(?:画(?:画|两笔|几笔|一会儿|点东西)|散步|走一圈|走一走|(?:洗|泡|冲)(?:个)?(?:热水)?澡|喝(?:一|几|两|口|点|杯|些|热|温|杯)?[^，。；,.;！？!?]{0,5}?(?:水|茶)|倒(?:一杯|杯|点)(?:水|茶)|休息(?:一下|一会儿|会儿)?|歇(?:一下|一会儿|会儿)|深呼吸|做(?:几次|几组)?呼吸(?:练习)?|睡(?:一觉|个觉|会儿|一会儿)|早点睡|熬夜|列(?:个|一份|一下)?[^，。；,.;！？!?、或和及]{0,8}?(?:清单|列表|计划)|(?:记|写)下来|写在(?:纸上|本子上|笔记里)|写(?:个|一份|一下)?[^，。；,.;！？!?、或和及]{0,8}?(?:清单|计划|日记|邮件)|整理[^，。；,.;！？!?、或和及]{1,12}|确认[^，。；,.;！？!?、或和及]{1,12}|联系[^，。；,.;！？!?、或和及]{1,10}|发(?:一封|个|条)?[^，。；,.;！？!?、或和及]{0,8}?(?:邮件|消息)|(?:关掉|关闭|放下|收起)(?:手机|电脑|屏幕|工作|笔|材料|事情|这件事|它)|(?:重新|全部)?重写[^，。；,.;！？!?、或和及]{1,12}|制定[^，。；,.;！？!?、或和及]{1,12}|(?:take a walk|go for a walk|take a shower|draw|make a list|write (?:it|them) down|drink (?:some )?water|take a break|contact \w+|send (?:an? )?email))/giu;
const ADDITIONAL_ACTION =
  /(?:翻(?:翻|阅|看|几页)?|读(?:读|几页)?|看(?:看|几页)?)(?:[^，。；,.;！？!?、或和及]{0,12}?的)?(?:杂志|书|小说)|把(?:手机|电脑|屏幕|工作|笔|材料)(?:先)?(?:收起来|关掉|关闭|放下)/giu;
const OPTIONAL =
  /(?:你(?:也|还)?可以|不如|不妨|要不要|要不|可以(?:试试|考虑)|^(?:也许|或许|可能)?(?:也|还)?可以|试(?:一)?试|随手|愿意的话|(?:you (?:can|could)|maybe|perhaps|how about|why not)\b)/iu;
const DIRECTIVE =
  /(?:你(?:应该|应当|需要|必须|最好|得|要(?!不要))|建议你|务必|一定要|立刻|马上|(?:you (?:must|should|need to|have to)|I recommend|make sure)\b)/iu;
const DENIED_ADVICE =
  /^(?:(?:我)?(?:不是|并非|没有)(?:在)?(?:让|要|叫|劝|建议)(?:你)?|(?:你)?(?:也|还|先|再)?(?:不用|不必|无需|不需要|没必要)|(?:I am |I'm )?not (?:asking|telling|advising) you\b|you (?:do not|don't) (?:need|have) to\b)/iu;
// The negation belongs to manner, not the suggested action: “不用费心地读读书”.
const NEGATED_MANNER =
  /^(?:不用|无需|不必)(?:费心|费劲|费力|动脑子?)(?:地|就(?:可以|能)?)/u;
const REPORTED =
  /^(?:(?:你|他|她|朋友|同事|别人|妈妈|爸爸)(?:(?:刚才|之前|以前|昨天|已经|曾经|还|也|跟我|对我|和我)){0,3}(?:说|提过|建议|觉得)|我(?:刚才|之前|以前|曾经|昨天).{0,8}(?:说|建议)|(?:you|she|he|they) (?:said|suggested|asked)\b)/iu;
const OTHER_ACTOR =
  /^(?:我(?:也|还)?(?:今天|今晚|今早|明天|刚才|昨天|以前|下班|回家|饭后|晚上|周末|平时|会|想|准备|打算|可以|先)|(?:他|她|朋友|同事|别人)(?:也|还)?(?:今天|今晚|明天|刚才|昨天|会|想|准备|可以|先)|(?:I|she|he|they) (?:will|can|could|went|am|was|want)\b)/iu;
const OBSERVED_ACTION =
  /^(?:你(?:已经|刚才|昨天|昨晚|之前|以前)|you (?:already|yesterday|previously)\b)/iu;
const HYPOTHETICAL = /^(?:假如|假设|如果|要是|倘若|if\b|suppose\b)/iu;
const WILLINGNESS =
  /^(?:如果|要是)(?:你)?(?:愿意|想(?:试|缓|放松))|^if you (?:want|like)\b/iu;
const SUBSTANTIAL =
  /(?:每天|每日|每晚|坚持|至少\s*\d|必须|务必|立刻|马上|全部|整(?:份|个|套)|完整(?:的)?(?:计划|方案)|重写|制定|\b(?:every day|daily|all|entire|must|immediately)\b)/iu;
const DISCOURSE_PREFIX =
  /^(?:(?:不过|但是|然而|但|而且|并且|只是|例如|比如|譬如|然后|接着|最后|或者|或是|也可以(?=不用|不必)|也(?!许)|还)|(?:but|and|or|for example)\b)\s*/iu;
const CONTRAST = /^(?:不过|但是|然而|但|but\b)/iu;
const COORDINATED =
  /^(?:例如|比如|譬如|然后|再|接着|最后|或者|或是|并且|也可以|还可以|and\b|or\b|for example\b)/iu;
const DESCRIPTION =
  /(?:都没用|都没有用|都没什么用|有助于|能让人|会让人|不是万能|也未必|的(?:东西|时候|结果))/u;
const GENERIC_FRAME =
  /^(?:(?:做|找)(?:点|一点|些|一些)?[^，。]{0,16}(?:事|事情|活动|办法|方式)|给.{0,8}找个出口|[^，。]{1,18}的(?:活动|事|事情)|(?:试试)?这些)(?:吧|就好)?$/u;
const NON_ACTION_COMPLEMENT =
  /^(?:是|有|没有|不是|不喜欢|不开心|难过|生气|失望|觉得|知道|理解|相信|不认同|不同意|不高兴|很|挺|更|慢慢来|不急|be\b|feel\b|know\b|believe\b)/iu;
const CONVERSATION_INVITATION =
  /^(?:慢慢|继续|接着|放心)?(?:说(?=说|下去|完|给我|出来|吧|$)|讲(?=讲|下去|完|给我|吧|$)|聊(?=聊|下去|吧|$)|吐槽|告诉我)/u;

interface AdviceFrame {
  strength: AdviceAction["strength"];
  certainty: UnsupportedAdviceCandidate["certainty"];
  pending?: UnsupportedAdviceCandidate;
}

/** Inspect concrete recommendations addressed to the user, retaining exact audit spans.
 * This finite first pass does not claim unrestricted natural-language entailment.
 */
export function inspectAdviceLoad(input: {
  text: string;
  policy: AdvicePolicy;
}): AdviceLoadInspection {
  const visible = input.text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<!\p{L})'[^'\n]*'(?!\p{L})|`[^`]*`/gu,
    (quote) => " ".repeat(quote.length),
  );
  const actions: AdviceAction[] = [];
  const unsupportedCandidates: UnsupportedAdviceCandidate[] = [];
  let frame: AdviceFrame | undefined;
  let excluded = false;
  const closeFrame = () => {
    if (frame?.pending !== undefined) unsupportedCandidates.push(frame.pending);
    frame = undefined;
  };
  for (const segment of adviceSegments(visible)) {
    if (/[。.;；！!？?]|\n\s*\n/u.test(segment.separator)) {
      closeFrame();
      excluded = false;
    }
    const rawClause = segment.text.trim();
    const clause = rawClause.replace(DISCOURSE_PREFIX, "");
    const quoted =
      input.text.slice(segment.start, segment.end) !== segment.text;
    if (!clause) {
      if (quoted) {
        closeFrame();
        excluded = true;
      }
      continue;
    }
    const optional = OPTIONAL.exec(clause);
    const directive = DIRECTIVE.exec(clause);
    const cue = directive ?? optional;
    const uncertain = /^(?:也许|或许|可能)(?:可以|换|做|找|试)/u.test(clause);
    if (quoted) {
      closeFrame();
      if (cue === null) {
        excluded = true;
        continue;
      }
    }
    const body =
      cue === null ? clause : clause.slice(cue.index + cue[0].length).trim();
    const candidateBody = body.replace(
      /^(?:先|再|然后|接着|去|试试|考虑|随便|漫无目的地)\s*/u,
      "",
    );
    // Check denial on the predicate or direct modality complement, not anywhere
    // inside its object. Reports and changed actors also bind later examples.
    if (
      isDenied(clause) ||
      (cue !== null && isDenied(body)) ||
      REPORTED.test(clause) ||
      OTHER_ACTOR.test(clause) ||
      OBSERVED_ACTION.test(clause) ||
      (HYPOTHETICAL.test(clause) && !WILLINGNESS.test(clause))
    ) {
      closeFrame();
      excluded = true;
      continue;
    }
    if (CONVERSATION_INVITATION.test(candidateBody)) {
      // An activity named as the topic of an invitation is not an assigned task.
      // The invitation itself also resolves a preceding generic list parent.
      if (frame !== undefined) delete frame.pending;
      closeFrame();
      excluded = true;
      continue;
    }
    const explicitUser =
      /(?:你(?:也|还)?(?:可以|应该|应当|需要|必须|最好|得)|建议你|\byou (?:can|could|must|should|need to)\b)/iu.test(
        clause,
      );
    if (
      excluded &&
      !explicitUser &&
      !(CONTRAST.test(rawClause) && cue !== null)
    )
      continue;
    if (explicitUser || (CONTRAST.test(rawClause) && cue !== null))
      excluded = false;
    const candidates = [
      ...segment.text.matchAll(ACTION),
      ...segment.text.matchAll(ADDITIONAL_ACTION),
    ].sort((a, b) => a.index - b.index);
    const explicitStrength: AdviceAction["strength"] | undefined =
      directive !== null
        ? "directive"
        : optional !== null ||
            WILLINGNESS.test(clause) ||
            /(?:也行|也可以|就好|吧)\s*$/u.test(clause)
          ? "optional"
          : undefined;
    if (explicitStrength !== undefined) {
      // Example children can resolve a generic parent, rather than adding a
      // second unparsed "do something" task to an otherwise concrete list.
      frame ??= {
        strength: explicitStrength,
        certainty: uncertain ? "possible" : "explicit",
      };
      frame.strength = explicitStrength;
      if (cue !== null) frame.certainty = uncertain ? "possible" : "explicit";
    }
    const strength = explicitStrength ?? frame?.strength;
    let accepted = 0;
    for (const candidate of candidates) {
      const before = segment.text.slice(0, candidate.index);
      const after = segment.text.slice(candidate.index + candidate[0].length);
      // An activity embedded in a reported outcome or a descriptive noun phrase
      // is not a new imperative, even if an earlier clause contained a suggestion.
      if (
        /(?:已经|刚才|昨天|你说|他说|她说|并非|不是|没让).{0,10}$/u.test(
          before,
        ) ||
        /^(?:的(?:东西|时候|人|结果)|过|了|都没用|都没什么用|让我|会让人|能让人|不是|并不|不等于|未必|也未必|有助于|可以让|很|挺)/u.test(
          after,
        )
      )
        continue;
      const bareImperative =
        /^(?:\s*(?:[-*•]|\d+[.)、]))?\s*(?:你|先|再|然后|接着|去|就|每天|请|别|不要)*\s*$/u.test(
          before,
        );
      if (strength === undefined && !bareImperative) continue;
      // Past/general descriptions such as “洗澡有助于放松” are not instructions.
      if (
        strength === undefined &&
        /(?:有助于|可以让|能让|都没用|都没有用|都没什么用|是|的时候|过了|过一次)/u.test(
          after,
        )
      )
        continue;
      const start = segment.start + candidate.index;
      const end = start + candidate[0].length;
      const action: AdviceAction = {
        text: input.text.slice(start, end),
        start,
        end,
        strength: strength ?? "directive",
        burden: SUBSTANTIAL.test(clause) ? "substantial" : "light",
      };
      accepted += 1;
      if (frame !== undefined) delete frame.pending;
      const existing = actions.find(
        (previous) =>
          actionIdentity(previous.text) === actionIdentity(action.text),
      );
      if (existing === undefined) actions.push(action);
      else {
        // Rephrasing the same small proposal is one action, while its strongest
        // tone/burden still determines whether it remained optional.
        if (
          (action.strength === "directive" &&
            existing.strength === "optional") ||
          (action.burden === "substantial" && existing.burden === "light")
        ) {
          existing.text = action.text;
          existing.start = action.start;
          existing.end = action.end;
        }
        if (action.strength === "directive") existing.strength = "directive";
        if (action.burden === "substantial") existing.burden = "substantial";
      }
    }
    if (accepted > 0) continue;
    const coordinated =
      COORDINATED.test(rawClause) ||
      /(?:、|或|\band\b|\bor\b)/iu.test(segment.separator);
    // No vocabulary match is not proof of no advice. Preserve complements of
    // actual frames, but do not manufacture candidates from arbitrary prose.
    if (
      candidates.length === 0 &&
      !DESCRIPTION.test(clause) &&
      !NON_ACTION_COMPLEMENT.test(candidateBody) &&
      !CONVERSATION_INVITATION.test(candidateBody) &&
      !/^如果|^要是|^(?:其他|其余)的/u.test(clause) &&
      ((cue !== null && candidateBody.length >= 2) ||
        (frame !== undefined && coordinated && candidateBody.length >= 2) ||
        uncertain)
    ) {
      const candidateText = uncertain && cue === null ? clause : candidateBody;
      const start = segment.start + segment.text.indexOf(candidateText);
      const candidate: UnsupportedAdviceCandidate = {
        text: input.text.slice(start, start + candidateText.length),
        start,
        end: start + candidateText.length,
        strength: strength ?? "optional",
        certainty: uncertain ? "possible" : (frame?.certainty ?? "explicit"),
        reason: uncertain ? "ambiguous_frame" : "unparsed_action",
      };
      if (GENERIC_FRAME.test(candidateText) && frame !== undefined) {
        frame.pending = { ...candidate, reason: "unresolved_action_frame" };
      } else {
        if (frame !== undefined) delete frame.pending;
        unsupportedCandidates.push(candidate);
      }
    }
  }
  closeFrame();
  const issues: AdviceLoadIssue[] = [];
  const issue = (code: AdviceLoadIssue["code"], action: AdviceAction) =>
    issues.push({
      code,
      text: action.text,
      start: action.start,
      end: action.end,
    });
  if (input.policy === "none_now") {
    for (const action of actions) issue("ADVICE_NOT_REQUESTED_NOW", action);
    for (const candidate of unsupportedCandidates)
      if (candidate.certainty === "explicit")
        issues.push({
          code: "ADVICE_ACTION_UNRESOLVED",
          text: candidate.text,
          start: candidate.start,
          end: candidate.end,
        });
  } else if (input.policy === "optional_light") {
    if (actions.length > 1)
      for (const action of actions) issue("ADVICE_LOAD_EXCEEDS_LIGHT", action);
    for (const action of actions) {
      if (action.strength === "directive")
        issue("UNREQUESTED_DIRECTIVE", action);
      else if (action.burden === "substantial")
        issue("ADVICE_LOAD_EXCEEDS_LIGHT", action);
    }
  }
  return {
    policyVersion: ADVICE_POLICY_VERSION,
    policy: input.policy,
    passed: issues.length === 0,
    actionCount: actions.length,
    actions,
    issues,
    reviewRequired: unsupportedCandidates.length > 0,
    coverage: {
      status:
        unsupportedCandidates.length > 0
          ? actions.length > 0
            ? "partial"
            : "unresolved"
          : actions.length > 0
            ? "resolved"
            : "no_action_frame",
      unsupportedCandidates,
    },
  };
}

function isDenied(text: string): boolean {
  return DENIED_ADVICE.test(text) && !NEGATED_MANNER.test(text);
}

/** Preserve source offsets while separating finite local example/list children. */
function* adviceSegments(text: string): Generator<{
  text: string;
  start: number;
  end: number;
  separator: string;
}> {
  let start = 0;
  let separator = "";
  for (const boundary of text.matchAll(
    /[，,。.;；！!？?\n：:、]+|或者|或是|或(?!许|者)|(?<![你我他她])(?=(?:也|还)可以)|\b(?:and|or)\s+/giu,
  )) {
    yield {
      text: text.slice(start, boundary.index),
      start,
      end: boundary.index,
      separator,
    };
    separator = boundary[0];
    start = boundary.index + boundary[0].length;
  }
  yield { text: text.slice(start), start, end: text.length, separator };
}

function actionIdentity(text: string): string {
  if (
    /^(?:(?:出门|出去|下楼)?(?:走|散步|转转)|take a walk|go for a walk)/iu.test(
      text,
    )
  )
    return "walk";
  if (/^(?:画|draw)/iu.test(text)) return "draw";
  if (/^(?:(?:洗|泡|冲).{0,4}澡|take a shower)/iu.test(text)) return "shower";
  if (/^(?:休息|歇|take a break)/iu.test(text)) return "rest";
  if (/^(?:深呼吸|做.{0,4}呼吸)/u.test(text)) return "breathe";
  if (/^(?:翻|读|看)/u.test(text) && /(?:杂志|书|小说)$/u.test(text))
    return `read:${text.endsWith("杂志") ? "magazine" : "book"}`;
  return text.toLocaleLowerCase();
}
