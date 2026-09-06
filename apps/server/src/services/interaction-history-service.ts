import {
  LOCAL_USER_ID,
  type EffectivePersonaSnapshot,
  type InteractionEvidenceSnapshot,
} from "@personasim/contracts";
import {
  buildInteractionEvidence,
  inspectInteractionAttribution,
} from "@personasim/features";
import type { DatabaseStore } from "../db/store.js";
import { PersonaRuntimeRepository } from "../repositories/persona-runtime-repository.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import { projectReplySentences } from "./reply-text-projection.js";

type SourceRow = { id: string; text: string; createdAtUtc: string };

/** Reads original user sources, independent of the topic-filtered active practices.
 * Bounded recent sources plus finite practice origins; never assistant self-proof. */
export function loadInteractionEvidence(input: {
  store: DatabaseStore;
  agentId: string;
  nowUtc: string;
  effectivePersona?: EffectivePersonaSnapshot;
  currentUser?: { id: string; text: string };
}): InteractionEvidenceSnapshot {
  const origins = new PersonaRuntimeRepository(input.store)
    .listAdaptations(input.agentId)
    .map((item) => item.sourceMessageId);
  const recent = input.store.database
    .prepare(
      `SELECT id, content AS text, created_at_utc AS createdAtUtc
    FROM messages WHERE agent_id = ? AND role = 'user' AND created_at_utc <= ?
    ORDER BY created_at_utc DESC, rowid DESC LIMIT 200`,
    )
    .all(input.agentId, input.nowUtc) as SourceRow[];
  const historical =
    origins.length === 0
      ? []
      : (input.store.database
          .prepare(
            `SELECT id, content AS text, created_at_utc AS createdAtUtc
    FROM messages WHERE agent_id = ? AND role = 'user' AND created_at_utc <= ?
    AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at_utc, rowid`,
          )
          .all(
            input.agentId,
            input.nowUtc,
            JSON.stringify(origins),
          ) as SourceRow[]);
  const validity = new MemoryValidityRepository(input.store);
  const unique = [
    ...new Map(
      [...historical, ...recent.reverse()].map((row) => [row.id, row]),
    ).values(),
  ]
    .filter((row) => !validity.messageSourceNeedsReview(input.agentId, row.id))
    .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
  return buildInteractionEvidence({
    userId: LOCAL_USER_ID,
    characterId: input.agentId,
    messages: [
      ...unique.map((row) => ({
        id: row.id,
        role: "user" as const,
        text: row.text,
      })),
      ...(input.currentUser === undefined
        ? []
        : [{ ...input.currentUser, role: "user" as const }]),
    ],
    activePractices:
      input.effectivePersona?.relationshipPractices.map((item) => ({
        id: item.id,
        sourceMessageId: item.sourceMessageId,
        practice: item.proposal.practice,
        scope:
          item.proposal.scope.topic === undefined
            ? {}
            : { topic: item.proposal.scope.topic },
      })) ?? [],
  });
}

/** A read projection only. Original displayed history and source hashes stay intact. */
export function projectInteractionHistory<
  T extends { id: string; role: string; content: string },
>(
  messages: readonly T[],
  evidence: InteractionEvidenceSnapshot,
): {
  messages: T[];
  annotations: Array<{
    messageId: string;
    excludedText: string;
    issues: unknown[];
  }>;
} {
  const annotations: Array<{
    messageId: string;
    excludedText: string;
    issues: unknown[];
  }> = [];
  return {
    messages: messages.map((message) => {
      if (message.role !== "assistant") return message;
      const result = inspectInteractionAttribution({
        text: message.content,
        evidence,
      });
      if (result.allowed) return message;
      const projection = projectReplySentences(
        message.content,
        result.violations,
      );
      for (const removed of projection.removed) {
        annotations.push({
          messageId: message.id,
          excludedText: removed.text,
          issues: result.violations.filter(
            (issue) => issue.start < removed.end && issue.end > removed.start,
          ),
        });
      }
      const retained = projection.text;
      if (retained === message.content.trim()) return message;
      return {
        ...message,
        content:
          retained ||
          "[此条角色回复中的互动历史声称缺少支持，不能作为关系事实依据。]",
      };
    }),
    annotations,
  };
}
