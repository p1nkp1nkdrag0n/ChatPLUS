import { createHash } from "node:crypto";

import {
  ActionRecordSchema,
  DailyLifeContextSchema,
  DailyLifeIntentSchema,
  DecisionRecordSchema,
  DilemmaEpisodeSchema,
  LifeOutcomeSchema,
  LifeThreadSchema,
  OutcomeRecordSchema,
  PressureEpisodeSchema,
  ReflectionRecordSchema,
  RelationshipMilestoneSchema,
  SupportInterventionSchema,
  type CharacterSpec,
  type CharacterGoal,
  type CharacterGoalMilestone,
  type DailyLifeContext,
  type DailyLifeIntent,
  type DayPeriod,
  type DecisionRecord,
  type DilemmaEpisode,
  type LifeDomain,
  type LifeOutcome,
  type LifeThread,
  type LifeThreadClock,
  type LifeThreadTimelinePlan,
  type OutcomeRecord,
  type PressureEpisode,
  type ReflectionRecord,
  type RuntimeState,
  type SupportIntervention,
  type SupportMode,
} from "@personasim/contracts";
import {
  projectCharacterTime,
  seededUnit,
  stableId,
} from "@personasim/features";
import { DateTime } from "luxon";

import type { DatabaseStore } from "../db/store.js";
import { buildTimeBasedGoalMilestones } from "../domain/defaults.js";
import { notFound } from "../domain/errors.js";
import {
  LifeThreadRevisionConflictError,
  type LifeRepository,
} from "../repositories/life-repository.js";
import type { Clock } from "../runtime/clock.js";

type DomainEventWrite = Omit<
  Parameters<DatabaseStore["insertDomainEvent"]>[0],
  "streamVersion"
> & {
  streamVersion?: number;
};

interface DailyIntentSeed {
  title: string;
  summary: string;
  domain: LifeDomain;
  period: DayPeriod;
  sourceKind: "goal" | "routine" | "spontaneous";
  importance: number;
  goalRefIds: string[];
  threadIds: string[];
}

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
      context = DailyLifeContextSchema.parse({
        id: stableId("life_day", `${agentId}:${localDate}:${spec.version}`),
        agentId,
        localDate,
        timezone: spec.identity.timezone,
        status: "active",
        currentPeriod: dayPeriod(local.hour),
        availability: availabilityFor(state),
        availabilityConfidence: "inferred",
        theme: threads[0]?.title ?? spec.persona.goals[0]?.title,
        currentFocus: focusForPeriod(intents, dayPeriod(local.hour)),
        todayFocus: intents.map((intent) => intent.title),
        intentIds: intents.map((intent) => intent.id),
        activeThreadIds: threads.map((thread) => thread.id),
        currentPressureEpisodeIds: this.repository
          .listOpenPressures(agentId, 4)
          .map((episode) => episode.id),
        recentOutcomeIds: this.repository
          .listRecentLifeOutcomes(agentId, 4)
          .map((outcome) => outcome.id),
        revision: 1,
        schemaVersion: 1,
        createdAtUtc: atUtc,
        updatedAtUtc: atUtc,
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
    const currentPeriod = dayPeriod(local.hour);
    const availability = availabilityFor(state);
    const currentFocus = focusForPeriod(intents, currentPeriod);
    const activeThreadIds = threads.map((thread) => thread.id);
    const currentPressureEpisodeIds = this.repository
      .listOpenPressures(agentId, 4)
      .map((episode) => episode.id);
    const recentOutcomeIds = this.repository
      .listRecentLifeOutcomes(agentId, 4)
      .map((outcome) => outcome.id);
    const changed =
      context.currentPeriod !== currentPeriod ||
      context.availability !== availability ||
      context.currentFocus !== currentFocus ||
      JSON.stringify(context.activeThreadIds) !==
        JSON.stringify(activeThreadIds) ||
      JSON.stringify(context.currentPressureEpisodeIds) !==
        JSON.stringify(currentPressureEpisodeIds) ||
      JSON.stringify(context.recentOutcomeIds) !==
        JSON.stringify(recentOutcomeIds);
    if (changed) {
      const refreshed = DailyLifeContextSchema.parse({
        ...context,
        currentPeriod,
        availability,
        currentFocus,
        activeThreadIds,
        currentPressureEpisodeIds,
        recentOutcomeIds,
        revision: context.revision + 1,
        updatedAtUtc: atUtc,
      });
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
          const outcomeKind = seededOutcome(intent.id);
          const summary = outcomeSummary(intent.title, outcomeKind);
          const outcome = LifeOutcomeSchema.parse({
            id: stableId("life_outcome", intent.id),
            agentId,
            intentId: intent.id,
            outcomeKind,
            summary,
            outcomeFacts: [summary],
            origin: "simulation",
            threadIds: intent.threadIds,
            sourceEvidenceIds: [evidenceId],
            importance: intent.importance,
            effectiveLocalDate: context.localDate,
            temporalPrecision: "day",
            recordedAtUtc: toUtc,
            idempotencyKey: `life-outcome:${intent.id}`,
            schemaVersion: 1,
          });
          if (this.repository.insertLifeOutcome(outcome)) {
            createdOutcomeIds.push(outcome.id);
          }
          outcomeIds.push(outcome.id);
        }
        this.repository.updateDailyContext(
          DailyLifeContextSchema.parse({
            ...context,
            status: "settled",
            recentOutcomeIds: outcomeIds.slice(0, 8),
            revision: context.revision + 1,
            updatedAtUtc: toUtc,
          }),
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

  promptContext(agentId: string, atUtc = this.clock.nowUtc()): unknown {
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
    return {
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
    };
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
    const spec = this.store.getCharacterSpec(input.agentId);
    if (!spec) throw notFound("Character");
    const local = projectCharacterTime(spec.identity, input.recordedAtUtc);
    const localDate = local.localDate;
    const period = dayPeriod(local.hour);
    const pressureFollowUp = this.applyPressureFollowUp(
      input,
      localDate,
      period,
    );
    const followUpImpact = this.recordDecisionFollowUp(
      input,
      localDate,
      period,
    );
    this.recordCanonicalDilemmaEvidence(input, localDate, period);

    const characterDilemma = this.selectOpenDilemma(
      input.agentId,
      "character",
      `${input.userText} ${input.assistantText}`,
    );
    if (
      characterDilemma !== undefined &&
      isCharacterDilemmaTurn(input.userText, characterDilemma)
    ) {
      const characterImpact = this.recordCharacterDirectedTurn(
        input,
        characterDilemma,
        localDate,
        period,
      );
      return {
        ...followUpImpact,
        ...characterImpact,
        ...(pressureFollowUp.episodeId === undefined
          ? {}
          : { pressureEpisodeId: pressureFollowUp.episodeId }),
      };
    }

    if (isUserOwnedDecision(input.userText)) {
      const dilemma = this.selectOpenDilemma(
        input.agentId,
        "user",
        input.userText,
      );
      if (dilemma !== undefined) {
        const selectedOption = selectDilemmaOption(dilemma, input.userText);
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
          reasoningSummary: input.userText,
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

    const delegated = isDelegatedDecision(input.userText);
    const mode = supportMode(
      input.userText,
      delegated,
      isDilemma(input.userText),
    );
    const explicitSupport = hasExplicitSupportIntent(input.userText);
    const dilemmaLike =
      delegated ||
      isDilemma(input.userText) ||
      (explicitSupport && mode !== "listen_only");
    const pressureLike =
      isPressureDisclosure(input.userText) && !pressureFollowUp.updated;
    const shouldRecordSupport =
      dilemmaLike ||
      pressureLike ||
      explicitSupport ||
      pressureFollowUp.updated;
    if (!shouldRecordSupport) return followUpImpact;

    const domain = inferDomain(input.userText);
    let dilemma = dilemmaLike
      ? this.selectOpenDilemma(input.agentId, "user", input.userText)
      : undefined;
    if (dilemmaLike && dilemma === undefined) {
      dilemma = this.createUserDilemma(input, domain, localDate, period);
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
        triggerSummary: input.userText,
        status: "open",
        initialPressure: parseScaleMetric(input.userText, "pressure") ?? 0.72,
        currentPressure: parseScaleMetric(input.userText, "pressure") ?? 0.72,
        initialClarity:
          parseScaleMetric(input.userText, "clarity") ??
          (dilemmaLike ? 0.3 : 0.45),
        currentClarity:
          parseScaleMetric(input.userText, "clarity") ??
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

    const targetPressureId = this.selectPressureForSupport({
      agentId: input.agentId,
      subject: "user",
      ...(dilemma === undefined ? {} : { dilemma }),
      preferredEpisodeIds: [pressure?.id, pressureFollowUp.episodeId].filter(
        (id): id is string => id !== undefined,
      ),
    })?.id;
    const selectedOption =
      dilemma === undefined
        ? undefined
        : selectDilemmaOption(
            dilemma,
            `${input.assistantText} ${input.userText}`,
          );
    let interventionId: string | undefined;
    if (dilemma !== undefined || targetPressureId !== undefined) {
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
    if (streamId !== undefined) {
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
    const actionEvidence = isActionEvidence(input.userText);
    const outcomeEvidence = isOutcomeEvidence(input.userText);
    const userReflectionEvidence = isReflectionEvidence(input.userText);
    const characterReflectionRequest = isCharacterReflectionRequest(
      input.userText,
    );
    if (
      !actionEvidence &&
      !outcomeEvidence &&
      !userReflectionEvidence &&
      !characterReflectionRequest
    ) {
      return {};
    }
    const decision = this.selectDecisionForEvidence(
      input.agentId,
      input.sessionId,
      input.userText,
      characterReflectionRequest,
      outcomeEvidence
        ? "outcome"
        : userReflectionEvidence || characterReflectionRequest
          ? "reflection"
          : "action",
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
      !(actionsBeforeTurn.length > 0 && isActionRestatement(input.userText))
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
            decision.subject === "user"
              ? "user"
              : decision.subject === "character"
                ? "character"
                : "joint",
          actionKind: inferActionKind(input.userText),
          summary: input.userText,
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
            : hasMixedCausation(input.userText)
              ? "mixed"
              : "action",
        valence: inferOutcomeValence(input.userText),
        summary: input.userText,
        consequenceFacts: [input.userText],
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
          : input.userText;
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
        stanceTowardDecision: reflectionStance(reflectionText),
        changedInterpretation: /后悔|改主意|不是.*想的|重新/u.test(
          reflectionText,
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
              : input.userText,
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

  private createUserDilemma(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    domain: LifeDomain,
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
  ): DilemmaEpisode {
    const selected = extractSelectedDirection(input.assistantText);
    const dilemmaId = stableId(
      "dilemma",
      `${input.sessionId}:${input.userMessageId}`,
    );
    const dilemma = DilemmaEpisodeSchema.parse({
      id: dilemmaId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      subject: "user",
      title: shortTitle(input.userText),
      summary: input.userText,
      domain,
      options: [
        {
          id: stableId("option", `${dilemmaId}:change`),
          label: selected,
          description: `按照本轮讨论形成的方向：${selected}`,
          likelyTradeoffs: ["会带来改变，也需要承担相应的不确定性"],
          valuesAtStake: inferValues(input.userText),
        },
        {
          id: stableId("option", `${dilemmaId}:status-quo`),
          label: "暂时维持现状",
          description: "保留当前路径，继续观察后再决定。",
          likelyTradeoffs: ["短期更稳定，但原有压力或疑问可能继续存在"],
          valuesAtStake: inferValues(input.userText),
        },
      ],
      status: "open",
      sourceMessageIds: [input.userMessageId],
      effectiveLocalDate: localDate,
      effectivePeriod: period,
      temporalPrecision: "period",
      recordedAtUtc: input.recordedAtUtc,
      updatedAtUtc: input.recordedAtUtc,
      idempotencyKey: `dilemma:${input.sessionId}:${input.userMessageId}`,
      schemaVersion: 1,
    });
    this.repository.insertDilemma(dilemma);
    return dilemma;
  }

  private recordCanonicalDilemmaEvidence(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
  ): void {
    const optionMatch = input.userText.match(
      /选项\s*([AB])\s*是\s*([^。！？!\n]+)/u,
    );
    const isContextEvidence =
      /生活储备|父母.{0,16}(?:负担|担心)|价值排序|长期失去创作能力|许宁觉得|母亲觉得|更正.{0,20}山鸣影像.{0,20}(?:期限|回复)/u.test(
        input.userText,
      );
    if (optionMatch === null && !isContextEvidence) return;

    let dilemma = this.selectOpenDilemma(input.agentId, "user", input.userText);
    if (dilemma === undefined) {
      dilemma = this.createUserDilemma(
        input,
        inferDomain(input.userText),
        localDate,
        period,
      );
    }

    const nextOptions = [...dilemma.options];
    if (optionMatch?.[1] !== undefined && optionMatch[2] !== undefined) {
      const optionIndex = optionMatch[1] === "A" ? 0 : 1;
      const current = nextOptions[optionIndex]!;
      nextOptions[optionIndex] = {
        ...current,
        label: optionMatch[2].trim().slice(0, 160),
        description: input.userText,
        likelyTradeoffs: extractTradeoffFacts(input.userText),
        valuesAtStake: inferValues(input.userText),
      };
    } else if (/更正.{0,20}山鸣影像/u.test(input.userText)) {
      const current = nextOptions[1]!;
      const correctedDescription = current.description
        .replace(/9\s*月\s*14\s*日/gu, "9 月 16 日")
        .replace(/9月14日/gu, "9月16日");
      nextOptions[1] = {
        ...current,
        description: `${correctedDescription} 最新期限以本轮更正为准：9 月 16 日。`,
      };
    }

    const updated = DilemmaEpisodeSchema.parse({
      ...dilemma,
      summary: `${dilemma.summary}\n证据补充：${input.userText}`,
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
        optionMatch === null
          ? "life.dilemma_context_evidenced"
          : "life.dilemma_option_evidenced",
      recordedAtUtc: input.recordedAtUtc,
      effectiveAtUtc: input.recordedAtUtc,
      payload: {
        dilemmaId: dilemma.id,
        optionKey: optionMatch?.[1],
        evidenceMessageId: input.userMessageId,
        correction: /更正/u.test(input.userText),
      },
      correlationId: input.correlationId,
      causationId: input.userMessageId,
      idempotencyKey: `dilemma-evidence:${dilemma.id}:${input.userMessageId}`,
    });
  }

  private recordCharacterDirectedTurn(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
    dilemma: DilemmaEpisode,
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
  ): ConversationLifeImpact {
    const wantsOwnDecision = isCharacterSubjectDecisionRequest(input.userText);
    const offersSupport =
      wantsOwnDecision || isUserAdviceToCharacter(input.userText);
    if (!offersSupport) return { dilemmaId: dilemma.id };

    const mode: SupportMode = wantsOwnDecision
      ? "deliberate"
      : userToCharacterSupportMode(input.userText);
    const selectedOption = selectDilemmaOption(
      dilemma,
      `${input.userText} ${input.assistantText}`,
    );
    const pressureEpisodeId = this.repository
      .listOpenPressures(input.agentId, 12)
      .find(
        (episode) =>
          episode.subject === "character" && episode.dilemmaId === dilemma.id,
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
        dilemmaId: dilemma.id,
        ...(pressureEpisodeId === undefined ? {} : { pressureEpisodeId }),
        mode,
        offeredBy: "user",
        receivedBy: "character",
        summary: input.userText,
        intendedEffect: supportIntendedEffect(mode, "character"),
        ...(mode === "recommend"
          ? { recommendationOptionId: selectedOption.id }
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

    if (!wantsOwnDecision) {
      return {
        dilemmaId: dilemma.id,
        ...(pressureEpisodeId === undefined ? {} : { pressureEpisodeId }),
        interventionId,
      };
    }

    const decisionOption = selectDilemmaOption(dilemma, input.assistantText);
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
    agentId: string,
    subject: DilemmaEpisode["subject"],
    evidenceText: string,
  ): DilemmaEpisode | undefined {
    const candidates = this.repository
      .listOpenDilemmas(agentId, 32)
      .filter((episode) => episode.subject === subject);
    if (candidates.length <= 1) return candidates[0];
    return [...candidates].sort(
      (left, right) =>
        dilemmaRelevance(right, evidenceText) -
        dilemmaRelevance(left, evidenceText),
    )[0];
  }

  private selectDecisionForEvidence(
    agentId: string,
    sessionId: string,
    evidenceText: string,
    preferCharacter: boolean,
    stage: "action" | "outcome" | "reflection",
  ): DecisionRecord | undefined {
    const decisions = this.repository.listCurrentDecisions(agentId, 32);
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
      return row === undefined ? [] : [row.content];
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
      return (
        row !== undefined &&
        (parseScaleMetric(row.content, "pressure") !== undefined ||
          parseScaleMetric(row.content, "clarity") !== undefined)
      );
    });
  }

  private selectContinuingUserPressure(
    input: Parameters<FuzzyLifeService["recordConversationTurn"]>[0],
  ): PressureEpisode | undefined {
    const candidates = this.repository
      .listOpenPressures(input.agentId, 24)
      .filter((episode) => episode.subject === "user");
    if (candidates.length === 0) return undefined;

    if (isPressureTrajectoryContinuation(input.userText)) {
      return candidates[0];
    }

    const sameSession = candidates.filter(
      (episode) => episode.sessionId === input.sessionId,
    );
    const pool = sameSession.length > 0 ? sameSession : candidates;
    const inferredKind = pressureKind(inferDomain(input.userText));
    const exactKind = pool.find(
      (episode) => episode.pressureKind === inferredKind,
    );
    if (exactKind !== undefined) return exactKind;

    if (
      inferredKind === "identity" &&
      isIdentityFacetOfLifeChoice(input.userText)
    ) {
      return pool.find((episode) =>
        ["work", "decision", "identity"].includes(episode.pressureKind),
      );
    }

    const hasExplicitScale =
      parseScaleMetric(input.userText, "pressure") !== undefined ||
      parseScaleMetric(input.userText, "clarity") !== undefined;
    if (hasExplicitScale && sameSession.length > 0) return sameSession[0];
    if (sameSession.length > 0 && isPressureFeedbackText(input.userText)) {
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
    localDate: string,
    period: Exclude<DayPeriod, "anytime">,
  ): PressureFollowUpResult {
    const explicitPressure = parseScaleMetric(input.userText, "pressure");
    const explicitClarity = parseScaleMetric(input.userText, "clarity");
    const improvingLanguage =
      /好多了|轻松多了|没那么(?:焦虑|难受|乱)|想清楚了|清楚多了|被理解|谢谢你.*(?:听|陪)/u.test(
        input.userText,
      );
    const worseningLanguage =
      /更焦虑|更难受|更糟|还是很乱|完全没用|压力更大/u.test(input.userText);
    const feltUnderstoodPositive =
      /被(?:你)?听见|被理解|谢谢你.*(?:听|陪)|你听懂了/u.test(input.userText);
    const feltUnderstoodNegative =
      /没(?:有)?被(?:听见|理解)|你没听懂|完全没听进去/u.test(input.userText);
    const episode = this.selectContinuingUserPressure(input);
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
        isPressureDisclosure(input.userText) &&
        isPressureTrajectoryContinuation(input.userText)
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
        input.userText,
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
        input.userText,
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

function linkPressureOutcomeEvidence(
  episode: PressureEpisode,
  outcome: OutcomeRecord,
  updatedAtUtc: string,
): PressureEpisode {
  const sourceMessageIds = [
    ...new Set([...episode.sourceMessageIds, ...outcome.sourceEvidenceIds]),
  ];
  return PressureEpisodeSchema.parse({
    ...episode,
    outcomeIds: [...new Set([...episode.outcomeIds, outcome.id])],
    sourceMessageIds,
    latestEvidenceMessageId:
      outcome.sourceEvidenceIds.at(-1) ?? episode.latestEvidenceMessageId,
    effectiveLocalDate: outcome.effectiveLocalDate,
    ...(outcome.effectivePeriod === undefined
      ? { effectivePeriod: undefined, temporalPrecision: "day" as const }
      : {
          effectivePeriod: outcome.effectivePeriod,
          temporalPrecision: "period" as const,
        }),
    updatedAtUtc,
  });
}

function progressPressureFromOutcome(
  episode: PressureEpisode,
  outcome: OutcomeRecord,
  updatedAtUtc: string,
): PressureEpisode {
  const transition =
    episode.status === "resolved"
      ? { pressure: 0, clarity: 0, status: "resolved" as const }
      : outcomePressureTransition(outcome.valence);
  const sourceMessageIds = [
    ...new Set([...episode.sourceMessageIds, ...outcome.sourceEvidenceIds]),
  ];
  const latestEvidenceMessageId =
    outcome.sourceEvidenceIds.at(-1) ?? episode.latestEvidenceMessageId;
  return PressureEpisodeSchema.parse({
    ...episode,
    status: transition.status,
    currentPressure: clamp01(episode.currentPressure + transition.pressure),
    currentClarity: clamp01(episode.currentClarity + transition.clarity),
    outcomeIds: [...new Set([...episode.outcomeIds, outcome.id])],
    sourceMessageIds,
    latestEvidenceMessageId,
    effectiveLocalDate: outcome.effectiveLocalDate,
    ...(outcome.effectivePeriod === undefined
      ? { effectivePeriod: undefined, temporalPrecision: "day" as const }
      : {
          effectivePeriod: outcome.effectivePeriod,
          temporalPrecision: "period" as const,
        }),
    updatedAtUtc,
  });
}

function progressPressureFromReflection(
  episode: PressureEpisode,
  reflection: ReflectionRecord,
  updatedAtUtc: string,
): PressureEpisode {
  const closesCompletedChain =
    reflection.outcomeId !== undefined &&
    episode.outcomeIds.includes(reflection.outcomeId) &&
    (reflection.stanceTowardDecision === "affirm" ||
      reflection.stanceTowardDecision === "mixed");
  const transition =
    episode.status === "resolved"
      ? { pressure: 0, clarity: 0, status: "resolved" as const }
      : closesCompletedChain
        ? { pressure: -0.06, clarity: 0.12, status: "resolved" as const }
        : reflectionPressureTransition(
            reflection.stanceTowardDecision,
            episode.status,
          );
  const sourceMessageIds = [
    ...new Set([...episode.sourceMessageIds, ...reflection.sourceMessageIds]),
  ];
  const latestEvidenceMessageId =
    reflection.sourceMessageIds.at(-1) ?? episode.latestEvidenceMessageId;
  return PressureEpisodeSchema.parse({
    ...episode,
    status: transition.status,
    currentPressure: clamp01(episode.currentPressure + transition.pressure),
    currentClarity: clamp01(episode.currentClarity + transition.clarity),
    sourceMessageIds,
    latestEvidenceMessageId,
    ...(transition.status === "resolved"
      ? {
          resolutionEvidenceMessageId:
            latestEvidenceMessageId ?? episode.resolutionEvidenceMessageId,
        }
      : { resolutionEvidenceMessageId: undefined }),
    effectiveLocalDate: reflection.effectiveLocalDate,
    ...(reflection.effectivePeriod === undefined
      ? { effectivePeriod: undefined, temporalPrecision: "day" as const }
      : {
          effectivePeriod: reflection.effectivePeriod,
          temporalPrecision: "period" as const,
        }),
    updatedAtUtc,
  });
}

function outcomePressureTransition(valence: OutcomeRecord["valence"]): {
  pressure: number;
  clarity: number;
  status: Exclude<PressureEpisode["status"], "open" | "resolved">;
} {
  switch (valence) {
    case "positive":
      return { pressure: -0.12, clarity: 0.14, status: "improving" };
    case "negative":
      return { pressure: 0.1, clarity: 0.08, status: "worsening" };
    case "mixed":
      return { pressure: -0.04, clarity: 0.12, status: "improving" };
    case "neutral":
      return { pressure: -0.02, clarity: 0.08, status: "improving" };
  }
}

function reflectionPressureTransition(
  stance: ReflectionRecord["stanceTowardDecision"],
  currentStatus: PressureEpisode["status"],
): {
  pressure: number;
  clarity: number;
  status: PressureEpisode["status"];
} {
  switch (stance) {
    case "affirm":
      return { pressure: -0.06, clarity: 0.12, status: "improving" };
    case "mixed":
      return { pressure: -0.03, clarity: 0.1, status: "improving" };
    case "question":
      return { pressure: 0.02, clarity: 0.06, status: "worsening" };
    case "reverse":
      return { pressure: 0.06, clarity: 0.08, status: "worsening" };
    case "unclear":
      return { pressure: 0, clarity: 0.05, status: currentStatus };
  }
}

function pressureLifecycleSnapshot(episode: PressureEpisode): {
  status: PressureEpisode["status"];
  pressure: number;
  clarity: number;
  feltUnderstood: number;
  outcomeIds: string[];
  latestEvidenceMessageId: string;
} {
  return {
    status: episode.status,
    pressure: episode.currentPressure,
    clarity: episode.currentClarity,
    feltUnderstood: episode.currentFeltUnderstood,
    outcomeIds: episode.outcomeIds,
    latestEvidenceMessageId: episode.latestEvidenceMessageId,
  };
}

function timeMilestonesForGoal(goal: CharacterGoal): CharacterGoalMilestone[] {
  return goal.milestones ?? buildTimeBasedGoalMilestones(goal.id, goal.title);
}

function freezeTimelinePlan(
  spec: CharacterSpec,
  goal: CharacterGoal,
  anchorUtc: string,
): LifeThreadTimelinePlan {
  const milestones = structuredClone(timeMilestonesForGoal(goal));
  const timeBasis = timelineClockForCharacter(spec, anchorUtc);
  const origin: LifeThreadTimelinePlan["origin"] =
    goal.milestones === undefined ? "legacy_fallback_v1" : "character_spec";
  const unsigned: Omit<LifeThreadTimelinePlan, "planSha256"> = {
    schemaVersion: 1 as const,
    sourceGoalId: goal.id,
    sourceCharacterVersion: spec.version,
    origin,
    timeBasis,
    milestones,
  };
  return {
    ...unsigned,
    planSha256: hashTimelinePlan(unsigned),
  };
}

function timelineClockForCharacter(
  spec: CharacterSpec,
  fallbackSystemAnchorUtc: string,
): LifeThreadClock {
  const frame = spec.identity.temporalFrame;
  if (frame?.mode !== "anchored_story") {
    return { mode: "realtime", timezone: spec.identity.timezone };
  }
  return {
    mode: "anchored_story",
    timezone: spec.identity.timezone,
    storyAnchorLocalDate: frame.storyAnchorLocalDate,
    systemAnchorUtc: frame.systemAnchorUtc ?? fallbackSystemAnchorUtc,
  };
}

function timelineLocalDate(clock: LifeThreadClock, atUtc: string): string {
  const identity =
    clock.mode === "realtime"
      ? { timezone: clock.timezone }
      : {
          timezone: clock.timezone,
          temporalFrame: {
            mode: "anchored_story" as const,
            eraLabel: "frozen life-thread story clock",
            storyAnchorLocalDate: clock.storyAnchorLocalDate,
            systemAnchorUtc: clock.systemAnchorUtc,
          },
        };
  return projectCharacterTime(identity, atUtc).localDate;
}

function hashTimelinePlan(
  value: Omit<LifeThreadTimelinePlan, "planSha256">,
): string {
  const canonical = {
    schemaVersion: value.schemaVersion,
    sourceGoalId: value.sourceGoalId,
    sourceCharacterVersion: value.sourceCharacterVersion,
    origin: value.origin,
    timeBasis: value.timeBasis,
    milestones: value.milestones,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function assertTimelinePlanHash(plan: LifeThreadTimelinePlan): void {
  const unsigned = {
    schemaVersion: plan.schemaVersion,
    sourceGoalId: plan.sourceGoalId,
    sourceCharacterVersion: plan.sourceCharacterVersion,
    origin: plan.origin,
    timeBasis: plan.timeBasis,
    milestones: plan.milestones,
  };
  if (hashTimelinePlan(unsigned) !== plan.planSha256) {
    throw new Error(
      `Life-thread timeline plan hash mismatch for goal ${plan.sourceGoalId}`,
    );
  }
}

function resolveLegacyTimelinePlan(
  store: DatabaseStore,
  thread: LifeThread,
): { plan: LifeThreadTimelinePlan; persistedIndex: number } {
  const candidates = store
    .listCharacterVersions(thread.agentId)
    .flatMap(({ spec }) =>
      spec.persona.goals.flatMap((goal) =>
        `life-thread:${thread.agentId}:goal:${goal.id}` ===
        thread.idempotencyKey
          ? [{ spec, goal }]
          : [],
      ),
    )
    .filter(({ spec, goal }) => {
      const plan = freezeTimelinePlan(spec, goal, thread.createdAtUtc);
      return (
        timelineLocalDate(plan.timeBasis, thread.createdAtUtc) ===
        thread.startedLocalDate
      );
    });
  const createdBefore = candidates.filter(
    ({ spec }) =>
      Date.parse(spec.createdAtUtc) <= Date.parse(thread.createdAtUtc),
  );
  const selected = (createdBefore.length > 0 ? createdBefore : candidates)[0];
  if (selected === undefined) {
    throw new Error(
      `Cannot resolve a frozen source plan for legacy life thread ${thread.id}`,
    );
  }
  const plan = freezeTimelinePlan(
    selected.spec,
    selected.goal,
    thread.createdAtUtc,
  );
  const titleMatches = plan.milestones
    .map((milestone, index) =>
      milestone.title === thread.currentStage ? index : -1,
    )
    .filter((index) => index >= 0);
  return {
    plan,
    persistedIndex: titleMatches.length === 1 ? titleMatches[0]! : 0,
  };
}

function localCalendarDayDifference(
  fromLocalDate: string,
  toLocalDate: string,
) {
  const from = DateTime.fromISO(fromLocalDate, { zone: "UTC" }).startOf("day");
  const to = DateTime.fromISO(toLocalDate, { zone: "UTC" }).startOf("day");
  return Math.trunc(to.diff(from, "days").days);
}

function milestoneIndexAt(
  milestones: CharacterGoalMilestone[],
  elapsedDays: number,
): number {
  let index = 0;
  for (let candidate = 1; candidate < milestones.length; candidate += 1) {
    if (milestones[candidate]!.afterDays > elapsedDays) break;
    index = candidate;
  }
  return index;
}

function milestoneEffectiveLocalDate(
  startedLocalDate: string,
  afterDays: number,
): string {
  return DateTime.fromISO(startedLocalDate, { zone: "UTC" })
    .plus({ days: afterDays })
    .toISODate()!;
}

function milestoneNextStep(
  milestone: CharacterGoalMilestone,
  next: CharacterGoalMilestone | undefined,
): string {
  const text =
    milestone.nextStepHint ??
    (next === undefined
      ? `继续维持并复盘“${milestone.title}”阶段。`
      : `为之后进入“${next.title}”阶段保留可持续的准备。`);
  return text.slice(0, 240);
}

function buildDailyIntents(
  spec: CharacterSpec,
  threads: LifeThread[],
  localDate: string,
  atUtc: string,
): DailyLifeIntent[] {
  const contextId = stableId(
    "life_day",
    `${spec.id}:${localDate}:${spec.version}`,
  );
  const goalIntents: DailyIntentSeed[] = spec.persona.goals
    .slice(0, 3)
    .map((goal, index) => ({
      title: goal.title,
      summary: `今天为“${goal.title}”推进一个有意义但不要求精确钟点的步骤。`,
      domain: inferDomain(`${goal.title} ${goal.description}`),
      period: (["morning", "afternoon", "evening"] as const)[index % 3]!,
      sourceKind: "goal" as const,
      importance: Math.max(0.45, goal.priority),
      goalRefIds: [goal.id],
      threadIds: threads
        .filter(
          (thread) =>
            thread.timelinePlan?.sourceGoalId === goal.id ||
            (thread.timelinePlan === undefined && thread.title === goal.title),
        )
        .map((thread) => thread.id),
    }));
  const routineIntents: DailyIntentSeed[] = spec.routines
    .filter(
      (routine) =>
        routine.category !== "sleep" &&
        routine.category !== "meal" &&
        !spec.persona.goals.some((goal) => goal.title === routine.title),
    )
    .slice(0, Math.max(0, 4 - goalIntents.length))
    .map((routine) => ({
      title: routine.title,
      summary: `按自己的生活节奏处理“${routine.title}”，不声明精确开始或结束时间。`,
      domain: routineDomain(routine.category),
      period: periodFromClock(routine.preferredStartLocal),
      sourceKind: "routine" as const,
      importance: routine.priority,
      goalRefIds: [],
      threadIds: [],
    }));
  const bases = [...goalIntents, ...routineIntents].slice(0, 6);
  if (bases.length === 0) {
    bases.push({
      title: "照顾今天的生活状态",
      summary: "根据精力和压力决定今天值得投入的一件小事。",
      domain: "self_reflection",
      period: "anytime",
      sourceKind: "spontaneous",
      importance: 0.5,
      goalRefIds: [],
      threadIds: [],
    });
  }
  return bases.map((base, index) =>
    DailyLifeIntentSchema.parse({
      id: stableId("life_intent", `${contextId}:${index}:${base.title}`),
      agentId: spec.id,
      contextId,
      localDate,
      title: base.title,
      summary: base.summary,
      domain: base.domain,
      period: base.period,
      durationBand: index === 0 ? "most_of_period" : "part_of_period",
      commitmentLevel: index === 0 ? "priority" : "optional",
      status: "intended",
      sourceKind: base.sourceKind,
      shareable: base.importance >= 0.65,
      importance: clamp01(base.importance),
      threadIds: base.threadIds,
      goalRefIds: base.goalRefIds,
      evidenceMessageIds: [],
      idempotencyKey: `life-intent:${contextId}:${index}`,
      revision: 1,
      schemaVersion: 1,
      createdAtUtc: atUtc,
      updatedAtUtc: atUtc,
    }),
  );
}

function dayPeriod(hour: number): Exclude<DayPeriod, "anytime"> {
  if (hour < 6) return "early_morning";
  if (hour < 11) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 23) return "evening";
  return "late_night";
}

function periodFromClock(value: string): DayPeriod {
  const hour = Number(value.slice(0, 2));
  return Number.isFinite(hour) ? dayPeriod(hour) : "anytime";
}

function availabilityFor(
  state: RuntimeState,
): "free" | "interruptible" | "occupied" {
  if (state.stress > 0.78 || (state.focus > 0.8 && state.energy < 0.4)) {
    return "occupied";
  }
  if (state.focus > 0.58 || state.socialBattery < 0.35) return "interruptible";
  return "free";
}

function focusForPeriod(
  intents: readonly DailyLifeIntent[],
  period: Exclude<DayPeriod, "anytime">,
): string | undefined {
  return (
    intents.find((intent) => intent.period === period)?.title ??
    intents.find((intent) => intent.period === "anytime")?.title ??
    intents[0]?.title
  );
}

function seededOutcome(intentId: string): LifeOutcome["outcomeKind"] {
  const roll = seededUnit(`${intentId}:fuzzy-life-outcome`);
  if (roll < 0.62) return "completed";
  if (roll < 0.8) return "partial";
  if (roll < 0.92) return "deferred";
  return "skipped";
}

function outcomeSummary(
  title: string,
  kind: LifeOutcome["outcomeKind"],
): string {
  if (kind === "completed") return `完成了“${title}”中今天想推进的部分。`;
  if (kind === "partial") return `“${title}”有了一些进展，但还没有完全处理完。`;
  if (kind === "deferred") return `“${title}”今天没有展开，决定以后再继续。`;
  if (kind === "cancelled") return `取消了今天关于“${title}”的打算。`;
  return `今天没有继续“${title}”。`;
}

function isDelegatedDecision(text: string): boolean {
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

function isDilemma(text: string): boolean {
  return /要不要|该不该|怎么选|选哪个|怎么办|是否应该|拿不定主意|很犹豫|还没决定|难以决定|做(?:不出|不了)决定|面临.{0,8}(?:决定|选择)/u.test(
    text,
  );
}

function isRecommendationRequest(text: string): boolean {
  return /(?:请|直接|只|给我).{0,10}推荐|给我.{0,8}(?:明确)?建议|你觉得|你会怎么做|帮我分析|替我分析/u.test(
    text,
  );
}

function isPressureDisclosure(text: string): boolean {
  return /焦虑|压力|清晰度|难受|低落|撑不住|烦躁|崩溃|害怕|我又怕|失眠|反复想|很乱|不知所措|累坏|一直.{0,6}压着|压得.{0,8}(?:喘不过气|难受)|肩膀.{0,8}绷/u.test(
    text,
  );
}

function isPressureTrajectoryContinuation(text: string): boolean {
  return /最难受|每天.{0,12}不相信|我又怕|十年后.{0,16}没试过|这(?:次|个|条).{0,10}(?:选择|决定|结果|压力)|这个结果|结果出现后|压力(?:大概|大约|差不多|还是|是|到|降到|升到)?\s*\d|清晰度(?:大概|大约|差不多|还是|是|到|降到|升到)?\s*\d|梳理完这些|清楚了不代表轻松|能接受.{0,8}代价|真正改变我的/u.test(
    text,
  );
}

function isIdentityFacetOfLifeChoice(text: string): boolean {
  return /工作|职业|创作|收入|合同|搬家|选择|决定|结果|长期|十年后|害怕|不相信|意义|代价/u.test(
    text,
  );
}

function isPressureFeedbackText(text: string): boolean {
  return /好多了|轻松多了|没那么(?:焦虑|难受|乱)|想清楚了|清楚多了|被(?:你)?听见|被理解|谢谢你.*(?:听|陪)|更焦虑|更难受|更糟|还是很乱|完全没用|压力更大|没(?:有)?被(?:听见|理解)/u.test(
    text,
  );
}

function hasExplicitSupportIntent(text: string): boolean {
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

function supportMode(
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

function userToCharacterSupportMode(text: string): SupportMode {
  if (/如果是我|我的建议|建议你|我会优先|我会选择|我会选/u.test(text)) {
    return "recommend";
  }
  return "deliberate";
}

function supportIntendedEffect(
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

function decisionSupportDirection(
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

function isUserOwnedDecision(text: string): boolean {
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

function isCharacterSubjectDecisionRequest(text: string): boolean {
  return /你现在愿意.{0,20}(?:选一个方向|作决定)|请按你自己的价值作决定|由你自己.{0,8}(?:决定|选择)|你愿意为.{0,16}(?:决定|选)/u.test(
    text,
  );
}

function isUserAdviceToCharacter(text: string): boolean {
  return /如果是我|我的建议|这是我的建议|建议你|我会优先|我会选择|我会选|你可以接受|部分接受|拒绝/u.test(
    text,
  );
}

function isCharacterDilemmaTurn(
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

function isCharacterReflectionRequest(text: string): boolean {
  return /你现在怎么看自己的选择|你现在怎么看.{0,8}(?:决定|选择)|回头看.{0,12}你.{0,8}(?:决定|选择)|你如何理解自己的选择/u.test(
    text,
  );
}

function parseScaleMetric(
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

function selectDilemmaOption(
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

function dilemmaRelevance(
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

function decisionRelevance(
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
    decision.subject === "character" &&
    /你|你的|顾澜|《夜航》/u.test(evidenceText)
      ? 8
      : decision.subject === "user" && /我|我的/u.test(evidenceText)
        ? 4
        : 0;
  return selectionScore + dilemmaScore + subjectBonus;
}

const DECISION_EVIDENCE_RELEVANCE_THRESHOLD = 12;
const REFLECTION_CONTINUITY_RELEVANCE_THRESHOLD = 8;
const PRESSURE_DILEMMA_RELEVANCE_THRESHOLD = 12;
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
  ["搬家", "换个地方", "上海", "杭州"],
  ["关系", "伴侣", "分手", "朋友", "家人"],
  ["健康", "睡眠", "生病", "身体"],
  ["学习", "考试", "课程", "学校"],
] as const;

function decisionEvidenceSemanticRelevance(
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

function decisionStagePredecessorRelevance(
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

function reflectionContinuityRelevance(
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

function reflectionSubjectMatches(
  decision: DecisionRecord,
  evidenceText: string,
  preferCharacter: boolean,
): boolean {
  if (preferCharacter) return decision.subject === "character";
  if (/我|我的|我们/u.test(evidenceText)) return decision.subject === "user";
  return decision.subject !== "character";
}

function pressureDilemmaSemanticRelevance(
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

function hasExplicitCausalStageReference(
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

function exactlyOne<T>(values: readonly T[]): T | undefined {
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

function extractSelectedDirection(text: string): string {
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

function shortTitle(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 80);
}

function inferValues(text: string): string[] {
  const values: string[] = [];
  if (/稳定|收入|工作|辞职|转行/u.test(text)) values.push("稳定与成长");
  if (/家人|伴侣|关系|分手|朋友/u.test(text)) values.push("关系与自我尊重");
  if (/梦想|喜欢|热爱|创作/u.test(text)) values.push("意义与自我实现");
  if (/累|健康|休息|压力/u.test(text)) values.push("健康与可持续性");
  return values.length === 0 ? ["当前安稳与未来可能性"] : values;
}

function extractTradeoffFacts(text: string): string[] {
  const facts = text
    .split(/[；;。]/u)
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.length > 0 &&
        /但|低一些|不稳定|合同|搬家|麻木|担心|代价|风险/u.test(part),
    )
    .map((part) => part.slice(0, 240));
  return facts.length === 0
    ? ["这个方向同时包含收益、不确定性与需要承担的代价"]
    : facts.slice(0, 12);
}

function inferDomain(text: string): LifeDomain {
  if (/工作|职业|辞职|转行|项目|公司/u.test(text)) return "work";
  if (/学习|考试|课程|学校|毕业/u.test(text)) return "study";
  if (/创作|剪辑|片子|写作|画/u.test(text)) return "creative";
  if (/关系|分手|伴侣|朋友|家人/u.test(text)) return "relationship";
  if (/健康|生病|身体|睡眠/u.test(text)) return "health";
  if (/休息|放松|累/u.test(text)) return "rest";
  if (/我是谁|身份|意义|人生/u.test(text)) return "identity";
  return "self_reflection";
}

function routineDomain(category: string): LifeDomain {
  if (category === "work") return "work";
  if (category === "study") return "study";
  if (category === "exercise") return "health";
  if (category === "social") return "social";
  if (category === "errand") return "errand";
  if (category === "leisure") return "leisure";
  if (category === "self_care") return "rest";
  return "other";
}

function pressureKind(domain: LifeDomain): PressureEpisode["pressureKind"] {
  if (domain === "work" || domain === "study" || domain === "creative")
    return "work";
  if (domain === "relationship" || domain === "social") return "relationship";
  if (domain === "identity" || domain === "self_reflection") return "identity";
  if (domain === "health" || domain === "rest") return "health";
  return "decision";
}

function compactLifePromptText(text: string, maximum = 600): string {
  const compact = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return compact.length <= maximum
    ? compact
    : `${compact.slice(0, maximum - 1)}…`;
}

function isActionEvidence(text: string): boolean {
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

function isActionRestatement(text: string): boolean {
  return /(?:同一封)?邮件已经发出|同一封邮件|不要把.{0,12}(?:算成|记成).{0,8}(?:两次|重复)|连接重试|重复发送|这仍是同一个行动|只是重述.{0,8}行动|实际情况.{0,32}(?:自己|由我).{0,12}(?:执行|行动)|之后也是我自己执行/u.test(
    text,
  );
}

function inferActionKind(
  text: string,
): "initiated" | "advanced" | "completed" | "abandoned" {
  if (/完成|办完|做完|结束|落实/u.test(text)) return "completed";
  if (/取消|放弃|没再继续|停下/u.test(text)) return "abandoned";
  if (/继续|推进|又做|第二步/u.test(text)) return "advanced";
  return "initiated";
}

function isOutcomeEvidence(text: string): boolean {
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

function hasMixedCausation(text: string): boolean {
  return /混合原因|既有.{0,12}行动.{0,16}也有.{0,12}外部|外部因素|同时.{0,20}(?:资金|政策|市场|公司另行)/u.test(
    text,
  );
}

function inferOutcomeValence(
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

function isReflectionEvidence(text: string): boolean {
  if (/有没有改变你|请.{0,8}(?:回顾|总结|区分)|你现在怎么看/u.test(text)) {
    return false;
  }
  return /回头看|现在想想|我觉得这个决定|我对这个选择|我后悔|我很庆幸|我才明白|我想明白|我(?:现在)?的理解是|重新想/u.test(
    text,
  );
}

function reflectionLesson(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}…`;
}

function reflectionStance(
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
