/**
 * Independent rule probes for commit db446b8fdeb00b4189a44a72d509336d86405e8c.
 * This is NOT the repository test suite and does NOT call a provider or SQLite.
 * conversation-requests.ts is transcribed with TS annotations removed.
 * The persona guard probe follows the retrieved guardPersonaReply body.
 * The classification probe uses the intent branch from conversation-context-plan.ts;
 * it does not emulate retrieval, schemas, context projection, or model output.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const LISTEN =
  /(?:先(?:听我说|让我(?:说|讲)完)|听我说就好|只想(?:说说|吐槽|倾诉)|just listen)/giu;
const ADVICE =
  /(?:请.{0,6}(?:建议|帮我|分析)|给我.{0,6}(?:建议|办法|方案)|帮我.{0,6}(?:分析|想想|解决|决定|选)|我(?:该|应该)怎么(?:办|做)|有什么(?:建议|办法)|你建议|what should I do|(?:give me|I (?:want|need)) (?:some )?(?:advice|help)|help me (?:decide|solve|plan|understand)|(?:直接|再|然后|接着)(?:详细|深入|具体)?(?:分析|给建议))/giu;
const NO_ADVICE =
  /(?:不(?:用|要|必|急着).{0,5}(?:建议|分析|解决)|别.{0,4}(?:建议|分析|追问)|(?:don't|do not|no) (?:give (?:me )?)?(?:advice|analy[sz]e))/giu;
const DETAIL =
  /(?:详细|深入|逐步|一步一步|多角度|全面|完整方案|深度分析|in detail|step[- ]by[- ]step|thorough|comprehensive)/iu;
const DETAIL_REQUEST =
  /(?:请|帮我|给我|我想(?:听|了解|知道)|我需要|你能|能不能|可以.{0,3}(?:说|讲)|(?:详细|深入|逐步|一步一步|多角度|全面).{0,3}(?:说说|讲讲|分析一下)|^(?:详细|深入|逐步|全面)(?:分析|解释)|\b(?:please|could you|can you|explain|describe|give me|I want|I need)\b)/iu;
const NEGATION =
  /(?:不用|不要|不必|不需要|没必要|无需|无须|别|不是|并非|不想|没让|没有让|don't|do not|not)\s*(?:只是|仅仅|只|让你|要你|请你|再|to|just|only)?\s*$/iu;
const CORRECTION =
  /^(?:但|但是|不过|而是|是请|改成|改为|还是先|不$|算了$|but\b|instead\b|no$)/iu;
const REPORTED_OR_HYPOTHETICAL =
  /^(?:(?:她|他|别人|朋友|同事|你|我(?:以前|之前|当时|刚才)).{0,8}(?:说|让|要求)|(?:如果|假如|假设|要是)|(?:she|he|they|you) (?:said|asked)|if\b)/iu;
function withoutQuotedConversationText(text) {
  return text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<!\p{L})'[^'\n]*'(?!\p{L})|`[^`]*`/gu,
    " ",
  );
}
function deriveCurrentConversationRequests(originalQuery) {
  const text = withoutQuotedConversationText(originalQuery);
  const clauses = text
    .replace(
      /(?<!不)(但是|但|不过|而是|改成|改为)|\b(but|instead)\b/giu,
      "，$&",
    )
    .split(/[，,。.!！?？;；\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let listen = false,
    advice = false,
    detail = false,
    deferredHelp = false;
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
        kind: "listen",
      })),
      ...[...clause.matchAll(NO_ADVICE)].map((match) => ({
        match,
        kind: "no_advice",
      })),
      ...[...clause.matchAll(ADVICE)].map((match) => ({
        match,
        kind: "advice",
      })),
    ].sort(
      (left, right) =>
        left.match.index - right.match.index ||
        right.match[0].length - left.match[0].length,
    );
    let previousEnd = 0,
      clauseAdvice = false,
      clauseNoAdvice = false;
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
    conflicting,
    supportStyle: conflicting
      ? "respond_naturally"
      : deferredHelp
        ? "listen_then_help"
        : help
          ? "offer_requested_help"
          : listen
            ? "listen"
            : "respond_naturally",
    helpTiming: deferredHelp
      ? "after_user_finishes"
      : conflicting
        ? "unspecified"
        : "now",
  };
}
// Exact VENTING and intent branches, intentionally without other planner outputs.
const VENTING =
  /(?:为什么|为何).{0,14}(?:我总|我又|我老|搞砸|倒霉|这么难|不顺)|(?:难过|委屈|烦死|好烦|挫败|好累|想哭|沮丧|好崩溃)|why (?:do I always|am I always|does (?:this|everything) always)|(?:so frustrated|feel awful|feel terrible)/iu;
const RECOLLECTION =
  /(?:还记得|记不记得|回顾|回想|以前.{0,8}(?:说过|聊过)|之前.{0,8}(?:说过|聊过)|这些年|一路走来|do you remember|look back|reminisce)/iu;
function classify(originalQuery) {
  const requests = deriveCurrentConversationRequests(originalQuery);
  const { listen, adviceRequested, detailedAnalysisRequested } = requests;
  const recollection = RECOLLECTION.test(originalQuery),
    venting = VENTING.test(originalQuery);
  const intent = requests.conflicting
    ? "uncertain"
    : adviceRequested || detailedAnalysisRequested
      ? "help"
      : recollection
        ? "recollection"
        : listen || venting
          ? "venting"
          : /(?:对不起|我们.{0,5}(?:误会|吵架)|sorry (?:about|for))/iu.test(
                originalQuery,
              )
            ? "relationship_repair"
            : /(?:今天|刚才|分享|发生了|today|just happened)/iu.test(
                  originalQuery,
                )
              ? "sharing"
              : "casual";
  return {
    ...requests,
    intent,
    supportStyle:
      requests.supportStyle === "respond_naturally" &&
      venting &&
      !requests.conflicting
        ? "listen"
        : requests.supportStyle,
  };
}
const AI_META_PATTERNS = [
  /作为(?:一个)?(?:AI|人工智能|语言模型)/iu,
  /as an? (?:ai|language model)/iu,
  /my system prompt/iu,
  /我的系统提示(?:词)?/u,
];
const SCHEDULE_CLAIM =
  /(?:已经|已|刚刚).{0,8}(?:修改|取消|移动|改了|安排).{0,10}(?:日程|计划)|(?:i(?:'ve| have)) (?:rescheduled|cancelled|added it to my schedule)/iu;
function includesPhrase(text, phrase) {
  return (
    phrase.trim() !== "" &&
    text.toLocaleLowerCase().includes(phrase.trim().toLocaleLowerCase())
  );
}
function guardPersonaReply(input) {
  const text = input.text.trim();
  const violations = [];
  if (text === "")
    violations.push({
      code: "EMPTY_REPLY",
      severity: "error",
      detail: "Reply cannot be empty",
    });
  if (AI_META_PATTERNS.some((p) => p.test(text)))
    violations.push({
      code: "AI_META_DISCLOSURE",
      severity: "error",
      detail: "Reply breaks character with generic assistant meta-language",
    });
  for (const phrase of input.forbiddenMetaKnowledge ?? [])
    if (includesPhrase(text, phrase))
      violations.push({
        code: "FORBIDDEN_KNOWLEDGE",
        severity: "error",
        detail: `Reply includes forbidden meta-knowledge: ${phrase.slice(0, 80)}`,
      });
  for (const phrase of input.avoidedPhrases ?? [])
    if (includesPhrase(text, phrase))
      violations.push({
        code: "AVOIDED_PHRASE",
        severity: "warning",
        detail: `Reply uses an avoided phrase: ${phrase.slice(0, 80)}`,
      });
  if (
    SCHEDULE_CLAIM.test(text) &&
    (input.acceptedScheduleEffects?.length ?? 0) === 0
  )
    violations.push({
      code: "UNCOMMITTED_SCHEDULE_CLAIM",
      severity: "error",
      detail: "Reply claims a schedule mutation without a validated effect",
    });
  if ((input.reasonSummary?.length ?? 0) > 240)
    violations.push({
      code: "REASON_SUMMARY_TOO_LONG",
      severity: "error",
      detail: "reasonSummary exceeds 240 characters",
    });
  return {
    allowed: violations.every((v) => v.severity !== "error"),
    violations,
    text,
  };
}
const tests = [
  {
    id: "T06",
    text: "工作倒没有出大事，就是改了一天东西，回家以后脑子还是停不下来。",
    expected: ["casual", false, "respond_naturally"],
  },
  {
    id: "T08",
    text: "我现在想具体想一想了，请帮我分析一下：怎样区分真正做错了，和只是被反复修改弄得烦。",
    expected: ["help", true, "offer_requested_help"],
  },
  {
    id: "T15",
    text: "不用先听我说，直接给我建议：我该怎样跟同事确认修改范围？",
    expected: ["help", true, "offer_requested_help"],
  },
  {
    id: "T16",
    text: "不是让你先听我说，是请你帮我分析：哪些要求值得当场问清楚？",
    expected: ["help", true, "offer_requested_help"],
  },
];
const results = tests.map((test) => {
  const actual = classify(test.text);
  assert.deepEqual(
    [actual.intent, actual.adviceRequested, actual.supportStyle],
    test.expected,
  );
  return { id: test.id, input: test.text, observed: actual };
});
const t14 =
  "嗯，明白了，是他对别人说的，跟你没关系。\n那这话就听一耳朵就行，不用往自己身上接。\n他是嫌被追问，不是冲你，更不是要你也别问。\n你之前一直记得先听我说不急着给建议，那份是你主动给的，跟这事是两码事。";
const guardResult = guardPersonaReply({ text: t14 });
assert.equal(guardResult.allowed, true);
assert.deepEqual(guardResult.violations, []);
results.push({ id: "T14_persona_guard", observed: guardResult });
const output = {
  commit: "db446b8fdeb00b4189a44a72d509336d86405e8c",
  scope:
    "Independent transcription of pure rule branches; not a repository integration run.",
  limitations: [
    "No production CharacterSpec was supplied to the standalone guard.",
    "No original model-io.jsonl or final.sqlite was inspected.",
    "No provider, SQLite, Zod, retrieval or full turn pipeline executed.",
    "PASS means the observations match the current implementation, not that product behavior is acceptable.",
  ],
  observations: results,
};
writeFileSync(
  new URL("./rule_probe_results.json", import.meta.url),
  JSON.stringify(output, null, 2) + "\n",
);
console.log(JSON.stringify(output, null, 2));
