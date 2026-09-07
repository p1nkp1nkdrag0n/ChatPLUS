/** Independent correction-first acceptance. Judgments come from a fixture or
 * reviewer; this module never infers correctness from apologies or word counts,
 * calls a model, or changes the frozen 120-turn scoring protocol. */
export const RETENTION_STAGES = [
  "delay",
  "session",
  "restart",
  "compression",
] as const;
export type RetentionStage = (typeof RETENTION_STAGES)[number];

export interface CorrectionObservation {
  turnId: string;
  /** true requires correct target content and any applicable state checks.
   * null means unjudged, never a successful answer or a reason to correct it. */
  correct: boolean | null;
  evidenceIds: readonly string[];
  /** Only previously correct facts actually checked on this turn belong here. */
  collateralChecks?: readonly { factKey: string; preserved: boolean }[];
}

export interface CorrectionAttempt {
  number: 1 | 2;
  userText: string;
  observation: CorrectionObservation;
  /** Optional reviewed burden, not a required explanation or mistake reason. */
  extraExplanationCharacters?: number;
}

export interface RetentionProbe {
  stage: RetentionStage;
  observation: CorrectionObservation;
  /** Stable actual session identity; required for a new-session probe. */
  sessionId?: string;
  /** Reference actual intervening turns, session creation, process restart, or
   * completed compression event. A planned/scheduled transition is insufficient. */
  transitionEvidenceIds: readonly string[];
}

export interface CorrectionCase {
  caseId: string;
  targetKey: string;
  evidenceKind: "fixture" | "reviewed_run";
  prefix: {
    snapshotId: string;
    lastIncludedTurn: number;
    initialProbeTurn: number;
    sourceRevision: string;
    configurationId: string;
    characterId: string;
    model: string;
  };
  initial: CorrectionObservation;
  corrections: readonly CorrectionAttempt[];
  /** Chronological, judged probes only after this case recovered within C1/C2. */
  probes: readonly RetentionProbe[];
}

export type CorrectionNextStep =
  | { kind: "correct"; number: 1 | 2 }
  | {
      kind: "stop";
      reason:
        "initial_correct" | "recovered" | "limit_reached" | "await_assessment";
    };

/** A driver must consult this after each actual response, never send a frozen
 * correction regardless of the observed output. No third correction is allowed. */
export function nextCorrectionStep(
  input: Pick<CorrectionCase, "initial" | "corrections">,
): CorrectionNextStep {
  validateCorrections(input);
  const latest = input.corrections.at(-1)?.observation ?? input.initial;
  if (latest.correct === null)
    return { kind: "stop", reason: "await_assessment" };
  if (latest.correct)
    return {
      kind: "stop",
      reason: input.corrections.length === 0 ? "initial_correct" : "recovered",
    };
  if (input.corrections.length === 2)
    return { kind: "stop", reason: "limit_reached" };
  return { kind: "correct", number: input.corrections.length === 0 ? 1 : 2 };
}

/** Adapter for an existing HTTP/fixture runner. The assessment callback stays
 * separate from send, so its expected answers need not enter generation input. */
export async function runAdaptiveCorrections<Reply>(input: {
  initial: CorrectionObservation;
  feedback: { c1: string; c2: string };
  send: (userText: string) => Promise<Reply>;
  assess: (
    reply: Reply,
    number: 1 | 2,
  ) => CorrectionObservation | Promise<CorrectionObservation>;
}): Promise<CorrectionAttempt[]> {
  const corrections: CorrectionAttempt[] = [];
  for (;;) {
    const next = nextCorrectionStep({ initial: input.initial, corrections });
    if (next.kind === "stop") return corrections;
    const userText = next.number === 1 ? input.feedback.c1 : input.feedback.c2;
    if (!userText.trim()) throw new Error("correction_feedback_empty");
    const observation = await input.assess(
      await input.send(userText),
      next.number,
    );
    corrections.push({ number: next.number, userText, observation });
  }
}

interface Rate {
  numerator: number;
  denominator: number;
  value: number | null;
  status: "measured" | "N/A";
}

/** Event denominators stay separate from repeated exposures and from the number
 * of probe turns. Missing stages, especially real compression, stay N/A. */
export function summarizeCorrectionAcceptance(
  cases: readonly CorrectionCase[],
) {
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length)
    throw new Error("correction_duplicate_case");
  cases.forEach(validateCase);
  const judged = cases.filter((item) => item.initial.correct !== null);
  const errors = judged.filter((item) => item.initial.correct === false);
  const recovered = errors.filter((item) => recoveredAt(item) !== undefined);
  const allObservations = cases.flatMap((item) => [
    item.initial,
    ...item.corrections.map((attempt) => attempt.observation),
    ...item.probes.map((probe) => probe.observation),
  ]);
  const attempts = cases.flatMap((item) => item.corrections);
  const collateralChecks = cases
    .flatMap((item) => [
      ...item.corrections.map((attempt) => attempt.observation),
      ...item.probes.map((probe) => probe.observation),
    ])
    .flatMap((item) => item.collateralChecks ?? []);
  const recurrenceEvents: Array<{
    eventId: string;
    caseId: string;
    targetKey: string;
    turnIds: string[];
  }> = [];
  let recurrenceOpportunities = 0;
  let unjudgedProbes = 0;
  for (const item of recovered) {
    let active: (typeof recurrenceEvents)[number] | undefined;
    let sequence = 0;
    let sessionId: string | undefined;
    for (const probe of item.probes) {
      if (probe.sessionId !== undefined && probe.sessionId !== sessionId) {
        // A fresh session exposes a separately recorded recurrence even when
        // the preceding session also ended with the same unrecovered mistake.
        active = undefined;
        sessionId = probe.sessionId;
      }
      if (probe.observation.correct === null) {
        unjudgedProbes += 1;
        continue;
      }
      recurrenceOpportunities += 1;
      if (probe.observation.correct) {
        active = undefined;
        continue;
      }
      if (active === undefined) {
        active = {
          eventId: `${item.caseId}:recurrence:${++sequence}`,
          caseId: item.caseId,
          targetKey: item.targetKey,
          turnIds: [],
        };
        recurrenceEvents.push(active);
      }
      active.turnIds.push(probe.observation.turnId);
    }
  }
  const retention = Object.fromEntries(
    RETENTION_STAGES.map((stage) => {
      const tested = recovered.flatMap((item) => {
        const probes = item.probes.filter(
          (probe) =>
            probe.stage === stage && probe.observation.correct !== null,
        );
        return probes.length === 0
          ? []
          : [
              {
                caseId: item.caseId,
                retained: probes.every((probe) => probe.observation.correct),
              },
            ];
      });
      return [
        stage,
        {
          ...rate(tested.filter((item) => item.retained).length, tested.length),
          testedCaseIds: tested.map((item) => item.caseId),
          untestedRecoveredEvents: recovered.length - tested.length,
        },
      ];
    }),
  ) as Record<
    RetentionStage,
    Rate & { testedCaseIds: string[]; untestedRecoveredEvents: number }
  >;
  const explained = attempts.filter(
    (attempt) => attempt.extraExplanationCharacters !== undefined,
  );
  return {
    schema: "correction-first-acceptance-v1" as const,
    evidenceKinds: [...new Set(cases.map((item) => item.evidenceKind))],
    caseSources: cases.map((item) => ({
      caseId: item.caseId,
      evidenceKind: item.evidenceKind,
      prefix: item.prefix,
    })),
    opportunityCount: cases.length,
    unjudgedInitialOpportunities: cases.length - judged.length,
    E0: rate(errors.length, judged.length),
    R1: rate(
      recovered.filter((item) => recoveredAt(item) === 1).length,
      errors.length,
    ),
    R2: rate(recovered.length, errors.length),
    initialErrorEvents: errors.map((item) => ({
      caseId: item.caseId,
      targetKey: item.targetKey,
      recoveredAtCorrection: recoveredAt(item) ?? null,
      exposureTurnIds: [
        item.initial,
        ...item.corrections.map((attempt) => attempt.observation),
      ]
        .filter((observation) => observation.correct === false)
        .map((observation) => observation.turnId),
    })),
    initialErrorExposures: errors.reduce(
      (total, item) =>
        total +
        1 +
        item.corrections.filter(
          (attempt) => attempt.observation.correct === false,
        ).length,
      0,
    ),
    totalErrorExposures: allObservations.filter(
      (item) => item.correct === false,
    ).length,
    retention,
    recurrence: {
      ...rate(recurrenceEvents.length, recurrenceOpportunities),
      events: recurrenceEvents,
      exposures: recurrenceEvents.reduce(
        (total, item) => total + item.turnIds.length,
        0,
      ),
      unjudgedProbes,
    },
    collateral: {
      ...rate(
        collateralChecks.filter((check) => !check.preserved).length,
        collateralChecks.length,
      ),
      damagedFactKeys: [
        ...new Set(
          collateralChecks
            .filter((check) => !check.preserved)
            .map((check) => check.factKey),
        ),
      ],
    },
    burden: {
      correctionTurns: attempts.length,
      correctionsPer100InitialOpportunities:
        judged.length === 0 ? null : (attempts.length / judged.length) * 100,
      correctionsPerRecoveredEvent:
        recovered.length === 0
          ? null
          : recovered.reduce(
              (total, item) => total + item.corrections.length,
              0,
            ) / recovered.length,
      unresolvedCorrectionTurns: errors
        .filter((item) => recoveredAt(item) === undefined)
        .reduce((total, item) => total + item.corrections.length, 0),
      reviewedExplanationTurns: explained.length,
      extraExplanationCharacters:
        explained.length === 0
          ? null
          : explained.reduce(
              (total, item) => total + (item.extraExplanationCharacters ?? 0),
              0,
            ),
    },
    pendingRecoveryAssessments: errors.filter((item) => {
      const next = nextCorrectionStep(item);
      return next.kind === "correct" || next.reason === "await_assessment";
    }).length,
    limitations: [
      "Correctness and collateral outcomes are supplied evidence judgments, not model-generated satisfaction scores.",
      "Recovery rates retain every observed initial error; pending cases are disclosed rather than silently removed.",
      "Retention uses distinct recovered cases per stage; repeated failures in one session remain exposures of one recurrence until observed recovery; a new session starts a separate recurrence event.",
      "A transition reference must identify an actual completed event; this pure worksheet does not itself verify database or process logs.",
      "This supplementary protocol does not alter frozen 120-turn observations, scores, or thresholds.",
    ],
  };
}

function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    status: denominator === 0 ? "N/A" : "measured",
  };
}

function recoveredAt(
  item: Pick<CorrectionCase, "corrections">,
): 1 | 2 | undefined {
  return item.corrections.find(
    (attempt) => attempt.observation.correct === true,
  )?.number;
}

function validateObservation(observation: CorrectionObservation): void {
  if (
    !observation.turnId.trim() ||
    (observation.correct !== null &&
      (observation.evidenceIds.length === 0 ||
        observation.evidenceIds.some((id) => !id.trim())))
  )
    throw new Error("correction_observation_evidence_required");
  const checks = observation.collateralChecks ?? [];
  if (
    checks.some((check) => !check.factKey.trim()) ||
    new Set(checks.map((check) => check.factKey)).size !== checks.length
  )
    throw new Error("correction_collateral_check_invalid");
}

function validateCorrections(
  input: Pick<CorrectionCase, "initial" | "corrections">,
): void {
  validateObservation(input.initial);
  if (input.corrections.length > 2)
    throw new Error("correction_limit_exceeded");
  let previous = input.initial;
  const turnIds = new Set([previous.turnId]);
  for (const [index, attempt] of input.corrections.entries()) {
    if (previous.correct !== false)
      throw new Error("correction_requires_observed_error");
    if (attempt.number !== index + 1 || !attempt.userText.trim())
      throw new Error("correction_sequence_invalid");
    if (
      attempt.extraExplanationCharacters !== undefined &&
      (!Number.isInteger(attempt.extraExplanationCharacters) ||
        attempt.extraExplanationCharacters < 0)
    )
      throw new Error("correction_burden_invalid");
    validateObservation(attempt.observation);
    if (turnIds.has(attempt.observation.turnId))
      throw new Error("correction_duplicate_turn");
    turnIds.add(attempt.observation.turnId);
    previous = attempt.observation;
  }
}

function validateCase(item: CorrectionCase): void {
  if (!item.caseId.trim() || !item.targetKey.trim())
    throw new Error("correction_case_identity_required");
  const prefix = item.prefix;
  if (
    !Number.isInteger(prefix.lastIncludedTurn) ||
    !Number.isInteger(prefix.initialProbeTurn) ||
    prefix.lastIncludedTurn < 0 ||
    prefix.lastIncludedTurn >= prefix.initialProbeTurn
  )
    throw new Error("correction_requires_legal_prefix");
  if (
    [
      prefix.snapshotId,
      prefix.sourceRevision,
      prefix.configurationId,
      prefix.characterId,
      prefix.model,
    ].some((value) => !value.trim())
  )
    throw new Error("correction_prefix_identity_required");
  validateCorrections(item);
  if (item.probes.length > 0 && recoveredAt(item) === undefined)
    throw new Error("retention_requires_recovered_error");
  const turnIds = new Set([
    item.initial.turnId,
    ...item.corrections.map((attempt) => attempt.observation.turnId),
  ]);
  for (const probe of item.probes) {
    validateObservation(probe.observation);
    if (
      (probe.stage === "session" && !probe.sessionId?.trim()) ||
      probe.sessionId === ""
    )
      throw new Error("retention_session_identity_required");
    if (
      probe.transitionEvidenceIds.length === 0 ||
      probe.transitionEvidenceIds.some((id) => !id.trim())
    )
      throw new Error("retention_transition_evidence_required");
    if (turnIds.has(probe.observation.turnId))
      throw new Error("correction_duplicate_turn");
    turnIds.add(probe.observation.turnId);
  }
}
