import {
  INTERACTION_EVIDENCE_POLICY_VERSION,
  InteractionEvidenceSnapshotSchema,
  type InteractionEvidenceAnchor,
  type InteractionEvidenceSnapshot,
  type InteractionSourceMessage,
} from "@personasim/contracts";

import { deriveCurrentConversationRequests } from "./conversation-requests.js";

type Behavior = InteractionEvidenceAnchor["behavior"];
type Modality = InteractionEvidenceAnchor["modality"];

export interface InteractionPracticeReference {
  id: string;
  sourceMessageId: string;
  practice: Behavior;
  scope?: { topic?: string };
}

export interface BuildInteractionEvidenceInput {
  userId: string;
  characterId: string;
  /** Caller supplies only valid, participant-scoped original messages. */
  messages: readonly InteractionSourceMessage[];
  activePractices?: readonly InteractionPracticeReference[];
}

export type InteractionAttributionViolationCode =
  | "INTERACTION_DIRECTION_INVERTED"
  | "REQUEST_PROMOTED_TO_HISTORY"
  | "UNSUPPORTED_REPEATED_BEHAVIOR_CLAIM"
  | "UNSUPPORTED_INTERACTION_HISTORY_CLAIM";

export interface InteractionClaim {
  text: string;
  start: number;
  end: number;
  surface: "text" | "chunk";
  chunkIndex?: number;
  actor: string;
  recipient: string;
  behavior: Behavior;
  modality: Modality;
  historical: boolean;
  topic?: string;
}

export interface InteractionAttributionViolation {
  code: InteractionAttributionViolationCode;
  severity: "error";
  /** Absence of supporting evidence is not a claim that it never happened. */
  evidenceStatus: "insufficient";
  detail: string;
  text: string;
  start: number;
  end: number;
  surface: "text" | "chunk";
  chunkIndex?: number;
  claim: InteractionClaim;
  anchorIds: string[];
  sourceMessageIds: string[];
}

// Finite Chinese dyadic communication patterns. This is not a general fact judge.
const LISTEN_PATTERN =
  /(我|你)([^我你。！？!?；;\n]{0,28}?)(?:(?:听|倾听)(我|你)(?:说|讲|倾诉|吐槽)?|(?:等|让)(我|你)(?:先)?(?:说完|讲完)|(?:不(?:再)?打断)(我|你))/gu;
const QUESTIONS_PATTERN =
  /(我|你)([^我你。！？!?；;\n]{0,28}?)(?:(?:少|减少|不再|不怎么)(?:再)?(?:追问|问)(我|你))/gu;
const LISTEN_PROMISE_PATTERN =
  /(我|你)((?:之前|以前|曾经|曾|已经|早就)?(?:答应过|承诺过)(?:我|你)[^我你。！？!?；;\n]{0,16}?)(?:(?:听|倾听)(我|你)(?:说|讲)?|(?:等|让)(我|你)(?:先)?(?:说完|讲完))/gu;
const REPEATED =
  /(?:一直|总是|每次|一贯|常常|经常|反复|这些年|这么多年|每回|每一次|向来)/u;
const OCCURRED =
  /(?:之前|以前|过去|当时|昨天|昨晚|上次|刚才|曾经|曾|已经|还记得|记得那次|谢谢|感谢|多亏)/u;
const WILLING = /(?:愿意|乐意|可以|准备|打算|以后会|会先|将会)/u;
const REQUEST =
  /(?:希望|请求|要求|让|请|想要|想让|盼着|盼望|说过.{0,8}(?:要|先))/u;
const NEGATED =
  /(?:没有|并没|从没|从未|不是|并非|不曾|没说|别说|不能说|谈不上|未曾|不要把|不代表|不等于|不希望|不想让|不需要|不用|不必|不愿意|不乐意|不打算|不准备|不(?:总是|一直|每次|经常|常常))/u;
const HYPOTHETICAL = /(?:如果|假如|假设|要是|比如|举例|试想)/u;
const THIRD_PARTY_REPORT =
  /(?:(?:朋友|同事|姐姐|妹妹|哥哥|弟弟|妈妈|爸爸|别人|第三方|他|她).{0,14}(?:说|希望|要求|让)|(?:转述|引用|原话|那句|这句话))/u;

/** Preserve offsets for evidence and for downstream annotation of rejected spans. */
function maskQuotes(text: string): string {
  return text.replace(
    /“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|(?<!\p{L})'[^'\n]*'(?!\p{L})|`[^`]*`/gu,
    (quote) => " ".repeat(quote.length),
  );
}

function sentenceAt(text: string, index: number) {
  const before = text.slice(0, index);
  const start =
    Math.max(
      before.lastIndexOf("。"),
      before.lastIndexOf("！"),
      before.lastIndexOf("？"),
      before.lastIndexOf("!"),
      before.lastIndexOf("?"),
      before.lastIndexOf("\n"),
      before.lastIndexOf(";"),
      before.lastIndexOf("；"),
    ) + 1;
  const rest = text.slice(index);
  const suffixEnd = rest.search(/[。！？!?；;\n]/u);
  return {
    prefix: text.slice(start, index),
    text: text.slice(start, suffixEnd < 0 ? text.length : index + suffixEnd),
  };
}

function topicIn(text: string): string | undefined {
  return /(?:聊|谈|说起|谈到|说到)([^，,。！？!?；;\n]{1,16}?)(?:时|的时候|的话|话题)/u.exec(
    text,
  )?.[1];
}

function participant(
  pronoun: string,
  role: "user" | "assistant",
  input: {
    userId: string;
    characterId: string;
  },
): string {
  const isUser = (pronoun === "我") === (role === "user");
  return isUser ? `user:${input.userId}` : `character:${input.characterId}`;
}

function directClaims(
  text: string,
  role: "user" | "assistant",
  identities: { userId: string; characterId: string },
): Omit<InteractionClaim, "surface" | "chunkIndex">[] {
  const masked = maskQuotes(text);
  const results: Omit<InteractionClaim, "surface" | "chunkIndex">[] = [];
  for (const [behavior, pattern] of [
    ["listen_first", LISTEN_PATTERN],
    ["listen_first", LISTEN_PROMISE_PATTERN],
    ["fewer_questions", QUESTIONS_PATTERN],
  ] as const) {
    for (const match of masked.matchAll(pattern)) {
      const actorPronoun = match[1]!;
      const recipientPronoun = match[3] ?? match[4] ?? match[5];
      if (recipientPronoun === undefined || actorPronoun === recipientPronoun)
        continue;
      const sentence = sentenceAt(masked, match.index);
      const modifiers = match[2] ?? "";
      // "I heard you mention X" reports conversational content, not a claim
      // that a listen-first practice was followed. Its content needs other guards.
      if (
        /(?:听[我你](?:说|讲))$/u.test(match[0]) &&
        /^过/u.test(masked.slice(match.index + match[0].length)) &&
        !/(?:先|耐心|认真|倾听)/u.test(match[0])
      )
        continue;
      // Questions, conditions, metalinguistic quotation and denials do not assert history.
      if (
        NEGATED.test(modifiers) ||
        NEGATED.test(sentence.prefix.slice(-24)) ||
        HYPOTHETICAL.test(sentence.prefix) ||
        THIRD_PARTY_REPORT.test(sentence.prefix) ||
        /(?:吗|么|是否|有没有|难道)/u.test(sentence.text) ||
        /(?:[?？])/u.test(
          masked.slice(
            match.index + match[0].length,
            match.index + match[0].length + 2,
          ),
        )
      )
        continue;
      const requestPrefix = sentence.prefix.slice(-20);
      const request =
        REQUEST.test(modifiers) ||
        /(?:希望|请求|要求|想要|想让|请|盼着|盼望|说过.{0,6}(?:要|先))[^，,]{0,8}$/u.test(
          requestPrefix,
        );
      const allModifiers = `${sentence.prefix.slice(-12)}${modifiers}`;
      const promised = /(?:答应过|承诺过)/u.test(modifiers);
      const willing =
        WILLING.test(modifiers) &&
        (!REPEATED.test(allModifiers) ||
          /(?:愿意|乐意|以后|准备|打算)/u.test(modifiers));
      const modality: Modality | undefined = request
        ? "requested"
        : promised
          ? "promised"
          : willing
            ? "willing"
            : REPEATED.test(allModifiers)
              ? "observed_repeated"
              : OCCURRED.test(allModifiers) ||
                  /(?:了|过)/u.test(
                    masked.slice(
                      match.index + match[0].length,
                      match.index + match[0].length + 4,
                    ),
                  )
                ? "observed_once"
                : undefined;
      if (modality === undefined) continue;
      const start = match.index;
      const end = start + match[0].length;
      const topic = topicIn(sentence.text);
      results.push({
        text: text.slice(start, end),
        start,
        end,
        actor: participant(actorPronoun, role, identities),
        recipient: participant(recipientPronoun, role, identities),
        behavior,
        modality,
        historical:
          promised ||
          REPEATED.test(allModifiers) ||
          OCCURRED.test(allModifiers),
        ...(topic === undefined ? {} : { topic }),
      });
    }
  }
  return results;
}

/**
 * Builds a temporary evidence view, not new persona adaptations. Original user
 * reports may support behavior; prior assistant assertions never corroborate themselves.
 */
export function buildInteractionEvidence(
  input: BuildInteractionEvidenceInput,
): InteractionEvidenceSnapshot {
  const historicalAnchors: InteractionEvidenceAnchor[] = [];
  for (const message of input.messages) {
    if (message.role !== "user") continue;
    const claims = directClaims(message.text, "user", input);
    const unquoted = maskQuotes(message.text);
    const request = deriveCurrentConversationRequests(message.text);
    // Implicit "please listen to me" has no actor pronoun. Do not infer this
    // from a forwarded quotation or hypothetical, nor from a negated request.
    const explicitListen =
      request.listen &&
      !request.conflicting &&
      /(?:先听我(?:说|讲)|先让我(?:说|讲)完|不要急着给(?:我)?建议|别急着给(?:我)?建议)/u.test(
        unquoted,
      );
    const fewerQuestions =
      /(?:请|希望你|以后|每次|不要|别|少).{0,14}(?:少追问我|别追问我|不要追问我|少问我)/u.test(
        unquoted,
      );
    const eligibleRequest =
      !HYPOTHETICAL.test(unquoted) && !THIRD_PARTY_REPORT.test(unquoted);
    const topic = topicIn(unquoted);
    for (const behavior of eligibleRequest
      ? [
          ...(explicitListen ? ["listen_first" as const] : []),
          ...(fewerQuestions ? ["fewer_questions" as const] : []),
        ]
      : []) {
      if (
        !claims.some(
          (claim) =>
            claim.behavior === behavior && claim.modality === "requested",
        )
      ) {
        claims.push({
          text: message.text,
          start: 0,
          end: message.text.length,
          actor: `character:${input.characterId}`,
          recipient: `user:${input.userId}`,
          behavior,
          modality: "requested",
          historical: false,
          ...(topic === undefined ? {} : { topic }),
        });
      }
    }
    for (const [index, claim] of claims.entries()) {
      const observed =
        claim.modality === "observed_once" ||
        claim.modality === "observed_repeated";
      historicalAnchors.push({
        id: `interaction:${message.id}:${claim.behavior}:${index}`,
        kind: observed ? "behavior_report" : "communication_preference",
        ...(claim.modality === "requested"
          ? { requestedBy: claim.recipient }
          : {}),
        expectedActor: claim.actor,
        recipient: claim.recipient,
        behavior: claim.behavior,
        scope: claim.topic === undefined ? {} : { topic: claim.topic },
        modality: claim.modality,
        sourceMessageIds: [message.id],
        sourceQuotes: [
          { messageId: message.id, role: "user", text: message.text },
        ],
        observedAdherenceEvidenceIds: observed ? [message.id] : [],
      });
    }
  }
  const activePracticeAnchorIds = historicalAnchors
    .filter(
      (anchor) =>
        anchor.modality === "requested" &&
        input.activePractices?.some(
          (practice) =>
            practice.practice === anchor.behavior &&
            anchor.sourceMessageIds.includes(practice.sourceMessageId),
        ),
    )
    .map((anchor) => anchor.id);
  return InteractionEvidenceSnapshotSchema.parse({
    policyVersion: INTERACTION_EVIDENCE_POLICY_VERSION,
    userId: input.userId,
    characterId: input.characterId,
    sourceMessages: input.messages,
    historicalAnchors,
    activePracticeAnchorIds,
  });
}

/** Inspect actual emitted surfaces. Caller must repeat this after any later rewrite. */
export function inspectInteractionAttribution(input: {
  text: string;
  chunks?: readonly string[];
  evidence: InteractionEvidenceSnapshot;
}): {
  allowed: boolean;
  violations: InteractionAttributionViolation[];
  claims: InteractionClaim[];
} {
  const claims: InteractionClaim[] = [
    ...directClaims(input.text, "assistant", input.evidence).map((claim) => ({
      ...claim,
      surface: "text" as const,
    })),
    ...(input.chunks ?? []).flatMap((chunk, chunkIndex) =>
      directClaims(chunk, "assistant", input.evidence).map((claim) => ({
        ...claim,
        surface: "chunk" as const,
        chunkIndex,
      })),
    ),
  ];
  const violations: InteractionAttributionViolation[] = [];
  for (const claim of claims) {
    if (
      claim.modality !== "observed_once" &&
      claim.modality !== "observed_repeated" &&
      claim.modality !== "promised" &&
      !(claim.modality === "requested" && claim.historical)
    )
      continue;
    const relevant = input.evidence.historicalAnchors.filter(
      (anchor) =>
        anchor.behavior === claim.behavior &&
        (claim.topic === undefined ||
          anchor.scope.topic === undefined ||
          claim.topic === anchor.scope.topic),
    );
    const sameDirection = relevant.filter(
      (anchor) =>
        anchor.expectedActor === claim.actor &&
        anchor.recipient === claim.recipient,
    );
    const supported = sameDirection.some((anchor) =>
      claim.modality === "promised" || claim.modality === "requested"
        ? anchor.modality === claim.modality
        : anchor.observedAdherenceEvidenceIds.length > 0 &&
          (anchor.modality === "observed_repeated" ||
            (claim.modality === "observed_once" &&
              anchor.modality === "observed_once")),
    );
    if (supported) continue;
    const codes: InteractionAttributionViolationCode[] = [];
    if (sameDirection.length === 0 && relevant.length > 0)
      codes.push("INTERACTION_DIRECTION_INVERTED");
    if (
      claim.modality !== "requested" &&
      (sameDirection.some((anchor) => anchor.modality === "requested") ||
        (sameDirection.length === 0 &&
          relevant.some((anchor) => anchor.modality === "requested")))
    )
      codes.push("REQUEST_PROMOTED_TO_HISTORY");
    if (claim.modality === "observed_repeated")
      codes.push("UNSUPPORTED_REPEATED_BEHAVIOR_CLAIM");
    if (codes.length === 0) codes.push("UNSUPPORTED_INTERACTION_HISTORY_CLAIM");
    for (const code of codes) {
      violations.push({
        code,
        severity: "error",
        evidenceStatus: "insufficient",
        detail: `The visible ${claim.behavior} claim requires ${claim.modality} evidence for ${claim.actor} -> ${claim.recipient}; the frozen user evidence does not support that attribution and frequency. This does not establish that the behavior never happened.`,
        text: claim.text,
        start: claim.start,
        end: claim.end,
        surface: claim.surface,
        ...(claim.chunkIndex === undefined
          ? {}
          : { chunkIndex: claim.chunkIndex }),
        claim,
        anchorIds: relevant.map((anchor) => anchor.id),
        sourceMessageIds: [
          ...new Set(relevant.flatMap((anchor) => anchor.sourceMessageIds)),
        ],
      });
    }
  }
  return { allowed: violations.length === 0, violations, claims };
}
