import {
  PERSONA_RUNTIME_POLICY_VERSION,
  PersonaAdaptationSchema,
  PersonaEvidenceSourceSchema,
  PersonaPracticeProposalSchema,
  UtcDateTimeSchema,
  type PersonaAdaptation,
  type PersonaPracticeProposal,
} from "@personasim/contracts";
import { z } from "zod";

import type { DatabaseStore } from "../db/store.js";

const HeadSchema = z
  .object({
    agentId: z.string(),
    baseCharacterVersion: z.number().int().min(1),
    revision: z.number().int().nonnegative(),
    memoryRevision: z.number().int().nonnegative(),
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type PersonaRuntimeHead = z.infer<typeof HeadSchema>;

const HistoricalStateSchema = z
  .object({
    baseCharacterVersion: z.number().int().min(1),
    memoryRevision: z.number().int().nonnegative(),
    adaptations: z.array(PersonaAdaptationSchema).max(1_000),
    changeSources: z.array(PersonaEvidenceSourceSchema).max(4).optional(),
  })
  .strict();
export type PersonaHistoricalState = z.infer<typeof HistoricalStateSchema>;

export class PersonaRuntimeRepository {
  constructor(private readonly store: DatabaseStore) {}

  head(agentId: string): PersonaRuntimeHead | undefined {
    const row = this.store.database
      .prepare(
        `SELECT agent_id AS agentId,
      base_character_version AS baseCharacterVersion, revision, memory_revision AS memoryRevision,
      updated_at_utc AS updatedAtUtc FROM persona_runtime_heads WHERE agent_id = ?`,
      )
      .get(agentId);
    return row === undefined ? undefined : HeadSchema.parse(row);
  }

  ensureHead(input: Omit<PersonaRuntimeHead, "revision">): PersonaRuntimeHead {
    const parsed = HeadSchema.parse({ ...input, revision: 0 });
    this.store.database
      .prepare(
        `INSERT OR IGNORE INTO persona_runtime_heads
      (agent_id, base_character_version, revision, memory_revision, updated_at_utc) VALUES (?, ?, 0, ?, ?)`,
      )
      .run(
        parsed.agentId,
        parsed.baseCharacterVersion,
        parsed.memoryRevision,
        parsed.updatedAtUtc,
      );
    return this.head(parsed.agentId)!;
  }

  updateHead(input: PersonaRuntimeHead, expectedRevision: number): void {
    const parsed = HeadSchema.parse(input);
    const result = this.store.database
      .prepare(
        `UPDATE persona_runtime_heads SET
      base_character_version = ?, revision = ?, memory_revision = ?, updated_at_utc = ?
      WHERE agent_id = ? AND revision = ?`,
      )
      .run(
        parsed.baseCharacterVersion,
        parsed.revision,
        parsed.memoryRevision,
        parsed.updatedAtUtc,
        parsed.agentId,
        expectedRevision,
      );
    if (result.changes !== 1) throw new Error("persona_revision_conflict");
  }

  listAdaptations(agentId: string): PersonaAdaptation[] {
    const rows = this.store.database
      .prepare(
        "SELECT record_json FROM persona_adaptations WHERE agent_id = ? ORDER BY revision, id LIMIT 1000",
      )
      .all(agentId) as { record_json: string }[];
    return rows.map((row) =>
      PersonaAdaptationSchema.parse(JSON.parse(row.record_json)),
    );
  }

  saveAdaptation(adaptation: PersonaAdaptation, nowUtc: string): void {
    const parsed = PersonaAdaptationSchema.parse(adaptation);
    UtcDateTimeSchema.parse(nowUtc);
    this.store.database
      .prepare(
        `INSERT INTO persona_adaptations
      (id, agent_id, source_message_id, scope_key, base_character_version, revision, status, record_json, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET base_character_version = excluded.base_character_version,
      revision = excluded.revision, status = excluded.status, record_json = excluded.record_json,
      updated_at_utc = excluded.updated_at_utc`,
      )
      .run(
        parsed.id,
        parsed.agentId,
        parsed.sourceMessageId,
        personaScopeKey(parsed.proposal),
        parsed.baseCharacterVersion,
        parsed.revision,
        parsed.status,
        JSON.stringify(parsed),
        parsed.effectiveFromUtc,
        nowUtc,
      );
  }

  observe(input: {
    id: string;
    agentId: string;
    sourceMessageId: string;
    sourceHash: string;
    proposal: PersonaPracticeProposal;
    dedupeKey: string;
    nowUtc: string;
  }): "new" | "existing" {
    const proposal = PersonaPracticeProposalSchema.parse(input.proposal);
    const result = this.store.database
      .prepare(
        `INSERT OR IGNORE INTO persona_observations
      (id, agent_id, source_message_id, source_hash, proposal_json, status, reason_code, dedupe_key, policy_version, created_at_utc)
      VALUES (?, ?, ?, ?, ?, 'captured', 'explicit_user_practice', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.agentId,
        input.sourceMessageId,
        input.sourceHash,
        JSON.stringify(proposal),
        input.dedupeKey,
        PERSONA_RUNTIME_POLICY_VERSION,
        UtcDateTimeSchema.parse(input.nowUtc),
      );
    return result.changes === 1 ? "new" : "existing";
  }

  observation(
    id: string,
  ):
    | { status: "captured" | "accepted" | "rejected"; sourceHash: string }
    | undefined {
    return this.store.database
      .prepare(
        "SELECT status, source_hash AS sourceHash FROM persona_observations WHERE id = ?",
      )
      .get(id) as
      | { status: "captured" | "accepted" | "rejected"; sourceHash: string }
      | undefined;
  }

  markObservation(
    id: string,
    status: "accepted" | "rejected",
    reason: string,
  ): void {
    this.store.database
      .prepare(
        "UPDATE persona_observations SET status = ?, reason_code = ? WHERE id = ?",
      )
      .run(status, reason, id);
  }

  appendRevision(input: {
    id: string;
    agentId: string;
    fromRevision: number;
    reason: string;
    idempotencyKey: string;
    nowUtc: string;
    state: PersonaHistoricalState;
  }): void {
    const state = HistoricalStateSchema.parse(input.state);
    this.store.database
      .prepare(
        `INSERT INTO persona_revision_events
      (id, agent_id, from_revision, to_revision, operation_json, reason_code, policy_version, idempotency_key, created_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.agentId,
        input.fromRevision,
        input.fromRevision + 1,
        JSON.stringify(state),
        input.reason,
        PERSONA_RUNTIME_POLICY_VERSION,
        input.idempotencyKey,
        UtcDateTimeSchema.parse(input.nowUtc),
      );
  }

  historyAt(
    agentId: string,
    nowUtc: string,
  ): { revision: number; state: PersonaHistoricalState } | undefined {
    const row = this.store.database
      .prepare(
        `SELECT to_revision AS revision, operation_json AS state
      FROM persona_revision_events WHERE agent_id = ? AND created_at_utc <= ? ORDER BY created_at_utc DESC, to_revision DESC LIMIT 1`,
      )
      .get(agentId, nowUtc) as { revision: number; state: string } | undefined;
    return row === undefined
      ? undefined
      : {
          revision: row.revision,
          state: HistoricalStateSchema.parse(JSON.parse(row.state)),
        };
  }

  invalidationsAt(
    agentId: string,
    nowUtc: string,
  ): { adaptationIds: string[]; memoryRevision: number } {
    const rows = this.store.database
      .prepare(
        `SELECT adaptation_id AS adaptationId, memory_revision AS memoryRevision
      FROM persona_evidence_invalidations WHERE agent_id = ? AND effective_at_utc <= ? ORDER BY effective_at_utc, adaptation_id`,
      )
      .all(agentId, nowUtc) as {
      adaptationId: string;
      memoryRevision: number;
    }[];
    return {
      adaptationIds: rows.map((row) => row.adaptationId),
      memoryRevision: Math.max(0, ...rows.map((row) => row.memoryRevision)),
    };
  }
}

export function personaScopeKey(proposal: PersonaPracticeProposal): string {
  return JSON.stringify([
    proposal.scope.userId,
    proposal.scope.topic ?? "",
    proposal.facet,
  ]);
}
