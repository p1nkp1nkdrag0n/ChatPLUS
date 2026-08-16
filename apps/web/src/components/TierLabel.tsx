import type { SimulationTier } from "../api/types";

const LABELS: Record<SimulationTier, string> = {
  lightweight: "轻量模拟",
  daily: "日常模拟",
  high_fidelity: "拟真模拟",
};

export function TierLabel({ tier }: { tier: SimulationTier }) {
  return (
    <span className={`tier-label tier-label--${tier}`}>{LABELS[tier]}</span>
  );
}
