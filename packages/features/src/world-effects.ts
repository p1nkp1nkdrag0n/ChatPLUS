import {
  MemoryCandidateSchema,
  PersonalIntentCandidateSchema,
  RelationshipDeltaSchema,
  RuntimeStateDeltaSchema,
  type MemoryCandidate,
  type PersonaTurnEnvelope,
  type PersonalIntentCandidate,
  type RelationshipDelta,
  type RuntimeStateDelta,
} from "@personasim/contracts";

import { applyRelationshipDelta } from "./relationship-engine.js";
import { clampStateDelta } from "./state-engine.js";

export type WorldEffectKind =
  | "state_delta"
  | "relationship_delta"
  | "memory_candidate"
  | "personal_intent_candidate";

export interface WorldEffectRejection {
  effect: WorldEffectKind;
  index?: number;
  field?: string;
  reasonCode: string;
  reasonSummary: string;
  raw: unknown;
}

export interface ValidatedWorldEffects {
  stateDelta?: RuntimeStateDelta;
  relationshipDelta?: RelationshipDelta;
  memoryCandidates: MemoryCandidate[];
  personalIntentCandidates: PersonalIntentCandidate[];
}

export interface WorldEffectsValidationResult {
  proposed: {
    stateDelta?: unknown;
    relationshipDelta?: unknown;
  };
  effects: ValidatedWorldEffects;
  rejections: WorldEffectRejection[];
  limitsApplied: WorldEffectKind[];
}

const LIVE_STATE_DELTA_MAXIMUM = 0.2;
const STATE_KEYS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
] as const;
const RELATIONSHIP_KEYS = [
  "closeness",
  "trust",
  "familiarity",
  "recentInteractionValence",
] as const;
const SERVER_OWNED_STATE_KEYS = new Set([
  "agentId",
  "asOfUtc",
  "revision",
  "sleepDebtMinutes",
  "currentActivityId",
  "locationContext",
  "relationship",
]);
type ModelMemoryTypeDescriptor = {
  kind: MemoryCandidate["kind"];
  explicitUser: boolean;
  stability: NonNullable<MemoryCandidate["stability"]>;
};

const MODEL_MEMORY_TYPES = {
  user_fact: { kind: "semantic", explicitUser: true, stability: "stable" },
  user_preference: {
    kind: "semantic",
    explicitUser: true,
    stability: "stable",
  },
  fact: { kind: "semantic", explicitUser: true, stability: "stable" },
  preference: { kind: "semantic", explicitUser: true, stability: "stable" },
  semantic: {
    kind: "semantic",
    explicitUser: false,
    stability: "situational",
  },
  episodic: { kind: "episodic", explicitUser: false, stability: "one_off" },
  relationship: {
    kind: "relationship",
    explicitUser: false,
    stability: "situational",
  },
  commitment: {
    kind: "commitment",
    explicitUser: false,
    stability: "situational",
  },
  user_current_challenge: {
    kind: "episodic",
    explicitUser: true,
    stability: "situational",
  },
  care_preference: {
    kind: "semantic",
    explicitUser: true,
    stability: "stable",
  },
  personal_preference: {
    kind: "semantic",
    explicitUser: true,
    stability: "stable",
  },
} as const satisfies Record<string, ModelMemoryTypeDescriptor>;

function boundedUnit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

/**
 * Converts the deliberately small model-facing memory proposal into the
 * existing strict server candidate. Evidence ids, timestamps, lifecycle state,
 * dedupe keys and persistence metadata are never accepted from the model.
 */
function modelMemoryCandidate(
  raw: unknown,
):
  | { success: true; data: MemoryCandidate }
  | { success: false; reasonCode?: string; reasonSummary?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { success: false };
  }
  const record = raw as Record<string, unknown>;
  const rawType =
    typeof record["type"] === "string"
      ? record["type"].trim().toLowerCase()
      : typeof record["kind"] === "string"
        ? record["kind"].trim().toLowerCase()
        : "";
  const descriptor =
    MODEL_MEMORY_TYPES[rawType as keyof typeof MODEL_MEMORY_TYPES];
  const kind = descriptor?.kind;
  const content =
    typeof record["content"] === "string"
      ? record["content"].trim()
      : typeof record["text"] === "string"
        ? record["text"].trim()
        : "";
  if (descriptor === undefined || content === "") return { success: false };

  for (const key of [
    "id",
    "agentId",
    "status",
    "dedupeKey",
    "createdAtUtc",
    "updatedAtUtc",
    "recordedAtUtc",
  ]) {
    if (record[key] !== undefined && record[key] !== null) {
      return {
        success: false,
        reasonCode: "server_owned_effect_field",
        reasonSummary: `Memory field ${key} is server-owned.`,
      };
    }
  }
  for (const key of ["sourceMessageIds", "sourceActivityEventIds"]) {
    const value = record[key];
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      return {
        success: false,
        reasonCode: "server_owned_effect_field",
        reasonSummary: `Memory field ${key} must be omitted.`,
      };
    }
  }

  const explicitUser = descriptor.explicitUser;
  const tags = Array.isArray(record["tags"])
    ? record["tags"]
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  if (!tags.includes(rawType)) tags.unshift(rawType);
  const namespace = explicitUser
    ? ("user_model" as const)
    : kind === "relationship" || kind === "commitment"
      ? ("shared_relationship" as const)
      : undefined;
  const certainty = explicitUser
    ? ("explicit" as const)
    : ("inferred" as const);
  const attribution = explicitUser
    ? ("user_explicit" as const)
    : ("model_inference" as const);
  const stability = descriptor.stability;
  const materialized = MemoryCandidateSchema.safeParse({
    kind,
    content: content.slice(0, 2_000),
    importance: boundedUnit(record["importance"], explicitUser ? 0.65 : 0.5),
    confidence: boundedUnit(record["confidence"], explicitUser ? 0.95 : 0.7),
    tags,
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    ...(namespace === undefined ? {} : { namespace }),
    certainty,
    attribution,
    stability,
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: "model_memory_candidate",
    reasonSummary:
      "The server materialized a fuzzy model memory proposal for evidence validation.",
  });
  return materialized.success ? materialized : { success: false };
}

const MODEL_INTENT_CATEGORY_ALIASES: Record<string, string> = {
  social_support: "social",
};

function modelPersonalIntentCandidate(
  raw: unknown,
):
  | { success: true; data: PersonalIntentCandidate }
  | { success: false; reasonCode?: string; reasonSummary?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { success: false };
  }
  const record = raw as Record<string, unknown>;
  for (const key of [
    "id",
    "agentId",
    "sessionId",
    "desiredDurationMinutes",
    "earliestAtUtc",
    "latestAtUtc",
    "basisRefIds",
    "evidenceMessageIds",
    "priority",
    "freshness",
    "status",
    "dedupeKey",
    "specVersion",
    "schemaVersion",
    "attemptCount",
    "lastAttemptAtUtc",
    "createdAtUtc",
    "updatedAtUtc",
  ]) {
    if (record[key] !== undefined && record[key] !== null) {
      return {
        success: false,
        reasonCode: "server_owned_effect_field",
        reasonSummary: "Personal-intent field " + key + " is server-owned.",
      };
    }
  }
  const activity =
    typeof record["activity"] === "string"
      ? record["activity"]
      : record["fuzzyActivity"];
  const rawCategory =
    typeof record["category"] === "string"
      ? record["category"].trim().toLowerCase()
      : undefined;
  const category =
    rawCategory === undefined
      ? undefined
      : (MODEL_INTENT_CATEGORY_ALIASES[rawCategory] ?? rawCategory);
  const parsed = PersonalIntentCandidateSchema.safeParse({
    activity,
    ...(category === undefined ? {} : { category }),
    ...(record["durationHint"] === undefined
      ? {}
      : { durationHint: record["durationHint"] }),
    ...(record["timingHint"] === undefined
      ? {}
      : { timingHint: record["timingHint"] }),
    basisKind: record["basisKind"],
    evidenceQuotes: record["evidenceQuotes"],
    reasonCode: record["reasonCode"],
    reasonSummary: record["reasonSummary"],
  });
  return parsed.success ? parsed : { success: false };
}

function clampLiveStateDelta(delta: RuntimeStateDelta): {
  delta: RuntimeStateDelta;
  limited: boolean;
} {
  const alreadySafe = clampStateDelta(delta);
  const limited: Record<string, number> = {};
  let wasLimited = false;
  for (const key of STATE_KEYS) {
    const requested = alreadySafe[key];
    if (requested === undefined) continue;
    const applied = Math.max(
      -LIVE_STATE_DELTA_MAXIMUM,
      Math.min(LIVE_STATE_DELTA_MAXIMUM, requested),
    );
    limited[key] = applied;
    wasLimited ||= applied !== requested;
  }
  return {
    delta: RuntimeStateDeltaSchema.parse(limited),
    limited: wasLimited,
  };
}

function sanitizeNumericDelta(
  raw: unknown,
  effect: "state_delta" | "relationship_delta",
  allowedKeys: readonly string[],
  rejections: WorldEffectRejection[],
): Record<string, number> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    rejections.push({
      effect,
      reasonCode:
        effect === "state_delta"
          ? "invalid_state_delta"
          : "invalid_relationship_delta",
      reasonSummary: "The delta must be a JSON object.",
      raw,
    });
    return undefined;
  }
  const allowed = new Set(allowedKeys);
  const sanitized: Record<string, number> = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!allowed.has(field)) {
      const serverOwned =
        effect === "state_delta" && SERVER_OWNED_STATE_KEYS.has(field);
      rejections.push({
        effect,
        field,
        reasonCode: serverOwned
          ? "server_owned_state_field"
          : effect === "state_delta"
            ? "unknown_state_delta_field"
            : "unknown_relationship_delta_field",
        reasonSummary: serverOwned
          ? `State field ${field} is server-owned and was removed.`
          : `Delta field ${field} is not supported and was removed.`,
        raw: value,
      });
      continue;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < -1 ||
      value > 1
    ) {
      rejections.push({
        effect,
        field,
        reasonCode:
          effect === "state_delta"
            ? "invalid_state_delta_field"
            : "invalid_relationship_delta_field",
        reasonSummary: `Delta field ${field} must be a finite number from -1 to 1 and was removed.`,
        raw: value,
      });
      continue;
    }
    sanitized[field] = value;
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function pushCandidateRejections(
  raw: unknown,
  effect: "memory_candidate" | "personal_intent_candidate",
  maximum: number,
  parse: (candidate: unknown) =>
    | { success: true; data: MemoryCandidate | PersonalIntentCandidate }
    | {
        success: false;
        reasonCode?: string;
        reasonSummary?: string;
      },
  accepted: Array<MemoryCandidate | PersonalIntentCandidate>,
  rejections: WorldEffectRejection[],
): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    rejections.push({
      effect,
      reasonCode: "invalid_effect_collection",
      reasonSummary: "World-effect candidates must be an array.",
      raw,
    });
    return;
  }
  if (raw.length > maximum) {
    rejections.push({
      effect,
      reasonCode: "effect_collection_limit",
      reasonSummary: `At most ${maximum} candidates are evaluated.`,
      raw: raw.slice(maximum),
    });
  }
  for (const [index, candidate] of raw.slice(0, maximum).entries()) {
    const parsed = parse(candidate);
    if (parsed.success) {
      accepted.push(parsed.data);
    } else {
      rejections.push({
        effect,
        index,
        reasonCode: parsed.reasonCode ?? "invalid_effect_candidate",
        reasonSummary:
          parsed.reasonSummary ?? "The candidate failed its strict contract.",
        raw: candidate,
      });
    }
  }
}

/**
 * Validates each model-proposed world effect independently. A malformed effect
 * is rejected without invalidating the conversational reply or valid siblings.
 */
export function validateWorldEffects(
  raw: PersonaTurnEnvelope["worldEffects"],
): WorldEffectsValidationResult {
  const proposed = {
    ...(raw.stateDelta === undefined ? {} : { stateDelta: raw.stateDelta }),
    ...(raw.relationshipDelta === undefined
      ? {}
      : { relationshipDelta: raw.relationshipDelta }),
  };
  const effects: ValidatedWorldEffects = {
    memoryCandidates: [],
    personalIntentCandidates: [],
  };
  const rejections: WorldEffectRejection[] = [];
  const limitsApplied: WorldEffectKind[] = [];

  if (raw.stateDelta !== undefined) {
    const sanitized = sanitizeNumericDelta(
      raw.stateDelta,
      "state_delta",
      STATE_KEYS,
      rejections,
    );
    if (sanitized !== undefined) {
      const parsed = RuntimeStateDeltaSchema.parse(sanitized);
      const clamped = clampLiveStateDelta(parsed);
      effects.stateDelta = clamped.delta;
      if (clamped.limited) limitsApplied.push("state_delta");
    }
  }

  if (raw.relationshipDelta !== undefined) {
    const sanitized = sanitizeNumericDelta(
      raw.relationshipDelta,
      "relationship_delta",
      RELATIONSHIP_KEYS,
      rejections,
    );
    if (sanitized !== undefined) {
      const parsed = RelationshipDeltaSchema.parse(sanitized);
      const clamped = applyRelationshipDelta(
        {
          userId: "local-user",
          closeness: 0.5,
          trust: 0.5,
          familiarity: 0.5,
          recentInteractionValence: 0,
        },
        parsed,
        "1970-01-01T00:00:00.000Z",
      );
      effects.relationshipDelta = RelationshipDeltaSchema.parse(
        clamped.appliedDelta,
      );
      if (clamped.limited) limitsApplied.push("relationship_delta");
    }
  }

  const memories: Array<MemoryCandidate | PersonalIntentCandidate> = [];
  pushCandidateRejections(
    raw.memoryCandidates,
    "memory_candidate",
    8,
    modelMemoryCandidate,
    memories,
    rejections,
  );
  effects.memoryCandidates = memories as MemoryCandidate[];

  const intents: Array<MemoryCandidate | PersonalIntentCandidate> = [];
  pushCandidateRejections(
    raw.personalIntentCandidates,
    "personal_intent_candidate",
    8,
    modelPersonalIntentCandidate,
    intents,
    rejections,
  );
  effects.personalIntentCandidates = intents as PersonalIntentCandidate[];

  return { proposed, effects, rejections, limitsApplied };
}
