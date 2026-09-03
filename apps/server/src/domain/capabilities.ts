import type { SimulationTier } from "./schemas.js";

export type LifePlanningMode = "fuzzy" | "legacy_exact";

/** Capabilities intrinsic to a simulation tier, before runtime-mode gating. */
export type TierSimulationCapabilities = {
  /** Support for the retired UTC ScheduleItem planner and settlement model. */
  legacyExactSchedule: boolean;
  offlineSettlement: boolean;
  dynamicState: boolean;
  longTermMemory: boolean;
  relationshipDynamics: boolean;
  relationshipDeltaScale: number;
  proactiveDialogue: boolean;
  personaGuard: boolean;
  activityEnrichment: boolean;
  memoryCandidatesPerTurn: number;
};

/**
 * Effective capabilities for one running server.
 *
 * `schedule` is retained as a wire-compatibility alias. New server code must
 * use `fuzzyLife` or `legacyExactSchedule`, which cannot both be true.
 */
export type SimulationCapabilities = TierSimulationCapabilities & {
  fuzzyLife: boolean;
  /** @deprecated Use legacyExactSchedule. */
  schedule: boolean;
};

const CAPABILITIES: Record<SimulationTier, TierSimulationCapabilities> = {
  lightweight: {
    legacyExactSchedule: false,
    offlineSettlement: false,
    dynamicState: false,
    longTermMemory: false,
    relationshipDynamics: false,
    relationshipDeltaScale: 0,
    proactiveDialogue: false,
    personaGuard: false,
    activityEnrichment: false,
    memoryCandidatesPerTurn: 0,
  },
  daily: {
    legacyExactSchedule: true,
    offlineSettlement: true,
    dynamicState: true,
    longTermMemory: true,
    relationshipDynamics: true,
    relationshipDeltaScale: 0.5,
    proactiveDialogue: false,
    personaGuard: false,
    activityEnrichment: false,
    memoryCandidatesPerTurn: 4,
  },
  high_fidelity: {
    legacyExactSchedule: true,
    offlineSettlement: true,
    dynamicState: true,
    longTermMemory: true,
    relationshipDynamics: true,
    relationshipDeltaScale: 1,
    // Temporarily disabled product-wide. Keep the dormant contracts and
    // persistence path readable until the stale-subject/lifecycle issue is
    // fixed and the feature is explicitly re-enabled.
    proactiveDialogue: false,
    personaGuard: true,
    activityEnrichment: true,
    memoryCandidatesPerTurn: 8,
  },
};

export function capabilitiesForTier(
  tier: SimulationTier,
): TierSimulationCapabilities {
  return CAPABILITIES[tier];
}

/** Resolve mutually exclusive fuzzy-life and legacy exact-schedule worlds. */
export function capabilitiesForRuntime(
  tier: SimulationTier,
  lifePlanningMode: LifePlanningMode,
): SimulationCapabilities {
  const tierCapabilities = capabilitiesForTier(tier);
  const legacyExactSchedule =
    lifePlanningMode === "legacy_exact" && tierCapabilities.legacyExactSchedule;
  return {
    ...tierCapabilities,
    fuzzyLife: lifePlanningMode === "fuzzy",
    legacyExactSchedule,
    // Old clients understand schedule as exact ScheduleItem support. Preserve
    // that meaning while exposing an unambiguous canonical field alongside it.
    schedule: legacyExactSchedule,
  };
}
