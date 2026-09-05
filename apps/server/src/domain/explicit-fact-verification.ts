import { isExplicitUserMemoryStatement } from "@personasim/features";

import type { Memory } from "@personasim/contracts";

export type BeverageFamily = "tea" | "coffee" | "cocoa" | "juice" | "water";

export type BeverageFacetSelector =
  | { scope: "any" }
  | { scope: "family"; family: BeverageFamily }
  | { scope: "specific"; canonical: string };

export type ExplicitFactFacetDescriptor =
  | {
      kind: "beverage_preference";
      selector: BeverageFacetSelector;
    }
  | {
      kind: "entity_inscription";
      entity: string;
    };

export type ExplicitFactFacet =
  | (Extract<ExplicitFactFacetDescriptor, { kind: "beverage_preference" }> & {
      searchTerms: string[];
    })
  | (Extract<ExplicitFactFacetDescriptor, { kind: "entity_inscription" }> & {
      searchTerms: string[];
    });

export type ExplicitFactVerificationRequest = {
  expectedFacetCount: number;
  facets: ExplicitFactFacet[];
};

export type ExplicitFactVerificationParse =
  | { kind: "none" | "unsupported" }
  | { kind: "invalid"; reason: "requested_fact_request_invalid" }
  | { kind: "valid"; request: ExplicitFactVerificationRequest };

export type ExplicitFactValueResolution =
  | { kind: "none" }
  | { kind: "resolved"; valueKey: string }
  | { kind: "conflicted" };

type ExplicitFactScoredMemory = Pick<Memory, "content" | "tags">;

type CanonicalBeverageFact = {
  canonical: string;
  family: BeverageFamily;
  sweetness: "sweetened" | "unsweetened" | "unspecified";
  temperature: "cold" | "hot" | "warm" | "room" | "unspecified";
};

export function parseExplicitFactVerificationRequest(
  query: string,
): ExplicitFactVerificationParse {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const politeRequest =
    /(?:^|[，,。！？]\s*)(?:(?:请|麻烦)(?:你)?|替我|帮我|你能否|你可以|能不能)\s*(?:替我|帮我)?\s*(?:核对|确认|复述|回忆|回想|告诉我|说出)\s*(?:一下)?\s*(?:这|那|以下|下列)?\s*([一二两三四五六七八九\d]+)\s*(?:件|个|项)\s*(?:旧事|事实|信息|事情)?\s*[:：]\s*(.+)$/u.exec(
      normalized,
    );
  const bareRequest =
    /^(?:核对|确认|复述|回忆|回想|告诉我|说出)\s*(?:一下)?\s*(?:这|那|以下|下列)?\s*([一二两三四五六七八九\d]+)\s*(?:件|个|项)\s*(?:旧事|事实|信息|事情)?\s*[:：]\s*(.+)$/u.exec(
      normalized,
    );
  const request = politeRequest ?? bareRequest;
  if (request === null) return { kind: "none" };
  const prefix = normalized
    .slice(0, request.index)
    .replace(/[，,。！？\s]+$/gu, "");
  if (!isAllowedExplicitFactRequestPrefix(prefix)) {
    return { kind: "none" };
  }

  const expectedFacetCount = explicitFactCount(request[1] ?? "");
  const payload = request[2] ?? "";
  const terminator = /[。！？]/u.exec(payload);
  const checklist = payload
    .slice(0, terminator?.index ?? payload.length)
    .trim();
  const tail =
    terminator === null
      ? ""
      : payload.slice(terminator.index + terminator[0].length).trim();
  const parts = checklist
    .split(
      /(?:、|；|;|[,，]\s*(?:和|与|以及|还有|and|&)\s*|\s+(?:and|&)\s+|(?:以及|还有))/iu,
    )
    .map((part) =>
      part
        .replace(/^(?:和|与|以及|还有)\s*/u, "")
        .replace(/^(?:第?[一二两三123]\s*(?:项|件|个)?\s*[是:：、.]?)\s*/u, "")
        .trim(),
    )
    .filter(Boolean);
  const facets = parts.flatMap((part) => {
    const facet = describeExplicitFactFacet(part);
    return facet === undefined ? [] : [facet];
  });
  const facetKeys = facets.map(explicitFactFacetKey);
  const supported =
    expectedFacetCount >= 2 &&
    expectedFacetCount <= 3 &&
    parts.length === expectedFacetCount &&
    facets.length === expectedFacetCount &&
    new Set(facetKeys).size === expectedFacetCount;
  // This selector is intentionally narrow. A checklist with no supported
  // facets remains on the generic hierarchy, while a malformed or partially
  // supported fact checklist must fail closed rather than silently degrading.
  if (!supported) {
    return facets.length === 0
      ? { kind: "unsupported" }
      : { kind: "invalid", reason: "requested_fact_request_invalid" };
  }
  if (!isAllowedExplicitFactRequestTail(tail)) {
    return { kind: "invalid", reason: "requested_fact_request_invalid" };
  }
  return {
    kind: "valid",
    request: {
      expectedFacetCount,
      facets,
    },
  };
}

function isAllowedExplicitFactRequestPrefix(prefix: string): boolean {
  if (prefix.length === 0) return true;
  const normalized = prefix.normalize("NFKC").trim();
  if (/^(?:现在|接下来|另外|顺便|还有|然后)$/u.test(normalized)) {
    return true;
  }
  // Keep this allowlist deliberately narrow. It admits the scenario's direct
  // temporal setup without treating quoted, reported, or narrated requests as
  // a live instruction.
  return /^(?:今天|今晚|明天|后天|周末|下周)(?:去[\p{L}\p{N}]{1,16})?(?:前|后|时|的时候)?$/u.test(
    normalized,
  );
}

function isAllowedExplicitFactRequestTail(tail: string): boolean {
  if (tail.length === 0) return true;
  const clauses = tail
    .split(/[，,。；;！？!?]/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return (
    clauses.length > 0 &&
    clauses.every((clause) =>
      /^(?:(?:请)?(?:只|仅)(?:答|说|回复).{0,12}(?:事实|答案)|(?:不要|不必|无需|别|不)(?:解释|解读|引申|补充|猜测|发挥).{0,32})$/u.test(
        clause,
      ),
    )
  );
}

function explicitFactCount(value: string): number {
  if (/^\d+$/u.test(value)) return Number.parseInt(value, 10);
  const counts: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  return counts[value] ?? 0;
}

const BEVERAGE_LEXEMES: ReadonlyArray<{
  canonical: string;
  family: BeverageFamily;
  aliases: readonly string[];
}> = [
  {
    canonical: "jasmine_tea",
    family: "tea",
    aliases: ["茉莉花茶", "jasmine tea"],
  },
  {
    canonical: "oolong_tea",
    family: "tea",
    aliases: ["乌龙茶", "oolong tea"],
  },
  {
    canonical: "puer_tea",
    family: "tea",
    aliases: ["普洱茶", "pu-erh tea", "puer tea"],
  },
  {
    canonical: "black_tea",
    family: "tea",
    aliases: ["红茶", "black tea", "red tea"],
  },
  {
    canonical: "green_tea",
    family: "tea",
    aliases: ["绿茶", "green tea"],
  },
  {
    canonical: "white_tea",
    family: "tea",
    aliases: ["白茶", "white tea"],
  },
  {
    canonical: "flower_tea",
    family: "tea",
    aliases: ["花茶", "flower tea"],
  },
  {
    canonical: "milk_tea",
    family: "tea",
    aliases: ["奶茶", "milk tea"],
  },
  { canonical: "tea", family: "tea", aliases: ["茶", "tea"] },
  { canonical: "coffee", family: "coffee", aliases: ["咖啡", "coffee"] },
  { canonical: "cocoa", family: "cocoa", aliases: ["可可", "cocoa"] },
  { canonical: "juice", family: "juice", aliases: ["果汁", "juice"] },
  {
    canonical: "mineral_water",
    family: "water",
    aliases: ["矿泉水", "mineral water"],
  },
  { canonical: "plain_water", family: "water", aliases: ["白水"] },
  { canonical: "water", family: "water", aliases: ["水", "water"] },
];

const ANY_BEVERAGE_ALIASES = ["饮料", "饮品", "drink", "beverage"] as const;

function describeExplicitFactFacet(
  rawFacet: string,
): ExplicitFactFacet | undefined {
  const facet = rawFacet.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const normalized = facet.toLocaleLowerCase();
  const beverage = beverageFacetFromText(normalized);
  if (
    beverage !== undefined &&
    /(?:喝|饮用|点|冲|习惯|偏好|口味|加糖|无糖|甜)|\b(?:drink|take|prefer|habit|preference|sweet)\b/iu.test(
      normalized,
    )
  ) {
    return {
      kind: "beverage_preference",
      selector: beverage.selector,
      searchTerms: beverage.searchTerms,
    };
  }

  const inscription =
    /^(.{1,48}?)(?:的)?(?:标签|标记|题签|编号|铭牌|字样|题字|铭文)$/u.exec(
      facet,
    );
  const entity = normalizeFactEntity(inscription?.[1] ?? "");
  if (entity.length < 2 || entity.length > 32) return undefined;
  return {
    kind: "entity_inscription",
    entity,
    searchTerms: [entity],
  };
}

function beverageFacetFromText(
  text: string,
): { selector: BeverageFacetSelector; searchTerms: string[] } | undefined {
  const anyAlias = ANY_BEVERAGE_ALIASES.find((alias) =>
    factTextContainsAnchor(text, alias),
  );
  const matches = BEVERAGE_LEXEMES.flatMap((lexeme) =>
    lexeme.aliases
      .filter((alias) => factTextContainsAnchor(text, alias))
      .map((alias) => ({ lexeme, alias })),
  ).sort(
    (left, right) =>
      normalizeBeverageToken(right.alias).length -
        normalizeBeverageToken(left.alias).length ||
      left.lexeme.canonical.localeCompare(right.lexeme.canonical),
  );
  const best = matches[0];
  if (best !== undefined) {
    const selector: BeverageFacetSelector =
      best.lexeme.canonical === best.lexeme.family
        ? { scope: "family", family: best.lexeme.family }
        : { scope: "specific", canonical: best.lexeme.canonical };
    return {
      selector,
      searchTerms: best.lexeme.aliases.flatMap((alias) => [
        alias,
        normalizeBeverageToken(alias),
      ]),
    };
  }
  return anyAlias === undefined
    ? undefined
    : {
        selector: { scope: "any" },
        searchTerms: [
          ...new Set([
            ...ANY_BEVERAGE_ALIASES,
            ...BEVERAGE_LEXEMES.flatMap((lexeme) =>
              lexeme.aliases.flatMap((alias) => [
                alias,
                normalizeBeverageToken(alias),
              ]),
            ),
          ]),
        ],
      };
}

function normalizeFactEntity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/^(?:我(?:的)?|用户(?:的)?)/u, "")
    .replace(/^(?:那|这)(?:一)?(?:只|个|件|本|份|把|枚|张)?/u, "")
    .replace(/[的:：,，。.!！?？]+$/gu, "")
    .trim()
    .toLocaleLowerCase();
}

function explicitFactFacetKey(facet: ExplicitFactFacet): string {
  return facet.kind === "beverage_preference"
    ? `${facet.kind}:${beverageSelectorKey(facet.selector)}`
    : `${facet.kind}:${facet.entity}`;
}

function beverageSelectorKey(selector: BeverageFacetSelector): string {
  if (selector.scope === "any") return "any";
  return selector.scope === "family"
    ? `family:${selector.family}`
    : `specific:${selector.canonical}`;
}

export function isGroundedEvidenceExcerpt(
  source: string,
  quote: string,
): boolean {
  const normalizeExcerpt = (value: string): string =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  const normalizedQuote = normalizeExcerpt(quote);
  return (
    normalizedQuote.length > 0 &&
    normalizeExcerpt(source).includes(normalizedQuote)
  );
}

export function isFactBearingUserStatement(text: string): boolean {
  const request = parseExplicitFactVerificationRequest(text);
  const normalized = text.normalize("NFKC");
  return (
    isExplicitUserMemoryStatement(text) &&
    request.kind === "none" &&
    assertiveFactText(normalized) !== undefined &&
    !/(?:你还记得|是否记得|记不记得|是错的|说错了|不对)|\b(?:was wrong|is wrong)\b/iu.test(
      normalized,
    )
  );
}

function assertiveFactText(text: string): string | undefined {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const controlText = maskFactQuotedContent(normalized);
  const correctionPivots = [
    ...controlText.matchAll(
      /(?:^|[，,。；;！？!?]\s*)(?:更正(?:一下)?|纠正|修正|更新一下)\s*[:：]\s*/gu,
    ),
  ];
  const lastCorrection = correctionPivots.at(-1);
  const activeText =
    lastCorrection === undefined
      ? normalized
      : normalized.slice(
          (lastCorrection.index ?? 0) + lastCorrection[0].length,
        );
  if (containsQuotedFactProposition(activeText)) return undefined;
  if (hasReportedFactScope(activeText)) return undefined;
  if (
    /(?:原文|引文|引用(?:内容)?|摘录|资料(?:里|中)?|转述|例句|例子|示例|举例|比如|例如|譬如|模板|测试文本|虚构|杜撰|假话|反事实|演示|设想|想象|假设|假如|否认|否定|没有说过|没说过|不承认|别信|不要相信|不是真的|并不是真的|不属实|不是事实|并非(?:事实|实际|真实)|不代表事实|尚未确认|还没确认|未确认|不确定|可能|也许|或许)|\b(?:quote|quotation|quoted text|excerpt|source material|example|hypothetical|counterfactual|fictional|sample text|suppose|assuming|deny|denied|disavow|not true|not a fact|do not believe|unconfirmed|uncertain|maybe|perhaps)\b/iu.test(
      activeText,
    )
  ) {
    return undefined;
  }
  const sentences = activeText
    .split(/[。；;！？!?\n]/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const assertiveSentences: string[] = [];
  for (const sentence of sentences) {
    const clauses: string[] = [];
    for (const clause of sentence
      .split(/[，,]/u)
      .map((clause) => clause.trim())
      .filter(Boolean)) {
      if (/^(?:[“"'「『]).*(?:[”"'」』])$/u.test(clause)) {
        return undefined;
      }
      if (/(?:如果|倘若)|\bif\b/iu.test(clause)) {
        if (
          /(?:我|用户).{0,40}(?:喝|饮用|喜欢|偏好|标签|标记|题签|编号|铭牌|字样|题字|铭文)/u.test(
            clause,
          )
        ) {
          return undefined;
        }
        continue;
      }
      clauses.push(clause);
    }
    if (clauses.length > 0) assertiveSentences.push(clauses.join("，"));
  }
  return assertiveSentences.length === 0
    ? undefined
    : assertiveSentences.join("。");
}

function hasReportedFactScope(text: string): boolean {
  return text
    .split(/[。；;！？!?\n]/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .some((sentence) => {
      const colonIndex = sentence.search(/[:：]/u);
      if (colonIndex < 0) return false;
      const discourseLead = sentence.slice(0, colonIndex).trim();
      return (
        /(?:^|\s)(?:有人|他|她|他们|她们|别人|对方|[^，,。:：]{1,16})(?:说|说道|写道|提到|表示|声称|认为|宣称|转述)$/u.test(
          discourseLead,
        ) ||
        /(?:资料|文档|档案|报道|原文|引文|引用|摘录|记录)(?:里|中)?(?:写着|记载|显示|提到)?$/u.test(
          discourseLead,
        )
      );
    });
}

function containsQuotedFactProposition(text: string): boolean {
  const quotedSegments = [
    /“([^”]{1,2000})”/gu,
    /‘([^’]{1,2000})’/gu,
    /「([^」]{1,2000})」/gu,
    /『([^』]{1,2000})』/gu,
    /"([^"]{1,2000})"/gu,
    /'([^']{1,2000})'/gu,
  ].flatMap((pattern) =>
    [...text.matchAll(pattern)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    ),
  );
  return quotedSegments.some(
    (segment) =>
      /(?:我|用户).{0,40}(?:喝|饮用|喜欢|偏好)/u.test(segment) ||
      /(?:标签|标记|题签|编号|铭牌|字样|题字|铭文).{0,16}(?:是|为|写着|写有|印着|刻着|标着|[:：])/u.test(
        segment,
      ),
  );
}

function maskFactQuotedContent(text: string): string {
  return [
    /“[^”]*”/gu,
    /‘[^’]*’/gu,
    /「[^」]*」/gu,
    /『[^』]*』/gu,
    /"[^"]*"/gu,
    /'[^']*'/gu,
  ].reduce(
    (masked, pattern) =>
      masked.replace(pattern, (quoted) => " ".repeat(quoted.length)),
    text,
  );
}

const FACT_UNCERTAINTY =
  /(?:不知道|不清楚|不确定|尚未确认|没有确认|未确认|还没定|尚未定|未定|忘了|记不清|可能|也许|或许|好像|是什么|写着什么|哪一种|哪一个|是否有|有没有)|\b(?:unknown|uncertain|unconfirmed|maybe|perhaps|what|which)\b/iu;
const OWNED_INSCRIPTION_PREFIX =
  /^\s*(?:(?:的)?(?:标签|标记|题签|编号|铭牌|字样|题字|铭文)\s*(?:仍然|还是)?\s*(?:是|为|写着|写有|印着|刻着|标着|[:：])|(?:的)?(?:(?:盒盖|盖子|封面|表面|外壳|背面|正面|侧面|边缘)(?:上|里|处)?|上|里)\s*(?:仍然|还是)?\s*(?:写着|写有|印着|刻着|标着))\s*[:：]?\s*(.*)$/u;

export function explicitFactValueResolution(
  text: string,
  facet: ExplicitFactFacetDescriptor,
): ExplicitFactValueResolution {
  const assertiveText = assertiveFactText(text);
  if (assertiveText === undefined) return { kind: "none" };
  const valueKeys =
    facet.kind === "beverage_preference"
      ? beverageFactValueKeys(assertiveText, facet)
      : inscriptionFactValueKeys(assertiveText, facet);
  return valueKeys.length === 0
    ? { kind: "none" }
    : valueKeys.length === 1
      ? { kind: "resolved", valueKey: valueKeys[0]! }
      : { kind: "conflicted" };
}

export function explicitFactCandidateScore(
  memory: ExplicitFactScoredMemory,
  facet: ExplicitFactFacetDescriptor,
): number {
  const tags = new Set(
    memory.tags.map((tag) =>
      tag
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ""),
    ),
  );
  const metadataText = [memory.content, ...memory.tags].join(" ");
  const metaInstruction =
    /(?:只是事实|事实记录|不要解读|不作解释|不解释|人格|象征|引申|记录方式)|\b(?:boundary|meta|symbolism|interpretation)\b/iu.test(
      metadataText,
    );
  let score = metaInstruction ? 8 : 12;
  if (facet.kind === "beverage_preference") {
    if (
      [...tags].some((tag) =>
        /^(?:饮品|饮料|usualdrink|beverage|drinkpreference)$/iu.test(tag),
      )
    ) {
      score += 4;
    }
    if (
      [...tags].some((tag) =>
        /^(?:偏好|用户偏好|userpreference|preference)$/iu.test(tag),
      )
    ) {
      score += 2;
    }
  } else {
    if (normalizedFactText(memory.content).includes(facet.entity)) score += 4;
    if (
      [...tags].some((tag) =>
        /^(?:标签|标记|题签|编号|铭牌|字样|题字|铭文|label|inscription)$/iu.test(
          tag,
        ),
      )
    ) {
      score += 2;
    }
  }
  return score;
}

function beverageFactValueKeys(
  text: string,
  facet: Extract<ExplicitFactFacetDescriptor, { kind: "beverage_preference" }>,
): string[] {
  const values = new Set<string>();
  for (const rawClause of text.normalize("NFKC").split(/[，,。；;！？!?\n]/u)) {
    const clause = rawClause.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
    if (clause.length === 0 || FACT_UNCERTAINTY.test(clause)) continue;
    const assertion = parseUserBeverageAssertion(clause);
    if (assertion === undefined || hasBeverageValueChoice(assertion.rawValue)) {
      continue;
    }
    const value = canonicalBeverageFactValue(assertion.rawValue);
    if (value === undefined || !beverageMatchesFacet(value, facet.selector)) {
      continue;
    }
    const polarity = /^(?:不|讨厌)|^(?:do\s+not|don't|dislike)/iu.test(
      assertion.predicate,
    )
      ? "negative"
      : "affirmed";
    values.add(
      `${polarity}:${value.canonical}:${value.temperature}:${value.sweetness}`,
    );
  }
  return [...values].sort();
}

function parseUserBeverageAssertion(
  clause: string,
): { predicate: string; rawValue: string } | undefined {
  const chinese =
    /^(?:(?:至于|说到)(?:饮品|饮料|喝的)?\s*[:：]?\s*)?(?:我|用户)(?:自己)?(?:通常|一般|平时|一直|仍然|还是|只是|只)?\s*(习惯喝|不饮用|不喜欢|不喝|不爱|讨厌|饮用|喜欢|偏好|喝|点|冲)\s*([^，,。；;！？!?]{1,48})$/u.exec(
      clause,
    );
  if (chinese?.[1] !== undefined && chinese[2] !== undefined) {
    return { predicate: chinese[1], rawValue: chinese[2] };
  }
  const english =
    /^(?:(?:as\s+for|regarding)\s+(?:drinks?|beverages?)\s*[:,]?\s*)?(?:i|the\s+user)(?:\s+(?:usually|normally|still|only))*\s+(do\s+not\s+drink|don't\s+drink|dislike|drink|take|prefer)\s+([^,.;!?]{1,48})$/iu.exec(
      clause,
    );
  return english?.[1] === undefined || english[2] === undefined
    ? undefined
    : { predicate: english[1].toLocaleLowerCase(), rawValue: english[2] };
}

function hasBeverageValueChoice(value: string): boolean {
  const choice = /^(.*?)(?:还是|或(?:者|是)?|\bor\b)(.*)$/iu.exec(value);
  if (choice?.[1] === undefined || choice[2] === undefined) return false;
  return (
    canonicalBeverageFactValue(choice[1]) !== undefined &&
    canonicalBeverageFactValue(choice[2]) !== undefined
  );
}

function canonicalBeverageFactValue(
  value: string,
): CanonicalBeverageFact | undefined {
  const normalized = value
    .normalize("NFKC")
    .replace(/^(?:只|通常|一般|平时|会|要)\s*/u, "")
    .replace(
      /(?:这个事实|这件事|只是事实|只作记录|不作解释|不要解读|不解释).*$/u,
      "",
    )
    .replace(/^[“"'「『]+|[”"'」』。.!！]+$/gu, "")
    .trim()
    .toLocaleLowerCase();
  const unsweetened = /(?:不加糖|无糖|不放糖|别加糖|不要糖|不甜)/u.test(
    normalized,
  );
  const sweetened =
    !unsweetened && /(?:加糖|有糖|放糖|偏甜|甜的?)/u.test(normalized);
  const sweetness = unsweetened
    ? "unsweetened"
    : sweetened
      ? "sweetened"
      : "unspecified";
  const withoutSweetness = normalized
    .replace(/(?:不加糖|无糖|不放糖|别加糖|不要糖|不甜)/gu, "")
    .replace(/(?:加糖|有糖|放糖|偏甜|甜的?)/gu, "")
    .replace(/的/gu, "")
    .replace(/^[“"'「『]+|[”"'」』。.!！]+$/gu, "")
    .trim();
  const temperatureMatch =
    /^(常温|冰|冷|热|温|iced\s+|cold\s+|hot\s+|warm\s+)(.+)$/iu.exec(
      withoutSweetness,
    );
  const temperature = beverageTemperature(temperatureMatch?.[1]);
  const beverageToken = normalizeBeverageToken(
    temperatureMatch?.[2] ?? withoutSweetness,
  );
  const lexeme = BEVERAGE_LEXEMES.find((item) =>
    item.aliases.some(
      (alias) => normalizeBeverageToken(alias) === beverageToken,
    ),
  );
  return lexeme === undefined
    ? undefined
    : {
        canonical: lexeme.canonical,
        family: lexeme.family,
        sweetness,
        temperature,
      };
}

function beverageTemperature(
  value: string | undefined,
): CanonicalBeverageFact["temperature"] {
  const normalized = value?.trim().toLocaleLowerCase();
  if (
    normalized === "冰" ||
    normalized === "冷" ||
    normalized === "iced" ||
    normalized === "cold"
  ) {
    return "cold";
  }
  if (normalized === "热" || normalized === "hot") return "hot";
  if (normalized === "温" || normalized === "warm") return "warm";
  if (normalized === "常温") return "room";
  return "unspecified";
}

function normalizeBeverageToken(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase();
}

function factTextContainsAnchor(text: string, anchor: string): boolean {
  if (!/^[a-z0-9 ]+$/iu.test(anchor)) return text.includes(anchor);
  return new RegExp(`\\b${escapeRegularExpression(anchor)}\\b`, "iu").test(
    text,
  );
}

function beverageMatchesFacet(
  beverage: CanonicalBeverageFact,
  selector: BeverageFacetSelector,
): boolean {
  if (selector.scope === "any") return true;
  return selector.scope === "family"
    ? beverage.family === selector.family
    : beverage.canonical === selector.canonical;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function inscriptionFactValueKeys(
  text: string,
  facet: Extract<ExplicitFactFacetDescriptor, { kind: "entity_inscription" }>,
): string[] {
  const values = new Set<string>();
  const sentences = text
    .normalize("NFKC")
    .split(/[。；;！？!?\n]/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    const clauses = sentence
      .split(/[，,]/u)
      .map((clause) => clause.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    for (let index = 0; index < clauses.length; index += 1) {
      const clause = clauses[index];
      if (
        clause === undefined ||
        !normalizedFactText(clause).includes(facet.entity)
      ) {
        continue;
      }
      const normalizedClause = normalizedFactText(clause);
      const entityIndex = normalizedClause.indexOf(facet.entity);
      if (
        hasNonUserEntityOwner(
          normalizedClause.slice(0, Math.max(0, entityIndex)),
        ) ||
        !hasUserEntityScope(
          sentence,
          normalizedClause,
          Math.max(0, entityIndex),
        )
      ) {
        continue;
      }
      const direct = inscriptionValueFromOwnedTail(
        normalizedClause.slice(entityIndex + facet.entity.length),
      );
      if (direct !== undefined) values.add(direct);

      const nextClause = clauses[index + 1];
      if (nextClause !== undefined && !FACT_UNCERTAINTY.test(nextClause)) {
        const adjacent = inscriptionValueFromOwnedTail(nextClause);
        if (adjacent !== undefined) values.add(adjacent);
      }
    }
  }
  return [...values]
    .sort()
    .map((value) => `entity_inscription:${facet.entity}:${value}`);
}

function hasUserEntityScope(
  sentence: string,
  normalizedClause: string,
  entityIndex: number,
): boolean {
  const clausePrefix = normalizedClause.slice(0, entityIndex);
  if (/(?:我|用户|本人)(?:自己)?(?:的|那只|这只)?/u.test(clausePrefix)) {
    return true;
  }
  const normalizedSentence = normalizedFactText(sentence);
  const sentenceEntityIndex = normalizedSentence.indexOf(
    normalizedClause.slice(entityIndex),
  );
  const precedingSentence = normalizedSentence.slice(
    0,
    sentenceEntityIndex < 0 ? normalizedSentence.length : sentenceEntityIndex,
  );
  return /(?:我|用户|本人)/u.test(precedingSentence);
}

function inscriptionValueFromOwnedTail(tail: string): string | undefined {
  if (FACT_UNCERTAINTY.test(tail)) return undefined;
  const payload = OWNED_INSCRIPTION_PREFIX.exec(tail)?.[1]?.trim();
  if (payload === undefined || payload.length === 0) return undefined;
  const parsed = parseInscriptionPayload(payload);
  if (parsed === undefined || parsed.remainder.length > 0) {
    return undefined;
  }
  const rawValue = parsed.value;
  const value = rawValue
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(/\s*([/|_:：-])\s*/gu, "$1")
    .replace(/^[“"'「『\s]+|[”"'」』\s]+$/gu, "")
    .trim()
    .toLocaleLowerCase();
  return value.length === 0 || FACT_UNCERTAINTY.test(value) ? undefined : value;
}

function parseInscriptionPayload(
  payload: string,
): { value: string; remainder: string; quoted: boolean } | undefined {
  const pairs: Record<string, string> = {
    "“": "”",
    '"': '"',
    "'": "'",
    "「": "」",
    "『": "』",
  };
  const opening = payload[0];
  const closing = opening === undefined ? undefined : pairs[opening];
  if (closing !== undefined) {
    const end = payload.indexOf(closing, 1);
    if (end < 1) return undefined;
    return {
      value: payload.slice(1, end),
      remainder: payload.slice(end + 1).trim(),
      quoted: true,
    };
  }
  const choice = /(?:还是|或(?:者|是)?|\bor\b)/iu.exec(payload);
  const end = choice?.index ?? payload.length;
  return {
    value: payload.slice(0, end).trim(),
    remainder: payload.slice(end).trim(),
    quoted: false,
  };
}

function hasNonUserEntityOwner(prefix: string): boolean {
  if (
    /(?:朋友|同事|室友|家人|父亲|母亲|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|他|她|他们|她们|别人|对方)(?:自己)?(?:的|那只|这只)?[^。；;！？!?]{0,12}$/u.test(
      prefix,
    )
  ) {
    return true;
  }
  const possessive = /(?:^|[:：，,。])([^:：，,。]{1,16})的[^的]{0,12}$/u.exec(
    prefix,
  );
  if (possessive?.[1] === undefined) return false;
  const owner = possessive[1].trim();
  return !/^(?:我|用户|我自己|用户自己|本人)$/u.test(owner);
}

export function normalizedFactText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}
