import type { MemoryLifecycleStatusLike } from "./memory-lifecycle.js";
import { clamp, normalizeText, parseInstant, stableId } from "./shared.js";

export type MemoryKindLike =
  "semantic" | "episodic" | "relationship" | "commitment";
export type MemoryOriginLike =
  | "user_spec"
  | "canon_extract"
  | "model_inference"
  | "synthetic_extension"
  | "runtime_simulation";

export interface MemoryClaimLike {
  subjectKey: string;
  disposition: "affirmed" | "negated" | "cancelled" | "completed";
  recordedAtUtc: string;
}

export interface MemoryLike {
  id: string;
  agentId: string;
  kind: MemoryKindLike;
  content: string;
  importance: number;
  confidence: number;
  occurredAtUtc?: string;
  expiresAtUtc?: string;
  tags: string[];
  sourceMessageIds: string[];
  sourceActivityEventIds: string[];
  origin: MemoryOriginLike;
  status: MemoryLifecycleStatusLike;
  dedupeKey: string;
  claim?: MemoryClaimLike;
  supersededById?: string;
  mergedIntoId?: string;
  lastReinforcedAtUtc?: string;
  lifecycleUpdatedAtUtc?: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface MemoryProposalLike {
  kind: MemoryKindLike;
  content: string;
  importance: number;
  confidence: number;
  occurredAtUtc?: string;
  expiresAtUtc?: string;
  tags: string[];
  sourceMessageIds: string[];
  sourceActivityEventIds: string[];
  origin: MemoryOriginLike;
  claim?: MemoryClaimLike;
  reasonCode: string;
  reasonSummary: string;
}

export interface MemoryProposalValidation {
  accepted: boolean;
  errors: string[];
  proposal?: MemoryProposalLike;
}

export function validateMemoryProposal(
  proposal: MemoryProposalLike,
): MemoryProposalValidation {
  const errors: string[] = [];
  const content = proposal.content.trim().replace(/\s+/gu, " ").slice(0, 2_000);
  if (content.length < 3) errors.push("Memory content is too short");
  if (
    !Number.isFinite(proposal.importance) ||
    proposal.importance < 0 ||
    proposal.importance > 1
  ) {
    errors.push("Memory importance must be between 0 and 1");
  }
  if (
    !Number.isFinite(proposal.confidence) ||
    proposal.confidence < 0 ||
    proposal.confidence > 1
  ) {
    errors.push("Memory confidence must be between 0 and 1");
  }
  if (proposal.confidence < 0.5)
    errors.push("Low-confidence claims are not persisted");
  if (proposal.importance < 0.2)
    errors.push("Low-importance details stay in conversation history");
  if (
    proposal.reasonCode.trim() === "" ||
    proposal.reasonSummary.trim() === ""
  ) {
    errors.push("Memory proposals require a short reason");
  }
  if (proposal.reasonSummary.length > 240)
    errors.push("Memory reasonSummary cannot exceed 240 characters");
  if (
    ["semantic", "commitment", "relationship"].includes(proposal.kind) &&
    proposal.sourceMessageIds.length === 0 &&
    proposal.sourceActivityEventIds.length === 0
  ) {
    errors.push("Claim-like memories require a message or activity source");
  }
  if (
    proposal.expiresAtUtc !== undefined &&
    proposal.occurredAtUtc !== undefined &&
    parseInstant(proposal.expiresAtUtc) <= parseInstant(proposal.occurredAtUtc)
  ) {
    errors.push("expiresAtUtc must be later than occurredAtUtc");
  }

  if (errors.length > 0) return { accepted: false, errors };
  return {
    accepted: true,
    errors,
    proposal: {
      ...proposal,
      content,
      tags: [
        ...new Set(proposal.tags.map(normalizeText).filter(Boolean)),
      ].slice(0, 20),
      sourceMessageIds: [...new Set(proposal.sourceMessageIds)].slice(0, 20),
      sourceActivityEventIds: [
        ...new Set(proposal.sourceActivityEventIds),
      ].slice(0, 20),
      importance: clamp(proposal.importance),
      confidence: clamp(proposal.confidence),
      reasonSummary: proposal.reasonSummary.slice(0, 240),
    },
  };
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((part) => part.length > 1),
  );
}

function similarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0)
    return normalizeText(left) === normalizeText(right) ? 1 : 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function memoryDedupeKey(
  agentId: string,
  kind: MemoryKindLike,
  content: string,
): string {
  return stableId("memory-key", `${agentId}:${kind}:${normalizeText(content)}`);
}

export function mergeMemoryProposal(
  agentId: string,
  proposal: MemoryProposalLike,
  existing: readonly MemoryLike[],
  nowUtc: string,
): { memory: MemoryLike; superseded?: MemoryLike } | undefined {
  const validation = validateMemoryProposal(proposal);
  if (!validation.accepted || validation.proposal === undefined)
    return undefined;
  const safe = validation.proposal;
  const duplicate = existing
    .filter((memory) => memory.kind === safe.kind && memory.status === "active")
    .map((memory) => ({
      memory,
      score: similarity(memory.content, safe.content),
    }))
    .sort((left, right) => right.score - left.score)[0];
  const base =
    duplicate !== undefined && duplicate.score >= 0.72
      ? duplicate.memory
      : undefined;
  const source =
    safe.sourceMessageIds[0] ?? safe.sourceActivityEventIds[0] ?? nowUtc;
  const memoryId =
    base?.id ??
    stableId("memory", `${agentId}:${safe.kind}:${source}:${safe.content}`);
  const claim = safe.claim ?? base?.claim;
  const memory: MemoryLike = {
    id: memoryId,
    agentId,
    kind: safe.kind,
    content: safe.content,
    importance: Math.max(base?.importance ?? 0, safe.importance),
    confidence: Math.max(base?.confidence ?? 0, safe.confidence),
    tags: [...new Set([...(base?.tags ?? []), ...safe.tags])].slice(0, 20),
    sourceMessageIds: [
      ...new Set([...(base?.sourceMessageIds ?? []), ...safe.sourceMessageIds]),
    ].slice(0, 20),
    sourceActivityEventIds: [
      ...new Set([
        ...(base?.sourceActivityEventIds ?? []),
        ...safe.sourceActivityEventIds,
      ]),
    ].slice(0, 20),
    origin: safe.origin,
    status: "active",
    dedupeKey: memoryDedupeKey(agentId, safe.kind, safe.content),
    ...(claim === undefined ? {} : { claim }),
    lastReinforcedAtUtc: nowUtc,
    lifecycleUpdatedAtUtc: base?.lifecycleUpdatedAtUtc ?? nowUtc,
    createdAtUtc: base?.createdAtUtc ?? nowUtc,
    updatedAtUtc: nowUtc,
    ...(safe.occurredAtUtc === undefined
      ? {}
      : { occurredAtUtc: safe.occurredAtUtc }),
    ...(safe.expiresAtUtc === undefined
      ? {}
      : { expiresAtUtc: safe.expiresAtUtc }),
  };
  return { memory };
}
