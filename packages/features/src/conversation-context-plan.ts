import {
  CONVERSATION_CONTEXT_POLICY_VERSION,
  ConversationContextPlanSchema,
  type ConversationContextPlan,
  type Message,
} from "@personasim/contracts";

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

const LISTEN =
  /(?:先听我说|听我说就好|只想(?:说说|吐槽|倾诉)|不(?:用|要|必|急着).{0,5}(?:建议|分析|解决)|别.{0,4}(?:建议|分析|追问)|just listen|(?:don't|do not|no) (?:give (?:me )?)?(?:advice|analy[sz]e))/iu;
const ADVICE =
  /(?:请.{0,6}(?:建议|帮我|分析)|给我.{0,6}(?:建议|办法|方案)|帮我.{0,6}(?:分析|想想|解决|决定|选)|我(?:该|应该)怎么(?:办|做)|有什么(?:建议|办法)|你建议|what should I do|(?:give me|I (?:want|need)) (?:some )?(?:advice|help)|help me (?:decide|solve|plan|understand))/iu;
const DETAIL =
  /(?:详细|深入|逐步|一步一步|多角度|全面|完整方案|深度分析|in detail|step[- ]by[- ]step|thorough|comprehensive)/iu;
const DETAIL_REQUEST =
  /(?:请|帮我|给我|我想(?:听|了解|知道)|我需要|你能|能不能|可以.{0,3}(?:说|讲)|(?:详细|深入|逐步|一步一步|多角度|全面).{0,3}(?:说说|讲讲|分析一下)|^(?:详细|深入|逐步|全面)(?:分析|解释)|\b(?:please|could you|can you|explain|describe|give me|I want|I need)\b)/iu;
const NEGATED_DETAIL =
  /(?:(?:不用|不要|不必|无需|别).{0,6}(?:详细|深入|逐步|全面|分析)|(?:not|don't|do not|no need).{0,16}(?:detail|analy[sz]|thorough))/iu;
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
  const listen = LISTEN.test(originalQuery);
  const detailedAnalysisRequested =
    DETAIL.test(originalQuery) &&
    DETAIL_REQUEST.test(originalQuery) &&
    !NEGATED_DETAIL.test(originalQuery);
  const adviceRequested = !listen && ADVICE.test(originalQuery);
  const recollection = RECOLLECTION.test(originalQuery);
  const venting = VENTING.test(originalQuery);
  const references = [...new Set(originalQuery.match(REFERENCES) ?? [])].slice(
    0,
    8,
  );
  // Only user-authored, same-session text can supply short-term query candidates.
  // Full source text is retained; oversized messages are omitted, not summarized.
  const sources =
    references.length === 0
      ? []
      : input.recentMessages
          .filter(
            (message) =>
              message.agentId === input.agentId &&
              message.sessionId === input.sessionId &&
              message.role === "user" &&
              message.text.length <= 1_200,
          )
          .slice(-3);
  const complexRecall =
    recollection &&
    (detailedAnalysisRequested || COMPLEX_RECOLLECTION.test(originalQuery));
  const intent: ConversationContextPlan["intent"] =
    adviceRequested || detailedAnalysisRequested
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
      adviceRequested || detailedAnalysisRequested
        ? "offer_requested_help"
        : listen || venting
          ? "listen"
          : "respond_naturally",
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
