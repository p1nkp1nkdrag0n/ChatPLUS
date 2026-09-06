import type { DilemmaEpisode, DilemmaOption } from "@personasim/contracts";

export interface DilemmaChoiceEvidence {
  labels: [string, string];
  /** A single labelled option can be introduced before its counterpart. */
  incomplete: boolean;
}

const UNEXPLAINED = ["选项 A（尚未说明）", "选项 B（尚未说明）"] as const;
const STOP_WORDS = new Set([
  "现在",
  "今天",
  "今晚",
  "这次",
  "这个",
  "这件",
  "事情",
  "问题",
  "决定",
  "选择",
  "选项",
  "方向",
  "当前",
  "暂时",
  "自己",
  "已经",
  "还是",
  "之间",
  "应该",
  "可以",
  "可能",
  "需要",
  "具体",
  "分析",
  "比较",
  "建议",
  "推荐",
  "授权",
  "明确",
  "正式",
  "直接",
  "一个",
  "两个",
  "什么",
  "怎么",
  "知道",
  "觉得",
  "希望",
  "时候",
  "未来",
  "以后",
  "之前",
  "继续",
  "维持",
  "现状",
  "讨论",
  "影响",
  "结果",
  "这条",
  "这份",
  "因为",
  "所以",
  "保留",
  "接受",
  "启动",
  "工作",
  "生活",
  "稳定",
  "收入",
  "风险",
  "代价",
  "分钟",
  "小时",
  "时间",
  "整理",
  "完成",
  "清理",
]);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/** Only user-authored alternatives are admitted; an assistant affirmation is not an option. */
export function extractDilemmaChoices(
  sourceText: string,
  classificationText = sourceText,
): DilemmaChoiceEvidence | undefined {
  const source = sourceText.normalize("NFKC");
  const classification = classificationText.normalize("NFKC");
  const structured = [
    ...classification.matchAll(/选项\s*([AB])\s*(?:是|为|[:：])/gu),
  ];
  if (structured.length > 0) {
    const labels: [string, string] = [...UNEXPLAINED];
    for (const match of structured) {
      const offset = match.index + match[0].length;
      const raw = source
        .slice(offset)
        .match(
          /^\s*(?:“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|[^，,。；;！？!?\n]+)/u,
        )?.[0];
      const label = cleanLabel(raw ?? "");
      if (label) labels[match[1] === "A" ? 0 : 1] = label;
    }
    return { labels, incomplete: labels.some(isUnexplainedOption) };
  }

  // A quote inside an active alternatives frame is the value of that slot.
  // A quotation of the entire frame has no active frame in classification.
  if (
    /(?:在|从|只限|只有).*(?:之间|二选一)|还是|要不要|该不该|是否应该|A\s*[/和与、]\s*B/u.test(
      classification,
    )
  ) {
    const between = source.match(
      /(?:(?<!现)在|从)\s*([^，,。；;！？!?\n]{1,140}?)\s*(?:和|与|、|\/|或)\s*([^，,。；;！？!?\n]{1,140}?)\s*(?:之间|中(?:选|挑)|二选一)/u,
    );
    if (between?.[1] && between[2]) return pair(between[1], between[2]);
    const versus = source.match(
      /(?:到底|不知道|纠结|犹豫|今晚|今天|现在|我|该|要|选|是)*\s*([^，,。；;！？!?\n]{1,120}?)\s*还是\s*([^，,。；;！？!?\n]{1,120})/u,
    );
    if (versus?.[1] && versus[2]) {
      const left = versus[1].replace(
        /^(?:我(?:不知道|正在|在|很)?|不知道|纠结|犹豫|到底|今晚|今天|现在|该|要|选|是)+/u,
        "",
      );
      const right = versus[2].replace(/(?:呢|好呢|比较好|更合适)$/u, "");
      const alternatives =
        /决定权|拍板权|(?:压力|清晰度|心情|状态)$/u.test(left) ||
        /^\d+(?:\.\d+)?\s*\/\s*10|^(?:在我|在你|由我|由你|我自己|你自己|自己决定|自己选)/u.test(
          right,
        )
          ? undefined
          : pair(left, right);
      if (alternatives) return alternatives;
    }
    const binary = source.match(
      /(?:要不要|该不该|是否应该)\s*([^，,。；;！？!?\n]{1,120})/u,
    )?.[1];
    if (binary) {
      const action = cleanLabel(
        binary.replace(/(?:呢|好呢|比较好|更合适)$/u, ""),
      );
      if (action) return pair(action, `不${action}`);
    }
    if (/A\s*(?:和|与|、|\/)\s*B/iu.test(classification))
      return { labels: ["选项 A", "选项 B"], incomplete: true };
  }
  return undefined;
}

export function isUnexplainedOption(label: string): boolean {
  return /尚未说明|待说明|^选项\s*[AB]$/u.test(label);
}

/** Candidate matching requires an actual topic anchor, not recency or a shared support verb. */
export function dilemmaScopeScore(
  dilemma: DilemmaEpisode,
  text: string,
  explicitChoices?: DilemmaChoiceEvidence,
): number {
  const values = dilemma.options
    .filter((option) => !isUnexplainedOption(option.label))
    .map((option) => option.label);
  if (explicitChoices && !explicitChoices.incomplete) {
    const matches = explicitChoices.labels.map((label) =>
      values.map((value) => topicOverlap(label, value)),
    );
    // A yes/no question names one proposition and its negation. Its named
    // proposition can revisit an option whose counterpart uses other wording
    // (for example, "not resign" versus "stay in the current job").
    if (
      comparable(explicitChoices.labels[1]) ===
      `不${comparable(explicitChoices.labels[0])}`
    ) {
      const anchor = Math.max(0, ...(matches[0] ?? []));
      return anchor > 0 ? anchor + 20 : 0;
    }
    const assignments = values.flatMap((_, leftIndex) =>
      values.map((__, rightIndex) => {
        if (leftIndex === rightIndex) return 0;
        const left = matches[0]?.[leftIndex] ?? 0;
        const right = matches[1]?.[rightIndex] ?? 0;
        return left > 0 && right > 0 ? left + right + 20 : 0;
      }),
    );
    return Math.max(0, ...assignments);
  }
  return Math.max(
    0,
    ...[
      dilemma.title,
      ...values,
      ...dilemma.options.flatMap((option) => [
        option.description,
        ...option.valuesAtStake,
      ]),
    ].map((value) => topicOverlap(text, value)),
  );
}

export function isDilemmaContinuation(text: string): boolean {
  if (extractDilemmaChoices(text)?.incomplete === false) return false;
  let remaining = text.replace(/选项\s*[AB]|A\s*[/和与、]\s*B/giu, " ");
  const words = [
    "这次",
    "这件事",
    "这两个选项",
    "这两个方向",
    "这个决定",
    "刚才",
    "上面",
    "前面",
    "价值排序",
    "长期价值",
    "并说明",
    "最符合",
    "哪项",
    "它",
    "决策优先级",
    "选择标准",
    "取舍底线",
    "我",
    "你",
    "请",
    "帮",
    "替",
    "来",
    "把",
    "给",
    "一个",
    "两个",
    "自己",
    "最终",
    "最后",
    "只",
    "先",
    "吧",
    "好",
    "也",
    "不过",
    "但",
    "不",
    "不要",
    "不用",
    "现在",
    "明确",
    "正式",
    "直接",
    "决定权",
    "授权",
    "决定",
    "作出",
    "选择",
    "比较",
    "分析",
    "建议",
    "推荐",
    "供",
    "参考",
    "意见",
    "听",
    "说",
    "解释",
    "认为",
    "保留",
    "拍板",
    "采纳",
    "需要",
    "负责",
    "当作",
    "当",
    "话",
    "答案",
    "视为",
    "责任",
    "是",
    "了",
    "的",
    "在",
    "和",
    "与",
    "之间",
    "陪",
    "一起",
    "切换",
    "从",
    "到",
    "方向",
    "选",
    "哪个",
    "支持",
    "可以",
    "还是",
    "提",
    "这",
    "其实",
    "只当",
    "只把",
    "由",
    "作",
    "一次",
    "今天",
    "只限",
    "这一件事",
    "想",
    "只能",
    "是否",
    "建议一下",
    "仅",
    "必须",
    "如果",
    "二选一",
    "就",
    "只要",
    "假如",
    "由",
    "能",
    "拍板权",
    "此时",
    "只是",
    "还没有接受",
    "听建议",
    "就好",
    "只能",
  ];
  for (const word of words.sort((a, b) => b.length - a.length))
    remaining = remaining.replaceAll(word, " ");
  return remaining.replace(/[\s\p{P}\p{S}]/gu, "").length === 0;
}

/** Returns undefined for no choice, unresolved alternatives, or an ambiguous answer. */
export function matchDilemmaOption(
  dilemma: DilemmaEpisode,
  text: string,
  recommendation = false,
): DilemmaOption | undefined {
  const normalized = text.normalize("NFKC");
  const segments = normalized
    .split(/[。！？!?\n；;，,]/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const explicit = segments.flatMap((part) => {
    const match = part.match(
      /(?:我的(?:决定|建议)(?:是)?|我(?:最终|现在|已经)?(?:决定(?:了)?(?:选择)?|选择(?:了)?|会选|选)|就选|^选择|^选|我建议你|建议你|推荐(?:你)?|优先(?:选择)?|仍认同|保留)(?:[:：\s]*)(.+)/u,
    );
    return match?.[1] &&
      !/^(?:了|是)$/u.test(match[1]) &&
      !/^(?:别|不要|不|如果|假设|例如|请翻译)|还没决定|没有决定|尚未决定|可能|也许/u.test(
        part,
      )
      ? [
          match[1]
            .replace(/^(?:选择|选(?!项))\s*/u, "")
            .replace(/(?:因为|理由是|这样|以便).*/u, ""),
        ]
      : [];
  });
  const choices =
    explicit.length > 0
      ? explicit
      : segments.filter(
          (part) =>
            !/别|不要|不选|不建议|如果|假设|例如|你选|你决定|授权|你可以|都可以|都不错|都挺好|都合适|还没决定|尚未决定|可能|也许/u.test(
              part,
            ),
        );
  const selectedIds = new Set<string>();
  for (const phrase of choices) {
    const marker = phrase
      .match(/^(?:选项\s*)?([AB])(?:[:：\s]|$)/iu)?.[1]
      ?.toUpperCase();
    if (marker) {
      const option = dilemma.options[marker === "A" ? 0 : 1];
      if (option && !isUnexplainedOption(option.label))
        selectedIds.add(option.id);
      continue;
    }
    const scored = dilemma.options
      .filter((option) => !isUnexplainedOption(option.label))
      .map((option) => ({
        option,
        score: Math.max(
          choiceOverlap(phrase, option.label),
          ...(recommendation
            ? [
                topicOverlap(phrase, option.description),
                ...option.valuesAtStake.map((value) =>
                  topicOverlap(phrase, value),
                ),
              ]
            : []),
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    if (
      scored.length === 1 ||
      (explicit.length > 0 &&
        scored[0] &&
        scored[0].score > (scored[1]?.score ?? 0) * 1.5)
    ) {
      selectedIds.add(scored[0]!.option.id);
    }
  }
  if (selectedIds.size !== 1) return undefined;
  return dilemma.options.find((option) => selectedIds.has(option.id));
}

function pair(left: string, right: string): DilemmaChoiceEvidence | undefined {
  const labels: [string, string] = [cleanLabel(left), cleanLabel(right)];
  if (labels[0] === "A" && labels[1] === "B")
    return { labels: ["选项 A", "选项 B"], incomplete: true };
  return labels.every(Boolean) &&
    comparable(labels[0]) !== comparable(labels[1])
    ? { labels, incomplete: false }
    : undefined;
}

function cleanLabel(text: string): string {
  return text
    .trim()
    .replace(/^[“‘"']|[”’"']$/gu, "")
    .trim()
    .slice(0, 160);
}

function comparable(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(
      /(?:出去|出门|到外面|外面)?走(?:一走|走)?(?=.{0,8}(?:分钟|一会|一圈|两圈|吧|$))/gu,
      "散步",
    )
    .replace(/离开(?:当前)?(?:这份|这家|现在的)?(?:工作|公司)|离职/gu, "辞职");
}

function topicTokens(text: string): Set<string> {
  return new Set(
    [...segmenter.segment(comparable(text))]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
      .filter(
        (word) =>
          word.length >= 2 &&
          !/^[\d一二三四五六七八九十百千两]+$/u.test(word) &&
          !STOP_WORDS.has(word),
      ),
  );
}

export function topicOverlap(left: string, right: string): number {
  const leftTokens = topicTokens(left);
  const rightTokens = topicTokens(right);
  return [...leftTokens]
    .filter((word) => rightTokens.has(word))
    .reduce((sum, word) => sum + word.length, 0);
}

function choiceOverlap(text: string, label: string): number {
  const phrase = comparable(text);
  const candidate = comparable(label);
  if (!phrase || !candidate) return 0;
  const negative = /^(?:不|暂不|先不|不要)/u.test(candidate);
  const positiveCandidate = candidate.replace(/^(?:不|暂不|先不|不要)/u, "");
  const explicitlyNegative = new RegExp(
    `(?:不|别|不要|暂不|先不)${escapeRegExp(positiveCandidate)}`,
    "u",
  ).test(phrase);
  if (
    negative !== explicitlyNegative &&
    (phrase.includes(positiveCandidate) || positiveCandidate.includes(phrase))
  )
    return 0;
  if (phrase.includes(candidate) || candidate.includes(phrase))
    return Math.min(phrase.length, candidate.length) + 10;
  return topicOverlap(text, label);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
