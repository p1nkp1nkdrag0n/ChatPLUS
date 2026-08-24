export interface ExplicitReplyConstraints {
  /** Maximum number of distinct advice items explicitly allowed by the user. */
  readonly maxAdvicePoints?: number;
  /** The user explicitly asked the reply to contain actionable advice. */
  readonly requiresAdviceResponse?: true;
  /** A hard sentence ceiling only when the user explicitly asks for brevity. */
  readonly maxSentences?: number;
  /** A hard sentence floor only when the user explicitly requests a range. */
  readonly minSentences?: number;
  /** Exact user-requested duration for an actionable preparation plan. */
  readonly requiredPreparationMinutes?: number;
  /** The user explicitly requested concrete preparation steps or a plan. */
  readonly requiresPreparationPlan?: boolean;
  /** The user explicitly asked for their feelings to be acknowledged first. */
  readonly requiresEmotionalAcknowledgement?: boolean;
  readonly concise: boolean;
  /** The user explicitly closed the previous topic before asking something new. */
  readonly topicSwitch: boolean;
  /** The user explicitly closed the topic or declined any further check-in. */
  readonly forbidFollowUpQuestions?: boolean;
}

export interface ExplicitAdvicePointAudit {
  readonly count: number;
  readonly method:
    | "numbered_or_markdown_list"
    | "chinese_ordinals"
    | "semicolon_advice_items"
    | "punctuated_advice_items"
    | "single_advice_cue"
    | "none";
}

/**
 * Extracts only high-precision, user-authored reply constraints. These are
 * presentation constraints, never authority to mutate state.
 */
export function deriveExplicitReplyConstraints(
  userMessage: string,
): ExplicitReplyConstraints {
  const normalized = userMessage.normalize("NFKC");
  const explicitDiscussionStop =
    /(?:^|[，,。！？!?；;\n]\s*)我(?:现在|暂时)?\s*(?:不想|不愿(?:意)?|不打算)\s*(?:再|继续)?\s*(?:聊|谈|说)(?:这个|这件事|这事|它|刚才的(?:事|话题)?|之前的(?:事|话题)?)?(?:了)?(?=$|[，,。！？!?；;\s])/u.test(
      normalized,
    ) ||
    /\bI\s+(?:do\s+not|don't)\s+want\s+to\s+(?:keep|continue)\s+(?:talking|discussing)(?:\s+about)?\s+(?:this|it)\b/iu.test(
      normalized,
    );
  const explicitNoFollowUp =
    /(?:^|[，,。！？!?；;\n]\s*)(?:但|不过|但是|也|请)?\s*(?:别|不要|不用|不必)\s*(?:再|继续)?\s*(?:问|追问|跟进|关心)(?:我)?/u.test(
      normalized,
    ) ||
    /\b(?:please\s+)?(?:do\s+not|don't)\s+(?:ask|follow\s+up|check\s+in)(?:\s+with\s+me)?\s+again\b/iu.test(
      normalized,
    );
  const topicSwitch =
    /(?:^|[，。！？!?\s])(?:好[，,]?\s*)?(?:先|暂时)?(?:不再?|别再?)(?:聊|谈|说)(?:这个|这件事|它|刚才的(?:事|话题)?|之前的(?:事|话题)?)(?:了)?/u.test(
      normalized,
    ) ||
    /(?:换|切|转)(?:一)?个(?:新)?话题|(?:先|暂时)(?:放下|跳过|略过)(?:这个|这件事|刚才的(?:事|话题)?)/u.test(
      normalized,
    ) ||
    explicitDiscussionStop;
  const concise =
    /(?:很短|简短|精简|简要|一句话|不要展开|别展开|不展开|brief|concise|short)/iu.test(
      normalized,
    );
  const adviceRequested = /建议|办法|怎么做|可以做什么|advice|suggest/iu.test(
    normalized,
  );
  const adviceRefused =
    /(?:不想|不需要|无需|无须).{0,8}(?:听|要|给|来|谈)?(?:建议|办法)|(?:不要|别)(?:再|马上|现在)?(?:给|提|说|讲|来|谈).{0,8}(?:建议|办法)/u.test(
      normalized,
    );
  const requiresAdviceResponse =
    !adviceRefused &&
    (/(?:^|[，,。！？!?；;\n]\s*)(?:(?:现在|这次|接下来)\s*)?我?\s*(?:愿意听(?:听)?|想听(?:听)?)(?:你(?:给|提|说)(?:的)?|你的)?\s*(?:一个|一点|一些|几(?:点|条|个))?\s*(?:(?:很短|简短)(?:的)?)?\s*(?:建议|办法)(?=$|[，,。！？!?；;\s]|但)|(?:^|[，,。！？!?；;\n]\s*)(?:(?:请|麻烦)\s*)?(?:你\s*)?(?:(?:能不能|能否|可不可以)\s*)?(?:直接\s*)?(?:给我|帮我想|替我想)\s*(?:一个|一点|一些|几(?:点|条|个))?\s*(?:(?:很短|简短)(?:的)?)?\s*(?:建议|办法)|(?:^|[，,。！？!?；;\n]\s*)(?:(?:请|麻烦)\s*)?(?:你\s*)?(?:直接\s*)?(?:给|提|说)\s*(?:我)?\s*(?:一|两|二|三|几|\d+)?\s*(?:点|条|个)?\s*(?:(?:很短|简短)(?:的)?)?\s*(?:建议|办法)/u.test(
      normalized,
    ) ||
      /\b(?:(?:please\s+)?(?:give|offer)\s+me|I(?:'d|\s+would)\s+like(?:\s+to\s+hear)?|I\s+am\s+ready\s+to\s+hear)\s+(?:(?:a|some)\s+)?(?:brief\s+|short\s+)?(?:advice|suggestions?)\b/iu.test(
        normalized,
      ));
  const adviceLimitMatch =
    /(?:不(?:要)?|别)?(?:多于|超过|超出)\s*([一二两三四五六七八九十\d]+)\s*(?:点|条|个)/u.exec(
      normalized,
    );
  const maxAdvicePoints = adviceRequested
    ? parseBoundedCount(adviceLimitMatch?.[1])
    : undefined;
  const oneSentence = /(?:只用|用|就用)?一句话/u.test(normalized);
  const twoOrThreeSentences =
    /(?:两|二)\s*(?:到|至|-|—)?\s*三\s*(?:句|句话)|2\s*(?:到|至|-|—)\s*3\s*(?:句|sentences?)/iu.test(
      normalized,
    );
  const maxSentences = oneSentence
    ? 1
    : twoOrThreeSentences
      ? 3
      : concise && maxAdvicePoints !== undefined
        ? Math.min(4, maxAdvicePoints + 1)
        : undefined;
  const minSentences = twoOrThreeSentences ? 2 : undefined;
  const preparationRequest = explicitPreparationRequest(normalized);
  const requiresEmotionalAcknowledgement =
    /(?:先|首先)(?:回应|照顾|接住|理解|安慰)(?:一下)?(?:我的|我现在的)?(?:感受|情绪)|(?:先|首先)(?:回应|理解|安慰)我(?:的)?(?:感受|情绪)/u.test(
      normalized,
    );

  return {
    concise: concise || maxAdvicePoints !== undefined || twoOrThreeSentences,
    topicSwitch,
    ...(explicitDiscussionStop || explicitNoFollowUp
      ? { forbidFollowUpQuestions: true }
      : {}),
    ...(maxAdvicePoints === undefined ? {} : { maxAdvicePoints }),
    ...(requiresAdviceResponse ? { requiresAdviceResponse: true } : {}),
    ...(maxSentences === undefined ? {} : { maxSentences }),
    ...(minSentences === undefined ? {} : { minSentences }),
    ...(preparationRequest === undefined
      ? {}
      : {
          requiredPreparationMinutes: preparationRequest.minutes,
          requiresPreparationPlan: true,
        }),
    ...(requiresEmotionalAcknowledgement
      ? { requiresEmotionalAcknowledgement: true }
      : {}),
  };
}

/**
 * Counts structurally distinct advice items without trusting a model's
 * self-reported point count. Shared by generation validation and acceptance
 * auditing so both enforce the same user-authored ceiling.
 */
export function detectExplicitAdvicePoints(
  text: string,
): ExplicitAdvicePointAudit {
  const listCount = countStructuredAdviceItems(
    text,
    /(?:^|[\n；;。！？!?：:])\s*(?:(?:\d{1,2}|[一二三四五六七八九十])[.、)，,]|[（(](?:\d{1,2}|[一二三四五六七八九十])[）)]|[-*]\s+)(?=\s*(?!\d)\S)/gmu,
  );
  if (listCount > 0) {
    return { count: listCount, method: "numbered_or_markdown_list" };
  }

  const ordinalCount = countStructuredAdviceItems(
    text,
    /(?:^|[\n；;。！？!?：:])\s*第(?:一|二|三|四|五|六|七|八|九|十)(?:(?:点)\s*[、，,:：.。]?|[、，,:：.。])\s*(?=\S)/gmu,
  );
  if (ordinalCount > 0) {
    return { count: ordinalCount, method: "chinese_ordinals" };
  }

  const strongClauses = text
    .split(/[；;。！？!?\n]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const declaredItems = declaredAdvicePointItems(strongClauses);
  if (declaredItems.length > 0) {
    return {
      count: declaredItems.length,
      method: /[；;]/u.test(text)
        ? "semicolon_advice_items"
        : "punctuated_advice_items",
    };
  }

  const punctuatedItems = strongClauses.filter(hasAdviceDirective);
  if (punctuatedItems.length > 1) {
    return {
      count: punctuatedItems.length,
      method: /[；;]/u.test(text)
        ? "semicolon_advice_items"
        : "punctuated_advice_items",
    };
  }

  if (punctuatedItems.length === 1) {
    return { count: 1, method: "single_advice_cue" };
  }
  return { count: 0, method: "none" };
}

function countStructuredAdviceItems(text: string, pattern: RegExp): number {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return 0;

  return matches.reduce((count, match, index) => {
    const payloadStart = (match.index ?? 0) + match[0].length;
    const payloadEnd = matches[index + 1]?.index ?? text.length;
    const payload = text.slice(payloadStart, payloadEnd).trim();
    return count + (hasEnumeratedAdviceAction(payload) ? 1 : 0);
  }, 0);
}

function declaredAdvicePointItems(clauses: readonly string[]): string[] {
  const introPattern =
    /(?:^|[，,:：\s])(?:(?:(?:我)?(?:就|只|简单|简短|先)?(?:说|给|提|列)(?:个|出)?)|那就|就)(?:一|二|两|三|四|五|六|七|八|九|十|\d{1,2})点(?:建议)?/u;
  const introIndex = clauses.findIndex((clause) => introPattern.test(clause));
  if (introIndex < 0) return [];

  const introClause = clauses[introIndex] ?? "";
  const introMatch = introPattern.exec(introClause);
  const tail =
    introMatch === null
      ? ""
      : introClause
          .slice(introMatch.index + introMatch[0].length)
          .replace(/^[，,:：\s]+/u, "")
          .trim();
  return [tail, ...clauses.slice(introIndex + 1)].filter(
    (item) => item !== "" && hasEnumeratedAdviceAction(item),
  );
}

function hasEnumeratedAdviceAction(text: string): boolean {
  const normalized = text
    .normalize("NFKC")
    .trim()
    .replace(/^[，,:：、.\s]+/u, "");
  if (
    /^[，,:：、.\s]*(?:我|我们|本人)(?:已经|都|曾经|刚刚|刚|之前|以前)?(?:提前|准备|练习|熟悉|去|到|看|写|讲|说|做|深呼吸|放慢|停).{0,12}(?:了|过).{0,12}(?:[。！？，,；;]|$)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^[，,:：、.\s]*(?:我|我们|本人)(?:正在|正|在)(?:提前|准备|练习|熟悉|去|到|看|写|讲|说|做|深呼吸|放慢|停)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  if (hasNonDirectiveAdviceFrame(normalized)) {
    return false;
  }
  if (
    /你(?:已经|都|早就).{0,8}(?:准备|练习|熟悉).{0,8}(?:了|好|很久)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  if (hasAdviceDirective(normalized)) return true;
  if (
    /(?:我|我们|本人).{0,8}(?:会|曾|也|还|没|去|做|说|讲)/u.test(normalized)
  ) {
    return false;
  }
  return /(?:练熟|熟悉|练习|准备|早点(?:去|到)|提前(?:去|到)|放慢|慢点|慢慢(?:说|讲)|深呼吸|停(?:一下|一会儿?)|写下|拆成|盯着|看着|看(?:一眼|一下)|带上|喝(?:口|点)?水|检查|确认|复习|(?:卡住|忘词|紧张)(?:时|的时候)?就(?:停|呼吸|放慢))/u.test(
    normalized,
  );
}

function hasNonDirectiveAdviceFrame(text: string): boolean {
  return (
    /^[，,:：、.\s]*(?:(?:他|她|他们|她们|老师|朋友|同事|家人|别人).{0,12}(?:建议|让|叫|告诉|说|认为|觉得)|(?:据|按照).{0,10}(?:建议|说法))/u.test(
      text,
    ) ||
    /(?:不适合我|对我(?:没用|无效|不管用)|不是我(?:的)?.{0,8}(?:做法|方法|建议|习惯)|我反而.{0,8}(?:更|会)?(?:慌|紧张|焦虑|不安|难受)|反而.{0,8}(?:让我|使我|令我)|(?:让我|使我|令我).{0,8}(?:更|很|会)?(?:紧张|难受|头晕|焦虑|不安))/u.test(
      text,
    )
  );
}

function hasAdviceDirective(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  if (
    /^(?:可以说|这么说|也就是说)[，,]/u.test(normalized) ||
    /^(?:先)?(?:不|别)(?:展开|细说|多说|说了|聊了)(?:[。.!！]|$)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  const experienceFramed =
    /(?:让我|使我|令我|这件事|是我(?:上次|之前|以前)|我(?:上次|之前|以前|还)?(?:没|不会|不太会)|我会|(?:是|属于).{0,10}(?:做法|方法|习惯|经验)|(?:这种|这个)方法.{0,10}(?:不适合|不管用)|不适合我)/u.test(
      normalized,
    ) || hasNonDirectiveAdviceFrame(normalized);
  return (
    (!experienceFramed &&
      /(?:^|[，,:：；;。！？!?\s]|[时前后])(?:把|别(?!人)|不要|避免|留出|放慢|深呼吸|慢点(?:说|讲)|慢一点(?:说|讲)|只(?:要|需|管|想|看|做|记|说|听))/u.test(
        normalized,
      )) ||
    /(?:^|[，,:：；;。！？!?\s])(?:你)?(?:可以|不妨|最好|尽量|记得|务必|请|先|再|然后|接着|最后|试着|试试)(?:先|再)?(?:把|别(?!人)|不要|避免|留出|放慢|深呼吸|呼吸|提前|熟悉|练习|准备|踩点|到场|检查|确认|看|盯|停|写|拆|定|说|讲|听|带|喝|只(?:要|需|管|想|看|做|记|说|听)|允许自己|给自己|不(?:急|忙|做|想|管))/u.test(
      normalized,
    ) ||
    /^[，,:：、.\s]*(?:我)?(?:建议|推荐)(?:你)?(?:先|可以|试着)?(?:把|别(?!人)|不要|避免|留出|放慢|深呼吸|呼吸|提前|熟悉|练习|准备|踩点|到场|检查|确认|看|盯|停|写|拆|定|说|讲|听|带|只(?:要|需|管|想|看|做|记|说|听)|允许自己|给自己)/u.test(
      normalized,
    ) ||
    /^(?:我觉得|我想)(?:你)?(?:可以|不妨|最好|尽量|先|试着)(?:先|再)?(?:把|别(?!人)|不要|避免|留出|放慢|深呼吸|呼吸|提前|熟悉|练习|准备|踩点|到场|检查|确认|看|盯|停|写|拆|定|说|讲|听|带|喝|只(?:要|需|管|想|看|做|记|说|听)|允许自己|给自己)/u.test(
      normalized,
    ) ||
    (!experienceFramed &&
      (/(?:^|[，,:：；;。！？!?\s]|[时前后])准备(?:一句|一个|一份|好|下|开头|结尾|讲稿|提纲|内容|材料|设备)/u.test(
        normalized,
      ) ||
        /^(?:另外|还有|再者|其次)?提前.{0,18}(?:熟悉|练习|准备|踩点|到(?:现)?场|站上台|检查|确认|过一遍)/u.test(
          normalized,
        ) ||
        /^(?:讲|分享|上台|发言|答辩).{0,8}(?:时|的时候)(?:就|先|可以)?(?:预设|准备|留出|深呼吸|呼吸|看|放慢)/u.test(
          normalized,
        ))) ||
    (!experienceFramed &&
      (/^(?:紧张|焦虑|慌|卡壳|忘词)(?:时|的时候)?(?:就|先|可以)?(?:深呼吸|呼吸|慢点|慢一点|放慢|停一下)/u.test(
        normalized,
      ) ||
        /^(?:如果|要是|一旦).{0,20}[，,]?(?:就|先|可以)?(?:深呼吸|呼吸|慢点|慢一点|放慢|停一下|把|别(?!人)|不要)/u.test(
          normalized,
        ) ||
        /^(?:允许自己|给自己(?:一点|一些)?|深呼吸|慢点(?:说|讲)|慢一点(?:说|讲))/u.test(
          normalized,
        )))
  );
}

function explicitPreparationRequest(
  text: string,
): { minutes: number } | undefined {
  const clauses = text
    .split(/[。！？!?；;\n]+/u)
    .map((clause) => clause.trim());
  for (const clause of clauses) {
    if (
      !/(?:请|能否|能不能|可不可以|可以(?:请)?|请你|帮我|陪我|麻烦你|我们(?:一起)?)/u.test(
        clause,
      ) ||
      !/(?:梳理|制定|列(?:出)?|安排|规划|做(?:个|一份)?|拆成|演练)/u.test(
        clause,
      ) ||
      !/(?:准备|步骤|计划|练习|演练)/u.test(clause)
    ) {
      continue;
    }
    const duration =
      /([零一二两三四五六七八九十百\d]{1,4})\s*(?:个)?分钟/u.exec(clause)?.[1];
    const minutes = parseMinuteCount(duration);
    if (minutes !== undefined) return { minutes };
  }
  return undefined;
}

function parseMinuteCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const digit = Number.parseInt(value, 10);
  if (Number.isInteger(digit)) {
    return digit >= 1 && digit <= 180 ? digit : undefined;
  }
  const digits: Record<string, number> = {
    零: 0,
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
  if (value === "十") return 10;
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[value.slice(0, tenIndex)];
    const ones =
      tenIndex === value.length - 1 ? 0 : digits[value.slice(tenIndex + 1)];
    if (tens !== undefined && ones !== undefined) {
      const parsed = tens * 10 + ones;
      return parsed >= 1 && parsed <= 180 ? parsed : undefined;
    }
  }
  const single = digits[value];
  return single !== undefined && single >= 1 ? single : undefined;
}

function parseBoundedCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const digit = Number.parseInt(value, 10);
  if (Number.isInteger(digit)) return Math.max(1, Math.min(9, digit));
  const chinese: Record<string, number> = {
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
    十: 10,
  };
  const parsed = chinese[value];
  return parsed === undefined ? undefined : Math.min(9, parsed);
}
