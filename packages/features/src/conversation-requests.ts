/** Only direct, unquoted current requests may prescribe a response style. */
const LISTEN =
  /(?:先(?:听我说|让我(?:说|讲)完)|听我说就好|只想(?:说说|吐槽|倾诉)|just listen)/giu;
const ADVICE =
  /(?:请.{0,6}(?:建议|帮我|分析)|给我.{0,6}(?:建议|办法|方案)|帮我.{0,6}(?:分析|想想|解决|决定|选)|我(?:该|应该)怎么(?:办|做)|有什么(?:建议|办法)|你建议|what should I do|(?:give me|I (?:want|need)) (?:some )?(?:advice|help)|help me (?:decide|solve|plan|understand)|(?:再|然后|接着)(?:分析|给建议))/giu;
const NO_ADVICE =
  /(?:不(?:用|要|必|急着).{0,5}(?:建议|分析|解决)|别.{0,4}(?:建议|分析|追问)|(?:don't|do not|no) (?:give (?:me )?)?(?:advice|analy[sz]e))/giu;
const DETAIL =
  /(?:详细|深入|逐步|一步一步|多角度|全面|完整方案|深度分析|in detail|step[- ]by[- ]step|thorough|comprehensive)/iu;
const DETAIL_REQUEST =
  /(?:请|帮我|给我|我想(?:听|了解|知道)|我需要|你能|能不能|可以.{0,3}(?:说|讲)|(?:详细|深入|逐步|一步一步|多角度|全面).{0,3}(?:说说|讲讲|分析一下)|^(?:详细|深入|逐步|全面)(?:分析|解释)|\b(?:please|could you|can you|explain|describe|give me|I want|I need)\b)/iu;
const NEGATION =
  /(?:不用|不要|不必|无需|别|不是|并非|不想|没让|没有让|don't|do not|not)\s*(?:只是|仅仅|只|让你|要你|请你|再|to|just|only)?\s*$/iu;
const CORRECTION = /^(?:但|但是|不过|而是|是请|改成|改为|but\b|instead\b)/iu;
const REPORTED_OR_HYPOTHETICAL =
  /^(?:(?:她|他|别人|朋友|同事|你|我(?:以前|之前|当时|刚才)).{0,8}(?:说|让|要求)|(?:如果|假如|假设|要是)|(?:she|he|they|you) (?:said|asked)|if\b)/iu;

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
  const clauses = text
    .replace(
      /(?<!不)(但是|但|不过|而是|改成|改为)|\b(but|instead)\b/giu,
      "，$&",
    )
    .split(/[，,。.!！?？;；\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let listen = false;
  let advice = false;
  let detail = false;
  let deferredHelp = false;
  for (const clause of clauses) {
    if (REPORTED_OR_HYPOTHETICAL.test(clause)) continue;
    if (CORRECTION.test(clause)) {
      listen = false;
      advice = false;
      detail = false;
      deferredHelp = false;
    }
    const requests = [
      ...[...clause.matchAll(LISTEN)].map((match) => ({
        match,
        kind: "listen" as const,
      })),
      ...[...clause.matchAll(NO_ADVICE)].map((match) => ({
        match,
        kind: "no_advice" as const,
      })),
      ...[...clause.matchAll(ADVICE)].map((match) => ({
        match,
        kind: "advice" as const,
      })),
    ].sort(
      (left, right) =>
        left.match.index - right.match.index ||
        right.match[0].length - left.match[0].length,
    );
    let previousEnd = 0;
    let clauseAdvice = false;
    let clauseNoAdvice = false;
    for (const { match, kind } of requests) {
      if (match.index < previousEnd) continue;
      const prefix = clause.slice(previousEnd, match.index);
      const negated =
        NEGATION.test(prefix) ||
        (kind !== "no_advice" &&
          /^(?:请|帮我).{0,2}(?:别|不要|不用)/u.test(match[0]));
      previousEnd = match.index + match[0].length;
      if (negated) continue;
      if (kind === "listen" || kind === "no_advice") {
        listen = true;
        clauseNoAdvice ||= kind === "no_advice";
      } else {
        clauseAdvice = true;
        advice = true;
        deferredHelp ||=
          listen && /(?:再|然后|接着|之后|说完|讲完|then|after)/iu.test(clause);
      }
    }
    const clauseDetail =
      DETAIL.test(clause) &&
      DETAIL_REQUEST.test(clause) &&
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
