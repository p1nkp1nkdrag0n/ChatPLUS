import { normalizeText } from "./shared.js";

export type ExplicitUserMemoryClaimCategory = "user_fact" | "user_preference";

export interface DerivedExplicitUserMemoryClaim {
  subjectKey: string;
  disposition: "affirmed" | "negated";
}

const CORRECTION_PREFIX =
  /^(?:(?:更正|纠正|修正|更新(?:一下)?|改(?:正|一下)|补充更正)|(?:我|前面|刚才|之前)?(?:刚才|之前|前面)?说错了|correction|update|i\s+(?:was|got\s+that)\s+wrong)\s*[:：,，。.!！-]?\s*/iu;
const EXPLICIT_REPLACEMENT =
  /(?:不是|并非).{1,120}?(?:而是|应该是)|\bnot\b.{1,120}?\bbut\b/iu;
const QUESTION_OR_NON_ASSERTION =
  /[?？]\s*$|(?:是不是|是否)|(?:吗|呢)\s*$|^(?:我|我们)?(?:如果|假如|假设|假定|要是|比如|例如|譬如|举例|想象一下|听说|有人说|据说)|^(?:if\b|suppose\b|for\s+example\b)/iu;
const QUOTED_OR_DISCLAIMED =
  /^(?!(?:我|前面|刚才|之前)?(?:刚才|之前|前面)?说错了)[^，,。.!！？:：]{1,20}(?:说|表示|认为|声称)[，,:：]?|^(?:he\s+said|she\s+said|they\s+said)\b|(?:别|不要).{0,20}(?:记住|记录|当成|当作).{0,20}(?:我的|用户的)?(?:事实|偏好|记忆)|(?:这|那)(?:不|并不)是我的(?:事实|偏好)/iu;
const UNCERTAIN_ASSERTION =
  /(?:可能|也许|或许|大概|似乎|好像|不确定|未确认|没有确认)|\b(?:maybe|perhaps|probably|uncertain|unconfirmed)\b/iu;

/**
 * Returns true only for an explicit correction in verified user-authored text.
 * The model-facing memory proposal cannot set this durable lifecycle signal.
 */
export function hasExplicitMemoryCorrection(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  if (!isExplicitUserMemoryStatement(normalized)) return false;
  return (
    CORRECTION_PREFIX.test(normalized) || EXPLICIT_REPLACEMENT.test(normalized)
  );
}

export function isExplicitUserMemoryStatement(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  return (
    normalized.length >= 3 &&
    !QUESTION_OR_NON_ASSERTION.test(normalized) &&
    !QUOTED_OR_DISCLAIMED.test(normalized)
  );
}

/**
 * Conservatively derives a stable fact slot from verified user evidence. It
 * intentionally supports only unambiguous, common forms; unsupported language
 * remains an ordinary memory without claim reconciliation semantics.
 */
export function deriveExplicitUserMemoryClaim(input: {
  category: ExplicitUserMemoryClaimCategory;
  evidenceText: string;
  candidateContent?: string;
}): DerivedExplicitUserMemoryClaim | undefined {
  const evidence = stripTerminalPunctuation(
    stripMemoryInstructionPrefix(stripCorrectionPrefix(input.evidenceText)),
  );
  if (
    !isExplicitUserMemoryStatement(evidence) ||
    UNCERTAIN_ASSERTION.test(evidence) ||
    (/(?:不是|并非)/u.test(evidence) && !EXPLICIT_REPLACEMENT.test(evidence))
  ) {
    return undefined;
  }
  const parsers =
    input.category === "user_fact" ? FACT_PARSERS : PREFERENCE_PARSERS;
  const evidenceClaims = parseClaims(evidence, parsers);

  const candidate = stripTerminalPunctuation(
    input.candidateContent?.normalize("NFKC").trim() ?? "",
  );
  if (candidate.length > 0 && isExplicitUserMemoryStatement(candidate)) {
    const candidateClaims = parseClaims(candidate, parsers);
    if (candidateClaims.length > 0) {
      return candidateClaims.find((candidateClaim) =>
        evidenceClaims.some(
          (evidenceClaim) =>
            evidenceClaim.subjectKey === candidateClaim.subjectKey &&
            evidenceClaim.disposition === candidateClaim.disposition,
        ),
      );
    }
  }
  return evidenceClaims[0];
}

type ClaimParser = (text: string) => DerivedExplicitUserMemoryClaim | undefined;

const FACT_PARSERS: readonly ClaimParser[] = [
  (text) => {
    const implicitCorrection = text.match(
      /^([^，。！？,:：;；]{1,40}?)(?:其实|实际上|实际)?是(?:我|用户)?(?:的)?[^，。！？;；]*(?:同学|朋友|同事|亲戚|表姐|表哥|堂姐|堂哥|室友)[^，。！？;；]*(?:[;；].*)?$/u,
    );
    const replacement = text.match(
      /^([^，。！？,:：;；]{1,40}?)(?:不是|并非)(?:我|用户)(?:的)?[^，。；;]{1,100}?(?:而是|应该是)(?:我|用户)(?:的)?[^，。；;]+$/u,
    );
    const ordinary = text.match(
      /^([^，。！？,:：;；]{1,40}?)是(?:我|用户)(?:的)?[^，。！？;；]+$/u,
    );
    const subject =
      replacement?.[1] ?? ordinary?.[1] ?? implicitCorrection?.[1];
    return subject === undefined
      ? undefined
      : claim(`user_fact:relationship:${keyPart(subject)}`);
  },
  (text) => {
    const match = text.match(
      /^我的([^，。！？,:：;；]{1,32}?)(?:是|为|叫)([^，。！？;；]+)$/u,
    );
    return match?.[1] === undefined
      ? undefined
      : claim(`user_fact:user:${keyPart(match[1])}`);
  },
  (text) => {
    const match = text.match(
      /^([^，。！？,:：;；的]{1,40})的([^，。！？,:：;；]{1,32}?)(?:是|为|叫)([^，。！？;；]+)$/u,
    );
    return match?.[1] === undefined || match[2] === undefined
      ? undefined
      : claim(`user_fact:${keyPart(match[1])}:${keyPart(match[2])}`);
  },
  (text) => {
    const direct = text.match(
      /^([^，。！？,:：;；的]{1,40})(?:的)?(?:居住地|住址)(?:是|为|在)([^，。！？;；]+)$/u,
    );
    if (direct?.[1] !== undefined) {
      return claim(`user_fact:${keyPart(direct[1])}:居住地`);
    }
    const simple = text.match(
      /^([^，。！？,:：;；]{1,40}?)(?:现在|目前|确实)?住在([^，。！？;；]+)$/u,
    );
    if (simple?.[1] !== undefined) {
      return claim(`user_fact:${keyPart(simple[1])}:居住地`);
    }
    const compound = text.match(
      /^([^，。！？,:：;；]{1,40}?)(?:其实|实际上|实际)?是(?:我|用户)?(?:的)?[^，。！？;；]+[，,;；].*?(?:他|她|其)?(?:现在|目前|确实)?住在([^，。！？;；]+)$/u,
    );
    return compound?.[1] === undefined
      ? undefined
      : claim(`user_fact:${keyPart(compound[1])}:居住地`);
  },
  (text) => {
    const relationship = text.match(
      /^(.{1,80}?)\s+is\s+(?:not\s+)?my\s+.{1,100}?(?:\s+but\s+my\s+.+)?[.!]?$/iu,
    );
    if (relationship?.[1] !== undefined) {
      return claim(`user_fact:relationship:${keyPart(relationship[1])}`);
    }
    const attribute = text.match(/^my\s+(.{1,60}?)\s+is\s+.+[.!]?$/iu);
    return attribute?.[1] === undefined
      ? undefined
      : claim(`user_fact:user:${keyPart(attribute[1])}`);
  },
];

function parseClaims(
  text: string,
  parsers: readonly ClaimParser[],
): DerivedExplicitUserMemoryClaim[] {
  const claims = new Map<string, DerivedExplicitUserMemoryClaim>();
  for (const parser of parsers) {
    const derived = parser(text);
    if (derived === undefined) continue;
    claims.set(`${derived.subjectKey}:${derived.disposition}`, derived);
  }
  return [...claims.values()];
}

const BEVERAGE = "咖啡|茶|奶茶|可可|果汁|饮料|水";
const PREFERENCE_PARSERS: readonly ClaimParser[] = [
  (text) => {
    const match = text.match(
      new RegExp(
        `^我(?:喝|点|冲)(?<drink>${BEVERAGE})(?:时|的时候)?(?:通常|一般|更)?(?:喜欢|偏好|习惯|要|会)?[^，。！？;；]+$`,
        "u",
      ),
    );
    const drink = match?.groups?.["drink"];
    return drink === undefined
      ? undefined
      : claim(`user_preference:drink:${keyPart(drink)}`);
  },
  (text) => {
    if (
      /^(?:我(?:最近|平时|通常|一般)?|最近我|平时我)(?:不太|很少|更|常|经常|通常|一般)*?(?:喜欢|偏爱|喝|常喝|更常喝).*(?:咖啡|茶|奶茶|可可|果汁|饮料|水)/u.test(
        text,
      )
    ) {
      return claim("user_preference:drink:usual");
    }
    return undefined;
  },
  (text) => {
    const match = text.match(
      new RegExp(
        `^(?:我的)?(?<drink>${BEVERAGE})(?:方面|口味)?(?:的)?(?:偏好|习惯)(?:是|为)[^，。！？;；]+$`,
        "u",
      ),
    );
    const drink = match?.groups?.["drink"];
    return drink === undefined
      ? undefined
      : claim(`user_preference:drink:${keyPart(drink)}`);
  },
  (text) => {
    const match = text.match(
      /^我(不喜欢|讨厌|喜欢|偏爱|爱)([^，。！？;；]+)$/u,
    );
    const predicate = match?.[1];
    const object = match?.[2];
    if (predicate === undefined || object === undefined) return undefined;
    return claim(
      `user_preference:like:${keyPart(object)}`,
      predicate === "不喜欢" || predicate === "讨厌" ? "negated" : "affirmed",
    );
  },
  (text) => {
    const coffee = text.match(
      /^i\s+(?:take|drink|prefer)\s+my\s+(coffee|tea)\s+.+[.!]?$/iu,
    );
    if (coffee?.[1] !== undefined) {
      return claim(`user_preference:drink:${keyPart(coffee[1])}`);
    }
    const preference = text.match(
      /^my\s+preference\s+for\s+(.{1,60}?)\s+is\s+.+[.!]?$/iu,
    );
    return preference?.[1] === undefined
      ? undefined
      : claim(`user_preference:${keyPart(preference[1])}`);
  },
];

function stripCorrectionPrefix(text: string): string {
  return text.normalize("NFKC").trim().replace(CORRECTION_PREFIX, "").trim();
}

function stripMemoryInstructionPrefix(text: string): string {
  return text
    .replace(
      /^(?:再记一件|再记一下|记一下|记住|请记住|补充(?:一下)?|再补充一件)\s*[:：,，。]?\s*/u,
      "",
    )
    .trim();
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[。.!！;；,，]+$/gu, "").trim();
}

function keyPart(value: string): string {
  const normalized = normalizeText(value)
    .replace(/^(?:the|a|an)\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
  return normalized || "unknown";
}

function claim(
  subjectKey: string,
  disposition: "affirmed" | "negated" = "affirmed",
): DerivedExplicitUserMemoryClaim {
  return { subjectKey, disposition };
}
