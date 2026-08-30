import type {
  ActionRecord,
  DailyLifeContext,
  DecisionRecord,
  DilemmaEpisode,
  OutcomeRecord,
  PressureEpisode,
  ReflectionRecord,
  RelationshipMilestone,
  SupportIntervention,
} from "@personasim/contracts";

/**
 * Pure, runner-agnostic hard gates for the fuzzy-life v3 long run.
 *
 * The runner owns database reads. It projects the relevant durable rows into
 * `CompanionLongRunV3Snapshot` before and after a candidate turn, then passes
 * the snapshots and the turn-specific expectation to this module. No function
 * below reads the filesystem, environment, clock, database, or provider.
 */

export const COMPANION_LONG_RUN_V3_HARD_GATE_CODES = [
  "daily_context_unique",
  "no_schedule_growth",
  "causal_stage_separated",
  "delegated_decision_authorized",
  "pressure_change_evidence_bound",
  "idempotent_replay",
  "branch_isolated",
  "prompt_excludes_future_schedule",
  "prompt_includes_life_context",
] as const;

export type CompanionLongRunV3HardGateCode =
  (typeof COMPANION_LONG_RUN_V3_HARD_GATE_CODES)[number];

export interface CompanionLongRunV3HardGateResult {
  code: CompanionLongRunV3HardGateCode;
  status: "PASS" | "FAIL" | "SKIPPED";
  summary: string;
  expected?: unknown;
  actual?: unknown;
}

export interface CompanionLongRunV3ScheduleRow {
  id: string;
}

/**
 * Complete (not tail-truncated) durable projection used by hard gates.
 * `durableSha256` must cover every durable table that a replay is forbidden
 * to mutate, including messages, memories, causal records, and domain events.
 */
export interface CompanionLongRunV3Snapshot {
  durableSha256: string;
  dailyContexts: readonly DailyLifeContext[];
  scheduleItems: readonly CompanionLongRunV3ScheduleRow[];
  dilemmas: readonly DilemmaEpisode[];
  supportInterventions: readonly SupportIntervention[];
  decisions: readonly DecisionRecord[];
  actions: readonly ActionRecord[];
  outcomes: readonly OutcomeRecord[];
  reflections: readonly ReflectionRecord[];
  pressureEpisodes: readonly PressureEpisode[];
  relationshipMilestones: readonly RelationshipMilestone[];
  /** Complete source projections used to prove every causal evidence id exists. */
  messages: readonly unknown[];
  activityEvents: readonly unknown[];
  domainEvents: readonly unknown[];
}

export interface CompanionLongRunV3PromptCall {
  purpose: string;
  system: string;
  prompt: string;
  /**
   * Set this explicitly for a renamed primary chat purpose. When omitted,
   * `purpose === "chat_turn"` is the primary fuzzy-life call.
   */
  primaryChat?: boolean;
}

export interface CompanionLongRunV3PressureExpectation {
  /** Selects one episode. Omit only when exactly one episode is new/changed. */
  episodeId?: string;
  evidenceMessageId: string;
  pressure?: "increase" | "decrease" | "unchanged";
  clarity?: "increase" | "decrease" | "unchanged";
  feltUnderstood?: "increase" | "decrease" | "unchanged";
  currentPressure?: number;
  currentClarity?: number;
  currentFeltUnderstood?: number;
  initialPressure?: number;
  initialClarity?: number;
  /** Later probes must update the original episode instead of opening another. */
  requirePreexistingEpisode?: boolean;
  /** Identifies the one durable pressure thread these probes are allowed to mutate. */
  subject?: PressureEpisode["subject"];
  pressureKind?: PressureEpisode["pressureKind"];
}

export interface CompanionLongRunV3BranchExpectation {
  branch: "A" | "B";
  expectedAnchorSha256: string;
  actualAnchorSha256: string;
  /**
   * A branch-only durable projection. Do not include the shared pre-fork
   * history or user instructions that merely name the counterfactual branch.
   */
  durableProjection: unknown;
  forbiddenDurableFragments: readonly string[];
  /** The assistant candidate only; the caller must not concatenate user text. */
  assistantText?: string;
  forbiddenAssistantFragments?: readonly string[];
}

export interface CompanionLongRunV3HardAssertionInput {
  before: CompanionLongRunV3Snapshot;
  after: CompanionLongRunV3Snapshot;
  promptCalls: readonly CompanionLongRunV3PromptCall[];
  responseScheduleChangeCount?: number;
  scheduleCapability?: boolean;
  /** Dates explicitly touched by activation/clock advancement in this step. */
  touchedLocalDates?: readonly string[];
  currentUserMessageId?: string;
  /** Required on the T48-style turn that grants delegated authority. */
  expectedDelegatedAuthorizationMessageId?: string;
  pressureExpectation?: CompanionLongRunV3PressureExpectation;
  idempotentReplay?: boolean;
  expectReplay?: boolean;
  branch?: CompanionLongRunV3BranchExpectation;
}

/**
 * Small, serializable result used by the v3 runner's turn-specific gates.
 * These validators deliberately return every observed issue instead of
 * accepting a partially matching row. That makes a missing or ambiguous
 * evidence chain fail closed while keeping this module independent of the
 * database and HTTP runtime.
 */
export interface CompanionLongRunV3FailClosedValidation {
  passed: boolean;
  issues: readonly string[];
  actual?: unknown;
}

export interface CompanionLongRunV3SupportModeValidationInput {
  before: CompanionLongRunV3Snapshot;
  after: CompanionLongRunV3Snapshot;
  expectedMode: SupportIntervention["mode"];
  /** The message that contains the offered support (assistant for character→user). */
  evidenceMessageId: string;
  /** The user's explicit delegated-authority message, when distinct from the support message. */
  authorizationMessageId?: string;
  offeredBy: SupportIntervention["offeredBy"];
  receivedBy: SupportIntervention["receivedBy"];
}

export interface CompanionLongRunV3MemoryProjection {
  messages: readonly unknown[];
  memories: readonly unknown[];
  memoryEvidence: readonly unknown[];
  retrievalRuns: readonly unknown[];
  activityEvents?: readonly unknown[];
  domainEvents?: readonly unknown[];
}

export interface CompanionLongRunV3MemoryWriteValidationInput {
  before: CompanionLongRunV3MemoryProjection;
  after: CompanionLongRunV3MemoryProjection;
  evidenceMessageId: string;
}

export interface CompanionLongRunV3MemoryRecallValidationInput {
  before: CompanionLongRunV3MemoryProjection;
  after: CompanionLongRunV3MemoryProjection;
  evidenceMessageId: string;
  diagnostic: unknown;
  requireSelectedEvidence?: boolean;
  /**
   * When supplied, the immutable rendered retrieval fragment must also occur in
   * the one primary chat prompt. Keeping this optional preserves the pure
   * validator's compatibility with callers that have not projected calls yet;
   * the persisted retrieval run itself is still required to contain the
   * fragment for every positive recall.
   */
  promptCalls?: readonly CompanionLongRunV3PromptCall[];
  expectation?: CompanionLongRunV3MemoryRecallExpectation;
}

export interface CompanionLongRunV3MemoryRecallRequirementGroup {
  /** Stable label surfaced in fail-closed issue codes. */
  label: string;
  /** A group matches one selected memory with any of these canonical subjects. */
  subjectKeys?: readonly string[];
  /** A group may be pinned to one of these exact durable memory ids. */
  memoryIds?: readonly string[];
  /**
   * Every fragment must occur in the selected memory's durable content or in
   * one of its selected, persisted evidence quotes/context summaries.
   */
  contentIncludesAll?: readonly string[];
  /** At least one grounded fragment must occur when this list is non-empty. */
  contentIncludesAny?: readonly string[];
  /** The matching memory must be backed by all of these selected source rows. */
  requiredSourceMessageIds?: readonly string[];
  /**
   * Candidate ordinals are resolved from persisted message metadata or the
   * runner's stable client-message suffix (for example `shared-014`).
   */
  requiredSourceMessageOrdinals?: readonly number[];
}

export interface CompanionLongRunV3MemoryRecallExpectation {
  minimumSelectedMemories?: number;
  requiredGroups?: readonly CompanionLongRunV3MemoryRecallRequirementGroup[];
  /** Require the configured groups to be satisfied by different memories. */
  requireDistinctGroupMatches?: boolean;
  /** Forbidden fragments are checked against selected durable memory content. */
  forbiddenContent?: readonly string[];
  requiredSourceMessageIds?: readonly string[];
  requiredSourceMessageOrdinals?: readonly number[];
  /** Reject superseded/contradictory source rows even if memory content is terse. */
  forbiddenSourceMessageIds?: readonly string[];
  forbiddenSourceMessageOrdinals?: readonly number[];
}

export type CompanionLongRunV3CharacterCausalStage =
  | "dilemma"
  | "user_to_character_support"
  | "character_decision_and_action"
  | "mixed_outcome"
  | "character_reflection";

export interface CompanionLongRunV3BidirectionalValidationInput {
  snapshot: CompanionLongRunV3Snapshot;
  characterDilemmaId: string;
  requiredCharacterStage: CompanionLongRunV3CharacterCausalStage;
}

export interface CompanionLongRunV3DurableNegativeValidationInput {
  before: CompanionLongRunV3MemoryProjection &
    Pick<CompanionLongRunV3Snapshot, "actions" | "outcomes">;
  after: CompanionLongRunV3MemoryProjection &
    Pick<CompanionLongRunV3Snapshot, "actions" | "outcomes">;
  evidenceMessageId: string;
}

export type CompanionLongRunV3CausalRecapStage =
  "dilemma" | "support" | "decision" | "action" | "outcome" | "reflection";

export interface CompanionLongRunV3CausalRecapValidationInput {
  snapshot: CompanionLongRunV3Snapshot;
  evidence: CompanionLongRunV3MemoryProjection;
  promptCalls: readonly CompanionLongRunV3PromptCall[];
  dilemmaId: string;
  /** Pin the intended chain when a dilemma contains historical decisions. */
  decisionId?: string;
  requiredStages: readonly CompanionLongRunV3CausalRecapStage[];
  /** Optional exact counts make intermediate recaps prove absent later stages. */
  expectedStageCounts?: Partial<
    Record<CompanionLongRunV3CausalRecapStage, number>
  >;
  /** Durable memory ids that must be active, evidenced, and present in prompt. */
  requiredMemoryIds?: readonly string[];
  minimumDurableMemories?: number;
}

export interface CompanionLongRunV3RelationshipContinuityValidationInput {
  snapshot: CompanionLongRunV3Snapshot;
  evidence: CompanionLongRunV3MemoryProjection;
  promptCalls: readonly CompanionLongRunV3PromptCall[];
  dilemmaId: string;
  decisionId?: string;
  requiredCausalStages: readonly CompanionLongRunV3CausalRecapStage[];
  expectedStageCounts?: Partial<
    Record<CompanionLongRunV3CausalRecapStage, number>
  >;
  /** Relationship facts must match these configured groups; no wording is hard-coded. */
  requiredMemoryGroups: readonly CompanionLongRunV3MemoryRecallRequirementGroup[];
  requireDistinctMemoryGroups?: boolean;
  minimumDurableMemories?: number;
  /** At least one canonical user-choice milestone must normally be projected. */
  minimumPromptedMilestones?: number;
}

export function evaluateCompanionLongRunV3HardAssertions(
  input: CompanionLongRunV3HardAssertionInput,
): readonly CompanionLongRunV3HardGateResult[] {
  return [
    dailyContextUnique(input),
    noScheduleGrowth(input),
    causalStageSeparated(input),
    delegatedDecisionAuthorized(input),
    pressureChangeEvidenceBound(input),
    idempotentReplay(input),
    branchIsolated(input),
    promptExcludesFutureSchedule(input),
    promptIncludesLifeContext(input),
  ];
}

function dailyContextUnique(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const effective = input.after.dailyContexts.filter(
    (context) => context.status !== "superseded",
  );
  const byAgentDate = groupBy(
    effective,
    (context) => `${context.agentId}\u001f${context.localDate}`,
  );
  const duplicates = [...byAgentDate.entries()]
    .filter(([, contexts]) => contexts.length > 1)
    .map(([key, contexts]) => ({
      key,
      ids: contexts.map((context) => context.id),
    }));
  const touched = input.touchedLocalDates ?? [];
  const touchedCounts = touched.map((localDate) => ({
    localDate,
    count: effective.filter((context) => context.localDate === localDate)
      .length,
  }));
  const touchedValid = touchedCounts.every(({ count }) => count === 1);
  return hardResult(
    "daily_context_unique",
    duplicates.length === 0 && touchedValid,
    "At most one effective DailyLifeContext exists per agent/local day, and every touched day has one.",
    {
      expected: {
        maximumEffectiveContextsPerAgentDate: 1,
        touchedDates: touched,
      },
      actual: { duplicates, touchedCounts },
    },
  );
}

function noScheduleGrowth(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const beforeIds = sortedIds(input.before.scheduleItems);
  const afterIds = sortedIds(input.after.scheduleItems);
  const responseScheduleChangeCount = input.responseScheduleChangeCount ?? 0;
  const capabilityRetired = input.scheduleCapability !== true;
  const passed =
    equalStrings(beforeIds, afterIds) &&
    responseScheduleChangeCount === 0 &&
    capabilityRetired;
  return hardResult(
    "no_schedule_growth",
    passed,
    "The fuzzy-life turn does not create, delete, or report exact schedule items.",
    {
      expected: {
        scheduleIds: beforeIds,
        responseScheduleChangeCount: 0,
        scheduleCapability: false,
      },
      actual: {
        scheduleIds: afterIds,
        responseScheduleChangeCount,
        scheduleCapability: input.scheduleCapability,
      },
    },
  );
}

function causalStageSeparated(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const snapshot = input.after;
  const dilemmaById = byId(snapshot.dilemmas);
  const interventionById = byId(snapshot.supportInterventions);
  const decisionById = byId(snapshot.decisions);
  const actionById = byId(snapshot.actions);
  const outcomeById = byId(snapshot.outcomes);
  const pressureById = byId(snapshot.pressureEpisodes);
  const sourceCatalog = evidenceSourceCatalog(snapshot);
  const issues: string[] = [];

  for (const dilemma of snapshot.dilemmas) {
    validatePersistedSourceIds(
      `dilemma:${dilemma.id}`,
      dilemma.sourceMessageIds,
      sourceCatalog,
      "missing_source_message",
      issues,
    );
    if (dilemma.closingDecisionId !== undefined) {
      const closingDecision = decisionById.get(dilemma.closingDecisionId);
      if (closingDecision === undefined) {
        issues.push(
          `dilemma:${dilemma.id}:missing_closing_decision:${dilemma.closingDecisionId}`,
        );
      } else if (closingDecision.dilemmaId !== dilemma.id) {
        issues.push(
          `dilemma:${dilemma.id}:closing_decision_wrong_dilemma:${closingDecision.id}`,
        );
      }
    }
  }

  for (const intervention of snapshot.supportInterventions) {
    if (intervention.dilemmaId !== undefined) {
      const dilemma = dilemmaById.get(intervention.dilemmaId);
      if (dilemma === undefined) {
        issues.push(`intervention:${intervention.id}:missing_dilemma`);
      } else {
        compareOwnership(
          `intervention:${intervention.id}`,
          intervention,
          dilemma,
          issues,
        );
        if (
          dilemma.subject !== "shared" &&
          intervention.receivedBy !== dilemma.subject
        ) {
          issues.push(
            `intervention:${intervention.id}:recipient_subject_mismatch`,
          );
        }
        if (
          intervention.recommendationOptionId !== undefined &&
          !dilemma.options.some(
            (option) => option.id === intervention.recommendationOptionId,
          )
        ) {
          issues.push(
            `intervention:${intervention.id}:recommendation_not_in_dilemma`,
          );
        }
      }
    }
    if (intervention.pressureEpisodeId !== undefined) {
      const pressure = pressureById.get(intervention.pressureEpisodeId);
      if (pressure === undefined) {
        issues.push(`intervention:${intervention.id}:missing_pressure`);
      } else {
        compareOwnership(
          `intervention:${intervention.id}`,
          intervention,
          pressure,
          issues,
        );
        if (
          pressure.subject !== "shared" &&
          intervention.receivedBy !== pressure.subject
        ) {
          issues.push(
            `intervention:${intervention.id}:pressure_recipient_mismatch`,
          );
        }
      }
    }
    validatePersistedSourceIds(
      `intervention:${intervention.id}`,
      [intervention.sourceMessageId],
      sourceCatalog,
      "missing_source_message",
      issues,
    );
  }

  for (const decision of snapshot.decisions) {
    const dilemma = dilemmaById.get(decision.dilemmaId);
    if (dilemma === undefined) {
      issues.push(`decision:${decision.id}:missing_dilemma`);
    } else {
      compareOwnership(`decision:${decision.id}`, decision, dilemma, issues);
      if (decision.subject !== dilemma.subject) {
        issues.push(`decision:${decision.id}:subject_mismatch`);
      }
      if (
        !dilemma.options.some(
          (option) => option.id === decision.selectedOptionId,
        )
      ) {
        issues.push(`decision:${decision.id}:option_not_in_dilemma`);
      }
      if (isBefore(decision.recordedAtUtc, dilemma.recordedAtUtc)) {
        issues.push(`decision:${decision.id}:recorded_before_dilemma`);
      }
    }
    validatePersistedSourceIds(
      `decision:${decision.id}`,
      decision.sourceMessageIds,
      sourceCatalog,
      "missing_source_message",
      issues,
    );
    let hasMatchingInterventionMode = false;
    for (const interventionId of decision.supportInterventionIds) {
      const intervention = interventionById.get(interventionId);
      if (intervention === undefined) {
        issues.push(
          `decision:${decision.id}:missing_intervention:${interventionId}`,
        );
      } else {
        if (intervention.mode === decision.supportMode) {
          hasMatchingInterventionMode = true;
        }
        compareOwnership(
          `decision:${decision.id}:intervention:${intervention.id}`,
          decision,
          intervention,
          issues,
        );
        if (intervention.dilemmaId !== decision.dilemmaId) {
          issues.push(
            `decision:${decision.id}:intervention_wrong_dilemma:${intervention.id}`,
          );
        }
        if (
          decision.subject !== "shared" &&
          intervention.receivedBy !== decision.subject
        ) {
          issues.push(
            `decision:${decision.id}:intervention_recipient_mismatch:${intervention.id}`,
          );
        }
        if (isBefore(decision.recordedAtUtc, intervention.recordedAtUtc)) {
          issues.push(
            `decision:${decision.id}:recorded_before_intervention:${intervention.id}`,
          );
        }
      }
    }
    if (
      decision.supportInterventionIds.length > 0 &&
      !hasMatchingInterventionMode
    ) {
      issues.push(
        `decision:${decision.id}:no_matching_intervention_mode:${decision.supportMode}`,
      );
    }
  }

  for (const action of snapshot.actions) {
    const decision = decisionById.get(action.decisionId);
    if (decision === undefined) {
      issues.push(`action:${action.id}:missing_decision`);
    } else {
      compareOwnership(`action:${action.id}`, action, decision, issues);
      if (action.subject !== decision.subject) {
        issues.push(`action:${action.id}:subject_mismatch`);
      }
      if (!actorMatchesSubject(action.performedBy, action.subject)) {
        issues.push(`action:${action.id}:performer_subject_mismatch`);
      }
      if (isBefore(action.recordedAtUtc, decision.recordedAtUtc)) {
        issues.push(`action:${action.id}:recorded_before_decision`);
      }
    }
    validatePersistedSourceIds(
      `action:${action.id}`,
      action.sourceEvidenceIds,
      sourceCatalog,
      "missing_independent_evidence",
      issues,
    );
  }

  for (const outcome of snapshot.outcomes) {
    const decision = decisionById.get(outcome.decisionId);
    if (decision === undefined) {
      issues.push(`outcome:${outcome.id}:missing_decision`);
    } else {
      compareOwnership(`outcome:${outcome.id}`, outcome, decision, issues);
      if (isBefore(outcome.recordedAtUtc, decision.recordedAtUtc)) {
        issues.push(`outcome:${outcome.id}:recorded_before_decision`);
      }
    }
    for (const actionId of outcome.actionIds) {
      const action = actionById.get(actionId);
      if (action === undefined) {
        issues.push(`outcome:${outcome.id}:missing_action:${actionId}`);
      } else {
        compareOwnership(
          `outcome:${outcome.id}:action:${action.id}`,
          outcome,
          action,
          issues,
        );
        if (action.decisionId !== outcome.decisionId) {
          issues.push(
            `outcome:${outcome.id}:action_wrong_decision:${action.id}`,
          );
        }
        if (isBefore(outcome.recordedAtUtc, action.recordedAtUtc)) {
          issues.push(
            `outcome:${outcome.id}:recorded_before_action:${action.id}`,
          );
        }
      }
    }
    if (
      (outcome.causeKind === "action" || outcome.causeKind === "mixed") &&
      outcome.actionIds.length === 0
    ) {
      issues.push(`outcome:${outcome.id}:action_cause_without_action`);
    }
    validatePersistedSourceIds(
      `outcome:${outcome.id}`,
      outcome.sourceEvidenceIds,
      sourceCatalog,
      "missing_independent_evidence",
      issues,
    );
  }

  for (const reflection of snapshot.reflections) {
    const decision =
      reflection.decisionId === undefined
        ? undefined
        : decisionById.get(reflection.decisionId);
    const outcome =
      reflection.outcomeId === undefined
        ? undefined
        : outcomeById.get(reflection.outcomeId);
    if (reflection.decisionId !== undefined && decision === undefined) {
      issues.push(`reflection:${reflection.id}:missing_decision`);
    }
    if (reflection.outcomeId !== undefined && outcome === undefined) {
      issues.push(`reflection:${reflection.id}:missing_outcome`);
    }
    if (
      reflection.decisionId === undefined &&
      reflection.outcomeId === undefined
    ) {
      issues.push(`reflection:${reflection.id}:missing_causal_reference`);
    }
    validatePersistedSourceIds(
      `reflection:${reflection.id}`,
      reflection.sourceMessageIds,
      sourceCatalog,
      "missing_source_message",
      issues,
    );
    if (decision !== undefined) {
      compareOwnership(
        `reflection:${reflection.id}`,
        reflection,
        decision,
        issues,
      );
      if (reflection.subject !== decision.subject) {
        issues.push(`reflection:${reflection.id}:subject_mismatch`);
      }
      if (!actorMatchesSubject(reflection.reflectedBy, reflection.subject)) {
        issues.push(`reflection:${reflection.id}:reflector_subject_mismatch`);
      }
      if (isBefore(reflection.recordedAtUtc, decision.recordedAtUtc)) {
        issues.push(`reflection:${reflection.id}:recorded_before_decision`);
      }
    }
    if (outcome !== undefined) {
      compareOwnership(
        `reflection:${reflection.id}:outcome:${outcome.id}`,
        reflection,
        outcome,
        issues,
      );
      if (
        reflection.decisionId !== undefined &&
        outcome.decisionId !== reflection.decisionId
      ) {
        issues.push(`reflection:${reflection.id}:outcome_wrong_decision`);
      }
      if (isBefore(reflection.recordedAtUtc, outcome.recordedAtUtc)) {
        issues.push(`reflection:${reflection.id}:recorded_before_outcome`);
      }
    }
  }

  for (const pressure of snapshot.pressureEpisodes) {
    if (pressure.dilemmaId !== undefined) {
      const dilemma = dilemmaById.get(pressure.dilemmaId);
      if (dilemma === undefined) {
        issues.push(`pressure:${pressure.id}:missing_dilemma`);
      } else {
        compareOwnership(`pressure:${pressure.id}`, pressure, dilemma, issues);
        if (pressure.subject !== dilemma.subject) {
          issues.push(`pressure:${pressure.id}:subject_mismatch`);
        }
      }
    }
    for (const interventionId of pressure.interventionIds) {
      const intervention = interventionById.get(interventionId);
      if (intervention === undefined) {
        issues.push(
          `pressure:${pressure.id}:missing_intervention:${interventionId}`,
        );
      } else if (intervention.pressureEpisodeId !== pressure.id) {
        issues.push(
          `pressure:${pressure.id}:intervention_backlink_mismatch:${intervention.id}`,
        );
      }
    }
    for (const outcomeId of pressure.outcomeIds) {
      if (!outcomeById.has(outcomeId)) {
        issues.push(`pressure:${pressure.id}:missing_outcome:${outcomeId}`);
      }
    }
  }

  const duplicateIdempotencyKeys = {
    dilemmas: duplicateKeys(snapshot.dilemmas),
    interventions: duplicateKeys(snapshot.supportInterventions),
    decisions: duplicateKeys(snapshot.decisions),
    actions: duplicateKeys(snapshot.actions),
    outcomes: duplicateKeys(snapshot.outcomes),
    reflections: duplicateKeys(snapshot.reflections),
  };
  for (const [collection, keys] of Object.entries(duplicateIdempotencyKeys)) {
    for (const key of keys) issues.push(`${collection}:duplicate_key:${key}`);
  }

  return hardResult(
    "causal_stage_separated",
    issues.length === 0,
    "Support, decision, action, outcome, and reflection remain distinct, evidenced stages with valid backward references.",
    { actual: { issues, duplicateIdempotencyKeys } },
  );
}

function delegatedDecisionAuthorized(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const newDecisions = addedRows(input.before.decisions, input.after.decisions);
  const newActions = addedRows(input.before.actions, input.after.actions);
  const newOutcomes = addedRows(input.before.outcomes, input.after.outcomes);
  const delegated = newDecisions.filter(
    (decision) =>
      decision.authority === "delegated" ||
      decision.supportMode === "delegated_decision",
  );
  const expectedAuthorization = input.expectedDelegatedAuthorizationMessageId;

  const structurallyValid = delegated.every(
    (decision) =>
      decision.authority === "delegated" &&
      decision.supportMode === "delegated_decision" &&
      decision.authorizedByMessageId !== undefined &&
      decision.sourceMessageIds.includes(decision.authorizedByMessageId) &&
      ((decision.subject === "user" && decision.decidedBy === "character") ||
        (decision.subject === "character" && decision.decidedBy === "user")),
  );
  const expectedValid =
    expectedAuthorization === undefined ||
    (newDecisions.length === 1 &&
      delegated.length === 1 &&
      delegated[0]?.authorizedByMessageId === expectedAuthorization &&
      delegated[0]?.sourceMessageIds.includes(expectedAuthorization) === true &&
      newActions.length === 0 &&
      newOutcomes.length === 0);

  return hardResult(
    "delegated_decision_authorized",
    structurallyValid && expectedValid,
    "Delegated choices require the exact authorization message and cannot manufacture an action or outcome in the same turn.",
    {
      expected:
        expectedAuthorization === undefined
          ? { allNewDelegatedDecisionsAreAuthorized: true }
          : {
              authorizationMessageId: expectedAuthorization,
              newDecisionCount: 1,
              newActionCount: 0,
              newOutcomeCount: 0,
            },
      actual: {
        newDecisionIds: newDecisions.map((decision) => decision.id),
        delegated: delegated.map((decision) => ({
          id: decision.id,
          authority: decision.authority,
          supportMode: decision.supportMode,
          decidedBy: decision.decidedBy,
          subject: decision.subject,
          authorizedByMessageId: decision.authorizedByMessageId,
        })),
        newActionIds: newActions.map((action) => action.id),
        newOutcomeIds: newOutcomes.map((outcome) => outcome.id),
      },
    },
  );
}

function pressureChangeEvidenceBound(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const beforeById = byId(input.before.pressureEpisodes);
  const changed = input.after.pressureEpisodes.filter((episode) => {
    const before = beforeById.get(episode.id);
    return (
      before === undefined ||
      pressureProjection(before) !== pressureProjection(episode)
    );
  });
  const expected = input.pressureExpectation;
  const currentEvidence =
    expected?.evidenceMessageId ?? input.currentUserMessageId;
  const ungrounded = changed.filter(
    (episode) =>
      currentEvidence === undefined ||
      episode.latestEvidenceMessageId !== currentEvidence ||
      !episode.sourceMessageIds.includes(currentEvidence),
  );

  const directionIssues: string[] = [];
  if (expected !== undefined) {
    if (expected.subject !== undefined || expected.pressureKind !== undefined) {
      const matchingEpisodes = input.after.pressureEpisodes.filter(
        (episode) =>
          (expected.subject === undefined ||
            episode.subject === expected.subject) &&
          (expected.pressureKind === undefined ||
            episode.pressureKind === expected.pressureKind),
      );
      if (matchingEpisodes.length !== 1) {
        directionIssues.push(
          `expected_one_matching_pressure_thread:actual_${String(matchingEpisodes.length)}`,
        );
      }
    }
    const candidates =
      expected.episodeId === undefined
        ? changed
        : changed.filter((episode) => episode.id === expected.episodeId);
    const unexpectedChanged =
      expected.episodeId === undefined
        ? []
        : changed.filter((episode) => episode.id !== expected.episodeId);
    for (const episode of unexpectedChanged) {
      directionIssues.push(`unexpected_changed_episode:${episode.id}`);
    }
    if (candidates.length !== 1) {
      directionIssues.push(
        `expected_one_pressure_episode:actual_${String(candidates.length)}`,
      );
    } else {
      const after = candidates[0]!;
      const before = beforeById.get(after.id);
      if (expected.requirePreexistingEpisode === true && before === undefined) {
        directionIssues.push("expected_preexisting_pressure_episode");
      }
      if (before === undefined) {
        if (
          expected.pressure !== undefined ||
          expected.clarity !== undefined ||
          expected.feltUnderstood !== undefined
        ) {
          directionIssues.push("direction_requires_preexisting_episode");
        }
      } else {
        checkDirection(
          "pressure",
          before.currentPressure,
          after.currentPressure,
          expected.pressure,
          directionIssues,
        );
        checkDirection(
          "clarity",
          before.currentClarity,
          after.currentClarity,
          expected.clarity,
          directionIssues,
        );
        checkDirection(
          "felt_understood",
          before.currentFeltUnderstood,
          after.currentFeltUnderstood,
          expected.feltUnderstood,
          directionIssues,
        );
      }
      checkExactValue(
        "initial_pressure",
        after.initialPressure,
        expected.initialPressure,
        directionIssues,
      );
      checkExactValue(
        "initial_clarity",
        after.initialClarity,
        expected.initialClarity,
        directionIssues,
      );
      checkExactValue(
        "pressure",
        after.currentPressure,
        expected.currentPressure,
        directionIssues,
      );
      checkExactValue(
        "clarity",
        after.currentClarity,
        expected.currentClarity,
        directionIssues,
      );
      checkExactValue(
        "felt_understood",
        after.currentFeltUnderstood,
        expected.currentFeltUnderstood,
        directionIssues,
      );
    }
  }

  return hardResult(
    "pressure_change_evidence_bound",
    ungrounded.length === 0 && directionIssues.length === 0,
    "Every pressure/clarity/understanding mutation is bound to explicit current-turn evidence and follows the declared direction.",
    {
      expected,
      actual: {
        changedEpisodeIds: changed.map((episode) => episode.id),
        ungroundedEpisodeIds: ungrounded.map((episode) => episode.id),
        directionIssues,
      },
    },
  );
}

export function validateCompanionLongRunV3SupportMode(
  input: CompanionLongRunV3SupportModeValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const addedInterventions = addedRows(
    input.before.supportInterventions,
    input.after.supportInterventions,
  );
  const addedDecisions = addedRows(
    input.before.decisions,
    input.after.decisions,
  );
  const addedActions = addedRows(input.before.actions, input.after.actions);
  const addedOutcomes = addedRows(input.before.outcomes, input.after.outcomes);
  const issues: string[] = [];
  if (addedInterventions.length !== 1) {
    issues.push(
      `expected_one_intervention:actual_${String(addedInterventions.length)}`,
    );
  }
  const intervention = addedInterventions[0];
  if (intervention !== undefined) {
    if (intervention.mode !== input.expectedMode)
      issues.push(`mode:${intervention.mode}:expected_${input.expectedMode}`);
    if (intervention.sourceMessageId !== input.evidenceMessageId)
      issues.push("source_message_mismatch");
    if (intervention.offeredBy !== input.offeredBy)
      issues.push("offered_by_mismatch");
    if (intervention.receivedBy !== input.receivedBy)
      issues.push("received_by_mismatch");
    const dilemma =
      intervention.dilemmaId === undefined
        ? undefined
        : input.after.dilemmas.find(
            (item) => item.id === intervention.dilemmaId,
          );
    const pressure =
      intervention.pressureEpisodeId === undefined
        ? undefined
        : input.after.pressureEpisodes.find(
            (item) => item.id === intervention.pressureEpisodeId,
          );
    if (dilemma === undefined && pressure === undefined)
      issues.push("support_target_missing");
    if (
      dilemma !== undefined &&
      dilemma.subject !== "shared" &&
      dilemma.subject !== intervention.receivedBy
    )
      issues.push("dilemma_subject_mismatch");
    if (
      pressure !== undefined &&
      pressure.subject !== "shared" &&
      pressure.subject !== intervention.receivedBy
    )
      issues.push("pressure_subject_mismatch");
    if (
      intervention.recommendationOptionId !== undefined &&
      (dilemma === undefined ||
        !dilemma.options.some(
          (option) => option.id === intervention.recommendationOptionId,
        ))
    )
      issues.push("recommendation_not_in_dilemma");
  }

  const decisionLinked =
    intervention === undefined
      ? []
      : addedDecisions.filter((decision) =>
          decision.supportInterventionIds.includes(intervention.id),
        );
  if (input.expectedMode === "delegated_decision") {
    const authorizationMessageId =
      input.authorizationMessageId ?? input.evidenceMessageId;
    if (
      decisionLinked.length !== 1 ||
      addedDecisions.length !== 1 ||
      decisionLinked[0]?.authority !== "delegated" ||
      decisionLinked[0]?.authorizedByMessageId !== authorizationMessageId ||
      decisionLinked[0]?.sourceMessageIds.includes(authorizationMessageId) !==
        true
    ) {
      issues.push("delegated_decision_not_uniquely_authorized_and_linked");
    }
  } else if (addedDecisions.length !== 0) {
    issues.push(`non_delegated_mode_created_decision:${input.expectedMode}`);
  }
  if (addedActions.length !== 0) issues.push("support_turn_created_action");
  if (addedOutcomes.length !== 0) issues.push("support_turn_created_outcome");

  return {
    passed: issues.length === 0,
    issues,
    actual: {
      interventionIds: addedInterventions.map((item) => item.id),
      decisionIds: addedDecisions.map((item) => item.id),
      actionIds: addedActions.map((item) => item.id),
      outcomeIds: addedOutcomes.map((item) => item.id),
    },
  };
}

export function validateCompanionLongRunV3MemoryWrite(
  input: CompanionLongRunV3MemoryWriteValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const addedMemories = addedRawRecords(
    input.before.memories,
    input.after.memories,
  );
  const messages = rawById(input.after.messages);
  const evidence = input.after.memoryEvidence.flatMap((value) => {
    const record = asRawRecord(value);
    return record === undefined ? [] : [record];
  });
  const issues: string[] = [];
  if (addedMemories.length === 0) issues.push("no_new_memory");

  for (const memory of addedMemories) {
    const memoryId = nonEmptyRawString(memory["id"]);
    const sourceMessageId = nonEmptyRawString(memory["source_message_id"]);
    if (memoryId === undefined) {
      issues.push("memory_missing_id");
      continue;
    }
    if (sourceMessageId !== input.evidenceMessageId)
      issues.push(`memory:${memoryId}:source_message_mismatch`);
    const sourceMessage = messages.get(input.evidenceMessageId);
    if (sourceMessage === undefined) {
      issues.push(`memory:${memoryId}:source_message_not_persisted`);
    } else if (sourceMessage["role"] !== "user") {
      issues.push(`memory:${memoryId}:source_message_not_user`);
    }
    const matchingEvidence = evidence.filter(
      (row) => row["memory_id"] === memoryId,
    );
    if (matchingEvidence.length === 0) {
      issues.push(`memory:${memoryId}:missing_evidence`);
      continue;
    }
    if (
      !matchingEvidence.some(
        (row) =>
          row["source_type"] === "message" &&
          row["source_id"] === input.evidenceMessageId,
      )
    ) {
      issues.push(`memory:${memoryId}:evidence_source_mismatch`);
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    actual: {
      addedMemoryIds: addedMemories.map((row) => row["id"]),
      evidenceMessageId: input.evidenceMessageId,
    },
  };
}

export function validateCompanionLongRunV3MemoryRecall(
  input: CompanionLongRunV3MemoryRecallValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const diagnostic = asRawRecord(input.diagnostic);
  const addedRuns = addedRawRecords(
    input.before.retrievalRuns,
    input.after.retrievalRuns,
  );
  const memories = rawById(input.after.memories);
  const evidence = rawById(input.after.memoryEvidence);
  const messages = rawById(input.after.messages);
  const activityEvents = rawById(input.after.activityEvents ?? []);
  const domainEvents = rawById(input.after.domainEvents ?? []);
  const issues: string[] = [];
  if (diagnostic === undefined) issues.push("recall_diagnostic_missing");
  if (addedRuns.length !== 1)
    issues.push(
      `expected_one_retrieval_run:actual_${String(addedRuns.length)}`,
    );
  const run = addedRuns[0];
  if (run?.["source_message_id"] !== input.evidenceMessageId)
    issues.push("retrieval_run_source_message_mismatch");
  if (!messages.has(input.evidenceMessageId))
    issues.push("retrieval_source_message_not_persisted");

  const selectedMemoryIds = rawStringArray(diagnostic?.["selectedMemoryIds"]);
  const selectedEvidenceIds = rawStringArray(
    diagnostic?.["selectedEvidenceIds"],
  );
  const promptMemoryIdList = rawStringArray(diagnostic?.["promptMemoryIds"]);
  const promptMemoryIds = new Set(promptMemoryIdList);
  const persistedResult = asRawRecord(run?.["result"]);
  const persistedCandidates = rawRecordArray(run?.["candidates"]);
  const persistedEvidenceBundle = asRawRecord(run?.["evidence_bundle"]);
  const resultEvidenceBundle = asRawRecord(persistedResult?.["evidenceBundle"]);
  const persistedSelectedMemoryIds = rawStringArray(
    persistedResult?.["selectedMemoryIds"],
  );
  const persistedSelectedEvidenceIds = rawStringArray(
    persistedResult?.["selectedEvidenceIds"],
  );
  const diagnosticMode = nonEmptyRawString(diagnostic?.["recallMode"]);
  const runMode = nonEmptyRawString(run?.["mode"]);
  const resultMode = nonEmptyRawString(persistedResult?.["mode"]);
  const bundleMode = nonEmptyRawString(persistedEvidenceBundle?.["mode"]);
  const renderedPromptFragment = nonEmptyRawString(
    run?.["rendered_prompt_fragment"],
  );

  if (persistedResult === undefined)
    issues.push("retrieval_run_result_missing");
  if (run !== undefined && !Array.isArray(run["candidates"]))
    issues.push("retrieval_run_candidates_missing");
  if (runMode === undefined) issues.push("retrieval_run_mode_missing");
  if (resultMode === undefined) issues.push("retrieval_result_mode_missing");
  if (input.requireSelectedEvidence !== false && bundleMode === undefined)
    issues.push("retrieval_evidence_bundle_mode_missing");
  if (diagnosticMode === undefined)
    issues.push("recall_diagnostic_mode_missing");
  if (
    runMode !== undefined &&
    diagnosticMode !== undefined &&
    runMode !== diagnosticMode
  )
    issues.push("retrieval_run_diagnostic_mode_mismatch");
  if (
    runMode !== undefined &&
    resultMode !== undefined &&
    runMode !== resultMode
  )
    issues.push("retrieval_run_result_mode_mismatch");
  if (
    runMode !== undefined &&
    bundleMode !== undefined &&
    runMode !== bundleMode
  )
    issues.push("retrieval_run_evidence_bundle_mode_mismatch");
  if (
    persistedResult !== undefined &&
    persistedResult["abstained"] !== diagnostic?.["abstained"]
  )
    issues.push("retrieval_run_result_abstention_mismatch");
  if (
    persistedResult !== undefined &&
    persistedResult["score"] !== diagnostic?.["score"]
  )
    issues.push("retrieval_run_result_score_mismatch");
  if (
    persistedResult !== undefined &&
    !equalStrings(persistedSelectedMemoryIds, selectedMemoryIds)
  )
    issues.push("retrieval_run_result_memory_selection_mismatch");
  if (
    persistedResult !== undefined &&
    !equalStrings(persistedSelectedEvidenceIds, selectedEvidenceIds)
  )
    issues.push("retrieval_run_result_evidence_selection_mismatch");
  if (
    diagnostic?.["promptStrategy"] === "evidence_selected" &&
    !equalStrings(promptMemoryIdList, selectedMemoryIds)
  )
    issues.push("diagnostic_prompt_selection_mismatch");
  if (input.requireSelectedEvidence !== false) {
    if (diagnostic?.["abstained"] !== false)
      issues.push("positive_recall_abstained");
    if (selectedMemoryIds.length === 0) issues.push("selected_memory_missing");
    if (selectedEvidenceIds.length === 0)
      issues.push("selected_evidence_missing");
    if (persistedEvidenceBundle === undefined)
      issues.push("retrieval_run_evidence_bundle_missing");
    if (resultEvidenceBundle === undefined)
      issues.push("retrieval_result_evidence_bundle_missing");
    if (renderedPromptFragment === undefined)
      issues.push("retrieval_rendered_prompt_fragment_missing");
  }
  if (
    persistedEvidenceBundle !== undefined &&
    resultEvidenceBundle !== undefined &&
    !canonicalJsonEqual(persistedEvidenceBundle, resultEvidenceBundle)
  )
    issues.push("retrieval_run_result_evidence_bundle_mismatch");

  const bundleEntries = rawRecordArray(persistedEvidenceBundle?.["evidence"]);
  if (persistedEvidenceBundle !== undefined) {
    const bundleMemoryIds = uniqueStrings(
      bundleEntries.flatMap((entry) => {
        const id = nonEmptyRawString(entry["memoryId"]);
        return id === undefined ? [] : [id];
      }),
    );
    const bundleEvidenceIds = bundleEntries.flatMap((entry) => {
      const evidenceRow = asRawRecord(entry["evidence"]);
      const id = nonEmptyRawString(evidenceRow?.["id"]);
      return id === undefined ? [] : [id];
    });
    if (!equalStrings(bundleMemoryIds, selectedMemoryIds))
      issues.push("retrieval_evidence_bundle_memory_selection_mismatch");
    if (!equalStrings(bundleEvidenceIds, selectedEvidenceIds))
      issues.push("retrieval_evidence_bundle_evidence_selection_mismatch");
  }

  if (new Set(selectedMemoryIds).size !== selectedMemoryIds.length)
    issues.push("selected_memory_ids_not_unique");
  if (new Set(selectedEvidenceIds).size !== selectedEvidenceIds.length)
    issues.push("selected_evidence_ids_not_unique");
  const selectedMemorySet = new Set(selectedMemoryIds);
  const selectedEvidenceRows = new Map<string, Record<string, unknown>>();
  for (const memoryId of selectedMemoryIds) {
    const memory = memories.get(memoryId);
    if (memory === undefined) {
      issues.push(`selected_memory_not_persisted:${memoryId}`);
      continue;
    }
    if (memory["status"] !== "active")
      issues.push(`selected_memory_not_active:${memoryId}`);
    if (nonNullRawValue(memory["superseded_by_id"] ?? memory["supersededById"]))
      issues.push(`selected_memory_superseded:${memoryId}`);
    if (nonNullRawValue(memory["merged_into_id"] ?? memory["mergedIntoId"]))
      issues.push(`selected_memory_merged:${memoryId}`);
    if (!promptMemoryIds.has(memoryId))
      issues.push(`selected_memory_not_in_prompt:${memoryId}`);
  }
  for (const evidenceId of selectedEvidenceIds) {
    const row = evidence.get(evidenceId);
    if (row === undefined) {
      issues.push(`selected_evidence_not_persisted:${evidenceId}`);
      continue;
    }
    selectedEvidenceRows.set(evidenceId, row);
    const memoryId = nonEmptyRawString(row["memory_id"]);
    if (memoryId === undefined || !selectedMemorySet.has(memoryId))
      issues.push(`selected_evidence_wrong_memory:${evidenceId}`);
    const sourceId = nonEmptyRawString(row["source_id"]);
    const sourceType = row["source_type"];
    const sourcePersisted =
      sourceId !== undefined &&
      ((sourceType === "message" && messages.has(sourceId)) ||
        (sourceType === "activity_event" && activityEvents.has(sourceId)) ||
        (sourceType === "character_source" && domainEvents.has(sourceId)));
    if (!sourcePersisted)
      issues.push(`selected_evidence_source_missing:${evidenceId}`);
  }

  for (const memoryId of selectedMemoryIds) {
    const hasSelectedEvidence = [...selectedEvidenceRows.values()].some(
      (row) => row["memory_id"] === memoryId,
    );
    if (!hasSelectedEvidence)
      issues.push(`selected_memory_missing_evidence:${memoryId}`);
    const memory = memories.get(memoryId);
    if (
      renderedPromptFragment !== undefined &&
      memory !== undefined &&
      !promptContainsAnyValue(renderedPromptFragment, [
        memoryId,
        nonEmptyRawString(memory["content"]),
      ])
    )
      issues.push(`selected_memory_missing_from_rendered_prompt:${memoryId}`);
  }
  if (
    run !== undefined &&
    typeof run["selected_count"] === "number" &&
    run["selected_count"] !== selectedMemoryIds.length
  ) {
    issues.push("retrieval_run_selected_count_mismatch");
  }
  if (run !== undefined && typeof run["selected_count"] !== "number")
    issues.push("retrieval_run_selected_count_missing");
  if (
    run !== undefined &&
    typeof run["candidate_count"] === "number" &&
    run["candidate_count"] !== persistedCandidates.length
  )
    issues.push("retrieval_run_candidate_count_mismatch");
  if (run !== undefined && typeof run["candidate_count"] !== "number")
    issues.push("retrieval_run_candidate_count_missing");

  if (input.promptCalls !== undefined) {
    const primary = primaryPromptCalls(input.promptCalls);
    if (primary.length !== 1)
      issues.push(
        `expected_one_primary_prompt:actual_${String(primary.length)}`,
      );
    else if (renderedPromptFragment !== undefined) {
      issues.push(
        ...retrievalPromptEvidenceIssues({
          renderedPromptFragment,
          persistedEvidenceBundle,
          primaryPrompt: combinedPrompt(primary[0]!),
        }),
      );
    }
  }

  issues.push(
    ...memoryRecallExpectationIssues({
      expectation: input.expectation,
      selectedMemoryIds,
      memories,
      selectedEvidenceRows: [...selectedEvidenceRows.values()],
      messages,
    }),
  );

  return {
    passed: issues.length === 0,
    issues,
    actual: {
      retrievalRunIds: addedRuns.map((row) => row["id"]),
      selectedMemoryIds,
      selectedEvidenceIds,
      persistedSelectedMemoryIds,
      persistedSelectedEvidenceIds,
      runMode,
      resultMode,
      bundleMode,
      diagnosticMode,
    },
  };
}

export function validateCompanionLongRunV3MemoryAbstentionDurability(
  input: CompanionLongRunV3DurableNegativeValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const added = addedRawRecords(input.before.memories, input.after.memories);
  const forbidden = added.filter((memory) => {
    const namespace = memory["namespace"];
    const attribution = memory["attribution"];
    const subjectKey = memorySubjectKey(memory);
    return (
      namespace === "user_model" ||
      namespace === "shared_relationship" ||
      attribution === "user_explicit" ||
      subjectKey?.startsWith("user_") === true ||
      subjectKey?.startsWith("user:") === true ||
      subjectKey?.startsWith("relationship:") === true ||
      subjectKey?.startsWith("shared:") === true
    );
  });
  const issues = forbidden.map(
    (memory) =>
      `unsupported_memory_created:${nonEmptyRawString(memory["id"]) ?? "<missing>"}`,
  );
  return {
    passed: issues.length === 0,
    issues,
    actual: {
      addedMemoryIds: added.map((memory) => memory["id"]),
      forbiddenMemoryIds: forbidden.map((memory) => memory["id"]),
    },
  };
}

export function validateCompanionLongRunV3PlannedNotOccurredDurability(
  input: CompanionLongRunV3DurableNegativeValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const beforeMemories = rawById(input.before.memories);
  const changedMemories = input.after.memories.flatMap((value) => {
    const after = asRawRecord(value);
    const id = nonEmptyRawString(after?.["id"]);
    if (after === undefined || id === undefined) return [];
    const before = beforeMemories.get(id);
    return before === undefined ||
      JSON.stringify(before) !== JSON.stringify(after)
      ? [after]
      : [];
  });
  const occurredMemories = changedMemories.filter((memory) => {
    return (
      memory["temporal_status"] === "occurred" ||
      memory["claim_disposition"] === "completed" ||
      nonEmptyRawString(memory["occurred_start_at_utc"]) !== undefined ||
      nonEmptyRawString(memory["occurred_at_utc"]) !== undefined
    );
  });
  const addedActions = addedRows(input.before.actions, input.after.actions);
  const addedOutcomes = addedRows(input.before.outcomes, input.after.outcomes);
  const issues: string[] = [];
  for (const memory of occurredMemories)
    issues.push(
      `plan_persisted_as_occurred_memory:${nonEmptyRawString(memory["id"]) ?? "<missing>"}`,
    );
  for (const action of addedActions)
    issues.push(`plan_persisted_as_action:${action.id}`);
  for (const outcome of addedOutcomes)
    issues.push(`plan_persisted_as_outcome:${outcome.id}`);
  return {
    passed: issues.length === 0,
    issues,
    actual: {
      changedMemoryIds: changedMemories.map((memory) => memory["id"]),
      addedActionIds: addedActions.map((action) => action.id),
      addedOutcomeIds: addedOutcomes.map((outcome) => outcome.id),
    },
  };
}

/**
 * Proves that a recap is backed by one durable causal chain rather than by a
 * plausible free-form answer. Record ids and summaries are derived from the
 * supplied snapshot; this validator contains no scenario-specific wording.
 */
export function validateCompanionLongRunV3CausalRecapProvenance(
  input: CompanionLongRunV3CausalRecapValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const issues: string[] = [];
  const primary = primaryPromptCalls(input.promptCalls);
  if (primary.length !== 1)
    issues.push(`expected_one_primary_prompt:actual_${String(primary.length)}`);
  const prompt = primary.length === 1 ? combinedPrompt(primary[0]!) : "";
  const lifeContextInspection =
    primary.length === 1
      ? inspectLabeledJsonSegment(prompt, "LIFE_CONTEXT_JSON")
      : undefined;
  if (lifeContextInspection?.issue !== undefined)
    issues.push(`causal_${lifeContextInspection.issue}`);
  const chain = causalPromptRecords(input, issues);
  const requiredStages = new Set(input.requiredStages);

  for (const stage of input.requiredStages) {
    if ((chain.records.get(stage) ?? []).length === 0)
      issues.push(`causal_stage_missing:${stage}`);
  }
  for (const [stage, expectedCount] of Object.entries(
    input.expectedStageCounts ?? {},
  ) as Array<[CompanionLongRunV3CausalRecapStage, number]>) {
    const actualCount = (chain.records.get(stage) ?? []).length;
    if (actualCount !== expectedCount)
      issues.push(
        `causal_stage_count_mismatch:${stage}:expected_${String(expectedCount)}:actual_${String(actualCount)}`,
      );
  }

  const stagesRequiringPrompt = new Set<CompanionLongRunV3CausalRecapStage>([
    ...requiredStages,
    ...(
      Object.entries(input.expectedStageCounts ?? {}) as Array<
        [CompanionLongRunV3CausalRecapStage, number]
      >
    )
      .filter(([, count]) => count > 0)
      .map(([stage]) => stage),
  ]);
  const sourceCatalog = evidenceSourceCatalog(input.evidence);
  for (const stage of stagesRequiringPrompt) {
    for (const record of chain.records.get(stage) ?? []) {
      const projectedRecords =
        lifeContextInspection?.value === undefined
          ? []
          : findPromptRecordsById(lifeContextInspection.value, record.id);
      if (projectedRecords.length !== 1)
        issues.push(
          `causal_record_projection_${projectedRecords.length === 0 ? "missing" : "ambiguous"}:${stage}:${record.id}:actual_${String(projectedRecords.length)}`,
        );
      const projectedRecordText =
        projectedRecords.length === 1
          ? JSON.stringify(projectedRecords[0])
          : "";
      if (record.sourceIds.length === 0)
        issues.push(`causal_record_missing_source:${stage}:${record.id}`);
      for (const sourceId of record.sourceIds) {
        if (!sourceCatalog.all.has(sourceId))
          issues.push(
            `causal_source_missing:${stage}:${record.id}:${sourceId}`,
          );
        if (prompt !== "" && !promptContainsValue(prompt, sourceId))
          issues.push(
            `causal_source_not_in_prompt:${stage}:${record.id}:${sourceId}`,
          );
        if (
          projectedRecordText !== "" &&
          !promptContainsValue(projectedRecordText, sourceId)
        )
          issues.push(
            `causal_source_not_in_record:${stage}:${record.id}:${sourceId}`,
          );
      }
      for (const backlinkId of record.backlinkIds) {
        if (prompt !== "" && !promptContainsValue(prompt, backlinkId))
          issues.push(
            `causal_backlink_not_in_prompt:${stage}:${record.id}:${backlinkId}`,
          );
        if (
          projectedRecordText !== "" &&
          !promptContainsValue(projectedRecordText, backlinkId)
        )
          issues.push(
            `causal_backlink_not_in_record:${stage}:${record.id}:${backlinkId}`,
          );
      }
      if (prompt !== "" && !promptContainsValue(prompt, record.id))
        issues.push(`causal_record_id_not_in_prompt:${stage}:${record.id}`);
      if (
        prompt !== "" &&
        !promptContainsAnyValue(prompt, record.semanticValues)
      )
        issues.push(
          `causal_record_summary_not_in_prompt:${stage}:${record.id}`,
        );
      if (
        projectedRecordText !== "" &&
        !promptContainsAnyValue(projectedRecordText, record.semanticValues)
      )
        issues.push(
          `causal_record_summary_not_in_projection:${stage}:${record.id}`,
        );
    }
  }

  const promptedMemories = validatePromptedDurableMemories({
    evidence: input.evidence,
    prompt,
    requiredMemoryIds: input.requiredMemoryIds ?? [],
    minimumDurableMemories: input.minimumDurableMemories ?? 0,
  });
  issues.push(...promptedMemories.issues);

  return {
    passed: issues.length === 0,
    issues,
    actual: {
      dilemmaId: input.dilemmaId,
      decisionId: chain.decisionId,
      stageRecordIds: Object.fromEntries(
        [...chain.records.entries()].map(([stage, records]) => [
          stage,
          records.map((record) => record.id),
        ]),
      ),
      promptedDurableMemoryIds: promptedMemories.validMemoryIds,
    },
  };
}

/**
 * Relationship continuity is a composite assertion: the relevant causal chain
 * must be present and traceable, while configured durable boundary/repair
 * memory groups must independently occur in the primary prompt.
 */
export function validateCompanionLongRunV3RelationshipContinuityGrounding(
  input: CompanionLongRunV3RelationshipContinuityValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const causal = validateCompanionLongRunV3CausalRecapProvenance({
    snapshot: input.snapshot,
    evidence: input.evidence,
    promptCalls: input.promptCalls,
    dilemmaId: input.dilemmaId,
    ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
    requiredStages: input.requiredCausalStages,
    ...(input.expectedStageCounts === undefined
      ? {}
      : { expectedStageCounts: input.expectedStageCounts }),
  });
  const issues = [...causal.issues];
  const primary = primaryPromptCalls(input.promptCalls);
  const prompt = primary.length === 1 ? combinedPrompt(primary[0]!) : "";
  const lifeContextInspection =
    primary.length === 1
      ? inspectLabeledJsonSegment(prompt, "LIFE_CONTEXT_JSON")
      : undefined;
  const milestoneGrounding = validateRelationshipMilestoneGrounding({
    snapshot: input.snapshot,
    decisionId: input.decisionId,
    lifeContext: lifeContextInspection?.value,
    minimumPromptedMilestones: input.minimumPromptedMilestones ?? 1,
  });
  issues.push(...milestoneGrounding.issues);
  const allEvidenceRows = rawRecordArray(input.evidence.memoryEvidence);
  const memories = rawRecordArray(input.evidence.memories);
  const messages = rawById(input.evidence.messages);
  const validPromptMemories = memories.filter((memory) =>
    durablePromptMemoryValid(memory, allEvidenceRows, input.evidence, prompt),
  );
  const matches = input.requiredMemoryGroups.map((group) => ({
    group,
    memoryIds: validPromptMemories
      .filter((memory) =>
        memoryMatchesRecallGroup(memory, group, allEvidenceRows, messages),
      )
      .flatMap((memory) => {
        const id = nonEmptyRawString(memory["id"]);
        return id === undefined ? [] : [id];
      }),
  }));
  for (const match of matches) {
    if (!memoryGroupHasConstraint(match.group))
      issues.push(
        `invalid_required_memory_group:${safeIssueLabel(match.group.label)}`,
      );
    if (match.memoryIds.length === 0)
      issues.push(
        `required_memory_group_missing:${safeIssueLabel(match.group.label)}`,
      );
  }
  if (
    input.requireDistinctMemoryGroups === true &&
    !hasDistinctGroupAssignment(matches.map((match) => match.memoryIds))
  )
    issues.push("required_memory_groups_not_distinct");
  const matchedMemoryIds = uniqueStrings(
    matches.flatMap((match) => match.memoryIds),
  );
  const minimum =
    input.minimumDurableMemories ?? input.requiredMemoryGroups.length;
  if (matchedMemoryIds.length < minimum)
    issues.push(
      `minimum_relationship_memories_not_met:expected_${String(minimum)}:actual_${String(matchedMemoryIds.length)}`,
    );

  return {
    passed: issues.length === 0,
    issues,
    actual: {
      causal: causal.actual,
      relationshipMilestones: milestoneGrounding.actual,
      memoryGroups: matches,
      matchedMemoryIds,
    },
  };
}

function validateRelationshipMilestoneGrounding(input: {
  snapshot: CompanionLongRunV3Snapshot;
  decisionId: string | undefined;
  lifeContext: Record<string, unknown> | undefined;
  minimumPromptedMilestones: number;
}): {
  issues: string[];
  actual: {
    relevantMilestoneIds: string[];
    promptedMilestoneIds: string[];
  };
} {
  const issues: string[] = [];
  if (input.decisionId === undefined) {
    return {
      issues: ["relationship_milestone_decision_missing"],
      actual: { relevantMilestoneIds: [], promptedMilestoneIds: [] },
    };
  }
  const decisionId = input.decisionId;
  if (
    !Number.isInteger(input.minimumPromptedMilestones) ||
    input.minimumPromptedMilestones < 1
  )
    issues.push("invalid_minimum_prompted_relationship_milestones");

  const decision = input.snapshot.decisions.find(
    (item) => item.id === decisionId,
  );
  const interventionIds = new Set(decision?.supportInterventionIds ?? []);
  const outcomeIds = new Set(
    input.snapshot.outcomes
      .filter((item) => item.decisionId === decisionId)
      .map((item) => item.id),
  );
  const reflectionIds = new Set(
    input.snapshot.reflections
      .filter(
        (item) =>
          item.decisionId === decisionId ||
          (item.outcomeId !== undefined && outcomeIds.has(item.outcomeId)),
      )
      .map((item) => item.id),
  );
  const continuityKinds = new Set<RelationshipMilestone["kind"]>([
    "shared_decision",
    "disagreement",
    "repair",
    "turning_point",
  ]);
  const relevant = input.snapshot.relationshipMilestones.filter(
    (milestone) =>
      continuityKinds.has(milestone.kind) &&
      (milestone.decisionIds.includes(decisionId) ||
        milestone.interventionIds.some((id) => interventionIds.has(id)) ||
        milestone.outcomeIds.some((id) => outcomeIds.has(id)) ||
        milestone.reflectionIds.some((id) => reflectionIds.has(id))),
  );
  if (relevant.length === 0)
    issues.push(`relationship_milestone_missing_for_decision:${decisionId}`);

  const interventions = byId(input.snapshot.supportInterventions);
  const decisions = byId(input.snapshot.decisions);
  const outcomes = byId(input.snapshot.outcomes);
  const reflections = byId(input.snapshot.reflections);
  const sourceCatalog = evidenceSourceCatalog(input.snapshot);
  const promptedMilestoneIds: string[] = [];
  for (const milestone of relevant) {
    validatePersistedSourceIds(
      `relationship_milestone:${milestone.id}`,
      milestone.sourceMessageIds,
      sourceCatalog,
      "missing_source_message",
      issues,
    );
    for (const [kind, ids, catalog] of [
      ["intervention", milestone.interventionIds, interventions],
      ["decision", milestone.decisionIds, decisions],
      ["outcome", milestone.outcomeIds, outcomes],
      ["reflection", milestone.reflectionIds, reflections],
    ] as const) {
      for (const id of ids) {
        const linked = catalog.get(id);
        if (linked === undefined) {
          issues.push(
            `relationship_milestone:${milestone.id}:missing_${kind}:${id}`,
          );
        } else {
          compareOwnership(
            `relationship_milestone:${milestone.id}:${kind}:${id}`,
            milestone,
            linked,
            issues,
          );
        }
      }
    }

    const projected =
      input.lifeContext === undefined
        ? []
        : findPromptRecordsById(input.lifeContext, milestone.id);
    if (projected.length > 1)
      issues.push(
        `relationship_milestone_projection_ambiguous:${milestone.id}:actual_${String(projected.length)}`,
      );
    if (projected.length !== 1) continue;
    promptedMilestoneIds.push(milestone.id);
    const projectedText = JSON.stringify(projected[0]);
    for (const sourceId of milestone.sourceMessageIds) {
      if (!promptContainsValue(projectedText, sourceId))
        issues.push(
          `relationship_milestone_source_not_in_record:${milestone.id}:${sourceId}`,
        );
    }
    for (const backlinkId of [
      ...milestone.interventionIds,
      ...milestone.decisionIds,
      ...milestone.outcomeIds,
      ...milestone.reflectionIds,
    ]) {
      if (!promptContainsValue(projectedText, backlinkId))
        issues.push(
          `relationship_milestone_backlink_not_in_record:${milestone.id}:${backlinkId}`,
        );
    }
    if (!promptContainsValue(projectedText, milestone.kind))
      issues.push(`relationship_milestone_kind_not_in_record:${milestone.id}`);
    if (!promptContainsValue(projectedText, milestone.summary))
      issues.push(
        `relationship_milestone_summary_not_in_record:${milestone.id}`,
      );
  }
  if (promptedMilestoneIds.length < input.minimumPromptedMilestones)
    issues.push(
      `minimum_prompted_relationship_milestones_not_met:expected_${String(input.minimumPromptedMilestones)}:actual_${String(promptedMilestoneIds.length)}`,
    );
  return {
    issues,
    actual: {
      relevantMilestoneIds: relevant.map((item) => item.id),
      promptedMilestoneIds,
    },
  };
}

export function validateCompanionLongRunV3BidirectionalCausality(
  input: CompanionLongRunV3BidirectionalValidationInput,
): CompanionLongRunV3FailClosedValidation {
  const issues: string[] = [];
  const snapshot = input.snapshot;
  const userDecisions = snapshot.decisions.filter(
    (decision) =>
      decision.subject === "user" &&
      decision.authority === "delegated" &&
      decision.status === "current",
  );
  if (userDecisions.length !== 1)
    issues.push(
      `expected_one_user_decision:actual_${String(userDecisions.length)}`,
    );
  const userDecision = userDecisions[0];
  const userActions =
    userDecision === undefined
      ? []
      : snapshot.actions.filter(
          (action) =>
            action.decisionId === userDecision.id &&
            action.subject === "user" &&
            action.performedBy === "user" &&
            action.sourceEvidenceIds.length > 0,
        );
  const userOutcomes =
    userDecision === undefined
      ? []
      : snapshot.outcomes.filter(
          (outcome) =>
            outcome.decisionId === userDecision.id &&
            outcome.valence === "mixed" &&
            outcome.sourceEvidenceIds.length > 0 &&
            outcome.actionIds.some((id) =>
              userActions.some((action) => action.id === id),
            ),
        );
  const userReflections =
    userDecision === undefined
      ? []
      : snapshot.reflections.filter(
          (reflection) =>
            reflection.decisionId === userDecision.id &&
            reflection.subject === "user" &&
            reflection.reflectedBy === "user" &&
            reflection.sourceMessageIds.length > 0 &&
            reflection.outcomeId !== undefined &&
            userOutcomes.some((outcome) => outcome.id === reflection.outcomeId),
        );
  if (userActions.length === 0) issues.push("user_action_missing");
  if (userOutcomes.length === 0) issues.push("user_mixed_outcome_missing");
  if (userReflections.length === 0) issues.push("user_reflection_missing");

  const characterDilemmas = snapshot.dilemmas.filter(
    (dilemma) =>
      dilemma.id === input.characterDilemmaId &&
      dilemma.subject === "character",
  );
  if (characterDilemmas.length !== 1)
    issues.push(
      `expected_one_character_dilemma:actual_${String(characterDilemmas.length)}`,
    );
  const characterSupports = snapshot.supportInterventions.filter(
    (support) =>
      support.dilemmaId === input.characterDilemmaId &&
      support.offeredBy === "user" &&
      support.receivedBy === "character" &&
      support.sourceMessageId.length > 0,
  );
  const characterDecisions = snapshot.decisions.filter(
    (decision) =>
      decision.dilemmaId === input.characterDilemmaId &&
      decision.subject === "character" &&
      decision.authority === "subject" &&
      decision.decidedBy === "character" &&
      decision.status === "current" &&
      decision.supportInterventionIds.some((id) =>
        characterSupports.some((support) => support.id === id),
      ),
  );
  const characterDecisionIds = new Set(
    characterDecisions.map((decision) => decision.id),
  );
  const characterActions = snapshot.actions.filter(
    (action) =>
      characterDecisionIds.has(action.decisionId) &&
      action.subject === "character" &&
      action.performedBy === "character" &&
      action.sourceEvidenceIds.length > 0,
  );
  const characterOutcomes = snapshot.outcomes.filter(
    (outcome) =>
      characterDecisionIds.has(outcome.decisionId) &&
      outcome.valence === "mixed" &&
      outcome.sourceEvidenceIds.length > 0 &&
      outcome.actionIds.some((id) =>
        characterActions.some((action) => action.id === id),
      ),
  );
  const characterReflections = snapshot.reflections.filter(
    (reflection) =>
      reflection.subject === "character" &&
      reflection.reflectedBy === "character" &&
      reflection.decisionId !== undefined &&
      characterDecisionIds.has(reflection.decisionId) &&
      reflection.outcomeId !== undefined &&
      characterOutcomes.some(
        (outcome) => outcome.id === reflection.outcomeId,
      ) &&
      reflection.sourceMessageIds.length > 0,
  );

  const stageOrder: readonly CompanionLongRunV3CharacterCausalStage[] = [
    "dilemma",
    "user_to_character_support",
    "character_decision_and_action",
    "mixed_outcome",
    "character_reflection",
  ];
  const requiredIndex = stageOrder.indexOf(input.requiredCharacterStage);
  if (requiredIndex >= 1 && characterSupports.length === 0)
    issues.push("character_support_missing");
  if (requiredIndex >= 2 && characterDecisions.length !== 1)
    issues.push(
      `expected_one_character_decision:actual_${String(characterDecisions.length)}`,
    );
  if (requiredIndex >= 2 && characterActions.length === 0)
    issues.push("character_action_missing");
  if (requiredIndex >= 3 && characterOutcomes.length === 0)
    issues.push("character_mixed_outcome_missing");
  if (requiredIndex >= 4 && characterReflections.length === 0)
    issues.push("character_reflection_missing");

  return {
    passed: issues.length === 0,
    issues,
    actual: {
      userDecisionIds: userDecisions.map((item) => item.id),
      userActionIds: userActions.map((item) => item.id),
      userOutcomeIds: userOutcomes.map((item) => item.id),
      userReflectionIds: userReflections.map((item) => item.id),
      characterDilemmaIds: characterDilemmas.map((item) => item.id),
      characterSupportIds: characterSupports.map((item) => item.id),
      characterDecisionIds: characterDecisions.map((item) => item.id),
      characterActionIds: characterActions.map((item) => item.id),
      characterOutcomeIds: characterOutcomes.map((item) => item.id),
      characterReflectionIds: characterReflections.map((item) => item.id),
    },
  };
}

interface CompanionLongRunV3CausalPromptRecord {
  stage: CompanionLongRunV3CausalRecapStage;
  id: string;
  sourceIds: readonly string[];
  /** Structural ids that prove this row is linked to the selected chain. */
  backlinkIds: readonly string[];
  semanticValues: readonly (string | undefined)[];
}

function causalPromptRecords(
  input: Pick<
    CompanionLongRunV3CausalRecapValidationInput,
    "snapshot" | "dilemmaId" | "decisionId"
  >,
  issues: string[],
): {
  records: Map<
    CompanionLongRunV3CausalRecapStage,
    CompanionLongRunV3CausalPromptRecord[]
  >;
  decisionId?: string;
} {
  const records = new Map<
    CompanionLongRunV3CausalRecapStage,
    CompanionLongRunV3CausalPromptRecord[]
  >(
    (
      [
        "dilemma",
        "support",
        "decision",
        "action",
        "outcome",
        "reflection",
      ] as const
    ).map((stage) => [stage, []]),
  );
  const dilemma = input.snapshot.dilemmas.find(
    (item) => item.id === input.dilemmaId,
  );
  if (dilemma === undefined) {
    issues.push(`causal_dilemma_missing:${input.dilemmaId}`);
    return { records };
  }
  records.get("dilemma")!.push({
    stage: "dilemma",
    id: dilemma.id,
    sourceIds: uniqueStrings(dilemma.sourceMessageIds),
    backlinkIds: [],
    semanticValues: [dilemma.summary, dilemma.title],
  });

  const dilemmaDecisions = input.snapshot.decisions.filter(
    (item) => item.dilemmaId === dilemma.id,
  );
  let selectedDecision: DecisionRecord | undefined;
  if (input.decisionId !== undefined) {
    selectedDecision = dilemmaDecisions.find(
      (item) => item.id === input.decisionId,
    );
    if (selectedDecision === undefined)
      issues.push(`causal_decision_missing:${input.decisionId}`);
  } else {
    const current = dilemmaDecisions.filter(
      (item) => item.status === "current",
    );
    const eligible = current.length > 0 ? current : dilemmaDecisions;
    if (eligible.length > 1)
      issues.push(
        `expected_one_causal_decision:actual_${String(eligible.length)}`,
      );
    if (eligible.length === 1) selectedDecision = eligible[0];
  }

  const supportById = byId(input.snapshot.supportInterventions);
  const supports =
    selectedDecision === undefined
      ? input.snapshot.supportInterventions.filter(
          (item) => item.dilemmaId === dilemma.id,
        )
      : selectedDecision.supportInterventionIds.flatMap((id) => {
          const item = supportById.get(id);
          if (item === undefined) {
            issues.push(`causal_support_reference_missing:${id}`);
            return [];
          }
          return [item];
        });
  for (const support of supports) {
    if (support.dilemmaId !== dilemma.id)
      issues.push(`causal_support_wrong_dilemma:${support.id}`);
    records.get("support")!.push({
      stage: "support",
      id: support.id,
      sourceIds: [support.sourceMessageId],
      backlinkIds: support.dilemmaId === undefined ? [] : [support.dilemmaId],
      semanticValues: [support.summary, support.intendedEffect],
    });
  }

  if (selectedDecision === undefined) return { records };
  records.get("decision")!.push({
    stage: "decision",
    id: selectedDecision.id,
    sourceIds: uniqueStrings(selectedDecision.sourceMessageIds),
    backlinkIds: uniqueStrings([
      selectedDecision.dilemmaId,
      ...selectedDecision.supportInterventionIds,
    ]),
    semanticValues: [
      selectedDecision.selectionSummary,
      selectedDecision.reasoningSummary,
    ],
  });
  const actions = input.snapshot.actions.filter(
    (item) => item.decisionId === selectedDecision.id,
  );
  for (const action of actions) {
    records.get("action")!.push({
      stage: "action",
      id: action.id,
      sourceIds: uniqueStrings(action.sourceEvidenceIds),
      backlinkIds: [action.decisionId],
      semanticValues: [action.summary],
    });
  }
  const outcomes = input.snapshot.outcomes.filter(
    (item) => item.decisionId === selectedDecision.id,
  );
  for (const outcome of outcomes) {
    records.get("outcome")!.push({
      stage: "outcome",
      id: outcome.id,
      sourceIds: uniqueStrings(outcome.sourceEvidenceIds),
      backlinkIds: uniqueStrings([outcome.decisionId, ...outcome.actionIds]),
      semanticValues: [outcome.summary, ...outcome.consequenceFacts],
    });
  }
  const outcomeIds = new Set(outcomes.map((item) => item.id));
  const reflections = input.snapshot.reflections.filter(
    (item) =>
      item.decisionId === selectedDecision.id ||
      (item.outcomeId !== undefined && outcomeIds.has(item.outcomeId)),
  );
  for (const reflection of reflections) {
    records.get("reflection")!.push({
      stage: "reflection",
      id: reflection.id,
      sourceIds: uniqueStrings(reflection.sourceMessageIds),
      backlinkIds: uniqueStrings(
        [reflection.decisionId, reflection.outcomeId].filter(
          (value): value is string => value !== undefined,
        ),
      ),
      semanticValues: [reflection.summary, ...reflection.lessons],
    });
  }
  return { records, decisionId: selectedDecision.id };
}

function memoryRecallExpectationIssues(input: {
  expectation: CompanionLongRunV3MemoryRecallExpectation | undefined;
  selectedMemoryIds: readonly string[];
  memories: Map<string, Record<string, unknown>>;
  selectedEvidenceRows: readonly Record<string, unknown>[];
  messages: Map<string, Record<string, unknown>>;
}): string[] {
  const expectation = input.expectation;
  if (expectation === undefined) return [];
  const issues: string[] = [];
  const minimum = expectation.minimumSelectedMemories ?? 0;
  if (!Number.isInteger(minimum) || minimum < 0) {
    issues.push("invalid_minimum_selected_memories");
  } else if (input.selectedMemoryIds.length < minimum) {
    issues.push(
      `minimum_selected_memories_not_met:expected_${String(minimum)}:actual_${String(input.selectedMemoryIds.length)}`,
    );
  }
  const selectedMemories = input.selectedMemoryIds.flatMap((id) => {
    const memory = input.memories.get(id);
    return memory === undefined ? [] : [memory];
  });
  for (const forbidden of expectation.forbiddenContent ?? []) {
    if (
      selectedMemories.some((memory) =>
        textIncludes(nonEmptyRawString(memory["content"]), forbidden),
      )
    )
      issues.push(
        `forbidden_selected_memory_content:${safeIssueLabel(forbidden)}`,
      );
  }
  const selectedSourceIds = selectedMessageSourceIds(
    input.selectedEvidenceRows,
  );
  for (const sourceId of expectation.requiredSourceMessageIds ?? []) {
    if (!selectedSourceIds.has(sourceId))
      issues.push(`required_source_message_missing:${sourceId}`);
  }
  for (const ordinal of expectation.requiredSourceMessageOrdinals ?? []) {
    if (!sourceSetContainsOrdinal(selectedSourceIds, input.messages, ordinal))
      issues.push(`required_source_message_ordinal_missing:${String(ordinal)}`);
  }
  for (const sourceId of expectation.forbiddenSourceMessageIds ?? []) {
    if (selectedSourceIds.has(sourceId))
      issues.push(`forbidden_source_message_selected:${sourceId}`);
  }
  for (const ordinal of expectation.forbiddenSourceMessageOrdinals ?? []) {
    if (sourceSetContainsOrdinal(selectedSourceIds, input.messages, ordinal))
      issues.push(
        `forbidden_source_message_ordinal_selected:${String(ordinal)}`,
      );
  }

  const groups = expectation.requiredGroups ?? [];
  const matches = groups.map((group) => {
    if (!memoryGroupHasConstraint(group))
      issues.push(
        `invalid_required_memory_group:${safeIssueLabel(group.label)}`,
      );
    return selectedMemories
      .filter((memory) =>
        memoryMatchesRecallGroup(
          memory,
          group,
          input.selectedEvidenceRows,
          input.messages,
        ),
      )
      .flatMap((memory) => {
        const id = nonEmptyRawString(memory["id"]);
        return id === undefined ? [] : [id];
      });
  });
  groups.forEach((group, index) => {
    if ((matches[index] ?? []).length === 0)
      issues.push(
        `required_memory_group_missing:${safeIssueLabel(group.label)}`,
      );
  });
  if (
    expectation.requireDistinctGroupMatches === true &&
    !hasDistinctGroupAssignment(matches)
  )
    issues.push("required_memory_groups_not_distinct");
  return issues;
}

function memoryMatchesRecallGroup(
  memory: Record<string, unknown>,
  group: CompanionLongRunV3MemoryRecallRequirementGroup,
  evidenceRows: readonly Record<string, unknown>[],
  messages: Map<string, Record<string, unknown>>,
): boolean {
  const memoryId = nonEmptyRawString(memory["id"]);
  if (memoryId === undefined) return false;
  if (
    group.memoryIds !== undefined &&
    group.memoryIds.length > 0 &&
    !group.memoryIds.includes(memoryId)
  )
    return false;
  const subjectKey = memorySubjectKey(memory);
  if (
    group.subjectKeys !== undefined &&
    group.subjectKeys.length > 0 &&
    (subjectKey === undefined || !group.subjectKeys.includes(subjectKey))
  )
    return false;
  const memoryEvidenceRows = evidenceRows.filter(
    (row) => row["memory_id"] === memoryId,
  );
  const groundingText = [
    nonEmptyRawString(memory["content"]),
    ...memoryEvidenceRows.flatMap((row) => [
      nonEmptyRawString(row["quote"]),
      nonEmptyRawString(row["context_summary"] ?? row["contextSummary"]),
      row["source_type"] === "message"
        ? nonEmptyRawString(messages.get(String(row["source_id"]))?.["content"])
        : undefined,
    ]),
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n");
  if (
    (group.contentIncludesAll ?? []).some(
      (fragment) => !textIncludes(groundingText, fragment),
    )
  )
    return false;
  if (
    group.contentIncludesAny !== undefined &&
    group.contentIncludesAny.length > 0 &&
    !group.contentIncludesAny.some((fragment) =>
      textIncludes(groundingText, fragment),
    )
  )
    return false;
  const sources = selectedMessageSourceIds(memoryEvidenceRows);
  if (
    (group.requiredSourceMessageIds ?? []).some(
      (sourceId) => !sources.has(sourceId),
    )
  )
    return false;
  if (
    (group.requiredSourceMessageOrdinals ?? []).some(
      (ordinal) => !sourceSetContainsOrdinal(sources, messages, ordinal),
    )
  )
    return false;
  return true;
}

function memoryGroupHasConstraint(
  group: CompanionLongRunV3MemoryRecallRequirementGroup,
): boolean {
  return [
    group.subjectKeys,
    group.memoryIds,
    group.contentIncludesAll,
    group.contentIncludesAny,
    group.requiredSourceMessageIds,
    group.requiredSourceMessageOrdinals,
  ].some((values) => values !== undefined && values.length > 0);
}

function validatePromptedDurableMemories(input: {
  evidence: CompanionLongRunV3MemoryProjection;
  prompt: string;
  requiredMemoryIds: readonly string[];
  minimumDurableMemories: number;
}): { issues: string[]; validMemoryIds: string[] } {
  const issues: string[] = [];
  const memories = rawById(input.evidence.memories);
  const evidenceRows = rawRecordArray(input.evidence.memoryEvidence);
  const validMemoryIds = [...memories.values()].flatMap((memory) => {
    const id = nonEmptyRawString(memory["id"]);
    return id !== undefined &&
      durablePromptMemoryValid(
        memory,
        evidenceRows,
        input.evidence,
        input.prompt,
      )
      ? [id]
      : [];
  });
  for (const memoryId of input.requiredMemoryIds) {
    const memory = memories.get(memoryId);
    if (memory === undefined) {
      issues.push(`required_durable_memory_missing:${memoryId}`);
      continue;
    }
    if (memory["status"] !== "active")
      issues.push(`required_durable_memory_not_active:${memoryId}`);
    if (nonNullRawValue(memory["superseded_by_id"] ?? memory["supersededById"]))
      issues.push(`required_durable_memory_superseded:${memoryId}`);
    if (nonNullRawValue(memory["merged_into_id"] ?? memory["mergedIntoId"]))
      issues.push(`required_durable_memory_merged:${memoryId}`);
    const rows = evidenceRows.filter((row) => row["memory_id"] === memoryId);
    if (rows.length === 0)
      issues.push(`required_durable_memory_missing_evidence:${memoryId}`);
    for (const row of rows) {
      if (!memoryEvidenceSourcePersisted(row, input.evidence))
        issues.push(
          `required_durable_memory_source_missing:${memoryId}:${nonEmptyRawString(row["id"]) ?? "<missing>"}`,
        );
    }
    if (
      !promptContainsAnyValue(input.prompt, [
        memoryId,
        nonEmptyRawString(memory["content"]),
      ])
    )
      issues.push(`required_durable_memory_not_in_prompt:${memoryId}`);
  }
  if (
    !Number.isInteger(input.minimumDurableMemories) ||
    input.minimumDurableMemories < 0
  ) {
    issues.push("invalid_minimum_durable_memories");
  } else if (validMemoryIds.length < input.minimumDurableMemories) {
    issues.push(
      `minimum_prompted_durable_memories_not_met:expected_${String(input.minimumDurableMemories)}:actual_${String(validMemoryIds.length)}`,
    );
  }
  return { issues, validMemoryIds };
}

function durablePromptMemoryValid(
  memory: Record<string, unknown>,
  evidenceRows: readonly Record<string, unknown>[],
  projection: CompanionLongRunV3MemoryProjection,
  prompt: string,
): boolean {
  const id = nonEmptyRawString(memory["id"]);
  if (
    id === undefined ||
    memory["status"] !== "active" ||
    nonNullRawValue(memory["superseded_by_id"] ?? memory["supersededById"]) ||
    nonNullRawValue(memory["merged_into_id"] ?? memory["mergedIntoId"])
  )
    return false;
  const rows = evidenceRows.filter((row) => row["memory_id"] === id);
  return (
    rows.length > 0 &&
    rows.every((row) => memoryEvidenceSourcePersisted(row, projection)) &&
    promptContainsAnyValue(prompt, [id, nonEmptyRawString(memory["content"])])
  );
}

function memoryEvidenceSourcePersisted(
  row: Record<string, unknown>,
  projection: CompanionLongRunV3MemoryProjection,
): boolean {
  const sourceId = nonEmptyRawString(row["source_id"]);
  if (sourceId === undefined) return false;
  const type = row["source_type"];
  if (type === "message") return rawById(projection.messages).has(sourceId);
  if (type === "activity_event")
    return rawById(projection.activityEvents ?? []).has(sourceId);
  if (type === "character_source")
    return rawById(projection.domainEvents ?? []).has(sourceId);
  return false;
}

function evidenceSourceCatalog(projection: {
  messages: readonly unknown[];
  activityEvents?: readonly unknown[];
  domainEvents?: readonly unknown[];
}): {
  all: Set<string>;
} {
  return {
    all: new Set([
      ...rawById(projection.messages).keys(),
      ...rawById(projection.activityEvents ?? []).keys(),
      ...rawById(projection.domainEvents ?? []).keys(),
    ]),
  };
}

function validatePersistedSourceIds(
  issuePrefix: string,
  sourceIds: readonly string[],
  catalog: { all: ReadonlySet<string> },
  missingIssue: string,
  issues: string[],
): void {
  const ids = sourceIds.filter((id) => id.trim() !== "");
  if (ids.length === 0) issues.push(`${issuePrefix}:${missingIssue}`);
  for (const sourceId of ids) {
    if (!catalog.all.has(sourceId))
      issues.push(`${issuePrefix}:source_not_persisted:${sourceId}`);
  }
}

function selectedMessageSourceIds(
  evidenceRows: readonly Record<string, unknown>[],
): Set<string> {
  return new Set(
    evidenceRows.flatMap((row) => {
      if (row["source_type"] !== "message") return [];
      const id = nonEmptyRawString(row["source_id"]);
      return id === undefined ? [] : [id];
    }),
  );
}

function sourceSetContainsOrdinal(
  sourceIds: ReadonlySet<string>,
  messages: Map<string, Record<string, unknown>>,
  ordinal: number,
): boolean {
  return [...sourceIds].some(
    (sourceId) => messageCandidateOrdinal(messages.get(sourceId)) === ordinal,
  );
}

function messageCandidateOrdinal(
  message: Record<string, unknown> | undefined,
): number | undefined {
  if (message === undefined) return undefined;
  const direct = [
    message["candidate_ordinal"],
    message["candidateOrdinal"],
    message["turn_ordinal"],
    message["turnOrdinal"],
    message["logical_ordinal"],
    message["logicalOrdinal"],
  ].find((value) => typeof value === "number" && Number.isInteger(value));
  if (typeof direct === "number") return direct;
  const metadata = asRawRecord(message["metadata"] ?? message["metadata_json"]);
  const nested = [
    metadata?.["candidateOrdinal"],
    metadata?.["candidate_number"],
    metadata?.["turnOrdinal"],
    metadata?.["logicalOrdinal"],
  ].find((value) => typeof value === "number" && Number.isInteger(value));
  if (typeof nested === "number") return nested;
  const clientId = nonEmptyRawString(
    message["client_message_id"] ?? message["clientMessageId"],
  );
  const match = clientId?.match(
    /(?:shared|branch-[ab])-(\d{1,3})(?:$|[^0-9])/iu,
  );
  if (match?.[1] !== undefined) return Number(match[1]);
  const suffix = clientId?.match(/-(\d{3})$/u);
  return suffix?.[1] === undefined ? undefined : Number(suffix[1]);
}

function memorySubjectKey(memory: Record<string, unknown>): string | undefined {
  const direct = nonEmptyRawString(
    memory["claim_subject_key"] ?? memory["claimSubjectKey"],
  );
  if (direct !== undefined) return direct;
  const claim = asRawRecord(memory["claim"]);
  return nonEmptyRawString(claim?.["subjectKey"] ?? claim?.["subject_key"]);
}

function hasDistinctGroupAssignment(
  groups: readonly (readonly string[])[],
): boolean {
  const ordered = [...groups].sort((left, right) => left.length - right.length);
  const search = (index: number, used: Set<string>): boolean => {
    if (index >= ordered.length) return true;
    for (const id of ordered[index] ?? []) {
      if (used.has(id)) continue;
      used.add(id);
      if (search(index + 1, used)) return true;
      used.delete(id);
    }
    return false;
  };
  return search(0, new Set());
}

function promptContainsAnyValue(
  prompt: string,
  values: readonly (string | undefined)[],
): boolean {
  return values.some(
    (value) => value !== undefined && promptContainsValue(prompt, value),
  );
}

function promptContainsValue(prompt: string, value: string): boolean {
  const needle = normalizeSearchText(value);
  return needle !== "" && normalizeSearchText(prompt).includes(needle);
}

function textIncludes(content: string | undefined, fragment: string): boolean {
  return (
    content !== undefined &&
    normalizeSearchText(content).includes(normalizeSearchText(fragment))
  );
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function combinedPrompt(call: CompanionLongRunV3PromptCall): string {
  return `${call.system}\n${call.prompt}`;
}

function safeIssueLabel(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized === "" ? "unnamed" : normalized;
}

function nonNullRawValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function rawRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRawRecord(item);
    return record === undefined ? [] : [record];
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function retrievalPromptEvidenceIssues(input: {
  renderedPromptFragment: string;
  persistedEvidenceBundle: Record<string, unknown> | undefined;
  primaryPrompt: string;
}): string[] {
  const issues: string[] = [];
  let renderedValue: unknown;
  try {
    renderedValue = JSON.parse(input.renderedPromptFragment);
  } catch {
    return ["retrieval_rendered_prompt_fragment_invalid"];
  }
  const renderedRoot = asRawRecord(renderedValue);
  const renderedMemoryEvidence = asRawRecord(renderedRoot?.["memoryEvidence"]);
  if (renderedRoot === undefined || renderedMemoryEvidence === undefined) {
    return ["retrieval_rendered_prompt_fragment_invalid"];
  }
  if (
    input.persistedEvidenceBundle === undefined ||
    !canonicalJsonEqual(renderedMemoryEvidence, input.persistedEvidenceBundle)
  ) {
    issues.push("retrieval_rendered_prompt_evidence_bundle_mismatch");
  }

  const referenceContext = inspectLabeledJsonSegment(
    input.primaryPrompt,
    "REFERENCE_CONTEXT_JSON",
  );
  if (referenceContext.value === undefined) {
    issues.push(
      "retrieval_reference_context_missing_or_invalid",
      "retrieval_fragment_not_in_primary_prompt",
    );
    return issues;
  }
  const promptMemoryEvidence = asRawRecord(
    referenceContext.value["memoryEvidence"],
  );
  if (promptMemoryEvidence === undefined) {
    issues.push(
      "retrieval_reference_memory_evidence_missing",
      "retrieval_fragment_not_in_primary_prompt",
    );
    return issues;
  }
  if (!canonicalJsonEqual(renderedMemoryEvidence, promptMemoryEvidence)) {
    issues.push("retrieval_fragment_not_in_primary_prompt");
  }
  return issues;
}

function idempotentReplay(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  if (input.expectReplay !== true) {
    return skippedResult(
      "idempotent_replay",
      "This step is not a declared replay probe.",
    );
  }
  const passed =
    input.idempotentReplay === true &&
    input.before.durableSha256 === input.after.durableSha256 &&
    input.promptCalls.length === 0;
  return hardResult(
    "idempotent_replay",
    passed,
    "A replay returns the persisted result without an LLM call or any durable mutation.",
    {
      expected: {
        idempotentReplay: true,
        durableSha256: input.before.durableSha256,
        promptCallCount: 0,
      },
      actual: {
        idempotentReplay: input.idempotentReplay,
        durableSha256: input.after.durableSha256,
        promptCallCount: input.promptCalls.length,
      },
    },
  );
}

function branchIsolated(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const branch = input.branch;
  if (branch === undefined) {
    return skippedResult(
      "branch_isolated",
      "This step is before the A/B fork or is not a branch probe.",
    );
  }
  const durableText = canonicalLower(branch.durableProjection);
  const assistantText = (branch.assistantText ?? "").toLocaleLowerCase("zh-CN");
  const durableLeaks = branch.forbiddenDurableFragments.filter((fragment) =>
    durableText.includes(fragment.toLocaleLowerCase("zh-CN")),
  );
  const assistantLeaks = (branch.forbiddenAssistantFragments ?? []).filter(
    (fragment) => assistantText.includes(fragment.toLocaleLowerCase("zh-CN")),
  );
  const anchorMatched =
    branch.actualAnchorSha256 === branch.expectedAnchorSha256;
  return hardResult(
    "branch_isolated",
    anchorMatched && durableLeaks.length === 0 && assistantLeaks.length === 0,
    "The branch starts from the frozen T108 anchor and contains no counterfactual branch facts.",
    {
      expected: {
        branch: branch.branch,
        anchorSha256: branch.expectedAnchorSha256,
        noForbiddenFragments: true,
      },
      actual: {
        anchorSha256: branch.actualAnchorSha256,
        durableLeaks,
        assistantLeaks,
      },
    },
  );
}

function promptExcludesFutureSchedule(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const primary = primaryPromptCalls(input.promptCalls);
  if (input.expectReplay === true && primary.length === 0) {
    return hardResult(
      "prompt_excludes_future_schedule",
      true,
      "Replay correctly made no primary prompt containing exact schedule context.",
      { actual: { primaryPromptCount: 0 } },
    );
  }
  const forbiddenLabels = [
    "FUTURE_SCHEDULE_JSON",
    "CURRENT_ACTIVITY_JSON",
  ] as const;
  const offenders = primary.flatMap((call) =>
    forbiddenLabels.flatMap((label) =>
      hasSegment(call, label) ? [{ purpose: call.purpose, label }] : [],
    ),
  );
  return hardResult(
    "prompt_excludes_future_schedule",
    primary.length > 0 && offenders.length === 0,
    "Every primary chat prompt omits the retired FUTURE_SCHEDULE_JSON and CURRENT_ACTIVITY_JSON exact-time segments.",
    {
      expected: { forbiddenLabels },
      actual: { primaryPromptCount: primary.length, offenders },
    },
  );
}

function promptIncludesLifeContext(
  input: CompanionLongRunV3HardAssertionInput,
): CompanionLongRunV3HardGateResult {
  const primary = primaryPromptCalls(input.promptCalls);
  if (input.expectReplay === true && primary.length === 0) {
    return hardResult(
      "prompt_includes_life_context",
      true,
      "Replay correctly reused the prior result without assembling a new LIFE_CONTEXT prompt.",
      { actual: { primaryPromptCount: 0 } },
    );
  }
  const inspection =
    primary.length === 1
      ? inspectLabeledJsonSegment(
          combinedPrompt(primary[0]!),
          "LIFE_CONTEXT_JSON",
        )
      : undefined;
  const issues: string[] = [];
  if (primary.length !== 1)
    issues.push(`expected_one_primary_prompt:actual_${String(primary.length)}`);
  if (inspection?.issue !== undefined) issues.push(inspection.issue);
  return hardResult(
    "prompt_includes_life_context",
    issues.length === 0,
    "The one primary chat prompt contains one complete, object-valued LIFE_CONTEXT_JSON segment bounded by the next prompt label.",
    {
      expected: {
        primaryPromptCount: 1,
        lifeContextOccurrenceCount: 1,
        completeJsonObject: true,
        adjacentLabelBoundary: true,
      },
      actual: {
        primaryPromptCount: primary.length,
        lifeContextOccurrenceCount: inspection?.occurrenceCount ?? 0,
        adjacentLabel: inspection?.adjacentLabel,
        issues,
      },
    },
  );
}

function primaryPromptCalls(
  calls: readonly CompanionLongRunV3PromptCall[],
): readonly CompanionLongRunV3PromptCall[] {
  return calls.filter(
    (call) => call.primaryChat === true || call.purpose === "chat_turn",
  );
}

function hasSegment(
  call: CompanionLongRunV3PromptCall,
  label: string,
): boolean {
  const text = `${call.system}\n${call.prompt}`;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}(?:\\r?\\n|$)`, "u").test(text);
}

function inspectLabeledJsonSegment(
  text: string,
  targetLabel: string,
): {
  occurrenceCount: number;
  adjacentLabel?: string;
  issue?: string;
  value?: Record<string, unknown>;
} {
  const labels = [...text.matchAll(/^([A-Z][A-Z0-9_]{2,})\r?$/gmu)].map(
    (match) => ({
      label: match[1] ?? "",
      start: match.index,
      contentStart: contentStartAfterLabel(text, match.index + match[0].length),
    }),
  );
  const targets = labels.filter((entry) => entry.label === targetLabel);
  if (targets.length !== 1) {
    return {
      occurrenceCount: targets.length,
      issue:
        targets.length === 0
          ? "life_context_segment_missing"
          : `life_context_segment_ambiguous:actual_${String(targets.length)}`,
    };
  }
  const targetIndex = labels.indexOf(targets[0]!);
  const adjacent = labels[targetIndex + 1];
  if (adjacent === undefined) {
    return {
      occurrenceCount: 1,
      issue: "life_context_adjacent_label_missing",
    };
  }
  const body = text.slice(targets[0]!.contentStart, adjacent.start).trim();
  if (body === "") {
    return {
      occurrenceCount: 1,
      adjacentLabel: adjacent.label,
      issue: "life_context_json_empty",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      occurrenceCount: 1,
      adjacentLabel: adjacent.label,
      issue: "life_context_json_invalid_or_truncated",
    };
  }
  const value = asRawRecord(parsed);
  if (value === undefined) {
    return {
      occurrenceCount: 1,
      adjacentLabel: adjacent.label,
      issue: "life_context_json_not_object",
    };
  }
  return { occurrenceCount: 1, adjacentLabel: adjacent.label, value };
}

function contentStartAfterLabel(text: string, labelEnd: number): number {
  if (text.startsWith("\r\n", labelEnd)) return labelEnd + 2;
  if (text.startsWith("\n", labelEnd)) return labelEnd + 1;
  return labelEnd;
}

function findPromptRecordsById(
  value: unknown,
  id: string,
): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = asRawRecord(candidate);
    if (record === undefined) return;
    if (record["id"] === id) matches.push(record);
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return matches;
}

function pressureProjection(episode: PressureEpisode): string {
  return JSON.stringify({
    status: episode.status,
    currentPressure: episode.currentPressure,
    currentClarity: episode.currentClarity,
    currentFeltUnderstood: episode.currentFeltUnderstood,
    latestEvidenceMessageId: episode.latestEvidenceMessageId,
    resolutionEvidenceMessageId: episode.resolutionEvidenceMessageId,
    sourceMessageIds: [...episode.sourceMessageIds].sort(),
  });
}

function checkDirection(
  field: string,
  before: number,
  after: number,
  expected: "increase" | "decrease" | "unchanged" | undefined,
  issues: string[],
): void {
  if (expected === undefined) return;
  const delta = after - before;
  const epsilon = 1e-9;
  const matches =
    expected === "increase"
      ? delta > epsilon
      : expected === "decrease"
        ? delta < -epsilon
        : Math.abs(delta) <= epsilon;
  if (!matches)
    issues.push(`${field}:expected_${expected}:delta_${String(delta)}`);
}

function checkExactValue(
  field: string,
  actual: number,
  expected: number | undefined,
  issues: string[],
): void {
  if (expected === undefined) return;
  if (Math.abs(actual - expected) > 1e-9)
    issues.push(
      `${field}:expected_${String(expected)}:actual_${String(actual)}`,
    );
}

function compareOwnership(
  prefix: string,
  left: { agentId: string },
  right: { agentId: string },
  issues: string[],
): void {
  if (left.agentId !== right.agentId) issues.push(`${prefix}:agent_mismatch`);
}

function actorMatchesSubject(
  actor: "user" | "character" | "joint",
  subject: "user" | "character" | "shared",
): boolean {
  if (subject === "shared") return actor === "joint";
  return actor === subject;
}

function isBefore(candidateUtc: string, predecessorUtc: string): boolean {
  return Date.parse(candidateUtc) < Date.parse(predecessorUtc);
}

function asRawRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyRawString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function rawStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const normalized = nonEmptyRawString(item);
        return normalized === undefined ? [] : [normalized];
      })
    : [];
}

function rawById(
  values: readonly unknown[],
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    const record = asRawRecord(value);
    const id = nonEmptyRawString(record?.["id"]);
    if (record !== undefined && id !== undefined) result.set(id, record);
  }
  return result;
}

function addedRawRecords(
  before: readonly unknown[],
  after: readonly unknown[],
): Array<Record<string, unknown>> {
  const beforeIds = new Set(rawById(before).keys());
  return after.flatMap((value) => {
    const record = asRawRecord(value);
    const id = nonEmptyRawString(record?.["id"]);
    return record !== undefined && (id === undefined || !beforeIds.has(id))
      ? [record]
      : [];
  });
}

function duplicateKeys(
  rows: readonly { idempotencyKey: string }[],
): readonly string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.idempotencyKey, (counts.get(row.idempotencyKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
}

function addedRows<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): readonly T[] {
  const ids = new Set(before.map((row) => row.id));
  return after.filter((row) => !ids.has(row.id));
}

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function sortedIds(rows: readonly { id: string }[]): string[] {
  return rows.map((row) => row.id).sort();
}

function equalStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const currentKey = key(value);
    const group = grouped.get(currentKey) ?? [];
    group.push(value);
    grouped.set(currentKey, group);
  }
  return grouped;
}

function canonicalLower(value: unknown): string {
  return JSON.stringify(sortJson(value)).toLocaleLowerCase("zh-CN");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function hardResult(
  code: CompanionLongRunV3HardGateCode,
  passed: boolean,
  summary: string,
  detail: { expected?: unknown; actual?: unknown } = {},
): CompanionLongRunV3HardGateResult {
  return {
    code,
    status: passed ? "PASS" : "FAIL",
    summary,
    ...(detail.expected === undefined ? {} : { expected: detail.expected }),
    ...(detail.actual === undefined ? {} : { actual: detail.actual }),
  };
}

function skippedResult(
  code: CompanionLongRunV3HardGateCode,
  summary: string,
): CompanionLongRunV3HardGateResult {
  return { code, status: "SKIPPED", summary };
}
