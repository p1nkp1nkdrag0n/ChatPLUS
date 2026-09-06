import {
  CONVERSATION_CONTEXT_POLICY_VERSION,
  ConversationContextPlanSchema,
  type ConversationContextPlan,
  type Message,
} from "@personasim/contracts";

import { deriveCurrentConversationRequests } from "./conversation-requests.js";
import { resolveCurrentConversationTopic } from "./conversation-topic.js";

export interface ConversationContextPlanInput {
  originalQuery: string;
  agentId: string;
  sessionId: string;
  /** Chronological retained original messages from this conversation. */
  recentMessages: readonly Pick<
    Message,
    "id" | "agentId" | "sessionId" | "role" | "text"
  >[];
}

const VENTING =
  /(?:为什么|为何).{0,14}(?:我总|我又|我老|搞砸|倒霉|这么难|不顺)|(?:难过|委屈|烦死|好烦|挫败|好累|想哭|沮丧|好崩溃)|why (?:do I always|am I always|does (?:this|everything) always)|(?:so frustrated|feel awful|feel terrible)/iu;
const RECOLLECTION =
  /(?:还记得|记不记得|回顾|回想|以前.{0,8}(?:说过|聊过)|之前.{0,8}(?:说过|聊过)|这些年|一路走来|do you remember|look back|reminisce)/iu;
const COMPLEX_RECOLLECTION =
  /(?:这些年|一路走来|所有|全部|整个|几次|每次|分别|对比|变化|过程|timeline|all (?:the|our)|over (?:the )?years)/iu;
const REFERENCES =
  /(?:她|他|它|那件事|这件事|那样|这样|那个人|那个|\b(?:she|he|they|that person|that thing|it)\b)/giu;
const LIFE =
  /(?:你.{0,5}(?:今天|最近|近况|过得|在忙|有什么新鲜事)|(?:how (?:was|is) your day|what have you been up to))/iu;

/** Bounded lexical planning. Ambiguous references deliberately remain unresolved. */
export function buildConversationContextPlan(
  input: ConversationContextPlanInput,
): ConversationContextPlan {
  const originalQuery = input.originalQuery;
  const requests = deriveCurrentConversationRequests(originalQuery);
  const { listen, detailedAnalysisRequested, adviceRequested } = requests;
  const recollection = RECOLLECTION.test(originalQuery);
  const venting = VENTING.test(originalQuery);
  const references = [...new Set(originalQuery.match(REFERENCES) ?? [])].slice(
    0,
    8,
  );
  // Only user-authored, same-session text can supply short-term query candidates.
  // Full source text is retained; oversized messages are omitted, not summarized.
  const recentUserMessages = input.recentMessages.filter(
    (message) =>
      message.agentId === input.agentId &&
      message.sessionId === input.sessionId &&
      message.role === "user",
  );
  const sources =
    references.length === 0
      ? []
      : recentUserMessages
          .filter((message) => message.text.length <= 1_200)
          .slice(-3);
  const complexRecall =
    recollection &&
    (detailedAnalysisRequested || COMPLEX_RECOLLECTION.test(originalQuery));
  const intent: ConversationContextPlan["intent"] = requests.conflicting
    ? "uncertain"
    : adviceRequested || detailedAnalysisRequested
      ? "help"
      : recollection
        ? "recollection"
        : listen || venting
          ? "venting"
          : /(?:对不起|我们.{0,5}(?:误会|吵架)|sorry (?:about|for))/iu.test(
                originalQuery,
              )
            ? "relationship_repair"
            : /(?:今天|刚才|分享|发生了|today|just happened)/iu.test(
                  originalQuery,
                )
              ? "sharing"
              : "casual";
  return ConversationContextPlanSchema.parse({
    policyVersion: CONVERSATION_CONTEXT_POLICY_VERSION,
    originalQuery,
    expandedQueries: [...new Set(sources.map((message) => message.text))],
    contextMessageIds: sources.map((message) => message.id),
    unresolvedReferences: references,
    intent,
    adviceRequested,
    detailedAnalysisRequested,
    supportStyle:
      requests.supportStyle === "respond_naturally" &&
      venting &&
      !requests.conflicting
        ? "listen"
        : requests.supportStyle,
    helpTiming: requests.helpTiming,
    requestPolicyVersion: "clause_requests_v1",
    resolvedCurrentTopic: resolveCurrentConversationTopic({
      originalQuery,
      recentUserMessages,
    }),
    maxRecallEvidence: complexRecall ? 8 : 3,
    maxExplicitMemories: complexRecall
      ? 8
      : recollection
        ? 3
        : listen || venting
          ? 0
          : 2,
    allowCharacterLifeMention: LIFE.test(originalQuery),
  });
}
