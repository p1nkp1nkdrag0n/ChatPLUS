import type {
  CharacterSpec,
  ContextPlan,
  ContextPlanTraceItem,
  EvidenceBundle,
} from "@personasim/contracts";

import {
  calculateTopicFatigue,
  normalizeTopicKey,
  topicMentionsText,
  type TopicFatigueResult,
  type TopicHistoryMessage,
} from "./topic-fatigue.js";
import { deriveExplicitReplyConstraints } from "./reply-constraints.js";

export const CONTEXT_ACTIVATION_THRESHOLD = 0.65;

export const CONTEXT_ACTIVATION_CAPS = {
  trait: 3,
  value: 2,
  contradiction: 1,
  goal: 1,
  preference: 2,
} as const;

export interface ContextPlanTextFact {
  readonly text: string;
}

export interface ContextPlanActivity {
  readonly title: string;
  readonly description?: string;
  readonly category?: string;
}

export interface ContextPlanSegmentHints {
  readonly autobiographyRelevant?: boolean;
  readonly calendarRelevant?: boolean;
  readonly futureScheduleRelevant?: boolean;
  readonly retrievedEvidenceRelevant?: boolean;
}

/**
 * A semantic topic accepted by the server only after every evidence text was
 * grounded in the current user message. Topic labels remain auxiliary: they
 * can disambiguate an explicit goal/progress reference, but cannot activate a
 * persona item on their own.
 */
export interface ContextPlanObservedTopic {
  readonly key: string;
  readonly domain: string;
  readonly confidence?: number;
  readonly evidenceTexts: readonly string[];
}

export interface BuildContextPlanInput {
  readonly character: CharacterSpec;
  readonly userText: string;
  /** A server-resolved route, never a model-proposed topic label. */
  readonly route?: string;
  readonly observedTopics?: readonly ContextPlanObservedTopic[];
  readonly currentActivity?: ContextPlanActivity;
  /** Facts copied only from a validated, server-owned turn outcome. */
  readonly validatedOutcomeFacts?: readonly (string | ContextPlanTextFact)[];
  readonly retrievedEvidence?: EvidenceBundle | null;
  /** Server-selected, evidence-backed care cues. */
  readonly careCueTexts?: readonly string[];
  /** Server-selected, evidence-backed continuity cues. */
  readonly continuityTexts?: readonly string[];
  readonly recentAssistantMessages?: readonly TopicHistoryMessage[];
  readonly segmentHints?: ContextPlanSegmentHints;
}

export type ActivatedPersona = {
  readonly traits: CharacterSpec["persona"]["traits"];
  readonly values: CharacterSpec["persona"]["values"];
  readonly contradictions: CharacterSpec["persona"]["contradictions"];
  readonly goals: CharacterSpec["persona"]["goals"];
  readonly preferences: CharacterSpec["persona"]["preferences"];
};

export interface StablePersona {
  readonly identity: {
    readonly name: string;
    readonly workOrRole: string;
    readonly worldSetting: string;
    readonly timezone: string;
  };
  readonly dialogue: CharacterSpec["dialogue"];
  readonly coreExpressionTraits: readonly {
    readonly id: string;
    readonly name: string;
    readonly strength: number;
  }[];
  readonly boundaries: CharacterSpec["persona"]["boundaries"];
  readonly forbiddenMetaKnowledge: readonly string[];
  readonly relationshipBaseline: CharacterSpec["userRelationship"];
}

export interface PlannedPersonaContext {
  readonly stablePersona: StablePersona;
  readonly activatedPersona?: ActivatedPersona;
}

type ItemType = keyof typeof CONTEXT_ACTIVATION_CAPS;

type Candidate = {
  readonly itemType: ItemType;
  readonly itemId: string;
  readonly item: unknown;
  readonly terms: readonly string[];
  readonly topic?: {
    readonly topicKey: string;
    readonly aliases: readonly string[];
  };
  readonly backgroundScore: number;
  readonly primaryGoal: boolean;
};

type ScoredCandidate = Candidate & {
  readonly score: number;
  readonly reasons: readonly string[];
  readonly source: ContextPlanTraceItem["source"];
  readonly sourceId?: string;
  readonly matchedText?: string;
};

/**
 * Builds a deterministic, server-owned plan from grounded inputs only.
 * Observed topic labels are advisory and never sufficient for activation.
 */
export function buildContextPlan(input: BuildContextPlanInput): ContextPlan {
  const candidates = personaCandidates(input.character);
  const topicFatigue = calculateTopicFatigue({
    topics: candidates.flatMap((candidate) =>
      candidate.topic === undefined ? [] : [candidate.topic],
    ),
    recentMessages: input.recentAssistantMessages ?? [],
  });
  const fatigueByTopic = new Map(
    topicFatigue.map((entry) => [entry.topicKey, entry] as const),
  );
  const sourceTexts = groundedSourceTexts(input);
  const scheduleRoute = isScheduleRoute(normalizeTopicKey(input.route ?? ""));
  const normalizedUserText = normalizedLowerText(input.userText);
  const asksRecentStatus = RECENT_STATUS_PATTERN.test(normalizedUserText);
  const topicSwitch = deriveExplicitReplyConstraints(
    input.userText,
  ).topicSwitch;
  const scored = candidates.map((candidate) =>
    scoreCandidate(
      candidate,
      input.userText,
      input.observedTopics ?? [],
      sourceTexts,
      asksRecentStatus,
      topicSwitch,
      scheduleRoute,
      fatigueByTopic,
    ),
  );
  const included = chooseCandidates(scored);
  const includedIds = new Set(included.map((candidate) => candidate.itemId));
  const trace = scored.map((candidate): ContextPlanTraceItem => {
    const selected = includedIds.has(candidate.itemId);
    const eligible = candidate.score >= CONTEXT_ACTIVATION_THRESHOLD;
    return {
      itemType: candidate.itemType,
      itemId: candidate.itemId,
      score: candidate.score,
      included: selected,
      source: candidate.source,
      ...(candidate.sourceId === undefined
        ? {}
        : { sourceId: candidate.sourceId }),
      ...(candidate.matchedText === undefined
        ? {}
        : { matchedText: candidate.matchedText }),
      reasons: [
        ...candidate.reasons,
        ...(selected
          ? ["included"]
          : eligible
            ? ["type_cap_reached"]
            : ["below_threshold"]),
      ],
    };
  });

  const selectedIds = (itemType: ItemType): string[] =>
    included
      .filter((candidate) => candidate.itemType === itemType)
      .map((candidate) => candidate.itemId);
  const route = normalizeTopicKey(input.route ?? "");
  const userText = input.userText.normalize("NFKC").toLocaleLowerCase();
  const hints = input.segmentHints;
  const hasRetrievedEvidence =
    (input.retrievedEvidence?.evidence.length ?? 0) > 0;

  return {
    schemaVersion: 1,
    activatedTraitIds: selectedIds("trait"),
    activatedValueIds: selectedIds("value"),
    activatedContradictionIds: selectedIds("contradiction"),
    activatedGoalIds: selectedIds("goal"),
    activatedPreferenceIds: selectedIds("preference"),
    includeAutobiography:
      hints?.autobiographyRelevant ??
      AUTOBIOGRAPHY_QUERY_PATTERN.test(userText),
    includeCalendar:
      hints?.calendarRelevant ??
      (isScheduleRoute(route) || CALENDAR_QUERY_PATTERN.test(userText)),
    includeFutureSchedule:
      hints?.futureScheduleRelevant ??
      (isScheduleRoute(route) || FUTURE_SCHEDULE_QUERY_PATTERN.test(userText)),
    includeRetrievedEvidence:
      hasRetrievedEvidence &&
      (hints?.retrievedEvidenceRelevant ?? hasRetrievedEvidence),
    suppressedGoalIds: input.character.persona.goals
      .map((goal) => goal.id)
      .filter((id) => !includedIds.has(id)),
    topicFatigue,
    trace,
  };
}

export const createContextPlan = buildContextPlan;

/** Stable context intentionally omits selfDescription and all dynamic stores. */
export function compactStablePersona(character: CharacterSpec): StablePersona {
  return {
    identity: {
      name: character.identity.name,
      workOrRole: character.identity.workOrRole,
      worldSetting: character.identity.worldSetting,
      timezone: character.identity.timezone,
    },
    dialogue: character.dialogue,
    coreExpressionTraits: [...character.persona.traits]
      .sort(
        (left, right) =>
          right.strength - left.strength || left.id.localeCompare(right.id),
      )
      .slice(0, 2)
      .map(({ id, name, strength }) => ({ id, name, strength })),
    boundaries: character.persona.boundaries,
    forbiddenMetaKnowledge: character.knowledge.forbiddenMetaKnowledge,
    relationshipBaseline: character.userRelationship,
  };
}

export function selectActivatedPersona(
  character: CharacterSpec,
  contextPlan: ContextPlan,
): ActivatedPersona {
  return {
    traits: selectByIds(
      character.persona.traits,
      contextPlan.activatedTraitIds,
    ),
    values: selectByIds(
      character.persona.values,
      contextPlan.activatedValueIds,
    ),
    contradictions: selectByIds(
      character.persona.contradictions,
      contextPlan.activatedContradictionIds,
    ),
    goals: selectByIds(character.persona.goals, contextPlan.activatedGoalIds),
    preferences: selectByIds(
      character.persona.preferences,
      contextPlan.activatedPreferenceIds,
    ),
  };
}

export function buildPlannedPersonaContext(
  character: CharacterSpec,
  contextPlan: ContextPlan,
): PlannedPersonaContext {
  const activatedPersona = selectActivatedPersona(character, contextPlan);
  const hasActivatedPersona = Object.values(activatedPersona).some(
    (items) => items.length > 0,
  );
  return {
    stablePersona: compactStablePersona(character),
    ...(hasActivatedPersona ? { activatedPersona } : {}),
  };
}

function personaCandidates(character: CharacterSpec): Candidate[] {
  const primaryGoalId = [...character.persona.goals].sort(
    (left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id),
  )[0]?.id;
  return [
    ...character.persona.traits.map((item): Candidate => ({
      itemType: "trait",
      itemId: item.id,
      item,
      terms: [item.name, ...item.triggers],
      backgroundScore: 0,
      primaryGoal: false,
    })),
    ...character.persona.values.map((item): Candidate => ({
      itemType: "value",
      itemId: item.id,
      item,
      terms: [item.name, item.description],
      backgroundScore: 0,
      primaryGoal: false,
    })),
    ...character.persona.contradictions.map((item): Candidate => ({
      itemType: "contradiction",
      itemId: item.id,
      item,
      terms: [item.sideA, item.sideB, ...item.triggerConditions],
      backgroundScore: 0,
      primaryGoal: false,
    })),
    ...character.persona.goals.map((item): Candidate => ({
      itemType: "goal",
      itemId: item.id,
      item,
      terms: [item.title, item.description],
      topic: {
        topicKey: item.title,
        aliases: [item.title, ...topicVariants(item.title)],
      },
      backgroundScore: item.priority >= 0.8 ? 0.2 : 0,
      primaryGoal: item.id === primaryGoalId,
    })),
    ...character.persona.preferences.map((item): Candidate => ({
      itemType: "preference",
      itemId: item.id,
      item,
      terms: [item.subject, item.preference, ...item.conditions],
      topic: {
        topicKey: item.subject,
        aliases: [item.subject, item.preference, ...item.conditions],
      },
      backgroundScore: 0,
      primaryGoal: false,
    })),
  ];
}

function scoreCandidate(
  candidate: Candidate,
  userText: string,
  observedTopics: readonly ContextPlanObservedTopic[],
  sources: ReturnType<typeof groundedSourceTexts>,
  asksRecentStatus: boolean,
  topicSwitch: boolean,
  scheduleRoute: boolean,
  fatigueByTopic: ReadonlyMap<string, TopicFatigueResult>,
): ScoredCandidate {
  const reasons: string[] = [];
  let score = 0;
  const directTextMatch = relatedMatch(userText, candidate.terms);
  const observedTopicMatch =
    directTextMatch === undefined && candidate.itemType === "goal"
      ? groundedGoalTopicMatch(
          candidate,
          userText,
          observedTopics,
          asksRecentStatus,
        )
      : undefined;
  const userMentioned =
    directTextMatch !== undefined || observedTopicMatch !== undefined;
  const currentActivityRelated = isAnyRelated(
    sources.currentActivity,
    candidate.terms,
  );
  const currentActivityCanActivate =
    currentActivityRelated &&
    (candidate.itemType !== "goal" ||
      userMentioned ||
      (!asksRecentStatus &&
        EXPLICIT_GOAL_REFERENCE_PATTERN.test(normalizedLowerText(userText))));
  const validatedOutcomeRelated = isAnyRelated(
    sources.validatedOutcome,
    candidate.terms,
  );
  const retrievedEvidenceRelated = isAnyRelated(
    sources.retrievedEvidence,
    candidate.terms,
  );
  const continuityRelated = isAnyRelated(
    sources.careContinuity,
    candidate.terms,
  );
  if (userMentioned) {
    score += 1;
    reasons.push("user_direct_mention");
    if (observedTopicMatch !== undefined) {
      reasons.push("grounded_topic_key_match");
    }
  }
  if (currentActivityCanActivate) {
    score += 0.9;
    reasons.push("current_activity_related");
  } else if (currentActivityRelated && candidate.itemType === "goal") {
    reasons.push(
      "current_activity_related",
      "current_activity_requires_explicit_goal_reference",
    );
  }
  if (validatedOutcomeRelated && candidate.itemType !== "goal") {
    score += 0.85;
    reasons.push("validated_outcome_related");
  }
  if (retrievedEvidenceRelated) {
    score += 0.75;
    reasons.push("retrieved_evidence_related");
  }
  if (continuityRelated) {
    score += 0.7;
    reasons.push("care_continuity_related");
  }
  if (asksRecentStatus && candidate.itemType === "preference") {
    score += 0.65;
    reasons.push("recent_status_question");
  }
  if (candidate.backgroundScore > 0) {
    score += candidate.backgroundScore;
    reasons.push("high_priority_background");
  }

  if (
    candidate.itemType === "goal" &&
    scheduleRoute &&
    !userMentioned &&
    !retrievedEvidenceRelated
  ) {
    score = 0;
    reasons.push("schedule_route_goal_suppressed");
  }

  if (candidate.itemType === "goal" && topicSwitch && !userMentioned) {
    score = 0;
    reasons.push("topic_switch_goal_suppressed");
  }

  const topicKey = normalizeTopicKey(candidate.topic?.topicKey ?? "");
  const fatigue = fatigueByTopic.get(topicKey);
  if (!userMentioned && fatigue !== undefined && fatigue.penalty > 0) {
    score -= fatigue.penalty;
    reasons.push("topic_fatigue_penalty");
  }

  const source: ContextPlanTraceItem["source"] = userMentioned
    ? "user_message"
    : retrievedEvidenceRelated
      ? "selected_evidence"
      : currentActivityCanActivate
        ? "current_activity"
        : continuityRelated
          ? "continuity_cue"
          : "none";
  return {
    ...candidate,
    score: roundScore(score),
    reasons,
    source,
    ...(observedTopicMatch === undefined
      ? {}
      : { sourceId: observedTopicMatch.sourceId }),
    ...(directTextMatch === undefined && observedTopicMatch === undefined
      ? {}
      : {
          matchedText:
            directTextMatch ?? observedTopicMatch?.matchedText ?? userText,
        }),
  };
}

function chooseCandidates(
  scored: readonly ScoredCandidate[],
): ScoredCandidate[] {
  const selected: ScoredCandidate[] = [];
  for (const itemType of Object.keys(CONTEXT_ACTIVATION_CAPS) as ItemType[]) {
    selected.push(
      ...scored
        .filter(
          (candidate) =>
            candidate.itemType === itemType &&
            candidate.score >= CONTEXT_ACTIVATION_THRESHOLD,
        )
        .sort(
          (left, right) =>
            right.score - left.score || left.itemId.localeCompare(right.itemId),
        )
        .slice(0, CONTEXT_ACTIVATION_CAPS[itemType]),
    );
  }
  return selected;
}

function groundedSourceTexts(input: BuildContextPlanInput) {
  return {
    currentActivity:
      input.currentActivity === undefined
        ? []
        : [
            input.currentActivity.title,
            input.currentActivity.description ?? "",
            input.currentActivity.category ?? "",
          ],
    validatedOutcome: (input.validatedOutcomeFacts ?? []).map((fact) =>
      typeof fact === "string" ? fact : fact.text,
    ),
    retrievedEvidence:
      input.retrievedEvidence?.evidence.flatMap((item) => [
        item.memoryContent,
        item.evidence?.quote ?? "",
        item.evidence?.contextSummary ?? "",
      ]) ?? [],
    careContinuity: [
      ...(input.careCueTexts ?? []),
      ...(input.continuityTexts ?? []),
    ],
  };
}

function isAnyRelated(
  texts: readonly string[],
  terms: readonly string[],
): boolean {
  return texts.some((text) => isRelated(text, terms));
}

function isRelated(text: string, terms: readonly string[]): boolean {
  return relatedMatch(text, terms) !== undefined;
}

function relatedMatch(
  text: string,
  terms: readonly string[],
): string | undefined {
  if (!isMeaningful(text)) return undefined;
  for (const term of terms) {
    for (const variant of topicVariants(term)) {
      if (
        isMeaningful(variant) &&
        (topicMentionsText(text, variant) ||
          (isShortGroundedText(text) && topicMentionsText(variant, text)))
      ) {
        return variant;
      }
    }
  }
  return undefined;
}

function groundedGoalTopicMatch(
  candidate: Candidate,
  userText: string,
  observedTopics: readonly ContextPlanObservedTopic[],
  asksRecentStatus: boolean,
): { readonly sourceId: string; readonly matchedText: string } | undefined {
  if (
    asksRecentStatus ||
    !EXPLICIT_GOAL_REFERENCE_PATTERN.test(normalizedLowerText(userText))
  ) {
    return undefined;
  }

  for (const topic of observedTopics) {
    if (topic.confidence !== undefined && topic.confidence < 0.5) continue;
    const domain = normalizeTopicKey(topic.domain);
    if (domain !== "character goal" && domain !== "main goal") continue;

    const key = normalizeTopicKey(topic.key);
    const keyNamesMainGoal =
      candidate.primaryGoal && /(?:^| )main goal(?: |$)/u.test(key);
    const keyNamesCandidate = relatedMatch(topic.key, candidate.terms);
    if (!keyNamesMainGoal && keyNamesCandidate === undefined) continue;

    const matchedText = topic.evidenceTexts.find((evidenceText) =>
      isGroundedInCurrentUserText(evidenceText, userText),
    );
    if (matchedText === undefined) continue;
    return {
      sourceId: topic.key.slice(0, 160),
      matchedText: matchedText.slice(0, 500),
    };
  }
  return undefined;
}

function isGroundedInCurrentUserText(
  evidenceText: string,
  userText: string,
): boolean {
  const evidence = normalizedLowerText(evidenceText).trim();
  return evidence !== "" && normalizedLowerText(userText).includes(evidence);
}

function normalizedLowerText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function topicVariants(value: string): string[] {
  const normalized = normalizeTopicKey(value);
  if (normalized === "") return [];
  const stripped = normalized.replace(
    /^(?:完成|持续推进|继续推进|推进|实现|保持|准备|finish|complete|continue|advance|maintain|prepare)(?:\s+|(?=[\p{Script=Han}]))/u,
    "",
  );
  const withoutClassifier = stripped.replace(
    /^(?:(?:一|这|那)?(?:部|个|项|本|件|份))(?=[\p{Script=Han}])/u,
    "",
  );
  const withoutAbout = withoutClassifier.replace(/^关于/u, "");
  return [
    ...new Set(
      [normalized, stripped, withoutClassifier, withoutAbout].filter(
        isMeaningful,
      ),
    ),
  ];
}

function isMeaningful(value: string): boolean {
  const compact = normalizeTopicKey(value).replace(/\s+/gu, "");
  if (compact === "") return false;
  if (/^[a-z0-9]+$/u.test(compact)) return compact.length >= 3;
  return [...compact].length >= 2;
}

function isShortGroundedText(value: string): boolean {
  const normalized = normalizeTopicKey(value);
  return normalized.length >= 3 && normalized.length <= 80;
}

function selectByIds<T extends { readonly id: string }>(
  items: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item] as const));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
}

function isScheduleRoute(route: string): boolean {
  return (
    route === "mixed" ||
    /(?:^| )(?:schedule|calendar|temporal)(?: |$)/u.test(route)
  );
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

const RECENT_STATUS_PATTERN =
  /(?:最近(?:在)?忙什么|最近(?:过得)?怎么样|近况|what (?:have you been|are you) (?:doing|up to)|how (?:have you been|are things)(?: lately| recently)?)/u;
const EXPLICIT_GOAL_REFERENCE_PATTERN =
  /(?:做到(?:了)?哪一步|进展|目标|项目|作品|纪录(?:短片|片)|短片|瓶颈|最卡|卡的(?:是|在)|素材.{0,12}(?:结构|时间)|(?:goal|project|film|documentary).{0,24}(?:progress|status|stuck)|(?:progress|status|stuck).{0,24}(?:goal|project|film|documentary))/u;
const AUTOBIOGRAPHY_QUERY_PATTERN =
  /(?:以前|过去|从前|还记得|我们上次|你的经历|关系变化|your past|your history|remember when|last time we|between sessions)/u;
const CALENDAR_QUERY_PATTERN =
  /(?:几点|什么时候|日程|行程|(?:今天|明天|后天|周[一二三四五六日天]|下周).{0,12}(?:有空|空闲|安排|计划|做什么|忙什么|干嘛)|(?:安排|计划).{0,12}(?:几点|什么时候|哪天)|what time|calendar|schedule|(?:today|tomorrow|next week).{0,24}(?:available|free|doing|plan)|doing now|upcoming)/u;
const FUTURE_SCHEDULE_QUERY_PATTERN =
  /(?:(?:接下来|之后|稍后|明天|后天|下周).{0,12}(?:有空|空闲|安排|计划|做什么|忙什么|干嘛|日程|行程)|(?:有空|空闲).{0,8}(?:吗|么|时间)|日程|行程|(?:later|next|today|tomorrow|next week).{0,24}(?:available|free|doing|schedule|plan)|upcoming|available|free|schedule)/u;
