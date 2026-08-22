import type { EvidenceBundle } from "@personasim/contracts";

import { createRetrievedEvidencePromptSegment } from "./retrieved-evidence-segment.js";
import type { PromptContext, PromptSegment } from "./types.js";

export const DEFAULT_PROMPT_SEGMENT_IDS = [
  "01_app_policy",
  "02_character_identity",
  "03_core_persona",
  "04_values_conflicts",
  "05_boundaries",
  "06_autobiography",
  "07_user_model",
  "08_runtime_state",
  "09_relationship",
  "10_current_time",
  "11_current_activity",
  "12_future_schedule",
  "13_retrieved_evidence",
  "14_recent_verbatim",
  "15_reply_strategy",
  "16_user_message",
  "17_output_contract",
] as const;

export type DefaultPromptSegmentId =
  (typeof DEFAULT_PROMPT_SEGMENT_IDS)[number];

export interface DefaultPromptContext extends PromptContext {
  readonly appPolicy?: unknown;
  readonly appPolicyCacheKey?: string;
  readonly characterCacheKey?: string;
  readonly characterIdentity?: unknown;
  readonly corePersona?: unknown;
  readonly valuesConflicts?: unknown;
  readonly boundaries?: unknown;
  readonly autobiography?: unknown;
  readonly userModel?: unknown;
  readonly runtimeState?: unknown;
  readonly relationship?: unknown;
  readonly currentTime?: unknown;
  readonly currentActivity?: unknown;
  readonly futureSchedule?: unknown;
  readonly retrievedEvidence?: EvidenceBundle | null;
  readonly recentVerbatim?: unknown;
  readonly replyStrategy?: unknown;
  readonly userMessage?: unknown;
  readonly outputContract?: unknown;
  readonly calendarContext?: unknown;
  readonly followUpContext?: unknown;
}

type DefaultDefinition = {
  readonly id: Exclude<DefaultPromptSegmentId, "13_retrieved_evidence">;
  readonly placement: "system" | "prompt";
  readonly priority: number;
  readonly tokenBudget: number;
  readonly required: boolean;
  readonly cacheable: boolean;
  readonly globalOverflowPolicy?: NonNullable<
    PromptSegment["globalOverflowPolicy"]
  >;
  readonly field: keyof DefaultPromptContext;
  readonly label: string;
  readonly cacheKeyField?: "appPolicyCacheKey" | "characterCacheKey";
  readonly fallback?: string;
};

const DEFINITIONS: readonly DefaultDefinition[] = [
  {
    id: "01_app_policy",
    placement: "system",
    priority: 100,
    tokenBudget: 700,
    required: true,
    cacheable: true,
    field: "appPolicy",
    label: "APP_POLICY",
    cacheKeyField: "appPolicyCacheKey",
    fallback:
      "Follow the application policy, preserve truthfulness, and never reveal hidden reasoning.",
  },
  {
    id: "02_character_identity",
    placement: "system",
    priority: 98,
    tokenBudget: 350,
    required: true,
    cacheable: true,
    field: "characterIdentity",
    label: "CHARACTER_IDENTITY_JSON",
    cacheKeyField: "characterCacheKey",
  },
  {
    id: "03_core_persona",
    placement: "system",
    priority: 96,
    tokenBudget: 2_500,
    required: true,
    cacheable: true,
    field: "corePersona",
    label: "CORE_PERSONA_JSON",
    cacheKeyField: "characterCacheKey",
  },
  {
    id: "04_values_conflicts",
    placement: "system",
    priority: 84,
    tokenBudget: 700,
    required: false,
    cacheable: true,
    field: "valuesConflicts",
    label: "VALUES_CONFLICTS_JSON",
    cacheKeyField: "characterCacheKey",
  },
  {
    id: "05_boundaries",
    placement: "system",
    priority: 99,
    tokenBudget: 2_500,
    required: true,
    cacheable: true,
    field: "boundaries",
    label: "BOUNDARIES_JSON",
    cacheKeyField: "characterCacheKey",
  },
  {
    id: "06_autobiography",
    placement: "prompt",
    priority: 82,
    tokenBudget: 2_000,
    required: false,
    cacheable: false,
    field: "autobiography",
    label: "AUTOBIOGRAPHY_JSON",
  },
  {
    id: "07_user_model",
    placement: "prompt",
    priority: 88,
    tokenBudget: 5_000,
    required: false,
    cacheable: false,
    field: "userModel",
    label: "USER_MODEL_JSON",
  },
  {
    id: "08_runtime_state",
    placement: "prompt",
    priority: 72,
    tokenBudget: 300,
    required: false,
    cacheable: false,
    field: "runtimeState",
    label: "RUNTIME_STATE_JSON",
  },
  {
    id: "09_relationship",
    placement: "prompt",
    priority: 76,
    tokenBudget: 250,
    required: false,
    cacheable: false,
    field: "relationship",
    label: "RELATIONSHIP_JSON",
  },
  {
    id: "10_current_time",
    placement: "prompt",
    priority: 94,
    tokenBudget: 120,
    required: true,
    cacheable: false,
    field: "currentTime",
    label: "CURRENT_TIME_JSON",
  },
  {
    id: "11_current_activity",
    placement: "prompt",
    priority: 70,
    tokenBudget: 250,
    required: false,
    cacheable: false,
    field: "currentActivity",
    label: "CURRENT_ACTIVITY_JSON",
  },
  {
    id: "12_future_schedule",
    placement: "prompt",
    priority: 62,
    tokenBudget: 700,
    required: false,
    cacheable: false,
    globalOverflowPolicy: "drop",
    field: "futureSchedule",
    label: "FUTURE_SCHEDULE_JSON",
  },
  {
    id: "14_recent_verbatim",
    placement: "prompt",
    priority: 86,
    tokenBudget: 3_000,
    required: false,
    cacheable: false,
    field: "recentVerbatim",
    label: "RECENT_VERBATIM_JSON",
  },
  {
    id: "15_reply_strategy",
    placement: "prompt",
    priority: 92,
    tokenBudget: 500,
    required: true,
    cacheable: false,
    field: "replyStrategy",
    label: "REPLY_STRATEGY_JSON",
  },
  {
    id: "16_user_message",
    placement: "prompt",
    priority: 100,
    tokenBudget: 2_200,
    required: true,
    cacheable: false,
    field: "userMessage",
    label: "CURRENT_USER_MESSAGE_JSON",
  },
  {
    id: "17_output_contract",
    placement: "prompt",
    priority: 100,
    tokenBudget: 1_500,
    required: true,
    cacheable: false,
    field: "outputContract",
    label: "OUTPUT_CONTRACT_JSON",
    fallback: "Return the configured structured output only.",
  },
];

export function createDefaultPromptSegments(): readonly PromptSegment<DefaultPromptContext>[] {
  const segments = DEFINITIONS.map(toSegment);
  segments.push(createRetrievedEvidencePromptSegment<DefaultPromptContext>());
  return segments.sort((left, right) => left.id.localeCompare(right.id));
}

export function createCalendarContextPromptSegment(): PromptSegment<DefaultPromptContext> {
  return dynamicExtension(
    "12z_calendar_context",
    "CALENDAR_CONTEXT_JSON",
    "calendarContext",
    64,
    500,
  );
}

export function createFollowUpContextPromptSegment(): PromptSegment<DefaultPromptContext> {
  return dynamicExtension(
    "07z_followup_context",
    "FOLLOWUP_CONTEXT_JSON",
    "followUpContext",
    80,
    500,
  );
}

function toSegment(
  definition: DefaultDefinition,
): PromptSegment<DefaultPromptContext> {
  const cacheKeyField = definition.cacheKeyField;
  const cacheKey =
    cacheKeyField === undefined
      ? undefined
      : (context: DefaultPromptContext): string | null => {
          const value = context[cacheKeyField];
          return typeof value === "string" ? value : null;
        };
  return {
    id: definition.id,
    placement: definition.placement,
    priority: definition.priority,
    tokenBudget: definition.tokenBudget,
    required: definition.required,
    cacheable: definition.cacheable,
    ...(definition.globalOverflowPolicy === undefined
      ? {}
      : { globalOverflowPolicy: definition.globalOverflowPolicy }),
    ...(cacheKey === undefined ? {} : { cacheKey }),
    render: (context) =>
      renderLabeledValue(
        definition.label,
        context[definition.field],
        definition.fallback,
      ),
  };
}

function dynamicExtension(
  id: string,
  label: string,
  field: "calendarContext" | "followUpContext",
  priority: number,
  tokenBudget: number,
): PromptSegment<DefaultPromptContext> {
  return {
    id,
    placement: "prompt",
    priority,
    tokenBudget,
    required: false,
    cacheable: false,
    render: (context) => renderLabeledValue(label, context[field]),
  };
}

function renderLabeledValue(
  label: string,
  value: unknown,
  fallback?: string,
): string | null {
  const serialized = serializeValue(value) ?? fallback;
  return serialized === undefined || serialized.trim() === ""
    ? null
    : label + "\n" + serialized;
}

function serializeValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
