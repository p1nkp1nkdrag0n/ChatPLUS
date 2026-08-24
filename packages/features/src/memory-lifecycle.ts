import { normalizeText } from "./shared.js";

export type MemoryLifecycleStatusLike =
  | "active"
  | "aging"
  | "archived"
  | "superseded"
  | "merged"
  | "needs_review"
  | "forgotten";

export type MemoryClaimDispositionLike =
  "affirmed" | "negated" | "cancelled" | "completed";

export interface MemoryClaimSemanticsLike {
  subjectKey: string;
  disposition: MemoryClaimDispositionLike;
  recordedAtUtc: string;
}

export interface LifecycleMemoryLike {
  id: string;
  kind: "semantic" | "episodic" | "relationship" | "commitment";
  content: string;
  importance: number;
  confidence: number;
  tags?: readonly string[];
  status: MemoryLifecycleStatusLike;
  stability?: "one_off" | "situational" | "stable";
  certainty?: "explicit" | "inferred" | "uncertain";
  attribution?:
    | "user_explicit"
    | "character_decision"
    | "simulation_event"
    | "model_inference"
    | "mixed";
  claim?: MemoryClaimSemanticsLike;
  expiresAtUtc?: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  lifecycleUpdatedAtUtc?: string;
  lastReinforcedAtUtc?: string;
}

export interface MemoryLifecyclePolicyLike {
  activeToAgingDays: number;
  agingToArchivedDays: number;
  protectedImportance: number;
}

export const DEFAULT_MEMORY_LIFECYCLE_POLICY: MemoryLifecyclePolicyLike = {
  activeToAgingDays: 30,
  agingToArchivedDays: 90,
  protectedImportance: 0.8,
};

export interface MemoryLifecycleTransition {
  memoryId: string;
  fromStatus: MemoryLifecycleStatusLike;
  toStatus: "aging" | "archived";
  reasonCode:
    | "legacy_forgotten_normalized"
    | "memory_expired"
    | "memory_aged"
    | "memory_archived";
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function ageDays(nowMs: number, thenUtc: string): number {
  const then = Date.parse(thenUtc);
  if (!Number.isFinite(then)) {
    throw new TypeError("Memory lifecycle timestamps must be valid instants");
  }
  return Math.max(0, (nowMs - then) / DAY_MS);
}

function protectedFromAging(
  memory: LifecycleMemoryLike,
  policy: MemoryLifecyclePolicyLike,
): boolean {
  return (
    memory.stability === "stable" ||
    memory.importance >= policy.protectedImportance ||
    (memory.kind === "commitment" && memory.claim?.disposition === "affirmed")
  );
}

export function planMemoryLifecycleTransition(input: {
  memory: LifecycleMemoryLike;
  nowUtc: string;
  policy?: MemoryLifecyclePolicyLike;
}): MemoryLifecycleTransition | undefined {
  const policy = input.policy ?? DEFAULT_MEMORY_LIFECYCLE_POLICY;
  const nowMs = Date.parse(input.nowUtc);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("nowUtc must be a valid instant");
  }
  const memory = input.memory;
  if (memory.status === "forgotten") {
    return {
      memoryId: memory.id,
      fromStatus: memory.status,
      toStatus: "archived",
      reasonCode: "legacy_forgotten_normalized",
    };
  }
  if (memory.status !== "active" && memory.status !== "aging") {
    return undefined;
  }
  if (
    memory.expiresAtUtc !== undefined &&
    Date.parse(memory.expiresAtUtc) <= nowMs
  ) {
    return {
      memoryId: memory.id,
      fromStatus: memory.status,
      toStatus: "archived",
      reasonCode: "memory_expired",
    };
  }
  if (protectedFromAging(memory, policy)) return undefined;

  if (
    memory.status === "active" &&
    ageDays(nowMs, memory.lastReinforcedAtUtc ?? memory.updatedAtUtc) >=
      policy.activeToAgingDays
  ) {
    return {
      memoryId: memory.id,
      fromStatus: "active",
      toStatus: "aging",
      reasonCode: "memory_aged",
    };
  }
  if (
    memory.status === "aging" &&
    ageDays(nowMs, memory.lifecycleUpdatedAtUtc ?? memory.updatedAtUtc) >=
      policy.agingToArchivedDays
  ) {
    return {
      memoryId: memory.id,
      fromStatus: "aging",
      toStatus: "archived",
      reasonCode: "memory_archived",
    };
  }
  return undefined;
}

export type MemoryClaimReconciliationKind =
  "unrelated" | "merge" | "supersede" | "needs_review";

export interface MemoryClaimReconciliation {
  kind: MemoryClaimReconciliationKind;
  reasonCode:
    | "different_subject"
    | "claim_reinforced"
    | "later_explicit_claim"
    | "ambiguous_claim_conflict";
  subjectKey?: string;
  existingStatus?: "active" | "superseded" | "merged" | "needs_review";
  incomingStatus?: "active" | "merged" | "needs_review";
  winnerMemoryId?: string;
}

function claimIsReliable(memory: LifecycleMemoryLike): boolean {
  return (
    memory.certainty === "explicit" &&
    (memory.attribution === "user_explicit" ||
      memory.attribution === "simulation_event") &&
    memory.confidence >= 0.8
  );
}

function isExplicitCorrection(memory: LifecycleMemoryLike): boolean {
  return (memory.tags ?? []).some((tag) => {
    const normalized = normalizeText(tag);
    return (
      normalized === "correction" ||
      normalized === "corrected" ||
      normalized === "更正" ||
      normalized === "纠正" ||
      normalized === "修正"
    );
  });
}

function contentFeatures(value: string): Set<string> {
  const normalized = normalizeText(value);
  const features = new Set(
    normalized.split(" ").filter((part) => part.length > 1),
  );
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      features.add(run.slice(index, index + 2));
    }
  }
  return features;
}

function similarity(left: string, right: string): number {
  const a = contentFeatures(left);
  const b = contentFeatures(right);
  if (a.size === 0 || b.size === 0) {
    return normalizeText(left) === normalizeText(right) ? 1 : 0;
  }
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function reconcileMemoryClaims(input: {
  existing: LifecycleMemoryLike;
  incoming: LifecycleMemoryLike;
  mergeSimilarity?: number;
}): MemoryClaimReconciliation {
  const existingClaim = input.existing.claim;
  const incomingClaim = input.incoming.claim;
  const existingSubject =
    existingClaim === undefined ? "" : normalizeText(existingClaim.subjectKey);
  const incomingSubject =
    incomingClaim === undefined ? "" : normalizeText(incomingClaim.subjectKey);
  if (
    existingClaim === undefined ||
    incomingClaim === undefined ||
    existingSubject.length === 0 ||
    existingSubject !== incomingSubject
  ) {
    return { kind: "unrelated", reasonCode: "different_subject" };
  }

  if (existingClaim.disposition === incomingClaim.disposition) {
    const incomingTime = Date.parse(incomingClaim.recordedAtUtc);
    const existingTime = Date.parse(existingClaim.recordedAtUtc);
    if (
      isExplicitCorrection(input.incoming) &&
      claimIsReliable(input.incoming) &&
      Number.isFinite(incomingTime) &&
      Number.isFinite(existingTime) &&
      incomingTime >= existingTime
    ) {
      return {
        kind: "supersede",
        reasonCode: "later_explicit_claim",
        subjectKey: incomingClaim.subjectKey,
        existingStatus: "superseded",
        incomingStatus: "active",
        winnerMemoryId: input.incoming.id,
      };
    }
    if (
      similarity(input.existing.content, input.incoming.content) >=
      (input.mergeSimilarity ?? 0.55)
    ) {
      return {
        kind: "merge",
        reasonCode: "claim_reinforced",
        subjectKey: incomingClaim.subjectKey,
        existingStatus: "active",
        incomingStatus: "merged",
        winnerMemoryId: input.existing.id,
      };
    }
    return {
      kind: "needs_review",
      reasonCode: "ambiguous_claim_conflict",
      subjectKey: incomingClaim.subjectKey,
      existingStatus: "needs_review",
      incomingStatus: "needs_review",
    };
  }

  const incomingTime = Date.parse(incomingClaim.recordedAtUtc);
  const existingTime = Date.parse(existingClaim.recordedAtUtc);
  if (
    Number.isFinite(incomingTime) &&
    Number.isFinite(existingTime) &&
    incomingTime > existingTime &&
    claimIsReliable(input.incoming)
  ) {
    return {
      kind: "supersede",
      reasonCode: "later_explicit_claim",
      subjectKey: incomingClaim.subjectKey,
      existingStatus: "superseded",
      incomingStatus: "active",
      winnerMemoryId: input.incoming.id,
    };
  }
  return {
    kind: "needs_review",
    reasonCode: "ambiguous_claim_conflict",
    subjectKey: incomingClaim.subjectKey,
    existingStatus: "needs_review",
    incomingStatus: "needs_review",
  };
}

export function canonicalMemoryConflictPair(
  leftMemoryId: string,
  rightMemoryId: string,
): readonly [string, string] {
  return leftMemoryId.localeCompare(rightMemoryId) <= 0
    ? [leftMemoryId, rightMemoryId]
    : [rightMemoryId, leftMemoryId];
}
