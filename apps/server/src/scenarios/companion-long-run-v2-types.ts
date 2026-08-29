import type { ScheduleCategory } from "@personasim/contracts";

export type LongRunBranchId = "A" | "B";
export type LongRunTurnScope = "shared" | "branch_a" | "branch_b";
export type LongRunSessionKey = "S1" | "S2" | "S3" | "S4";

export type PairedProbeCategory =
  | "persona_style"
  | "state_counterfactual"
  | "memory_time"
  | "emotion"
  | "relationship_date";

export type PairedProbeExpectedRelation =
  | "style_invariant"
  | "state_directional"
  | "temporal_evidence_directional"
  | "emotion_directional"
  | "relationship_date_directional";

/**
 * Deterministic assertions are evaluated from HTTP responses, persisted rows,
 * domain events and prompt traces. They deliberately do not encode a release
 * verdict or infer success from natural-language prose alone.
 */
export type HardAssertion =
  | "http_success"
  | "response_contract_valid"
  | "persisted_turn_matches_response"
  | "no_unvalidated_write"
  | "persona_boundary_respected"
  | "no_ai_meta_disclosure"
  | "memory_write_grounded"
  | "memory_recall_evidence_bound"
  | "memory_abstains_without_evidence"
  | "memory_correction_supersedes"
  | "planned_not_occurred"
  | "schedule_requires_server_commit"
  | "schedule_exactly_once"
  | "schedule_unchanged"
  | "settlement_monotonic"
  | "settlement_idempotent"
  | "state_delta_bounded"
  | "relationship_delta_bounded"
  | "cross_session_continuity"
  | "restart_preserves_state"
  | "idempotent_replay"
  | "no_background_llm_while_closed"
  | "proactive_policy_respected"
  | "proactive_source_linked"
  | "prompt_budget_bounded"
  | "trace_lineage_complete"
  | "branch_anchor_preserved"
  | "user_boundary_respected";

/**
 * Semantic dimensions are scored independently from hard assertions. A high
 * semantic score can never conceal a failed deterministic assertion.
 */
export type SemanticRubricTag =
  | "persona_identity"
  | "persona_traits"
  | "persona_values"
  | "persona_contradiction"
  | "persona_voice"
  | "persona_boundary"
  | "memory_precision"
  | "memory_correction"
  | "memory_abstention"
  | "memory_temporal_accuracy"
  | "emotion_recognition"
  | "emotional_attunement"
  | "comfort_without_overreach"
  | "emotion_continuity"
  | "relationship_stage_fit"
  | "relationship_date_fit"
  | "relationship_repair"
  | "autonomy_preservation"
  | "daily_relevance"
  | "task_helpfulness"
  | "conversational_naturalness"
  | "non_repetition"
  | "state_alignment"
  | "causal_grounding"
  | "proactive_relevance";

export interface RuntimeStatePatch {
  moodValence?: number;
  moodArousal?: number;
  energy?: number;
  stress?: number;
  socialBattery?: number;
  focus?: number;
  sleepDebtMinutes?: number;
}

export interface RelationshipStatePatch {
  closeness?: number;
  trust?: number;
  familiarity?: number;
  recentInteractionValence?: number;
}

export type ScenarioAction =
  | { kind: "advance_clock"; durationMinutes: number }
  | { kind: "set_clock"; atUtc: string }
  | { kind: "activate_agent" }
  | { kind: "settle_agent" }
  | { kind: "close_app" }
  | { kind: "open_app"; preserveDatabase: true }
  | { kind: "restart_app"; preserveDatabase: true }
  | { kind: "create_session"; key: LongRunSessionKey }
  | { kind: "repeat_same_client_message_id" }
  | { kind: "set_runtime_state"; patch: RuntimeStatePatch }
  | { kind: "set_relationship_state"; patch: RelationshipStatePatch };

export interface PairedProbeSetupMessage {
  userText: string;
  actionsBefore?: readonly ScenarioAction[];
}

/**
 * A deterministic schedule slot that a confirmation turn must commit. Both
 * UTC and local expectations are stored so a count-only assertion cannot hide
 * date parsing or timezone regressions.
 */
export interface ExpectedScheduleCommit {
  startAtUtc: string;
  endAtUtc: string;
  timezone: string;
  localStart: string;
  category: ScheduleCategory;
  titleIncludes: string;
}

export interface LongRunPairedProbeSpec {
  /** Unique executable candidate id. One spec always means one model call. */
  id: string;
  /** Joins exactly one control spec and one comparison spec. */
  pairId: string;
  category: PairedProbeCategory;
  objective: string;
  resetToBaseline: true;
  arm: "control" | "comparison";
  expectedRelation: PairedProbeExpectedRelation;
  setupMessages?: readonly PairedProbeSetupMessage[];
  actionsBefore?: readonly ScenarioAction[];
  userText: string;
  hardAssertions: readonly HardAssertion[];
  semanticRubricTags: readonly SemanticRubricTag[];
}

export interface LongRunTurnSpec {
  /** Unique across shared and both mutually exclusive branches. */
  id: string;
  /** Stable global candidate number in the closed interval 1..120. */
  candidateNumber: number;
  /** Position on an actually executed path. Branch turns use 109..114. */
  executionOrdinal: number;
  scope: LongRunTurnScope;
  blockId: string;
  phase: string;
  objective: string;
  sessionKey: LongRunSessionKey;
  userText: string;
  actionsBefore?: readonly ScenarioAction[];
  hardAssertions: readonly HardAssertion[];
  semanticRubricTags: readonly SemanticRubricTag[];
  expectedScheduleCommit?: ExpectedScheduleCommit;
  /** The shared turn whose unresolved fact or choice this branch resolves. */
  branchAnchorTurnId?: string;
}

export interface LongRunScenarioBlock {
  id: string;
  label: string;
  scope: LongRunTurnScope;
  firstCandidateNumber: number;
  lastCandidateNumber: number;
}

export interface LongRunBranchSpec {
  id: LongRunBranchId;
  label: string;
  forkAfterTurnId: string;
  anchorTurnId: string;
  expectedOutcome: "date_confirmed" | "friends_only_respected";
  turns: readonly LongRunTurnSpec[];
}

export interface LongRunCharacterFixtureV2 {
  name: "顾澜";
  worldSetting: string;
  workOrRole: string;
  coreTraits: readonly string[];
  coreContradiction: string;
  mainGoal: string;
  dialogueStyle: string;
  hardBoundaries: readonly string[];
}

export interface LongRunInitialRelationshipV2 {
  userId: "local-user";
  relationshipType: string;
  closeness: number;
  trust: number;
  familiarity: number;
  recentInteractionValence: number;
}

export interface LongRunFeatureFlagsV2 {
  capabilityProfile: "high_fidelity";
  clockMode: "fake";
  chatEffectsMode: "gated";
  scheduleNegotiationMode: "enforced";
  selfInitiatedPlanningMode: "enforced";
  liveWorldEffectsMode: "enforced";
  memoryRecallMode: "enforced";
  autobiographyMode: "off";
}

export interface LongRunScenarioManifestV2 {
  schemaVersion: 2;
  scenarioVersion: "companion-long-run-v2";
  scenarioId: string;
  seed: number;
  startAtUtc: string;
  timezone: "Asia/Shanghai";
  initialSessionKey: "S1";
  character: LongRunCharacterFixtureV2;
  initialRelationship: LongRunInitialRelationshipV2;
  featureFlags: LongRunFeatureFlagsV2;
  pairedProbeBaselineId: "gulan-v2-frozen-baseline";
  pairedProbes: readonly LongRunPairedProbeSpec[];
  blocks: readonly LongRunScenarioBlock[];
  sharedTurns: readonly LongRunTurnSpec[];
  branches: readonly [LongRunBranchSpec, LongRunBranchSpec];
}
