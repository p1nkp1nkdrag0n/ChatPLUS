import {
  TurnObservationProposalSchema,
  type EvidenceQuote,
  type ScheduleIntentProposal,
  type TurnObservationProposal,
  type TurnRoute,
  type TurnTopicProposal,
} from "@personasim/contracts";
import {
  assembleTurnUnderstandingPrompt,
  routeTurn,
  validateWorldEffects,
  type ScheduleCapability,
  type ScheduleDialogueFrame,
  type TurnRouteDecision,
  type WorldEffectsValidationResult,
} from "@personasim/features";

import type { StoredMessage } from "../db/store.js";
import type { RuntimeState, ScheduleItem } from "../domain/schemas.js";
import type { GenerateObjectInput } from "./llm-service.js";
import type { ActiveScheduleNegotiation } from "./schedule-negotiation-service.js";

export type TurnUnderstandingOrigin =
  | "model_valid"
  | "model_partial"
  | "deterministic"
  | "typed_fallback"
  | "fallback";

export interface GroundedEvidenceQuote {
  text: string;
  start: number;
  end: number;
}

export interface ObservationRejection {
  field: string;
  reasonCode: string;
  reasonSummary: string;
}

export interface ResolvedTurnObservation {
  proposal?: TurnObservationProposal;
  origin: TurnUnderstandingOrigin;
  route: TurnRoute;
  scheduleIntent: ScheduleIntentProposal;
  validatedEvidence: GroundedEvidenceQuote[];
  rejectedFields: ObservationRejection[];
  worldEffectsValidation: WorldEffectsValidationResult;
  topics: TurnTopicProposal[];
  confidence: number;
  routerReasonCodes: string[];
  scheduleFrame?: ScheduleDialogueFrame;
}

export interface TurnUnderstandingInput {
  agentId: string;
  userText: string;
  nowUtc: string;
  timezone: string;
  state: RuntimeState;
  scheduleCapability: ScheduleCapability;
  activeNegotiation?: ActiveScheduleNegotiation;
  currentActivity?: ScheduleItem;
  authoritativeSchedule: readonly ScheduleItem[];
  recentMessages: readonly StoredMessage[];
  careCueTexts?: readonly string[];
  explicitMemoryPolicy?: string;
}

interface ObjectGenerator {
  generateObject<T>(input: GenerateObjectInput<T>): Promise<T>;
}

/**
 * Resolves semantic observations only. It never generates a character reply
 * and never writes state. Any provider or schema failure becomes a grounded
 * no-op observation so reply generation can still run.
 */
export class TurnUnderstandingService {
  constructor(private readonly llm: ObjectGenerator) {}

  async understand(
    input: TurnUnderstandingInput,
  ): Promise<ResolvedTurnObservation> {
    const routeDecision = routeTurn({
      userText: input.userText,
      scheduleCapability: input.scheduleCapability,
      ...(input.activeNegotiation === undefined
        ? {}
        : {
            activeNegotiation: activeNegotiationReference(
              input.activeNegotiation,
            ),
          }),
    });

    if (!routeDecision.needsModelUnderstanding) {
      return deterministicObservation(input.userText, routeDecision);
    }

    try {
      const prompt = assembleTurnUnderstandingPrompt({
        userMessage: input.userText,
        nowUtc: input.nowUtc,
        timezone: input.timezone,
        routeDecision,
        ...(input.activeNegotiation === undefined
          ? {}
          : {
              activeNegotiationSummary: JSON.stringify({
                id: input.activeNegotiation.stored.id,
                status: input.activeNegotiation.state.status,
                offerVersion: input.activeNegotiation.state.offerVersion,
                expired: input.activeNegotiation.expired,
              }),
            }),
        runtimeStateSummary: JSON.stringify({
          moodValence: input.state.moodValence,
          moodArousal: input.state.moodArousal,
          energy: input.state.energy,
          stress: input.state.stress,
          socialBattery: input.state.socialBattery,
          focus: input.state.focus,
          locationContext: input.state.locationContext,
        }),
        ...(input.currentActivity === undefined
          ? {}
          : {
              currentActivitySummary: JSON.stringify({
                title: input.currentActivity.title,
                category: input.currentActivity.category,
                startAtUtc: input.currentActivity.startAtUtc,
                endAtUtc: input.currentActivity.endAtUtc,
              }),
            }),
        relevantScheduleItems: relevantScheduleItemsForUnderstanding(
          input,
          routeDecision,
        ).map((item) =>
          JSON.stringify({
            title: item.title,
            category: item.category,
            startAtUtc: item.startAtUtc,
            endAtUtc: item.endAtUtc,
            status: item.status,
          }),
        ),
        recentTurns: input.recentMessages
          .filter(
            (message) =>
              message.role === "user" || message.role === "assistant",
          )
          .slice(-4)
          .map((message) => ({
            role: message.role as "user" | "assistant",
            content: message.content,
          })),
        ...(input.careCueTexts === undefined
          ? {}
          : { careCuePolicy: input.careCueTexts.slice(0, 4).join("\n") }),
        ...(input.explicitMemoryPolicy === undefined
          ? {}
          : { explicitMemoryPolicy: input.explicitMemoryPolicy }),
      });
      const proposal = TurnObservationProposalSchema.parse(
        await this.llm.generateObject({
          purpose: "turn_understanding",
          agentId: input.agentId,
          system: prompt.system,
          prompt: prompt.prompt,
          schema: TurnObservationProposalSchema,
          maxOutputTokens: prompt.maxOutputTokens,
        }),
      );
      return resolveModelProposal(input.userText, routeDecision, proposal);
    } catch {
      return fallbackObservation(input.userText, routeDecision);
    }
  }
}

function relevantScheduleItemsForUnderstanding(
  input: TurnUnderstandingInput,
  routeDecision: TurnRouteDecision,
): ScheduleItem[] {
  if (routeDecision.scheduleAccess === "none") return [];
  return input.authoritativeSchedule
    .filter(
      (item) =>
        item.status !== "cancelled" &&
        item.id !== input.currentActivity?.id &&
        scheduleTitleReferenced(input.userText, item.title),
    )
    .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc))
    .slice(0, 4);
}

function scheduleTitleReferenced(userText: string, title: string): boolean {
  const user = userText.normalize("NFKC").toLocaleLowerCase();
  const normalizedTitle = title.normalize("NFKC").toLocaleLowerCase().trim();
  if (normalizedTitle.length >= 3 && user.includes(normalizedTitle))
    return true;

  const latinAnchors = normalizedTitle.match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? [];
  if (latinAnchors.some((anchor) => user.includes(anchor))) return true;

  const hanRuns = normalizedTitle.match(/[\p{Script=Han}]{3,}/gu) ?? [];
  return hanRuns.some((run) =>
    Array.from({ length: Math.max(0, run.length - 2) }, (_, index) =>
      run.slice(index, index + 3),
    ).some((anchor) => user.includes(anchor)),
  );
}

function activeNegotiationReference(active: ActiveScheduleNegotiation): {
  id: string;
  sessionId: string;
  expired: boolean;
} {
  return {
    id: active.stored.id,
    sessionId: active.stored.sessionId,
    expired: active.expired,
  };
}

function deterministicObservation(
  userText: string,
  routeDecision: TurnRouteDecision,
): ResolvedTurnObservation {
  const scheduleIntent = routeDecision.deterministicScheduleIntent;
  const evidence = evidenceFromScheduleIntent(scheduleIntent)
    .map((quote) => groundQuote(quote, userText))
    .filter((quote): quote is GroundedEvidenceQuote => quote !== undefined);
  return {
    origin: "deterministic",
    route: routeDecision.route,
    scheduleIntent,
    validatedEvidence: uniqueGroundedEvidence(evidence),
    rejectedFields: [],
    worldEffectsValidation: validateWorldEffects({}),
    topics: [],
    confidence: 1,
    routerReasonCodes: [...routeDecision.reasonCodes],
    ...(routeDecision.scheduleFrame === undefined
      ? {}
      : { scheduleFrame: routeDecision.scheduleFrame }),
  };
}

function fallbackObservation(
  userText: string,
  routeDecision: TurnRouteDecision,
): ResolvedTurnObservation {
  if (
    routeDecision.route === "schedule_query" ||
    ((routeDecision.route === "schedule_mutation" ||
      routeDecision.route === "mixed") &&
      routeDecision.scheduleAccess === "mutation_candidate")
  ) {
    const query = routeDecision.route === "schedule_query";
    return {
      origin: "typed_fallback",
      route: query ? "schedule_query" : "ambiguous",
      scheduleIntent: query
        ? routeDecision.deterministicScheduleIntent.kind === "query_schedule"
          ? routeDecision.deterministicScheduleIntent
          : {
              kind: "query_schedule",
              evidenceQuotes: [{ text: userText.slice(0, 500) }],
            }
        : {
            kind: "ambiguous",
            evidenceQuotes: [{ text: userText.slice(0, 500) }],
            missingFields: ["validated schedule details"],
          },
      validatedEvidence: [],
      rejectedFields: [understandingUnavailableRejection()],
      worldEffectsValidation: validateWorldEffects({}),
      topics: [],
      confidence: 0,
      routerReasonCodes: [...routeDecision.reasonCodes],
      ...(routeDecision.scheduleFrame === undefined
        ? {}
        : { scheduleFrame: routeDecision.scheduleFrame }),
    };
  }
  const safeRoute: TurnRoute =
    routeDecision.route === "explicit_memory" ||
    routeDecision.route === "continuity"
      ? routeDecision.route
      : "conversation";
  const scheduleIntent: ScheduleIntentProposal = { kind: "none" };
  return {
    origin: "fallback",
    route: safeRoute,
    scheduleIntent,
    validatedEvidence: [],
    rejectedFields: [understandingUnavailableRejection()],
    worldEffectsValidation: validateWorldEffects({}),
    topics: [],
    confidence: 0,
    routerReasonCodes: [...routeDecision.reasonCodes],
    ...(routeDecision.scheduleFrame === undefined
      ? {}
      : { scheduleFrame: routeDecision.scheduleFrame }),
  };
}

function understandingUnavailableRejection(): ObservationRejection {
  return {
    field: "proposal",
    reasonCode: "understanding_unavailable",
    reasonSummary:
      "Structured turn understanding was unavailable; mutations were disabled for this turn.",
  };
}

function resolveModelProposal(
  userText: string,
  routeDecision: TurnRouteDecision,
  proposal: TurnObservationProposal,
): ResolvedTurnObservation {
  const rejectedFields: ObservationRejection[] = [];
  const validatedEvidence: GroundedEvidenceQuote[] = [];
  const groundedScheduleIntent = groundScheduleIntent(
    proposal.scheduleIntent,
    userText,
    rejectedFields,
    validatedEvidence,
  );
  const scheduleIntent = gateScheduleIntent(
    groundedScheduleIntent,
    routeDecision,
    rejectedFields,
  );
  const topics = groundTopics(
    proposal.topics,
    userText,
    rejectedFields,
    validatedEvidence,
  );
  for (const quote of proposal.salientUserQuotes) {
    const grounded = groundQuote(quote, userText);
    if (grounded === undefined) {
      rejectedFields.push(ungroundedRejection("salientUserQuotes"));
    } else {
      validatedEvidence.push(grounded);
    }
  }

  const worldEffectsValidation = validateWorldEffects(proposal.worldEffects);
  let route = proposal.route;
  if (
    routeDecision.route === "schedule_query" ||
    isDeterministicScheduleControl(routeDecision)
  ) {
    route = routeDecision.route;
  }
  if (route === "schedule_query" && routeDecision.scheduleAccess !== "read") {
    route = routeDecision.route;
  } else if (
    (route === "schedule_mutation" || route === "mixed") &&
    routeDecision.scheduleAccess !== "mutation_candidate"
  ) {
    route = routeDecision.route;
  } else if (
    (route === "schedule_mutation" || route === "mixed") &&
    (scheduleIntent.kind === "none" || scheduleIntent.kind === "ambiguous")
  ) {
    route = "ambiguous";
  } else if (
    route === "ambiguous" &&
    routeDecision.scheduleAccess === "none" &&
    routeDecision.route !== "ambiguous"
  ) {
    route = routeDecision.route;
  }

  const partial =
    rejectedFields.length > 0 || worldEffectsValidation.rejections.length > 0;
  return {
    proposal,
    origin: partial ? "model_partial" : "model_valid",
    route,
    scheduleIntent,
    validatedEvidence: uniqueGroundedEvidence(validatedEvidence),
    rejectedFields,
    worldEffectsValidation,
    topics,
    confidence: proposal.confidence,
    routerReasonCodes: [...routeDecision.reasonCodes],
    ...(routeDecision.scheduleFrame === undefined
      ? {}
      : { scheduleFrame: routeDecision.scheduleFrame }),
  };
}

function gateScheduleIntent(
  intent: ScheduleIntentProposal,
  decision: TurnRouteDecision,
  rejections: ObservationRejection[],
): ScheduleIntentProposal {
  if (intent.kind === "none") return intent;
  if (intent.kind === "ambiguous") {
    if (
      decision.route === "ambiguous" ||
      decision.route === "mixed" ||
      decision.scheduleAccess !== "none"
    ) {
      return intent;
    }
    rejections.push({
      field: "scheduleIntent",
      reasonCode: "schedule_route_not_eligible",
      reasonSummary:
        "The deterministic route gate did not authorize ambiguous schedule handling.",
    });
    return { kind: "none" };
  }
  const allowed =
    intent.kind === "query_schedule"
      ? decision.scheduleAccess === "read"
      : decision.scheduleAccess === "mutation_candidate";
  if (allowed) return intent;
  rejections.push({
    field: "scheduleIntent",
    reasonCode: "schedule_route_not_eligible",
    reasonSummary:
      "The deterministic route gate did not authorize this schedule intent.",
  });
  return { kind: "none" };
}

function isDeterministicScheduleControl(decision: TurnRouteDecision): boolean {
  return (
    decision.deterministicScheduleIntent.kind === "confirm_pending_offer" ||
    decision.deterministicScheduleIntent.kind === "decline_pending_offer"
  );
}

function groundScheduleIntent(
  intent: ScheduleIntentProposal,
  userText: string,
  rejections: ObservationRejection[],
  evidence: GroundedEvidenceQuote[],
): ScheduleIntentProposal {
  if (intent.kind === "none") return intent;
  if (intent.kind === "create_shared_activity") {
    const activity = groundQuote(intent.activityQuote, userText);
    if (activity === undefined) {
      rejections.push(ungroundedRejection("scheduleIntent.activityQuote"));
      return { kind: "none" };
    }
    evidence.push(activity);
    const time =
      intent.timeQuote === undefined
        ? undefined
        : groundQuote(intent.timeQuote, userText);
    const participant =
      intent.participantQuote === undefined
        ? undefined
        : groundQuote(intent.participantQuote, userText);
    const missingFields = new Set(intent.missingFields);
    if (intent.timeQuote !== undefined && time === undefined) {
      rejections.push(ungroundedRejection("scheduleIntent.timeQuote"));
      missingFields.add("time");
    }
    if (intent.participantQuote !== undefined && participant === undefined) {
      rejections.push(ungroundedRejection("scheduleIntent.participantQuote"));
      missingFields.add("participant");
    }
    if (time !== undefined) evidence.push(time);
    if (participant !== undefined) evidence.push(participant);
    const groundedIntent: ScheduleIntentProposal = {
      kind: "create_shared_activity",
      activityQuote: { text: activity.text },
      ...(time === undefined ? {} : { timeQuote: { text: time.text } }),
      ...(participant === undefined
        ? {}
        : { participantQuote: { text: participant.text } }),
      ...(intent.durationMinutes === undefined
        ? {}
        : { durationMinutes: intent.durationMinutes }),
      missingFields: [...missingFields],
    };
    return groundedIntent;
  }

  const quotes = evidenceFromScheduleIntent(intent);
  const grounded = quotes
    .map((quote) => groundQuote(quote, userText))
    .filter((quote): quote is GroundedEvidenceQuote => quote !== undefined);
  if (grounded.length !== quotes.length) {
    rejections.push(ungroundedRejection("scheduleIntent.evidenceQuotes"));
    return { kind: "none" };
  }
  evidence.push(...grounded);
  return intent;
}

function groundTopics(
  topics: readonly TurnTopicProposal[],
  userText: string,
  rejections: ObservationRejection[],
  evidence: GroundedEvidenceQuote[],
): TurnTopicProposal[] {
  const accepted: TurnTopicProposal[] = [];
  for (const [index, topic] of topics.entries()) {
    const grounded = topic.evidenceQuotes
      .map((quote) => groundQuote(quote, userText))
      .filter((quote): quote is GroundedEvidenceQuote => quote !== undefined);
    if (grounded.length !== topic.evidenceQuotes.length) {
      rejections.push(
        ungroundedRejection(`topics.${String(index)}.evidenceQuotes`),
      );
      continue;
    }
    evidence.push(...grounded);
    accepted.push(topic);
  }
  return accepted;
}

function groundQuote(
  quote: EvidenceQuote,
  userText: string,
): GroundedEvidenceQuote | undefined {
  const index = userText.indexOf(quote.text);
  return index < 0
    ? undefined
    : {
        text: userText.slice(index, index + quote.text.length),
        start: index,
        end: index + quote.text.length,
      };
}

function evidenceFromScheduleIntent(
  intent: ScheduleIntentProposal,
): EvidenceQuote[] {
  switch (intent.kind) {
    case "none":
      return [];
    case "create_shared_activity":
      return [
        intent.activityQuote,
        ...(intent.timeQuote === undefined ? [] : [intent.timeQuote]),
        ...(intent.participantQuote === undefined
          ? []
          : [intent.participantQuote]),
      ];
    case "query_schedule":
    case "confirm_pending_offer":
    case "decline_pending_offer":
    case "unsupported_mutation":
    case "ambiguous":
      return [...intent.evidenceQuotes];
  }
}

function uniqueGroundedEvidence(
  evidence: readonly GroundedEvidenceQuote[],
): GroundedEvidenceQuote[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${String(item.start)}:${String(item.end)}:${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ungroundedRejection(field: string): ObservationRejection {
  return {
    field,
    reasonCode: "evidence_not_grounded",
    reasonSummary:
      "The proposed evidence quote was not copied from the current user message.",
  };
}
