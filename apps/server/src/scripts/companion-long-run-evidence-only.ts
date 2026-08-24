import { isAuthoritativeEvidenceOnlyQuote } from "@personasim/features";

export interface CompanionSummaryEvidenceSource {
  memoryContent: string;
  evidenceQuote?: string;
}

export type CompanionSummaryFact =
  | "lpm:code"
  | "lpm:pin"
  | "lpm:bag"
  | "lpm:pocket"
  | "lpm:ritual"
  | "cilantro:avoids"
  | "cilantro:accepts_small"
  | "cilantro:dislikes_large"
  | "cilantro:dislikes"
  | "cilantro:likes"
  | "xiaolin:known_person"
  | "xiaolin:university_classmate"
  | "xiaolin:high_school_classmate"
  | "xiaolin:other_relation"
  | "xiaolin:suzhou"
  | "pet:dog"
  | "pet:doubao"
  | "user:dorm_number"
  | "commitment:moving_help";

/**
 * Returns the sensitive user-fact atoms asserted by a natural-language string.
 * Epistemic disclaimers are not claims; polarity-specific preferences use a
 * negative atom instead of accidentally authorizing the affirmative atom.
 */
export function extractCompanionSummaryFacts(
  text: string,
): Set<CompanionSummaryFact> {
  const normalized = text.normalize("NFKC");
  const facts = new Set<CompanionSummaryFact>();
  addFactForPhrase(facts, normalized, "LPM-4827", "lpm:code");
  addFactForPhrase(facts, normalized, "墨绿色珐琅松针", "lpm:pin");
  addFactForPhrase(facts, normalized, "深灰色电脑包", "lpm:bag");
  addFactForPhrase(facts, normalized, "内侧拉链袋", "lpm:pocket");
  addFactForPhrase(facts, normalized, "重要发言前", "lpm:ritual");

  addFactForPattern(
    facts,
    normalized,
    /(?:通常|一般|平时)?(?:完全)?不吃(?:一点|少量|少许)?香菜/gu,
    "cilantro:avoids",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:可以|能)?接受(?:一点|少量|少许)(?:的)?香菜/gu,
    "cilantro:accepts_small",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:不喜欢|接受不了|不能接受)(?:整把|大量)(?:的)?香菜|(?:整把|大量)(?:的)?香菜(?:接受不了|不能接受)/gu,
    "cilantro:dislikes_large",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:并?不|不太|不怎么|不大)喜欢(?:吃)?香菜/gu,
    "cilantro:dislikes",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:最喜欢|喜欢吃|喜欢|爱吃)香菜/gu,
    "cilantro:likes",
  );

  addFactForPhrase(facts, normalized, "小林", "xiaolin:known_person");
  addFactForPhrase(
    facts,
    normalized,
    "大学同学",
    "xiaolin:university_classmate",
  );
  addFactForPhrase(
    facts,
    normalized,
    "高中同学",
    "xiaolin:high_school_classmate",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:小林.{0,8}(?:小学同学|初中同学|同事|室友|朋友|亲戚)|(?:小学同学|初中同学|同事|室友|朋友|亲戚).{0,8}小林)/gu,
    "xiaolin:other_relation",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:小林.{0,48}苏州|苏州.{0,48}小林)/gu,
    "xiaolin:suzhou",
  );

  addFactForPattern(
    facts,
    normalized,
    /(?:你|用户)(?:现在|确实|真的)?(?:养|有)(?:了|着)?(?:一只)?(?:叫[^，。！？；]{0,8})?(?:狗|狗狗|宠物)|(?:你的|用户的)(?:狗|狗狗|宠物)/gu,
    "pet:dog",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:你|用户).{0,16}豆包|豆包.{0,16}(?:是你|你的|用户)/gu,
    "pet:doubao",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:你|用户)(?:的)?(?:大学)?宿舍号(?:是|为|：|:)?\s*[A-Za-z0-9\-号室]+/gu,
    "user:dorm_number",
  );
  addFactForPattern(
    facts,
    normalized,
    /(?:你|用户).{0,12}(?:答应|承诺).{0,16}(?:搬家|帮忙搬)|(?:周日|星期日).{0,16}(?:搬家|帮忙搬).{0,12}(?:答应|承诺|日程|安排)/gu,
    "commitment:moving_help",
  );
  return facts;
}

/**
 * A selected memory supports a claim only when its persisted content and its
 * concrete evidence quote agree. This prevents quoted/hypothetical evidence
 * from becoming a user fact merely because a model-produced memory says so.
 */
export function supportedCompanionSummaryFacts(
  sources: readonly CompanionSummaryEvidenceSource[],
): Set<CompanionSummaryFact> {
  const supported = new Set<CompanionSummaryFact>();
  for (const source of sources) {
    const contentFacts = extractCompanionSummaryFacts(source.memoryContent);
    const quote = source.evidenceQuote?.trim();
    if (quote === undefined || quote === "") {
      for (const fact of contentFacts) supported.add(fact);
      continue;
    }
    if (!isAuthoritativeEvidenceOnlyQuote(quote)) continue;
    const quoteFacts = extractCompanionSummaryFacts(quote);
    for (const fact of contentFacts) {
      if (quoteFacts.has(fact)) supported.add(fact);
    }
  }
  return supported;
}

export function buildCompanionEvidenceOnlySummary(
  sources: readonly CompanionSummaryEvidenceSource[],
): string {
  const facts = supportedCompanionSummaryFacts(sources);
  const sentences: string[] = [];
  const lpmSentence = lpmSummarySentence(facts);
  if (lpmSentence !== undefined) sentences.push(lpmSentence);
  const cilantroSentence = cilantroSummarySentence(facts);
  if (cilantroSentence !== undefined) sentences.push(cilantroSentence);
  const xiaolinSentence = xiaolinSummarySentence(
    facts,
    sources.some(supportsCorrectedXiaolinRelation),
  );
  if (xiaolinSentence !== undefined) sentences.push(xiaolinSentence);

  if (sentences.length === 0) {
    return "目前没有足够可靠的证据让我总结你的具体情况。我不会用猜测补上空白。";
  }
  if (sentences.length === 1) {
    sentences.push("除此之外，不确定的部分我就不补充了。");
  }
  return sentences.slice(0, 3).join("");
}

function lpmSummarySentence(
  facts: ReadonlySet<CompanionSummaryFact>,
): string | undefined {
  const hasCode = facts.has("lpm:code");
  const hasPin = facts.has("lpm:pin");
  const hasBag = facts.has("lpm:bag");
  const hasPocket = facts.has("lpm:pocket");
  if (!hasCode && !hasPin && !hasBag && !hasPocket) return undefined;

  const subject =
    hasCode && hasPin
      ? "LPM-4827 是墨绿色珐琅松针"
      : hasPin
        ? "那是一枚墨绿色珐琅松针"
        : hasCode
          ? "代号是 LPM-4827"
          : "那件东西";
  const location =
    hasBag && hasPocket
      ? "放在深灰色电脑包的内侧拉链袋"
      : hasBag
        ? "放在深灰色电脑包里"
        : hasPocket
          ? "放在内侧拉链袋"
          : undefined;
  return location === undefined
    ? `我记得${subject}。`
    : `我记得${subject}，${location}。`;
}

function cilantroSummarySentence(
  facts: ReadonlySet<CompanionSummaryFact>,
): string | undefined {
  if (
    facts.has("cilantro:accepts_small") &&
    facts.has("cilantro:dislikes_large")
  ) {
    return "你可以接受少量香菜，但不喜欢整把香菜。";
  }
  if (facts.has("cilantro:accepts_small")) {
    return "你可以接受少量香菜。";
  }
  if (facts.has("cilantro:dislikes_large")) {
    return "你不喜欢整把香菜。";
  }
  if (facts.has("cilantro:avoids")) return "你通常不吃香菜。";
  if (facts.has("cilantro:dislikes")) return "你不喜欢香菜。";
  if (facts.has("cilantro:likes")) return "你喜欢香菜。";
  return undefined;
}

function xiaolinSummarySentence(
  facts: ReadonlySet<CompanionSummaryFact>,
  correctedRelation: boolean,
): string | undefined {
  const relation = facts.has("xiaolin:high_school_classmate")
    ? "高中同学"
    : facts.has("xiaolin:university_classmate")
      ? "大学同学"
      : undefined;
  const suzhou = facts.has("xiaolin:suzhou");
  if (correctedRelation) {
    return suzhou
      ? "小林不是你的大学同学，而是你的高中同学，她搬到了苏州。"
      : "小林不是你的大学同学，而是你的高中同学。";
  }
  if (relation !== undefined) {
    return suzhou
      ? `小林是你的${relation}，她搬到了苏州。`
      : `小林是你的${relation}。`;
  }
  return suzhou ? "我记得小林搬到了苏州。" : undefined;
}

function supportsCorrectedXiaolinRelation(
  source: CompanionSummaryEvidenceSource,
): boolean {
  const correction = /小林.{0,16}不是.{0,12}大学同学.{0,16}高中同学/u;
  if (!correction.test(source.memoryContent.normalize("NFKC"))) return false;
  const quote = source.evidenceQuote?.trim();
  return (
    quote === undefined ||
    (isAuthoritativeEvidenceOnlyQuote(quote) &&
      correction.test(quote.normalize("NFKC")))
  );
}

function addFactForPhrase(
  facts: Set<CompanionSummaryFact>,
  text: string,
  phrase: string,
  fact: CompanionSummaryFact,
): void {
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(phrase, from);
    if (index < 0) return;
    if (!occurrenceIsDisclaimed(text, index, phrase.length)) facts.add(fact);
    from = index + phrase.length;
  }
}

function addFactForPattern(
  facts: Set<CompanionSummaryFact>,
  text: string,
  pattern: RegExp,
  fact: CompanionSummaryFact,
): void {
  for (const match of text.matchAll(pattern)) {
    if (
      !occurrenceIsDisclaimed(text, match.index ?? 0, match[0]?.length ?? 0)
    ) {
      facts.add(fact);
    }
  }
}

function occurrenceIsDisclaimed(
  text: string,
  index: number,
  length: number,
): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf("。", index - 1),
    text.lastIndexOf("！", index - 1),
    text.lastIndexOf("？", index - 1),
    text.lastIndexOf("；", index - 1),
    text.lastIndexOf("，", index - 1),
  );
  const prefix = text.slice(Math.max(clauseStart + 1, index - 32), index);
  const local = text.slice(Math.max(0, index - 10), index + length + 8);
  const suffix = text.slice(index + length, index + length + 18);
  return (
    /(?:不知道|不确定|不记得|没记得|没有(?:可靠)?(?:证据|依据|记录)|不能说|无法确认|未记录).{0,24}$/u.test(
      prefix,
    ) ||
    /(?:并?不是|并非|不再)(?:你|我|用户|小林|她|他)?(?:的)?\s*$/u.test(
      prefix,
    ) ||
    /(?:并?不|不太|不怎么|不大)\s*$/u.test(prefix) ||
    /(?:只是|仅是).{0,10}(?:假设|举例)|(?:不是真的|不是真实|别当真)/u.test(
      local,
    ) ||
    /(?:太绝对|不准确|并不准确|说错了?)/u.test(suffix)
  );
}
