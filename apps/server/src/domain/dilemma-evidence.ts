import type { DilemmaOption } from "@personasim/contracts";

export type DilemmaEvidenceOptionKey = "A" | "B";

export interface DilemmaFactCorrection {
  previousValue: string;
  currentValue: string;
}

export type DilemmaTurnEvidence =
  | {
      kind: "option";
      optionKey: DilemmaEvidenceOptionKey;
      optionIndex: 0 | 1;
      label: string;
    }
  | {
      kind: "context";
    }
  | {
      kind: "correction";
      replacement?: DilemmaFactCorrection;
    };

const OPTION_EVIDENCE = /选项\s*([AB])\s*(?:是|为|[:：])\s*([^。！？!\n]+)/u;
const CORRECTION_CUE =
  /更正|纠正|修正|说错了|记错了|(?:不是|并非).{1,80}(?:而是|应为|应该是)|(?:改|调整|更新|延|推迟|提前)(?:成|为|到|至)/u;
const CONTEXT_EVIDENCE = [
  /(?:生活|经济|现金|应急).{0,8}(?:储备|缓冲)|(?:储蓄|存款).{0,10}(?:够|可(?:以)?|能).{0,12}(?:月|年)/u,
  /(?:父母|父亲|母亲|家人|伴侣|孩子).{0,30}(?:负担|依赖|照顾|支持|反对|担心|希望)/u,
  /(?:价值(?:排序|取舍)?|优先级|底线|更怕|最怕|更看重|最看重|最在意|不能接受|宁可|更愿意)/u,
  /(?:觉得|认为|建议|希望|支持|反对|担心).{0,48}(?:应该|不该|选择|接受|拒绝|留下|离开|去|更稳|风险)/u,
] as const;

const CORRECTION_PATTERNS: readonly {
  pattern: RegExp;
  previousIndex: number;
  currentIndex: number;
}[] = [
  {
    pattern:
      /(?:不是|并非)\s*([^，,。；;!?！？\n]{1,80}?)\s*[，,；;]\s*(?:而是|应(?:为|该是)|应该是)\s*([^，,。；;!?！？\n]{1,80})/u,
    previousIndex: 1,
    currentIndex: 2,
  },
  {
    pattern:
      /(?:从|原(?:来|先)?(?:是|为)?|旧(?:值|日期|时间|期限)?(?:是|为)?)\s*([^，,。；;!?！？\n]{1,80}?)\s*(?:改(?:成|为|到)|调整(?:成|为|到)|延(?:期)?(?:到|至)|推迟(?:到|至)|提前(?:到|至))\s*([^，,。；;!?！？\n]{1,80})/u,
    previousIndex: 1,
    currentIndex: 2,
  },
  {
    pattern:
      /(?:改(?:成|为|到)|调整(?:成|为|到)|延(?:期)?(?:到|至)|推迟(?:到|至)|提前(?:到|至)|更新(?:成|为)|现在(?:是|为)|最新(?:是|为)|应(?:为|该是))\s*([^，,。；;!?！？\n]{1,80}?)\s*[，,；;]\s*(?:而)?不是\s*([^，,。；;!?！？\n]{1,80})/u,
    previousIndex: 2,
    currentIndex: 1,
  },
];

/**
 * Extracts only reusable, user-authored dilemma evidence shapes. Context and
 * corrections are intentionally just classifications here; the service must
 * still bind them to an already-open dilemma before persisting anything.
 */
export function extractDilemmaTurnEvidence(
  sourceText: string,
): DilemmaTurnEvidence | undefined {
  const text = sourceText.normalize("NFKC").trim();
  const option = text.match(OPTION_EVIDENCE);
  const optionKey = option?.[1];
  const label = option?.[2]?.trim();
  if ((optionKey === "A" || optionKey === "B") && label !== undefined) {
    return {
      kind: "option",
      optionKey,
      optionIndex: optionKey === "A" ? 0 : 1,
      label: label.slice(0, 160),
    };
  }

  if (CORRECTION_CUE.test(text)) {
    const replacement = extractDilemmaFactCorrection(text);
    return {
      kind: "correction",
      ...(replacement === undefined ? {} : { replacement }),
    };
  }

  return CONTEXT_EVIDENCE.some((pattern) => pattern.test(text))
    ? { kind: "context" }
    : undefined;
}

export function applyDilemmaEvidenceToOptions(
  options: readonly DilemmaOption[],
  evidence: DilemmaTurnEvidence,
  sourceText: string,
): DilemmaOption[] {
  const next = options.map((option) => ({
    ...option,
    likelyTradeoffs: [...option.likelyTradeoffs],
    valuesAtStake: [...option.valuesAtStake],
  }));
  if (evidence.kind === "option") {
    const current = next[evidence.optionIndex];
    if (current === undefined) return next;
    next[evidence.optionIndex] = {
      ...current,
      label: evidence.label,
      description: sourceText,
      likelyTradeoffs: extractDilemmaTradeoffFacts(sourceText),
      valuesAtStake: inferDilemmaValues(sourceText),
    };
    return next;
  }

  if (evidence.kind !== "correction" || evidence.replacement === undefined) {
    return next;
  }
  const targetIndex = correctionTargetIndex(
    next,
    evidence.replacement.previousValue,
    sourceText,
  );
  if (targetIndex === undefined) return next;
  const target = next[targetIndex]!;
  const replace = (value: string): string =>
    replaceEquivalentFragment(
      value,
      evidence.replacement!.previousValue,
      evidence.replacement!.currentValue,
    );
  next[targetIndex] = {
    ...target,
    label: replace(target.label),
    description: replace(target.description),
    likelyTradeoffs: target.likelyTradeoffs.map(replace),
    valuesAtStake: target.valuesAtStake.map(replace),
  };
  return next;
}

/**
 * Returns true only when a parsed correction names an old value that is
 * actually present in one of the dilemma options. This keeps generic
 * correction language from attaching to whichever open dilemma happens to be
 * newest.
 */
export function dilemmaCorrectionMatchesOptions(
  options: readonly DilemmaOption[],
  evidence: DilemmaTurnEvidence,
  sourceText: string,
): boolean {
  return (
    evidence.kind === "correction" &&
    evidence.replacement !== undefined &&
    correctionTargetIndex(
      options,
      evidence.replacement.previousValue,
      sourceText,
    ) !== undefined
  );
}

export function inferDilemmaValues(text: string): string[] {
  const values: string[] = [];
  if (/稳定|收入|工作|辞职|转行/u.test(text)) values.push("稳定与成长");
  if (/家人|伴侣|关系|分手|朋友/u.test(text)) values.push("关系与自我尊重");
  if (/梦想|喜欢|热爱|创作/u.test(text)) values.push("意义与自我实现");
  if (/累|健康|休息|压力/u.test(text)) values.push("健康与可持续性");
  return values.length === 0 ? ["当前安稳与未来可能性"] : values;
}

export function extractDilemmaTradeoffFacts(text: string): string[] {
  const facts = text
    .split(/[；;。]/u)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length > 0 &&
        /但|较低|较少|低一些|少一些|不稳定|合同|搬家|通勤|成本|麻木|担心|代价|风险/u.test(
          part,
        ),
    )
    .map((part) => part.slice(0, 240));
  return facts.length === 0
    ? ["这个方向同时包含收益、不确定性与需要承担的代价"]
    : facts.slice(0, 12);
}

function extractDilemmaFactCorrection(
  text: string,
): DilemmaFactCorrection | undefined {
  for (const candidate of CORRECTION_PATTERNS) {
    const match = text.match(candidate.pattern);
    const previousValue = cleanCorrectionValue(
      match?.[candidate.previousIndex],
    );
    const currentValue = cleanCorrectionValue(match?.[candidate.currentIndex]);
    if (
      previousValue !== undefined &&
      currentValue !== undefined &&
      !equivalentText(previousValue, currentValue)
    ) {
      return { previousValue, currentValue };
    }
  }
  return undefined;
}

function cleanCorrectionValue(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/^(?:是|为)\s*/u, "").trim();
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

function correctionTargetIndex(
  options: readonly DilemmaOption[],
  previousValue: string,
  sourceText: string,
): number | undefined {
  const candidates = options
    .map((option, index) => ({
      index,
      option,
      containsPrevious: optionText(option).some((value) =>
        containsEquivalentFragment(value, previousValue),
      ),
    }))
    .filter((candidate) => candidate.containsPrevious);
  if (candidates.length === 0) return undefined;
  return candidates.sort(
    (left, right) =>
      optionCorrectionRelevance(right.option, sourceText) -
      optionCorrectionRelevance(left.option, sourceText),
  )[0]?.index;
}

function optionText(option: DilemmaOption): string[] {
  return [
    option.label,
    option.description,
    ...option.likelyTradeoffs,
    ...option.valuesAtStake,
  ];
}

function optionCorrectionRelevance(
  option: DilemmaOption,
  sourceText: string,
): number {
  const evidence = normalizeComparable(sourceText);
  return Math.max(
    ...optionText(option).map((value) =>
      longestCommonSubstringLength(evidence, normalizeComparable(value)),
    ),
  );
}

function containsEquivalentFragment(text: string, fragment: string): boolean {
  return equivalentFragmentPattern(fragment).test(text.normalize("NFKC"));
}

function replaceEquivalentFragment(
  text: string,
  previousValue: string,
  currentValue: string,
): string {
  return text
    .normalize("NFKC")
    .replace(equivalentFragmentPattern(previousValue, true), currentValue);
}

function equivalentFragmentPattern(fragment: string, global = false): RegExp {
  const pattern = fragment
    .normalize("NFKC")
    .trim()
    .split(/\s+/u)
    .map(escapeRegExp)
    .join("\\s*");
  return new RegExp(pattern, global ? "gu" : "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function equivalentText(left: string, right: string): boolean {
  return normalizeComparable(left) === normalizeComparable(right);
}

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "");
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
