import {
  dilemmaScopeScore,
  extractDilemmaChoices,
  isDilemmaContinuation,
  isUnexplainedOption,
  matchDilemmaOption,
} from "./fuzzy-life-choice.js";
import {
  analyzeCharacterSupportOffer,
  analyzeSpeakerSelfDisclosure,
  supportTopicScore,
  supportTopicText,
} from "./fuzzy-life-support.js";
import {
  ActionRecordSchema,
  DecisionRecordSchema,
  DilemmaEpisodeSchema,
  FuzzyLifePromptContextSchema,
  LifeThreadSchema,
  OutcomeRecordSchema,
  PressureEpisodeSchema,
  ReflectionRecordSchema,
  RelationshipMilestoneSchema,
  SupportInterventionSchema,
  type CharacterSpec,
  type DailyLifeContext,
  type DailyLifeIntent,
  type DayPeriod,
  type DecisionRecord,
  type DilemmaEpisode,
  type FuzzyLifePromptContext,
  type LifeDomain,
  type LifeOutcome,
  type LifeThread,
  type OutcomeRecord,
  type PressureEpisode,
  type ReflectionRecord,
  type SupportIntervention,
  type SupportMode,
} from "@personasim/contracts";
import { projectCharacterTime, stableId } from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import {
  applyDilemmaEvidenceToOptions,
  dilemmaCorrectionMatchesOptions,
  extractDilemmaTurnEvidence,
  inferDilemmaValues,
} from "../domain/dilemma-evidence.js";
import { notFound } from "../domain/errors.js";
import {
  LifeThreadRevisionConflictError,
  type LifeRepository,
} from "../repositories/life-repository.js";
import type { Clock } from "../runtime/clock.js";
import {
  analyzeLifeEvidence,
  evidenceSubject as inferEvidenceSubject,
} from "./fuzzy-life-evidence.js";
import {
  assertTimelinePlanHash,
  buildDailyIntents,
  buildDeterministicLifeOutcome,
  clamp01,
  createDailyLifeContext,
  dayPeriod,
  freezeTimelinePlan,
  inferDomain,
  localCalendarDayDifference,
  milestoneEffectiveLocalDate,
  milestoneIndexAt,
  milestoneNextStep,
  refreshDailyLifeContext,
  resolveLegacyTimelinePlan,
  settleDailyLifeContext,
  timelineLocalDate,
} from "./fuzzy-life-planning.js";
import {
  DECISION_EVIDENCE_RELEVANCE_THRESHOLD,
  DILEMMA_CONTEXT_EVIDENCE_RELEVANCE_THRESHOLD,
  PRESSURE_DILEMMA_RELEVANCE_THRESHOLD,
  REFLECTION_CONTINUITY_RELEVANCE_THRESHOLD,
  analyzeSupportSpeechAct,
  compactLifePromptText,
  decisionEvidenceSemanticRelevance,
  decisionRelevance,
  decisionStagePredecessorRelevance,
  decisionSupportDirection,
  dilemmaRelevance,
  exactlyOne,
  hasExplicitCausalStageReference,
  hasExplicitDilemmaContextFrame,
  hasMeaningfulDilemmaContextAnchor,
  hasMixedCausation,
  inferActionKind,
  inferOutcomeValence,
  isActionRestatement,
  isCharacterDilemmaTurn,
  isCharacterReflectionRequest,
  isCharacterSubjectDecisionRequest,
  isIdentityFacetOfLifeChoice,
  isPressureDisclosure,
  isPressureFeedbackText,
  isPressureTrajectoryContinuation,
  isReflectionEvidence,
  isUserAdviceToCharacter,
  isUserOwnedDecision,
  isUserPressureEvidenceSubject,
  parseScaleMetric,
  pressureDilemmaSemanticRelevance,
  pressureKind,
  reflectionContinuityRelevance,
  reflectionLesson,
  reflectionStance,
  reflectionSubjectMatches,
  selectDilemmaOption,
  shortTitle,
  supportIntendedEffect,
  type LifeEvidenceSubject,
  userToCharacterSupportMode,
} from "./fuzzy-life-language.js";
import {
  linkPressureOutcomeEvidence,
  pressureLifecycleSnapshot,
  progressPressureFromOutcome,
  progressPressureFromReflection,
} from "./fuzzy-life-pressure-projection.js";

type DomainEventWrite = Omit<
  Parameters<DatabaseStore["insertDomainEvent"]>[0],
  "streamVersion"
> & {
  streamVersion?: number;
};

export interface FuzzyLifeSnapshot {
  context: DailyLifeContext;
  intents: DailyLifeIntent[];
  threads: LifeThread[];
  recentOutcomes: LifeOutcome[];
}

export interface FuzzyLifeAdvanceResult extends FuzzyLifeSnapshot {
  settledContextIds: string[];
  createdOutcomeIds: string[];
}

export interface ConversationLifeImpact {
  dilemmaId?: string;
  pressureEpisodeId?: string;
  interventionId?: string;
  decisionId?: string;
  actionId?: string;
  outcomeId?: string;
  reflectionId?: string;
  milestoneId?: string;
}

interface PressureFollowUpResult {
  updated: boolean;
  episodeId?: string;
}

/**
 * Server-owned fuzzy life and decision causality. It never creates clock-time
 * character appointments. Exact UTC values are used only for ordering,
 * idempotency and audit; character-life facts stay at day/period precision.
 */
export class FuzzyLifeService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly repository: LifeRepository,
    private readonly clock: Clock,
  ) {}

  ensureToday(agentId: string, atUtc = this.clock.nowUtc()): FuzzyLifeSnapshot {
    const spec = this.store.getCharacterSpec(agentId);
    const state = this.store.getRuntimeState(agentId);
    if (!spec || !state) throw notFound("Character");
    const local = projectCharacterTime(spec.identity, atUtc);
    const localDate = local.localDate;
    const threads = this.ensureGoalThreads(spec, atUtc);
    let context = this.repository.findDailyContext(agentId, localDate);
    if (context === undefined) {
      const intents = buildDailyIntents(spec, threads, localDate, atUtc);
      context = createDailyLifeContext({
        agentId,
        spec,
        state,
        threads,
        intents,
        localDate,
        localHour: local.hour,
        currentPressureEpisodeIds: this.repository
          .listOpenPressures(agentId, 4)
          .map((episode) => episode.id),
        recentOutcomeIds: this.repository
          .listRecentLifeOutcomes(agentId, 4)
          .map((outcome) => outcome.id),
        atUtc,
      });
      this.store.transaction(() => {
        this.repository.insertDailyContext(context!);
        for (const intent of intents) this.repository.insertDailyIntent(intent);
        this.recordEvent({
          agentId,
          streamType: "daily_life",
          streamId: context!.id,
          eventType: "life.daily_context_created",
          recordedAtUtc: atUtc,
          effectiveAtUtc: atUtc,
          payload: {
            localDate,
            intentIds: intents.map((intent) => intent.id),
            temporalPrecision: "day",
          },
          idempotencyKey: `life-day:${agentId}:${localDate}:created`,
        });
      });
      return {
        context,
        intents,
        threads,
        recentOutcomes: this.repository.listRecentLifeOutcomes(agentId, 6),
      };
    }

    const intents = this.repository.listDailyIntents(context.id);
    const currentPressureEpisodeIds = this.repository
      .listOpenPressures(agentId, 4)
      .map((episode) => episode.id);
    const recentOutcomeIds = this.repository
      .listRecentLifeOutcomes(agentId, 4)
      .map((outcome) => outcome.id);
    const refreshed = refreshDailyLifeContext({
      context,
      state,
      intents,
      threads,
      localHour: local.hour,
      currentPressureEpisodeIds,
      recentOutcomeIds,
      atUtc,
    });
    if (refreshed !== context) {
      this.repository.updateDailyContext(refreshed);
      context = refreshed;
    }
    return {
      context,
      intents,
      threads,
      recentOutcomes: this.repository.listRecentLifeOutcomes(agentId, 6),
    };
  }

  advance(
    agentId: string,
    toUtc = this.clock.nowUtc(),
  ): FuzzyLifeAdvanceResult {
    const spec = this.store.getCharacterSpec(agentId);
    if (!spec) throw notFound("Character");
    const currentLocalDate = projectCharacterTime(
      spec.identity,
      toUtc,
    ).localDate;
    const settledContextIds: string[] = [];
    const createdOutcomeIds: string[] = [];

    this.store.transaction(() => {
      for (const context of this.repository.listDailyContextsBefore(
        agentId,
        currentLocalDate,
      )) {
        const outcomeIds: string[] = [];
        for (const intent of this.repository.listDailyIntents(context.id)) {
          const existing = this.repository.findLifeOutcomeForIntent(intent.id);
          if (existing !== undefined) {
            outcomeIds.push(existing.id);
            continue;
          }
          const evidenceKey = `life-outcome:${intent.id}:evidence`;
          this.recordEvent({
            agentId,
            streamType: "life_intent",
            streamId: intent.id,
            eventType: "life.intent_settled",
            recordedAtUtc: toUtc,
            effectiveAtUtc: toUtc,
            payload: {
              intentId: intent.id,
              effectiveLocalDate: context.localDate,
              temporalPrecision: "day",
            },
            idempotencyKey: evidenceKey,
          });
          const evidenceId = this.domainEventId(evidenceKey);
          const outcome = buildDeterministicLifeOutcome({
            agentId,
            intent,
            evidenceId,
            effectiveLocalDate: context.localDate,
            recordedAtUtc: toUtc,
          });
          if (this.repository.insertLifeOutcome(outcome)) {
            createdOutcomeIds.push(outcome.id);
          }
          outcomeIds.push(outcome.id);
        }
        this.repository.updateDailyContext(
          settleDailyLifeContext(context, outcomeIds, toUtc),
        );
        settledContextIds.push(context.id);
      }
    });

    return {
      ...this.ensureToday(agentId, toUtc),
      settledContextIds,
      createdOutcomeIds,
    };
  }

  promptContext(
    agentId: string,
    atUtc = this.clock.nowUtc(),
  ): FuzzyLifePromptContext {
    const snapshot = this.ensureToday(agentId, atUtc);
    const currentDecisions = this.repository.listCurrentDecisions(agentId, 32);
    const recentDecisions = currentDecisions.slice(0, 4);
    const recentActions = this.repository.listRecentActions(agentId, 32);
    const recentOutcomes = this.repository.listRecentOutcomeRecords(
      agentId,
      32,
    );
    const recentReflections = this.repository.listRecentReflections(
      agentId,
      32,
    );
    const decisionById = new Map(
      currentDecisions.map((decision) => [decision.id, decision]),
    );
    return FuzzyLifePromptContextSchema.parse({
      authority: "server_persisted_fuzzy_life",
      semantics: {
        intentionsAreNotOccurrences: true,
        decisionsAreNotActions: true,
        actionsAreNotOutcomes: true,
        characterTimePrecision: "day_or_period",
        characterLifeOwner: "character",
        lifeThreadStagesAdvanceByCharacterLocalDate: true,
        lifeThreadStageIsNotDailyOutcome: true,
        lifeThreadStageIsNotProofOfExternalSuccess: true,
      },
      today: {
        subject: "character",
        localDate: snapshot.context.localDate,
        currentPeriod: snapshot.context.currentPeriod,
        availability: snapshot.context.availability,
        currentFocus: snapshot.context.currentFocus,
        intentions: snapshot.intents.map((intent) => ({
          title: intent.title,
          period: intent.period,
          commitmentLevel: intent.commitmentLevel,
          status: intent.status,
        })),
      },
      ongoingThreads: snapshot.threads.map((thread) => ({
        subject: "character",
        title: thread.title,
        currentStage: thread.currentStage,
        progressNote: thread.progressNote,
        nextStepHint: thread.nextStepHint,
      })),
      verifiedRecentOutcomes: snapshot.recentOutcomes.map((outcome) => ({
        subject: "character",
        effectiveLocalDate: outcome.effectiveLocalDate,
        outcomeKind: outcome.outcomeKind,
        summary: compactLifePromptText(outcome.summary),
      })),
      unresolvedDilemmas: this.repository
        .listOpenDilemmas(agentId, 4)
        .map((episode) => ({
          id: episode.id,
          subject: episode.subject,
          domain: episode.domain,
          title: episode.title,
          summary: compactLifePromptText(episode.summary, 1_200),
          options: episode.options.map((option) => option.label),
        })),
      recentDecisionDilemmas: recentDecisions.flatMap((decision) => {
        const episode = this.findDilemma(decision.dilemmaId);
        return episode === undefined
          ? []
          : [
              {
                id: episode.id,
                subject: episode.subject,
                domain: episode.domain,
                status: episode.status,
                title: episode.title,
                summary: compactLifePromptText(episode.summary, 1_200),
                options: episode.options.map((option) => ({
                  id: option.id,
                  label: option.label,
                })),
                sourceMessageIds: episode.sourceMessageIds,
                closingDecisionId: episode.closingDecisionId,
              },
            ];
      }),
      activePressure: this.repository
        .listOpenPressures(agentId, 4)
        .map((episode) => ({
          id: episode.id,
          subject: episode.subject,
          pressureKind: episode.pressureKind,
          dilemmaId: episode.dilemmaId,
          threadId: episode.threadId,
          triggerSummary: compactLifePromptText(episode.triggerSummary),
          status: episode.status,
          currentPressure: episode.currentPressure,
          currentClarity: episode.currentClarity,
          currentFeltUnderstood: episode.currentFeltUnderstood,
          sourceMessageIds: episode.sourceMessageIds,
          latestEvidenceMessageId: episode.latestEvidenceMessageId,
        })),
      relationshipMilestones: this.repository
        .listRecentMilestones(agentId, 4)
        .map((milestone) => ({
          id: milestone.id,
          subject: "shared",
          kind: milestone.kind,
          summary: compactLifePromptText(milestone.summary),
          interventionIds: milestone.interventionIds,
          decisionIds: milestone.decisionIds,
          outcomeIds: milestone.outcomeIds,
          reflectionIds: milestone.reflectionIds,
          sourceMessageIds: milestone.sourceMessageIds,
          effectiveLocalDate: milestone.effectiveLocalDate,
        })),
      evidencedSupport: this.repository
        .listRecentInterventions(agentId, 8)
        .map((intervention) => ({
          id: intervention.id,
          dilemmaId: intervention.dilemmaId,
          pressureEpisodeId: intervention.pressureEpisodeId,
          mode: intervention.mode,
          offeredBy: intervention.offeredBy,
          receivedBy: intervention.receivedBy,
          summary: compactLifePromptText(intervention.summary),
          intendedEffect: intervention.intendedEffect,
          sourceMessageId: intervention.sourceMessageId,
          effectiveLocalDate: intervention.effectiveLocalDate,
        })),
      recentDecisions: recentDecisions.map((decision) => ({
        id: decision.id,
        dilemmaId: decision.dilemmaId,
        subject: decision.subject,
        authority: decision.authority,
        decidedBy: decision.decidedBy,
        selectionSummary: compactLifePromptText(decision.selectionSummary),
        supportInterventionIds: decision.supportInterventionIds,
        sourceMessageIds: decision.sourceMessageIds,
        authorizedByMessageId: decision.authorizedByMessageId,
        effectiveLocalDate: decision.effectiveLocalDate,
      })),
      canonicalCausalFacts: recentDecisions.map((decision) => ({
        dilemmaId: decision.dilemmaId,
        subject: decision.subject,
        decision: {
          decisionId: decision.id,
          subject: decision.subject,
          authority: decision.authority,
          decidedBy: decision.decidedBy,
          selectionSummary: compactLifePromptText(
            decision.selectionSummary,
            800,
          ),
          authorizedByMessageId: decision.authorizedByMessageId,
          sourceMessageIds: decision.sourceMessageIds,
        },
        actions: recentActions
          .filter((action) => action.decisionId === decision.id)
          .slice(0, 4)
          .map((action) => ({
            actionId: action.id,
            decisionId: action.decisionId,
            subject: action.subject,
            performedBy: action.performedBy,
            actionKind: action.actionKind,
            summary: compactLifePromptText(action.summary, 800),
            sourceEvidenceIds: action.sourceEvidenceIds,
          })),
        outcomes: recentOutcomes
          .filter((outcome) => outcome.decisionId === decision.id)
          .slice(0, 4)
          .map((outcome) => ({
            outcomeId: outcome.id,
            decisionId: outcome.decisionId,
            subject: decision.subject,
            actionIds: outcome.actionIds,
            causeKind: outcome.causeKind,
            valence: outcome.valence,
            summary: compactLifePromptText(outcome.summary, 800),
            sourceEvidenceIds: outcome.sourceEvidenceIds,
          })),
        reflections: recentReflections
          .filter((reflection) => reflection.decisionId === decision.id)
          .slice(0, 4)
          .map((reflection) => ({
            reflectionId: reflection.id,
            decisionId: reflection.decisionId,
            outcomeId: reflection.outcomeId,
            subject: reflection.subject,
            reflectedBy: reflection.reflectedBy,
            stanceTowardDecision: reflection.stanceTowardDecision,
            summary: compactLifePromptText(reflection.summary, 800),
            sourceMessageIds: reflection.sourceMessageIds,
          })),
      })),
      evidencedActions: recentActions.slice(0, 4).map((action) => ({
        id: action.id,
        decisionId: action.decisionId,
        subject: action.subject,
        performedBy: action.performedBy,
        actionKind: action.actionKind,
        summary: compactLifePromptText(action.summary),
        sourceEvidenceIds: action.sourceEvidenceIds,
        effectiveLocalDate: action.effectiveLocalDate,
      })),
      evidencedConsequences: recentOutcomes.slice(0, 4).map((outcome) => {
        const decision = decisionById.get(outcome.decisionId);
        return {
          id: outcome.id,
          decisionId: outcome.decisionId,
          ...(decision === undefined
            ? {}
            : {
                subject: decision.subject,
                decisionAuthority: decision.authority,
                decidedBy: decision.decidedBy,
              }),
          actionIds: outcome.actionIds,
          causeKind: outcome.causeKind,
          valence: outcome.valence,
          status: outcome.status,
          summary: compactLifePromptText(outcome.summary),
          sourceEvidenceIds: outcome.sourceEvidenceIds,
          effectiveLocalDate: outcome.effectiveLocalDate,
        };
      }),
      reflections: recentReflections.slice(0, 4).map((reflection) => ({
        id: reflection.id,
        decisionId: reflection.decisionId,
        outcomeId: reflection.outcomeId,
        subject: reflection.subject,
        reflectedBy: reflection.reflectedBy,
        stanceTowardDecision: reflection.stanceTowardDecision,
        summary: compactLifePromptText(reflection.summary),
        sourceMessageIds: reflection.sourceMessageIds,
        effectiveLocalDate: reflection.effectiveLocalDate,
      })),
    });
  }

  recordConversationTurn(input: {
    agentId: string;
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string;
    userText: string;
    assistantText: string;
    recordedAtUtc: string;
    correlationId: string;
  }): ConversationLifeImpact {
    // A user's offer can only refer to disclosures already visible before
    // this reply. New assistant disclosures are recorded afterwards.
    const participantImpact = this.recordParticipantTurn(input);
    const characterImpact = this.recordCharacterDisclosure(input);
    return { ...characterImpact, ...participantImpact };
  }

  private recordParticipantTurn(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
  ): ConversationLifeImpact {
    const spec = this.store.getCharacterSpec(input.agentId);
    if (!spec) throw notFound("Character");
    const local = projectCharacterTime(spec.identity, input.recordedAtUtc);
    const localDate = local.localDate;
    const period = dayPeriod(local.hour);
    const supportSpeechAct = analyzeSupportSpeechAct(input.userText);
    const dilemmaEvidenceText = supportSpeechAct.operativeDilemmaText;
    const dilemmaEvidenceClassifyText =
      supportSpeechAct.operativeDilemmaClassifyText;
    const userDisclosure = analyzeSpeakerSelfDisclosure(
      dilemmaEvidenceText,
      true,
    );
    const userPressureClassifyText = analyzeLifeEvidence(
      [userDisclosure.pressureText, userDisclosure.feedbackText]
        .filter(Boolean)
        .join("，"),
    ).classifyText;
    const pressureFollowUp = this.applyPressureFollowUp(
      input,
      userPressureClassifyText,
      localDate,
      period,
    );
    const followUpImpact = this.recordDecisionFollowUp(
      input,
      localDate,
      period,
    );
    this.recordDilemmaEvidence(
      input,
      dilemmaEvidenceText,
      dilemmaEvidenceClassifyText,
      localDate,
      period,
    );

    const offer = analyzeCharacterSupportOffer(input.userText);
    const characterScopeText = offer?.scopeText ?? dilemmaEvidenceText;
    const characterDilemma =
      this.selectOpenDilemma(
        input,
        "character",
        analyzeLifeEvidence(characterScopeText).classifyText,
        characterScopeText,
      ) ??
      (offer?.contextual
        ? exactlyOne(
            this.repository
              .listOpenDilemmas(input.agentId, 32)
              .filter(
                (episode) =>
                  episode.subject === "character" &&
                  this.hasRecentDilemmaContext(episode, input),
              ),
          )
        : undefined);
    if (
      dilemmaEvidenceClassifyText.trim() !== "" &&
      characterDilemma !== undefined &&
      (offer !== undefined ||
        isCharacterDilemmaTurn(dilemmaEvidenceClassifyText, characterDilemma))
    ) {
      const characterImpact = this.recordCharacterDirectedTurn(
        input,
        dilemmaEvidenceText,
        dilemmaEvidenceClassifyText,
        characterDilemma,
        localDate,
        period,
      );
      if (!analyzeSpeakerSelfDisclosure(input.userText).pressureText)
        return {
          ...followUpImpact,
          ...characterImpact,
          ...(pressureFollowUp.episodeId === undefined
            ? {}
            : { pressureEpisodeId: pressureFollowUp.episodeId }),
        };
    }

    if (offer !== undefined && characterDilemma === undefined) {
      const pressure = this.selectCharacterPressure(
        input,
        offer.scopeText,
        offer.contextual,
      );
      if (pressure !== undefined) {
        const characterImpact = this.recordCharacterDirectedTurn(
          input,
          offer.sourceText,
          offer.classifyText,
          undefined,
          localDate,
          period,
          pressure,
        );
        if (!analyzeSpeakerSelfDisclosure(input.userText).pressureText)
          return { ...followUpImpact, ...characterImpact };
      }
    }

    if (isUserOwnedDecision(dilemmaEvidenceClassifyText)) {
      const dilemma = this.selectOpenDilemma(
        input,
        "user",
        dilemmaEvidenceClassifyText,
        dilemmaEvidenceText,
      );
      if (dilemma !== undefined) {
        const selectedOption = selectDilemmaOption(
          dilemma,
          dilemmaEvidenceClassifyText,
        );
        if (selectedOption === undefined) return followUpImpact;
        const ownedSupport = this.subjectDecisionSupport({
          dilemma,
          offeredBy: "character",
          receivedBy: "user",
          selectedOption,
          fallbackMode: "deliberate",
        });
        const ownedDecision = this.recordOwnedDecision({
          input,
          dilemma,
          selectedOption,
          supportMode: ownedSupport.mode,
          authority: "subject",
          decidedBy: "user",
          sourceMessageIds: [input.userMessageId],
          reasoningSummary: dilemmaEvidenceText,
          supportInterventionIds: ownedSupport.interventionIds,
          localDate,
          period,
        });
        this.recordEvent({
          agentId: input.agentId,
          streamType: "life_decision",
          streamId: ownedDecision.decisionId,
          eventType: "life.subject_decision_recorded",
          recordedAtUtc: input.recordedAtUtc,
          effectiveAtUtc: input.recordedAtUtc,
          payload: {
            dilemmaId: dilemma.id,
            decisionId: ownedDecision.decisionId,
            subject: "user",
            authority: "subject",
            evidenceMessageId: input.userMessageId,
          },
          correlationId: input.correlationId,
          causationId: input.userMessageId,
          idempotencyKey: `subject-decision-impact:${dilemma.id}:${input.userMessageId}`,
        });
        return {
          ...followUpImpact,
          ...ownedDecision,
          dilemmaId: dilemma.id,
          ...(pressureFollowUp.episodeId === undefined
            ? {}
            : { pressureEpisodeId: pressureFollowUp.episodeId }),
        };
      }
    }

    const delegated = supportSpeechAct.delegated;
    let mode = supportSpeechAct.supportMode;
    const explicitSupport = supportSpeechAct.explicitSupport;
    const dilemmaLike =
      delegated ||
      supportSpeechAct.dilemmaLike ||
      (explicitSupport && mode !== "listen_only");
    const pressureLike =
      userDisclosure.pressureText !== "" && !pressureFollowUp.updated;
    const shouldRecordSupport =
      dilemmaLike ||
      pressureLike ||
      explicitSupport ||
      pressureFollowUp.updated;
    if (!shouldRecordSupport) return followUpImpact;

    const domain = inferDomain(dilemmaEvidenceClassifyText);
    let dilemma = dilemmaLike
      ? this.selectOpenDilemma(
          input,
          "user",
          dilemmaEvidenceClassifyText,
          dilemmaEvidenceText,
        )
      : undefined;
    if (dilemmaLike && dilemma === undefined) {
      dilemma = this.createUserDilemma(
        input,
        dilemmaEvidenceText,
        dilemmaEvidenceClassifyText,
        domain,
        localDate,
        period,
      );
    }

    const pressureId = pressureLike
      ? stableId("pressure", `${input.sessionId}:${input.userMessageId}`)
      : undefined;
    let pressure: PressureEpisode | undefined;
    if (pressureId !== undefined) {
      pressure = PressureEpisodeSchema.parse({
        id: pressureId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        ...(dilemma === undefined ? {} : { dilemmaId: dilemma.id }),
        subject: "user",
        pressureKind: pressureKind(domain),
        triggerSummary: userDisclosure.pressureText,
        status: "open",
        initialPressure:
          parseScaleMetric(userPressureClassifyText, "pressure") ?? 0.72,
        currentPressure:
          parseScaleMetric(userPressureClassifyText, "pressure") ?? 0.72,
        initialClarity:
          parseScaleMetric(userPressureClassifyText, "clarity") ??
          (dilemmaLike ? 0.3 : 0.45),
        currentClarity:
          parseScaleMetric(userPressureClassifyText, "clarity") ??
          (dilemmaLike ? 0.3 : 0.45),
        initialFeltUnderstood: 0.2,
        currentFeltUnderstood: 0.2,
        interventionIds: [],
        outcomeIds: [],
        sourceMessageIds: [input.userMessageId],
        latestEvidenceMessageId: input.userMessageId,
        effectiveLocalDate: localDate,
        effectivePeriod: period,
        temporalPrecision: "period",
        recordedAtUtc: input.recordedAtUtc,
        updatedAtUtc: input.recordedAtUtc,
        idempotencyKey: `pressure:${input.sessionId}:${input.userMessageId}`,
        schemaVersion: 1,
      });
      this.repository.insertPressure(pressure);
    }

    const continuedPressure =
      explicitSupport && isDilemmaContinuation(dilemmaEvidenceClassifyText)
        ? exactlyOne(
            this.repository
              .listOpenPressures(input.agentId, 24)
              .filter(
                (episode) =>
                  episode.subject === "user" &&
                  episode.sessionId === input.sessionId,
              ),
          )
        : undefined;
    const targetPressureId = this.selectPressureForSupport({
      agentId: input.agentId,
      subject: "user",
      ...(dilemma === undefined ? {} : { dilemma }),
      preferredEpisodeIds: [
        pressure?.id,
        pressureFollowUp.episodeId,
        continuedPressure?.id,
      ].filter((id): id is string => id !== undefined),
    })?.id;
    const selectedOption =
      dilemma === undefined
        ? undefined
        : selectDilemmaOption(dilemma, input.assistantText);
    if (
      (mode === "recommend" || mode === "delegated_decision") &&
      selectedOption === undefined
    )
      mode = "deliberate";
    let interventionId: string | undefined;
    if (
      input.assistantText.trim() !== "" &&
      (dilemma !== undefined || targetPressureId !== undefined)
    ) {
      interventionId = stableId(
        "support",
        `${input.sessionId}:${input.assistantMessageId}`,
      );
      this.repository.insertIntervention(
        SupportInterventionSchema.parse({
          id: interventionId,
          agentId: input.agentId,
          sessionId: input.sessionId,
          ...(dilemma === undefined ? {} : { dilemmaId: dilemma.id }),
          ...(targetPressureId === undefined
            ? {}
            : { pressureEpisodeId: targetPressureId }),
          mode,
          offeredBy: "character",
          receivedBy: "user",
          summary: input.assistantText,
          intendedEffect: supportIntendedEffect(mode, "user"),
          ...(mode === "recommend" || mode === "delegated_decision"
            ? { recommendationOptionId: selectedOption?.id }
            : {}),
          sourceMessageId: input.assistantMessageId,
          effectiveLocalDate: localDate,
          effectivePeriod: period,
          temporalPrecision: "period",
          recordedAtUtc: input.recordedAtUtc,
          idempotencyKey: `support:${input.sessionId}:${input.assistantMessageId}`,
          schemaVersion: 1,
        }),
      );
      if (targetPressureId !== undefined) {
        this.linkPressureIntervention(
          targetPressureId,
          interventionId,
          input.recordedAtUtc,
        );
      }
    }

    let decisionId: string | undefined;
    let milestoneId: string | undefined;
    if (
      delegated &&
      dilemma !== undefined &&
      selectedOption !== undefined &&
      interventionId !== undefined
    ) {
      const delegatedDecision = this.recordOwnedDecision({
        input,
        dilemma,
        selectedOption,
        supportMode: "delegated_decision",
        authority: "delegated",
        decidedBy: "character",
        sourceMessageIds: [input.userMessageId, input.assistantMessageId],
        reasoningSummary: input.assistantText,
        supportInterventionIds: [interventionId],
        authorizedByMessageId: input.userMessageId,
        localDate,
        period,
      });
      decisionId = delegatedDecision.decisionId;
      milestoneId = delegatedDecision.milestoneId;
    }

    const streamId =
      dilemma?.id ?? targetPressureId ?? interventionId ?? decisionId;
    if (streamId !== undefined && interventionId !== undefined) {
      this.recordEvent({
        agentId: input.agentId,
        streamType: "life_decision",
        streamId,
        eventType:
          decisionId === undefined
            ? "life.support_recorded"
            : "life.delegated_decision_recorded",
        recordedAtUtc: input.recordedAtUtc,
        effectiveAtUtc: input.recordedAtUtc,
        payload: {
          dilemmaId: dilemma?.id,
          pressureEpisodeId: targetPressureId,
          interventionId,
          decisionId,
          milestoneId,
          mode,
          temporalPrecision: "period",
        },
        correlationId: input.correlationId,
        causationId: input.userMessageId,
        idempotencyKey: `life-impact:${input.sessionId}:${input.userMessageId}`,
      });
    }

    return {
      ...followUpImpact,
      ...(dilemma === undefined ? {} : { dilemmaId: dilemma.id }),
      ...(targetPressureId === undefined
        ? {}
        : { pressureEpisodeId: targetPressureId }),
      ...(interventionId === undefined ? {} : { interventionId }),
      ...(decisionId === undefined ? {} : { decisionId }),
      ...(milestoneId === undefined ? {} : { milestoneId }),
    };
  }

  private recordDecisionFollowUp(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
  ): ConversationLifeImpact {
    // Occurrence evidence has its own modality rules. The support analyzer
    // deliberately discards past narration, which may be a real action here.
    const analysis = analyzeLifeEvidence(input.userText);
    const assertedClauses = analysis.clauses.filter(
      (clause) => clause.modality === "asserted",
    );
    const evidenceText = assertedClauses
      .map((clause) => clause.sourceText)
      .join("；");
    const actionText = analysis.clauses
      .filter((clause) => clause.action)
      .map((clause) => clause.sourceText)
      .join("；");
    const outcomeText = analysis.clauses
      .filter((clause) => clause.outcome)
      .map((clause) => clause.sourceText)
      .join("；");
    const classifyText = analysis.classifyText;
    const actionSubject = inferEvidenceSubject(analysis, "action");
    const outcomeSubject = inferEvidenceSubject(analysis, "outcome");
    const actionEvidence = analysis.clauses.some((clause) => clause.action);
    const outcomeEvidence = analysis.clauses.some((clause) => clause.outcome);
    const userReflectionEvidence = analysis.clauses.some(
      (clause) => clause.reflection,
    );
    const characterReflectionRequest =
      input.assistantText.trim() !== "" &&
      isCharacterReflectionRequest(classifyText);
    if (
      !actionEvidence &&
      !outcomeEvidence &&
      !userReflectionEvidence &&
      !characterReflectionRequest
    ) {
      return {};
    }
    const stage = outcomeEvidence
      ? "outcome"
      : userReflectionEvidence || characterReflectionRequest
        ? "reflection"
        : "action";
    const evidenceSubject =
      stage === "action"
        ? actionSubject
        : stage === "outcome"
          ? outcomeSubject
          : "unspecified";
    const decision = this.selectDecisionForEvidence(
      input.agentId,
      input.sessionId,
      classifyText,
      characterReflectionRequest,
      stage,
      evidenceSubject,
    );
    if (decision === undefined) return {};
    const reflectionEvidence =
      userReflectionEvidence ||
      (characterReflectionRequest && decision.subject === "character");

    const actionsBeforeTurn = this.repository.listActionsForDecision(
      decision.id,
      24,
    );
    let actionId: string | undefined;
    if (
      actionEvidence &&
      !(actionsBeforeTurn.length > 0 && isActionRestatement(classifyText))
    ) {
      const candidateActionId = stableId(
        "action",
        `${decision.id}:${input.userMessageId}`,
      );
      const inserted = this.repository.insertAction(
        ActionRecordSchema.parse({
          id: candidateActionId,
          agentId: input.agentId,
          sessionId: input.sessionId,
          decisionId: decision.id,
          subject: decision.subject,
          performedBy:
            actionSubject === "user"
              ? "user"
              : actionSubject === "character"
                ? "character"
                : decision.subject === "user"
                  ? "user"
                  : decision.subject === "character"
                    ? "character"
                    : "joint",
          actionKind: inferActionKind(actionText),
          summary: actionText,
          sourceEvidenceIds: [input.userMessageId],
          effectiveLocalDate: localDate,
          effectivePeriod: period,
          temporalPrecision: "period",
          recordedAtUtc: input.recordedAtUtc,
          idempotencyKey: `action:${decision.id}:${input.userMessageId}`,
          schemaVersion: 1,
        }),
      );
      if (inserted) actionId = candidateActionId;
    }

    const existingActionIds = this.repository
      .listActionsForDecision(decision.id, 12)
      .map((action) => action.id);
    const actionIds = [
      ...new Set([...(actionId ? [actionId] : []), ...existingActionIds]),
    ];
    let outcomeId: string | undefined;
    if (outcomeEvidence) {
      const candidateOutcomeId = stableId(
        "decision_outcome",
        `${decision.id}:${input.userMessageId}`,
      );
      const outcome = OutcomeRecordSchema.parse({
        id: candidateOutcomeId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        decisionId: decision.id,
        actionIds,
        causeKind:
          actionIds.length === 0
            ? "external"
            : hasMixedCausation(classifyText)
              ? "mixed"
              : "action",
        valence: inferOutcomeValence(outcomeText),
        summary: outcomeText,
        consequenceFacts: [outcomeText],
        sourceEvidenceIds: [input.userMessageId],
        confidence: 0.82,
        status: "observed",
        effectiveLocalDate: localDate,
        effectivePeriod: period,
        temporalPrecision: "period",
        recordedAtUtc: input.recordedAtUtc,
        idempotencyKey: `decision-outcome:${decision.id}:${input.userMessageId}`,
        schemaVersion: 1,
      });
      const inserted = this.repository.insertOutcomeRecord(outcome);
      if (inserted) {
        outcomeId = candidateOutcomeId;
        this.linkOutcomeToPressureEpisode(decision, outcome, input);
      }
    }

    let reflectionId: string | undefined;
    if (reflectionEvidence) {
      const reflectionSourceMessageId =
        decision.subject === "character" && characterReflectionRequest
          ? input.assistantMessageId
          : input.userMessageId;
      const reflectionText =
        decision.subject === "character" && characterReflectionRequest
          ? input.assistantText
          : evidenceText;
      const reflectionAnalysisText =
        decision.subject === "character" && characterReflectionRequest
          ? input.assistantText
          : classifyText;
      const linkedOutcomeId =
        outcomeId ??
        this.repository
          .listRecentOutcomeRecords(input.agentId, 32)
          .find((outcome) => outcome.decisionId === decision.id)?.id;
      const candidateReflectionId = stableId(
        "reflection",
        `${decision.id}:${reflectionSourceMessageId}`,
      );
      const reflection = ReflectionRecordSchema.parse({
        id: candidateReflectionId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        subject: decision.subject,
        reflectedBy:
          decision.subject === "user"
            ? "user"
            : decision.subject === "character"
              ? "character"
              : "joint",
        decisionId: decision.id,
        ...(linkedOutcomeId === undefined
          ? {}
          : { outcomeId: linkedOutcomeId }),
        summary: reflectionText,
        lessons: [reflectionLesson(reflectionText)],
        stanceTowardDecision: reflectionStance(reflectionAnalysisText),
        changedInterpretation: /后悔|改主意|不是.*想的|重新/u.test(
          reflectionAnalysisText,
        ),
        sourceMessageIds: [reflectionSourceMessageId],
        effectiveLocalDate: localDate,
        effectivePeriod: period,
        temporalPrecision: "period",
        recordedAtUtc: input.recordedAtUtc,
        idempotencyKey: `reflection:${decision.id}:${reflectionSourceMessageId}`,
        schemaVersion: 1,
      });
      const inserted = this.repository.insertReflection(reflection);
      if (inserted) {
        reflectionId = candidateReflectionId;
        this.linkReflectionToPressureEpisode(decision, reflection, input);
      }
    }

    let milestoneId: string | undefined;
    if (outcomeId !== undefined || reflectionId !== undefined) {
      const milestoneSourceMessageId =
        reflectionId !== undefined &&
        decision.subject === "character" &&
        characterReflectionRequest
          ? input.assistantMessageId
          : input.userMessageId;
      milestoneId = stableId(
        "milestone",
        `turning-point:${decision.id}:${milestoneSourceMessageId}`,
      );
      this.repository.insertMilestone(
        RelationshipMilestoneSchema.parse({
          id: milestoneId,
          agentId: input.agentId,
          sessionId: input.sessionId,
          kind: "turning_point",
          title: "共同选择开始产生真实后果",
          summary:
            decision.subject === "character" && characterReflectionRequest
              ? input.assistantText
              : evidenceText,
          significance: 0.72,
          interventionIds: [],
          decisionIds: [decision.id],
          outcomeIds: outcomeId === undefined ? [] : [outcomeId],
          reflectionIds: reflectionId === undefined ? [] : [reflectionId],
          sourceMessageIds: [milestoneSourceMessageId],
          effectiveLocalDate: localDate,
          effectivePeriod: period,
          temporalPrecision: "period",
          recordedAtUtc: input.recordedAtUtc,
          idempotencyKey: `milestone:turning-point:${decision.id}:${milestoneSourceMessageId}`,
          schemaVersion: 1,
        }),
      );
    }

    if (
      actionId !== undefined ||
      outcomeId !== undefined ||
      reflectionId !== undefined
    ) {
      this.recordEvent({
        agentId: input.agentId,
        streamType: "decision_causality",
        streamId: decision.id,
        eventType: "life.decision_follow_up_evidenced",
        recordedAtUtc: input.recordedAtUtc,
        effectiveAtUtc: input.recordedAtUtc,
        payload: {
          decisionId: decision.id,
          actionId,
          outcomeId,
          reflectionId,
          milestoneId,
          evidenceMessageId:
            reflectionId !== undefined &&
            decision.subject === "character" &&
            characterReflectionRequest
              ? input.assistantMessageId
              : input.userMessageId,
        },
        correlationId: input.correlationId,
        causationId: input.userMessageId,
        idempotencyKey: `decision-follow-up:${decision.id}:${input.userMessageId}`,
      });
    }

    return {
      ...(actionId === undefined ? {} : { actionId }),
      ...(outcomeId === undefined ? {} : { outcomeId }),
      ...(reflectionId === undefined ? {} : { reflectionId }),
      ...(milestoneId === undefined ? {} : { milestoneId }),
    };
  }

  private recordCharacterDisclosure(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
  ): ConversationLifeImpact {
    const evidence = analyzeSpeakerSelfDisclosure(input.assistantText);
    if (
      !evidence.dilemmaText &&
      !evidence.pressureText &&
      !evidence.feedbackText
    )
      return {};
    const spec = this.store.getCharacterSpec(input.agentId);
    if (!spec) throw notFound("Character");
    const local = projectCharacterTime(spec.identity, input.recordedAtUtc);
    const period = dayPeriod(local.hour);
    let dilemma: DilemmaEpisode | undefined;
    if (evidence.dilemmaText) {
      const classifyText = analyzeLifeEvidence(
        evidence.dilemmaText,
      ).classifyText;
      dilemma = this.selectOpenDilemma(
        input,
        "character",
        classifyText,
        evidence.dilemmaText,
      );
      if (dilemma === undefined) {
        dilemma = this.createUserDilemma(
          input,
          evidence.dilemmaText,
          classifyText,
          inferDomain(classifyText),
          local.localDate,
          period,
          "character",
        );
      } else if (!dilemma.sourceMessageIds.includes(input.assistantMessageId)) {
        dilemma = DilemmaEpisodeSchema.parse({
          ...dilemma,
          sourceMessageIds: [
            ...dilemma.sourceMessageIds,
            input.assistantMessageId,
          ],
          updatedAtUtc: input.recordedAtUtc,
        });
        this.repository.updateDilemma(dilemma);
      }
    }
    const pressureText = [evidence.pressureText, evidence.feedbackText]
      .filter(Boolean)
      .join("，");
    if (!pressureText)
      return dilemma === undefined ? {} : { dilemmaId: dilemma.id };
    const classifyText = analyzeLifeEvidence(pressureText).classifyText;
    const pressure = this.selectCharacterPressure(
      input,
      pressureText,
      supportTopicText(classifyText) === "",
      dilemma,
    );
    const sourceId = input.assistantMessageId;
    if (pressure?.sourceMessageIds.includes(sourceId))
      return {
        ...(dilemma ? { dilemmaId: dilemma.id } : {}),
        pressureEpisodeId: pressure.id,
      };
    const explicitPressure = parseScaleMetric(classifyText, "pressure");
    const explicitClarity = parseScaleMetric(classifyText, "clarity");
    if (pressure === undefined && !evidence.pressureText)
      return dilemma === undefined ? {} : { dilemmaId: dilemma.id };
    const feedback = analyzeLifeEvidence(evidence.feedbackText).clauses;
    const improving = feedback.some(
      (clause) => clause.pressureFeedback && clause.valence === "positive",
    );
    const worsening = feedback.some(
      (clause) => clause.pressureFeedback && clause.valence === "negative",
    );
    const notUnderstood =
      /没(?:有)?被(?:听见|理解)|没(?:有)?被你听见|你没听懂/u.test(classifyText);
    const understood =
      !notUnderstood &&
      /被理解|被(?:你)?听见|谢谢你.*(?:听|陪)/u.test(classifyText);
    const currentPressure =
      explicitPressure ??
      clamp01(
        (pressure?.currentPressure ?? 0.72) +
          (pressure && improving ? -0.2 : pressure && worsening ? 0.12 : 0),
      );
    const currentClarity =
      explicitClarity ??
      clamp01(
        (pressure?.currentClarity ?? (dilemma ? 0.3 : 0.45)) +
          (pressure && improving ? 0.22 : pressure && worsening ? -0.1 : 0),
      );
    const next = PressureEpisodeSchema.parse({
      ...(pressure ?? {}),
      id:
        pressure?.id ?? stableId("pressure", `${input.sessionId}:${sourceId}`),
      agentId: input.agentId,
      sessionId: pressure?.sessionId ?? input.sessionId,
      ...(dilemma === undefined ? {} : { dilemmaId: dilemma.id }),
      subject: "character",
      pressureKind:
        pressure?.pressureKind ??
        pressureKind(inferDomain(evidence.dilemmaText || classifyText)),
      triggerSummary: pressure?.triggerSummary ?? evidence.pressureText,
      status:
        currentPressure === 0
          ? "resolved"
          : pressure && currentPressure < pressure.currentPressure
            ? "improving"
            : pressure && currentPressure > pressure.currentPressure
              ? "worsening"
              : (pressure?.status ?? "open"),
      initialPressure: pressure?.initialPressure ?? currentPressure,
      currentPressure,
      initialClarity: pressure?.initialClarity ?? currentClarity,
      currentClarity,
      initialFeltUnderstood: pressure?.initialFeltUnderstood ?? 0.2,
      currentFeltUnderstood: clamp01(
        (pressure?.currentFeltUnderstood ?? 0.2) +
          (pressure && understood
            ? 0.2
            : pressure && notUnderstood
              ? -0.12
              : 0),
      ),
      interventionIds: pressure?.interventionIds ?? [],
      outcomeIds: pressure?.outcomeIds ?? [],
      sourceMessageIds: [...(pressure?.sourceMessageIds ?? []), sourceId],
      latestEvidenceMessageId: sourceId,
      ...(currentPressure === 0
        ? { resolutionEvidenceMessageId: sourceId }
        : {}),
      effectiveLocalDate: local.localDate,
      effectivePeriod: period,
      temporalPrecision: "period",
      recordedAtUtc: pressure?.recordedAtUtc ?? input.recordedAtUtc,
      updatedAtUtc: input.recordedAtUtc,
      idempotencyKey:
        pressure?.idempotencyKey ?? `pressure:${input.sessionId}:${sourceId}`,
      schemaVersion: 1,
    });
    if (pressure) this.repository.updatePressure(next);
    else this.repository.insertPressure(next);
    this.recordEvent({
      agentId: input.agentId,
      streamType: "pressure_episode",
      streamId: next.id,
      eventType: pressure
        ? "life.pressure_updated_from_character_evidence"
        : "life.pressure_disclosed_by_character",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        pressureEpisodeId: next.id,
        dilemmaId: next.dilemmaId,
        subject: "character",
        evidenceMessageId: sourceId,
        before: pressure ? pressureLifecycleSnapshot(pressure) : undefined,
        after: pressureLifecycleSnapshot(next),
      },
      correlationId: input.correlationId,
      causationId: sourceId,
      idempotencyKey: `pressure-character-evidence:${next.id}:${sourceId}`,
    });
    return {
      ...(dilemma ? { dilemmaId: dilemma.id } : {}),
      pressureEpisodeId: next.id,
    };
  }

  private selectCharacterPressure(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    text: string,
    contextual: boolean,
    dilemma?: DilemmaEpisode,
  ): PressureEpisode | undefined {
    const candidates = this.repository
      .listOpenPressures(input.agentId, 32)
      .filter(
        (episode) =>
          episode.subject === "character" &&
          (dilemma === undefined || episode.dilemmaId === dilemma.id),
      );
    if (dilemma !== undefined) return exactlyOne(candidates);
    const scored = candidates
      .map((episode) => ({
        episode,
        score: supportTopicScore(text, episode.triggerSummary),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored[0] && (!scored[1] || scored[0].score > scored[1].score))
      return scored[0].episode;
    if (!contextual) return undefined;
    const recent = this.store
      .listMessages(input.sessionId, 18)
      .filter(
        (message) =>
          message.id !== input.userMessageId &&
          message.id !== input.assistantMessageId,
      )
      .slice(-8);
    return exactlyOne(
      candidates.filter(
        (episode) =>
          episode.sessionId === input.sessionId &&
          recent.some(
            (message) =>
              episode.sourceMessageIds.includes(message.id) &&
              Date.parse(input.recordedAtUtc) -
                Date.parse(message.createdAtUtc) >=
                0 &&
              Date.parse(input.recordedAtUtc) -
                Date.parse(message.createdAtUtc) <=
                6 * 60 * 60 * 1_000,
          ),
      ),
    );
  }

  private createUserDilemma(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    evidenceText: string,
    classifyText: string,
    domain: LifeDomain,
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
    subject: "user" | "character" = "user",
  ): DilemmaEpisode | undefined {
    const choices = extractDilemmaChoices(evidenceText, classifyText);
    if (choices === undefined) return undefined;
    const dilemmaId = stableId(
      "dilemma",
      `${input.sessionId}:${subject === "user" ? input.userMessageId : input.assistantMessageId}`,
    );
    const dilemma = DilemmaEpisodeSchema.parse({
      id: dilemmaId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      subject,
      title: shortTitle(evidenceText),
      summary: evidenceText,
      domain,
      options: choices.labels.map((label, index) => ({
        id: stableId("option", `${dilemmaId}:${index}`),
        label,
        description: isUnexplainedOption(label)
          ? `${subject === "user" ? "用户" : "角色"}尚未说明这个选项。`
          : label,
        likelyTradeoffs: ["具体收益与代价尚待讨论"],
        valuesAtStake: inferDilemmaValues(classifyText),
      })),
      status: "open",
      sourceMessageIds: [
        subject === "user" ? input.userMessageId : input.assistantMessageId,
      ],
      effectiveLocalDate: localDate,
      effectivePeriod: period,
      temporalPrecision: "period",
      recordedAtUtc: input.recordedAtUtc,
      updatedAtUtc: input.recordedAtUtc,
      idempotencyKey: `dilemma:${input.sessionId}:${subject === "user" ? input.userMessageId : input.assistantMessageId}`,
      schemaVersion: 1,
    });
    this.repository.insertDilemma(dilemma);
    return dilemma;
  }

  private recordDilemmaEvidence(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    evidenceText: string,
    classifyText: string,
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
  ): void {
    if (classifyText.trim() === "") return;
    const evidence = extractDilemmaTurnEvidence(evidenceText, classifyText);
    if (evidence === undefined) return;

    let dilemma = this.selectOpenDilemma(
      input,
      "user",
      classifyText,
      evidenceText,
    );
    if (dilemma === undefined) {
      // A structured option can introduce a dilemma. A free-standing context
      // detail or correction cannot: it must be grounded in an existing open
      // dilemma, otherwise ordinary conversation would create false episodes.
      if (evidence.kind !== "option") return;
      dilemma = this.createUserDilemma(
        input,
        evidenceText,
        classifyText,
        inferDomain(classifyText),
        localDate,
        period,
      );
    }

    if (dilemma === undefined) return;

    if (
      evidence.kind === "context" &&
      ((dilemmaRelevance(dilemma, classifyText) <
        DILEMMA_CONTEXT_EVIDENCE_RELEVANCE_THRESHOLD &&
        !hasExplicitDilemmaContextFrame(classifyText)) ||
        (!hasMeaningfulDilemmaContextAnchor(dilemma, classifyText) &&
          !hasExplicitDilemmaContextFrame(classifyText)))
    ) {
      return;
    }
    if (
      evidence.kind === "correction" &&
      !dilemmaCorrectionMatchesOptions(dilemma.options, evidence, evidenceText)
    ) {
      return;
    }

    const nextOptions = applyDilemmaEvidenceToOptions(
      dilemma.options,
      evidence,
      evidenceText,
      classifyText,
    );

    const updated = DilemmaEpisodeSchema.parse({
      ...dilemma,
      summary: `${dilemma.summary}\n证据补充：${evidenceText}`,
      options: nextOptions,
      sourceMessageIds: [
        ...new Set([...dilemma.sourceMessageIds, input.userMessageId]),
      ],
      updatedAtUtc: input.recordedAtUtc,
    });
    this.repository.updateDilemma(updated);
    this.recordEvent({
      agentId: input.agentId,
      streamType: "dilemma_episode",
      streamId: dilemma.id,
      eventType:
        evidence.kind === "option"
          ? "life.dilemma_option_evidenced"
          : "life.dilemma_context_evidenced",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        dilemmaId: dilemma.id,
        optionKey: evidence.kind === "option" ? evidence.optionKey : undefined,
        evidenceMessageId: input.userMessageId,
        correction: evidence.kind === "correction",
      },
      correlationId: input.correlationId,
      causationId: input.userMessageId,
      idempotencyKey: `dilemma-evidence:${dilemma.id}:${input.userMessageId}`,
    });
  }

  private recordCharacterDirectedTurn(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    evidenceText: string,
    classifyText: string,
    dilemma: DilemmaEpisode | undefined,
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
    pressure?: PressureEpisode,
  ): ConversationLifeImpact {
    const wantsOwnDecision = isCharacterSubjectDecisionRequest(classifyText);
    const offer = analyzeCharacterSupportOffer(evidenceText);
    const offersSupport =
      wantsOwnDecision ||
      offer !== undefined ||
      isUserAdviceToCharacter(classifyText);
    if (!offersSupport) return dilemma ? { dilemmaId: dilemma.id } : {};

    let mode: SupportMode = wantsOwnDecision
      ? "deliberate"
      : (offer?.mode ?? userToCharacterSupportMode(classifyText));
    const selectedOption =
      dilemma === undefined
        ? undefined
        : matchDilemmaOption(dilemma, classifyText, mode === "recommend");
    if (mode === "recommend" && selectedOption === undefined)
      mode = "deliberate";
    const pressureEpisodeId =
      pressure?.id ??
      this.repository
        .listOpenPressures(input.agentId, 12)
        .find(
          (episode) =>
            dilemma !== undefined &&
            episode.subject === "character" &&
            episode.dilemmaId === dilemma.id,
        )?.id;
    const interventionId = stableId(
      "support",
      `${input.sessionId}:${input.userMessageId}:user-character`,
    );
    this.repository.insertIntervention(
      SupportInterventionSchema.parse({
        id: interventionId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        ...(dilemma === undefined ? {} : { dilemmaId: dilemma.id }),
        ...(pressureEpisodeId === undefined ? {} : { pressureEpisodeId }),
        mode,
        offeredBy: "user",
        receivedBy: "character",
        summary: offer?.sourceText ?? evidenceText,
        intendedEffect: supportIntendedEffect(mode, "character"),
        ...(mode === "recommend"
          ? { recommendationOptionId: selectedOption?.id }
          : {}),
        sourceMessageId: input.userMessageId,
        effectiveLocalDate: localDate,
        effectivePeriod: period,
        temporalPrecision: "period",
        recordedAtUtc: input.recordedAtUtc,
        idempotencyKey: `support:user-character:${input.sessionId}:${input.userMessageId}`,
        schemaVersion: 1,
      }),
    );
    if (pressureEpisodeId !== undefined) {
      this.linkPressureIntervention(
        pressureEpisodeId,
        interventionId,
        input.recordedAtUtc,
      );
    }

    this.recordEvent({
      agentId: input.agentId,
      streamType: "life_decision",
      streamId: dilemma?.id ?? pressureEpisodeId ?? interventionId,
      eventType: "life.support_recorded",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        dilemmaId: dilemma?.id,
        pressureEpisodeId,
        interventionId,
        offeredBy: "user",
        receivedBy: "character",
        mode,
      },
      correlationId: input.correlationId,
      causationId: input.userMessageId,
      idempotencyKey: `support:user-character:${input.sessionId}:${input.userMessageId}`,
    });

    if (
      dilemma === undefined ||
      !wantsOwnDecision ||
      input.assistantText.trim() === ""
    ) {
      return {
        ...(dilemma === undefined ? {} : { dilemmaId: dilemma.id }),
        ...(pressureEpisodeId === undefined ? {} : { pressureEpisodeId }),
        interventionId,
      };
    }

    const decisionOption = selectDilemmaOption(dilemma, input.assistantText);
    if (decisionOption === undefined)
      return {
        dilemmaId: dilemma.id,
        interventionId,
        ...(pressureEpisodeId === undefined ? {} : { pressureEpisodeId }),
      };
    const ownedSupport = this.subjectDecisionSupport({
      dilemma,
      offeredBy: "user",
      receivedBy: "character",
      selectedOption: decisionOption,
      fallbackMode: "deliberate",
    });
    const decisionImpact = this.recordOwnedDecision({
      input,
      dilemma,
      selectedOption: decisionOption,
      supportMode: ownedSupport.mode,
      authority: "subject",
      decidedBy: "character",
      sourceMessageIds: [input.userMessageId, input.assistantMessageId],
      reasoningSummary: input.assistantText,
      supportInterventionIds: ownedSupport.interventionIds,
      localDate,
      period,
    });
    this.recordEvent({
      agentId: input.agentId,
      streamType: "life_decision",
      streamId: decisionImpact.decisionId,
      eventType: "life.character_subject_decision_recorded",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        dilemmaId: dilemma.id,
        decisionId: decisionImpact.decisionId,
        subject: "character",
        authority: "subject",
        userSupportInterventionIds: ownedSupport.interventionIds,
        sourceMessageIds: [input.userMessageId, input.assistantMessageId],
      },
      correlationId: input.correlationId,
      causationId: input.userMessageId,
      idempotencyKey: `character-subject-decision:${dilemma.id}:${input.userMessageId}`,
    });
    return {
      ...decisionImpact,
      dilemmaId: dilemma.id,
      ...(pressureEpisodeId === undefined ? {} : { pressureEpisodeId }),
      interventionId,
    };
  }

  private recordOwnedDecision(input: {
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0];
    dilemma: DilemmaEpisode;
    selectedOption: DilemmaEpisode["options"][number];
    supportMode: SupportMode;
    authority: "subject" | "delegated";
    decidedBy: "user" | "character";
    sourceMessageIds: string[];
    reasoningSummary: string;
    supportInterventionIds?: string[];
    authorizedByMessageId?: string;
    localDate: string;
    period: Exclude<DayPeriod, "anytime">;
  }): { decisionId: string; milestoneId: string } {
    const decisionId = stableId(
      "decision",
      `${input.dilemma.id}:${input.authority}:${input.input.userMessageId}`,
    );
    const supportDirection = decisionSupportDirection(
      input.dilemma,
      input.authority,
      input.decidedBy,
    );
    const availableInterventions = this.interventionsForDilemma(
      input.dilemma.id,
      supportDirection.offeredBy,
      supportDirection.receivedBy,
    );
    const requestedInterventionIds = new Set(
      input.supportInterventionIds ??
        availableInterventions.map((intervention) => intervention.id),
    );
    const supportInterventionIds = availableInterventions
      .filter(
        (intervention) =>
          requestedInterventionIds.has(intervention.id) &&
          intervention.mode === input.supportMode,
      )
      .map((intervention) => intervention.id);
    this.repository.insertDecision(
      DecisionRecordSchema.parse({
        id: decisionId,
        agentId: input.input.agentId,
        sessionId: input.input.sessionId,
        dilemmaId: input.dilemma.id,
        subject: input.dilemma.subject,
        supportMode: input.supportMode,
        authority: input.authority,
        decidedBy: input.decidedBy,
        selectedOptionId: input.selectedOption.id,
        selectionSummary: input.selectedOption.label,
        reasoningSummary: input.reasoningSummary,
        supportInterventionIds,
        sourceMessageIds: input.sourceMessageIds,
        ...(input.authorizedByMessageId === undefined
          ? {}
          : { authorizedByMessageId: input.authorizedByMessageId }),
        confidence: input.authority === "delegated" ? 0.72 : 0.86,
        status: "current",
        effectiveLocalDate: input.localDate,
        effectivePeriod: input.period,
        temporalPrecision: "period",
        recordedAtUtc: input.input.recordedAtUtc,
        idempotencyKey: `decision:${input.dilemma.id}:${input.input.userMessageId}`,
        schemaVersion: 1,
      }),
    );
    this.repository.updateDilemma(
      DilemmaEpisodeSchema.parse({
        ...input.dilemma,
        status: "closed",
        closureKind: "decision",
        closureSummary: input.selectedOption.label,
        closingDecisionId: decisionId,
        sourceMessageIds: [
          ...new Set([
            ...input.dilemma.sourceMessageIds,
            ...input.sourceMessageIds,
          ]),
        ],
        updatedAtUtc: input.input.recordedAtUtc,
      }),
    );

    const milestoneId = stableId("milestone", decisionId);
    this.repository.insertMilestone(
      RelationshipMilestoneSchema.parse({
        id: milestoneId,
        agentId: input.input.agentId,
        sessionId: input.input.sessionId,
        kind: "shared_decision",
        title:
          input.authority === "delegated"
            ? "一次被明确托付的人生选择"
            : input.dilemma.subject === "character"
              ? "角色按自己的价值作出选择"
              : "用户明确作出自己的选择",
        summary:
          input.authority === "delegated"
            ? `用户明确授权角色选择：${input.selectedOption.label}`
            : `${input.dilemma.subject === "character" ? "角色" : "用户"}保留决定权并选择：${input.selectedOption.label}`,
        significance: input.authority === "delegated" ? 0.8 : 0.74,
        interventionIds: supportInterventionIds,
        decisionIds: [decisionId],
        outcomeIds: [],
        reflectionIds: [],
        sourceMessageIds: input.sourceMessageIds,
        effectiveLocalDate: input.localDate,
        effectivePeriod: input.period,
        temporalPrecision: "period",
        recordedAtUtc: input.input.recordedAtUtc,
        idempotencyKey: `milestone:decision:${decisionId}`,
        schemaVersion: 1,
      }),
    );
    return { decisionId, milestoneId };
  }

  private subjectDecisionSupport(input: {
    dilemma: DilemmaEpisode;
    offeredBy: "user" | "character";
    receivedBy: "user" | "character";
    selectedOption: DilemmaEpisode["options"][number];
    fallbackMode: Exclude<SupportMode, "delegated_decision">;
  }): {
    mode: Exclude<SupportMode, "delegated_decision">;
    interventionIds: string[];
  } {
    const interventions = this.interventionsForDilemma(
      input.dilemma.id,
      input.offeredBy,
      input.receivedBy,
    ).filter((intervention) => intervention.mode !== "delegated_decision");
    const matchingRecommendations = interventions.filter(
      (intervention) =>
        intervention.mode === "recommend" &&
        intervention.recommendationOptionId === input.selectedOption.id,
    );
    if (matchingRecommendations.length > 0) {
      return {
        mode: "recommend",
        interventionIds: matchingRecommendations.map(
          (intervention) => intervention.id,
        ),
      };
    }

    const latestApplicable = [...interventions]
      .reverse()
      .find((intervention) => intervention.mode !== "recommend");
    const mode =
      latestApplicable?.mode === "listen_only" ||
      latestApplicable?.mode === "deliberate" ||
      latestApplicable?.mode === "recommend"
        ? latestApplicable.mode
        : input.fallbackMode;
    return {
      mode,
      interventionIds: interventions
        .filter((intervention) => intervention.mode === mode)
        .map((intervention) => intervention.id),
    };
  }

  private selectOpenDilemma(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    subject: DilemmaEpisode["subject"],
    evidenceText: string,
    sourceText = evidenceText,
  ): DilemmaEpisode | undefined {
    if (evidenceText.trim() === "") return undefined;
    const candidates = this.repository
      .listOpenDilemmas(input.agentId, 32)
      .filter((episode) => episode.subject === subject);
    const choices = extractDilemmaChoices(sourceText, evidenceText);
    const structured = extractDilemmaTurnEvidence(sourceText, evidenceText);
    const namedReferences = [
      ...sourceText.matchAll(
        /(?:为|关于|对于|回到|就)\s*[《“]([^》”]+)[》”]/gu,
      ),
    ]
      .map((match) => match[1])
      .join(" ");
    const scored = candidates
      .map((episode) => ({
        episode,
        score: dilemmaScopeScore(
          episode,
          `${evidenceText} ${namedReferences}`,
          choices,
        ),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored[0] && (!scored[1] || scored[0].score > scored[1].score))
      return scored[0].episode;
    if (structured?.kind === "correction") {
      return exactlyOne(
        candidates.filter((episode) =>
          dilemmaCorrectionMatchesOptions(
            episode.options,
            structured,
            sourceText,
          ),
        ),
      );
    }
    const sameSession = candidates.filter((episode) =>
      this.hasRecentDilemmaContext(episode, input),
    );
    if (structured?.kind === "context") {
      const contextual = exactlyOne(
        sameSession.filter(
          (episode) =>
            hasExplicitDilemmaContextFrame(evidenceText) ||
            (dilemmaRelevance(episode, evidenceText) >=
              DILEMMA_CONTEXT_EVIDENCE_RELEVANCE_THRESHOLD &&
              hasMeaningfulDilemmaContextAnchor(episode, evidenceText)),
        ),
      );
      if (contextual !== undefined) return contextual;
    }
    if (structured?.kind === "option") {
      return exactlyOne(
        sameSession.filter((episode) =>
          isUnexplainedOption(episode.options[structured.optionIndex]!.label),
        ),
      );
    }
    if (choices && !choices.incomplete) return undefined;
    if (
      choices?.incomplete &&
      choices.labels.every((label) => /^选项\s*[AB]$/u.test(label))
    )
      return exactlyOne(sameSession);
    if (!isDilemmaContinuation(evidenceText)) return undefined;
    // An explicit anaphoric request can continue one current conversation
    // dilemma; a newly named topic cannot take this path.
    return exactlyOne(sameSession);
  }

  private hasRecentDilemmaContext(
    episode: DilemmaEpisode,
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
  ): boolean {
    if (episode.sessionId !== input.sessionId) return false;
    const messages = this.store
      .listMessages(input.sessionId, 18)
      .filter(
        (message) =>
          message.id !== input.userMessageId &&
          message.id !== input.assistantMessageId,
      )
      .slice(-8);
    const evidenceIds = new Set([
      ...episode.sourceMessageIds,
      ...this.repository
        .listRecentInterventions(input.agentId, 64)
        .filter((intervention) => intervention.dilemmaId === episode.id)
        .map((intervention) => intervention.sourceMessageId),
    ]);
    const now = Date.parse(input.recordedAtUtc);
    return messages.some((message) => {
      const elapsed = now - Date.parse(message.createdAtUtc);
      return (
        evidenceIds.has(message.id) &&
        elapsed >= 0 &&
        elapsed <= 6 * 60 * 60 * 1_000
      );
    });
  }

  private selectDecisionForEvidence(
    agentId: string,
    sessionId: string,
    evidenceText: string,
    preferCharacter: boolean,
    stage: "action" | "outcome" | "reflection",
    evidenceSubject: LifeEvidenceSubject = "unspecified",
  ): DecisionRecord | undefined {
    const decisions = this.repository
      .listCurrentDecisions(agentId, 32)
      .filter(
        (decision) =>
          stage === "reflection" ||
          evidenceSubject === "unspecified" ||
          (evidenceSubject === "user" &&
            (decision.subject === "user" || decision.subject === "shared")) ||
          (evidenceSubject === "character" &&
            (decision.subject === "character" ||
              decision.subject === "shared")),
      );
    if (decisions.length === 0) return undefined;
    const scored = decisions.map((decision, index) => {
      const dilemma = this.findDilemma(decision.dilemmaId);
      const actions = this.repository.listActionsForDecision(decision.id, 24);
      const outcomes = this.repository
        .listRecentOutcomeRecords(agentId, 64)
        .filter((outcome) => outcome.decisionId === decision.id);
      const stageEvidenceBonus =
        stage === "outcome"
          ? actions.some((action) => action.sessionId === sessionId)
            ? 180
            : actions.length > 0
              ? 35
              : 0
          : stage === "reflection"
            ? outcomes.some((outcome) => outcome.sessionId === sessionId)
              ? 180
              : outcomes.length > 0
                ? 35
                : 0
            : 0;
      const semanticRelevance = decisionEvidenceSemanticRelevance(
        decision,
        dilemma,
        evidenceText,
      );
      const predecessorRelevance = decisionStagePredecessorRelevance(
        stage,
        evidenceText,
        actions.map((action) => action.summary),
        outcomes.map((outcome) => outcome.summary),
      );
      const hasStageContinuity =
        stage === "action"
          ? decision.sessionId === sessionId
          : stage === "outcome"
            ? actions.some((action) => action.sessionId === sessionId)
            : outcomes.some((outcome) => outcome.sessionId === sessionId) ||
              decision.sessionId === sessionId;
      const normalEligible =
        semanticRelevance >= DECISION_EVIDENCE_RELEVANCE_THRESHOLD ||
        predecessorRelevance >= DECISION_EVIDENCE_RELEVANCE_THRESHOLD ||
        (hasStageContinuity &&
          hasExplicitCausalStageReference(evidenceText, stage));
      const sameSessionOutcome = outcomes.some(
        (outcome) => outcome.sessionId === sessionId,
      );
      const reflectionSubjectMatch = reflectionSubjectMatches(
        decision,
        evidenceText,
        preferCharacter,
      );
      const continuityRelevance = reflectionContinuityRelevance(
        decision,
        dilemma,
        evidenceText,
        actions.map((action) => action.summary),
        outcomes.map((outcome) => outcome.summary),
      );
      const continuityEligible =
        stage === "reflection" &&
        !preferCharacter &&
        isReflectionEvidence(evidenceText) &&
        sameSessionOutcome &&
        reflectionSubjectMatch &&
        continuityRelevance >= REFLECTION_CONTINUITY_RELEVANCE_THRESHOLD;
      const eligible = normalEligible || continuityEligible;
      const score =
        decisionRelevance(decision, dilemma, evidenceText) +
        (decision.sessionId === sessionId ? 240 : 0) +
        (preferCharacter && decision.subject === "character" ? 500 : 0) +
        (!preferCharacter &&
        decision.subject === "user" &&
        /我|我的|我们/u.test(evidenceText)
          ? 80
          : 0) +
        stageEvidenceBonus +
        (decisions.length - index);
      return {
        decision,
        score,
        eligible,
        normalEligible,
        sameSessionOutcome,
        reflectionSubjectMatch,
        semanticRelevance,
        predecessorRelevance,
        continuityRelevance,
      };
    });
    const eligible = scored
      .filter((candidate) => candidate.eligible)
      .sort((left, right) => right.score - left.score);
    if (stage !== "reflection") return eligible[0]?.decision;
    const sameSessionRelevant = eligible.filter(
      (candidate) =>
        candidate.sameSessionOutcome && candidate.reflectionSubjectMatch,
    );
    if (sameSessionRelevant.length > 1) return undefined;
    if (sameSessionRelevant.length === 1) {
      return sameSessionRelevant[0]!.decision;
    }
    const fullyGroundedElsewhere = eligible.filter(
      (candidate) => candidate.normalEligible,
    );
    return fullyGroundedElsewhere.length === 1
      ? fullyGroundedElsewhere[0]!.decision
      : undefined;
  }

  private findDilemma(id: string): DilemmaEpisode | undefined {
    const row = this.store.database
      .prepare("SELECT episode_json AS json FROM dilemma_episodes WHERE id = ?")
      .get(id) as { json: string } | undefined;
    return row === undefined
      ? undefined
      : DilemmaEpisodeSchema.parse(JSON.parse(row.json) as unknown);
  }

  private interventionsForDilemma(
    dilemmaId: string,
    offeredBy: "user" | "character",
    receivedBy: "user" | "character",
  ): SupportIntervention[] {
    return (
      this.store.database
        .prepare(
          `SELECT intervention_json AS json FROM support_interventions
           WHERE dilemma_id = ? AND offered_by = ? AND received_by = ?
           ORDER BY recorded_at_utc ASC, rowid ASC`,
        )
        .all(dilemmaId, offeredBy, receivedBy) as { json: string }[]
    ).map((row) =>
      SupportInterventionSchema.parse(JSON.parse(row.json) as unknown),
    );
  }

  private findIntervention(id: string): SupportIntervention | undefined {
    const row = this.store.database
      .prepare(
        "SELECT intervention_json AS json FROM support_interventions WHERE id = ?",
      )
      .get(id) as { json: string } | undefined;
    return row === undefined
      ? undefined
      : SupportInterventionSchema.parse(JSON.parse(row.json) as unknown);
  }

  private selectPressureForSupport(input: {
    agentId: string;
    subject: PressureEpisode["subject"];
    dilemma?: DilemmaEpisode;
    preferredEpisodeIds: readonly string[];
  }): PressureEpisode | undefined {
    const candidates = this.repository
      .listOpenPressures(input.agentId, 32)
      .filter((episode) => episode.subject === input.subject);
    const preferredIds = new Set(input.preferredEpisodeIds);
    const compatible = (episode: PressureEpisode): boolean =>
      input.dilemma === undefined || episode.dilemmaId === input.dilemma.id;
    const preferred = candidates.filter(
      (episode) => preferredIds.has(episode.id) && compatible(episode),
    );
    if (preferred.length === 1) return preferred[0];
    if (preferred.length > 1) return undefined;
    if (input.dilemma === undefined) return undefined;
    const exactDilemma = candidates.filter(compatible);
    return exactDilemma.length === 1 ? exactDilemma[0] : undefined;
  }

  private linkOutcomeToPressureEpisode(
    decision: DecisionRecord,
    outcome: OutcomeRecord,
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
  ): void {
    const pressure = this.selectPressureForDecision(decision);
    if (pressure === undefined || pressure.outcomeIds.includes(outcome.id)) {
      return;
    }
    const updated =
      decision.subject === "character"
        ? progressPressureFromOutcome(pressure, outcome, input.recordedAtUtc)
        : linkPressureOutcomeEvidence(pressure, outcome, input.recordedAtUtc);
    this.repository.updatePressure(updated);
    this.recordEvent({
      agentId: input.agentId,
      streamType: "pressure_episode",
      streamId: pressure.id,
      eventType:
        decision.subject === "character"
          ? "life.pressure_progressed_from_outcome"
          : "life.pressure_outcome_linked",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        pressureEpisodeId: pressure.id,
        dilemmaId: decision.dilemmaId,
        decisionId: decision.id,
        outcomeId: outcome.id,
        outcomeValence: outcome.valence,
        before: pressureLifecycleSnapshot(pressure),
        after: pressureLifecycleSnapshot(updated),
      },
      correlationId: input.correlationId,
      causationId: input.userMessageId,
      idempotencyKey: `pressure-outcome:${pressure.id}:${outcome.id}`,
    });
  }

  private linkReflectionToPressureEpisode(
    decision: DecisionRecord,
    reflection: ReflectionRecord,
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
  ): void {
    // User pressure metrics are updated only by explicit user-authored scale or
    // status evidence. Character pressure may advance from the character's
    // own observed outcome and reflection because those are its first-party
    // evidence. This preserves the H12 distinction between a user's life event
    // occurring and the user actually reporting how it affected them.
    if (decision.subject !== "character") return;
    if (reflection.outcomeId !== undefined) {
      const linkedOutcome = this.repository
        .listRecentOutcomeRecords(input.agentId, 128)
        .find((outcome) => outcome.id === reflection.outcomeId);
      if (linkedOutcome !== undefined) {
        this.linkOutcomeToPressureEpisode(decision, linkedOutcome, input);
      }
    }

    const pressure = this.selectPressureForDecision(decision);
    if (pressure === undefined) return;
    const eventKey = `pressure-reflection:${pressure.id}:${reflection.id}`;
    const alreadyProgressed = this.store.database
      .prepare("SELECT 1 FROM domain_events WHERE idempotency_key = ?")
      .get(eventKey);
    if (alreadyProgressed !== undefined) return;

    const updated = progressPressureFromReflection(
      pressure,
      reflection,
      input.recordedAtUtc,
    );
    this.repository.updatePressure(updated);
    this.recordEvent({
      agentId: input.agentId,
      streamType: "pressure_episode",
      streamId: pressure.id,
      eventType: "life.pressure_progressed_from_reflection",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        pressureEpisodeId: pressure.id,
        dilemmaId: decision.dilemmaId,
        decisionId: decision.id,
        reflectionId: reflection.id,
        reflectionStance: reflection.stanceTowardDecision,
        before: pressureLifecycleSnapshot(pressure),
        after: pressureLifecycleSnapshot(updated),
      },
      correlationId: input.correlationId,
      causationId: input.userMessageId,
      idempotencyKey: eventKey,
    });
  }

  private selectPressureForDecision(
    decision: DecisionRecord,
  ): PressureEpisode | undefined {
    const dilemma = this.findDilemma(decision.dilemmaId);
    if (dilemma === undefined) return;
    const candidates = this.listPressureEpisodes(decision.agentId).filter(
      (episode) => episode.subject === decision.subject,
    );
    const referencedPressureIds = new Set(
      decision.supportInterventionIds
        .flatMap((interventionId) => {
          const intervention = this.findIntervention(interventionId);
          return intervention === undefined ? [] : [intervention];
        })
        .flatMap((intervention) =>
          intervention.pressureEpisodeId === undefined
            ? []
            : [intervention.pressureEpisodeId],
        ),
    );
    const directlyLinked = candidates.filter((episode) =>
      referencedPressureIds.has(episode.id),
    );
    const exactDilemma = candidates.filter(
      (episode) => episode.dilemmaId === decision.dilemmaId,
    );
    const semanticallyLinked = candidates.filter(
      (episode) =>
        episode.sessionId === decision.sessionId &&
        pressureDilemmaSemanticRelevance(
          episode,
          dilemma,
          this.pressureEvidenceTexts(episode),
        ) >= PRESSURE_DILEMMA_RELEVANCE_THRESHOLD,
    );
    return (
      exactlyOne(directlyLinked) ??
      exactlyOne(exactDilemma) ??
      exactlyOne(semanticallyLinked)
    );
  }

  private listPressureEpisodes(agentId: string): PressureEpisode[] {
    return (
      this.store.database
        .prepare(
          `SELECT episode_json AS json FROM pressure_episodes
           WHERE agent_id = ? ORDER BY updated_at_utc DESC, rowid DESC`,
        )
        .all(agentId) as { json: string }[]
    ).map((row) =>
      PressureEpisodeSchema.parse(JSON.parse(row.json) as unknown),
    );
  }

  private pressureEvidenceTexts(episode: PressureEpisode): string[] {
    const selectMessage = this.store.database.prepare(
      "SELECT content FROM messages WHERE id = ?",
    );
    return episode.sourceMessageIds.flatMap((messageId) => {
      const row = selectMessage.get(messageId) as
        { content: string } | undefined;
      return row === undefined
        ? []
        : [analyzeSupportSpeechAct(row.content).operativeDilemmaClassifyText];
    });
  }

  private linkPressureIntervention(
    pressureEpisodeId: string,
    interventionId: string,
    recordedAtUtc: string,
  ): void {
    const row = this.store.database
      .prepare(
        "SELECT episode_json AS json FROM pressure_episodes WHERE id = ?",
      )
      .get(pressureEpisodeId) as { json: string } | undefined;
    if (row === undefined) return;
    const current = PressureEpisodeSchema.parse(
      JSON.parse(row.json) as unknown,
    );
    if (current.interventionIds.includes(interventionId)) return;
    this.repository.updatePressure(
      PressureEpisodeSchema.parse({
        ...current,
        interventionIds: [...current.interventionIds, interventionId],
        updatedAtUtc: recordedAtUtc,
      }),
    );
  }

  private pressureHasExplicitScaleEvidence(episode: PressureEpisode): boolean {
    const selectMessage = this.store.database.prepare(
      "SELECT content FROM messages WHERE id = ?",
    );
    return episode.sourceMessageIds.some((messageId) => {
      const row = selectMessage.get(messageId) as
        { content: string } | undefined;
      if (row === undefined) return false;
      const classifyText = analyzeSupportSpeechAct(
        row.content,
      ).operativeDilemmaClassifyText;
      return (
        parseScaleMetric(classifyText, "pressure") !== undefined ||
        parseScaleMetric(classifyText, "clarity") !== undefined
      );
    });
  }

  private selectContinuingUserPressure(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    classifyText: string,
  ): PressureEpisode | undefined {
    const candidates = this.repository
      .listOpenPressures(input.agentId, 24)
      .filter((episode) => episode.subject === "user");
    if (candidates.length === 0) return undefined;

    if (isPressureTrajectoryContinuation(classifyText)) {
      return candidates[0];
    }

    const sameSession = candidates.filter(
      (episode) => episode.sessionId === input.sessionId,
    );
    const pool = sameSession.length > 0 ? sameSession : candidates;
    const inferredKind = pressureKind(inferDomain(classifyText));
    const exactKind = pool.find(
      (episode) => episode.pressureKind === inferredKind,
    );
    if (exactKind !== undefined) return exactKind;

    if (
      inferredKind === "identity" &&
      isIdentityFacetOfLifeChoice(classifyText)
    ) {
      return pool.find((episode) =>
        ["work", "decision", "identity"].includes(episode.pressureKind),
      );
    }

    const hasExplicitScale =
      parseScaleMetric(classifyText, "pressure") !== undefined ||
      parseScaleMetric(classifyText, "clarity") !== undefined;
    if (hasExplicitScale && sameSession.length > 0) return sameSession[0];
    if (sameSession.length > 0 && isPressureFeedbackText(classifyText)) {
      return sameSession[0];
    }
    return undefined;
  }

  private ensureGoalThreads(spec: CharacterSpec, atUtc: string): LifeThread[] {
    for (const goal of spec.persona.goals.slice(0, 4)) {
      const key = `life-thread:${spec.id}:goal:${goal.id}`;
      const existing = this.repository.findThreadByIdempotencyKey(key);
      if (existing === undefined) {
        const timelinePlan = freezeTimelinePlan(spec, goal, atUtc);
        const milestones = timelinePlan.milestones;
        const firstMilestone = milestones[0]!;
        const localDate = timelineLocalDate(timelinePlan.timeBasis, atUtc);
        const thread = LifeThreadSchema.parse({
          id: stableId("life_thread", key),
          agentId: spec.id,
          subject: "character",
          title: goal.title,
          summary: goal.description,
          domain: inferDomain(`${goal.title} ${goal.description}`),
          status: "active",
          currentStage: firstMilestone.title,
          progressNote: firstMilestone.focus,
          nextStepHint: milestoneNextStep(firstMilestone, milestones[1]),
          timelinePlan,
          currentMilestoneId: firstMilestone.id,
          startedLocalDate: localDate,
          lastAdvancedLocalDate: localDate,
          sourceMessageIds: [],
          idempotencyKey: key,
          revision: 1,
          schemaVersion: 2,
          createdAtUtc: atUtc,
          updatedAtUtc: atUtc,
        });
        this.store.transaction(() => {
          if (!this.repository.insertThread(thread)) return;
          this.recordEvent({
            agentId: spec.id,
            streamType: "life_thread",
            streamId: thread.id,
            streamVersion: thread.revision,
            eventType: "life.thread_created",
            recordedAtUtc: atUtc,
            effectiveAtUtc: atUtc,
            payload: {
              threadId: thread.id,
              sourceGoalId: goal.id,
              sourceCharacterVersion: spec.version,
              timelinePlanSha256: timelinePlan.planSha256,
              milestoneId: firstMilestone.id,
              effectiveLocalDate: localDate,
              temporalPrecision: "day",
              progressionBasis: "published_character_timeline",
            },
            idempotencyKey: `life-thread:${thread.id}:created`,
          });
        });
      }
    }

    // Creation follows the current published head, while advancement follows
    // each thread's own immutable plan. A goal that is later removed, moved
    // below the prompt limit, or moved to another timezone must keep aging on
    // the exact timeline that created it.
    for (const thread of this.repository.listAllActiveThreads(spec.id)) {
      this.advanceGoalThread(thread.id, atUtc);
    }
    return this.repository.listActiveThreads(spec.id, 6);
  }

  private advanceGoalThread(threadId: string, atUtc: string): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.store.transaction(() => {
          const thread = this.repository.findThreadById(threadId);
          if (thread === undefined || thread.status !== "active") return;
          const migration =
            thread.timelinePlan === undefined
              ? resolveLegacyTimelinePlan(this.store, thread)
              : undefined;
          const timelinePlan = migration?.plan ?? thread.timelinePlan!;
          assertTimelinePlanHash(timelinePlan);
          const milestones = timelinePlan.milestones;
          const localDate = timelineLocalDate(timelinePlan.timeBasis, atUtc);
          const elapsedDays = localCalendarDayDifference(
            thread.startedLocalDate,
            localDate,
          );
          const dateIndex = milestoneIndexAt(milestones, elapsedDays);
          const persistedIndex =
            migration?.persistedIndex ??
            milestones.findIndex(
              (milestone) => milestone.id === thread.currentMilestoneId,
            );
          if (persistedIndex < 0) {
            throw new Error(
              `Life thread ${thread.id} points to a milestone outside its frozen plan`,
            );
          }
          // A developer clock rollback may change today's projected date, but
          // it must never rewind an already reached life stage.
          const targetIndex = Math.max(persistedIndex, dateIndex);
          const target = milestones[targetIndex]!;
          const projectionChanged =
            thread.currentStage !== target.title ||
            thread.progressNote !== target.focus ||
            thread.nextStepHint !==
              milestoneNextStep(target, milestones[targetIndex + 1]);
          const crossed = milestones.slice(persistedIndex + 1, targetIndex + 1);
          const transitions: Array<{
            eventType: string;
            payload: Record<string, unknown>;
            idempotencyKey: string;
          }> = [];
          if (migration !== undefined) {
            transitions.push({
              eventType: "life.thread_timeline_attached",
              payload: {
                threadId: thread.id,
                sourceGoalId: timelinePlan.sourceGoalId,
                sourceCharacterVersion: timelinePlan.sourceCharacterVersion,
                timelinePlanSha256: timelinePlan.planSha256,
                attachedMilestoneId: milestones[persistedIndex]!.id,
                progressionBasis: "frozen_character_timeline",
              },
              idempotencyKey: `life-thread:${thread.id}:timeline-attached:v1`,
            });
          }
          crossed.forEach((milestone, index) => {
            const previous = milestones[persistedIndex + index]!;
            transitions.push({
              eventType: "life.thread_milestone_reached",
              payload: {
                threadId: thread.id,
                sourceGoalId: timelinePlan.sourceGoalId,
                sourceCharacterVersion: timelinePlan.sourceCharacterVersion,
                timelinePlanSha256: timelinePlan.planSha256,
                milestoneId: milestone.id,
                previousMilestoneId: previous.id,
                phaseTitle: milestone.title,
                effectiveLocalDate: milestoneEffectiveLocalDate(
                  thread.startedLocalDate,
                  milestone.afterDays,
                ),
                temporalPrecision: "day",
                progressionBasis: "frozen_character_timeline",
              },
              idempotencyKey: `life-thread:${thread.id}:milestone:${milestone.id}`,
            });
          });
          if (
            migration === undefined &&
            crossed.length === 0 &&
            projectionChanged
          ) {
            transitions.push({
              eventType: "life.thread_projection_repaired",
              payload: {
                threadId: thread.id,
                timelinePlanSha256: timelinePlan.planSha256,
                milestoneId: target.id,
                effectiveLocalDate: localDate,
                temporalPrecision: "day",
              },
              idempotencyKey: `life-thread:${thread.id}:projection-repaired:${target.id}:${thread.revision}`,
            });
          }
          if (transitions.length === 0) return;
          const updated = LifeThreadSchema.parse({
            ...thread,
            currentStage: target.title,
            progressNote: target.focus,
            nextStepHint: milestoneNextStep(
              target,
              milestones[targetIndex + 1],
            ),
            timelinePlan,
            currentMilestoneId: target.id,
            lastAdvancedLocalDate: milestoneEffectiveLocalDate(
              thread.startedLocalDate,
              target.afterDays,
            ),
            revision: thread.revision + transitions.length,
            schemaVersion: 2,
            updatedAtUtc: atUtc,
          });
          transitions.forEach((transition, index) => {
            this.recordEvent({
              agentId: thread.agentId,
              streamType: "life_thread",
              streamId: thread.id,
              streamVersion: thread.revision + index + 1,
              eventType: transition.eventType,
              recordedAtUtc: atUtc,
              // Infrastructure ordering instant. The day-precision story
              // effective date lives in the event payload.
              effectiveAtUtc: atUtc,
              payload: transition.payload,
              idempotencyKey: transition.idempotencyKey,
            });
          });
          this.repository.updateThread(updated, thread.revision);
        });
        return;
      } catch (error) {
        if (!(error instanceof LifeThreadRevisionConflictError) || attempt > 0)
          throw error;
      }
    }
  }

  private applyPressureFollowUp(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    classifyText: string,
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
  ): PressureFollowUpResult {
    if (!isUserPressureEvidenceSubject(classifyText)) {
      return { updated: false };
    }
    const explicitPressure = parseScaleMetric(classifyText, "pressure");
    const explicitClarity = parseScaleMetric(classifyText, "clarity");
    const improvingLanguage =
      /好多了|轻松多了|没那么(?:焦虑|难受|乱)|想清楚了|清楚多了|被理解|谢谢你.*(?:听|陪)/u.test(
        classifyText,
      );
    const worseningLanguage =
      /更焦虑|更难受|更糟|还是很乱|完全没用|压力更大/u.test(classifyText);
    const feltUnderstoodPositive =
      /被(?:你)?听见|被理解|谢谢你.*(?:听|陪)|你听懂了/u.test(classifyText);
    const feltUnderstoodNegative =
      /没(?:有)?被(?:听见|理解)|你没听懂|完全没听进去/u.test(classifyText);
    const episode = this.selectContinuingUserPressure(input, classifyText);
    if (
      explicitPressure === undefined &&
      explicitClarity === undefined &&
      !improvingLanguage &&
      !worseningLanguage &&
      !feltUnderstoodPositive &&
      !feltUnderstoodNegative
    ) {
      if (
        episode !== undefined &&
        isPressureDisclosure(classifyText) &&
        isPressureTrajectoryContinuation(classifyText)
      ) {
        const updated = PressureEpisodeSchema.parse({
          ...episode,
          sourceMessageIds: [
            ...new Set([...episode.sourceMessageIds, input.userMessageId]),
          ],
          latestEvidenceMessageId: input.userMessageId,
          effectiveLocalDate: localDate,
          effectivePeriod: period,
          temporalPrecision: "period",
          updatedAtUtc: input.recordedAtUtc,
        });
        this.repository.updatePressure(updated);
        this.recordEvent({
          agentId: input.agentId,
          streamType: "pressure_episode",
          streamId: episode.id,
          eventType: "life.pressure_context_extended_from_user_evidence",
          recordedAtUtc: input.recordedAtUtc,
          effectiveAtUtc: input.recordedAtUtc,
          payload: {
            pressureEpisodeId: episode.id,
            pressureKind: episode.pressureKind,
            evidenceMessageId: input.userMessageId,
            metricsUnchanged: true,
          },
          correlationId: input.correlationId,
          causationId: input.userMessageId,
          idempotencyKey: `pressure-context:${episode.id}:${input.userMessageId}`,
        });
        return { updated: true, episodeId: episode.id };
      }
      return { updated: false };
    }
    if (episode === undefined) return { updated: false };

    const qualitativeMetricsAllowed =
      explicitPressure === undefined &&
      explicitClarity === undefined &&
      !/别(?:自动)?把.{0,12}(?:写成|当成).{0,12}(?:缓解|好转)|不代表轻松/u.test(
        classifyText,
      );
    const nextPressure =
      explicitPressure ??
      clamp01(
        episode.currentPressure +
          (qualitativeMetricsAllowed
            ? improvingLanguage
              ? -0.2
              : worseningLanguage
                ? 0.12
                : 0
            : 0),
      );
    const nextClarity =
      explicitClarity ??
      clamp01(
        episode.currentClarity +
          (qualitativeMetricsAllowed
            ? improvingLanguage
              ? 0.22
              : worseningLanguage
                ? -0.1
                : 0
            : 0),
      );
    const nextFeltUnderstood = clamp01(
      episode.currentFeltUnderstood +
        (feltUnderstoodPositive
          ? 0.2
          : feltUnderstoodNegative
            ? -0.12
            : qualitativeMetricsAllowed
              ? improvingLanguage
                ? 0.12
                : worseningLanguage
                  ? -0.08
                  : 0
              : 0),
    );
    const resolved =
      /已经没事|压力(?:是|到|降到)?\s*0(?:\.0+)?\s*\/\s*10|彻底解决了/u.test(
        classifyText,
      );
    const pressureDelta = nextPressure - episode.currentPressure;
    const firstExplicitScale =
      (explicitPressure !== undefined || explicitClarity !== undefined) &&
      !this.pressureHasExplicitScaleEvidence(episode);
    const status = resolved
      ? "resolved"
      : pressureDelta < -0.000_001
        ? "improving"
        : pressureDelta > 0.000_001
          ? "worsening"
          : episode.status;
    const updated = PressureEpisodeSchema.parse({
      ...episode,
      status,
      initialPressure:
        firstExplicitScale && explicitPressure !== undefined
          ? explicitPressure
          : episode.initialPressure,
      initialClarity:
        firstExplicitScale && explicitClarity !== undefined
          ? explicitClarity
          : episode.initialClarity,
      currentPressure: nextPressure,
      currentClarity: nextClarity,
      currentFeltUnderstood: nextFeltUnderstood,
      sourceMessageIds: [
        ...new Set([...episode.sourceMessageIds, input.userMessageId]),
      ],
      latestEvidenceMessageId: input.userMessageId,
      ...(resolved ? { resolutionEvidenceMessageId: input.userMessageId } : {}),
      effectiveLocalDate: localDate,
      effectivePeriod: period,
      temporalPrecision: "period",
      updatedAtUtc: input.recordedAtUtc,
    });
    this.repository.updatePressure(updated);
    this.recordEvent({
      agentId: input.agentId,
      streamType: "pressure_episode",
      streamId: episode.id,
      eventType:
        explicitPressure !== undefined || explicitClarity !== undefined
          ? "life.pressure_metrics_updated_from_user_evidence"
          : pressureDelta < 0
            ? "life.pressure_improved_from_user_evidence"
            : pressureDelta > 0
              ? "life.pressure_worsened_from_user_evidence"
              : "life.pressure_understanding_updated_from_user_evidence",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        before: {
          pressure: episode.currentPressure,
          clarity: episode.currentClarity,
          feltUnderstood: episode.currentFeltUnderstood,
        },
        after: {
          initialPressure: updated.initialPressure,
          initialClarity: updated.initialClarity,
          pressure: updated.currentPressure,
          clarity: updated.currentClarity,
          feltUnderstood: updated.currentFeltUnderstood,
        },
        firstExplicitScale,
      },
      correlationId: input.correlationId,
      causationId: input.userMessageId,
      idempotencyKey: `pressure-feedback:${episode.id}:${input.userMessageId}`,
    });
    return { updated: true, episodeId: episode.id };
  }

  private recordEvent(input: DomainEventWrite): void {
    const event = {
      ...input,
      streamVersion: input.streamVersion ?? 1,
    };
    if (event.streamType === "life_thread") {
      const occupyingVersion = this.store.getDomainEventByStreamVersion(
        event.streamType,
        event.streamId,
        event.streamVersion,
      );
      if (
        occupyingVersion !== undefined &&
        !sameLifeThreadEvent(occupyingVersion, event)
      ) {
        throw new Error(
          `Life-thread event stream version ${event.streamVersion} is already occupied for ${event.streamId}`,
        );
      }
    }
    if (this.store.insertDomainEvent(event)) return;
    if (event.streamType !== "life_thread") return;
    const existing = this.store.getDomainEventByIdempotencyKey(
      event.idempotencyKey,
    );
    if (existing === undefined || !sameLifeThreadEvent(existing, event)) {
      throw new Error(
        `Life-thread event idempotency collision: ${event.idempotencyKey}`,
      );
    }
  }

  private domainEventId(idempotencyKey: string): string {
    const row = this.store.database
      .prepare("SELECT id FROM domain_events WHERE idempotency_key = ?")
      .get(idempotencyKey) as { id: string } | undefined;
    if (row === undefined)
      throw new Error("Life outcome evidence event is missing");
    return row.id;
  }
}

function sameLifeThreadEvent(
  actual: Record<string, unknown>,
  expected: DomainEventWrite & { streamVersion: number },
): boolean {
  return (
    actual["agentId"] === expected.agentId &&
    actual["streamType"] === expected.streamType &&
    actual["streamId"] === expected.streamId &&
    actual["streamVersion"] === expected.streamVersion &&
    actual["eventType"] === expected.eventType &&
    actual["idempotencyKey"] === expected.idempotencyKey &&
    JSON.stringify(actual["payload"]) === JSON.stringify(expected.payload)
  );
}
