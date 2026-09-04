import type { KeepsakeKind, KeepsakeSourceType } from "@personasim/contracts";

export type KeepsakeSourceFactStatus =
  "planned" | "unknown" | "observed" | "confirmed" | "read";

export interface KeepsakeSourceCandidate {
  readonly agentId: string;
  readonly sourceType: KeepsakeSourceType;
  readonly sourceId: string;
  readonly status: KeepsakeSourceFactStatus;
  readonly significance: number;
  readonly effectiveAtUtc: string;
  readonly semanticTags: readonly string[];
}

export interface ExistingKeepsakeSignature {
  readonly kind: KeepsakeKind;
  readonly semanticKey: string;
  readonly createdEffectiveAtUtc: string;
}

export interface KeepsakeEligibilityOptions {
  readonly significanceThreshold?: number;
  readonly cooldownDays?: number;
  readonly requestedKind?: KeepsakeKind;
}

export type KeepsakeIneligibilityReason =
  | "source_not_settled"
  | "source_in_future"
  | "below_significance_threshold"
  | "duplicate_semantic_signature"
  | "kind_cooldown_active";

export interface KeepsakeEligibilityDecision {
  readonly eligible: boolean;
  readonly kind: KeepsakeKind;
  readonly semanticKey: string;
  readonly reasonCodes: readonly KeepsakeIneligibilityReason[];
}

const DEFAULT_SIGNIFICANCE_THRESHOLD = 0.65;
const DEFAULT_COOLDOWN_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Deterministic pre-model gate. The caller projects durable records into the
 * compact candidate shape; no prose model is consulted until this returns an
 * eligible decision.
 */
export function evaluateKeepsakeEligibility(
  candidate: KeepsakeSourceCandidate,
  history: readonly ExistingKeepsakeSignature[],
  observedNowUtc: string,
  options: KeepsakeEligibilityOptions = {},
): KeepsakeEligibilityDecision {
  const kind = options.requestedKind ?? deriveKeepsakeKind(candidate);
  const semanticKey = buildKeepsakeSemanticKey(candidate, kind);
  const reasons: KeepsakeIneligibilityReason[] = [];
  const threshold =
    options.significanceThreshold ?? DEFAULT_SIGNIFICANCE_THRESHOLD;
  const cooldownDays = options.cooldownDays ?? DEFAULT_COOLDOWN_DAYS;

  if (!isSettledSource(candidate)) reasons.push("source_not_settled");
  if (Date.parse(candidate.effectiveAtUtc) > Date.parse(observedNowUtc)) {
    reasons.push("source_in_future");
  }
  if (candidate.significance < threshold) {
    reasons.push("below_significance_threshold");
  }
  if (history.some((item) => item.semanticKey === semanticKey)) {
    reasons.push("duplicate_semantic_signature");
  }

  const cooldownBoundary =
    Date.parse(candidate.effectiveAtUtc) - Math.max(0, cooldownDays) * DAY_MS;
  if (
    history.some(
      (item) =>
        item.kind === kind &&
        Date.parse(item.createdEffectiveAtUtc) >= cooldownBoundary &&
        Date.parse(item.createdEffectiveAtUtc) <=
          Date.parse(candidate.effectiveAtUtc),
    )
  ) {
    reasons.push("kind_cooldown_active");
  }

  return {
    eligible: reasons.length === 0,
    kind,
    semanticKey,
    reasonCodes: reasons,
  };
}

export function isSettledSource(candidate: KeepsakeSourceCandidate): boolean {
  switch (candidate.sourceType) {
    case "life_outcome":
      return (
        candidate.status === "observed" || candidate.status === "confirmed"
      );
    case "relationship_milestone":
    case "reflection":
      return candidate.status === "confirmed";
    case "letter":
      return candidate.status === "read";
  }
}

export function deriveKeepsakeKind(
  candidate: KeepsakeSourceCandidate,
): KeepsakeKind {
  const tags = new Set(candidate.semanticTags.map(normalizeTag));
  if (hasAny(tags, ["travel", "trip", "location", "journey", "旅行", "地点"])) {
    return "postcard";
  }
  if (
    hasAny(tags, [
      "exhibition",
      "performance",
      "concert",
      "cinema",
      "event",
      "展览",
      "演出",
      "电影",
    ])
  ) {
    return "ticket_stub";
  }
  if (hasAny(tags, ["food", "cooking", "recipe", "饮食", "料理", "食谱"])) {
    return "recipe_or_note_card";
  }
  if (hasAny(tags, ["flower", "season", "garden", "花", "季节", "植物"])) {
    return "pressed_flower";
  }
  if (hasAny(tags, ["art", "drawing", "creative", "sketch", "绘画", "创作"])) {
    return "sketch";
  }
  return "recipe_or_note_card";
}

/** Stable pre-hash value used for dedupe and the server-owned idempotency key. */
export function buildKeepsakeSemanticKey(
  candidate: KeepsakeSourceCandidate,
  kind: KeepsakeKind,
): string {
  const tags = [...new Set(candidate.semanticTags.map(normalizeTag))]
    .filter((tag) => tag.length > 0)
    .sort(codeUnitCompare);
  return [
    "keepsake-semantic-v1",
    candidate.agentId,
    candidate.sourceType,
    candidate.sourceId,
    kind,
    tags.join(","),
  ].join("|");
}

function normalizeTag(tag: string): string {
  return tag.trim().toLocaleLowerCase("und");
}

function hasAny(
  values: ReadonlySet<string>,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => values.has(candidate));
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
