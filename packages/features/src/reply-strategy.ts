export type ReplyComplexity = "brief" | "standard" | "complex" | "deep";

export type ReplyDeliveryPreference =
  "prefer_single_block" | "prefer_sequential" | "choose_naturally";

export interface ReplyDialogueStyleLike {
  verbosity?: number;
  averageMessageLength?: number;
  averageChunksPerTurn?: number;
  formality?: number;
  directness?: number;
}

export interface ReplyStrategy {
  complexity: ReplyComplexity;
  targetMinChars: number;
  targetChars: number;
  targetMaxChars: number;
  maxOutputTokens: number;
  deliveryPreference: ReplyDeliveryPreference;
  preferredChunkCount: number;
  lengthGuidance: string;
  deliveryGuidance: string;
}

const BRIEF_REQUEST =
  /(?:简短(?:点|一点)?|简单说|一句话|一两句|只说(?:结论|重点)|别展开|不要展开|brief(?:ly)?|short answer)/iu;
const NEGATED_BRIEF_REQUEST =
  /(?:(?:不要|别|并非|不是|不想|无需|不必)[^，,。；;.!?！？]{0,8}(?:简短|简单说|一句话|一两句|只说|短回答)|\b(?:not|isn't|is not|don't|do not)\b[^,.;:!?]{0,12}\b(?:brief|short)\b)/iu;
const DETAILED_REQUEST =
  /(?:详细|展开(?:说|讲|分析)?|深入|全面|具体(?:说|讲|分析)|逐步|一步一步|系统地|长一点|多说(?:一点)?|elaborate|in detail|step[- ]by[- ]step)/iu;
const DEEP_REQUEST =
  /(?:从零开始|完整方案|完整故事|长篇|深度分析|系统性分析|利弊与取舍|多角度|详细规划|完整设计|thorough|comprehensive)/iu;
const NEGATED_LONG_REQUEST =
  /(?:(?:不要|别|不用|无需|无须|不必|不想|并非)[^，,。；;.!?！？]{0,8}(?:详细|展开|深入|全面|具体|逐步|一步一步|系统|长篇|完整|深度|多角度)|\b(?:not|don't|do not|no need to|without)\b[^,.;:!?]{0,18}\b(?:detail(?:ed)?|elaborat(?:e|ion)|thorough|comprehensive|step[- ]by[- ]step)\b)/iu;
const ANALYTICAL_REQUEST_ZH =
  /(?:为什么|为何|原因|怎么(?:办|做|实现)|如何|分析|解释|比较|区别|优缺点|建议|规划|设计|架构|方案|步骤|取舍|影响|难点|问题|评价|总结|归纳)/u;
const ANALYTICAL_REQUEST_EN =
  /\b(?:what|why|how|compare|explain|analy[sz](?:e|is|ing)|recommend(?:ation)?s?|plan(?:ning)?|design|architecture|trade-?offs?|steps?|risks?)\b/iu;
const GREETING_OR_ACK =
  /^(?:你?好|嗨|哈[喽啰]|早上好|早安|午安|晚上好|晚安|在吗|谢谢|好的|好呀|嗯+|哦+|收到|hello|hi|hey|thanks)[!！。.，,～~ ]*$/iu;

/**
 * Produces a soft response budget. It deliberately avoids hard output-length
 * validation: a truthful, in-character answer is more important than hitting
 * an exact character count.
 */
export function deriveReplyStrategy(
  userMessage: string,
  dialogue: ReplyDialogueStyleLike,
): ReplyStrategy {
  const text = userMessage.trim();
  const negatedLongRequest = NEGATED_LONG_REQUEST.test(text);
  const explicitDetail = DETAILED_REQUEST.test(text) && !negatedLongRequest;
  const explicitDeep = DEEP_REQUEST.test(text) && !negatedLongRequest;
  const explicitBrief =
    BRIEF_REQUEST.test(text) &&
    !NEGATED_BRIEF_REQUEST.test(text) &&
    !explicitDetail &&
    !explicitDeep;

  let score = 0;
  if (text.length >= 70) score += 1;
  if (text.length >= 180) score += 1;
  if (ANALYTICAL_REQUEST_ZH.test(text) || ANALYTICAL_REQUEST_EN.test(text))
    score += 2;
  if (explicitDetail) score += 2;
  if (explicitDeep) score += 2;
  if ((text.match(/[?？]/gu) ?? []).length >= 2) score += 1;
  if (
    (
      text.match(/(?:第一|第二|另外|同时|以及|并且|但是|不过|而且|;|；)/gu) ??
      []
    ).length >= 2
  )
    score += 1;

  let complexity: ReplyComplexity;
  if (explicitBrief || (text.length <= 24 && GREETING_OR_ACK.test(text))) {
    complexity = "brief";
  } else if (explicitDeep || score >= 4) {
    complexity = "deep";
  } else if (score >= 2) {
    complexity = "complex";
  } else {
    complexity = "standard";
  }

  const verbosity = clamp(dialogue.verbosity ?? 0.5, 0, 1);
  const averageLength = clamp(
    Math.round(dialogue.averageMessageLength ?? 140),
    24,
    1_200,
  );
  const personaBaseline = averageLength * (0.7 + verbosity * 0.9);
  const target = targetFor(complexity, personaBaseline);
  const range = rangeFor(complexity, target);
  const preferredChunkCount = clamp(
    Math.round(dialogue.averageChunksPerTurn ?? 1),
    1,
    12,
  );
  const deliveryPreference = deliveryPreferenceFor(dialogue);

  return {
    complexity,
    targetMinChars: range.minimum,
    targetChars: target,
    targetMaxChars: range.maximum,
    // Structured chat may repeat the complete reply once in optional chunks.
    // Budget for that worst case so valid JSON is not truncated mid-response.
    maxOutputTokens: clamp(Math.ceil(range.maximum * 2.2 + 600), 2_000, 8_000),
    deliveryPreference,
    preferredChunkCount,
    lengthGuidance: lengthGuidanceFor(complexity, range.minimum, range.maximum),
    deliveryGuidance: deliveryGuidanceFor(
      deliveryPreference,
      preferredChunkCount,
    ),
  };
}

function targetFor(
  complexity: ReplyComplexity,
  personaBaseline: number,
): number {
  switch (complexity) {
    case "brief":
      return clamp(Math.round(personaBaseline * 0.6), 30, 160);
    case "standard":
      return clamp(Math.round(personaBaseline * 1.25), 80, 420);
    case "complex":
      return clamp(Math.round(personaBaseline * 3.2), 220, 900);
    case "deep":
      return clamp(Math.round(personaBaseline * 5.2), 360, 1_600);
  }
}

function rangeFor(
  complexity: ReplyComplexity,
  target: number,
): { minimum: number; maximum: number } {
  switch (complexity) {
    case "brief":
      return {
        minimum: clamp(Math.round(target * 0.55), 20, 100),
        maximum: clamp(Math.round(target * 1.7), 60, 240),
      };
    case "standard":
      return {
        minimum: clamp(Math.round(target * 0.65), 50, 300),
        maximum: clamp(Math.round(target * 1.55), 120, 650),
      };
    case "complex":
      return {
        minimum: clamp(Math.round(target * 0.68), 160, 650),
        maximum: clamp(Math.round(target * 1.55), 360, 1_400),
      };
    case "deep":
      return {
        minimum: clamp(Math.round(target * 0.68), 260, 1_100),
        maximum: clamp(Math.round(target * 1.55), 600, 2_500),
      };
  }
}

function deliveryPreferenceFor(
  dialogue: ReplyDialogueStyleLike,
): ReplyDeliveryPreference {
  const chunks = dialogue.averageChunksPerTurn ?? 1;
  if (chunks >= 1.6) return "prefer_sequential";
  if (chunks <= 1.2) return "prefer_single_block";

  const formality = dialogue.formality ?? 0.5;
  const directness = dialogue.directness ?? 0.5;
  if (formality >= 0.72 && directness <= 0.55) return "prefer_single_block";
  if (formality <= 0.42 && directness >= 0.58) return "prefer_sequential";
  return "choose_naturally";
}

function lengthGuidanceFor(
  complexity: ReplyComplexity,
  minimum: number,
  maximum: number,
): string {
  const intent = {
    brief: "This is a brief social or explicitly concise turn.",
    standard: "This is an ordinary conversational turn.",
    complex:
      "This question benefits from explanation, reasoning or practical detail.",
    deep: "This request calls for a fuller, structured or nuanced response.",
  }[complexity];
  return `${intent} A natural soft target is about ${minimum}-${maximum} characters in the character's primary language. This is guidance, not a quota: answer completely, stop when the thought is complete, and never pad, repeat, or cut off useful substance merely to hit the range.`;
}

function deliveryGuidanceFor(
  preference: ReplyDeliveryPreference,
  preferredChunkCount: number,
): string {
  const personaHint = {
    prefer_single_block:
      "This character usually sends one coherent block, but may split an unusually spontaneous exchange when that feels more authentic.",
    prefer_sequential: `This character often chats in a message-by-message rhythm (typically around ${preferredChunkCount} chunks), but may use one coherent block for a connected explanation.`,
    choose_naturally:
      "This character has no strong default; choose the delivery that best fits their persona and this moment.",
  }[preference];
  return `${personaHint} Use single_block for one continuous message. Use sequential when the character would naturally send several separate chat bubbles, with each chunk containing one complete short beat or sentence. Delivery is a style decision, not a way to shorten the answer.`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
