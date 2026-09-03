import {
  MemoryRecallRuntimeDiagnosticSchema,
  type MemoryRecallRuntimeDiagnostic,
} from "@personasim/contracts";

import type { StoredMessage } from "../db/store.js";
import { ApiError } from "../domain/errors.js";
import type { RuntimeState } from "../domain/schemas.js";
import type { MemoryRecallPreview } from "./memory-recall-service.js";
import type { ChatTurnResult } from "./turn-commit-types.js";

export function assertIdempotentTurnMatches(
  storedUserMessage: StoredMessage,
  requestedText: string,
): void {
  if (storedUserMessage.content === requestedText) return;
  throw new ApiError(
    409,
    "idempotency_key_reused",
    "The client message id was already used with different content.",
  );
}

export function replayTurnResult(
  turn: { userMessage: StoredMessage; assistantMessage: StoredMessage },
  state: RuntimeState,
): ChatTurnResult {
  const memoryRecall = readMemoryRecallDiagnostic(
    turn.assistantMessage.metadata,
  );
  return {
    idempotentReplay: true,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    scheduleChanges: [],
    state,
    ...(memoryRecall === undefined ? {} : { memoryRecall }),
    decision: {
      reasonCode: metadataText(
        turn.assistantMessage.metadata,
        "reasonCode",
        "idempotent_replay",
      ),
      reasonSummary: metadataText(
        turn.assistantMessage.metadata,
        "reasonSummary",
        "Replayed stored turn.",
      ),
      toneTags: Array.isArray(turn.assistantMessage.metadata.toneTags)
        ? (turn.assistantMessage.metadata.toneTags as string[])
        : [],
      deliveryMode: metadataDeliveryMode(turn.assistantMessage.metadata),
      chunks: metadataChunks(
        turn.assistantMessage.metadata,
        turn.assistantMessage.content,
      ),
    },
  };
}

export function buildMemoryRecallDiagnostic(
  mode: "legacy" | "shadow" | "enforced",
  legacyMemories: readonly { id: string }[],
  promptMemories: readonly { id: string }[],
  preview: MemoryRecallPreview,
): MemoryRecallRuntimeDiagnostic {
  const result = preview.result;
  return MemoryRecallRuntimeDiagnosticSchema.parse({
    rolloutMode: mode,
    promptStrategy: mode === "enforced" ? "evidence_selected" : "legacy_active",
    legacyPromptMemoryIds: legacyMemories
      .slice(0, 12)
      .map((memory) => memory.id),
    promptMemoryIds: promptMemories.slice(0, 12).map((memory) => memory.id),
    selectedMemoryIds: result.selectedMemoryIds,
    selectedEvidenceIds: result.selectedEvidenceIds,
    rejectedMemoryIds: preview.candidates
      .filter((candidate) => !candidate.selected)
      .map((candidate) => candidate.memoryId),
    recallMode: result.mode,
    score: result.score,
    abstained: result.abstained,
    ...(result.abstained ? { abstentionReason: result.abstentionReason } : {}),
    durationMs: preview.timing.durationMs,
  });
}

function readMemoryRecallDiagnostic(
  metadata: Record<string, unknown>,
): MemoryRecallRuntimeDiagnostic | undefined {
  const parsed = MemoryRecallRuntimeDiagnosticSchema.safeParse(
    metadata.memoryRecall,
  );
  return parsed.success ? parsed.data : undefined;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return undefined;
}

function metadataText(
  metadata: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return optionalText(metadata[key]) ?? fallback;
}

function metadataChunks(
  metadata: Record<string, unknown>,
  fallbackText?: string,
): string[] {
  const value = metadata.chunks;
  const chunks = Array.isArray(value)
    ? value.filter(
        (chunk): chunk is string =>
          typeof chunk === "string" && chunk.trim().length > 0,
      )
    : [];
  if (chunks.length > 0) return chunks;
  return fallbackText === undefined || fallbackText.trim() === ""
    ? []
    : [fallbackText];
}

function metadataDeliveryMode(
  metadata: Record<string, unknown>,
): "single_block" | "sequential" {
  if (
    metadata.deliveryMode === "single_block" ||
    metadata.deliveryMode === "sequential"
  ) {
    return metadata.deliveryMode;
  }
  return metadataChunks(metadata).length > 1 ? "sequential" : "single_block";
}
