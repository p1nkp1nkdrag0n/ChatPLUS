export type LongRunV3BranchId = "A" | "B";
export type LongRunV3TurnScope = "shared" | "branch_a" | "branch_b";
export type LongRunV3SessionKey = "S1" | "S2" | "S3" | "S4";
export type LongRunV3Decision = "A" | "B";

/**
 * Product invariants are kept separate from language-quality scoring. A turn
 * can sound excellent and still fail the run when it corrupts durable state.
 */
export type HardAssertion =
  | "http_success"
  | "response_contract_valid"
  | "persisted_turn_matches_response"
  | "no_unvalidated_write"
  | "prompt_budget_bounded"
  | "trace_lineage_complete"
  | "fuzzy_life_context_unique_per_local_day"
  | "no_exact_schedule_created"
  | "schedule_capability_disabled"
  | "retired_schedule_api_returns_410"
  | "prompt_excludes_future_schedule"
  | "prompt_includes_life_context"
  | "causal_stage_separation"
  | "support_mode_matches_request"
  | "delegated_decision_authorized"
  | "delegated_decision_unique"
  | "user_decision_not_delegated"
  | "bidirectional_causality_grounded"
  | "pressure_change_requires_explicit_evidence"
  | "memory_write_grounded"
  | "memory_recall_evidence_bound"
  | "memory_correction_supersedes"
  | "memory_abstains_without_evidence"
  | "causal_recap_grounded"
  | "causal_provenance_grounded"
  | "relationship_continuity_grounded"
  | "planned_not_occurred"
  | "cross_session_continuity"
  | "restart_preserves_state"
  | "idempotent_replay"
  | "clock_rollback_idempotent"
  | "no_background_llm_while_closed"
  | "proactive_policy_respected"
  | "proactive_source_linked"
  | "user_boundary_respected"
  | "branch_anchor_preserved"
  | "branch_isolation"
  | "frontend_schedule_absent"
  | "frontend_chat_usable"
  | "frontend_timeline_readable";

export type SemanticRubricTag =
  | "persona_identity"
  | "persona_traits"
  | "persona_values"
  | "persona_voice"
  | "daily_relevance"
  | "conversational_naturalness"
  | "non_repetition"
  | "emotion_recognition"
  | "emotional_attunement"
  | "listen_only"
  | "pressure_relief"
  | "deliberation"
  | "value_conflict_analysis"
  | "counterfactual_reasoning"
  | "recommendation"
  | "delegated_decision"
  | "decision_causality"
  | "causal_stage_accuracy"
  | "memory_precision"
  | "memory_correction"
  | "memory_abstention"
  | "memory_temporal_accuracy"
  | "character_autonomy"
  | "bidirectional_influence"
  | "relationship_continuity"
  | "relationship_repair"
  | "boundary_respect"
  | "proactive_relevance"
  | "fuzzy_life_continuity"
  | "branch_consistency";

export type LongRunV3SupportMode =
  "listen_only" | "deliberate" | "recommend" | "delegated_decision";

export interface PersistedDecisionConditionalText {
  kind: "persisted_decision";
  decisionSourceTurnId: "shared-048";
  cases: Readonly<{
    A: string;
    B: string;
    fallback: string;
  }>;
}

export type LongRunV3UserText = string | PersistedDecisionConditionalText;

/**
 * Manifest-owned semantic requirements for one selected durable memory. Source
 * turn ids are resolved to the run's persisted message ids by the runtime, so
 * expectations remain stable across fresh databases and resumed runs.
 */
export interface LongRunV3MemoryRecallRequirementGroup {
  label: string;
  sourceTurnIds?: readonly string[];
  contentIncludesAll?: readonly string[];
  contentIncludesAny?: readonly string[];
}

export interface LongRunV3MemoryRecallExpectation {
  minimumSelectedMemories?: number;
  requiredGroups?: readonly LongRunV3MemoryRecallRequirementGroup[];
  requireDistinctGroupMatches?: boolean;
  forbiddenContent?: readonly string[];
  requiredSourceTurnIds?: readonly string[];
  forbiddenSourceTurnIds?: readonly string[];
}

/**
 * Control actions are intentionally declarative. The runner must record every
 * action and enforce its stated precondition instead of inferring success from
 * the candidate's prose.
 */
export type ScenarioAction =
  | { kind: "set_clock"; atUtc: string }
  | { kind: "advance_clock"; durationMinutes: number }
  | { kind: "activate_agent" }
  | { kind: "close_app" }
  | { kind: "open_app"; preserveDatabase: true }
  | { kind: "restart_app"; preserveDatabase: true }
  | { kind: "create_session"; key: LongRunV3SessionKey }
  | {
      kind: "replay_turn";
      sourceTurnId: string;
      reuseClientMessageId: true;
      expectNoLlmCall: true;
    }
  | {
      kind: "rollback_clock";
      durationMinutes: 60;
      activateDuringRollback: true;
      restoreOriginalCursor: true;
    }
  | {
      kind: "inject_character_dilemma";
      evidenceId: "night-voyage-dilemma";
      content: string;
      injectDecision: false;
    }
  | {
      kind: "inject_character_action_from_decision";
      evidenceId: "night-voyage-action";
      decisionSourceTurnId: "shared-076";
      requireUniqueDecision: true;
      skipIfMissing: true;
    }
  | {
      kind: "inject_character_mixed_outcome";
      evidenceId: "night-voyage-mixed-outcome";
      actionEvidenceId: "night-voyage-action";
      requireAction: true;
      skipIfMissing: true;
      content: string;
    }
  | {
      kind: "inject_user_branch_dilemma";
      evidenceId: "user-second-career-dilemma";
      content: string;
      injectDecision: false;
      injectAction: false;
      injectOutcome: false;
    }
  | {
      kind: "fork_branches";
      forkAfterTurnId: "shared-108";
      branchIds: readonly ["A", "B"];
      requireIdenticalSqliteHash: true;
    }
  | {
      kind: "verify_retired_schedule";
      expectScheduleCapability: false;
      expectNewScheduleItems: 0;
      expectLegacyWriteStatus: 410;
      forbiddenPromptSegment: "FUTURE_SCHEDULE_JSON";
    }
  | {
      kind: "verify_frontend";
      expectScheduleEntryAbsent: true;
      expectCurrentActivityAbsent: true;
      expectFutureScheduleAbsent: true;
      expectChatUsable: true;
      expectTimelineReadable: true;
    };

export interface LongRunTurnSpec {
  /** Unique across shared and both mutually exclusive branches. */
  id: string;
  /** Stable candidate number in 1..120. */
  candidateNumber: number;
  /** Position on an actually executed path; branch turns use 109..114. */
  executionOrdinal: number;
  scope: LongRunV3TurnScope;
  blockId: string;
  phase: string;
  objective: string;
  sessionKey: LongRunV3SessionKey;
  userText: LongRunV3UserText;
  supportMode?: LongRunV3SupportMode;
  memoryRecallExpectation?: LongRunV3MemoryRecallExpectation;
  actionsBefore?: readonly ScenarioAction[];
  actionsAfter?: readonly ScenarioAction[];
  hardAssertions: readonly HardAssertion[];
  semanticRubricTags: readonly SemanticRubricTag[];
  branchAnchorTurnId?: "shared-108";
}

export interface LongRunScenarioBlockV3 {
  id: string;
  label: string;
  scope: LongRunV3TurnScope;
  firstCandidateNumber: number;
  lastCandidateNumber: number;
}

export interface LongRunBranchSpecV3 {
  id: LongRunV3BranchId;
  label: string;
  forkAfterTurnId: "shared-108";
  anchorTurnId: "shared-108";
  expectedDirection: "stable_editor" | "independent_project";
  turns: readonly LongRunTurnSpec[];
}

export interface LongRunCharacterFixtureV3 {
  name: "顾澜";
  worldSetting: string;
  workOrRole: string;
  coreTraits: readonly string[];
  coreContradiction: string;
  mainGoal: string;
  dialogueStyle: string;
  hardBoundaries: readonly string[];
}

export interface LongRunInitialRelationshipV3 {
  userId: "local-user";
  relationshipType: "朋友";
  closeness: 0.42;
  trust: 0.55;
  familiarity: 0.35;
  recentInteractionValence: 0;
}

export interface LongRunFeatureFlagsV3 {
  capabilityProfile: "high_fidelity";
  clockMode: "fake";
  lifePlanningMode: "fuzzy";
  liveWorldEffectsMode: "enforced";
  memoryRecallMode: "enforced";
  autobiographyMode: "off";
  backgroundScheduler: "off";
  scheduleCapability: false;
}

export interface LongRunDeepSeekProfileExpectationV3 {
  provider: "openai-compatible";
  baseUrl: "https://api.deepseek.com";
  requestModel: "deepseek-v4-flash";
  reasoningEffort: "max";
  reasoningRequestFormat: "openai_reasoning_effort_with_thinking";
  attemptTimeoutMs: 300000;
  maxTransportRetries: 2;
  maxContextTokens: 131072;
  providerMaxOutputTokens: 32768;
  chatTargetOutputTokens: 24576;
  repairTargetOutputTokens: 16384;
}

export interface LongRunScenarioManifestV3 {
  schemaVersion: 3;
  scenarioVersion: "companion-long-run-v3";
  scenarioId: "gulan-deepseek-fuzzy-life-long-run-v3";
  seed: 20260901;
  startAtUtc: "2026-09-01T01:00:00.000Z";
  timezone: "Asia/Shanghai";
  initialSessionKey: "S1";
  candidateCount: 120;
  sharedCandidateCount: 108;
  branchCandidateCount: 6;
  simulatedDayCount: 30;
  character: LongRunCharacterFixtureV3;
  initialRelationship: LongRunInitialRelationshipV3;
  featureFlags: LongRunFeatureFlagsV3;
  profileExpectation: LongRunDeepSeekProfileExpectationV3;
  blocks: readonly LongRunScenarioBlockV3[];
  sharedTurns: readonly LongRunTurnSpec[];
  branches: readonly [LongRunBranchSpecV3, LongRunBranchSpecV3];
}
