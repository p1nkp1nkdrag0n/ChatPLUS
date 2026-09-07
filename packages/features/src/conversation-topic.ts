import { normalizeText } from "./shared.js";
import type { ConversationContextPlan } from "@personasim/contracts";
import { withoutQuotedConversationText } from "./conversation-requests.js";

const TOPIC_SHIFT =
  /(?:换个话题|换一个话题|说点别的|另一个话题|回到|转到|change (?:the )?subject|changing (?:the )?topic|back to)/giu;
const EXCLUDED_TOPIC_CLAUSE =
  /(?:先?别|不(?:用|要|想)?|暂时不).{0,3}(?:聊|谈|说起|提起)|(?:don't|do not) (?:talk|speak) about/iu;
const GENERIC_REFERENCE =
  /^(?:(?:她|他|它|那个人|那件事|这件事)(?:今天|刚才|后来)?(?:又|也|还是|仍然)?(?:那样|这样|怎么了|怎么样了|呢|没变|没变化|变了|说了同样的话|做了同样的事)(?:了|呀|啊)?|(?:she|he|it|that person|that thing) (?:did (?:it|that) again|again|hasn't changed))[。.!！?？\s]*$/iu;
const PERSON =
  /(?:同事|主管|领导|老板|经理|客户|姐姐|妹妹|哥哥|弟弟|妈妈|母亲|爸爸|父亲|老师|同学|朋友|邻居|colleague|coworker|manager|sister|brother|mother|father|teacher|friend)/giu;

/** Explicit switches and exclusions bound topic text before it can activate practices. */
function focusedTopicText(text: string): string {
  const unquoted = withoutQuotedConversationText(text);
  const shifts = [...unquoted.matchAll(TOPIC_SHIFT)];
  const shift = shifts.at(-1);
  const focused =
    shift === undefined
      ? unquoted
      : unquoted.slice(shift.index + shift[0].length);
  return focused
    .split(/(?<=[，,。;；\n])/u)
    .filter((clause) => !EXCLUDED_TOPIC_CLAUSE.test(clause))
    .join("")
    .replace(/^[，,\s]+/u, "")
    .trim();
}

/**
 * Resolve topic continuity only, never a person or a fact. The nearest user
 * source must introduce one unambiguous person; competing introductions and
 * topic switches are barriers. Ordinary concrete current text stands alone.
 */
export function resolveCurrentConversationTopic(input: {
  originalQuery: string;
  recentUserMessages: readonly { id: string; text: string }[];
}): NonNullable<ConversationContextPlan["resolvedCurrentTopic"]> {
  const current = focusedTopicText(input.originalQuery);
  const base = {
    policyVersion: "scoped_topic_v1" as const,
    sourceMessageIds: [],
  };
  if (!GENERIC_REFERENCE.test(current)) {
    return {
      ...base,
      text: current,
      basis: current.length === 0 ? "unresolved" : "current_message",
    };
  }
  const recent = input.recentUserMessages.slice(-3);
  const latest = recent.at(-1);
  if (latest === undefined || latest.text.length > 1_200)
    return { ...base, text: "", basis: "unresolved" };
  const source = focusedTopicText(latest.text);
  const people = [...new Set(source.match(PERSON) ?? [])];
  const previousPeople = recent
    .slice(0, -1)
    .flatMap((message) => focusedTopicText(message.text).match(PERSON) ?? []);
  const hasTopicShift = [...latest.text.matchAll(TOPIC_SHIFT)].length > 0;
  if (
    people.length !== 1 ||
    /(?:或者|还是|要么|如果|假如|假设|以后|每次|今后|\b(?:or|if|in future)\b)/iu.test(
      source,
    ) ||
    (!hasTopicShift && previousPeople.some((person) => person !== people[0]))
  )
    return { ...base, text: "", basis: "unresolved" };
  return {
    ...base,
    text: source,
    basis: "recent_user_continuity",
    sourceMessageIds: [latest.id],
  };
}

/** Generic distress words cannot move a practice from work to family or another topic. */
export function matchesConversationTopic(
  topic: string,
  currentText: string,
): boolean {
  const anchor = normalizeText(topic)
    .replace(/(?:烦恼|挫折|压力|问题|相关|事情|感受|关系|方面|的)/gu, "")
    .trim();
  if (anchor.length < 2) return false;
  const current = normalizeText(currentText);
  return /\p{Script=Han}/u.test(anchor)
    ? current.includes(anchor)
    : ` ${current} `.includes(` ${anchor} `);
}
