import type { ConversationContextPlan } from "@personasim/contracts";

export const ADVICE_POLICY_VERSION = "advice_load_v1";
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
    | "UNREQUESTED_DIRECTIVE";
  text: string;
  start: number;
  end: number;
}

export interface AdviceLoadInspection {
  policyVersion: typeof ADVICE_POLICY_VERSION;
  policy: AdvicePolicy;
  passed: boolean;
  actionCount: number;
  actions: AdviceAction[];
  issues: AdviceLoadIssue[];
}

// These are bounded action phrases, not a bag of words: imperative eligibility,
// actor, modality and clause scope are checked separately before any are counted.
const ACTION =
  /(?:出门|出去|下楼)(?:走(?:一圈|一走|走|几步|十分钟)?|散步|转转)|(?:画(?:画|两笔|几笔|一会儿|点东西)|散步|走一圈|走一走|(?:洗|泡|冲)(?:个)?(?:热水)?澡|喝(?:一|几|两|口|点|杯|些|热|温|杯)?[^，。；,.;！？!?]{0,5}?(?:水|茶)|倒(?:一杯|杯|点)(?:水|茶)|休息(?:一下|一会儿|会儿)?|歇(?:一下|一会儿|会儿)|深呼吸|做(?:几次|几组)?呼吸(?:练习)?|睡(?:一觉|个觉|会儿|一会儿)|早点睡|熬夜|列(?:个|一份|一下)?[^，。；,.;！？!?、或和及]{0,8}?(?:清单|列表|计划)|(?:记|写)下来|写在(?:纸上|本子上|笔记里)|写(?:个|一份|一下)?[^，。；,.;！？!?、或和及]{0,8}?(?:清单|计划|日记|邮件)|整理[^，。；,.;！？!?、或和及]{1,12}|确认[^，。；,.;！？!?、或和及]{1,12}|联系[^，。；,.;！？!?、或和及]{1,10}|发(?:一封|个|条)?[^，。；,.;！？!?、或和及]{0,8}?(?:邮件|消息)|(?:关掉|关闭|放下|收起)(?:手机|电脑|屏幕|工作|笔|材料|事情|这件事|它)|(?:重新|全部)?重写[^，。；,.;！？!?、或和及]{1,12}|制定[^，。；,.;！？!?、或和及]{1,12}|(?:take a walk|go for a walk|take a shower|draw|make a list|write (?:it|them) down|drink (?:some )?water|take a break|contact \w+|send (?:an? )?email))/giu;
const OPTIONAL =
  /(?:你(?:也|还)?可以|不如|不妨|要不要|要不|可以(?:试试|考虑)|^可以|试(?:一)?试|随手|愿意的话|(?:you (?:can|could)|maybe|perhaps|how about|why not)\b)/iu;
const DIRECTIVE =
  /(?:你(?:应该|应当|需要|必须|最好|得|要(?!不要))|建议你|务必|一定要|立刻|马上|(?:you (?:must|should|need to|have to)|I recommend|make sure)\b)/iu;
const DENIED_ADVICE =
  /(?:不是|并非|没有)(?:在)?(?:让|要|叫|劝|建议)(?:你)?|(?:不用|不必|无需|不需要|没必要)(?:你|去|再|先)?|(?:not (?:asking|telling|advising) you|you (?:do not|don't) (?:need|have) to)\b/iu;
const REPORTED =
  /^(?:(?:你(?:刚才|之前|以前)?|(?:他|她|朋友|同事|别人|妈妈|爸爸)).{0,8}(?:说|提过|建议|觉得)|我(?:刚才|之前|以前|曾经|昨天).{0,8}(?:说|建议)|(?:you|she|he|they) (?:said|suggested|asked)\b)/iu;
const OTHER_ACTOR =
  /^(?:我(?:今天|刚才|昨天|以前|会|想|准备|打算|可以|先)|(?:他|她|朋友|同事|别人)(?:今天|刚才|昨天|会|想|准备|可以|先)|(?:I|she|he|they) (?:will|can|could|went|am|was|want)\b)/iu;
const HYPOTHETICAL = /^(?:假如|假设|如果|要是|倘若|if\b|suppose\b)/iu;
const WILLINGNESS =
  /^(?:如果|要是)(?:你)?(?:愿意|想(?:试|缓|放松))|^if you (?:want|like)\b/iu;
const SUBSTANTIAL =
  /(?:每天|每日|每晚|坚持|至少\s*\d|必须|务必|立刻|马上|全部|整(?:份|个|套)|完整(?:的)?(?:计划|方案)|重写|制定|\b(?:every day|daily|all|entire|must|immediately)\b)/iu;

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
  let inherited: AdviceAction["strength"] | undefined;
  let previousEnd = 0;
  let listStrength: AdviceAction["strength"] | undefined;
  for (const match of visible.matchAll(/[^，,。；;！!？?\n：:]+/gu)) {
    const prefix = visible.slice(previousEnd, match.index);
    if (/[。；;！!？?]|\n\s*\n/u.test(prefix)) {
      inherited = undefined;
      listStrength = undefined;
    } else if (/[:：]/u.test(prefix)) {
      listStrength = inherited;
    }
    previousEnd = match.index + match[0].length;
    const clause = match[0].trim();
    if (
      DENIED_ADVICE.test(clause) ||
      REPORTED.test(clause) ||
      OTHER_ACTOR.test(clause) ||
      (HYPOTHETICAL.test(clause) && !WILLINGNESS.test(clause))
    ) {
      inherited = undefined;
      listStrength = undefined;
      continue;
    }
    const candidates = [...match[0].matchAll(ACTION)];
    const explicitStrength: AdviceAction["strength"] | undefined =
      DIRECTIVE.test(clause)
        ? "directive"
        : OPTIONAL.test(clause) ||
            WILLINGNESS.test(clause) ||
            /(?:也行|也可以|就好|吧)\s*$/u.test(clause)
          ? "optional"
          : undefined;
    if (explicitStrength !== undefined) inherited = explicitStrength;
    const strength = explicitStrength ?? inherited ?? listStrength;
    for (const candidate of candidates) {
      const before = match[0].slice(0, candidate.index);
      const after = match[0].slice(candidate.index + candidate[0].length);
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
      const start = match.index + candidate.index;
      const end = start + candidate[0].length;
      const action: AdviceAction = {
        text: input.text.slice(start, end),
        start,
        end,
        strength: strength ?? "directive",
        burden: SUBSTANTIAL.test(clause) ? "substantial" : "light",
      };
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
  }
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
  };
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
  return text.toLocaleLowerCase();
}
