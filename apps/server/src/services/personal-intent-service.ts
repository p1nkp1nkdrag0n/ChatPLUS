import {
  PersonalIntentCandidateSchema,
  PersonalIntentSchema,
  type CharacterSpec,
  type PersonalIntent,
  type PersonalIntentBasis,
} from "@personasim/contracts";
import {
  buildPersonalIntentDedupeKey,
  canConsumePersonalIntent,
  evaluatePersonalIntentExpiry,
  evaluatePersonalIntentSpecVersion,
  expirePersonalIntent,
  groundPersonalIntent,
  normalizePersonalIntentActivity,
  normalizePersonalIntentCandidate,
  normalizePersonalIntentCategory,
  normalizePersonalIntentDuration,
  parsePersonalIntentTimingHint,
  resolvePersonalIntentDedupe,
  type NormalizedPersonalIntent,
  type SpontaneousIntentPolicy,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import type { Clock } from "../runtime/clock.js";

export interface PersonalIntentCommandMetadata {
  correlationId?: string;
  causationId?: string;
  idempotencyKey: string;
}

export interface ChatPersonalIntentProposal {
  basisKind: "chat";
  candidate: unknown;
  evidenceMessageId: string;
  priority?: number;
  freshness?: number;
}

export interface DerivedPersonalIntentProposal {
  basisKind: Exclude<PersonalIntentBasis, "chat">;
  activity: string;
  category?: string;
  durationHint?: string;
  timingHint?: string;
  basisRefIds?: readonly string[];
  reasonCode: string;
  reasonSummary: string;
  priority?: number;
  freshness?: number;
  spontaneousPolicy?: SpontaneousIntentPolicy;
}

export type PersonalIntentProposalInput =
  ChatPersonalIntentProposal | DerivedPersonalIntentProposal;

export interface UpsertPersonalIntentInput extends PersonalIntentCommandMetadata {
  agentId: string;
  sessionId?: string;
  proposal: PersonalIntentProposalInput;
}

export interface ExpirePersonalIntentInput extends PersonalIntentCommandMetadata {
  agentId: string;
  intentId: string;
  ttlDays?: Partial<Record<PersonalIntentBasis, number>>;
}

export interface MarkPersonalIntentConsumedInput extends PersonalIntentCommandMetadata {
  agentId: string;
  intentId: string;
  ttlDays?: Partial<Record<PersonalIntentBasis, number>>;
}

export interface UpsertPersonalIntentResult {
  action: "created" | "merged";
  intent: PersonalIntent;
  replayed: boolean;
}

export interface PersonalIntentTransitionResult {
  intent: PersonalIntent;
  transitioned: boolean;
  replayed: boolean;
}

export interface PersonalIntentSpecReevaluationInput {
  agentId: string;
  correlationId?: string;
  causationId?: string;
}

export interface PersonalIntentSpecReevaluationResult {
  revalidatedIntentIds: string[];
  rejectedIntentIds: string[];
}

export interface PersonalIntentServiceOptions {
  spontaneous?: {
    /** P0 remains disabled unless server composition explicitly opts in. */
    enabled?: boolean;
    /** Accepted intents in the rolling window, including inactive ones. */
    maxAcceptedIntents?: number;
    rollingWindowHours?: number;
  };
}
interface StoredCommandEvent {
  agentId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

interface UserMessageEvidence {
  id: string;
  text: string;
}

const ACTIVE_STATUSES = ["pending", "planned"] as const;
const IDEMPOTENCY_KEY_MAX_LENGTH = 240;
const DEFAULT_SPONTANEOUS_MAX_ACCEPTED = 1;
const DEFAULT_SPONTANEOUS_WINDOW_HOURS = 24;

interface SpontaneousFrequencyAudit {
  policySource: "server";
  rollingWindowHours: number;
  maxAcceptedIntents: number;
  acceptedCountBefore: number;
}

type PreparedPersonalIntent = NormalizedPersonalIntent & {
  spontaneousFrequency?: SpontaneousFrequencyAudit;
};

export class PersonalIntentService {
  private readonly spontaneousEnabled: boolean;
  private readonly spontaneousMaxAccepted: number;
  private readonly spontaneousWindowHours: number;

  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    options: PersonalIntentServiceOptions = {},
  ) {
    this.spontaneousEnabled = options.spontaneous?.enabled === true;
    this.spontaneousMaxAccepted = boundedPositiveInteger(
      options.spontaneous?.maxAcceptedIntents,
      DEFAULT_SPONTANEOUS_MAX_ACCEPTED,
      100,
    );
    this.spontaneousWindowHours = boundedPositiveInteger(
      options.spontaneous?.rollingWindowHours,
      DEFAULT_SPONTANEOUS_WINDOW_HOURS,
      24 * 30,
    );
  }

  listActive(agentId: string): PersonalIntent[] {
    if (this.store.getCharacterSummary(agentId) === undefined) {
      throw notFound("Character");
    }
    return this.queryActive(agentId);
  }

  read(agentId: string, intentId: string): PersonalIntent {
    const intent = this.readMaybe(agentId, intentId);
    if (intent === undefined) throw notFound("Personal intent");
    return intent;
  }

  upsertOrMerge(input: UpsertPersonalIntentInput): UpsertPersonalIntentResult {
    assertCommandMetadata(input);
    return this.store.transaction(() => {
      const commandEvent = this.readCommandEvent(input.idempotencyKey);
      if (commandEvent !== undefined) {
        return this.replayUpsert(input, commandEvent);
      }

      const spec = this.requireSpec(input.agentId);
      this.requireSessionOwnership(input.agentId, input.sessionId);
      const nowUtc = this.clock.nowUtc();
      const prepared = this.prepareProposal(input, spec, nowUtc);
      const incoming = this.materializeIntent(
        input.agentId,
        input.sessionId,
        prepared,
        nowUtc,
      );
      const decision = resolvePersonalIntentDedupe(
        this.queryActive(input.agentId),
        incoming,
        nowUtc,
      );
      const action = decision.action === "create" ? "created" : "merged";
      const intent = PersonalIntentSchema.parse(decision.intent);
      this.writeIntent(intent);
      this.insertIntentEvent({
        intent,
        eventType: `personal_intent.${action}`,
        metadata: input,
        payload: {
          action,
          intentId: intent.id,
          status: intent.status,
          dedupeKey: intent.dedupeKey,
          basisKind: intent.basisKind,
          evidenceMessageIds: intent.evidenceMessageIds,
          evidenceQuotes: prepared.evidenceQuotes,
          reasonCode: prepared.reasonCode,
          reasonSummary: prepared.reasonSummary,
          ...(prepared.spontaneousFrequency === undefined
            ? {}
            : { spontaneousFrequency: prepared.spontaneousFrequency }),
        },
        recordedAtUtc: nowUtc,
      });
      return { action, intent, replayed: false };
    });
  }

  expire(input: ExpirePersonalIntentInput): PersonalIntentTransitionResult {
    assertCommandMetadata(input);
    return this.store.transaction(() => {
      const commandEvent = this.readCommandEvent(input.idempotencyKey);
      if (commandEvent !== undefined) {
        return this.replayTransition(
          input.agentId,
          input.intentId,
          commandEvent,
          "personal_intent.expired",
        );
      }

      const intent = this.read(input.agentId, input.intentId);
      if (intent.status === "expired") {
        return { intent, transitioned: false, replayed: false };
      }
      const nowUtc = this.clock.nowUtc();
      const evaluation = evaluatePersonalIntentExpiry(
        intent,
        nowUtc,
        input.ttlDays,
      );
      if (!evaluation.expired) {
        return { intent, transitioned: false, replayed: false };
      }
      const expired = PersonalIntentSchema.parse(
        expirePersonalIntent(intent, nowUtc, input.ttlDays),
      );
      this.writeIntent(expired);
      this.insertIntentEvent({
        intent: expired,
        eventType: "personal_intent.expired",
        metadata: input,
        payload: {
          intentId: expired.id,
          status: expired.status,
          expiresAtUtc: evaluation.expiresAtUtc,
          reasonCode: evaluation.reasonCode,
        },
        recordedAtUtc: nowUtc,
      });
      return { intent: expired, transitioned: true, replayed: false };
    });
  }

  markConsumed(
    input: MarkPersonalIntentConsumedInput,
  ): PersonalIntentTransitionResult {
    assertCommandMetadata(input);
    return this.store.transaction(() => {
      const commandEvent = this.readCommandEvent(input.idempotencyKey);
      if (commandEvent !== undefined) {
        return this.replayTransition(
          input.agentId,
          input.intentId,
          commandEvent,
          "personal_intent.consumed",
        );
      }

      const intent = this.read(input.agentId, input.intentId);
      if (intent.status === "consumed") {
        return { intent, transitioned: false, replayed: false };
      }
      const activeSpec = this.requireSpec(input.agentId);
      if (intent.specVersion !== activeSpec.version) {
        throw new ApiError(
          409,
          "personal_intent_spec_stale",
          "A stale personal intent must be re-evaluated before consumption.",
        );
      }

      const nowUtc = this.clock.nowUtc();
      if (
        intent.status === "pending" &&
        !canConsumePersonalIntent(intent, nowUtc, input.ttlDays)
      ) {
        throw new ApiError(
          409,
          "personal_intent_expired",
          "An expired personal intent cannot be consumed.",
        );
      }
      if (
        !ACTIVE_STATUSES.includes(
          intent.status as (typeof ACTIVE_STATUSES)[number],
        )
      ) {
        throw new ApiError(
          409,
          "personal_intent_not_consumable",
          `A personal intent in status ${intent.status} cannot be consumed.`,
        );
      }
      const consumed = PersonalIntentSchema.parse({
        ...intent,
        status: "consumed",
        updatedAtUtc: nowUtc,
      });
      this.writeIntent(consumed);
      this.insertIntentEvent({
        intent: consumed,
        eventType: "personal_intent.consumed",
        metadata: input,
        payload: { intentId: consumed.id, status: consumed.status },
        recordedAtUtc: nowUtc,
      });
      return { intent: consumed, transitioned: true, replayed: false };
    });
  }

  reevaluateActiveForCurrentSpec(
    input: PersonalIntentSpecReevaluationInput,
  ): PersonalIntentSpecReevaluationResult {
    return this.store.transaction(() => {
      const spec = this.requireSpec(input.agentId);
      const nowUtc = this.clock.nowUtc();
      const revalidatedIntentIds: string[] = [];
      const rejectedIntentIds: string[] = [];

      for (const intent of this.queryActive(input.agentId)) {
        const evaluation = evaluatePersonalIntentSpecVersion(intent, spec);
        if (evaluation.outcome === "current") continue;

        let canRevalidate = evaluation.outcome === "revalidated";
        let reasonCode =
          evaluation.reasonCode ??
          (canRevalidate
            ? "spec_reference_revalidated"
            : "spec_version_incompatible");
        if (
          evaluation.outcome === "requires_revalidation" &&
          intent.basisKind === "chat"
        ) {
          const grounding = this.revalidateChatGrounding(intent, spec);
          canRevalidate = grounding.ok;
          reasonCode = grounding.reasonCode;
        }

        const metadata: PersonalIntentCommandMetadata = {
          ...(input.correlationId === undefined
            ? {}
            : { correlationId: input.correlationId }),
          ...(input.causationId === undefined
            ? {}
            : { causationId: input.causationId }),
          idempotencyKey:
            "personal-intent:" +
            input.agentId +
            ":" +
            intent.id +
            ":spec:" +
            intent.specVersion +
            ":" +
            spec.version +
            ":" +
            (canRevalidate ? "revalidated" : "rejected"),
        };
        if (canRevalidate) {
          const revalidated = PersonalIntentSchema.parse({
            ...intent,
            specVersion: spec.version,
            updatedAtUtc: nowUtc,
          });
          this.writeIntent(revalidated);
          this.insertIntentEvent({
            intent: revalidated,
            eventType: "personal_intent.revalidated",
            metadata,
            payload: {
              intentId: revalidated.id,
              status: revalidated.status,
              previousSpecVersion: intent.specVersion,
              targetSpecVersion: spec.version,
              reasonCode,
            },
            recordedAtUtc: nowUtc,
          });
          revalidatedIntentIds.push(revalidated.id);
          continue;
        }

        const rejected = PersonalIntentSchema.parse({
          ...intent,
          status: "rejected",
          updatedAtUtc: nowUtc,
        });
        this.writeIntent(rejected);
        this.insertIntentEvent({
          intent: rejected,
          eventType: "personal_intent.rejected",
          metadata,
          payload: {
            intentId: rejected.id,
            status: rejected.status,
            previousSpecVersion: intent.specVersion,
            targetSpecVersion: spec.version,
            reasonCode,
          },
          recordedAtUtc: nowUtc,
        });
        rejectedIntentIds.push(rejected.id);
      }

      return { revalidatedIntentIds, rejectedIntentIds };
    });
  }

  private prepareProposal(
    input: UpsertPersonalIntentInput,
    spec: CharacterSpec,
    nowUtc: string,
  ): PreparedPersonalIntent {
    if (input.proposal.basisKind === "chat") {
      if (input.sessionId === undefined) {
        throw new ApiError(
          400,
          "chat_intent_session_required",
          "A chat personal intent requires a server-owned session reference.",
        );
      }
      const candidate = PersonalIntentCandidateSchema.parse(
        input.proposal.candidate,
      );
      const message = this.requireUserMessageEvidence(
        input.agentId,
        input.sessionId,
        input.proposal.evidenceMessageId,
      );
      const normalized = normalizePersonalIntentCandidate({
        candidate,
        agentId: input.agentId,
        spec,
        currentUserMessage: message,
        nowUtc,
        timezone: spec.identity.timezone,
        ...(input.proposal.priority === undefined
          ? {}
          : { priority: input.proposal.priority }),
        ...(input.proposal.freshness === undefined
          ? {}
          : { freshness: input.proposal.freshness }),
      });
      if (!normalized.accepted) {
        throw groundingError(normalized.rejection);
      }
      return normalized.intent;
    }

    const proposal = input.proposal;
    const activity = normalizePersonalIntentActivity(proposal.activity);
    const category = normalizePersonalIntentCategory(
      proposal.category,
      activity,
    );
    const spontaneousFrequency =
      proposal.basisKind === "spontaneous"
        ? this.readSpontaneousFrequency(input.agentId, nowUtc)
        : undefined;
    const spontaneousPolicy =
      spontaneousFrequency === undefined
        ? undefined
        : {
            ...proposal.spontaneousPolicy,
            enabled: this.spontaneousEnabled,
            frequencyAllowed:
              this.spontaneousEnabled &&
              spontaneousFrequency.acceptedCountBefore <
                spontaneousFrequency.maxAcceptedIntents,
          };
    const grounding = groundPersonalIntent(
      {
        activity,
        category,
        basisKind: proposal.basisKind,
        basisRefIds: proposal.basisRefIds ?? [],
      },
      {
        spec,
        ...(spontaneousPolicy === undefined ? {} : { spontaneousPolicy }),
      },
    );
    if (!grounding.ok) throw groundingError(grounding.rejection);
    const reason = validateReason(proposal.reasonCode, proposal.reasonSummary);
    const window = parsePersonalIntentTimingHint(proposal.timingHint, {
      nowUtc,
      timezone: spec.identity.timezone,
    });
    const basisRefIds = grounding.grounding.basisRefIds;
    return {
      agentId: input.agentId,
      activity,
      category,
      desiredDurationMinutes: normalizePersonalIntentDuration(
        proposal.durationHint,
        category,
      ),
      ...window,
      basisKind: proposal.basisKind,
      basisRefIds,
      evidenceMessageIds: grounding.grounding.evidenceMessageIds,
      evidenceQuotes: grounding.grounding.evidenceQuotes,
      priority: resolvePriority(spec, proposal, basisRefIds),
      freshness: clampScore(proposal.freshness, 1),
      dedupeKey: buildPersonalIntentDedupeKey({
        agentId: input.agentId,
        activity,
        category,
        basisKind: proposal.basisKind,
        basisRefIds,
      }),
      specVersion: spec.version,
      schemaVersion: 1,
      reasonCode: reason.reasonCode,
      reasonSummary: reason.reasonSummary,
      ...(spontaneousFrequency === undefined ? {} : { spontaneousFrequency }),
    };
  }

  private materializeIntent(
    agentId: string,
    sessionId: string | undefined,
    prepared: NormalizedPersonalIntent,
    nowUtc: string,
  ): PersonalIntent {
    return PersonalIntentSchema.parse({
      id: createEntityId("intent"),
      agentId,
      ...(sessionId === undefined ? {} : { sessionId }),
      activity: prepared.activity,
      category: prepared.category,
      desiredDurationMinutes: prepared.desiredDurationMinutes,
      ...(prepared.earliestAtUtc === undefined
        ? {}
        : { earliestAtUtc: prepared.earliestAtUtc }),
      ...(prepared.latestAtUtc === undefined
        ? {}
        : { latestAtUtc: prepared.latestAtUtc }),
      basisKind: prepared.basisKind,
      basisRefIds: prepared.basisRefIds,
      evidenceMessageIds: prepared.evidenceMessageIds,
      priority: prepared.priority,
      freshness: prepared.freshness,
      status: "pending",
      dedupeKey: prepared.dedupeKey,
      specVersion: prepared.specVersion,
      schemaVersion: prepared.schemaVersion,
      attemptCount: 0,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
  }

  private queryActive(agentId: string): PersonalIntent[] {
    return this.store.database
      .prepare(
        `SELECT record_json FROM personal_intentions
         WHERE agent_id = ? AND status IN ('pending', 'planned')
         ORDER BY priority DESC, freshness DESC, created_at_utc, rowid`,
      )
      .all(agentId)
      .map((row) => parseIntentRow(row as { record_json: string }));
  }

  private readMaybe(
    agentId: string,
    intentId: string,
  ): PersonalIntent | undefined {
    const row = this.store.database
      .prepare(
        `SELECT record_json FROM personal_intentions
         WHERE agent_id = ? AND id = ?`,
      )
      .get(agentId, intentId) as { record_json: string } | undefined;
    return row === undefined ? undefined : parseIntentRow(row);
  }

  private writeIntent(intent: PersonalIntent): void {
    const parsed = PersonalIntentSchema.parse(intent);
    this.store.database
      .prepare(
        `INSERT INTO personal_intentions(
          id, agent_id, session_id, activity, category, duration_minutes,
          earliest_at_utc, latest_at_utc, basis_kind, priority, freshness,
          record_json, status, dedupe_key, spec_version, schema_version,
          attempt_count, last_attempt_at_utc, created_at_utc, updated_at_utc
        ) VALUES (
          @id, @agentId, @sessionId, @activity, @category, @durationMinutes,
          @earliestAtUtc, @latestAtUtc, @basisKind, @priority, @freshness,
          @recordJson, @status, @dedupeKey, @specVersion, @schemaVersion,
          @attemptCount, @lastAttemptAtUtc, @createdAtUtc, @updatedAtUtc
        )
        ON CONFLICT(id) DO UPDATE SET
          session_id = excluded.session_id,
          activity = excluded.activity,
          category = excluded.category,
          duration_minutes = excluded.duration_minutes,
          earliest_at_utc = excluded.earliest_at_utc,
          latest_at_utc = excluded.latest_at_utc,
          basis_kind = excluded.basis_kind,
          priority = excluded.priority,
          freshness = excluded.freshness,
          record_json = excluded.record_json,
          status = excluded.status,
          dedupe_key = excluded.dedupe_key,
          spec_version = excluded.spec_version,
          schema_version = excluded.schema_version,
          attempt_count = excluded.attempt_count,
          last_attempt_at_utc = excluded.last_attempt_at_utc,
          updated_at_utc = excluded.updated_at_utc`,
      )
      .run({
        id: parsed.id,
        agentId: parsed.agentId,
        sessionId: parsed.sessionId ?? null,
        activity: parsed.activity,
        category: parsed.category,
        durationMinutes: parsed.desiredDurationMinutes,
        earliestAtUtc: parsed.earliestAtUtc ?? null,
        latestAtUtc: parsed.latestAtUtc ?? null,
        basisKind: parsed.basisKind,
        priority: parsed.priority,
        freshness: parsed.freshness,
        recordJson: JSON.stringify(parsed),
        status: parsed.status,
        dedupeKey: parsed.dedupeKey,
        specVersion: parsed.specVersion,
        schemaVersion: parsed.schemaVersion,
        attemptCount: parsed.attemptCount,
        lastAttemptAtUtc: parsed.lastAttemptAtUtc ?? null,
        createdAtUtc: parsed.createdAtUtc,
        updatedAtUtc: parsed.updatedAtUtc,
      });
  }

  private insertIntentEvent(input: {
    intent: PersonalIntent;
    eventType: string;
    metadata: PersonalIntentCommandMetadata;
    payload: Record<string, unknown>;
    recordedAtUtc: string;
  }): void {
    const inserted = this.store.insertDomainEvent({
      agentId: input.intent.agentId,
      streamType: "personal_intent",
      streamId: input.intent.id,
      streamVersion: this.nextStreamVersion(input.intent.id),
      eventType: input.eventType,
      recordedAtUtc: input.recordedAtUtc,
      payload: input.payload,
      ...(input.metadata.correlationId === undefined
        ? {}
        : { correlationId: input.metadata.correlationId }),
      ...(input.metadata.causationId === undefined
        ? {}
        : { causationId: input.metadata.causationId }),
      idempotencyKey: input.metadata.idempotencyKey,
    });
    if (!inserted) {
      throw new ApiError(
        409,
        "idempotency_key_conflict",
        "The idempotency key has already been used by another command.",
      );
    }
  }

  private nextStreamVersion(intentId: string): number {
    const row = this.store.database
      .prepare(
        `SELECT COALESCE(MAX(stream_version), 0) + 1 AS next_version
         FROM domain_events
         WHERE stream_type = 'personal_intent' AND stream_id = ?`,
      )
      .get(intentId) as { next_version: number };
    return Number(row.next_version);
  }

  private readCommandEvent(
    idempotencyKey: string,
  ): StoredCommandEvent | undefined {
    const row = this.store.database
      .prepare(
        `SELECT agent_id, event_type, payload_json
         FROM domain_events WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as
      | { agent_id: string; event_type: string; payload_json: string }
      | undefined;
    if (row === undefined) return undefined;
    const payload = JSON.parse(row.payload_json) as unknown;
    if (!isRecord(payload)) {
      throw new ApiError(
        500,
        "invalid_domain_event_payload",
        "The stored idempotency event payload is invalid.",
      );
    }
    return {
      agentId: row.agent_id,
      eventType: row.event_type,
      payload,
    };
  }

  private replayUpsert(
    input: UpsertPersonalIntentInput,
    event: StoredCommandEvent,
  ): UpsertPersonalIntentResult {
    assertReplayEvent(
      input.agentId,
      event,
      new Set(["personal_intent.created", "personal_intent.merged"]),
    );
    const intentId = requireEventIntentId(event);
    const intent = this.read(input.agentId, intentId);
    return {
      action:
        event.eventType === "personal_intent.merged" ? "merged" : "created",
      intent,
      replayed: true,
    };
  }

  private replayTransition(
    agentId: string,
    intentId: string,
    event: StoredCommandEvent,
    expectedEventType: string,
  ): PersonalIntentTransitionResult {
    assertReplayEvent(agentId, event, new Set([expectedEventType]));
    if (requireEventIntentId(event) !== intentId) {
      throw idempotencyConflict();
    }
    return {
      intent: this.read(agentId, intentId),
      transitioned: false,
      replayed: true,
    };
  }

  private revalidateChatGrounding(
    intent: PersonalIntent,
    spec: CharacterSpec,
  ): { ok: boolean; reasonCode: string } {
    if (intent.sessionId === undefined) {
      return { ok: false, reasonCode: "chat_evidence_unavailable" };
    }
    const rows = this.store.database
      .prepare(
        `SELECT payload_json FROM domain_events
         WHERE stream_type = 'personal_intent' AND stream_id = ?
           AND event_type IN ('personal_intent.created', 'personal_intent.merged')
         ORDER BY stream_version`,
      )
      .all(intent.id) as Array<{ payload_json: string }>;
    let lastReasonCode = "chat_evidence_unavailable";
    for (const row of rows) {
      const payload = parseRecordMaybe(row.payload_json);
      if (payload === undefined) continue;
      const evidenceMessageIds = stringValues(payload["evidenceMessageIds"]);
      const evidenceQuotes = stringValues(payload["evidenceQuotes"]);
      if (evidenceQuotes.length === 0) continue;
      for (const messageId of evidenceMessageIds) {
        if (!intent.evidenceMessageIds.includes(messageId)) continue;
        const message = this.store.database
          .prepare(
            `SELECT id, content FROM messages
             WHERE id = ? AND agent_id = ? AND session_id = ? AND role = 'user'`,
          )
          .get(messageId, intent.agentId, intent.sessionId) as
          { id: string; content: string } | undefined;
        if (message === undefined) continue;
        const grounding = groundPersonalIntent(
          {
            activity: intent.activity,
            category: intent.category,
            basisKind: "chat",
            evidenceMessageIds: [message.id],
            evidenceQuotes,
          },
          {
            spec,
            currentUserMessage: { id: message.id, text: message.content },
          },
        );
        if (grounding.ok) {
          return { ok: true, reasonCode: "chat_evidence_revalidated" };
        }
        lastReasonCode = grounding.rejection.reasonCode;
      }
    }
    return { ok: false, reasonCode: lastReasonCode };
  }

  private readSpontaneousFrequency(
    agentId: string,
    nowUtc: string,
  ): SpontaneousFrequencyAudit {
    const windowStartUtc = new Date(
      Date.parse(nowUtc) - this.spontaneousWindowHours * 60 * 60 * 1_000,
    ).toISOString();
    const row = this.store.database
      .prepare(
        `SELECT COUNT(*) AS count FROM personal_intentions
         WHERE agent_id = ? AND basis_kind = 'spontaneous'
           AND created_at_utc >= ? AND created_at_utc <= ?`,
      )
      .get(agentId, windowStartUtc, nowUtc) as { count: number };
    return {
      policySource: "server",
      rollingWindowHours: this.spontaneousWindowHours,
      maxAcceptedIntents: this.spontaneousMaxAccepted,
      acceptedCountBefore: Number(row.count),
    };
  }

  private requireSpec(agentId: string): CharacterSpec {
    const spec = this.store.getCharacterSpec(agentId);
    if (spec === undefined) throw notFound("Character");
    return spec;
  }

  private requireSessionOwnership(
    agentId: string,
    sessionId: string | undefined,
  ): void {
    if (sessionId === undefined) return;
    const session = this.store.getSession(sessionId);
    if (session === undefined || session.agentId !== agentId) {
      throw notFound("Session");
    }
  }

  private requireUserMessageEvidence(
    agentId: string,
    sessionId: string,
    messageId: string,
  ): UserMessageEvidence {
    const row = this.store.database
      .prepare(
        `SELECT id, content FROM messages
         WHERE id = ? AND agent_id = ? AND session_id = ? AND role = 'user'`,
      )
      .get(messageId, agentId, sessionId) as
      { id: string; content: string } | undefined;
    if (row === undefined) {
      throw new ApiError(
        422,
        "invalid_message_ref",
        "The chat evidence message is not an owned user message in this session.",
      );
    }
    return { id: row.id, text: row.content };
  }
}

function parseIntentRow(row: { record_json: string }): PersonalIntent {
  return PersonalIntentSchema.parse(JSON.parse(row.record_json));
}

function assertCommandMetadata(input: PersonalIntentCommandMetadata): void {
  const key = input.idempotencyKey;
  if (
    key.trim() === "" ||
    key !== key.trim() ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    throw new ApiError(
      400,
      "invalid_idempotency_key",
      "idempotencyKey must be non-empty, trimmed, and at most 240 characters.",
    );
  }
}

function groundingError(rejection: {
  reasonCode: string;
  reasonSummary: string;
}): ApiError {
  return new ApiError(422, rejection.reasonCode, rejection.reasonSummary);
}

function validateReason(
  reasonCode: string,
  reasonSummary: string,
): { reasonCode: string; reasonSummary: string } {
  const code = reasonCode.trim();
  const summary = reasonSummary.trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
    throw new ApiError(
      400,
      "invalid_reason_code",
      "reasonCode must use lower-case snake_case.",
    );
  }
  if (summary === "" || summary.length > 240) {
    throw new ApiError(
      400,
      "invalid_reason_summary",
      "reasonSummary must contain between 1 and 240 characters.",
    );
  }
  return { reasonCode: code, reasonSummary: summary };
}

function clampScore(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function resolvePriority(
  spec: CharacterSpec,
  proposal: DerivedPersonalIntentProposal,
  basisRefIds: readonly string[],
): number {
  if (proposal.priority !== undefined) {
    return clampScore(proposal.priority, 0.6);
  }
  const refs = new Set(basisRefIds);
  let priorities: number[];
  if (proposal.basisKind === "goal") {
    priorities = spec.persona.goals
      .filter((goal) => refs.has(goal.id))
      .map((goal) => goal.priority);
  } else if (proposal.basisKind === "preference") {
    priorities = spec.persona.preferences
      .filter((preference) => refs.has(preference.id))
      .map((preference) => preference.intensity);
  } else if (proposal.basisKind === "routine") {
    priorities = spec.routines
      .filter((routine) => refs.has(routine.id))
      .map((routine) => routine.priority);
  } else {
    priorities = [spec.schedulePolicy.spontaneity];
  }
  return priorities.length === 0 ? 0.6 : Math.max(...priorities);
}

function assertReplayEvent(
  agentId: string,
  event: StoredCommandEvent,
  allowedEventTypes: ReadonlySet<string>,
): void {
  if (event.agentId !== agentId || !allowedEventTypes.has(event.eventType)) {
    throw idempotencyConflict();
  }
}

function requireEventIntentId(event: StoredCommandEvent): string {
  const intentId = event.payload["intentId"];
  if (typeof intentId !== "string" || intentId === "") {
    throw idempotencyConflict();
  }
  return intentId;
}

function idempotencyConflict(): ApiError {
  return new ApiError(
    409,
    "idempotency_key_conflict",
    "The idempotency key belongs to a different command.",
  );
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function parseRecordMaybe(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.length > 0,
      ),
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
