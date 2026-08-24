import { basename, isAbsolute, posix, win32 } from "node:path";

import type { ScenarioAction } from "../scenarios/companion-long-run-types.js";
import { auditCompanionLongRunRecallMetrics } from "./companion-long-run-runner.js";
import type {
  CompanionLongRunRecallMetricAudit,
  CompanionLongRunExecution,
  CompanionLongRunTurnExecution,
  LongRunAssertionResult as ExecutionAssertionResult,
  SafeLlmCall,
  SafeRuntimeSnapshot,
} from "./companion-long-run-runner.js";
import type {
  BuildCompanionLongRunReportInput,
  CompanionLongRunTurnReport,
  LongRunAssertionResult,
  LongRunAuthoritySnapshotReport,
  LongRunChangeReport,
  LongRunContextPlanReport,
  LongRunDomainEventReport,
  LongRunHttpExchangeReport,
  LongRunLlmCallReport,
  LongRunMetricResult,
  LongRunMetricValue,
  LongRunObservationReport,
  LongRunOutcomeReport,
  LongRunPromptSegmentTraceReport,
  LongRunRetrievalReport,
} from "./companion-long-run-report.js";

/**
 * Projects the runner's already-sanitized execution evidence into the stable,
 * narrower report DTO. Unknown keys are deliberately ignored.
 */
export function toCompanionLongRunReportInput(
  execution: CompanionLongRunExecution,
  partialSequence?: number,
): BuildCompanionLongRunReportInput {
  const turns = execution.turns.map((turn) => projectTurn(execution, turn));
  const turnLlmCallIds = new Set(
    execution.turns.flatMap((turn) => turn.llmCalls.map((call) => call.id)),
  );
  const runLlmCalls = execution.llmCalls
    .filter((call) => !turnLlmCallIds.has(call.id))
    .map(projectLlmCall);
  const metrics = projectMetrics(execution.metrics);
  const failure = projectExecutionFailure(execution);
  return {
    runId: execution.runId,
    scenarioVersion: execution.scenarioVersion,
    repoHead: execution.repoHead,
    worktreeDirty: execution.worktreeDirty ?? false,
    gitDiffStat: execution.gitDiffStat ?? "not_collected",
    gitDiffFingerprint: execution.gitDiffFingerprint ?? "not_collected",
    untrackedFileCount: execution.untrackedFileCount ?? 0,
    startedAtUtc: execution.startedAtUtc,
    completedAtUtc: execution.completedAtUtc,
    status: execution.status,
    completionReason: execution.completionReason,
    provider: execution.provider,
    providerMode: execution.providerMode,
    model: execution.model,
    clockMode: execution.clockMode,
    pipelineExpectation: execution.pipelineExpectation,
    requestedTurnCount: execution.requestedTurnCount,
    httpExchangeCount: execution.httpExchangeCount,
    ...(execution.runHttp === undefined
      ? {}
      : { runHttp: execution.runHttp.map(projectHttpExchange) }),
    turns,
    runLlmCalls,
    runAssertions: execution.assertions
      .filter((assertion) => assertion.scope === "run")
      .map(projectAssertion),
    metrics,
    metricDetails: projectMetricDetails(
      metrics,
      execution.requestedTurnCount,
      auditCompanionLongRunRecallMetrics(execution.turns),
    ),
    artifactLabels: {
      database: safeArtifactLabel(execution.databaseLabel),
      log: safeArtifactLabel(execution.logPath),
    },
    ...(failure === undefined ? {} : { failure }),
    ...(partialSequence === undefined ? {} : { partialSequence }),
  };
}

function projectTurn(
  execution: CompanionLongRunExecution,
  turn: CompanionLongRunTurnExecution,
): CompanionLongRunTurnReport {
  const changes = projectChanges(turn);
  return {
    number: turn.sequence,
    manifestTurnNumber: turn.number,
    phase: turn.phase,
    objective: turn.objective,
    sessionKey: turn.sessionKey,
    sessionId: turn.sessionId,
    clientMessageId: turn.clientMessageId,
    userText: turn.userText,
    actionsBefore: turn.actionsBefore.map(projectAction),
    expected: turn.expected,
    http: turn.http.map(projectHttpExchange),
    actualRoute: turn.actualRoute,
    observation: projectObservation(execution, turn),
    outcome: projectOutcome(turn, changes),
    contextPlan: projectContextPlan(turn.contextPlan),
    promptSegmentTrace: projectPromptSegmentTrace(turn.promptSegmentTrace),
    selectedEvidenceIds: uniqueStrings(turn.selectedEvidenceIds),
    assistant: {
      text: turn.assistantText,
      chunkCount: turn.chunks.length,
      repairAttempted: turn.replyAudit["repairAttempted"] === true,
      usedFallback: turn.replyAudit["usedFallback"] === true,
      ...optionalString(turn.replyAudit, "reasonCode"),
      ...(stringArray(turn.replyAudit["issueCodes"]).length === 0
        ? {}
        : { issueCodes: stringArray(turn.replyAudit["issueCodes"]) }),
    },
    stateBefore: projectSnapshot(turn.before),
    stateAfter: projectSnapshot(turn.after),
    changes,
    domainEvents: turn.domainEvents.map(projectDomainEvent),
    retrieval: projectRetrieval(turn),
    llmCalls: turn.llmCalls.map(projectLlmCall),
    assertions: turn.assertions.map((assertion) =>
      projectAssertion({ ...assertion, turnNumber: turn.sequence }),
    ),
    softMetricTags: [...(turn.expected.softMetricTags ?? [])],
    ...(turn.error === undefined
      ? {}
      : {
          failure: {
            code: turn.error.code,
            stage: turn.error.stage ?? "turn_execution",
            retryable: turn.error.retryable ?? false,
          },
        }),
  };
}

function projectAction(action: ScenarioAction): ScenarioAction {
  switch (action.kind) {
    case "send_message":
      return { kind: "send_message" };
    case "create_session":
      return { kind: "create_session", key: action.key };
    case "restart_app":
      return { kind: "restart_app", preserveDatabase: true };
    case "set_clock_local":
      return { kind: "set_clock_local", localIso: action.localIso };
    case "set_clock_from_schedule_item":
      return {
        kind: "set_clock_from_schedule_item",
        selector: action.selector,
        relation: action.relation,
        offsetMinutes: action.offsetMinutes,
      };
    case "set_clock_in_runtime_window":
      return {
        kind: "set_clock_in_runtime_window",
        window: action.window,
        offsetMinutes: action.offsetMinutes,
      };
    case "advance_clock":
      return { kind: "advance_clock", durationMinutes: action.durationMinutes };
    case "settle_agent":
      return { kind: "settle_agent" };
    case "allocate_free_slot":
      return {
        kind: "allocate_free_slot",
        key: action.key,
        durationMinutes: action.durationMinutes,
      };
    case "repeat_same_client_message_id":
      return { kind: "repeat_same_client_message_id" };
  }
}

function projectHttpExchange(
  exchange: CompanionLongRunTurnExecution["http"][number],
): LongRunHttpExchangeReport {
  return {
    label: exchange.label,
    method: exchange.method,
    route: exchange.route.split(/[?#]/u, 1)[0] ?? exchange.route,
    status: exchange.status,
    durationMs: exchange.durationMs,
    ...(exchange.requestId === undefined
      ? {}
      : { requestId: exchange.requestId }),
    ...(exchange.idempotentReplay === undefined
      ? {}
      : { idempotentReplay: exchange.idempotentReplay }),
  };
}

function projectObservation(
  execution: CompanionLongRunExecution,
  turn: CompanionLongRunTurnExecution,
): LongRunObservationReport {
  const observation = turn.turnObservation ?? {};
  const rejectedFieldCodes = recordArray(observation["rejectedFields"])
    .map((item) => {
      const field = stringField(item, "field");
      const reasonCode = stringField(item, "reasonCode");
      return [field, reasonCode]
        .filter((value) => value !== undefined)
        .join(":");
    })
    .filter((value) => value.length > 0);
  return {
    origin: observationOrigin(turn.understandingOrigin, execution.providerMode),
    route: stringField(observation, "route") ?? turn.actualRoute,
    ...optionalFiniteNumber(observation, "confidence"),
    topicKeys: stringArray(observation["topicKeys"]),
    topicDomains:
      turn.soft.domain === "" ? [] : uniqueStrings([turn.soft.domain]),
    ...optionalString(observation, "scheduleIntentKind"),
    uncertaintyCodes: stringArray(observation["routerReasonCodes"]),
    rejectedFieldCodes,
  };
}

function observationOrigin(
  origin: string,
  providerMode: CompanionLongRunExecution["providerMode"],
): LongRunObservationReport["origin"] {
  if (/fallback/iu.test(origin)) return "fallback";
  if (providerMode === "fixture" || /fixture|deterministic/iu.test(origin)) {
    return "fixture";
  }
  return "model";
}

function projectOutcome(
  turn: CompanionLongRunTurnExecution,
  changes: LongRunChangeReport,
): LongRunOutcomeReport {
  const outcome = turn.validatedOutcome;
  const acceptedKinds = stringArray(outcome["acceptedEffectKinds"]);
  const scheduleWritesEnabled = booleanField(outcome, "scheduleWritesEnabled");
  const dryRun = booleanField(outcome, "dryRun");
  const personalIntentIds = uniqueStrings(
    turn.domainEvents.flatMap((event) =>
      stringArray(asRecord(event["payload"])["personalIntentIds"]),
    ),
  );
  return {
    route: stringField(outcome, "route") ?? turn.actualRoute,
    scheduleOutcomeKind:
      stringField(outcome, "scheduleOutcomeKind") ?? "missing",
    decisionPath: stringField(outcome, "decisionPath") ?? "missing",
    worldEffectsMode: stringField(outcome, "worldEffectsMode") ?? "missing",
    worldEffectWritesEnabled:
      outcome["worldEffectsWritesEnabled"] === true ||
      outcome["worldEffectWritesEnabled"] === true,
    scheduleWritesEnabled: scheduleWritesEnabled ?? false,
    scheduleWritesEnabledSource:
      scheduleWritesEnabled === undefined ? "missing" : "validated_outcome",
    stateChanged: changes.stateChanged,
    dryRun: dryRun ?? false,
    dryRunSource: dryRun === undefined ? "missing" : "validated_outcome",
    replyMutationAuthorization:
      stringField(outcome, "replyMutationAuthorization") ?? "missing",
    acceptedEffectCounts: {
      stateDelta: acceptedKinds.includes("state_delta") ? 1 : 0,
      relationshipDelta: acceptedKinds.includes("relationship_delta") ? 1 : 0,
      memories: changes.memoryIdsAdded?.length ?? 0,
      personalIntents:
        personalIntentIds.length > 0
          ? personalIntentIds.length
          : acceptedKinds.includes("personal_intent_candidate")
            ? 1
            : 0,
      continuityEffects: changes.followUpIdsAdded?.length ?? 0,
      careCues: changes.careCueIdsAdded?.length ?? 0,
    },
    proposalRejectionCodes: uniqueStrings([
      ...stringArray(outcome["proposalRejectionCodes"]),
      ...turn.rejectedProposals.flatMap((proposal) =>
        stringField(proposal, "reasonCode") === undefined
          ? []
          : [stringField(proposal, "reasonCode") as string],
      ),
    ]),
  };
}

function projectContextPlan(
  raw: Record<string, unknown> | null,
): LongRunContextPlanReport {
  const plan = raw ?? {};
  return {
    activatedTraitIds: stringArray(plan["activatedTraitIds"]),
    activatedValueIds: stringArray(plan["activatedValueIds"]),
    activatedContradictionIds: stringArray(plan["activatedContradictionIds"]),
    activatedGoalIds: stringArray(plan["activatedGoalIds"]),
    activatedPreferenceIds: stringArray(plan["activatedPreferenceIds"]),
    suppressedGoalIds: stringArray(plan["suppressedGoalIds"]),
    includeAutobiography: plan["includeAutobiography"] === true,
    includeCalendar: plan["includeCalendar"] === true,
    includeFutureSchedule: plan["includeFutureSchedule"] === true,
    includeRetrievedEvidence: plan["includeRetrievedEvidence"] === true,
    trace: recordArray(plan["trace"]).map((item) => {
      const source = stringField(item, "source");
      return {
        itemType: stringField(item, "itemType") ?? "missing",
        itemId: stringField(item, "itemId") ?? "missing",
        included: item["included"] === true,
        source: isContextTraceSource(source) ? source : "none",
        reasons: stringArray(item["reasons"]),
        ...(stringField(item, "sourceId") === undefined
          ? {}
          : { sourceId: stringField(item, "sourceId") as string }),
      };
    }),
  };
}

function isContextTraceSource(
  value: string | undefined,
): value is LongRunContextPlanReport["trace"][number]["source"] {
  return [
    "user_message",
    "selected_evidence",
    "current_activity",
    "continuity_cue",
    "none",
  ].includes(value ?? "");
}

function projectPromptSegmentTrace(
  raw: unknown,
): LongRunPromptSegmentTraceReport[] {
  const direct = recordArray(raw);
  const records = Array.isArray(raw)
    ? direct
    : recordArray(asRecord(raw)["segments"]);
  return records.map((trace) => {
    const placement = stringField(trace, "placement");
    return {
      id: stringField(trace, "id") ?? "missing",
      placement: placement === "system" ? "system" : "prompt",
      priority: finiteNumberField(trace, "priority") ?? 0,
      tokenBudget: finiteNumberField(trace, "tokenBudget") ?? 0,
      estimatedTokens: finiteNumberField(trace, "estimatedTokens") ?? 0,
      required: trace["required"] === true,
      included: trace["included"] === true,
      truncated: trace["truncated"] === true,
      cacheHit: trace["cacheHit"] === true,
      ...optionalString(trace, "reason"),
    };
  });
}

function projectSnapshot(
  snapshot: SafeRuntimeSnapshot,
): LongRunAuthoritySnapshotReport {
  const state = snapshot.state;
  const runtimeState = state === null ? undefined : projectRuntimeState(state);
  const scheduleCommitLineage = snapshot.scheduleCommitLineage.flatMap(
    (lineage) => {
      const authorizedItemId = stringField(lineage, "authorizedItemId");
      const scheduleCommandEventId = stringField(
        lineage,
        "scheduleCommandEventId",
      );
      const negotiationId = stringField(lineage, "negotiationId");
      const offerVersion = finiteNumberField(lineage, "offerVersion");
      if (
        authorizedItemId === undefined ||
        scheduleCommandEventId === undefined ||
        negotiationId === undefined ||
        offerVersion === undefined ||
        !Number.isInteger(offerVersion) ||
        offerVersion < 1 ||
        lineage["negotiationStatus"] !== "committed"
      ) {
        return [];
      }
      return [
        {
          authorizedItemId,
          scheduleCommandEventId,
          negotiationId,
          offerVersion,
          negotiationStatus: "committed" as const,
        },
      ];
    },
  );
  return {
    ...(runtimeState === undefined ? {} : { runtimeState }),
    schedule: snapshot.schedule.map((item) => ({
      id: stringField(item, "id") ?? "missing",
      title: stringField(item, "title") ?? "missing",
      category: stringField(item, "category") ?? "other",
      startAtUtc: stringField(item, "startAtUtc") ?? new Date(0).toISOString(),
      endAtUtc: stringField(item, "endAtUtc") ?? new Date(0).toISOString(),
      status: stringField(item, "status") ?? "missing",
      revision: finiteNumberField(item, "revision") ?? 0,
    })),
    ...(scheduleCommitLineage.length === 0 ? {} : { scheduleCommitLineage }),
    memoryCount:
      countField(snapshot.counts, "memories") ?? snapshot.memories.length,
    careCueCount:
      countField(snapshot.counts, "care_cues") ?? snapshot.careCues.length,
    followUpCount:
      countField(snapshot.counts, "follow_up_intents") ??
      snapshot.followUps.length,
    domainEventCount: countField(snapshot.counts, "domain_events") ?? 0,
  };
}

function projectRuntimeState(
  state: Record<string, unknown>,
): NonNullable<LongRunAuthoritySnapshotReport["runtimeState"]> | undefined {
  const asOfUtc = stringField(state, "asOfUtc");
  const revision = finiteNumberField(state, "revision");
  const moodValence = finiteNumberField(state, "moodValence");
  const moodArousal = finiteNumberField(state, "moodArousal");
  const energy = finiteNumberField(state, "energy");
  const stress = finiteNumberField(state, "stress");
  const socialBattery = finiteNumberField(state, "socialBattery");
  const focus = finiteNumberField(state, "focus");
  const sleepDebtMinutes = finiteNumberField(state, "sleepDebtMinutes");
  if (
    asOfUtc === undefined ||
    revision === undefined ||
    moodValence === undefined ||
    moodArousal === undefined ||
    energy === undefined ||
    stress === undefined ||
    socialBattery === undefined ||
    focus === undefined ||
    sleepDebtMinutes === undefined
  ) {
    return undefined;
  }
  const relationship = projectRelationship(asRecord(state["relationship"]));
  return {
    asOfUtc,
    revision,
    moodValence,
    moodArousal,
    energy,
    stress,
    socialBattery,
    focus,
    sleepDebtMinutes,
    ...optionalString(state, "currentActivityId"),
    ...optionalString(state, "locationContext"),
    ...(relationship === undefined ? {} : { relationship }),
  };
}

function projectRelationship(
  relationship: Record<string, unknown>,
):
  | NonNullable<
      NonNullable<
        LongRunAuthoritySnapshotReport["runtimeState"]
      >["relationship"]
    >
  | undefined {
  const userId = stringField(relationship, "userId");
  const closeness = finiteNumberField(relationship, "closeness");
  const trust = finiteNumberField(relationship, "trust");
  const familiarity = finiteNumberField(relationship, "familiarity");
  const recentInteractionValence = finiteNumberField(
    relationship,
    "recentInteractionValence",
  );
  if (
    userId === undefined ||
    closeness === undefined ||
    trust === undefined ||
    familiarity === undefined ||
    recentInteractionValence === undefined
  ) {
    return undefined;
  }
  return {
    userId,
    closeness,
    trust,
    familiarity,
    recentInteractionValence,
    ...optionalString(relationship, "lastInteractionAtUtc"),
  };
}

function projectChanges(
  turn: CompanionLongRunTurnExecution,
): LongRunChangeReport {
  const changes = turn.changes;
  const rejectionCodes = (purposePattern: RegExp): string[] =>
    uniqueStrings(
      turn.rejectedProposals.flatMap((proposal) => {
        const purpose = stringField(proposal, "purpose") ?? "";
        const code = stringField(proposal, "reasonCode");
        return purposePattern.test(purpose) && code !== undefined ? [code] : [];
      }),
    );
  return {
    stateChanged: changes["stateChanged"] === true,
    ...optionalStringArray(changes, "scheduleItemIdsAdded"),
    ...optionalStringArray(changes, "scheduleItemIdsUpdated"),
    ...optionalStringArray(changes, "memoryIdsAdded"),
    ...optionalStringArray(changes, "memoryIdsUpdated"),
    ...optionalStringArray(changes, "careCueIdsAdded"),
    ...optionalStringArray(changes, "careCueIdsUpdated"),
    ...optionalStringArray(changes, "followUpIdsAdded"),
    ...optionalStringArray(changes, "followUpIdsUpdated"),
    ...(rejectionCodes(/memory/iu).length === 0
      ? {}
      : { memoryRejectionCodes: rejectionCodes(/memory/iu) }),
    ...(rejectionCodes(/care/iu).length === 0
      ? {}
      : { careCueRejectionCodes: rejectionCodes(/care/iu) }),
    ...(rejectionCodes(/follow/iu).length === 0
      ? {}
      : { followUpRejectionCodes: rejectionCodes(/follow/iu) }),
  };
}

function projectDomainEvent(
  event: Record<string, unknown>,
): LongRunDomainEventReport {
  const payload = asRecord(event["payload"]);
  const correlationId = nullableStringField(event, "correlationId");
  const causationId = nullableStringField(event, "causationId");
  const entityIds = uniqueStrings([
    ...optionalValueString(payload, "userMessageId"),
    ...optionalValueString(payload, "assistantMessageId"),
    ...optionalValueString(payload, "negotiationId"),
    ...stringArray(payload["scheduleItemIds"]),
    ...stringArray(payload["changedItemIds"]),
    ...stringArray(payload["memoryIds"]),
    ...stringArray(payload["personalIntentIds"]),
  ]);
  const reasonCodes = uniqueStrings([
    ...optionalValueString(payload, "reasonCode"),
    ...stringArray(payload["rejectionCodes"]),
  ]);
  return {
    id: stringField(event, "id") ?? "missing",
    type: stringField(event, "eventType") ?? "unknown",
    aggregateType: stringField(event, "streamType") ?? "unknown",
    aggregateId: stringField(event, "streamId") ?? "unknown",
    occurredAtUtc:
      stringField(event, "recordedAtUtc") ?? new Date(0).toISOString(),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(causationId === undefined ? {} : { causationId }),
    ...(entityIds.length === 0 ? {} : { entityIds }),
    ...(reasonCodes.length === 0 ? {} : { reasonCodes }),
  };
}

function projectRetrieval(
  turn: CompanionLongRunTurnExecution,
): LongRunRetrievalReport {
  const mappings: LongRunRetrievalReport["evidenceMappings"][number][] = [];
  const selectedEvidenceIds = new Set(turn.selectedEvidenceIds);
  for (const run of turn.retrievalRuns) {
    for (const evidenceId of stringArray(run["selectedEvidenceIds"])) {
      selectedEvidenceIds.add(evidenceId);
    }
    const sourceMessageId = nullableStringField(run, "sourceMessageId");
    for (const mapping of recordArray(run["evidenceMappings"])) {
      const evidenceId = stringField(mapping, "evidenceId") ?? "missing";
      const sourceType = stringField(mapping, "sourceType") ?? "missing";
      const sourceId = stringField(mapping, "sourceId");
      const mappedSourceMessageId =
        /message/iu.test(sourceType) && sourceId !== undefined
          ? sourceId
          : undefined;
      mappings.push({
        evidenceId,
        ...optionalString(mapping, "memoryId"),
        ...(mappedSourceMessageId === undefined
          ? {}
          : { sourceMessageId: mappedSourceMessageId }),
        currentTurnGrounded:
          mappedSourceMessageId !== undefined &&
          mappedSourceMessageId === sourceMessageId,
      });
    }
  }
  return {
    runIds: uniqueStrings(
      turn.retrievalRuns.flatMap((run) => optionalValueString(run, "id")),
    ),
    selectedEvidenceIds: [...selectedEvidenceIds],
    evidenceMappings: mappings,
  };
}

function projectLlmCall(call: SafeLlmCall): LongRunLlmCallReport {
  const attemptCount = call.attemptCount ?? 1;
  const failedAttemptCount =
    call.failedAttemptCount ?? (call.success ? 0 : attemptCount);
  return {
    purpose: call.purpose,
    provider: call.provider,
    model: call.model,
    attempt: attemptCount,
    attemptCount,
    failedAttemptCount,
    ...(call.providerInputUsageAttemptCount === undefined
      ? {}
      : {
          providerInputUsageAttemptCount: finiteOrZero(
            call.providerInputUsageAttemptCount,
          ),
        }),
    ...(call.providerOutputUsageAttemptCount === undefined
      ? {}
      : {
          providerOutputUsageAttemptCount: finiteOrZero(
            call.providerOutputUsageAttemptCount,
          ),
        }),
    ...(call.attemptTelemetrySource === undefined
      ? {}
      : { attemptTelemetrySource: call.attemptTelemetrySource }),
    latencyMs: finiteOrZero(call.latencyMs),
    success: call.success,
    inputTokens: finiteOrZero(call.inputTokens),
    outputTokens: finiteOrZero(call.outputTokens),
    ...(call.providerInputTokens === undefined
      ? {}
      : { providerInputTokens: finiteOrZero(call.providerInputTokens) }),
    ...(call.providerOutputTokens === undefined
      ? {}
      : { providerOutputTokens: finiteOrZero(call.providerOutputTokens) }),
    ...(call.usageSource === undefined
      ? {}
      : { usageSource: call.usageSource }),
    ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
  };
}

function projectAssertion(
  assertion: ExecutionAssertionResult,
): LongRunAssertionResult {
  return {
    id: assertion.id,
    code: assertion.code,
    passed: assertion.passed,
    message: assertion.description,
    hard: assertion.hard,
    scope: assertion.scope,
    ...(assertion.turnNumber === undefined
      ? {}
      : { turnNumber: assertion.turnNumber }),
    evidence: Object.entries(assertion.evidence)
      .filter((entry): entry is [string, string | number | boolean | null] =>
        isScalar(entry[1]),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value })),
  };
}

function projectMetrics(
  metrics: Readonly<Record<string, string | number | boolean>>,
): Record<string, LongRunMetricValue> {
  return Object.fromEntries(
    Object.entries(metrics)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        if (typeof value === "number" && !Number.isFinite(value)) {
          throw new TypeError(`Metric ${name} must be finite.`);
        }
        return [name, value];
      }),
  );
}

function projectMetricDetails(
  metrics: Readonly<Record<string, LongRunMetricValue>>,
  requestedTurnCount: number,
  recallAudit: CompanionLongRunRecallMetricAudit,
): LongRunMetricResult[] {
  return Object.entries(metrics).flatMap(([name, value]) => {
    if (typeof value !== "number") return [];
    const base: LongRunMetricResult = { name, value, source: "runner" };
    const withRecallAudit = (
      audit: CompanionLongRunRecallMetricAudit[
        "durableMapping" | "durableEndToEnd" | "recentEndToEnd"],
      source: string,
    ) => ({
      ...base,
      source,
      ...(audit.denominator === 0
        ? {}
        : {
            numerator: audit.numerator,
            denominator: audit.denominator,
            failedTurnNumbers: audit.failedTurnNumbers,
            failedManifestTurnNumbers: audit.failedManifestTurnNumbers,
          }),
    });
    switch (name) {
      case "nonScheduleScheduleInterferenceRate":
      case "SharedScheduleInterferenceRate":
      case "memoryPoisonWriteCount":
      case "technicalFallbackTextCount":
      case "duplicateAuthoritativeSideEffectCount":
        return [
          {
            ...base,
            comparator: "=" as const,
            threshold: 0,
            passed: value === 0,
          },
        ];
      case "currentTurnRetrievalMappingRate":
        return [
          {
            ...withRecallAudit(
              recallAudit.durableMapping,
              "runner (deprecated alias of DurableRecallMappingRate)",
            ),
            comparator: "=" as const,
            threshold: 1,
            passed: value === 1,
          },
        ];
      case "DurableRecallMappingRate":
        return [
          {
            ...withRecallAudit(
              recallAudit.durableMapping,
              "runner evidence-mapping integrity",
            ),
            comparator: "=" as const,
            threshold: 1,
            passed: value === 1,
          },
        ];
      case "DurableRecallAssertionPassRate":
        return [
          {
            ...withRecallAudit(
              recallAudit.durableEndToEnd,
              "runner end-to-end durable recall hard assertions",
            ),
            comparator: "=" as const,
            threshold: 1,
            passed: value === 1,
          },
        ];
      case "RecentContextRecallPassRate":
        return [
          {
            ...withRecallAudit(
              recallAudit.recentEndToEnd,
              "runner end-to-end recent-context hard assertions",
            ),
            comparator: "=" as const,
            threshold: 1,
            passed: value === 1,
          },
        ];
      case "goalActivationRecall":
        if (requestedTurnCount < 30) return [base];
        return [
          {
            ...base,
            comparator: "=" as const,
            threshold: 1,
            passed: value === 1,
          },
        ];
      case "goalActivationPrecision":
        if (requestedTurnCount < 30) return [base];
        return [
          {
            ...base,
            comparator: ">=" as const,
            threshold: 0.9,
            passed: value >= 0.9,
          },
        ];
      default:
        return [base];
    }
  });
}

function projectExecutionFailure(
  execution: CompanionLongRunExecution,
): BuildCompanionLongRunReportInput["failure"] {
  if (execution.failure !== undefined) {
    return {
      code: execution.failure.code,
      stage: execution.failure.stage ?? execution.completionReason,
      message: execution.failure.message ?? execution.failure.name,
      ...(execution.failure.turnNumber === undefined
        ? {}
        : { turnNumber: execution.failure.turnNumber }),
      ...(execution.failure.retryable === undefined
        ? {}
        : { retryable: execution.failure.retryable }),
    };
  }
  switch (execution.completionReason) {
    case "budget_limit":
      return {
        code: "budget_limit",
        stage: "budget_limit",
        message: "Run stopped after reaching the configured token budget.",
      };
    case "runner_error":
      return {
        code: "runner_error",
        stage: "runner_error",
        message: "Run stopped because the runner reported an error.",
      };
    case "paid_opt_in_missing":
      return {
        code: "paid_opt_in_missing",
        stage: "paid_opt_in_missing",
        message: "Paid provider opt-in or configuration was unavailable.",
      };
    case "completed":
    case "interval_checkpoint":
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueStrings(
        value.filter((item): item is string => typeof item === "string"),
      )
    : [];
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function nullableStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return stringField(record, key);
}

function finiteNumberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function countField(
  counts: Readonly<Record<string, number>>,
  key: string,
): number | undefined {
  const value = counts[key];
  return value === undefined || !Number.isFinite(value) ? undefined : value;
}

function optionalString<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, string>> {
  const value = stringField(record, key);
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function optionalFiniteNumber<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, number>> {
  const value = finiteNumberField(record, key);
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

function optionalStringArray<K extends string>(
  record: Record<string, unknown>,
  key: K,
): Partial<Record<K, string[]>> {
  const value = stringArray(record[key]);
  return value.length === 0 ? {} : ({ [key]: value } as Record<K, string[]>);
}

function optionalValueString(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = stringField(record, key);
  return value === undefined ? [] : [value];
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function safeArtifactLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "[unavailable]";
  const normalized = trimmed.replace(/\\/gu, "/");
  if (
    isAbsolute(trimmed) ||
    win32.isAbsolute(trimmed) ||
    posix.isAbsolute(trimmed) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return basename(win32.basename(posix.basename(trimmed)));
  }
  return normalized;
}
