import type { SimulationTier } from "@personasim/contracts";

export interface ServerSimulationCapabilities {
  readonly schedulePlanning: boolean;
  readonly offlineSettlement: boolean;
  readonly hourlySettlement: boolean;
  readonly proactiveDialogue: boolean;
}

export interface ServerSimulationBundle {
  readonly id: SimulationTier;
  readonly pluginId: string;
  readonly capabilities: ServerSimulationCapabilities;
}

const BUNDLES: Readonly<Record<SimulationTier, ServerSimulationBundle>> = {
  lightweight: Object.freeze({
    id: "lightweight",
    pluginId: "server.bundle.lightweight",
    capabilities: Object.freeze({
      schedulePlanning: false,
      offlineSettlement: false,
      hourlySettlement: false,
      proactiveDialogue: false,
    }),
  }),
  daily: Object.freeze({
    id: "daily",
    pluginId: "server.bundle.daily",
    capabilities: Object.freeze({
      schedulePlanning: true,
      offlineSettlement: true,
      hourlySettlement: true,
      proactiveDialogue: false,
    }),
  }),
  high_fidelity: Object.freeze({
    id: "high_fidelity",
    pluginId: "server.bundle.high-fidelity",
    capabilities: Object.freeze({
      schedulePlanning: true,
      offlineSettlement: true,
      hourlySettlement: true,
      proactiveDialogue: true,
    }),
  }),
};

/**
 * Explicit tier profiles select their matching bundle. General application
 * profiles run the complete bundle because a local library may contain
 * characters from every tier.
 */
export function resolveServerBundle(profile: string): ServerSimulationBundle {
  const normalized = profile.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "lightweight") return BUNDLES.lightweight;
  if (normalized === "daily") return BUNDLES.daily;
  if (normalized === "high_fidelity") return BUNDLES.high_fidelity;
  return BUNDLES.high_fidelity;
}
