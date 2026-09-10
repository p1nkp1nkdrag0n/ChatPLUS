/** Only direct, unquoted current requests may prescribe a response style. */
export const CURRENT_REQUEST_POLICY_VERSION = "clause_requests_v3";
const LISTEN =
  /(?:先(?:听我说|让我(?:说|讲)完)|听我说就好|只想(?:说说|吐槽|倾诉)|just listen)/giu;
const ADVICE =
  /(?:请.{0,6}(?:建议|帮我|分析)|给我.{0,6}(?:建议|办法|方案)|帮我.{0,6}(?:分析|想想|解决|决定|选)|我(?:该|应该)怎么(?:办|做)|有什么(?:建议|办法)|你建议|what should I do|(?:give me|I (?:want|need)) (?:some )?(?:advice|help)|help me (?:decide|solve|plan|understand)|(?:直接|再|然后|接着)(?:详细|深入|具体)?(?:分析|给建议))/giu;
// A requested output or direct production verb grants help; nouns in an
// account of somebody's day do not. Modifiers are bounded within one clause.
const TASK_REQUEST =
  /(?:(?:给我|为我提供).{0,40}?(?:顺序|步骤|流程|清单|计划|方案|草稿|回复|措辞)|(?:帮我|替我|为我|(?:请|麻烦)(?:你)?(?:帮我|替我|为我)?|(?:你)?(?:能不能|可不可以)(?:帮我|替我|为我)?)(?:先|再|现在|直接|认真|具体|详细|逐项|逐步|简单|完整|充分|一下|地){0,6}(?:写|拟|起草|列|安排|制定|规划|梳理|比较|对比|评估|分析|解释|展开(?:比较|对比|分析|解释|讲|说))|(?:现在|这次|这轮)(?:可以|能)(?:一起|帮我)(?:想(?:想)?办法|讨论(?:方案|办法))|\b(?:give me|I (?:want|need)) .{0,80}?(?:plan|steps|checklist|draft|reply)\b|\bhelp me (?:write|draft|outline|prepare|compare)\b|\b(?:please|could you|can you) (?:write|draft|outline|compare|plan)\b)/giu;
// An output noun later in the clause cannot change the actual object of
// “give me time/space/opportunity to ...” into a request to perform that work.
const NON_TASK_OBJECT =
  /^(?:(?:请|麻烦)(?:你)?)?(?:给我|为我提供)(?:一点|一些|些|点|更多(?:的)?|足够(?:的)?|一段|片刻|一个)?(?:时间|空间|机会|耐心|安静)|^(?:give me|I (?:want|need)) (?:some |a little |more )?(?:time|space|a chance)\b/iu;
const NO_ADVICE =
  /(?:不(?:用|要|必|急着).{0,5}(?:建议|分析|解决)|别.{0,4}(?:建议|分析|追问)|(?:don't|do not|no) (?:give (?:me )?)?(?:advice|analy[sz]e))/giu;
const DETAIL =
  /(?:详细|深入|逐步|一步一步|逐项|多角度|全面|完整方案|深度分析|(?:认真|充分)?展开(?:比较|对比|分析|解释|讲|说)|in detail|step[- ]by[- ]step|thorough|comprehensive)/iu;
const DETAIL_REQUEST =
  /(?:请|帮我|给我|我想(?:听|了解|知道)|我需要|你能|能不能|可以.{0,3}(?:说|讲)|(?:详细|深入|逐步|一步一步|多角度|全面).{0,3}(?:说说|讲讲|分析一下)|^(?:详细|深入|逐步|全面)(?:分析|解释)|\b(?:please|could you|can you|explain|describe|give me|I want|I need)\b)/iu;
const NEGATION =
  /(?:不用|不要|不必|不需要|没必要|无需|无须|别|不是|并非|不想|没让|没有让|don't|do not|not)\s*(?:只是|仅仅|只|让你|要你|请你|你|to|just|only)?\s*(?:现在|这次|这轮|今天|今晚|再|先)?\s*$/iu;
const CORRECTION =
  /^(?:但|但是|不过|而是|是请|改成|改为|还是先|不$|算了$|but\b|instead\b|no$)/iu;
const REPORTED_OR_HYPOTHETICAL =
  /^(?:(?:她|他|别人|朋友|同事|你|我(?:以前|之前|当时|刚才)).{0,8}(?:说|让|要求)|(?:如果|假如|假设|要是)|(?:she|he|they|you) (?:said|asked)|if\b)/iu;
const CURRENT_ADOPTION =
  /^(?:你(?:现在|这次|这轮)(?:帮我|替我|为我)|(?:现在|这次|这轮)(?:我想)?(?:请你|麻烦你|帮我|替我)|我现在(?:想请你|需要你|要你))/iu;
const FUTURE_REQUEST_PREFIX =
  /(?:明天|后天|改天|下次|稍后|晚些时候|以后|待会儿|等会儿)(?:再|才)?\s*$|\b(?:tomorrow|later|next time)\s*$/iu;

// A procedure must be the requested output, not the topic of a short draft.
// The head boundary excludes “a summary/reply about the plan”. These hints
// only classify an already accepted, clause-scoped task request below.
const PROCEDURAL_OUTPUT_HEAD =
  /(?:顺序|步骤|流程|清单|计划|方案)(?=$|[吧呢啊呀]|(?:重点|需要|必须|包含|包括|要|能|可以|并|然后|再|就))|\b(?:plan|steps|checklist)\b(?=$|\s+(?:for|to|with|that|covering)\b)/iu;
const REFERENCED_OUTPUT =
  /(?:回复|草稿|措辞|标题|句子|一条消息|一句话|一版|提到|谈到|介绍|描述)|\b(?:reply|draft|message|title|sentence|mention|describe|about)\b/iu;
const PROCEDURAL_REQUEST_ACTION =
  /(?:给我|为我提供)|(?:写|拟|起草|列|安排|制定|规划|梳理)$|\b(?:give me|I (?:want|need)|write|draft|outline|prepare|plan)\b/iu;

function requestsProcedure(match: RegExpMatchArray, clause: string): boolean {
  if (!PROCEDURAL_REQUEST_ACTION.test(match[0])) return false;
  const requestedOutput = clause.slice(match.index);
  const head = PROCEDURAL_OUTPUT_HEAD.exec(requestedOutput);
  return (
    head !== null &&
    head.index <= 100 &&
    !REFERENCED_OUTPUT.test(requestedOutput.slice(0, head.index))
  );
}

/** Quotation is conversation data, including quoted requests and hypothetical examples. */
export function withoutQuotedConversationText(text: string): string {
  return text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<!\p{L})'[^'\n]*'(?!\p{L})|`[^`]*`/gu,
    " ",
  );
}

/** Finite clause parsing; unresolved conflicting requests stay neutral. */
export function deriveCurrentConversationRequests(originalQuery: string) {
  const text = withoutQuotedConversationText(originalQuery);
  const clauses = [
    ...text
      .replace(
        /(?<!不)(但是|但|不过|而是|改成|改为)|\b(but|instead)\b/giu,
        "，$&",
      )
      .matchAll(/([^，,。.!！?？;；\n]+)([，,。.!！?？;；\n]*)/gu),
  ]
    .map((match) => ({ text: match[1]!.trim(), separator: match[2]! }))
    .filter((clause) => clause.text.length > 0);
  let listen = false;
  let advice = false;
  let detail = false;
  let structuredTask = false;
  let deferredHelp = false;
  let newSentence = true;
  let reportedScope: "introduction" | "statement" | "hypothetical" | undefined;
  for (const entry of clauses) {
    const clause = entry.text;
    if (newSentence) reportedScope = undefined;
    newSentence = /[。.!！?？;；\n]/u.test(entry.separator);
    const changesRequest =
      [LISTEN, NO_ADVICE, ADVICE, TASK_REQUEST].some(
        (pattern) => [...clause.matchAll(pattern)].length > 0,
      ) || /^(?:改成|改为|还是先|不$|算了$|no$)/iu.test(clause);
    if (CORRECTION.test(clause) && changesRequest) {
      reportedScope = undefined;
      listen = false;
      advice = false;
      detail = false;
      structuredTask = false;
      deferredHelp = false;
    }
    const report = CURRENT_ADOPTION.test(clause)
      ? null
      : REPORTED_OR_HYPOTHETICAL.exec(clause);
    if (report) {
      reportedScope = /^(?:如果|假如|假设|要是|if\b)/iu.test(clause)
        ? "hypothetical"
        : clause.slice(report[0].length).trim().length === 0
          ? "introduction"
          : "statement";
      continue;
    }
    if (reportedScope !== undefined) {
      // An explicit new request after a complete indirect report is adoption.
      // A report introduction followed by its quoted command stays data.
      if (reportedScope === "statement" && CURRENT_ADOPTION.test(clause))
        reportedScope = undefined;
      else continue;
    }
    const requests = [
      ...[...clause.matchAll(LISTEN)].map((match) => ({
        match,
        kind: "listen" as const,
        structured: false,
      })),
      ...[...clause.matchAll(NO_ADVICE)].map((match) => ({
        match,
        kind: "no_advice" as const,
        structured: false,
      })),
      ...[ADVICE, TASK_REQUEST].flatMap((pattern) =>
        [...clause.matchAll(pattern)].map((match) => ({
          match,
          kind: "advice" as const,
          structured:
            pattern === TASK_REQUEST && requestsProcedure(match, clause),
        })),
      ),
    ].sort(
      (left, right) =>
        left.match.index - right.match.index ||
        right.match[0].length - left.match[0].length ||
        Number(right.structured) - Number(left.structured),
    );
    let previousEnd = 0;
    let clauseAdvice = false;
    let clauseNoAdvice = false;
    let clauseNegatedHelp = false;
    let clauseFutureHelp = false;
    let clauseNonTaskObject = false;
    for (const { match, kind, structured } of requests) {
      if (match.index < previousEnd) continue;
      const prefix = clause.slice(previousEnd, match.index);
      const negated =
        NEGATION.test(prefix) ||
        (kind !== "no_advice" &&
          /^(?:请|帮我).{0,2}(?:别|不要|不用)/u.test(match[0]));
      previousEnd = match.index + match[0].length;
      if (
        kind === "advice" &&
        NON_TASK_OBJECT.test(clause.slice(match.index))
      ) {
        clauseNonTaskObject = true;
        continue;
      }
      if (negated) {
        clauseNegatedHelp ||= kind === "advice";
        continue;
      }
      if (kind === "listen" || kind === "no_advice") {
        listen = true;
        clauseNoAdvice ||= kind === "no_advice";
      } else {
        if (FUTURE_REQUEST_PREFIX.test(clause.slice(0, match.index))) {
          clauseFutureHelp = true;
          continue;
        }
        clauseAdvice = true;
        advice = true;
        structuredTask ||= structured;
        deferredHelp ||=
          listen &&
          /(?:再|然后|接着|之后|说完|讲完|then|after)/iu.test(
            clause.slice(0, match.index + match[0].length),
          );
      }
    }
    const clauseDetail =
      DETAIL.test(clause) &&
      (!(clauseNegatedHelp || clauseFutureHelp || clauseNonTaskObject) ||
        clauseAdvice) &&
      (DETAIL_REQUEST.test(clause) || clauseAdvice) &&
      !/(?:(?:不用|不要|不必|无需|别).{0,6}(?:详细|深入|逐步|全面|分析)|(?:not|don't|do not|no need).{0,16}(?:detail|analy[sz]|thorough))/iu.test(
        clause,
      );
    if (clauseDetail && !clauseNoAdvice) {
      detail = true;
      if (!clauseAdvice)
        deferredHelp ||= listen && /(?:再|然后|之后|then|after)/iu.test(clause);
    }
  }
  const help = advice || detail;
  const conflicting = listen && help && !deferredHelp;
  return {
    listen,
    adviceRequested: advice,
    detailedAnalysisRequested: detail,
    structuredTaskRequested: structuredTask,
    conflicting,
    supportStyle: conflicting
      ? ("respond_naturally" as const)
      : deferredHelp
        ? ("listen_then_help" as const)
        : help
          ? ("offer_requested_help" as const)
          : listen
            ? ("listen" as const)
            : ("respond_naturally" as const),
    helpTiming: deferredHelp
      ? ("after_user_finishes" as const)
      : conflicting
        ? ("unspecified" as const)
        : ("now" as const),
  };
}
