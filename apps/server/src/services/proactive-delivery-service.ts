import { ProactiveMessageProposalSchema } from "@personasim/contracts";
import { DateTime } from "luxon";

import { capabilitiesForTier } from "../domain/capabilities.js";
import type { DatabaseStore, StoredMessage } from "../db/store.js";
import type { Clock } from "../runtime/clock.js";
import type { SseHub } from "../sse/hub.js";
import type { LlmService } from "./llm-service.js";
import type {
  ProactiveGenerationOutcome,
  ProactiveGenerationPolicy,
  ProactiveGenerationService,
} from "./proactive-generation-service.js";

export type ProactiveDeliveryOutcome =
  | Exclude<ProactiveGenerationOutcome, { status: "committed" }>
  | {
      status: "committed";
      runId: string;
      message: StoredMessage;
    }
  | { status: "not_claimed"; reasonCode: "no_session" };

/**
 * Coordinates policy lookup, optional model composition, atomic generation,
 * and the runtime notification emitted only after the durable commit.
 */
export class ProactiveDeliveryService {
  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
    private readonly sse: SseHub,
    private readonly generations: ProactiveGenerationService,
  ) {}

  loadPolicy(agentId: string, nowUtc: string): ProactiveGenerationPolicy {
    const spec = this.store.getCharacterSpec(agentId);
    const state = this.store.getRuntimeState(agentId);
    if (spec === undefined || state === undefined) {
      return {
        tierSupportsProactive: false,
        policyEnabled: false,
        quietHours: true,
        timezone: "UTC",
        dailyLimit: 0,
        relationshipCloseness: 0,
        minimumCloseness: 1,
        maximumUnanswered: 2,
      };
    }
    const lastProactive = this.store.database
      .prepare(
        `SELECT created_at_utc
         FROM messages
         WHERE agent_id = ? AND message_kind = 'assistant_proactive'
         ORDER BY created_at_utc DESC, rowid DESC
         LIMIT 1`,
      )
      .get(agentId) as { created_at_utc: string } | undefined;
    const cooldownUntilUtc =
      lastProactive === undefined
        ? undefined
        : DateTime.fromISO(lastProactive.created_at_utc, { setZone: true })
            .plus({ hours: 2 })
            .toUTC()
            .toISO()!;

    return {
      tierSupportsProactive: capabilitiesForTier(spec.tier).proactiveDialogue,
      policyEnabled: spec.proactivePolicy.enabled,
      quietHours: isQuietTime(nowUtc, spec),
      timezone: spec.identity.timezone,
      dailyLimit: spec.proactivePolicy.maxMessagesPerDay,
      relationshipCloseness: state.relationship.closeness,
      minimumCloseness: spec.proactivePolicy.minimumCloseness,
      maximumUnanswered: 2,
      ...(cooldownUntilUtc === undefined ? {} : { cooldownUntilUtc }),
    };
  }

  async deliverNext(agentId: string): Promise<ProactiveDeliveryOutcome> {
    const spec = this.store.getCharacterSpec(agentId);
    if (
      spec === undefined ||
      !capabilitiesForTier(spec.tier).proactiveDialogue
    ) {
      return { status: "not_claimed", reasonCode: "tier_not_supported" };
    }
    const session = this.store.listSessions(agentId)[0];
    if (session === undefined) {
      return { status: "not_claimed", reasonCode: "no_session" };
    }
    const outcome = await this.generations.generate({
      agentId,
      sessionId: session.id,
      compose: async (context) => {
        try {
          const nowUtc = this.clock.nowUtc();
          const proposal = await this.llm.generateObject({
            purpose: "compose_proactive_message",
            agentId,
            system:
              "Write one concise, natural proactive message grounded only in the supplied delivery subject. A follow_up is due now: execute the check-in as a direct present-tense question. Never promise to ask or remind later, and never repeat an old relative date as if it were still future. Do not invent an outcome or imply that a planned event occurred.",
            prompt: JSON.stringify({
              nowUtc,
              deliveryState:
                context.subject.kind === "follow_up" ? "due_now" : "share_now",
              dueAtUtc: context.subject.earliestAtUtc,
              sourceExpiresAtUtc: context.subject.expiresAtUtc,
              expectedOutcomeDescription:
                context.subject.kind === "follow_up"
                  ? context.subject.expectedOutcomeDescription
                  : undefined,
              summary:
                context.subject.kind === "activity_candidate"
                  ? context.subject.summary
                  : context.subject.contextSummary,
              suggestedContent: context.suggestedContent,
              sourceKind: context.subject.kind,
              sourceId: context.subject.id,
            }),
            schema: ProactiveMessageProposalSchema,
            maxOutputTokens: 512,
            fixture: {
              content: context.suggestedContent,
              reasonCode: "fixture_proactive_composition",
              reasonSummary: "Uses the grounded delivery subject fixture.",
            },
          });
          return finalizeProactiveContent(
            context.subject.kind,
            context.suggestedContent,
            proposal.content,
          );
        } catch {
          return context.suggestedContent;
        }
      },
    });
    if (outcome.status !== "committed") return outcome;
    const message = toStoredMessage(outcome.message);
    this.sse.publish({
      type: "message.created",
      agentId,
      occurredAtUtc: message.createdAtUtc,
      data: message,
    });
    return { ...outcome, message };
  }
}

const DEFERRED_FOLLOW_UP_PATTERN =
  /(?:\u6211|\bI\b|\bwe\b).{0,12}(?:\u4f1a|\u5c06|will|going to).{0,40}(?:\u95ee|\u63d0\u9192|ask|check|remind)|(?:\u660e\u5929|\u4ee5\u540e|\u5230\u65f6\u5019|\u5c4a\u65f6|tomorrow|later).{0,40}(?:\u95ee|\u63d0\u9192|ask|check|remind)/iu;
const DIRECT_FOLLOW_UP_PATTERN =
  /[?\uff1f]|(?:\u5417|\u5462)(?:[\u3002\uff01!])?$|\b(?:how|did|have|has|is|are|was|were|do|does|what)\b/iu;

export function finalizeProactiveContent(
  sourceKind: "activity_candidate" | "follow_up",
  suggestedContent: string,
  generatedContent: string,
): string {
  const content = generatedContent.replace(/\s+/gu, " ").trim();
  if (sourceKind !== "follow_up") return content;
  if (
    DEFERRED_FOLLOW_UP_PATTERN.test(content) ||
    !DIRECT_FOLLOW_UP_PATTERN.test(content)
  ) {
    return suggestedContent;
  }
  return content;
}

function isQuietTime(
  nowUtc: string,
  spec: NonNullable<ReturnType<DatabaseStore["getCharacterSpec"]>>,
): boolean {
  const local = DateTime.fromISO(nowUtc, { setZone: true }).setZone(
    spec.identity.timezone,
  );
  const minute = local.hour * 60 + local.minute;
  const start = clockMinutes(spec.proactivePolicy.quietHours.startLocal);
  const end = clockMinutes(spec.proactivePolicy.quietHours.endLocal);
  return start > end
    ? minute >= start || minute < end
    : minute >= start && minute < end;
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number) as [number, number];
  return hour * 60 + minute;
}

function toStoredMessage(
  message: Extract<
    ProactiveGenerationOutcome,
    { status: "committed" }
  >["message"],
): StoredMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    agentId: message.agentId,
    role: "assistant",
    content: message.content,
    messageKind: "assistant_proactive",
    metadata: message.metadata,
    createdAtUtc: message.createdAtUtc,
    ...(message.triggerEventId === undefined
      ? {}
      : { triggerEventId: message.triggerEventId }),
  };
}
