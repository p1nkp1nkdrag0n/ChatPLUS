import { createHash } from "node:crypto";
import {
  INTERACTION_PRIVATE_VIEW_TEXT,
  InteractionAppraisalCandidateSchema,
  InteractionAppraisalSchema,
  type CharacterSpec,
  type InteractionAppraisal,
  type RuntimeState,
} from "@personasim/contracts";
import { stableId } from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";

export const INTERACTION_APPRAISAL_EVENT_TYPE =
  "interaction.appraisal.recorded";
export const INTERACTION_APPRAISAL_STREAM_TYPE = "interaction_appraisal";

interface SourceMessage {
  id: string;
  agentId: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAtUtc: string;
  inReplyToMessageId: string | null;
}

/** Optional qualitative reactions share the chat transaction. No LLM calls,
 * relationship changes, factual memories, or public notifications happen here. */
export class InteractionAppraisalService {
  private readonly validity: MemoryValidityRepository;

  constructor(private readonly store: DatabaseStore) {
    this.validity = new MemoryValidityRepository(store);
  }

  recordForTurn(input: {
    candidate: unknown;
    character: CharacterSpec;
    stateBefore: RuntimeState;
    userMessageId: string;
    assistantMessageId: string;
    generatedReplyText: string;
    nowUtc: string;
    effectivePersonaRevision?: number;
  }): InteractionAppraisal | undefined {
    const parsed = InteractionAppraisalCandidateSchema.safeParse(
      input.candidate,
    );
    if (!parsed.success) return undefined;
    return this.store.transaction(() => {
      const agentId = input.character.id;
      const user = this.readMessage(agentId, input.userMessageId);
      const assistant = this.readMessage(agentId, input.assistantMessageId);
      if (
        user?.role !== "user" ||
        assistant?.role !== "assistant" ||
        user.sessionId !== assistant.sessionId ||
        assistant.inReplyToMessageId !== user.id ||
        input.stateBefore.agentId !== agentId ||
        user.createdAtUtc !== input.nowUtc ||
        assistant.createdAtUtc !== input.nowUtc ||
        // Later reply repair must not retrospectively rewrite a private reaction.
        comparableReply(assistant.content) !==
          comparableReply(input.generatedReplyText) ||
        !user.content.includes(parsed.data.triggerQuote) ||
        !assistant.content.includes(parsed.data.publicExpression) ||
        this.validity.messageSourceNeedsReview(agentId, user.id)
      )
        return undefined;

      const id = stableId("appraisal", `${agentId}:${user.id}`);
      const idempotencyKey = `interaction-appraisal:${id}`;
      const existing =
        this.store.getDomainEventByIdempotencyKey(idempotencyKey);
      if (existing !== undefined) {
        const record = InteractionAppraisalSchema.safeParse(
          existing["payload"],
        );
        return record.success && this.isCurrent(record.data)
          ? record.data
          : undefined;
      }

      const sources = [user, assistant].map((message) =>
        this.validity.readSource(agentId, "message", message.id),
      );
      if (sources.some((source) => source === undefined)) return undefined;
      const appraisal = InteractionAppraisalSchema.parse({
        ...parsed.data,
        feelings: [...new Set(parsed.data.feelings)],
        privateView: [...new Set(parsed.data.privateView)],
        id,
        agentId,
        sessionId: user.sessionId,
        sourceMessageIds: [user.id, assistant.id],
        sources: [user, assistant].map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          createdAtUtc: message.createdAtUtc,
          sourceHash: sourceHash(message),
        })),
        recordedAtUtc: input.nowUtc,
        characterVersion: input.character.version,
        characterSpecHash: createHash("sha256")
          .update(JSON.stringify(input.character))
          .digest("hex"),
        ...(input.effectivePersonaRevision === undefined
          ? {}
          : { effectivePersonaRevision: input.effectivePersonaRevision }),
        stateRevision: input.stateBefore.revision,
        closeness: input.stateBefore.relationship.closeness,
        runtimeState: input.stateBefore,
        privateViewText: [...new Set(parsed.data.privateView)]
          .map((view) => INTERACTION_PRIVATE_VIEW_TEXT[view])
          .join(""),
        validationVersion: "interaction_appraisal_v1",
        authority: "subjective_character_reaction",
      });
      if (
        !this.validity.registerDependencies({
          agentId,
          derivedType: INTERACTION_APPRAISAL_STREAM_TYPE,
          derivedId: id,
          sources: sources.filter((source) => source !== undefined),
          nowUtc: input.nowUtc,
        })
      )
        return undefined;
      this.store.insertDomainEvent({
        agentId,
        streamType: INTERACTION_APPRAISAL_STREAM_TYPE,
        streamId: id,
        streamVersion: 1,
        eventType: INTERACTION_APPRAISAL_EVENT_TYPE,
        recordedAtUtc: input.nowUtc,
        payload: appraisal,
        correlationId: user.id,
        causationId: user.id,
        idempotencyKey,
      });
      return appraisal;
    });
  }

  /** Half-open UTC interval on the user's sharing time, not reply completion.
   * Historical views stay historical; current affinity
   * never changes them. Edited/deleted/corrected evidence removes eligibility. */
  listForDiary(input: {
    agentId: string;
    fromUtc: string;
    toUtc: string;
  }): InteractionAppraisal[] {
    const rows = this.store.database
      .prepare(
        `SELECT payload_json FROM domain_events
       WHERE agent_id = ? AND stream_type = ? AND event_type = ?
         AND json_extract(payload_json, '$.sources[0].createdAtUtc') >= ?
         AND json_extract(payload_json, '$.sources[0].createdAtUtc') < ?
       ORDER BY recorded_at_utc, rowid`,
      )
      .all(
        input.agentId,
        INTERACTION_APPRAISAL_STREAM_TYPE,
        INTERACTION_APPRAISAL_EVENT_TYPE,
        input.fromUtc,
        input.toUtc,
      ) as Array<{ payload_json: string }>;
    return rows.flatMap((row) => {
      let value: unknown;
      try {
        value = JSON.parse(row.payload_json);
      } catch {
        return [];
      }
      const parsed = InteractionAppraisalSchema.safeParse(value);
      return parsed.success &&
        parsed.data.agentId === input.agentId &&
        this.isCurrent(parsed.data)
        ? [parsed.data]
        : [];
    });
  }

  private isCurrent(record: InteractionAppraisal): boolean {
    return (
      this.validity.isDerivedCurrent(
        record.agentId,
        INTERACTION_APPRAISAL_STREAM_TYPE,
        record.id,
      ) &&
      record.sources.every((source, index) => {
        const current = this.readMessage(record.agentId, source.id);
        return (
          current !== undefined &&
          current.sessionId === record.sessionId &&
          source.id === record.sourceMessageIds[index] &&
          (index === 0
            ? current.role === "user"
            : current.role === "assistant" &&
              current.inReplyToMessageId === record.sourceMessageIds[0]) &&
          sourceHash(current) === source.sourceHash &&
          !this.validity.messageSourceNeedsReview(record.agentId, source.id)
        );
      })
    );
  }

  private readMessage(
    agentId: string,
    messageId: string,
  ): SourceMessage | undefined {
    return this.store.database
      .prepare(
        `SELECT id, agent_id AS agentId, session_id AS sessionId, role, content,
         created_at_utc AS createdAtUtc, in_reply_to_message_id AS inReplyToMessageId
       FROM messages WHERE agent_id = ? AND id = ? AND role IN ('user', 'assistant')`,
      )
      .get(agentId, messageId) as SourceMessage | undefined;
  }
}

function sourceHash(source: SourceMessage): string {
  return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function comparableReply(text: string): string {
  // Sequential delivery may add line breaks without rewriting any words.
  return text.replace(/\s+/gu, "");
}
