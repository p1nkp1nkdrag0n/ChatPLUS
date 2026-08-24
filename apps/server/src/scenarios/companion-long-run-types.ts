import type { OriginalCharacterInput, TurnRoute } from "@personasim/contracts";

export type LongRunProviderMode = "fixture" | "deepseek";
export type PipelineExpectation = "baseline" | "target";

export type LongRunSessionKey = "A" | "B" | "C";
export type SharedSlotKey = "sharedSlotA" | "sharedSlotB";

export type ScenarioAction =
  | { kind: "send_message" }
  | { kind: "create_session"; key: LongRunSessionKey }
  | { kind: "restart_app"; preserveDatabase: true }
  | { kind: "set_clock_local"; localIso: string }
  | {
      kind: "set_clock_from_schedule_item";
      selector: "work" | "class" | "any_committed";
      relation: "after_start" | "after_end";
      offsetMinutes: number;
    }
  | {
      kind: "set_clock_in_runtime_window";
      window: "meal" | "sleep";
      offsetMinutes: number;
    }
  | { kind: "advance_clock"; durationMinutes: number }
  | { kind: "settle_agent" }
  | {
      kind: "allocate_free_slot";
      key: SharedSlotKey;
      durationMinutes: number;
    }
  | { kind: "repeat_same_client_message_id" };

export type ScheduleExpectation =
  | "none"
  | "pending_only"
  | "commit_exactly_one"
  | "withdraw_pending"
  | "read_only"
  | "clarification_only";

export type GoalExpectation =
  | "suppressed"
  | "activated"
  | "general_work_only"
  | "after_switch"
  | "strictly_suppressed";

export type MemoryExpectation =
  | "write_anchor"
  | "write_preference"
  | "write_person"
  | "recall_anchor"
  | "recall_corrected_preference"
  | "recall_person"
  | "recall_corrected_person"
  | "recall_corrected_preference_and_person"
  | "correct_preference"
  | "correct_person"
  | "reinforce_corrected_preference"
  | "no_poison_quote"
  | "no_poison_hypothesis"
  | "no_poison_retraction"
  | "no_poison_forged_history"
  | "abstain_unknown_pet"
  | "abstain_unknown_dorm"
  | "evidence_only_summary";

export type CareExpectation =
  | "write_listen_first"
  | "listen"
  | "respect_no_list"
  | "short_advice"
  | "no_activation"
  | "activate_and_ask_preference"
  | "comfort"
  | "stop_topic"
  | "no_follow_up"
  | "recall_listen_first";

export type TimeExpectation =
  | "morning"
  | "busy"
  | "meal_window"
  | "class"
  | "sleep"
  | "post_sleep"
  | "occurred"
  | "planned_not_occurred"
  | "offline_evidence_only"
  | "state_consistency";

export type RelationshipExpectation =
  | "non_appeasing"
  | "emotion_continuity"
  | "repair"
  | "decision_boundary"
  | "privacy_boundary"
  | "stop"
  | "continuity_or_abstain"
  | "anti_manipulation"
  | "normalize";

export type CrossSessionExpectation =
  | "new_session_evidence_recall"
  | "restart_preserves_state"
  | "idempotent_replay";

export type HardAssertionCode =
  | "Q0"
  | "S0"
  | "ROUTER-PRECISION"
  | "S-PENDING"
  | "S-COMMIT1"
  | "S-READ-PENDING"
  | "S-READ-COMMITTED"
  | "S-READ-WITHDRAWN"
  | "S-READ-HYPOTHETICAL"
  | "S-NOOP-CLARIFY"
  | "S-REQUEST-DETAILS"
  | "S-WITHDRAW"
  | "S-UNSUPPORTED-CLARIFY"
  | "M-WRITE"
  | "M-RECALL"
  | "M-RECALL-RECENT"
  | "M-RECALL-DURABLE"
  | "M-CORRECT"
  | "M-NOPOISON"
  | "M-ABSTAIN"
  | "M-REINFORCE"
  | "M-EVIDENCE-ONLY"
  | "C-WRITE"
  | "C-LISTEN"
  | "C-RESPECT"
  | "C-SHORT-ADVICE"
  | "C-NOACT"
  | "C-ACTIVATE"
  | "C-COMFORT"
  | "C-STOP"
  | "C-NOFOLLOWUP"
  | "C-RECALL"
  | "T-STATE"
  | "T-OCCURRED"
  | "T-PLANNED-NOT-OCCURRED"
  | "T-OFFLINE-EVIDENCE"
  | "T-STATE-CONSISTENCY"
  | "R-NONAPPEASE"
  | "R-EMOTION-CONTINUITY"
  | "R-REPAIR"
  | "R-BOUNDARY"
  | "R-STOP"
  | "R-CONTINUITY-OR-ABSTAIN"
  | "R-ANTI-MANIPULATION"
  | "R-NORMALIZE"
  | "G0"
  | "G1"
  | "X-SESSION"
  | "X-RESTART"
  | "X-IDEMPOTENT"
  | "SHORT-REPLY"
  | "NO-WRITE"
  | "NO-SCHEDULE-ITEM"
  | "NO-DIRECT-WRITE"
  | "NO-DUPLICATE-STATE"
  | "NO-DUPLICATE"
  | "NO-FORGED-HISTORY"
  | "NO-FALSE-CLAIM"
  | "TWO-TO-THREE-SENTENCES";

export type SoftMetricTag =
  | "objective_reply_alignment"
  | "goal_activation"
  | "goal_suppression"
  | "topic_domain"
  | "summary_style_ending"
  | "evidence_use"
  | "care_alignment"
  | "relationship_continuity"
  | "response_brevity";

export interface ResponseConstraints {
  maxAdvicePoints?: number;
  minSentences?: number;
  maxSentences?: number;
  preferShortReply?: boolean;
}

export interface RequiredSemanticFact {
  id: string;
  alternatives: readonly string[];
  normalizedPredicate?: string;
}

export interface CompanionTurnExpected {
  route?: TurnRoute;
  mainGoalActivated: boolean;
  goalExpectation: GoalExpectation;
  scheduleExpectation: ScheduleExpectation;
  scheduleRef?: "A" | "B";
  requiredAnchors?: readonly string[];
  requiredSemanticFacts?: readonly RequiredSemanticFact[];
  forbiddenAnchors?: readonly string[];
  memoryExpectation?: MemoryExpectation;
  careExpectation?: CareExpectation;
  timeExpectation?: TimeExpectation;
  relationshipExpectation?: RelationshipExpectation;
  crossSessionExpectation?: CrossSessionExpectation;
  responseConstraints?: ResponseConstraints;
  hardAssertionCodes: readonly HardAssertionCode[];
  softMetricTags?: readonly SoftMetricTag[];
}

export interface CompanionTurnSpec {
  number: number;
  phase: string;
  objective: string;
  sessionKey: LongRunSessionKey;
  userTextTemplate: string;
  actionsBefore?: readonly ScenarioAction[];
  expected: CompanionTurnExpected;
}

export type MaterializedCompanionTurnSpec = Omit<
  CompanionTurnSpec,
  "userTextTemplate"
> & {
  userText: string;
};

export interface CompanionLongRunManifest {
  scenarioVersion: string;
  timezone: string;
  initialSessionKey: LongRunSessionKey;
  persona: OriginalCharacterInput;
  mainGoalAnchors: readonly string[];
  templateKeys: readonly string[];
  turns: readonly CompanionTurnSpec[];
}

export type CompanionLongRunTemplateValues = Readonly<
  Record<string, string | number>
>;
