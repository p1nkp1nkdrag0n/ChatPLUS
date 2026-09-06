import { createHash } from "node:crypto";
import { EVIDENCE_SEMANTICS_VERSION } from "@personasim/features";
import type { ContinuityEvidenceRef } from "@personasim/contracts";

import type { DatabaseStore } from "../db/store.js";

export type MemoryValiditySourceType =
  "memory" | "message" | "activity_event" | "domain_event";
export interface MemoryValiditySource {
  sourceType: MemoryValiditySourceType;
  sourceId: string;
  sourceHash: string;
}

/** Shared source/revision boundary. Persona and continuity may depend on this
 * repository without depending on one another's projections or services. */
export class MemoryValidityRepository {
  constructor(private readonly store: DatabaseStore) {}

  currentRevision(agentId: string): number {
    return (
      (
        this.store.database
          .prepare(
            "SELECT revision FROM agent_memory_revisions WHERE agent_id = ?",
          )
          .get(agentId) as { revision: number } | undefined
      )?.revision ?? 0
    );
  }

  readSource(
    agentId: string,
    sourceType: MemoryValiditySourceType,
    sourceId: string,
    nowUtc?: string,
  ): MemoryValiditySource | undefined {
    const queries: Record<MemoryValiditySourceType, string> = {
      memory: `SELECT content, namespace, certainty, attribution, stability, status,
        claim_subject_key, claim_disposition, superseded_by_id, merged_into_id,
        valid_until_utc, memory_json FROM memories WHERE agent_id = ? AND id = ?
        AND status IN ('active', 'aging') AND superseded_by_id IS NULL AND merged_into_id IS NULL`,
      message:
        "SELECT role, content FROM messages WHERE agent_id = ? AND id = ? AND role IN ('user', 'assistant')",
      activity_event:
        "SELECT summary FROM activity_events WHERE agent_id = ? AND id = ?",
      domain_event:
        "SELECT payload_json FROM domain_events WHERE agent_id = ? AND id = ?",
    };
    const row = this.store.database
      .prepare(queries[sourceType])
      .get(agentId, sourceId) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      (nowUtc !== undefined &&
        typeof row["valid_until_utc"] === "string" &&
        row["valid_until_utc"] <= nowUtc)
    )
      return undefined;
    return {
      sourceType,
      sourceId,
      sourceHash: createHash("sha256")
        .update(JSON.stringify(row))
        .digest("hex"),
    };
  }

  isSourceCurrent(
    agentId: string,
    source: MemoryValiditySource,
    nowUtc?: string,
  ): boolean {
    return (
      this.readSource(agentId, source.sourceType, source.sourceId, nowUtc)
        ?.sourceHash === source.sourceHash
    );
  }

  dependencies(
    agentId: string,
    derivedType: string,
    derivedId: string,
  ): MemoryValiditySource[] {
    return this.store.database
      .prepare(
        `SELECT source_type AS sourceType, source_id AS sourceId, source_hash AS sourceHash
      FROM memory_derivation_dependencies WHERE agent_id = ? AND derived_type = ? AND derived_id = ?
      ORDER BY source_type, source_id`,
      )
      .all(agentId, derivedType, derivedId) as MemoryValiditySource[];
  }

  isDerivedCurrent(
    agentId: string,
    derivedType: string,
    derivedId: string,
    nowUtc?: string,
  ): boolean {
    const row = this.store.database
      .prepare(
        `SELECT state FROM memory_derived_validity
      WHERE agent_id = ? AND derived_type = ? AND derived_id = ?`,
      )
      .get(agentId, derivedType, derivedId) as { state: string } | undefined;
    const sources = this.dependencies(agentId, derivedType, derivedId);
    return (
      row?.state === "active" &&
      sources.length > 0 &&
      sources.every((source) => this.isSourceCurrent(agentId, source, nowUtc))
    );
  }

  registerDependencies(input: {
    agentId: string;
    derivedType: string;
    derivedId: string;
    sources: readonly MemoryValiditySource[];
    nowUtc: string;
  }): boolean {
    return this.store.transaction(() => {
      if (
        input.sources.length === 0 ||
        !input.sources.every((source) =>
          this.isSourceCurrent(input.agentId, source, input.nowUtc),
        )
      )
        return false;
      const existing = this.dependencies(
        input.agentId,
        input.derivedType,
        input.derivedId,
      );
      const registered = this.store.database
        .prepare(
          "SELECT state FROM memory_derived_validity WHERE agent_id = ? AND derived_type = ? AND derived_id = ?",
        )
        .get(input.agentId, input.derivedType, input.derivedId);
      if (registered !== undefined) {
        // Reusing an artifact ID cannot silently revalidate its old provenance.
        return (
          existing.length === input.sources.length &&
          this.isDerivedCurrent(
            input.agentId,
            input.derivedType,
            input.derivedId,
            input.nowUtc,
          ) &&
          existing.every((source) =>
            input.sources.some(
              (item) =>
                item.sourceType === source.sourceType &&
                item.sourceId === source.sourceId &&
                item.sourceHash === source.sourceHash,
            ),
          )
        );
      }
      this.store.database
        .prepare(
          `INSERT INTO memory_derived_validity(agent_id, derived_type, derived_id, state, validator_version, updated_at_utc)
        VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          input.agentId,
          input.derivedType,
          input.derivedId,
          EVIDENCE_SEMANTICS_VERSION,
          input.nowUtc,
        );
      const insert = this.store.database
        .prepare(`INSERT OR IGNORE INTO memory_derivation_dependencies
        (agent_id, derived_type, derived_id, source_type, source_id, source_hash, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const source of input.sources)
        insert.run(
          input.agentId,
          input.derivedType,
          input.derivedId,
          source.sourceType,
          source.sourceId,
          source.sourceHash,
          input.nowUtc,
        );
      return true;
    });
  }

  messageSourceNeedsReview(agentId: string, sourceId: string): boolean {
    return (
      this.store.database
        .prepare(
          `SELECT 1 FROM memory_evidence e JOIN memories m ON m.id = e.memory_id
      WHERE m.agent_id = ? AND e.source_type = 'message' AND e.source_id = ?
        AND m.status IN ('superseded', 'needs_review') LIMIT 1`,
        )
        .get(agentId, sourceId) !== undefined
    );
  }

  sourcesForEvidence(
    agentId: string,
    evidence: readonly ContinuityEvidenceRef[],
    content?: string,
  ): MemoryValiditySource[] {
    const sources: MemoryValiditySource[] = [];
    for (const reference of evidence) {
      if (reference.sourceType === "memory_evidence") {
        const memory = this.store.database
          .prepare(
            `SELECT e.memory_id, e.source_type, e.source_id FROM memory_evidence e
          JOIN memories m ON m.id = e.memory_id WHERE e.id = ? AND m.agent_id = ?`,
          )
          .get(reference.sourceId, agentId) as
          | { memory_id: string; source_type: string; source_id: string }
          | undefined;
        if (memory === undefined) return [];
        const source = this.readSource(agentId, "memory", memory.memory_id);
        if (source === undefined) return [];
        sources.push(source);
        if (
          memory.source_type === "message" ||
          memory.source_type === "activity_event" ||
          memory.source_type === "domain_event"
        ) {
          const root = this.readSource(
            agentId,
            memory.source_type,
            memory.source_id,
          );
          if (root === undefined) return [];
          sources.push(root);
        }
      } else {
        const source = this.readSource(
          agentId,
          reference.sourceType === "message_archive"
            ? "message"
            : reference.sourceType,
          reference.sourceId,
        );
        if (source === undefined) return [];
        sources.push(source);
        if (
          reference.sourceType === "message_archive" &&
          content !== undefined
        ) {
          const message = this.store.database
            .prepare(
              "SELECT content FROM messages WHERE agent_id = ? AND id = ?",
            )
            .get(agentId, reference.sourceId) as
            { content: string } | undefined;
          // A whole-message report contains every fact in that utterance. Each
          // atomic memory is an explicit dependency; independent memory_evidence
          // references still bind only their own fact, even in a shared message.
          if (
            message !== undefined &&
            content.includes(message.content.trim())
          ) {
            const memories = this.store.database
              .prepare(
                `SELECT DISTINCT m.id FROM memory_evidence e JOIN memories m ON m.id = e.memory_id
              WHERE m.agent_id = ? AND e.source_type = 'message' AND e.source_id = ? AND m.status IN ('active','aging','superseded','needs_review')`,
              )
              .all(agentId, reference.sourceId) as Array<{ id: string }>;
            for (const memory of memories) {
              const root = this.readSource(agentId, "memory", memory.id);
              if (root === undefined) return [];
              sources.push(root);
            }
          }
        }
      }
    }
    return [
      ...new Map(
        sources.map((source) => [
          `${source.sourceType}:${source.sourceId}`,
          source,
        ]),
      ).values(),
    ];
  }
}
