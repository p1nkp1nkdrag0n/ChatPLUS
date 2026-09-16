import { createHash } from "node:crypto";
import {
  assembleChatPrompt,
  type AssemblePromptInput,
  type ReplyStrategy,
  type PromptAssemblyTrace,
} from "@personasim/features";
import { initialRuntimeState } from "../domain/defaults.js";
import { buildArchitecturePersonaFixtureCharacter } from "./architecture-persona-cases.js";
import {
  parseArchitecturePrompt,
  type ArchitecturePromptSegment,
} from "./architecture-prompt-ablation.js";
import {
  STATE_MATRIX_BASELINE_CASES,
  STATE_MATRIX_HOLDOUT_CASES,
  STATE_MATRIX_NEUTRAL,
  STATE_MATRIX_REGRESSION_CASE_IDS,
  STATE_MATRIX_RUBRIC,
  STATE_MATRIX_VERSION,
  type StateMatrixCase,
} from "./state-matrix-validation-cases.js";

const STATE_SEGMENT = "08_runtime_state";
const STRATEGY_SEGMENT = "15_reply_strategy";
const MUTABLE_SEGMENTS = new Set([STATE_SEGMENT, STRATEGY_SEGMENT]);
const PERSONA_SEGMENTS = new Set([
  "02_character_identity",
  "03_core_persona",
  "04_values_conflicts",
  "05_boundaries",
]);
const OMITTABLE_STATE_KEYS = new Set([
  "authority",
  "asOfUtc",
  "revision",
  "semantics",
  "qualitative",
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
  "locationContext",
  "contextOnlyFields",
]);

export const stateMatrixValidationHash = (value: unknown): string =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export interface StateMatrixPromptCapture {
  readonly case: StateMatrixCase;
  readonly input: AssemblePromptInput;
  readonly neutralInput?: AssemblePromptInput;
  readonly production: {
    readonly system: string;
    readonly prompt: string;
    readonly segments: readonly ArchitecturePromptSegment[];
    readonly segmentTrace: PromptAssemblyTrace;
    readonly strategy: ReplyStrategy;
  };
  /** Exact text dispatched by this controlled experiment, after intervention. */
  readonly model: {
    readonly system: string;
    readonly prompt: string;
    readonly segments: readonly ArchitecturePromptSegment[];
    readonly strategy: ReplyStrategy;
  };
  readonly proof: {
    readonly inputSha256: string;
    readonly neutralInputSha256?: string;
    readonly productionSha256: string;
    readonly modelSha256: string;
    readonly systemSha256: string;
    readonly nonStateAndStrategySha256: string;
    readonly strategySha256: string;
    readonly intervention:
      "neutral_strategy_and_dimension_projection" | "production";
  };
}

export interface StateMatrixFrozenBaseline {
  readonly schemaVersion: "state-matrix-frozen-baseline-v1";
  readonly experimentVersion: string;
  readonly baselineCaseIds: readonly string[];
  readonly holdoutCaseIds: readonly string[];
  readonly regressionCaseIds: readonly string[];
  /** Includes the seven holdout baselines before any production optimization. */
  readonly captures: readonly StateMatrixPromptCapture[];
  readonly sha256: string;
}

export interface StateMatrixValidationCell {
  readonly cellId: string;
  readonly caseId: string;
  readonly pairingId: string;
  readonly condition: StateMatrixCase["condition"];
  readonly personaId: StateMatrixCase["personaId"];
  readonly family: "necessity" | "mixed" | "continuity" | "holdout";
  readonly phase: "baseline" | "candidate";
  readonly variant: "baseline" | "candidate";
  readonly system: string;
  readonly prompt: string;
  readonly proof: StateMatrixPromptCapture["proof"];
}

export interface StateMatrixPromptManifest {
  readonly schemaVersion: "state-matrix-prompt-manifest-v1";
  readonly phase: "baseline" | "candidate";
  readonly baseline: StateMatrixFrozenBaseline;
  readonly candidateCaptures?: readonly StateMatrixPromptCapture[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a complete state-matrix JSON object");
  return value as Record<string, unknown>;
}

function exactlyOne(
  segments: readonly ArchitecturePromptSegment[],
  id: string,
): ArchitecturePromptSegment {
  const found = segments.filter((segment) => segment.id === id);
  if (found.length !== 1)
    throw new Error(`Expected one complete state-matrix segment: ${id}`);
  return found[0]!;
}

function payload(segment: ArchitecturePromptSegment): Record<string, unknown> {
  const lines = segment.content.split("\n");
  if (lines.length !== 2 || lines[0] !== segment.label)
    throw new Error(`Expected labelled JSON only: ${segment.id}`);
  return record(JSON.parse(lines[1]!));
}

function joined(
  segments: readonly ArchitecturePromptSegment[],
  placement: "system" | "prompt",
) {
  return segments
    .filter((item) => item.placement === placement)
    .map((item) => item.content)
    .join("\n");
}

function fixedSegments(segments: readonly ArchitecturePromptSegment[]) {
  return segments.filter((item) => !MUTABLE_SEGMENTS.has(item.id));
}

export function assertStateMatrixFixedSegments(
  baseline: readonly ArchitecturePromptSegment[],
  candidate: readonly ArchitecturePromptSegment[],
): void {
  const layout = (segments: readonly ArchitecturePromptSegment[]) =>
    segments.map(({ id, placement, label }) => ({ id, placement, label }));
  if (
    stateMatrixValidationHash(layout(baseline)) !==
    stateMatrixValidationHash(layout(candidate))
  )
    throw new Error("State-matrix comparison changed prompt segment layout");
  if (
    stateMatrixValidationHash(fixedSegments(baseline)) !==
    stateMatrixValidationHash(fixedSegments(candidate))
  )
    throw new Error(
      "State-matrix comparison changed a non-state/strategy segment",
    );
  if (joined(baseline, "system") !== joined(candidate, "system"))
    throw new Error("State-matrix comparison changed system policy or persona");
}

/** The omission removes both exact values and their words. Unknown derived
 * readouts fail closed until an explicit projection is reviewed for them. */
function projectState(
  segment: ArchitecturePromptSegment,
  probe: StateMatrixCase,
): ArchitecturePromptSegment {
  const state = payload(segment);
  if ("sleepDebtMinutes" in state || "sleepDebt" in record(state.qualitative))
    throw new Error("Fuzzy state-matrix prompts must not expose sleep debt");
  if ("summary" in record(state.qualitative))
    throw new Error("State-matrix prompt contains a duplicate state summary");
  if (probe.omittedDimensions.length === 0) return segment;
  if (
    Object.keys(state).some((key) => !OMITTABLE_STATE_KEYS.has(key)) ||
    Object.keys(record(state.qualitative)).some(
      (key) => !(key in STATE_MATRIX_NEUTRAL),
    )
  )
    throw new Error("Unreviewed derived state fields prevent a clean omission");
  const qualitative = { ...record(state.qualitative) };
  for (const dimension of probe.omittedDimensions) {
    if (!(dimension in state) || !(dimension in qualitative))
      throw new Error(`Cannot omit an absent state dimension: ${dimension}`);
    delete state[dimension];
    delete qualitative[dimension];
  }
  return {
    ...segment,
    content: `${segment.label}\n${JSON.stringify({ ...state, qualitative })}`,
  };
}

export function stateMatrixValidationInput(
  probe: StateMatrixCase,
): AssemblePromptInput {
  const original = buildArchitecturePersonaFixtureCharacter(probe.personaId);
  const character = {
    ...original,
    identity: {
      ...original.identity,
      temporalFrame: { mode: "realtime" as const, eraLabel: "2026年的上海" },
    },
  };
  const initial = initialRuntimeState(character.id, probe.nowUtc, character);
  const { currentActivityId, locationContext, ...state } = initial;
  void currentActivityId;
  void locationContext;
  return {
    character,
    state: { ...state, ...probe.state },
    schedule: [],
    memories: [],
    recentMessages: probe.history.map((message, index) => ({
      role: message.role,
      content: message.content,
      createdAtUtc:
        message.createdAtUtc ??
        new Date(
          Date.parse(probe.nowUtc) - (probe.history.length - index) * 60_000,
        ).toISOString(),
    })),
    nowUtc: probe.nowUtc,
    userMessage: probe.userText,
    lifePlanningMode: "fuzzy",
    liveWorldEffectsMode: "off",
    decisionMode: "reply_only",
    maxInputTokens: 32_000,
  };
}

function capture(
  probe: StateMatrixCase,
  input: AssemblePromptInput,
  neutralInput?: AssemblePromptInput,
): StateMatrixPromptCapture {
  if (
    (probe.strategyMode === "neutral_frozen") !==
    (neutralInput !== undefined)
  )
    throw new Error("State-matrix strategy control does not match the case");
  const assembled = assembleChatPrompt(input);
  const segments = parseArchitecturePrompt(assembled);
  const stateSegment = projectState(exactlyOne(segments, STATE_SEGMENT), probe);
  const neutral =
    neutralInput === undefined ? undefined : assembleChatPrompt(neutralInput);
  const neutralSegments =
    neutral === undefined ? undefined : parseArchitecturePrompt(neutral);
  if (neutralSegments !== undefined)
    assertStateMatrixFixedSegments(segments, neutralSegments);
  const strategySegment = exactlyOne(
    neutralSegments ?? segments,
    STRATEGY_SEGMENT,
  );
  if ("stateGuidance" in payload(strategySegment))
    throw new Error(
      "State-matrix strategy contains a second derived state readout",
    );
  const delivered = segments.map((segment) =>
    segment.id === STATE_SEGMENT
      ? stateSegment
      : segment.id === STRATEGY_SEGMENT
        ? strategySegment
        : segment,
  );
  const model = {
    system: joined(delivered, "system"),
    prompt: joined(delivered, "prompt"),
    segments: delivered,
    strategy: neutral?.replyStrategy ?? assembled.replyStrategy,
  };
  assertStateMatrixFixedSegments(segments, delivered);
  return {
    case: structuredClone(probe),
    input: structuredClone(input),
    ...(neutralInput === undefined
      ? {}
      : { neutralInput: structuredClone(neutralInput) }),
    production: {
      system: assembled.system,
      prompt: assembled.prompt,
      segments,
      segmentTrace: assembled.segmentTrace,
      strategy: assembled.replyStrategy,
    },
    model,
    proof: {
      inputSha256: stateMatrixValidationHash(input),
      ...(neutralInput === undefined
        ? {}
        : { neutralInputSha256: stateMatrixValidationHash(neutralInput) }),
      productionSha256: stateMatrixValidationHash({
        system: assembled.system,
        prompt: assembled.prompt,
      }),
      modelSha256: stateMatrixValidationHash({
        system: model.system,
        prompt: model.prompt,
      }),
      systemSha256: stateMatrixValidationHash(model.system),
      nonStateAndStrategySha256: stateMatrixValidationHash(
        fixedSegments(delivered),
      ),
      strategySha256: stateMatrixValidationHash(strategySegment.content),
      intervention:
        neutralInput === undefined
          ? "production"
          : "neutral_strategy_and_dimension_projection",
    },
  };
}

function buildBaseline(): StateMatrixFrozenBaseline {
  const captures = [
    ...STATE_MATRIX_BASELINE_CASES,
    ...STATE_MATRIX_HOLDOUT_CASES,
  ].map((probe) => {
    const input = stateMatrixValidationInput(probe);
    const neutralInput =
      probe.strategyMode === "neutral_frozen"
        ? {
            ...structuredClone(input),
            state: { ...input.state, ...STATE_MATRIX_NEUTRAL },
          }
        : undefined;
    return capture(probe, input, neutralInput);
  });
  const data = {
    schemaVersion: "state-matrix-frozen-baseline-v1" as const,
    experimentVersion: STATE_MATRIX_VERSION,
    baselineCaseIds: STATE_MATRIX_BASELINE_CASES.map((probe) => probe.id),
    holdoutCaseIds: STATE_MATRIX_HOLDOUT_CASES.map((probe) => probe.id),
    regressionCaseIds: [...STATE_MATRIX_REGRESSION_CASE_IDS],
    captures,
  };
  return { ...data, sha256: stateMatrixValidationHash(data) };
}

function validateFrozenBaseline(baseline: StateMatrixFrozenBaseline): void {
  const { sha256, ...data } = baseline;
  if (
    baseline.schemaVersion !== "state-matrix-frozen-baseline-v1" ||
    baseline.experimentVersion !== STATE_MATRIX_VERSION ||
    stateMatrixValidationHash(data) !== sha256
  )
    throw new Error("Invalid or modified frozen state-matrix baseline");
  const captureIds = baseline.captures.map((item) => item.case.id);
  if (
    baseline.baselineCaseIds.length !== 56 ||
    baseline.holdoutCaseIds.length !== 7 ||
    baseline.regressionCaseIds.length !== 26 ||
    captureIds.length !== 63 ||
    new Set(captureIds).size !== 63 ||
    [...baseline.baselineCaseIds, ...baseline.holdoutCaseIds].some(
      (id) => !captureIds.includes(id),
    ) ||
    baseline.regressionCaseIds.some(
      (id) => !baseline.baselineCaseIds.includes(id),
    )
  )
    throw new Error(
      "Frozen state-matrix case inventory does not match the bounded protocol",
    );
  for (const item of baseline.captures) {
    if (
      item.proof.inputSha256 !== stateMatrixValidationHash(item.input) ||
      item.proof.modelSha256 !==
        stateMatrixValidationHash({
          system: item.model.system,
          prompt: item.model.prompt,
        }) ||
      item.model.system !== joined(item.model.segments, "system") ||
      item.model.prompt !== joined(item.model.segments, "prompt")
    )
      throw new Error("Frozen state-matrix input or prompt proof mismatch");
  }
}

function cell(
  captured: StateMatrixPromptCapture,
  phase: "baseline" | "candidate",
  variant: "baseline" | "candidate",
): StateMatrixValidationCell {
  const probe = captured.case;
  const family = {
    single_dimension: "necessity",
    mixed_persona: "mixed",
    lifecycle_snapshot: "continuity",
    holdout: "holdout",
  } as const;
  return {
    cellId: `${probe.id}/${variant}`,
    caseId: probe.id,
    pairingId: probe.pairingId,
    condition: probe.condition,
    personaId: probe.personaId,
    family: family[probe.block],
    phase,
    variant,
    system: captured.model.system,
    prompt: captured.model.prompt,
    proof: captured.proof,
  };
}

function reviewContext(captured: StateMatrixPromptCapture) {
  const probe = captured.case;
  return {
    caseId: probe.id,
    pairingId: probe.pairingId,
    title: probe.title,
    block: probe.block,
    condition: probe.condition,
    personaId: probe.personaId,
    admittedPersona: captured.model.segments.filter((item) =>
      PERSONA_SEGMENTS.has(item.id),
    ),
    personaReviewAuthority:
      "Judge persona only using admittedPersona, not unadmitted author material.",
    admittedState: payload(exactlyOne(captured.model.segments, STATE_SEGMENT)),
    runtimeReviewAuthority:
      "Judge state using admittedState only. An omitted dimension is unavailable, not neutral; mark compatibility with that omitted dimension N/A. Private input state is provenance only.",
    omittedDimensions: probe.omittedDimensions,
    strategyMode: probe.strategyMode,
    ...(probe.targetDimension === undefined
      ? {}
      : { targetDimension: probe.targetDimension }),
    ...(probe.trajectoryId === undefined
      ? {}
      : { trajectoryId: probe.trajectoryId }),
    ...(probe.timepoint === undefined ? {} : { timepoint: probe.timepoint }),
    nowUtc: probe.nowUtc,
    history: probe.history,
    userText: probe.userText,
    criteria: probe.criteria,
    sourceNotes: probe.sourceNotes,
  };
}

/** No I/O or model calls. Phase two replays frozen inputs and baseline text;
 * current production may change only the explicitly allowed two prompt blocks. */
export function buildStateMatrixValidationPrompts(
  options:
    | { readonly phase?: "baseline" }
    | {
        readonly phase: "candidate";
        readonly frozenBaseline: StateMatrixFrozenBaseline;
      } = {},
) {
  const phase = options.phase ?? "baseline";
  const baseline =
    options.phase === "candidate"
      ? structuredClone(options.frozenBaseline)
      : buildBaseline();
  validateFrozenBaseline(baseline);
  const byId = new Map(baseline.captures.map((item) => [item.case.id, item]));
  const selectedIds =
    phase === "baseline"
      ? baseline.baselineCaseIds
      : [...baseline.regressionCaseIds, ...baseline.holdoutCaseIds];
  const selected = selectedIds.map((id) => byId.get(id)!);
  const candidateCaptures: StateMatrixPromptCapture[] = [];
  const cells = selected.flatMap((saved) => {
    if (phase === "baseline") return [cell(saved, phase, "baseline")];
    const candidate = capture(saved.case, saved.input, saved.neutralInput);
    assertStateMatrixFixedSegments(
      saved.model.segments,
      candidate.model.segments,
    );
    candidateCaptures.push(candidate);
    return baseline.holdoutCaseIds.includes(saved.case.id)
      ? [cell(saved, phase, "baseline"), cell(candidate, phase, "candidate")]
      : [cell(candidate, phase, "candidate")];
  });
  const promptManifest: StateMatrixPromptManifest = {
    schemaVersion: "state-matrix-prompt-manifest-v1",
    phase,
    baseline,
    ...(phase === "candidate" ? { candidateCaptures } : {}),
  };
  return {
    cells,
    sharedReviewContexts: {
      rubric: STATE_MATRIX_RUBRIC,
      cases: selected.map(reviewContext),
    },
    promptManifest,
  };
}
