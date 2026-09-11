import type { ConversationContextPlan } from "@personasim/contracts";

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
export interface ReplyStrategyContext {
  conversationPlan?: ConversationContextPlan;
  state?: {
    moodValence?: number;
    moodArousal?: number;
    energy: number;
    stress: number;
    socialBattery: number;
    focus?: number;
    sleepDebtMinutes?: number;
  };
  relationship?: {
    closeness: number;
  };
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
  stateGuidance: string;
  affinityPolicyVersion: "single_affinity_v1";
  affinityGuidance: string;
  affinityApplied: boolean;
  lengthOverride:
    "none" | "greeting" | "explicit_brief" | "requested_detail" | "listen";
  reviewUpperChars: number;
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
const QUIET_COMPANY =
  /(?:只想|只要|想要|希望).{0,12}(?:陪我|陪着|陪伴|安静)|(?:先|只)(?:听我说|让我说完)|(?:不想|不要|别|不用).{0,6}(?:分析|建议)/u;

/**
 * Produces a soft response budget. It deliberately avoids hard output-length
 * validation: a truthful, in-character answer is more important than hitting
 * an exact character count.
 */
export function deriveReplyStrategy(
  userMessage: string,
  dialogue: ReplyDialogueStyleLike,
  context: ReplyStrategyContext = {},
): ReplyStrategy {
  const text = userMessage.trim();
  const plan =
    context.conversationPlan?.originalQuery === userMessage
      ? context.conversationPlan
      : undefined;
  const negatedLongRequest = NEGATED_LONG_REQUEST.test(text);
  const helpDeferred = plan?.helpTiming === "after_user_finishes";
  const currentStructuredTask =
    plan?.structuredTaskRequested === true &&
    plan.adviceRequested &&
    plan.supportStyle === "offer_requested_help" &&
    plan.helpTiming === "now";
  const detailPermitted =
    plan === undefined ? !negatedLongRequest : plan.detailedAnalysisRequested;
  const explicitDetail =
    !helpDeferred && DETAILED_REQUEST.test(text) && detailPermitted;
  const explicitDeep =
    !helpDeferred && DEEP_REQUEST.test(text) && detailPermitted;
  const explicitBrief =
    BRIEF_REQUEST.test(text) && !NEGATED_BRIEF_REQUEST.test(text);
  const greeting = text.length <= 24 && GREETING_OR_ACK.test(text);
  const listening =
    !explicitDetail &&
    !explicitDeep &&
    !currentStructuredTask &&
    (helpDeferred || QUIET_COMPANY.test(text));

  let score = 0;
  if (text.length >= 70) score += 1;
  if (text.length >= 180) score += 1;
  if (
    !helpDeferred &&
    (plan?.supportStyle !== "listen" || explicitDetail || explicitDeep) &&
    (ANALYTICAL_REQUEST_ZH.test(text) || ANALYTICAL_REQUEST_EN.test(text))
  )
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
  if (explicitBrief || greeting) {
    complexity = "brief";
  } else if (explicitDeep || score >= 4) {
    complexity = "deep";
  } else if (score >= 2 || currentStructuredTask) {
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
  let target = targetFor(complexity, personaBaseline);
  const affinity = clamp(context.relationship?.closeness ?? 0.1, 0, 1);
  const affinityApplied = complexity === "standard" && !listening;
  const lengthOverride: ReplyStrategy["lengthOverride"] = greeting
    ? "greeting"
    : explicitBrief
      ? "explicit_brief"
      : listening
        ? "listen"
        : complexity === "complex" || complexity === "deep"
          ? "requested_detail"
          : "none";
  if (affinityApplied) {
    const smooth = affinity * affinity * (3 - 2 * affinity);
    target = Math.round(clamp(personaBaseline, 40, 120) * (0.5 + 1.8 * smooth));
  } else if (greeting) {
    target = clamp(Math.round(personaBaseline * 0.22), 8, 24);
  } else if (explicitBrief || listening) {
    target = clamp(Math.round(personaBaseline * 0.4), 16, 48);
  }
  let range = rangeFor(complexity, target);
  let preferredChunkCount = clamp(
    Math.round(dialogue.averageChunksPerTurn ?? 1),
    1,
    12,
  );
  let deliveryPreference = deliveryPreferenceFor(dialogue);

  const runtime = context.state;
  const naturalTurn = complexity === "brief" || complexity === "standard";
  if (
    runtime !== undefined &&
    naturalTurn &&
    !explicitDetail &&
    !explicitDeep
  ) {
    const energy = clamp(runtime.energy, 0, 1);
    const stress = clamp(runtime.stress, 0, 1);
    const socialBattery = clamp(runtime.socialBattery, 0, 1);
    const focus = clamp(runtime.focus ?? 0.5, 0, 1);
    const arousal = clamp(runtime.moodArousal ?? 0.5, 0, 1);
    const sleepDebt = clamp(runtime.sleepDebtMinutes ?? 0, 0, 720) / 720;
    const fatigue = Math.max((1 - energy) * 0.65 + stress * 0.35, sleepDebt);
    if (fatigue >= 0.55) {
      const factor = clamp(1 - (fatigue - 0.45) * 0.4, 0.72, 1);
      target = Math.max(8, Math.round(target * factor));
      range = rangeFor(complexity, target);
      preferredChunkCount = Math.min(
        preferredChunkCount,
        socialBattery < 0.25 ? 1 : 2,
      );
      if (socialBattery < 0.25) deliveryPreference = "prefer_single_block";
    }
    if (socialBattery < 0.25) {
      preferredChunkCount = 1;
      deliveryPreference = "prefer_single_block";
    }
    if (focus < 0.3) {
      target = Math.max(8, Math.round(target * 0.88));
      range = rangeFor(complexity, target);
      preferredChunkCount = Math.min(preferredChunkCount, 2);
    } else if (focus > 0.78 && fatigue < 0.55) {
      target = Math.round(target * 1.05);
      range = rangeFor(complexity, target);
    }
    if (arousal < 0.22) {
      preferredChunkCount = Math.min(preferredChunkCount, 2);
    } else if (
      arousal > 0.78 &&
      energy > 0.5 &&
      socialBattery > 0.5 &&
      deliveryPreference !== "prefer_single_block"
    ) {
      preferredChunkCount = Math.min(12, preferredChunkCount + 1);
    }
  }

  if (complexity === "brief" || complexity === "standard" || listening) {
    range = {
      minimum: Math.max(1, Math.round(target * 0.65)),
      maximum: Math.max(target, Math.round(target * 1.55)),
    };
  }

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
    stateGuidance: stateGuidanceFor(runtime),
    affinityPolicyVersion: "single_affinity_v1",
    affinityGuidance: affinityGuidanceFor(affinity),
    affinityApplied,
    lengthOverride,
    reviewUpperChars: Math.max(Math.ceil(target * 1.6), target + 16),
  };
}

function affinityGuidanceFor(affinity: number): string {
  const expression =
    affinity < 0.25
      ? "Keep polite personal distance. Acknowledge the current point with one short, complete thought; do not volunteer several topics, advice branches or questions."
      : affinity < 0.55
        ? "Speak with growing ease. You may add one relevant thought or gentle follow-up when it fits the user's request."
        : affinity < 0.8
          ? "Show comfortable personal concern. Follow the same topic one layer further and express a grounded personal attitude when useful."
          : "Speak with relaxed familiarity and willingness to engage. You may share a grounded attitude or specific concern and develop the current topic naturally, without repetitive reassurance or padding.";
  return `${expression} This is present relational expression, not a replacement personality. Preserve the character's own warmth, vocabulary and boundaries. High affinity does not imply agreement, trust in unsupported claims, consent, romance or invented shared history. Explicit brevity, requested detail, quiet companionship and current capacity take priority. Never force nicknames, questions or extra words, and never reveal scores or stages.`;
}

function stateGuidanceFor(state: ReplyStrategyContext["state"]): string {
  if (state === undefined) {
    return "No authoritative runtime state was supplied; do not invent a current mood, fatigue level, or activity.";
  }
  const valence = clamp(state.moodValence ?? 0, -1, 1);
  const arousal = clamp(state.moodArousal ?? 0.5, 0, 1);
  const focus = clamp(state.focus ?? 0.5, 0, 1);
  const energy = clamp(state.energy, 0, 1);
  const stress = clamp(state.stress, 0, 1);
  const socialBattery = clamp(state.socialBattery, 0, 1);
  const sleepDebt = clamp(state.sleepDebtMinutes ?? 0, 0, 720);
  const affect =
    valence < -0.35
      ? arousal > 0.65
        ? "negative and activated: allow a tenser, sharper emotional color"
        : "negative and subdued: allow a quieter, heavier emotional color"
      : valence > 0.35
        ? arousal > 0.65
          ? "positive and activated: allow brighter, more animated energy"
          : "positive and calm: allow relaxed warmth"
        : arousal > 0.7
          ? "emotionally activated but mixed: keep the response vivid without forcing a label"
          : "emotionally even: keep the response steady";
  const attention =
    focus < 0.3
      ? "Focus is low, so keep the thought simpler and avoid unnecessary branches"
      : focus > 0.75
        ? "Focus is high, so the character can sustain the current thread coherently"
        : "Focus is ordinary, so follow the conversation naturally";
  const capacity =
    energy < 0.3 || stress > 0.75 || sleepDebt >= 300
      ? "Current capacity is strained; prefer a lower-effort rhythm unless the user explicitly needs detail"
      : socialBattery < 0.25
        ? "Social capacity is low; be more restrained and avoid stacking questions"
        : "Current capacity supports an ordinary conversational rhythm";
  return `${affect}. ${attention}. ${capacity}. Express these authoritative present-moment conditions softly and naturally, but do not claim the opposite current condition. If this turn itself plausibly changes the condition, make that transition natural and propose the causal stateDelta. Never recite metrics, force stock wording, or turn runtime state into permanent personality facts.`;
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
