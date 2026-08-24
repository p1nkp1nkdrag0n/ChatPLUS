import {
  PersonaChatResponseSchema,
  type EvidenceBundle,
  type PersonaChatResponse,
} from "@personasim/contracts";
import {
  auditDirectUserFactTextGrounding,
  auditEvidenceOnlyTextGrounding,
  assembleReplyPrompt,
  buildPlannedPersonaContext,
  deriveExplicitReplyConstraints,
  detectExplicitAdvicePoints,
  extractActiveCorrectionStatement,
  guardPersonaReply,
  splitEvidenceOnlyClauses,
  type AssembleReplyPromptInput,
  type EvidenceOnlyGroundingSource,
  type ExplicitReplyConstraints,
} from "@personasim/features";

import { toFeatureScheduleEffects } from "../domain/feature-adapters.js";
import type { AgentTurnDecision, RuntimeState } from "../domain/schemas.js";
import type { GenerateObjectInput } from "./llm-service.js";
import type { ReplyRepairService } from "./reply-repair-service.js";
import type {
  ScheduleOutcome,
  ValidatedTurnOutcome,
} from "./turn-execution-service.js";

export type MaterializedPersonaReply = AgentTurnDecision["reply"];

export interface ReplyGenerationIssue {
  code: string;
  message: string;
}

export interface GeneratedPersonaReply {
  reply: MaterializedPersonaReply;
  response: PersonaChatResponse;
  repairAttempted: boolean;
  usedFallback: boolean;
  issues: ReplyGenerationIssue[];
  promptSegmentTrace?: ReturnType<typeof assembleReplyPrompt>["segmentTrace"];
}

export type ReplyGenerationInput = Omit<
  AssembleReplyPromptInput,
  "state" | "validatedOutcome"
> & {
  state: RuntimeState;
  validatedOutcome: ValidatedTurnOutcome;
};

interface ObjectGenerator {
  generateObject<T>(input: GenerateObjectInput<T>): Promise<T>;
}

interface PersonaReplyRepairer {
  repairPersonaReply: ReplyRepairService["repairPersonaReply"];
}

const MIN_STRUCTURED_REPLY_OUTPUT_TOKENS = 4_000;

/** Generates and repairs only the natural-language reply lane. */
export class ReplyGenerationService {
  constructor(
    private readonly llm: ObjectGenerator,
    private readonly repairs: PersonaReplyRepairer,
  ) {}

  async generate(input: ReplyGenerationInput): Promise<GeneratedPersonaReply> {
    const explicitReplyConstraints = deriveExplicitReplyConstraints(
      input.userMessage,
    );
    const evidencePolicy = replyEvidencePolicy(input);
    const selectedEvidence = selectAllowedEvidence(
      input.memoryEvidence,
      evidencePolicy.allowedEvidenceIds,
    );
    const recentUserFactEvidence = selectRecentUserFactEvidence(
      input,
      evidencePolicy,
      selectedEvidence,
    );
    if (
      evidencePolicy.mustAbstain ||
      (evidencePolicy.evidenceOnly && selectedEvidence === undefined) ||
      (evidencePolicy.mustNotInferFromPersona &&
        evidencePolicy.allowedEvidenceIds.length > 0 &&
        selectedEvidence === undefined &&
        recentUserFactEvidence.length === 0)
    ) {
      return deterministicAbstention(input);
    }
    let assembled: ReturnType<typeof assembleReplyPrompt> | undefined;
    let response: PersonaChatResponse | undefined;
    let initialIssues: ReplyGenerationIssue[] = [];
    try {
      assembled = assembleReplyPrompt(
        toAssemblerInput(input, selectedEvidence, recentUserFactEvidence),
      );
    } catch (error) {
      initialIssues = [invalidOutputIssue(error)];
    }
    if (assembled !== undefined) {
      try {
        response = PersonaChatResponseSchema.parse(
          await this.llm.generateObject({
            purpose: "reply_generation",
            agentId: input.character.id,
            system: assembled.system,
            prompt: assembled.prompt,
            schema: PersonaChatResponseSchema,
            maxOutputTokens: Math.max(
              input.replyStrategy.maxOutputTokens,
              MIN_STRUCTURED_REPLY_OUTPUT_TOKENS,
            ),
          }),
        );
      } catch (error) {
        initialIssues = [invalidOutputIssue(error)];
      }
    }

    let issues =
      response === undefined
        ? initialIssues
        : inspectReply(input, materializeReply(response));
    let repairAttempted = false;
    if (response === undefined || issues.length > 0) {
      repairAttempted = true;
      let repaired: PersonaChatResponse | undefined;
      try {
        const personaContext = repairPersonaContext(input);
        repaired = await this.repairs.repairPersonaReply({
          spec: input.character,
          userText: input.userMessage,
          invalidResponse: response,
          issues,
          replyStrategy: input.replyStrategy,
          replyDirectives: input.validatedOutcome.replyDirectives,
          explicitReplyConstraints,
          preserveAnchors: groundedAnchorsAlreadyPresent(input, response),
          ...(selectedEvidence === undefined
            ? {}
            : { evidenceContext: selectedEvidence }),
          ...(recentUserFactEvidence.length === 0
            ? {}
            : { recentUserFactEvidence }),
          ...(personaContext === undefined ? {} : { personaContext }),
        });
      } catch (error) {
        issues = [
          ...issues,
          {
            code: "reply_repair_failed",
            message:
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Reply repair failed.",
          },
        ];
      }
      if (repaired !== undefined) {
        const parsed = PersonaChatResponseSchema.safeParse(repaired);
        if (parsed.success) {
          const repairedIssues = inspectReply(
            input,
            materializeReply(parsed.data),
          );
          if (repairedIssues.length === 0) {
            return {
              reply: materializeReply(parsed.data),
              response: parsed.data,
              repairAttempted,
              usedFallback: false,
              issues: [],
              ...(assembled === undefined
                ? {}
                : { promptSegmentTrace: assembled.segmentTrace }),
            };
          }
          issues = repairedIssues;
        }
      }
    }

    if (response !== undefined && issues.length === 0) {
      return {
        reply: materializeReply(response),
        response,
        repairAttempted,
        usedFallback: false,
        issues: [],
        ...(assembled === undefined
          ? {}
          : { promptSegmentTrace: assembled.segmentTrace }),
      };
    }

    if (
      evidencePolicy.mustNotInferFromPersona &&
      (selectedEvidence !== undefined || recentUserFactEvidence.length > 0)
    ) {
      const evidenceFallback = evidenceOnlyFallbackResponse(
        input,
        selectedEvidence,
        recentUserFactEvidence,
      );
      const evidenceFallbackIssues = inspectReply(
        input,
        materializeReply(evidenceFallback),
      );
      if (evidenceFallbackIssues.length === 0) {
        return {
          reply: materializeReply(evidenceFallback),
          response: evidenceFallback,
          repairAttempted,
          usedFallback: true,
          issues: [],
          ...(assembled === undefined
            ? {}
            : { promptSegmentTrace: assembled.segmentTrace }),
        };
      }
    }

    if (response !== undefined) {
      const constrainedFallback = compactExplicitAdviceResponse(
        response,
        explicitReplyConstraints,
      );
      if (constrainedFallback !== undefined) {
        const constrainedIssues = inspectReply(
          input,
          materializeReply(constrainedFallback),
        );
        if (constrainedIssues.length === 0) {
          return {
            reply: materializeReply(constrainedFallback),
            response: constrainedFallback,
            repairAttempted,
            usedFallback: true,
            issues: [],
            ...(assembled === undefined
              ? {}
              : { promptSegmentTrace: assembled.segmentTrace }),
          };
        }
      }
    }

    const fallback = fallbackResponse(
      input,
      selectedEvidence,
      explicitReplyConstraints,
    );
    const fallbackIssues = inspectReply(input, materializeReply(fallback));
    return {
      reply: materializeReply(fallback),
      response: fallback,
      repairAttempted,
      usedFallback: true,
      issues: fallbackIssues,
      ...(assembled === undefined
        ? {}
        : { promptSegmentTrace: assembled.segmentTrace }),
    };
  }
}

function explicitConstraintIssues(
  text: string,
  constraints: ExplicitReplyConstraints,
): ReplyGenerationIssue[] {
  const issues: ReplyGenerationIssue[] = [];
  const advicePointCount =
    constraints.maxAdvicePoints !== undefined ||
    constraints.requiresAdviceResponse === true
      ? countAdvicePoints(text)
      : undefined;
  if (constraints.requiresAdviceResponse === true && advicePointCount === 0) {
    issues.push({
      code: "explicit_advice_response_unaddressed",
      message:
        "The user explicitly requested actionable advice, but the reply contains no advice point.",
    });
  }
  if (constraints.maxAdvicePoints !== undefined) {
    const pointCount = advicePointCount ?? 0;
    if (pointCount > constraints.maxAdvicePoints) {
      issues.push({
        code: "explicit_advice_point_limit_exceeded",
        message: `The user allowed at most ${constraints.maxAdvicePoints} advice points, but the reply contains ${pointCount}.`,
      });
    }
  }
  if (
    constraints.forbidFollowUpQuestions === true &&
    containsFollowUpQuestion(text)
  ) {
    issues.push({
      code: "explicit_no_follow_up_question_violated",
      message:
        "The user closed this topic or declined further check-ins, but the reply asks another question.",
    });
  }
  if (constraints.maxSentences !== undefined) {
    const count = splitSentences(text).length;
    if (count > constraints.maxSentences) {
      issues.push({
        code: "explicit_sentence_limit_exceeded",
        message: `The user requested a brief reply of at most ${constraints.maxSentences} sentences, but the reply contains ${count}.`,
      });
    }
  }
  if (constraints.minSentences !== undefined) {
    const count = splitSentences(text).length;
    if (count < constraints.minSentences) {
      issues.push({
        code: "explicit_sentence_minimum_not_met",
        message: `The user requested at least ${constraints.minSentences} sentences, but the reply contains ${count}.`,
      });
    }
  }
  if (
    constraints.requiredPreparationMinutes !== undefined &&
    !replyMentionsMinuteDuration(text, constraints.requiredPreparationMinutes)
  ) {
    issues.push({
      code: "explicit_preparation_duration_unaddressed",
      message: `The user requested an exact ${constraints.requiredPreparationMinutes}-minute preparation plan, but the reply does not preserve that duration.`,
    });
  }
  if (
    constraints.requiresPreparationPlan === true &&
    !replyContainsActionablePreparationPlan(text)
  ) {
    issues.push({
      code: "explicit_preparation_plan_unaddressed",
      message:
        "The user explicitly requested concrete preparation steps, but the reply does not contain an actionable plan.",
    });
  }
  if (
    constraints.requiresEmotionalAcknowledgement === true &&
    !replyAcknowledgesEmotion(text)
  ) {
    issues.push({
      code: "explicit_emotional_acknowledgement_unaddressed",
      message:
        "The user explicitly asked for their feelings to be acknowledged first, but the reply does not do so.",
    });
  }
  return issues;
}

function replyMentionsMinuteDuration(text: string, expected: number): boolean {
  const matches = text.matchAll(
    /([零一二两三四五六七八九十百\d]{1,4})\s*(?:个)?分钟/gu,
  );
  const durations = [...matches]
    .map((match) => parseReplyMinuteCount(match[1]))
    .filter((value): value is number => value !== undefined);
  return (
    durations.includes(expected) ||
    (durations.length >= 2 &&
      durations.reduce((total, value) => total + value, 0) === expected)
  );
}

function parseReplyMinuteCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const digit = Number.parseInt(value, 10);
  if (Number.isInteger(digit)) return digit;
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
    return tens === undefined || ones === undefined
      ? undefined
      : tens * 10 + ones;
  }
  return digits[value];
}

function replyContainsActionablePreparationPlan(text: string): boolean {
  const actions =
    text.match(
      /(?:列出|写下|记下|试说|复述|演练|模拟|回顾|整理|练习|计时|回答|检查|深呼吸)/gu,
    ) ?? [];
  const sequence =
    text.match(
      /(?:先|首先|第一|再|然后|接着|其次|第二|最后|第三|(?:^|\n)\s*\d+[.、)])/gu,
    ) ?? [];
  return (
    actions.length >= 2 &&
    (sequence.length >= 2 || /(?:步骤|计划|分成)/u.test(text))
  );
}

function replyAcknowledgesEmotion(text: string): boolean {
  return (
    /(?:紧张|焦虑|不安|担心|害怕|压力|难受|委屈|失落|沮丧|生气|疲惫|很累)/u.test(
      text,
    ) &&
    /(?:听见|理解|能理解|很正常|难怪|确实|不容易|辛苦|我在|陪(?:着)?你|接住|感受到)/u.test(
      text,
    )
  );
}

function suppressedTopicIssues(
  input: ReplyGenerationInput,
  text: string,
): ReplyGenerationIssue[] {
  const constraints = deriveExplicitReplyConstraints(input.userMessage);
  if (!constraints.topicSwitch) return [];
  const suppressed = new Set(input.contextPlan.suppressedGoalIds);
  const revived = input.character.persona.goals
    .filter((goal) => suppressed.has(goal.id))
    .flatMap((goal) => distinctiveGoalAnchors(goal.title, goal.description))
    .find((anchor) => comparableAnchorText(text).includes(anchor));
  return revived === undefined
    ? []
    : [
        {
          code: "suppressed_topic_revival",
          message:
            "The reply revives a goal topic after the user explicitly switched away from it.",
        },
      ];
}

function distinctiveGoalAnchors(title: string, description: string): string[] {
  const anchors: string[] = [];
  for (const value of [title, description]) {
    const normalized = comparableAnchorText(value);
    if (normalized.length >= 4) anchors.push(normalized);
    const about =
      /关于([\p{Script=Han}a-z0-9_-]{2,30}?)(?:的)?(?:纪录|短片|项目|作品)/iu.exec(
        value,
      )?.[1];
    if (about !== undefined && about.length >= 3) {
      anchors.push(comparableAnchorText(about));
    }
  }
  return [...new Set(anchors)].filter(Boolean);
}

function countAdvicePoints(text: string): number {
  return detectExplicitAdvicePoints(text).count;
}

function containsFollowUpQuestion(text: string): boolean {
  return (
    /[？?]/u.test(text) ||
    /(?:要不要|想不想|愿不愿意|是否|还有什么|接下来(?:呢|怎么办)|(?:可以|愿意)(?:再|继续)?(?:聊|说|谈)).{0,12}(?:吗|呢|么)?(?:[。！!\s]|$)/u.test(
      text,
    )
  );
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n?/gu, "\n")
    .split(/(?<=[。！？!?])|\n+/gu)
    .map((part) => part.trim())
    .filter(Boolean);
}

function compactExplicitAdviceResponse(
  response: PersonaChatResponse,
  constraints: ExplicitReplyConstraints,
): PersonaChatResponse | undefined {
  if (constraints.maxAdvicePoints === undefined) return undefined;
  const adviceSentences = splitSentences(response.text).filter((sentence) =>
    /^(?:第一|第二|第三|第四|第五|第六|第七|第八|第九|首先|其次|最后)[，、,:：]/u.test(
      sentence,
    ),
  );
  if (adviceSentences.length === 0) return undefined;
  const selected = adviceSentences.slice(0, constraints.maxAdvicePoints);
  const text = selected.join("");
  return PersonaChatResponseSchema.parse({
    text,
    toneTags: response.toneTags ?? [],
    deliveryMode: "single_block",
  });
}

function groundedAnchorsAlreadyPresent(
  input: ReplyGenerationInput,
  response: PersonaChatResponse | undefined,
): string[] {
  if (response === undefined) return [];
  const candidates = [
    ...input.validatedOutcome.replyDirectives.authoritativeFacts.flatMap(
      (fact) => fact.requiredAnchors ?? [],
    ),
    ...input.validatedOutcome.replyDirectives.mustAddressUserQuotes.flatMap(
      (quote) => quote.match(/[a-z0-9][a-z0-9_-]{2,}/giu) ?? [],
    ),
  ];
  return [
    ...new Set(
      candidates.filter((anchor) =>
        comparableAnchorText(response.text).includes(
          comparableAnchorText(anchor),
        ),
      ),
    ),
  ].slice(0, 12);
}

function repairPersonaContext(
  input: ReplyGenerationInput,
): ReturnType<typeof buildPlannedPersonaContext> | undefined {
  if ((input.personaContextMode ?? "legacy") !== "enforced") {
    return undefined;
  }
  return buildPlannedPersonaContext(input.character, input.contextPlan);
}

function toAssemblerInput(
  input: ReplyGenerationInput,
  selectedEvidence: EvidenceBundle | undefined,
  recentUserFactEvidence: readonly AssembleReplyPromptInput["recentMessages"][number][],
): AssembleReplyPromptInput {
  const state = input.state;
  const authoritativeScheduleIds =
    input.validatedOutcome.scheduleOutcome.kind === "read_only"
      ? new Set(input.validatedOutcome.scheduleOutcome.itemIds)
      : undefined;
  return {
    ...input,
    ...(selectedEvidence === undefined
      ? {}
      : { memoryEvidence: selectedEvidence }),
    ...(recentUserFactEvidence.length === 0 ? {} : { recentUserFactEvidence }),
    schedule:
      authoritativeScheduleIds === undefined
        ? input.schedule
        : input.schedule.filter((item) =>
            authoritativeScheduleIds.has(item.id),
          ),
    state: {
      agentId: state.agentId,
      asOfUtc: state.asOfUtc,
      moodValence: state.moodValence,
      moodArousal: state.moodArousal,
      energy: state.energy,
      stress: state.stress,
      socialBattery: state.socialBattery,
      focus: state.focus,
      sleepDebtMinutes: state.sleepDebtMinutes,
      revision: state.revision,
      ...(state.currentActivityId === undefined
        ? {}
        : { currentActivityId: state.currentActivityId }),
      ...(state.locationContext === undefined
        ? {}
        : { locationContext: state.locationContext }),
      relationship: {
        userId: state.relationship.userId,
        closeness: state.relationship.closeness,
        trust: state.relationship.trust,
        familiarity: state.relationship.familiarity,
        recentInteractionValence: state.relationship.recentInteractionValence,
        ...(state.relationship.lastInteractionAtUtc === undefined
          ? {}
          : {
              lastInteractionAtUtc: state.relationship.lastInteractionAtUtc,
            }),
      },
    },
    validatedOutcome: input.validatedOutcome,
  };
}

interface ReplyEvidencePolicy {
  evidenceOnly: boolean;
  mustAbstain: boolean;
  mustNotInferFromPersona: boolean;
  allowedEvidenceIds: readonly string[];
}

function replyEvidencePolicy(input: ReplyGenerationInput): ReplyEvidencePolicy {
  const directives = input.validatedOutcome
    .replyDirectives as typeof input.validatedOutcome.replyDirectives & {
    evidenceOnly?: boolean;
    mustAbstain?: boolean;
    mustNotInferFromPersona?: boolean;
    allowedEvidenceIds?: readonly string[];
  };
  return {
    evidenceOnly: directives.evidenceOnly === true,
    mustAbstain: directives.mustAbstain === true,
    mustNotInferFromPersona: directives.mustNotInferFromPersona === true,
    allowedEvidenceIds: directives.allowedEvidenceIds ?? [],
  };
}

function selectAllowedEvidence(
  bundle: EvidenceBundle | undefined,
  allowedEvidenceIds: readonly string[],
): EvidenceBundle | undefined {
  if (bundle === undefined) return undefined;
  if (allowedEvidenceIds.length === 0) return bundle;
  const allowed = new Set(allowedEvidenceIds);
  const evidence = bundle.evidence.filter((item) =>
    allowed.has(item.evidence.id),
  );
  if (evidence.length === 0) return undefined;
  return { ...bundle, evidence };
}

function selectRecentUserFactEvidence(
  input: ReplyGenerationInput,
  policy: ReplyEvidencePolicy,
  selectedEvidence: EvidenceBundle | undefined,
): readonly AssembleReplyPromptInput["recentMessages"][number][] {
  if (
    !policy.mustNotInferFromPersona ||
    policy.evidenceOnly ||
    selectedEvidence !== undefined
  ) {
    return [];
  }
  return (input.recentUserFactEvidence ?? [])
    .filter(
      (message) => message.role === "user" && message.content.trim() !== "",
    )
    .slice(-3);
}

function deterministicAbstention(
  input: ReplyGenerationInput,
): GeneratedPersonaReply {
  const summaryRequest =
    /(?:两三句话|总结.{0,12}(?:记得|了解)|说说.{0,12}(?:记得的我|了解的我))/u.test(
      input.userMessage,
    );
  const text =
    majorDecisionBoundaryFallback(input.userMessage) ??
    (summaryRequest
      ? "我现在没有足够的可靠证据来总结你。没有证据的部分我不猜，所以这些我不知道。"
      : "这件事我没有能验证的依据，所以现在不知道。");
  const response = PersonaChatResponseSchema.parse({
    text,
    toneTags: ["自然", "克制"],
    deliveryMode: "single_block",
  });
  return {
    reply: materializeReply(response),
    response,
    repairAttempted: false,
    usedFallback: false,
    issues: [],
  };
}

function evidenceOnlyFallbackResponse(
  input: ReplyGenerationInput,
  evidence: EvidenceBundle | undefined,
  recentUserFactEvidence: readonly AssembleReplyPromptInput["recentMessages"][number][] = [],
): PersonaChatResponse {
  const scheduleFacts =
    input.validatedOutcome.replyDirectives.authoritativeFacts
      .filter((fact) => fact.kind === "schedule")
      .map((fact) => stripTerminalPunctuation(fact.text))
      .filter(Boolean);
  const groundingSources: EvidenceOnlyGroundingSource[] = [
    ...(evidence?.evidence.map((item) => ({
      memoryContent: item.memoryContent,
      ...(item.evidence.quote === undefined
        ? {}
        : { evidenceQuote: item.evidence.quote }),
    })) ?? []),
    ...recentUserFactEvidence.map((message) => ({
      memoryContent: message.content,
    })),
  ];
  const fallbackEvidence =
    scheduleFacts.length === 0
      ? groundingSources
      : groundingSources.filter(
          (item) =>
            !isHistoricalScheduleProposalEvidence(
              item.evidenceQuote ?? item.memoryContent,
            ),
        );
  const relevantEvidence = evidenceRelevantToExplicitIdentifiers(
    input.userMessage,
    fallbackEvidence,
  );
  const facts = [
    ...new Set(
      relevantEvidence.flatMap((item) => groundedFallbackClauses(item)),
    ),
  ].slice(0, 3);
  const summaryRequest =
    /(?:两三句话|总结.{0,12}(?:记得|了解)|说说.{0,12}(?:记得的我|了解的我))/u.test(
      input.userMessage,
    );
  let text: string;
  if (summaryRequest) {
    const sentences = facts.map(
      (fact, index) =>
        `${index === 0 ? "我确定记得，" : "另外，"}${stripTerminalPunctuation(fact)}。`,
    );
    if (sentences.length === 1) {
      sentences.push("其余没有可靠证据的部分，我不猜。 ");
    }
    text = sentences.slice(0, 3).join("").trim();
  } else {
    text =
      facts.length === 0
        ? ""
        : `根据你之前明确告诉我的，我能确认：${facts
            .map(stripTerminalPunctuation)
            .join("；")}。`;
  }
  if (scheduleFacts.length > 0) {
    const scheduleText = `你问的共同安排是：${scheduleFacts.join("；")}。`;
    text =
      text === ""
        ? `我核对了，${scheduleText}`
        : `${text}另外，${scheduleText}`;
  }
  return PersonaChatResponseSchema.parse({
    text,
    toneTags: ["自然", "克制"],
    deliveryMode: "single_block",
  });
}

function evidenceRelevantToExplicitIdentifiers(
  userMessage: string,
  evidence: readonly EvidenceOnlyGroundingSource[],
): readonly EvidenceOnlyGroundingSource[] {
  const queriedIdentifiers = [
    ...(userMessage.normalize("NFKC").match(DISTINCTIVE_IDENTIFIERS) ?? []),
  ].map((identifier) => identifier.toLocaleLowerCase());
  if (queriedIdentifiers.length === 0) return evidence;
  const matched = evidence.filter((item) => {
    const content = item.memoryContent.normalize("NFKC").toLocaleLowerCase();
    return queriedIdentifiers.some((identifier) =>
      content.includes(identifier),
    );
  });
  return matched.length > 0 ? matched : evidence;
}

function groundedFallbackClauses(item: EvidenceOnlyGroundingSource): string[] {
  const evidenceQuote = item.evidenceQuote?.trim();
  const projectedCorrection =
    evidenceQuote === "" || evidenceQuote === undefined
      ? undefined
      : extractActiveCorrectionStatement(evidenceQuote);
  const sourceText =
    projectedCorrection ??
    (evidenceQuote === "" || evidenceQuote === undefined
      ? item.memoryContent
      : evidenceQuote);
  const source = {
    memoryContent: item.memoryContent,
    ...(evidenceQuote === "" || evidenceQuote === undefined
      ? {}
      : { evidenceQuote }),
  };
  const sourceClauses = splitEvidenceOnlyClauses(sourceText);
  const candidatePassesAudit = (clause: string): boolean =>
    auditEvidenceOnlyTextGrounding({
      text: clause,
      sources: [source],
      requireGroundedClaim: true,
    }).passed;
  const personRelationClauses =
    personRelationFallbackClauses(sourceText).filter(candidatePassesAudit);
  const groundedSourceClauses = sourceClauses
    .map(userPerspectiveFact)
    .map(stripTerminalPunctuation)
    .filter(Boolean)
    .filter(candidatePassesAudit);
  if (personRelationClauses.length > 0) {
    return [...new Set([...personRelationClauses, ...groundedSourceClauses])];
  }
  const placementClauses = sourceClauses
    .flatMap((clause) => placementFallbackClauses(item.memoryContent, clause))
    .filter(candidatePassesAudit);
  if (placementClauses.length > 0) {
    return [...new Set(placementClauses)];
  }
  return groundedSourceClauses;
}

function personRelationFallbackClauses(sourceText: string): string[] {
  const namedRelation = sourceText.match(
    /(?:^|[，。；;\s])(?:我|用户的?)(大学同学|高中同学|中学同学|小学同学)(?:叫|是)([\p{Script=Han}]{2,8})(?=最近|刚|已|现在|目前|住|搬|[，。；;\s]|$)/u,
  );
  const relation = namedRelation?.[1];
  const name = namedRelation?.[2];
  if (relation === undefined || name === undefined) return [];
  return [`${name}是你的${relation}`];
}

function placementFallbackClauses(
  memoryContent: string,
  evidenceClause: string,
): string[] {
  const identifier = (memoryContent
    .normalize("NFKC")
    .match(DISTINCTIVE_IDENTIFIERS) ?? [])[0];
  if (identifier === undefined) return [];
  const placement = evidenceClause.match(
    /(?:把|将)(?:一(?:枚|个|只|件|张|份|本|块|支|颗|条))?(.{1,40}?)(放在|放进|放到|装在|装进|装到|收在|藏在)(.{1,40})$/u,
  );
  const object = stripTerminalPunctuation(placement?.[1] ?? "").trim();
  const verb = placement?.[2];
  const location = stripTerminalPunctuation(placement?.[3] ?? "").trim();
  if (object === "" || verb === undefined || location === "") return [];
  return [`${identifier} 是${object}`, `${verb}${location}`];
}

function isHistoricalScheduleProposalEvidence(value: string): boolean {
  return /(?:共同邀约|待.{0,8}确认|尚待确认|确认之前.{0,12}(?:不会|不能).{0,8}(?:写入|加入)日程|不要声称.{0,16}(?:写入|加入)日程|你愿意吗|是否愿意)/u.test(
    value,
  );
}

function userPerspectiveFact(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/用户的/gu, "你的")
    .replace(/用户/gu, "你")
    .replace(/我的/gu, "你的")
    .replace(
      /(^|[，。；;]\s*)我(?=(?:大学|高中|中学|小学|同事|朋友))/gu,
      "$1你的",
    )
    .replace(/(?<=是)我(?=(?:大学|高中|中学|小学)同学)/gu, "你的")
    .replace(/(^|[，。；;]\s*)我(?=[\p{Script=Han}])/gu, "$1你")
    .replace(/我(?=会|是|可以|通常|把|对|不|有|喜欢|讨厌|接受)/gu, "你");
}

function stripTerminalPunctuation(value: string): string {
  return value.trim().replace(/[。！？!?；;，,]+$/gu, "");
}

interface MajorDecisionDelegation {
  subject: string;
}

const MAJOR_DECISION_TOPICS: ReadonlyArray<{
  pattern: RegExp;
  subject: string;
}> = [
  { pattern: /辞职|离职/u, subject: "是否辞职" },
  { pattern: /分手/u, subject: "是否分手" },
  { pattern: /结婚|领证/u, subject: "是否结婚" },
  { pattern: /离婚/u, subject: "是否离婚" },
  { pattern: /退学|辍学/u, subject: "是否退学" },
  { pattern: /搬家|迁居/u, subject: "是否搬家" },
];

const DIRECT_DECISION_DELEGATION =
  /(?:(?:你|请你|麻烦你)(?:(?:来|直接|干脆|就|索性))*(?:替|帮)我(?:来)?(?:做(?:出)?决定|决定|选择|拍板|做主|拿主意|定(?:一下|下来)?)|(?:请|麻烦)?(?:替|帮)我(?:来)?(?:做(?:出)?决定|决定|选择|拍板|做主|拿主意|定(?:一下|下来)?)|(?:你|请你)(?:(?:来|直接|干脆|就|索性))*(?:决定|选择|拍板|做主|拿主意)|(?:决定权|选择权)(?:交给|给)你|你说了算)/u;

const NEGATED_DECISION_DELEGATION =
  /(?:(?:不要|别|不用|无需|不必|不需要|请勿)(?:再|直接)?(?:让|叫|请|麻烦)?你?(?:来)?(?:替|帮)我(?:来)?(?:做(?:出)?决定|决定|选择|拍板|做主|拿主意|定)|不想(?:让|叫|请)?你?(?:来)?(?:替|帮)我(?:来)?(?:做(?:出)?决定|决定|选择|拍板|做主|拿主意|定)|不是(?:要|让)你(?:来)?(?:替|帮)我(?:来)?(?:做(?:出)?决定|决定|选择|拍板|做主|拿主意|定))/u;

const NON_MAJOR_DECISION_OBJECT =
  /辞职信|离职信|欢送会|交接|日期|时间|标题|措辞|模板|晚饭|午饭|晚餐|吃什么|餐厅|酒店|机票|车票|路线|地点/u;

const CLEAR_MAJOR_DECISION_REFUSAL =
  /(?:(?:我)?(?:不能|无法|没法|不会|不可以|不适合|不该|无权|不愿|不想|不打算)(?:直接|擅自)?(?:替|帮|代)你(?:来)?(?:做(?:出)?决定|决定|选择|拍板|做主|拿主意|定(?!不了))|(?:这个|这类|这种)?(?:决定|选择)[^。！？!?]{0,10}(?:我)?(?:不能|无法|没法|不会|不可以|不适合|不该|无权)(?:替|代)你(?:做|作出|下)?)/u;

const CLEAR_USER_DECISION_AUTHORITY =
  /(?:(?:决定权|选择权)(?:最终|仍然|还是)?(?:在|归|属于)你|(?:这个|最终|这类|这种)?(?:决定|选择)(?:仍然|最终|归根到底|还是)?(?:得|要|应该|只能)(?:由)?你自己(?:来)?(?:作出|做|定|决定|选择|拍板|拿主意)?|你自己(?:来)?(?:决定(?!不了)|选择|拍板|做主|拿主意)|你的人生[^。！？!?]{0,12}(?:你(?:自己)?做主|由你自己决定|得你自己))/u;

const MAJOR_DECISION_TAKEOVER =
  /(?:^|[，,。；;！？!?\n]|但|不过|可是|那么)(?:那|所以)?我(?:(?:已经|直接|就|来|现在))*(?:替你|帮你)(?:来)?(?:做(?:出)?决定|决定(?!不了)|选择|拍板|做主|拿主意|定(?:了|下来)?)/u;

const MAJOR_DECISION_MANDATE =
  /(?:^|[，,。；;！？!?\n]|但|不过|可是|那么)(?:所以|那)?你(?:必须|务必|一定要|现在就|立刻)(?:马上|立刻)?(?:辞职|离职|分手|结婚|领证|离婚|退学|辍学|搬家|迁居)/u;

function directMajorDecisionDelegation(
  userMessage: string,
): MajorDecisionDelegation | undefined {
  const normalized = userMessage.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    /(?:只是|仅仅|单纯)(?:在)?(?:引用|转述|举例)[^。！？!?]{0,80}(?:不是|并非)[^。！？!?]{0,20}(?:要求|请求|让)你/u.test(
      normalized,
    )
  ) {
    return undefined;
  }
  for (const sentence of normalized.split(/[。！？!?；;\n]+/u)) {
    if (
      sentence === "" ||
      /(?:如果|假如|假设|倘若|设想)[^。！？!?]{0,60}(?:会怎么|会如何|你会|怎么回应|如何回应)/u.test(
        sentence,
      ) ||
      NEGATED_DECISION_DELEGATION.test(sentence)
    ) {
      continue;
    }
    const topic = MAJOR_DECISION_TOPICS.find(({ pattern }) =>
      pattern.test(sentence),
    );
    const delegation = DIRECT_DECISION_DELEGATION.exec(sentence);
    if (topic === undefined || delegation === null) continue;
    if (
      /(?:已|已经|早已|早就)(?:明确|正式)?决定[^，,。！？!?]{0,10}(?:辞职|离职|分手|结婚|领证|离婚|退学|辍学|搬家|迁居)/u.test(
        sentence,
      )
    ) {
      continue;
    }
    const delegationStart = delegation.index;
    const delegationEnd = delegationStart + delegation[0].length;
    const nearbyStart = Math.max(0, delegationStart - 14);
    const nearbyEnd = Math.min(sentence.length, delegationEnd + 14);
    if (
      NON_MAJOR_DECISION_OBJECT.test(sentence.slice(nearbyStart, nearbyEnd))
    ) {
      continue;
    }
    const topicMatch = sentence.match(topic.pattern);
    const topicIndex = topicMatch?.index ?? -1;
    const uncertaintyMatch = sentence.match(
      /想|考虑|纠结|犹豫|拿不准|没想好|还没决定|不知道|要不要|是否|该不该|应不应该/u,
    );
    const uncertaintyIndex = uncertaintyMatch?.index ?? -1;
    const uncertaintyBindsTopic =
      topicIndex >= 0 &&
      uncertaintyIndex >= 0 &&
      Math.abs(topicIndex - uncertaintyIndex) <= 14;
    const delegationBindsTopic =
      topicIndex >= 0 &&
      Math.min(
        Math.abs(topicIndex - delegationStart),
        Math.abs(topicIndex - delegationEnd),
      ) <= 16;
    if (uncertaintyBindsTopic || delegationBindsTopic) {
      return { subject: topic.subject };
    }
  }
  return undefined;
}

function majorDecisionBoundaryIssues(
  userMessage: string,
  replyText: string,
): ReplyGenerationIssue[] {
  if (directMajorDecisionDelegation(userMessage) === undefined) return [];
  const normalizedReply = replyText.normalize("NFKC");
  const issues: ReplyGenerationIssue[] = [];
  if (
    MAJOR_DECISION_TAKEOVER.test(normalizedReply) ||
    MAJOR_DECISION_MANDATE.test(normalizedReply)
  ) {
    issues.push({
      code: "major_decision_takeover",
      message:
        "The reply takes over or commands a major life decision that must remain under the user's authority.",
    });
  }
  if (
    !CLEAR_MAJOR_DECISION_REFUSAL.test(normalizedReply) &&
    !CLEAR_USER_DECISION_AUTHORITY.test(normalizedReply)
  ) {
    issues.push({
      code: "major_decision_boundary_unaddressed",
      message:
        "The user directly delegated a major life decision, but the reply did not clearly refuse that delegation or preserve the user's decision authority.",
    });
  }
  return issues;
}

function majorDecisionBoundaryFallback(
  userMessage: string,
): string | undefined {
  const delegation = directMajorDecisionDelegation(userMessage);
  return delegation === undefined
    ? undefined
    : `我不能替你决定${delegation.subject}。这个决定只能由你自己作出；我可以陪你梳理各个选择的利弊和下一步。`;
}

function inspectReply(
  input: ReplyGenerationInput,
  reply: MaterializedPersonaReply,
): ReplyGenerationIssue[] {
  const guarded = guardPersonaReply({
    text: reply.text,
    avoidedPhrases: input.character.dialogue.avoidedPhrases,
    forbiddenMetaKnowledge: input.character.knowledge.forbiddenMetaKnowledge,
    acceptedScheduleEffects: toFeatureScheduleEffects(
      input.validatedOutcome.validation.accepted,
    ),
  });
  const issues: ReplyGenerationIssue[] = guarded.violations
    .filter((violation) => violation.severity === "error")
    .map((violation) => ({
      code: violation.code.toLocaleLowerCase(),
      message: violation.detail,
    }));
  const requiredQuotes =
    input.validatedOutcome.replyDirectives.mustAddressUserQuotes;
  if (input.validatedOutcome.route === "mixed") {
    const missingQuotes = requiredQuotes.filter(
      (quote) => !replyAddressesUserAnchor(input, reply.text, quote),
    );
    if (missingQuotes.length > 0) {
      issues.push({
        code: "unaddressed_mixed_turn_anchor",
        message:
          "The mixed-turn reply does not address every grounded user anchor alongside the schedule result.",
      });
    }
  } else if (
    requiredQuotes.length > 0 &&
    !requiredQuotes.some((quote) =>
      replyAddressesUserAnchor(input, reply.text, quote),
    )
  ) {
    issues.push({
      code: "unaddressed_user_anchor",
      message:
        "The reply does not address any grounded user quote required by the authoritative turn outcome.",
    });
  }
  for (const fact of input.validatedOutcome.replyDirectives
    .authoritativeFacts) {
    if (!replyAlignsWithAuthoritativeFact(reply.text, fact)) {
      issues.push({
        code: "authoritative_fact_unaddressed",
        message: `The reply does not address a server-authoritative ${fact.kind} fact required by the turn outcome.`,
      });
    }
  }
  const claimRestrictions = new Set(
    input.validatedOutcome.replyDirectives.mustNotClaim,
  );
  if (
    claimRestrictions.has("memory_persisted") &&
    replyClaimsPersistedMemory(reply.text)
  ) {
    issues.push({
      code: "uncommitted_memory_claim",
      message:
        "The reply claims durable memory persistence, which the authoritative outcome does not permit the reply to guarantee.",
    });
  }
  if (
    claimRestrictions.has("future_action_guaranteed") &&
    replyGuaranteesFutureAction(reply.text)
  ) {
    issues.push({
      code: "unguarded_future_action_claim",
      message:
        "The reply guarantees a future action that is not an authoritative committed outcome.",
    });
  }
  if (
    input.validatedOutcome.route === "schedule_query" ||
    input.validatedOutcome.route === "schedule_mutation" ||
    input.validatedOutcome.route === "mixed"
  ) {
    issues.push(
      ...scheduleTruthIssues(
        reply.text,
        input.validatedOutcome.scheduleOutcome,
        input.validatedOutcome.replyDirectives,
      ),
    );
  }
  issues.push(
    ...explicitConstraintIssues(
      reply.text,
      deriveExplicitReplyConstraints(input.userMessage),
    ),
    ...majorDecisionBoundaryIssues(input.userMessage, reply.text),
    ...suppressedTopicIssues(input, reply.text),
    ...evidenceGroundingIssues(input, reply.text),
    ...currentUserFactGroundingIssues(input, reply.text),
    ...activatedGoalQuestionIssues(input, reply.text),
  );
  return uniqueIssues(issues);
}

function scheduleTruthIssues(
  text: string,
  outcome: ScheduleOutcome,
  directives: ValidatedTurnOutcome["replyDirectives"],
): ReplyGenerationIssue[] {
  const issues: ReplyGenerationIssue[] = [];
  const mutationClaim = replyClaimsScheduleMutation(text);
  const agreementClaim = replyClaimsRecordedAgreement(text);
  const committedAuthority = hasCommittedScheduleAuthority(directives);
  if (outcome.kind !== "committed" && mutationClaim) {
    issues.push({
      code: "uncommitted_schedule_claim",
      message:
        "The reply claims a schedule mutation that is not present in the authoritative outcome.",
    });
  }
  if (
    outcome.kind !== "committed" &&
    outcome.kind !== "pending_confirmation" &&
    agreementClaim &&
    (!committedAuthority || replyClaimsRejectedMutationAgreement(text))
  ) {
    issues.push({
      code: "uncommitted_schedule_agreement",
      message:
        "The reply claims a settled agreement without an authoritative committed or pending outcome.",
    });
  }
  if (
    outcome.kind === "pending_confirmation" &&
    (mutationClaim || replyClaimsFinalAgreement(text))
  ) {
    issues.push({
      code: "pending_schedule_overclaim",
      message:
        "The reply must describe the offer as pending confirmation, not committed.",
    });
  }
  if (
    (outcome.kind === "committed" || committedAuthority) &&
    replyDeniesCommittedSchedule(text)
  ) {
    issues.push({
      code: "committed_schedule_contradiction",
      message:
        "The reply contradicts the authoritative committed schedule outcome.",
    });
  } else if (
    (outcome.kind === "committed" || committedAuthority) &&
    !replyAffirmsCommittedSchedule(text)
  ) {
    issues.push({
      code: "committed_schedule_status_unaddressed",
      message:
        "The reply does not explicitly affirm the authoritative committed schedule status.",
    });
  }
  return uniqueIssues(issues);
}

function hasCommittedScheduleAuthority(
  directives: ValidatedTurnOutcome["replyDirectives"],
): boolean {
  return directives.authoritativeFacts.some((fact) => {
    if (fact.kind !== "schedule") return false;
    const structured = fact as typeof fact & {
      scheduleAuthorityState?: "committed" | "pending" | "withdrawn" | "absent";
    };
    return (
      structured.scheduleAuthorityState === "committed" ||
      /(?:当前|原|已经|已).{0,8}确认.{0,8}(?:生效|保持不变|共同安排)|已确认并生效/u.test(
        fact.text,
      )
    );
  });
}

function currentUserFactGroundingIssues(
  input: ReplyGenerationInput,
  text: string,
): ReplyGenerationIssue[] {
  if (
    input.validatedOutcome.acceptedWorldEffects.memoryCandidates.length === 0
  ) {
    return [];
  }
  const grounding = auditDirectUserFactTextGrounding({
    text,
    memorySources: [{ memoryContent: input.userMessage }],
    authoritativeFacts:
      input.validatedOutcome.replyDirectives.authoritativeFacts,
    requireGroundedMemoryClaim: false,
    userMessage: input.userMessage,
  });
  return grounding.passed
    ? []
    : [
        {
          code: "unsupported_current_user_fact_claim",
          message:
            "The reply adds factual claims that are not supported by the user's current explicit fact statement.",
        },
      ];
}

type ActivatedGoalQuestionKind = "progress" | "bottleneck" | "choice";

type ActivatedGoal =
  ReplyGenerationInput["character"]["persona"]["goals"][number];

type GoalEvidenceItem = EvidenceBundle["evidence"][number];

type GoalEvidenceStatus =
  "completed" | "in_progress" | "partial" | "skipped" | "cancelled" | "unknown";

interface LatestGoalEvidenceSnapshot {
  item: GoalEvidenceItem | undefined;
  status: GoalEvidenceStatus;
  ambiguous: boolean;
}

const HIGH_RISK_GOAL_PROGRESS_DETAIL =
  /(?:粗剪|初剪|精剪|剪辑|素材|便利店|转场|镜头|采访|拍摄|补拍|场景|段落|旁白|配乐|字幕|调色|收音|音轨|样片|成片|时间线|开场|结尾|人物线索|第[一二三四五六七八九十\d]+(?:个)?阶段|前半部分|后半部分)/u;

function activatedGoalQuestionIssues(
  input: ReplyGenerationInput,
  text: string,
): ReplyGenerationIssue[] {
  const kind = activatedGoalQuestionKind(input.userMessage);
  const goal = activatedGoal(input);
  if (kind === undefined || goal === undefined) return [];
  const residual = stripEchoedGoalQuestion(text, input.userMessage);
  if (!substantivelyAnswersGoalQuestion(residual, kind)) {
    return [
      {
        code: "activated_goal_question_unanswered",
        message:
          "The reply echoes or defers an explicit activated-goal question without answering its progress, bottleneck, or choice.",
      },
    ];
  }
  switch (kind) {
    case "progress":
      return activatedGoalProgressGroundingIssues(input, residual, goal);
    case "bottleneck":
      return activatedGoalBottleneckGroundingIssues(input, residual, goal);
    case "choice":
      return activatedGoalChoiceIssues(residual);
  }
}

function activatedGoalBottleneckGroundingIssues(
  input: ReplyGenerationInput,
  text: string,
  goal: ActivatedGoal,
): ReplyGenerationIssue[] {
  const policy = replyEvidencePolicy(input);
  const relevantEvidenceItems = relevantGoalEvidenceItems(
    goal.title,
    goal.description,
    selectAllowedEvidence(input.memoryEvidence, policy.allowedEvidenceIds),
  );
  const latestEvidence = latestGoalEvidenceSnapshot(relevantEvidenceItems);
  const evidenceItems =
    !latestEvidence.ambiguous && latestEvidence.item !== undefined
      ? [latestEvidence.item]
      : [];
  const expectedPercent = Math.round(goal.progress * 100);
  const completionEvidence = latestEvidence.status === "completed";
  const authorizedPercentages = new Set<number>([
    expectedPercent,
    ...evidenceItems.flatMap(itemSupportedProgressPercentages),
    ...(completionEvidence ? [100] : []),
  ]);
  if (
    goalProgressPercentages(text).some(
      (percentage) => !authorizedPercentages.has(percentage),
    )
  ) {
    return [
      {
        code: "unsupported_activated_goal_bottleneck_percentage",
        message: `An epistemic bottleneck answer may only append the exact structured goal progress of ${expectedPercent}% or a percentage stated in selected evidence.`,
      },
    ];
  }
  const specificClaims = splitEvidenceOnlyClauses(text).filter(
    (clause) =>
      textStatesSpecificGoalBottleneck(clause) && !goalEpistemicAnswer(clause),
  );
  if (specificClaims.length === 0 && goalEpistemicAnswer(text)) return [];

  const bottleneckEvidenceItems = evidenceItems.filter(
    itemSupportsGoalBottleneck,
  );
  const sources = goalEvidenceGroundingSources(bottleneckEvidenceItems);
  if (
    specificClaims.length > 0 &&
    sources.length > 0 &&
    specificClaims.every(
      (claim) =>
        auditEvidenceOnlyTextGrounding({
          text: claim,
          sources,
          requireGroundedClaim: true,
        }).passed,
    )
  ) {
    return [];
  }
  return [
    {
      code: "unsupported_activated_goal_bottleneck_claim",
      message:
        "A specific activated-goal bottleneck must be grounded in selected temporal evidence; choices listed in the user's question do not establish the current bottleneck.",
    },
  ];
}

function activatedGoalChoiceIssues(text: string): ReplyGenerationIssue[] {
  const issues: ReplyGenerationIssue[] = [];
  if (!conditionallyAnswersGoalChoice(text)) {
    issues.push({
      code: "activated_goal_choice_not_conditional",
      message:
        "The activated-goal choice answer must remain conditional instead of asserting a current goal state.",
    });
  }
  const currentFactClauses = splitEvidenceOnlyClauses(text).filter((clause) => {
    if (goalEpistemicAnswer(clause)) return false;
    if (goalChoiceClause(clause)) return false;
    return (
      HIGH_RISK_GOAL_PROGRESS_DETAIL.test(clause) ||
      goalProgressPercentages(clause).length > 0 ||
      textClaimsGoalCompletion(clause) ||
      textClaimsGoalIncomplete(clause) ||
      /(?:当前|目前|现在|已经|正在|还在|进度|做到|推进到|阶段)/u.test(clause)
    );
  });
  if (currentFactClauses.length > 0) {
    issues.push({
      code: "activated_goal_choice_current_fact",
      message:
        "A conditional activated-goal choice must not append unsupported claims about the goal's current production stage or materials.",
    });
  }
  return uniqueIssues(issues);
}

function conditionallyAnswersGoalChoice(text: string): boolean {
  return (
    /(?:如果|要是|假如|一旦|真(?:的)?遇到|遇到.{0,12}(?:时|的话))/u.test(
      text,
    ) && /(?:暂停|停一下|停一停|换.{0,5}(?:视角|思路)|不.{0,6}硬撑)/u.test(text)
  );
}

function goalChoiceClause(clause: string): boolean {
  return (
    /(?:如果|要是|假如|一旦|真(?:的)?遇到|遇到.{0,12}(?:时|的话))/u.test(
      clause,
    ) ||
    /(?:(?:(?:我)?会|先|选择|不会).{0,12}(?:暂停|停一下|停一停|硬撑)|换.{0,5}(?:视角|思路)|不.{0,6}硬撑)/u.test(
      clause,
    )
  );
}

function activatedGoalProgressGroundingIssues(
  input: ReplyGenerationInput,
  text: string,
  goal: ActivatedGoal,
): ReplyGenerationIssue[] {
  const policy = replyEvidencePolicy(input);
  const selectedEvidence = selectAllowedEvidence(
    input.memoryEvidence,
    policy.allowedEvidenceIds,
  );
  const relevantEvidenceItems = relevantGoalEvidenceItems(
    goal.title,
    goal.description,
    selectedEvidence,
  );
  const latestEvidence = latestGoalEvidenceSnapshot(relevantEvidenceItems);
  const evidenceItems =
    !latestEvidence.ambiguous && latestEvidence.item !== undefined
      ? [latestEvidence.item]
      : [];
  const expectedPercent = Math.round(goal.progress * 100);
  const reportedPercentages = goalProgressPercentages(text);
  const completionEvidence = latestEvidence.status === "completed";
  const stateClaimText = stripGoalDefinitionMentions(text, goal);
  const replyClaimsCompletion = textClaimsGoalCompletion(stateClaimText);
  const replyClaimsIncomplete = textClaimsGoalIncomplete(stateClaimText);
  const issues: ReplyGenerationIssue[] = [];

  const unsupportedDetails = unsupportedGoalProgressDetailClauses(
    text,
    goal,
    evidenceItems,
  );
  if (unsupportedDetails.length > 0) {
    issues.push({
      code: "unsupported_activated_goal_progress_detail",
      message:
        "The activated-goal progress reply adds concrete production details that are absent from the goal title, goal description, and selected evidence.",
    });
  }

  if (
    completionEvidence &&
    (replyClaimsIncomplete ||
      reportedPercentages.some((percentage) => percentage < 100))
  ) {
    issues.push({
      code: "activated_goal_progress_completion_conflict",
      message:
        "Selected occurred evidence says the activated goal was completed, so the reply must not describe it as unfinished or report a sub-100% progress value.",
    });
  } else if (
    !completionEvidence &&
    ((expectedPercent < 100 && replyClaimsCompletion) ||
      (expectedPercent === 100 && replyClaimsIncomplete))
  ) {
    issues.push({
      code: "activated_goal_progress_structured_conflict",
      message: `The reply contradicts the activated goal's structured progress value of ${expectedPercent}%.`,
    });
  }

  const authorizedPercentages = new Set<number>([
    expectedPercent,
    ...evidenceItems.flatMap(itemSupportedProgressPercentages),
    ...(completionEvidence ? [100] : []),
  ]);
  if (
    reportedPercentages.some(
      (percentage) => !authorizedPercentages.has(percentage),
    )
  ) {
    issues.push({
      code: "unsupported_activated_goal_progress_percentage",
      message: `The activated-goal progress reply must use the exact structured value of ${expectedPercent}% or a percentage stated in selected goal evidence.`,
    });
  }

  if (issues.length > 0) return uniqueIssues(issues);

  const affirmativeClaim =
    reportedPercentages.length > 0 ||
    replyClaimsCompletion ||
    replyClaimsIncomplete ||
    /(?:(?:已经|已)(?:开始|推进)|(?:开始|推进)(?:了|到)|(?:做到|推进到).{0,8}(?:阶段|\d|百分之)|下一步(?:是|要|会))/u.test(
      stateClaimText,
    );
  if (
    goalEpistemicAnswer(text) &&
    !affirmativeClaim &&
    latestEvidence.status === "unknown"
  ) {
    return [];
  }
  if (reportedPercentages.length > 0) return [];
  if (completionEvidence && replyClaimsCompletion) return [];
  if (
    evidenceItems.some(
      (item) => item.temporalMetadata?.temporalStatus === "in_progress",
    ) &&
    replyClaimsIncomplete
  ) {
    return [];
  }
  if (goalProgressClaimGroundedInEvidence(stateClaimText, evidenceItems)) {
    return [];
  }
  return [
    {
      code: "unsupported_activated_goal_progress_claim",
      message: `Activated-goal progress must be grounded in selected evidence, report the exact structured value of ${expectedPercent}%, or explicitly abstain when no more precise evidence exists.`,
    },
  ];
}

function relevantGoalEvidenceItems(
  title: string,
  description: string,
  evidence: EvidenceBundle | undefined,
): EvidenceBundle["evidence"] {
  if (evidence === undefined) return [];
  const anchors = distinctiveGoalAnchors(title, description);
  return evidence.evidence.filter((item) => {
    const status = item.temporalMetadata?.temporalStatus;
    if (status !== "occurred" && status !== "in_progress") return false;
    const comparable = comparableAnchorText(
      `${item.memoryContent} ${item.evidence.quote ?? ""}`,
    );
    return anchors.some((anchor) => comparable.includes(anchor));
  });
}

function unsupportedGoalProgressDetailClauses(
  text: string,
  goal: ActivatedGoal,
  evidenceItems: EvidenceBundle["evidence"],
): string[] {
  const sources: EvidenceOnlyGroundingSource[] = [
    { memoryContent: goal.title },
    { memoryContent: goal.description },
    ...goalEvidenceGroundingSources(evidenceItems),
  ];
  return splitEvidenceOnlyClauses(text).filter((clause) => {
    if (goalEpistemicAnswer(clause)) return false;
    if (!HIGH_RISK_GOAL_PROGRESS_DETAIL.test(clause)) return false;
    const detailClaim = stripGoalProgressPercentageText(clause)
      .replace(
        /^(?:(?:按|根据)(?:现有|目前)(?:可靠)?(?:记录|证据|依据))[，,：:\s]*/u,
        "",
      )
      .trim();
    if (detailClaim === "") return false;
    return !auditEvidenceOnlyTextGrounding({
      text: detailClaim,
      sources,
      requireGroundedClaim: true,
    }).passed;
  });
}

function goalProgressClaimGroundedInEvidence(
  text: string,
  evidenceItems: EvidenceBundle["evidence"],
): boolean {
  if (evidenceItems.length === 0) return false;
  const claim = text
    .replace(
      /^(?:(?:按|根据)(?:现有|目前)(?:可靠)?(?:记录|证据|依据))[，,：:\s]*/u,
      "",
    )
    .trim();
  if (claim === "") return false;
  return auditEvidenceOnlyTextGrounding({
    text: claim,
    sources: goalEvidenceGroundingSources(evidenceItems),
    requireGroundedClaim: true,
  }).passed;
}

function goalEvidenceGroundingSources(
  evidenceItems: EvidenceBundle["evidence"],
): EvidenceOnlyGroundingSource[] {
  return evidenceItems.map((item) => ({
    memoryContent: item.memoryContent,
    ...(item.evidence.quote === undefined
      ? {}
      : { evidenceQuote: item.evidence.quote }),
  }));
}

function goalProgressPercentages(text: string): number[] {
  const normalized = text.normalize("NFKC");
  const percentages = [
    ...[...normalized.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/gu)].map((match) =>
      Number(match[1]),
    ),
    ...[...normalized.matchAll(/百分之\s*(\d{1,3}(?:\.\d+)?)/gu)].map((match) =>
      Number(match[1]),
    ),
    ...[
      ...normalized.matchAll(
        /百分之\s*([零〇一二两三四五六七八九十百]{1,4})/gu,
      ),
    ].map((match) => chineseGoalPercentage(match[1] ?? "")),
  ];
  return [...new Set(percentages)].filter(
    (percentage): percentage is number =>
      percentage !== null &&
      Number.isFinite(percentage) &&
      percentage >= 0 &&
      percentage <= 100,
  );
}

function chineseGoalPercentage(value: string): number | null {
  const normalized = value.replace(/[〇]/gu, "零").replace(/[两]/gu, "二");
  const digit = new Map<string, number>([
    ["零", 0],
    ["一", 1],
    ["二", 2],
    ["三", 3],
    ["四", 4],
    ["五", 5],
    ["六", 6],
    ["七", 7],
    ["八", 8],
    ["九", 9],
  ]);
  if (normalized === "一百") return 100;
  if (!normalized.includes("十")) return digit.get(normalized) ?? null;
  const [tensText = "", onesText = ""] = normalized.split("十");
  if (normalized.split("十").length !== 2) return null;
  const tens = tensText === "" ? 1 : digit.get(tensText);
  const ones = onesText === "" ? 0 : digit.get(onesText);
  if (tens === undefined || ones === undefined) return null;
  const percentage = tens * 10 + ones;
  return percentage <= 99 ? percentage : null;
}

function stripGoalProgressPercentageText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\d{1,3}(?:\.\d+)?\s*%/gu, " ")
    .replace(/百分之\s*\d{1,3}(?:\.\d+)?/gu, " ")
    .replace(/百分之\s*[零〇一二两三四五六七八九十百]{1,4}/gu, " ");
}

function itemSupportedProgressPercentages(
  item: EvidenceBundle["evidence"][number],
): number[] {
  const contentPercentages = goalProgressPercentages(item.memoryContent);
  const quote = item.evidence.quote;
  if (quote === undefined) return contentPercentages;
  const quotePercentages = new Set(goalProgressPercentages(quote));
  return contentPercentages.filter((percentage) =>
    quotePercentages.has(percentage),
  );
}

function itemSupportsGoalCompletion(
  item: EvidenceBundle["evidence"][number],
): boolean {
  if (item.temporalMetadata?.temporalStatus !== "occurred") return false;
  if (
    /(?:部分完成|只完成(?:了)?一部分|完成(?:了)?一部分|未能进行|没有进行|未开展|跳过|取消)/u.test(
      item.memoryContent,
    )
  ) {
    return false;
  }
  if (!textClaimsGoalCompletion(item.memoryContent)) return false;
  const quote = item.evidence.quote;
  return (
    quote === undefined ||
    (!/(?:部分完成|只完成(?:了)?一部分|完成(?:了)?一部分|未能进行|没有进行|未开展|跳过|取消)/u.test(
      quote,
    ) &&
      textClaimsGoalCompletion(quote))
  );
}

function itemSupportsGoalBottleneck(
  item: EvidenceBundle["evidence"][number],
): boolean {
  if (!textStatesSpecificGoalBottleneck(item.memoryContent)) return false;
  const quote = item.evidence.quote;
  return quote === undefined || textStatesSpecificGoalBottleneck(quote);
}

function textStatesSpecificGoalBottleneck(text: string): boolean {
  return /(?:(?:最卡的?(?:是|在)|卡在|瓶颈(?:是|在)).{0,40}(?:素材|结构|时间|开场|人物|线索|剪辑|叙事|取舍)|(?:素材|结构|时间|开场|人物|线索|剪辑|叙事|取舍).{0,30}(?:受阻|卡住|成为瓶颈|是难点))/u.test(
    text,
  );
}

function textClaimsGoalCompletion(text: string): boolean {
  if (goalProgressPercentages(text).some((percentage) => percentage < 100)) {
    return false;
  }
  if (/(?:还没|尚未|未|没有|并未).{0,4}(?:完成|做完|结束)/u.test(text)) {
    return false;
  }
  return /(?:(?:已经|已)(?:经)?(?:全部|整体|全片)?(?:完成|做完|结束)(?!\s*(?:(?:约|大约|大概|近)?\d|百分之))|(?:完成|做完|结束)(?:了|完毕)(?!\s*(?:(?:约|大约|大概|近)?\d|百分之)))/u.test(
    text,
  );
}

function textClaimsGoalIncomplete(text: string): boolean {
  if (goalProgressPercentages(text).some((percentage) => percentage < 100)) {
    return true;
  }
  return /(?:(?:还没|尚未|未|没有|并未).{0,4}(?:完成|做完|结束)|(?:还在|正在|仍在).{0,16}(?:推进|进行|制作|拍摄|剪辑|整理|粗剪|初剪)|(?:处于|停留在).{0,12}(?:阶段|制作中|拍摄中|剪辑中)|(?:只|仅).{0,8}(?:完成|做到)|下一步.{0,12}(?:还要|需要|准备))/u.test(
    text,
  );
}

function stripGoalDefinitionMentions(
  text: string,
  goal: ActivatedGoal,
): string {
  return [goal.title, goal.description]
    .filter((value) => value.trim() !== "")
    .sort((left, right) => right.length - left.length)
    .reduce(
      (residual, value) =>
        residual.replace(new RegExp(escapeRegExp(value), "gu"), " "),
      text,
    );
}

function activatedGoalQuestionKind(
  userMessage: string,
): ActivatedGoalQuestionKind | undefined {
  if (
    /(?:暂停(?:一下)?|停一下).{0,20}(?:硬撑|做完)|(?:硬撑|做完).{0,20}(?:暂停|停一下)/u.test(
      userMessage,
    )
  ) {
    return "choice";
  }
  if (/(?:最卡|卡在|瓶颈)/u.test(userMessage)) return "bottleneck";
  return /(?:做到哪一步|进展|进度|目标和进展|什么阶段|完成到哪|进行得怎么样)/u.test(
    userMessage,
  )
    ? "progress"
    : undefined;
}

function activatedGoal(input: ReplyGenerationInput) {
  const activatedIds = new Set(input.contextPlan.activatedGoalIds);
  return input.character.persona.goals.find((goal) =>
    activatedIds.has(goal.id),
  );
}

function stripEchoedGoalQuestion(text: string, userMessage: string): string {
  let residual = text.replace(
    new RegExp(escapeRegExp(userMessage.trim()), "gu"),
    " ",
  );
  const normalizedQuestion = comparableAnchorText(userMessage);
  residual = residual.replace(
    /[“「『"]([^”」』"]{2,240})[”」』"]/gu,
    (whole, quoted: string) => {
      const normalizedQuote = comparableAnchorText(quoted);
      return normalizedQuote !== "" &&
        (normalizedQuestion.includes(normalizedQuote) ||
          normalizedQuote.includes(normalizedQuestion))
        ? " "
        : whole;
    },
  );
  return residual
    .replace(/我(?:听见|知道|明白).{0,18}(?:你(?:在)?问|你说)/gu, " ")
    .replace(
      /(?:我们可以|可以|愿意的话).{0,18}(?:继续|顺着).{0,8}(?:聊|说|谈)/gu,
      " ",
    )
    .trim();
}

function substantivelyAnswersGoalQuestion(
  text: string,
  kind: ActivatedGoalQuestionKind,
): boolean {
  if (goalEpistemicAnswer(text)) return true;
  switch (kind) {
    case "choice":
      return /(?:会|我会|先|选择).{0,10}(?:暂停|停一下|停一停|换.{0,5}(?:视角|思路))|(?:不|不会).{0,6}硬撑/u.test(
        text,
      );
    case "bottleneck":
      return /(?:最卡的?(?:是|在)|卡在|瓶颈(?:是|在)).{0,30}(?:素材|结构|时间|开场|人物|线索|剪辑|叙事|取舍)/u.test(
        text,
      );
    case "progress":
      return /(?:已经|已|正在|完成(?:了|到|过)|未能进行|没有进行|未开展|跳过(?:了)?|取消(?:了)?|部分完成|只完成(?:了)?一部分|目前.{0,16}(?:阶段|重点|做到)|下一步|进度.{0,12}(?:约|大约|大概|\d|百分之)|\d{1,3}\s*%)/u.test(
        text,
      );
  }
}

function goalEpistemicAnswer(text: string): boolean {
  return /(?:现有|目前).{0,14}(?:信息|记录|依据).{0,14}(?:不足|不够|没有)|(?:无法|不能|没法).{0,8}确认|不知道|不确定|不想编造|不敢编造/u.test(
    text,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function evidenceGroundingIssues(
  input: ReplyGenerationInput,
  text: string,
): ReplyGenerationIssue[] {
  const policy = replyEvidencePolicy(input);
  if (!policy.mustNotInferFromPersona) return [];
  const evidence = selectAllowedEvidence(
    input.memoryEvidence,
    policy.allowedEvidenceIds,
  );
  const recentUserFactEvidence = selectRecentUserFactEvidence(
    input,
    policy,
    evidence,
  );
  if (policy.evidenceOnly && evidence === undefined) {
    if (!policy.mustAbstain) return [];
    return /不知道|没有.{0,8}(?:证据|依据|记录)|不确定|无法确认/u.test(text)
      ? []
      : [
          {
            code: "evidence_only_answer_without_evidence",
            message:
              "The reply makes a factual answer even though no allowed evidence is available.",
          },
        ];
  }
  const memorySources =
    evidence?.evidence.map((item) => ({
      memoryContent: item.memoryContent,
      ...(item.evidence.quote === undefined
        ? {}
        : { evidenceQuote: item.evidence.quote }),
    })) ?? [];
  memorySources.push(
    ...recentUserFactEvidence.map((message) => ({
      memoryContent: message.content,
    })),
  );
  const grounding = policy.evidenceOnly
    ? auditEvidenceOnlyTextGrounding({ text, sources: memorySources })
    : auditDirectUserFactTextGrounding({
        text,
        memorySources,
        authoritativeFacts:
          input.validatedOutcome.replyDirectives.authoritativeFacts,
        requireGroundedMemoryClaim: memorySources.length > 0,
        userMessage: input.userMessage,
      });
  return grounding.passed
    ? []
    : [
        {
          code: "unsupported_evidence_only_claim",
          message:
            "One or more factual clauses are not grounded in the selected evidence.",
        },
      ];
}

const DISTINCTIVE_IDENTIFIERS =
  /(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9_-]{2,}/giu;

function materializeReply(
  response: PersonaChatResponse,
): MaterializedPersonaReply {
  const faithfulChunks = faithfulResponseChunks(response);
  const sequential =
    response.deliveryMode === "sequential" &&
    faithfulChunks !== undefined &&
    faithfulChunks.length > 1;
  const chunks = sequential ? faithfulChunks : [response.text];
  return {
    text: chunks.join("\n"),
    chunks,
    toneTags: response.toneTags ?? [],
  };
}

function faithfulResponseChunks(
  response: PersonaChatResponse,
): string[] | undefined {
  if (response.chunks === undefined || response.chunks.length === 0) {
    return undefined;
  }
  const chunks = response.chunks.map((chunk) => chunk.trim()).filter(Boolean);
  const joined = comparableText(chunks.join(""));
  const joinedWithLines = comparableText(chunks.join("\n"));
  const complete = comparableText(response.text);
  return joined === complete || joinedWithLines === complete
    ? chunks
    : undefined;
}

function comparableText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function fallbackResponse(
  input: ReplyGenerationInput,
  evidence: EvidenceBundle | undefined,
  constraints: ExplicitReplyConstraints,
): PersonaChatResponse {
  const outcome = input.validatedOutcome;
  const warmth = input.character.dialogue.warmth;
  const schedule = outcome.scheduleOutcome;
  const scheduleSummary = authoritativeScheduleSummary(outcome);
  const activityFact = outcome.replyDirectives.authoritativeFacts.find(
    (fact) => fact.kind === "activity",
  );
  let text: string;
  if (activityFact !== undefined) {
    text = `我核对了，${stripTerminalPunctuation(activityFact.text)}。`;
  } else
    switch (schedule.kind) {
      case "read_only": {
        const facts = outcome.replyDirectives.authoritativeFacts
          .filter((fact) => fact.kind === "schedule")
          .map((fact) => fact.text);
        text =
          facts.length === 0
            ? "我核对了，没有找到与你刚才询问相符的共同安排。"
            : `我核对了，你问的共同安排是：${facts
                .map(stripTerminalPunctuation)
                .join("；")}。`;
        break;
      }
      case "needs_clarification":
        text = `我还需要你说清楚${naturalMissingFields(schedule.missingFields)}，确认之前我不会改动日程。`;
        break;
      case "pending_confirmation":
        text = `${
          scheduleSummary === undefined ? "这个安排" : scheduleSummary
        }目前只是待确认方案；你明确确认后，它才会写入日程。`;
        break;
      case "committed":
        text = `${
          scheduleSummary === undefined ? "这个安排" : scheduleSummary
        }已经确认并加入日程了。`;
        break;
      case "declined":
        text = `${
          scheduleSummary === undefined ? "这次待确认的安排" : scheduleSummary
        }先取消，日程没有改动。`;
        break;
      case "rejected":
        text =
          scheduleSummary !== undefined &&
          hasCommittedScheduleAuthority(outcome.replyDirectives)
            ? `我核对了，${stripTerminalPunctuation(scheduleSummary)}。`
            : "这个安排目前还不能安全确认，我们先核对清楚具体活动和时间。";
        break;
      case "none": {
        const goalFallback = activatedGoalFallback(input, evidence);
        const currentFactFallback = currentUserFactFallback(input);
        text =
          constraints.requiresPreparationPlan === true &&
          constraints.requiredPreparationMinutes !== undefined
            ? timeboxedPreparationFallback(
                constraints.requiredPreparationMinutes,
                constraints.requiresEmotionalAcknowledgement === true,
              )
            : constraints.requiresAdviceResponse === true
              ? shortAdviceFallback()
              : constraints.forbidFollowUpQuestions === true
                ? stoppedTopicFallback(warmth)
                : (goalFallback ??
                  currentFactFallback ??
                  naturalNoopFallback(
                    outcome.replyDirectives.mustAddressUserQuotes[0],
                    warmth,
                  ));
        break;
      }
    }
  if (outcome.route === "mixed") {
    text = appendMissingMixedTurnAnchors(
      text,
      outcome.replyDirectives.mustAddressUserQuotes,
    );
  }
  const decisionBoundary = majorDecisionBoundaryFallback(input.userMessage);
  if (decisionBoundary !== undefined) {
    text =
      activityFact === undefined &&
      schedule.kind === "none" &&
      outcome.route !== "mixed"
        ? decisionBoundary
        : `${decisionBoundary}${text}`;
  }
  return PersonaChatResponseSchema.parse({
    text,
    toneTags: warmth >= 0.6 ? ["自然", "温和"] : ["自然", "克制"],
    deliveryMode: "single_block",
  });
}

function currentUserFactFallback(
  input: ReplyGenerationInput,
): string | undefined {
  if (
    input.validatedOutcome.acceptedWorldEffects.memoryCandidates.length === 0
  ) {
    return undefined;
  }
  const source = input.userMessage.replace(/\s+/gu, " ").trim().slice(0, 600);
  if (source === "") return undefined;
  const memorySource = { memoryContent: source };
  const facts = groundedFallbackClauses(memorySource)
    .filter(
      (fact) =>
        auditDirectUserFactTextGrounding({
          text: fact,
          memorySources: [memorySource],
          authoritativeFacts:
            input.validatedOutcome.replyDirectives.authoritativeFacts,
          requireGroundedMemoryClaim: true,
          userMessage: input.userMessage,
        }).passed,
    )
    .slice(0, 3);
  return facts.length === 0
    ? "好的。"
    : `${facts.map(stripTerminalPunctuation).join("；")}。`;
}

function activatedGoalFallback(
  input: ReplyGenerationInput,
  evidence: EvidenceBundle | undefined,
): string | undefined {
  const kind = activatedGoalQuestionKind(input.userMessage);
  const goal = activatedGoal(input);
  if (kind === undefined || goal === undefined) return undefined;
  if (kind === "choice") {
    return "如果遇到瓶颈，我会先暂停一下，换个视角再继续，不会靠硬撑把判断力耗掉。";
  }
  if (kind === "bottleneck") {
    const bottleneckEvidenceText = latestGoalBottleneckEvidenceText(
      goal.title,
      goal.description,
      evidence,
    );
    return bottleneckEvidenceText !== undefined
      ? `按现有记录，${stripTerminalPunctuation(bottleneckEvidenceText)}。`
      : "目前的可靠记录不足以判断最卡在素材、结构还是时间，我不想编造。";
  }
  const evidenceText = latestGoalEvidenceText(
    goal.title,
    goal.description,
    evidence,
  );
  if (evidenceText !== undefined) {
    const relevantEvidence = relevantGoalEvidenceItems(
      goal.title,
      goal.description,
      evidence,
    );
    const latestEvidence = latestGoalEvidenceSnapshot(relevantEvidence);
    if (latestEvidence.status === "completed") {
      return `按现有记录，${stripTerminalPunctuation(evidenceText)}。`;
    }
    const progress = Math.round(goal.progress * 100);
    return `按现有记录，${stripTerminalPunctuation(evidenceText)}；当前目标记录的进度约为 ${progress}%。`;
  }
  const progress = Math.round(goal.progress * 100);
  return `关于“${stripTerminalPunctuation(goal.title)}”，当前目标记录的进度约为 ${progress}%。现在的方向是：${stripTerminalPunctuation(goal.description)}。`;
}

function latestGoalEvidenceText(
  title: string,
  description: string,
  evidence: EvidenceBundle | undefined,
): string | undefined {
  const latest = latestGoalEvidenceSnapshot(
    relevantGoalEvidenceItems(title, description, evidence),
  );
  if (latest.ambiguous || latest.status === "unknown") return undefined;
  const text = latest.item?.memoryContent.trim();
  return text === "" ? undefined : text;
}

function latestGoalBottleneckEvidenceText(
  title: string,
  description: string,
  evidence: EvidenceBundle | undefined,
): string | undefined {
  const latest = latestGoalEvidenceSnapshot(
    relevantGoalEvidenceItems(title, description, evidence),
  );
  if (
    latest.ambiguous ||
    latest.item === undefined ||
    !itemSupportsGoalBottleneck(latest.item)
  ) {
    return undefined;
  }
  const text = latest.item.memoryContent.trim();
  return text === "" ? undefined : text;
}

function latestGoalEvidenceSnapshot(
  evidenceItems: readonly GoalEvidenceItem[],
): LatestGoalEvidenceSnapshot {
  if (evidenceItems.length === 0) {
    return { item: undefined, status: "unknown", ambiguous: false };
  }
  const timestamps = evidenceItems.map((item) => ({
    item,
    timestamp: goalEvidenceTimestamp(item),
  }));
  const latestTimestamp = Math.max(
    ...timestamps.map(({ timestamp }) => timestamp),
  );
  const candidates = timestamps
    .filter(({ timestamp }) => timestamp === latestTimestamp)
    .map(({ item }) => item);
  const statuses = new Set(candidates.map(goalEvidenceStatus));
  if (statuses.size !== 1) {
    return { item: undefined, status: "unknown", ambiguous: true };
  }
  const item = [...candidates].sort((left, right) =>
    left.evidence.id.localeCompare(right.evidence.id),
  )[0];
  return {
    item,
    status: item === undefined ? "unknown" : goalEvidenceStatus(item),
    ambiguous: false,
  };
}

function goalEvidenceStatus(item: GoalEvidenceItem): GoalEvidenceStatus {
  const text = `${item.memoryContent}\n${item.evidence.quote ?? ""}`;
  if (/(?:部分完成|只完成(?:了)?一部分|完成(?:了)?一部分)/u.test(text)) {
    return "partial";
  }
  if (/(?:未能进行|没有进行|未开展|跳过(?:了)?|已跳过)/u.test(text)) {
    return "skipped";
  }
  if (/(?:取消(?:了)?|已取消)/u.test(text)) return "cancelled";
  if (itemSupportsGoalCompletion(item)) return "completed";
  if (
    item.temporalMetadata?.temporalStatus === "in_progress" ||
    /(?:开始(?:了)?|启动(?:了)?|正在|推进(?:了)?)/u.test(text)
  ) {
    return "in_progress";
  }
  return "unknown";
}

function goalEvidenceTimestamp(
  item: EvidenceBundle["evidence"][number],
): number {
  const temporal = item.temporalMetadata;
  const timestamp =
    temporal?.occurredEndAtUtc ??
    temporal?.occurredStartAtUtc ??
    item.evidence.recordedAtUtc;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortAdviceFallback(): string {
  return "给你一个很短的建议：先把眼前的问题缩小成一个能马上处理的小步骤。";
}

function stoppedTopicFallback(warmth: number): string {
  return warmth >= 0.6
    ? "好，我们就停在这里，我不会再追问。"
    : "明白，这个话题到这里，我不再追问。";
}

function timeboxedPreparationFallback(
  minutes: number,
  acknowledgeEmotion: boolean,
): string {
  const duration = minutes === 10 ? "十分钟" : `${minutes} 分钟`;
  const acknowledgement = acknowledgeEmotion
    ? "我听见你现在还是有些紧张，这很正常。"
    : "好，我们把它拆成一个小步骤。";
  return `${acknowledgement}我们就用${duration}做准备：先列出最担心的一点，再写下回答的开头，最后试说一遍。`;
}

function authoritativeScheduleSummary(
  outcome: ValidatedTurnOutcome,
): string | undefined {
  const facts = outcome.replyDirectives.authoritativeFacts
    .filter((fact) => fact.kind === "schedule")
    .map((fact) => fact.text.trim())
    .filter(Boolean);
  const summary =
    outcome.replyDirectives.presentationText?.trim() || facts.join("；");
  if (summary === "") return undefined;
  return summary.replace(/[。！？!?]+$/gu, "").slice(0, 800);
}

function naturalNoopFallback(
  anchor: string | undefined,
  warmth: number,
): string {
  const compactAnchor = anchor?.replace(/\s+/gu, " ").trim().slice(0, 120);
  if (compactAnchor !== undefined && compactAnchor !== "") {
    return warmth >= 0.6
      ? `我听见你说的“${compactAnchor}”了。你愿意的话，我们可以顺着这件事继续聊。`
      : `关于“${compactAnchor}”，我在听。你可以继续说。`;
  }
  return warmth >= 0.6
    ? "我刚才没有表达好，不过我在认真听。你愿意继续说说吗？"
    : "我刚才没有说清楚。你可以继续，我会认真听。";
}

function replyAddressesQuote(reply: string, quote: string): boolean {
  const normalizedReply = comparableAnchorText(reply);
  const normalizedQuote = comparableAnchorText(quote);
  if (normalizedQuote === "") return true;
  if (normalizedReply.includes(normalizedQuote)) return true;

  const latinAndNumericAnchors = normalizedQuote.match(
    /[a-z0-9][a-z0-9_-]{2,}/gu,
  );
  if (
    latinAndNumericAnchors?.some((anchor) => normalizedReply.includes(anchor))
  ) {
    return true;
  }

  const cjkRuns = normalizedQuote.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  return cjkRuns.some((run) =>
    cjkAnchors(run).some((anchor) => normalizedReply.includes(anchor)),
  );
}

function replyAddressesUserAnchor(
  input: ReplyGenerationInput,
  reply: string,
  quote: string,
): boolean {
  if (replyAddressesQuote(reply, quote)) return true;
  const recentRecallText = `${input.userMessage} ${quote}`;
  if (!/(?:刚才|前面|上一条|上条)/u.test(recentRecallText)) return false;
  const requiresIdentifier = /(?:代号|编号|代码|标识符)/u.test(quote);
  const requiresPlacement =
    /(?:放|装|收|藏|存).{0,12}(?:哪(?:里|儿)?|什么位置)|(?:哪里|哪儿|什么位置)/u.test(
      quote,
    );
  if (!requiresIdentifier && !requiresPlacement) return false;
  if (
    requiresIdentifier &&
    (reply.normalize("NFKC").match(DISTINCTIVE_IDENTIFIERS) ?? []).length === 0
  ) {
    return false;
  }
  if (
    requiresPlacement &&
    !/(?:放在|放进|放到|装在|装进|装到|收在|藏在|位于)/u.test(reply)
  ) {
    return false;
  }
  const policy = replyEvidencePolicy(input);
  if (!policy.mustNotInferFromPersona) return false;
  const selectedEvidence = selectAllowedEvidence(
    input.memoryEvidence,
    policy.allowedEvidenceIds,
  );
  if (selectedEvidence !== undefined) return false;
  const recentEvidence = selectRecentUserFactEvidence(
    input,
    policy,
    selectedEvidence,
  );
  if (recentEvidence.length === 0) return false;
  return auditDirectUserFactTextGrounding({
    text: reply,
    memorySources: recentEvidence.map((message) => ({
      memoryContent: message.content,
    })),
    authoritativeFacts:
      input.validatedOutcome.replyDirectives.authoritativeFacts,
    requireGroundedMemoryClaim: true,
    userMessage: input.userMessage,
  }).passed;
}

function replyAlignsWithAuthoritativeFact(
  reply: string,
  fact: TurnReplyDirectivesFact,
): boolean {
  if (
    fact.kind === "activity" &&
    !replyAffirmsAuthoritativeActivityOutcome(reply, fact.activityEventType)
  ) {
    return false;
  }
  const requiredAnchors = fact.requiredAnchors ?? [];
  if (
    requiredAnchors.length > 0 &&
    !requiredAnchors.every((anchor) =>
      fact.kind === "activity"
        ? replyAddressesActivityAnchor(reply, anchor)
        : replyAddressesRequiredAnchor(reply, anchor),
    )
  ) {
    return false;
  }
  if (
    fact.kind === "schedule" &&
    /(?:改到|改成|推迟到?|提前到?|\bmoved\s+to\b|\brescheduled\s+to\b)/iu.test(
      reply,
    )
  ) {
    return false;
  }
  return requiredAnchors.length > 0 || replyAddressesQuote(reply, fact.text);
}

function replyAddressesActivityAnchor(reply: string, anchor: string): boolean {
  switch (anchor) {
    case "已完成":
      return /(?:已(?:经)?完成|完成了|完成完毕)/u.test(reply);
    case "部分完成":
      return /(?:部分完成|完成了一部分)/u.test(reply);
    case "已跳过":
      return /(?:已(?:经)?跳过|跳过了)/u.test(reply);
    case "已取消":
      return /(?:已(?:经)?取消|取消了)/u.test(reply);
    default:
      return replyAddressesRequiredAnchor(reply, anchor);
  }
}

const TERMINAL_ACTIVITY_DENIAL =
  /(?:(?:还|尚|仍|并)?没(?:有)?(?:结束|完成|结算)|(?:还|尚|仍|并)?未(?:结束|完成|结算)|(?:并不|不是).{0,6}(?:已经|已).{0,6}(?:结束|完成|结算))/u;

function replyAffirmsAuthoritativeActivityOutcome(
  reply: string,
  eventType: string | undefined,
): boolean {
  if (TERMINAL_ACTIVITY_DENIAL.test(reply)) return false;
  switch (eventType) {
    case "completed":
      return /(?:(?:已经|已|确实|刚刚|刚).{0,10}(?:结束|完成|结算)|(?:结束|完成|结算)(?:了|完了|完毕))/u.test(
        reply,
      );
    case "partial":
      return /(?:部分完成|完成了一部分|(?:已经|已).{0,10}(?:结束|结算)|(?:结束|结算)(?:了|完毕))/u.test(
        reply,
      );
    case "skipped":
      return /(?:(?:已经|已).{0,10}(?:跳过|结束|结算)|(?:跳过|结束|结算)(?:了|完毕))/u.test(
        reply,
      );
    case "cancelled":
      return /(?:(?:已经|已).{0,10}(?:取消|结束|结算)|(?:取消|结束|结算)(?:了|完毕))/u.test(
        reply,
      );
    default:
      return /(?:(?:已经|已|确实|刚刚|刚).{0,10}(?:结束|完成|结算|取消|跳过)|(?:结束|完成|结算|取消|跳过)(?:了|完了|完毕)|部分完成)/u.test(
        reply,
      );
  }
}

function replyAddressesRequiredAnchor(reply: string, anchor: string): boolean {
  const anchorNumbers = numericAnchorTokens(anchor);
  if (anchorNumbers.length === 0) return replyAddressesQuote(reply, anchor);
  const replyNumbers = new Set(numericAnchorTokens(reply));
  if (!anchorNumbers.every((token) => replyNumbers.has(token))) return false;
  const semanticRemainder = anchor
    .replace(/\p{N}+(?:[-/:：.]\p{N}+)*/gu, " ")
    .replace(/[年月日号时分秒点]/gu, " ")
    .trim();
  return (
    semanticRemainder === "" || replyAddressesQuote(reply, semanticRemainder)
  );
}

function numericAnchorTokens(value: string): string[] {
  return (value.normalize("NFKC").match(/\p{N}+(?:[-/:：.]\p{N}+)*/gu) ?? [])
    .map((token) => token.replace(/[-/:：.]/gu, ""))
    .filter(Boolean);
}

type TurnReplyDirectivesFact =
  ValidatedTurnOutcome["replyDirectives"]["authoritativeFacts"][number];

function appendMissingMixedTurnAnchors(
  text: string,
  anchors: readonly string[],
): string {
  const missing = anchors
    .filter((anchor) => !replyAddressesQuote(text, anchor))
    .map((anchor) => anchor.replace(/\s+/gu, " ").trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 3);
  if (missing.length === 0) return text;
  return `${text}\n另外，我也听见你提到${missing
    .map((anchor) => `“${anchor}”`)
    .join("、")}。`;
}

function cjkAnchors(run: string): string[] {
  if (run.length <= 3) return [run];
  const anchors: string[] = [];
  for (let index = 0; index <= run.length - 2; index += 1) {
    const candidate = run.slice(index, index + 2);
    if (!GENERIC_CJK_ANCHORS.has(candidate)) anchors.push(candidate);
  }
  return anchors;
}

function comparableAnchorText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
}

const GENERIC_CJK_ANCHORS = new Set([
  "今天",
  "现在",
  "我们",
  "你说",
  "我想",
  "可以",
  "一下",
  "这个",
  "那个",
  "有点",
  "觉得",
  "愿意",
]);

function naturalMissingFields(fields: readonly string[]): string {
  if (fields.length === 0) return "具体活动和时间";
  const labels = fields.map((field) => {
    switch (field) {
      case "activity":
        return "活动";
      case "time":
        return "时间";
      case "participant":
        return "参与人";
      default:
        return field;
    }
  });
  return labels.join("和");
}

function replyClaimsScheduleMutation(text: string): boolean {
  return /(?:【日程已修改】|(?:已经|已|刚刚|刚).{0,10}(?:写入|加入|添加|新增|创建|修改|更新|取消|撤销|删除|改期).{0,10}(?:日程|安排|日历)|(?:日程|安排|日历).{0,10}(?:已经|已).{0,8}(?:修改|更新|取消|删除|改好)|\b(?:i(?:'ve| have)|we(?:'ve| have)|it(?:'s| has) been)\s+(?:added|saved|created|updated|cancelled|canceled|removed|rescheduled)\b)/iu.test(
    text,
  );
}

function replyClaimsRecordedAgreement(text: string): boolean {
  return /(?:说好(?:了)?|说定(?:了)?|约定(?:好|了)|已经确认|到时候见|\b(?:it(?:'s| is) a deal|see you then|we(?:'re| are) set)\b)/iu.test(
    text,
  );
}

function replyClaimsFinalAgreement(text: string): boolean {
  return /(?:说定了|约定好了|已经确认|到时候见|\b(?:deal|we(?:'re| are) set|see you then)\b)/iu.test(
    text,
  );
}

function replyClaimsRejectedMutationAgreement(text: string): boolean {
  return /(?:改期|改到|改成|晚一小时|提前|推迟|新时间).{0,14}(?:说定|约定|已经确认|确认好了)|(?:说定|约定|已经确认).{0,14}(?:改期|改到|改成|新时间)/u.test(
    text,
  );
}

function replyDeniesCommittedSchedule(text: string): boolean {
  const withoutExplicitNegationOfPending = text
    .replace(
      /(?:不是|并非|绝非|并不(?:是)?).{0,5}(?:待确认|未确认|没确认|尚未确认)/gu,
      "",
    )
    .replace(
      /(?:不能|无法|没法).{0,8}(?:直接)?(?:把)?已确认(?:的)?.{0,14}安排.{0,8}(?:改|删除|取消)/gu,
      "",
    );
  return /(?:仍|还是|只是|是|处于)?待确认(?:方案|状态)?|(?:尚未|还没|没有|并未).{0,14}(?:写入|写进|加入|添加|修改|确认|定下来|定好|说定)|(?:没法|无法|不能).{0,10}确认.{0,12}(?:(?:已经|已).{0,8})?(?:写入|写进|加入|日程|安排)|(?:等|需要|请).{0,8}(?:你)?(?:确认|同意).{0,8}(?:才|后)|\b(?:not|isn't|is not|hasn't|has not|cannot|can't)\b.{0,24}\b(?:confirmed|saved|added|scheduled)\b/iu.test(
    withoutExplicitNegationOfPending,
  );
}

function replyAffirmsCommittedSchedule(text: string): boolean {
  const declarative = text.replace(/[^。！!?！？\n]{0,160}[？?]/gu, " ");
  return /(?:(?:当前|原|原来|之前|已经|已).{0,10}(?:确认|生效)|(?:已经|已).{0,10}(?:写入|写进|加入).{0,8}(?:日程|安排)|(?:安排|日程).{0,12}(?:已确认|已经生效)|真正生效)/u.test(
    declarative,
  );
}

function replyClaimsPersistedMemory(text: string): boolean {
  return /(?:我|这边)?(?:已经|已|刚刚)?(?:替你|帮你)?(?:记住了|记下了|存好了|保存好了|写进记忆)|(?:以后|下次).{0,12}(?:一定|肯定).{0,8}(?:记得|不会忘)|\bi(?:'ve| have)\s+(?:saved|stored|memorized|remembered)\b|\b(?:saved|stored)\s+(?:that|this|it)\b/iu.test(
    text,
  );
}

function replyGuaranteesFutureAction(text: string): boolean {
  return /(?:我|我们)(?:(?:明天|后天|下周|稍后|到时|之后))?(?:(?:一定|肯定|保证|绝对)?会|将).{0,24}(?:提醒|联系|发送|预订|预约|安排|执行|完成|做到)|\bi\s+(?:will(?: definitely)?|promise to|guarantee (?:i(?:'ll| will)|to))\s+.{0,24}\b(?:remind|contact|send|book|reserve|arrange|complete)\b|\bwe\s+(?:will definitely|promise to)\b/iu.test(
    text,
  );
}

function invalidOutputIssue(error: unknown): ReplyGenerationIssue {
  return {
    code: "invalid_reply_output",
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : "The reply provider returned invalid output.",
  };
}

function uniqueIssues(
  issues: readonly ReplyGenerationIssue[],
): ReplyGenerationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
