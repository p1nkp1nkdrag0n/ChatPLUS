import type { SimulationTier } from "./schemas.js";

export type SimulationCapabilities = {
  schedule: boolean;
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

const CAPABILITIES: Record<SimulationTier, SimulationCapabilities> = {
  lightweight: {
    schedule: false,
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
    schedule: true,
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
    schedule: true,
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
): SimulationCapabilities {
  return CAPABILITIES[tier];
}
