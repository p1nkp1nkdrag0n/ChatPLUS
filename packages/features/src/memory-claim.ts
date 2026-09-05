import { normalizeText } from "./shared.js";

export type ExplicitUserMemoryClaimCategory = "user_fact" | "user_preference";

export interface DerivedExplicitUserMemoryClaim {
  subjectKey: string;
  disposition: "affirmed" | "negated";
}

export interface ExplicitDeadlineFact {
  subject: string;
  deadlineKind: "reply" | "application" | "submission" | "decision" | "general";
  value: string;
  subjectKey: string;
}

export interface ExplicitStoredItemFact {
  item: string;
  subjectKey: string;
}

export interface ExplicitWeeklyPlanFact {
  activity: string;
  weekday: string;
  timeOfDay: string;
  subjectKey: string;
  explicitCorrection: boolean;
}

const CORRECTION_PREFIX =
  /^(?:(?:更正(?:一下|一个事实|另一件事)?|纠正|修正|更新(?:一下)?|改(?:正|一下)|补充更正)|(?:我|前面|刚才|之前)?(?:刚才|之前|前面)?说错了|correction|update|i\s+(?:was|got\s+that)\s+wrong)\s*[:：,，。.!！-]?\s*/iu;
const EXPLICIT_REPLACEMENT =
  /(?:不是|并非).{1,120}?(?:而是|应该是)|\bnot\b.{1,120}?\bbut\b/iu;
const EXPLICIT_CHANGE =
  /(?:后来)?改(?:成|为|去|到).{1,80}?(?:不再|不去|不是|而非)|(?:延到|改到).{1,40}?(?:不是|而非)|(?:最新事实|被更正的旧信息)/u;
const QUESTION_OR_NON_ASSERTION =
  /[?？]\s*$|(?:是不是|是否)|(?:吗|呢)\s*$|^(?:我|我们)?(?:如果|假如|假设|假定|要是|比如|例如|譬如|举例|想象一下|听说|有人说|据说)|^(?:if\b|suppose\b|for\s+example\b)/iu;
const QUOTED_OR_DISCLAIMED =
  /^(?!(?:我|前面|刚才|之前)?(?:刚才|之前|前面)?说错了)(?!(?:以后)?如果我说)[^，,。.!！？:：]{1,20}(?:说|表示|认为|声称)[，,:：]?|^(?:he\s+said|she\s+said|they\s+said)\b|(?:别|不要).{0,20}(?:记住|记录|当成|当作).{0,20}(?:我的|用户的)?(?:事实|偏好|记忆)|(?:这|那)(?:不|并不)是我的(?:事实|偏好)/iu;
const UNCERTAIN_ASSERTION =
  /(?:可能|也许|或许|大概|似乎|好像|不确定|未确认|没有确认)|\b(?:maybe|perhaps|probably|uncertain|unconfirmed)\b/iu;
const ASSERTIVE_CONDITIONAL_PREFERENCE =
  /^如果只看(?:价值排序|长期价值|个人偏好)/u;

/**
 * Returns true only for an explicit correction in verified user-authored text.
 * The model-facing memory proposal cannot set this durable lifecycle signal.
 */
export function hasExplicitMemoryCorrection(text: string): boolean {
  return (
    extractExplicitWeeklyPlanFacts(text).some(
      (fact) => fact.explicitCorrection,
    ) || hasLegacyMemoryCorrection(text)
  );
}

function hasLegacyMemoryCorrection(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  if (!isExplicitUserMemoryStatement(normalized)) return false;
  return (
    CORRECTION_PREFIX.test(normalized) ||
    EXPLICIT_REPLACEMENT.test(normalized) ||
    EXPLICIT_CHANGE.test(normalized)
  );
}

export function isExplicitUserMemoryStatement(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  return (
    normalized.length >= 3 &&
    (!QUESTION_OR_NON_ASSERTION.test(normalized) ||
      ASSERTIVE_CONDITIONAL_PREFERENCE.test(normalized)) &&
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
  const weeklyFacts = extractExplicitWeeklyPlanFacts(input.evidenceText);
  if (input.category === "user_fact") {
    if (input.candidateContent === undefined && weeklyFacts[0] !== undefined) {
      return claim(weeklyFacts[0].subjectKey);
    }
    const candidateWeeklyFacts = extractExplicitWeeklyPlanFacts(
      input.candidateContent ?? "",
    );
    if (candidateWeeklyFacts.length > 1) return undefined;
    if (candidateWeeklyFacts.length > 0) {
      const verified = weeklyFacts.find((fact) =>
        candidateWeeklyFacts.some((candidate) =>
          weeklyPlanValuesMatch(fact, candidate),
        ),
      );
      return verified === undefined ? undefined : claim(verified.subjectKey);
    }
  }
  return deriveLegacyExplicitUserMemoryClaim(input);
}

function deriveLegacyExplicitUserMemoryClaim(input: {
  category: ExplicitUserMemoryClaimCategory;
  evidenceText: string;
  candidateContent?: string;
}): DerivedExplicitUserMemoryClaim | undefined {
  const explicitCorrection = hasLegacyMemoryCorrection(input.evidenceText);
  const evidence = stripTerminalPunctuation(
    stripMemoryInstructionPrefix(stripCorrectionPrefix(input.evidenceText)),
  );
  if (
    !isExplicitUserMemoryStatement(evidence) ||
    UNCERTAIN_ASSERTION.test(evidence) ||
    (/(?:不是|并非)/u.test(evidence) &&
      !EXPLICIT_REPLACEMENT.test(evidence) &&
      !explicitCorrection)
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

/** Correction authority is tied to the same verified fact, never another topic. */
export function hasExplicitMemoryCorrectionForClaim(input: {
  evidenceText: string;
  category: ExplicitUserMemoryClaimCategory;
  subjectKey: string;
  candidateContent?: string;
}): boolean {
  if (input.subjectKey.startsWith("user_fact:weekly_plan:")) {
    const candidateFacts =
      input.candidateContent === undefined
        ? undefined
        : extractExplicitWeeklyPlanFacts(input.candidateContent);
    if (candidateFacts !== undefined && candidateFacts.length !== 1)
      return false;
    return extractExplicitWeeklyPlanFacts(input.evidenceText).some(
      (fact) =>
        fact.subjectKey === input.subjectKey &&
        fact.explicitCorrection &&
        (input.candidateContent === undefined ||
          candidateFacts?.some((candidate) =>
            weeklyPlanValuesMatch(fact, candidate),
          )),
    );
  }
  return (
    hasLegacyMemoryCorrection(input.evidenceText) &&
    deriveLegacyExplicitUserMemoryClaim(input)?.subjectKey === input.subjectKey
  );
}

function weeklyPlanValuesMatch(
  left: ExplicitWeeklyPlanFact,
  right: ExplicitWeeklyPlanFact,
): boolean {
  return (
    left.subjectKey === right.subjectKey &&
    left.weekday === right.weekday &&
    left.timeOfDay === right.timeOfDay
  );
}

/**
 * Recognizes an explicitly stated weekly arrangement, not its execution. Each
 * activity has its own slot. Questions, alternatives and attributed quotations
 * are not arrangements, even when another sentence is assertive.
 */
export function extractExplicitWeeklyPlanFacts(
  sourceText: string,
): ExplicitWeeklyPlanFact[] {
  const text = sourceText.normalize("NFKC").trim();
  if (
    /(?:别|不要).{0,20}(?:记住|记录|当成|当作).{0,20}(?:事实|计划|安排|记忆)|(?:只是举例|别据此改(?:记忆|记录))/u.test(
      text,
    )
  ) {
    return [];
  }
  const weekday = "(?:每(?:周|星期|礼拜))([一二三四五六日天])";
  const period = "(早上|上午|中午|下午|晚上|夜里|晚间)?";
  const activity = "([^，,。！？!?；;:：的]{1,24}?)";
  const timeFirst = new RegExp(
    `(?:^|[，,:：])\\s*(?:我|用户)(?:计划|打算|决定)(?:在)?${weekday}${period}(?:去)?${activity}(?=[，,。！？!?；;]|$)`,
    "gu",
  );
  const activityFirst = new RegExp(
    `(?:^|[，,:：])\\s*(?:(?:我|用户)(?:的|把|将))?(?:留给)?${activity}(?:的)?(?:时间|时段)?(?:其实|现在|目前)?(定在|安排在|固定在|改到|改为|改成)(?:每(?:周|星期|礼拜))([一二三四五六日天])${period}(?=[，,。！？!?；;]|$)`,
    "gu",
  );
  const facts = new Map<string, ExplicitWeeklyPlanFact>();
  const ambiguousActivities = new Set<string>();
  // Remove complete quoted passages before splitting sentences, so a quoted
  // second sentence cannot become a new first-person user assertion.
  const unquotedText = text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu,
    " ",
  );
  for (const rawStatement of unquotedText.match(
    /[^。！？!?；;\r\n]+[。！？!?；;]?/gu,
  ) ?? []) {
    const statement = rawStatement.trim();
    if (
      !isExplicitUserMemoryStatement(statement) ||
      UNCERTAIN_ASSERTION.test(statement) ||
      /[“”"‘’'「」『』]|(?:能不能|可不可以|要不要|还没(?:有)?定|尚未决定|没有决定|或者|或是|还是|还在犹豫)/u.test(
        statement,
      )
    ) {
      continue;
    }
    const parseableStatement = statement.replace(
      /(?:不是|并非)(每)?(?:周|星期|礼拜)([一二三四五六日天])(早上|上午|中午|下午|晚上|夜里|晚间)?[，,]?\s*(?:而是|应该是)(每)?(?:周|星期|礼拜)([一二三四五六日天])(早上|上午|中午|下午|晚上|夜里|晚间)?/gu,
      (
        original: string,
        oldRecurring: string | undefined,
        oldDay: string,
        oldTime: string | undefined,
        newRecurring: string | undefined,
        newDay: string,
        newTime: string | undefined,
      ) =>
        oldRecurring === undefined && newRecurring === undefined
          ? original
          : `改为每周${newDay}${newTime ?? ""}，不是每周${oldDay}${oldTime ?? ""}`,
    );
    for (const [pattern, order] of [
      [activityFirst, "activity"],
      [timeFirst, "time"],
    ] as const) {
      for (const match of parseableStatement.matchAll(pattern)) {
        const rawActivity = (
          order === "activity" ? match[1] : match[3]
        )?.trim();
        const day = order === "activity" ? match[3] : match[1];
        const timeOfDay = (order === "activity" ? match[4] : match[2]) ?? "";
        if (
          rawActivity === undefined ||
          day === undefined ||
          /^(?:我|用户|你|他|她|它|朋友|同事|不|没|别|假设|假如|如果|例如|比如|可能|打算|计划|准备)|(?:每周|星期|礼拜)/u.test(
            rawActivity,
          )
        ) {
          continue;
        }
        const prefix = parseableStatement.slice(0, match.index).trim();
        const suffix = parseableStatement
          .slice(match.index + match[0].length)
          .trim();
        // A local "new weekday, not old weekday" belongs to this activity.
        // A correction elsewhere in the message does not.
        const replacement =
          /^[，,]\s*(?:而)?(?:不是|并非)(?:每)?(?:周|星期|礼拜)[一二三四五六日天]/u.test(
            suffix,
          );
        const localCorrection =
          /(?:^|[，,:：])\s*(?:更正(?:一下|一个事实|另一件事)?|纠正|修正|更新(?:一下)?|我(?:刚才|之前)?说错了)\s*[:：]?$/u.test(
            prefix,
          );
        const subjectKey = `user_fact:weekly_plan:${keyPart(rawActivity)}`;
        const fact: ExplicitWeeklyPlanFact = {
          activity: rawActivity,
          weekday: day === "天" ? "日" : day,
          timeOfDay: timeOfDay === "晚间" ? "晚上" : timeOfDay,
          subjectKey,
          explicitCorrection:
            replacement ||
            localCorrection ||
            (order === "activity" && /^改/u.test(match[2] ?? "")),
        };
        const previous = facts.get(subjectKey);
        if (
          previous !== undefined &&
          !weeklyPlanValuesMatch(previous, fact) &&
          !fact.explicitCorrection
        ) {
          ambiguousActivities.add(subjectKey);
        }
        if (fact.explicitCorrection) ambiguousActivities.delete(subjectKey);
        facts.set(subjectKey, fact);
      }
    }
  }
  return [...facts.values()].filter(
    (fact) => !ambiguousActivities.has(fact.subjectKey),
  );
}

type ClaimParser = (text: string) => DerivedExplicitUserMemoryClaim | undefined;

const FACT_PARSERS: readonly ClaimParser[] = [
  (text) => {
    const storedItem = extractExplicitStoredItemFact(text);
    return storedItem === undefined ? undefined : claim(storedItem.subjectKey);
  },
  (text) => {
    const deadline = extractExplicitDeadlineFact(text);
    return deadline === undefined ? undefined : claim(deadline.subjectKey);
  },
  (text) => {
    const bestFriend = text.match(
      /我最好的朋友叫([\p{Script=Han}A-Za-z·]{1,20})/u,
    )?.[1];
    const directPerson = text.match(
      /(?:^|[:：,，。；;])([\p{Script=Han}A-Za-z·]{1,20}?)(?:后来)?(?:改去|准备去)[\p{Script=Han}A-Za-z·]{1,20}(?:进修|学习|工作|生活)/u,
    )?.[1];
    const hasDestination =
      /(?:准备去|改去)[\p{Script=Han}A-Za-z·]{1,20}(?:进修|学习|工作|生活)/u.test(
        text,
      );
    const person = bestFriend ?? directPerson;
    return person === undefined || person.length === 0 || !hasDestination
      ? undefined
      : claim(`user_fact:person:${keyPart(person)}:destination`);
  },
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

/**
 * Derives a stable slot for an explicitly stated deadline without knowing any
 * scenario entity, option label, or date in advance.
 */
export function extractExplicitDeadlineFact(
  sourceText: string,
): ExplicitDeadlineFact | undefined {
  const text = stripTerminalPunctuation(
    stripCorrectionPrefix(sourceText.normalize("NFKC").trim()),
  );
  const deadlineKind = inferDeadlineKind(text);
  if (deadlineKind === undefined) return undefined;
  const value = currentDeadlineValue(text);
  if (value === undefined) return undefined;
  const subject = deadlineSubject(text);
  if (subject === undefined) return undefined;
  return {
    subject,
    deadlineKind,
    value,
    subjectKey: `user_fact:deadline:${keyPart(subject)}:${deadlineKind}`,
  };
}

/**
 * Recognizes an item-storage fact at the level needed for claim identity. The
 * stored content remains the user's evidence; this function never assumes a
 * particular item, container, color, compartment, or marker value.
 */
export function extractExplicitStoredItemFact(
  sourceText: string,
): ExplicitStoredItemFact | undefined {
  const text = stripTerminalPunctuation(
    stripCorrectionPrefix(sourceText.normalize("NFKC").trim()),
  );
  if (!isExplicitUserMemoryStatement(text)) return undefined;

  // Keep the item and its storage predicate in the same assertion. A storage
  // hint elsewhere in a message must not turn unrelated "我在想" / "拿笔在…"
  // clauses into item facts. A comma may separate an item from its predicate
  // ("我有一本笔记，放在…"), but a sentence boundary may not.
  const statements = text.match(/[^。！？!?；;\r\n]+[。！？!?；;]?/gu) ?? [];
  for (const statement of statements) {
    if (
      !isExplicitUserMemoryStatement(statement) ||
      UNCERTAIN_ASSERTION.test(statement)
    ) {
      continue;
    }
    const match = statement.match(
      /(?:^|[，,:：])\s*(?:我(?:有|的|(?:已经|刚刚|刚才)?把))?(?:一[本份个把串件])?(?:(?:很)?重要的?)?([^，,。！？!?；;:：]{1,24}?)(?:[，,]\s*)?(?:(?:现在|目前|一直|仍然|依然|仍|还)?(?:存放|保存|保管|放|收|存|搁)(?:在|于)|(?:一直|仍然|依然|仍|还)在|(?:的)?(?:位置|存放处)(?:是|为))([^，,。！？!?；;:：]+)/u,
    );
    const rawItem = match?.[1]?.trim();
    const location = match?.[2]?.trim();
    if (
      rawItem === undefined ||
      location === undefined ||
      /^(?:我|你|他|她|它)(?:们)?$/u.test(rawItem) ||
      /(?:不是|并非|不再|没有|没|不|别|不要)$|(?:打算|计划|准备|想要|假如|如果)|^(?:我|你|他|她|它)(?:们)?(?:想|要|不|没)/u.test(
        rawItem,
      ) ||
      /(?:哪里|哪儿|何处|什么地方)/u.test(location)
    ) {
      continue;
    }
    const item = /笔记/u.test(rawItem) ? "notes" : keyPart(rawItem);
    return { item, subjectKey: `user_fact:item:${item}:storage` };
  }
  return undefined;
}

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

function inferDeadlineKind(
  text: string,
): ExplicitDeadlineFact["deadlineKind"] | undefined {
  if (/(?:回复期限|期限.{0,8}回复|前回复)/u.test(text)) return "reply";
  if (/(?:申请期限|申请截止|报名期限|报名截止)/u.test(text)) {
    return "application";
  }
  if (/(?:提交期限|提交截止|交付期限|交付截止)/u.test(text)) {
    return "submission";
  }
  if (/(?:决定期限|决定截止|作出决定.{0,8}前)/u.test(text)) {
    return "decision";
  }
  return /期限|截止(?:日|时间)?/u.test(text) ? "general" : undefined;
}

function currentDeadlineValue(text: string): string | undefined {
  const value =
    text.match(
      /(?:延(?:期)?(?:到|至)|推迟(?:到|至)|提前(?:到|至)|改(?:成|为|到)|调整(?:成|为|到)|更新(?:成|为)|现在(?:是|为)|最新(?:是|为)|而是|应(?:为|该是)|应该是)\s*((?:\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:今天|明天|后天|下周[一二三四五六日天]?))/u,
    )?.[1] ??
    text.match(
      /((?:\d{1,4}\s*年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?:今天|明天|后天|下周[一二三四五六日天]?))/u,
    )?.[1];
  return value?.replace(/\s+/gu, "").trim();
}

function deadlineSubject(text: string): string | undefined {
  const direct = text.match(
    /(?:^|[，,。；;:：])\s*([\p{L}\p{N}·_-]{2,40}?)(?:后来)?(?:把|的)(?:回复|申请|报名|提交|交付|决定)?(?:期限|截止)/u,
  )?.[1];
  if (direct !== undefined) return cleanDeadlineSubject(direct);

  const optionSubject = text.match(
    /选项\s*([A-Z])\s*(?:是|为|[:：])\s*(?:去|加入|接受|选择|留在)?(?:[\p{Script=Han}A-Za-z0-9·_-]{1,16}的)?([\p{Script=Han}A-Za-z0-9·_-]{2,40})(?=[，,。；;])/u,
  );
  if (optionSubject?.[2] !== undefined) {
    return cleanDeadlineSubject(optionSubject[2]);
  }

  const possessive = text.match(
    /([\p{L}\p{N}·_-]{2,40}?)(?:的)(?:回复|申请|报名|提交|交付|决定)?(?:期限|截止)/u,
  )?.[1];
  if (possessive !== undefined) return cleanDeadlineSubject(possessive);
  const optionKey = optionSubject?.[1];
  return optionKey === undefined ? undefined : `option_${optionKey}`;
}

function cleanDeadlineSubject(value: string): string {
  return value
    .replace(/^(?:更正|纠正|修正|更新)(?:一下|一个事实|另一件事)?[:：]?/u, "")
    .replace(/^(?:对方|该方)$/u, "counterparty")
    .trim();
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
