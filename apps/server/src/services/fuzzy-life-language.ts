import type {
  DecisionRecord,
  DilemmaEpisode,
  LifeDomain,
  PressureEpisode,
  SupportMode,
} from "@personasim/contracts";

import { clamp01, inferDomain } from "./fuzzy-life-planning.js";

export function isDelegatedDecision(text: string): boolean {
  if (
    /(?:不要|不用|不需要|别)(?:你)?(?:直接)?(?:替我|代我|帮我)(?:决定|选择|选)|(?:不要|别)你来(?:决定|选择|选)|(?:没有|并未|不是).{0,12}授权/u.test(
      text,
    )
  ) {
    return false;
  }
  return /(?:替我|你来|你替我|帮我).{0,12}(?:决定|选)|直接.{0,8}(?:决定|选)|你说了算/u.test(
    text,
  );
}

export function isDilemma(text: string): boolean {
  return /要不要|该不该|怎么选|选哪个|怎么办|是否应该|拿不定主意|很犹豫|还没决定|难以决定|做(?:不出|不了)决定|面临.{0,8}(?:决定|选择)/u.test(
    text,
  );
}

function isRecommendationRequest(text: string): boolean {
  return /(?:请|直接|只|给我).{0,10}推荐|给我.{0,8}(?:明确)?建议|你觉得|你会怎么做|帮我分析|替我分析/u.test(
    text,
  );
}

export function isPressureDisclosure(text: string): boolean {
  return /焦虑|压力|清晰度|难受|低落|撑不住|烦躁|崩溃|害怕|我又怕|失眠|反复想|很乱|不知所措|累坏|一直.{0,6}压着|压得.{0,8}(?:喘不过气|难受)|肩膀.{0,8}绷/u.test(
    text,
  );
}

export function isPressureTrajectoryContinuation(text: string): boolean {
  return /最难受|每天.{0,12}不相信|我又怕|十年后.{0,16}没试过|这(?:次|个|条).{0,10}(?:选择|决定|结果|压力)|这个结果|结果出现后|压力(?:大概|大约|差不多|还是|是|到|降到|升到)?\s*\d|清晰度(?:大概|大约|差不多|还是|是|到|降到|升到)?\s*\d|梳理完这些|清楚了不代表轻松|能接受.{0,8}代价|真正改变我的/u.test(
    text,
  );
}

export function isIdentityFacetOfLifeChoice(text: string): boolean {
  return /工作|职业|创作|收入|合同|搬家|选择|决定|结果|长期|十年后|害怕|不相信|意义|代价/u.test(
    text,
  );
}

export function isPressureFeedbackText(text: string): boolean {
  return /好多了|轻松多了|没那么(?:焦虑|难受|乱)|想清楚了|清楚多了|被(?:你)?听见|被理解|谢谢你.*(?:听|陪)|更焦虑|更难受|更糟|还是很乱|完全没用|压力更大|没(?:有)?被(?:听见|理解)/u.test(
    text,
  );
}

export function hasExplicitSupportIntent(text: string): boolean {
  return /先陪我|陪我坐会|先听|只听|听我.{0,8}(?:说|讲)|不要分析|别分析|不要给.{0,6}(?:方案|建议)|一起分析|帮我分析|替我分析|梳理|理一理|权衡|收益.{0,12}代价|最坏情况|反事实|(?:请|直接|只).{0,8}推荐|替我.{0,12}(?:决定|选)|你说了算|先别急着解释/u.test(
    text,
  );
}

function isExplicitDeliberation(text: string): boolean {
  return /一起分析|帮我分析|替我分析|梳理|理一理|权衡|收益.{0,16}代价|最坏情况|哪些风险|反事实|帮我找到.{0,8}(?:卡住|关键)|只问我一个问题/u.test(
    text,
  );
}

function isExplicitListenOnly(text: string): boolean {
  return /先陪我|陪我坐会|先听|只听|听我.{0,8}(?:说|讲)|不要分析|别分析|不要给.{0,6}(?:方案|建议)|先别急着解释/u.test(
    text,
  );
}

function isExplicitRecommendation(text: string): boolean {
  if (/不要.{0,8}(?:推荐|建议)|先不要下结论/u.test(text)) {
    return false;
  }
  return /(?:请|直接|只).{0,8}推荐|只推荐一个|给我一个明确(?:方向|建议)|明确建议/u.test(
    text,
  );
}

export function supportMode(
  text: string,
  delegated: boolean,
  dilemmaLike: boolean,
): SupportMode {
  if (delegated) return "delegated_decision";
  if (isExplicitDeliberation(text)) return "deliberate";
  if (isExplicitListenOnly(text)) return "listen_only";
  if (isExplicitRecommendation(text)) return "recommend";
  if (dilemmaLike || isRecommendationRequest(text)) return "deliberate";
  return "listen_only";
}

export function userToCharacterSupportMode(text: string): SupportMode {
  if (/如果是我|我的建议|建议你|我会优先|我会选择|我会选/u.test(text)) {
    return "recommend";
  }
  return "deliberate";
}

export function supportIntendedEffect(
  mode: SupportMode,
  receiver: "user" | "character",
): string {
  const subject = receiver === "user" ? "用户" : "角色";
  if (mode === "listen_only") return `让${subject}感到被听见并降低反刍负担`;
  if (mode === "deliberate") return `帮助${subject}看清选项、价值冲突和代价`;
  if (mode === "recommend")
    return `向${subject}提供一个明确但不代行决定权的方向`;
  return `依据${subject}的明确授权代为作出选择`;
}

export function decisionSupportDirection(
  dilemma: DilemmaEpisode,
  authority: "subject" | "delegated",
  decidedBy: "user" | "character",
): {
  offeredBy: "user" | "character";
  receivedBy: "user" | "character";
} {
  if (dilemma.subject === "user") {
    return { offeredBy: "character", receivedBy: "user" };
  }
  if (dilemma.subject === "character") {
    return { offeredBy: "user", receivedBy: "character" };
  }
  if (authority === "delegated") {
    return decidedBy === "user"
      ? { offeredBy: "user", receivedBy: "character" }
      : { offeredBy: "character", receivedBy: "user" };
  }
  return decidedBy === "user"
    ? { offeredBy: "character", receivedBy: "user" }
    : { offeredBy: "user", receivedBy: "character" };
}

export function isUserOwnedDecision(text: string): boolean {
  if (
    /还没决定|没有决定|尚未决定|决定仍然有效|授权你|替我(?:决定|选择|选)|你来(?:决定|选择|选)|不要.{0,8}(?:替我|帮我).{0,6}(?:决定|选择|选)|不会假装/u.test(
      text,
    )
  ) {
    return false;
  }
  return /我(?:现在|已经|最终|明确)?(?:决定选择|决定了|决定要|选择了|选择)|这个决定由我作出/u.test(
    text,
  );
}

export function isCharacterSubjectDecisionRequest(text: string): boolean {
  return /你现在愿意.{0,20}(?:选一个方向|作决定)|请按你自己的价值作决定|由你自己.{0,8}(?:决定|选择)|你愿意为.{0,16}(?:决定|选)/u.test(
    text,
  );
}

export function isUserAdviceToCharacter(text: string): boolean {
  return /如果是我|我的建议|这是我的建议|建议你|我会优先|我会选择|我会选|你可以接受|部分接受|拒绝/u.test(
    text,
  );
}

export function isCharacterDilemmaTurn(
  text: string,
  dilemma: DilemmaEpisode,
): boolean {
  if (
    isUserAdviceToCharacter(text) ||
    isCharacterSubjectDecisionRequest(text)
  ) {
    return true;
  }
  return dilemmaRelevance(dilemma, text) >= 8;
}

export function isCharacterReflectionRequest(text: string): boolean {
  return /你现在怎么看自己的选择|你现在怎么看.{0,8}(?:决定|选择)|回头看.{0,12}你.{0,8}(?:决定|选择)|你如何理解自己的选择/u.test(
    text,
  );
}

export function parseScaleMetric(
  text: string,
  metric: "pressure" | "clarity",
): number | undefined {
  const label = metric === "pressure" ? "压力" : "清晰度";
  const match = text.match(
    new RegExp(
      `${label}(?:(?:大概|大约|差不多|还是|是|到|降到|升到)\\s*)*\\s*(\\d+(?:\\.\\d+)?)\\s*\\/\\s*10`,
      "u",
    ),
  );
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? clamp01(value / 10) : undefined;
}

export function selectDilemmaOption(
  dilemma: DilemmaEpisode,
  evidenceText: string,
): DilemmaEpisode["options"][number] {
  return [...dilemma.options].sort(
    (left, right) =>
      optionRelevance(right, evidenceText) -
      optionRelevance(left, evidenceText),
  )[0]!;
}

function optionRelevance(
  option: DilemmaEpisode["options"][number],
  evidenceText: string,
): number {
  const evidence = normalizeForMatch(evidenceText);
  const label = normalizeForMatch(option.label);
  const description = normalizeForMatch(option.description);
  const exactBonus =
    evidence.includes(label) || label.includes(evidence) ? label.length * 2 : 0;
  return (
    exactBonus +
    longestCommonSubstringLength(evidence, label) * 4 +
    longestCommonSubstringLength(evidence, description) * 2
  );
}

export function dilemmaRelevance(
  dilemma: DilemmaEpisode,
  evidenceText: string,
): number {
  const evidence = normalizeForMatch(evidenceText);
  const base = Math.max(
    longestCommonSubstringLength(evidence, normalizeForMatch(dilemma.title)),
    longestCommonSubstringLength(evidence, normalizeForMatch(dilemma.summary)),
  );
  const option = Math.max(
    ...dilemma.options.map((candidate) =>
      optionRelevance(candidate, evidenceText),
    ),
  );
  const domainBonus = inferDomain(evidenceText) === dilemma.domain ? 3 : 0;
  return base * 2 + option + domainBonus;
}

export function hasMeaningfulDilemmaContextAnchor(
  dilemma: DilemmaEpisode,
  evidenceText: string,
): boolean {
  const evidence = normalizeForMatch(evidenceText);
  const optionEvidence = dilemma.options.flatMap((option) => [
    option.label,
    option.description,
    ...option.likelyTradeoffs,
    ...option.valuesAtStake,
  ]);
  return [dilemma.title, ...optionEvidence].some(
    (source) =>
      longestCommonSubstringLength(evidence, normalizeForMatch(source)) >= 2,
  );
}

export function hasExplicitDilemmaContextFrame(text: string): boolean {
  return /(?:价值(?:排序|取舍)|决策优先级|选择标准|取舍底线)/u.test(text);
}

export function decisionRelevance(
  decision: DecisionRecord,
  dilemma: DilemmaEpisode | undefined,
  evidenceText: string,
): number {
  const evidence = normalizeForMatch(evidenceText);
  const selectionScore =
    longestCommonSubstringLength(
      evidence,
      normalizeForMatch(decision.selectionSummary),
    ) * 4;
  const dilemmaScore =
    dilemma === undefined ? 0 : dilemmaRelevance(dilemma, evidenceText);
  const subjectBonus =
    decision.subject === "character" && /你|你的|角色|对方/u.test(evidenceText)
      ? 8
      : decision.subject === "user" && /我|我的/u.test(evidenceText)
        ? 4
        : 0;
  return selectionScore + dilemmaScore + subjectBonus;
}

export const DECISION_EVIDENCE_RELEVANCE_THRESHOLD = 12;
export const REFLECTION_CONTINUITY_RELEVANCE_THRESHOLD = 8;
export const PRESSURE_DILEMMA_RELEVANCE_THRESHOLD = 12;
export const DILEMMA_CONTEXT_EVIDENCE_RELEVANCE_THRESHOLD = 8;
const STRONG_TWO_CHARACTER_CAUSAL_TERMS = [
  "辞职",
  "离职",
  "签约",
  "搬家",
  "分手",
  "拒绝",
  "接受",
  "报名",
  "申请",
] as const;
const AMBIGUOUS_TWO_CHARACTER_REFLECTION_TOPICS = new Set([
  "生活",
  "工作",
  "事情",
  "感觉",
  "理解",
  "需要",
  "可以",
  "应该",
  "时候",
  "还是",
]);
const PRESSURE_DILEMMA_CONCEPT_GROUPS = [
  ["工作", "职业", "公司", "员工"],
  ["长期", "十年后", "未来"],
  ["害怕", "怕", "担心"],
  ["创作", "纪录片", "内容"],
  ["稳定", "收入", "合同"],
  ["搬家", "换个地方", "城市", "异地"],
  ["关系", "伴侣", "分手", "朋友", "家人"],
  ["健康", "睡眠", "生病", "身体"],
  ["学习", "考试", "课程", "学校"],
] as const;

export function decisionEvidenceSemanticRelevance(
  decision: DecisionRecord,
  dilemma: DilemmaEpisode | undefined,
  evidenceText: string,
): number {
  const sources = [
    decision.selectionSummary,
    ...(dilemma === undefined
      ? []
      : [
          dilemma.title,
          dilemma.summary,
          ...dilemma.options.flatMap((option) => [
            option.label,
            option.description,
            ...option.likelyTradeoffs,
            ...option.valuesAtStake,
          ]),
        ]),
  ];
  return Math.max(
    0,
    ...sources.map((source) => causalTextRelevance(evidenceText, source)),
  );
}

export function decisionStagePredecessorRelevance(
  stage: "action" | "outcome" | "reflection",
  evidenceText: string,
  actionSummaries: readonly string[],
  outcomeSummaries: readonly string[],
): number {
  const sources =
    stage === "outcome"
      ? actionSummaries
      : stage === "reflection"
        ? [...outcomeSummaries, ...actionSummaries]
        : [];
  return Math.max(
    0,
    ...sources.map((source) => causalTextRelevance(evidenceText, source)),
  );
}

export function reflectionContinuityRelevance(
  decision: DecisionRecord,
  dilemma: DilemmaEpisode | undefined,
  evidenceText: string,
  actionSummaries: readonly string[],
  outcomeSummaries: readonly string[],
): number {
  const sources = [
    decision.selectionSummary,
    ...actionSummaries,
    ...outcomeSummaries,
    ...(dilemma === undefined
      ? []
      : [
          dilemma.title,
          dilemma.summary,
          ...dilemma.options.flatMap((option) => [
            option.label,
            option.description,
            ...option.likelyTradeoffs,
            ...option.valuesAtStake,
          ]),
        ]),
  ];
  return Math.max(
    0,
    ...sources.map((source) =>
      reflectionTopicTextRelevance(evidenceText, source),
    ),
  );
}

function reflectionTopicTextRelevance(left: string, right: string): number {
  return (
    longestMeaningfulCommonSubstringLength(
      normalizeCausalMatch(left),
      normalizeCausalMatch(right),
      AMBIGUOUS_TWO_CHARACTER_REFLECTION_TOPICS,
    ) * 4
  );
}

export function reflectionSubjectMatches(
  decision: DecisionRecord,
  evidenceText: string,
  preferCharacter: boolean,
): boolean {
  if (preferCharacter) return decision.subject === "character";
  if (/我|我的|我们/u.test(evidenceText)) return decision.subject === "user";
  return decision.subject !== "character";
}

export function pressureDilemmaSemanticRelevance(
  episode: PressureEpisode,
  dilemma: DilemmaEpisode,
  pressureEvidenceTexts: readonly string[],
): number {
  const pressureTexts = [episode.triggerSummary, ...pressureEvidenceTexts];
  const dilemmaTexts = [
    dilemma.title,
    dilemma.summary,
    ...dilemma.options.flatMap((option) => [
      option.label,
      option.description,
      ...option.likelyTradeoffs,
      ...option.valuesAtStake,
    ]),
  ];
  const strongestDirectMatch = Math.max(
    0,
    ...pressureTexts.flatMap((pressureText) =>
      dilemmaTexts.map((dilemmaText) =>
        causalTextRelevance(pressureText, dilemmaText),
      ),
    ),
  );
  const pressureCorpus = pressureTexts.join(" ");
  const dilemmaCorpus = dilemmaTexts.join(" ");
  const sharedConceptCount = PRESSURE_DILEMMA_CONCEPT_GROUPS.filter(
    (terms) =>
      terms.some((term) => pressureCorpus.includes(term)) &&
      terms.some((term) => dilemmaCorpus.includes(term)),
  ).length;
  return Math.max(strongestDirectMatch, sharedConceptCount * 4);
}

function causalTextRelevance(left: string, right: string): number {
  const normalizedLeft = normalizeCausalMatch(left);
  const normalizedRight = normalizeCausalMatch(right);
  const common = longestCommonSubstringLength(normalizedLeft, normalizedRight);
  if (common >= 3) return common * 4;
  return STRONG_TWO_CHARACTER_CAUSAL_TERMS.some(
    (term) => normalizedLeft.includes(term) && normalizedRight.includes(term),
  )
    ? DECISION_EVIDENCE_RELEVANCE_THRESHOLD
    : 0;
}

function normalizeCausalMatch(text: string): string {
  return normalizeForMatch(text).replace(
    /今天|刚刚|刚才|后来|最终|实际|事实|已经|仍然|一下|一封|普通|这个|那个|这次|上述|自己的|我的|你的|我们|他们|她们|自己|决定|选择|方向|行动|结果|反馈|我|你|他|她/gu,
    "",
  );
}

export function hasExplicitCausalStageReference(
  text: string,
  stage: "action" | "outcome" | "reflection",
): boolean {
  if (stage === "action") {
    return /(?:落实|执行|照着|按照|为了).{0,12}(?:决定|选择|方向)|(?:这个|这次|上述).{0,8}(?:决定|选择).{0,16}(?:做了|行动|落实|执行)/u.test(
      text,
    );
  }
  if (stage === "outcome") {
    return /(?:这个|这次|上述).{0,8}(?:决定|选择|行动).{0,16}(?:带来|导致|产生|结果|后果|反馈)|后来.{0,12}(?:公司|对方|机构|学校).{0,12}(?:同意|拒绝|通过|回复|确认)/u.test(
      text,
    );
  }
  return /(?:对|回看|回头看|关于).{0,12}(?:决定|选择|结果)|怎么看(?:自己)?的?(?:决定|选择)|如何理解自己的选择/u.test(
    text,
  );
}

export function exactlyOne<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function longestMeaningfulCommonSubstringLength(
  left: string,
  right: string,
  ambiguousTwoCharacterFragments: ReadonlySet<string>,
): number {
  const maximum = Math.min(left.length, right.length, 24);
  for (let length = maximum; length >= 2; length -= 1) {
    const fragments = new Set<string>();
    for (let index = 0; index <= left.length - length; index += 1) {
      fragments.add(left.slice(index, index + length));
    }
    for (const fragment of fragments) {
      if (
        right.includes(fragment) &&
        (length > 2 || !ambiguousTwoCharacterFragments.has(fragment))
      ) {
        return length;
      }
    }
  }
  return 0;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(/这个|那个|现在|已经|决定|选择|方向/gu, "");
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return 0;
  const previous = new Array<number>(right.length + 1).fill(0);
  let best = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        previous[rightIndex] = diagonal + 1;
        best = Math.max(best, previous[rightIndex]!);
      } else {
        previous[rightIndex] = 0;
      }
      diagonal = above;
    }
  }
  return best;
}

export function extractSelectedDirection(text: string): string {
  const explicit = text.match(
    /(?:我的决定|我的建议|我建议你|我会选|就选)[：:\s]*([^。！？!\n]{1,160})/u,
  )?.[1];
  if (explicit?.trim()) return explicit.trim();
  return text
    .replace(/\s+/gu, " ")
    .trim()
    .split(/[。！？!]/u)[0]!
    .slice(0, 160);
}

export function shortTitle(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 80);
}

export function pressureKind(
  domain: LifeDomain,
): PressureEpisode["pressureKind"] {
  if (domain === "work" || domain === "study" || domain === "creative")
    return "work";
  if (domain === "relationship" || domain === "social") return "relationship";
  if (domain === "identity" || domain === "self_reflection") return "identity";
  if (domain === "health" || domain === "rest") return "health";
  return "decision";
}

export function compactLifePromptText(text: string, maximum = 600): string {
  const compact = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return compact.length <= maximum
    ? compact
    : `${compact.slice(0, maximum - 1)}…`;
}

export function isActionEvidence(text: string): boolean {
  if (
    isCausalRecapOrProvenanceRequest(text) ||
    /(?:还没|没有|尚未|并未|不会|不等于).{0,20}(?:提交|办理|报名|申请|搬|分手|开始|完成|联系|签|执行|行动|发邮件|辞职|答应)|(?:只是|仍是).{0,12}(?:计划|打算)|如果.{0,16}(?:行动|已经做)|(?:吗|是否|有没有).{0,12}(?:行动|做了|迈出)|没有新的确认|事实没有变化/u.test(
      text,
    )
  ) {
    return false;
  }
  const strongEvidence =
    /(?:已经|刚刚|刚|后来|今天|最终|正式).{0,48}(?:提交(?:了)?|办理(?:了)?|报名(?:了)?|申请(?:了)?|搬走(?:了)?|分手了|答应了|拒绝了|开始做|完成(?:了)?|做了|去了|说了|联系(?:了)?|签了|取消(?:了)?|执行(?:了)?|行动(?:了)?|发(?:出|了)|提出(?:了)?|确认(?:了)?|启动(?:了)?)/u;
  if (strongEvidence.test(text)) return true;
  if (
    /只是想|(?:决定|打算|计划|准备|考虑|想要).{0,12}(?:辞职|离职|搬|分手|报名|申请)/u.test(
      text,
    )
  ) {
    return false;
  }
  return /(?:已经|刚刚|后来|最终).{0,8}(?:辞职|离职|搬家)/u.test(text);
}

export function isActionRestatement(text: string): boolean {
  return /(?:同一封)?邮件已经发出|同一封邮件|不要把.{0,12}(?:算成|记成).{0,8}(?:两次|重复)|连接重试|重复发送|这仍是同一个行动|只是重述.{0,8}行动|实际情况.{0,32}(?:自己|由我).{0,12}(?:执行|行动)|之后也是我自己执行/u.test(
    text,
  );
}

export function inferActionKind(
  text: string,
): "initiated" | "advanced" | "completed" | "abandoned" {
  if (/完成|办完|做完|结束|落实/u.test(text)) return "completed";
  if (/取消|放弃|没再继续|停下/u.test(text)) return "abandoned";
  if (/继续|推进|又做|第二步/u.test(text)) return "advanced";
  return "initiated";
}

export function isOutcomeEvidence(text: string): boolean {
  if (
    isCausalRecapOrProvenanceRequest(text) ||
    isCharacterReflectionRequest(text) ||
    /没有(?:最终)?结果|还没有.{0,16}(?:反馈|确认|结果)|仍然不是最终结果|仍不是最终结果|只有行动.{0,8}没有结果|事实没有变化|没有新的确认|(?:什么|哪些|现在).{0,8}(?:反馈|结果).{0,4}(?:是|吗)|如果.{0,12}(?:出现|有了).{0,8}结果|(?:这个|该|上述)结果.{0,8}(?:让我|使我|令我|带给我)|听到.{0,8}结果.{0,8}(?:我|感觉)/u.test(
      text,
    )
  ) {
    return false;
  }
  if (
    parseScaleMetric(text, "pressure") !== undefined &&
    parseScaleMetric(text, "clarity") !== undefined &&
    !/(?:资金|薪资|公司|合同|接受|拒绝|通过|失败|成功|通知|反馈|确认收件|混合结果)/u.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /(?:结果|后来|因此|所以|最终|现在).{0,28}(?:同意|拒绝|通过|失败|成功|变得|让我|轻松|开心|难受|后悔|更好|更糟|收到|有了)|(?:同意|拒绝|通过|失败|成功|收到).{0,20}(?:了|结果|通知)/u.test(
      text,
    ) || /几天后的结果是|这是混合结果|出现的实际反馈/u.test(text)
  );
}

function isCausalRecapOrProvenanceRequest(text: string): boolean {
  return /请.{0,16}(?:区分|回顾|总结).{0,40}(?:决定|行动|结果)|目前停在哪一步.{0,24}(?:决定|行动|结果)|哪段对话.{0,32}(?:影响|决定).{0,48}哪条消息|哪条消息.{0,24}(?:证明|行动|结果)|按顺序回顾/u.test(
    text,
  );
}

export function hasMixedCausation(text: string): boolean {
  return /混合原因|既有.{0,12}行动.{0,16}也有.{0,12}外部|外部因素|同时.{0,20}(?:资金|政策|市场|公司另行)/u.test(
    text,
  );
}

export function inferOutcomeValence(
  text: string,
): "positive" | "negative" | "mixed" | "neutral" {
  if (/混合结果|不是纯好消息|好的一面和坏的一面/u.test(text)) {
    return "mixed";
  }
  const positive =
    /成功|通过|同意|轻松|开心|更好|庆幸|值得|满意|稳定|放心|动力/u.test(text);
  const negative =
    /失败|拒绝|难受|更糟|后悔|失望|痛苦|损失|不稳定|担心|变少|减少|延迟|麻木/u.test(
      text,
    );
  if (positive && negative) return "mixed";
  if (positive) return "positive";
  if (negative) return "negative";
  return "neutral";
}

export function isReflectionEvidence(text: string): boolean {
  if (/有没有改变你|请.{0,8}(?:回顾|总结|区分)|你现在怎么看/u.test(text)) {
    return false;
  }
  return /回头看|现在想想|我觉得这个决定|我对这个选择|我后悔|我很庆幸|我才明白|我想明白|我(?:现在)?的理解是|重新想/u.test(
    text,
  );
}

export function reflectionLesson(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}…`;
}

export function reflectionStance(
  text: string,
): "affirm" | "question" | "reverse" | "mixed" | "unclear" {
  if (/后悔|改主意|不该|选错|反悔/u.test(text)) return "reverse";
  if (
    /一方面|但也|有好有坏|复杂|(?:仍)?认同.{0,80}(?:但|代价)|(?:但|同时).{0,48}(?:代价|担心)/u.test(
      text,
    )
  )
    return "mixed";
  if (/庆幸|值得|选对|没选错|很满意|(?:仍)?认同|仍会选择/u.test(text))
    return "affirm";
  if (/怀疑|不确定|是不是/u.test(text)) return "question";
  return "unclear";
}
