import type {
  FollowUpCandidateLike,
  FollowUpSubjectTypeLike,
} from "./follow-up.js";

export interface FollowUpEvidenceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** Server-derived evidence, never a model-supplied approval flag. */
export interface FollowUpGroundingBasis {
  version: 1;
  basisKind:
    | "user_event"
    | "user_plan"
    | "explicit_follow_up_request"
    | "shared_commitment"
    | "character_commitment";
  modality: "planned" | "requested";
  matter: string;
  timingSource: "event_or_plan" | "follow_up_request";
  sourceMessageIds: string[];
}

export type FollowUpGroundingRejectionCode =
  | "unsupported_follow_up_basis"
  | "conditional_or_reported_basis"
  | "missing_shared_commitment_evidence";

export type FollowUpGroundingResult =
  | {
      accepted: true;
      basis: FollowUpGroundingBasis;
      contextSummary: string;
      expectedOutcomeDescription: string;
      timingText: string;
    }
  | {
      accepted: false;
      rejection: {
        reasonCode: FollowUpGroundingRejectionCode;
        reasonSummary: string;
      };
    };

const UNCERTAIN =
  /如果|要是|假如|也许|或许|可能会|不一定|不打算|不准备|不会|不想|取消|不是我|不是说我|并非我|\b(?:if|might|maybe|perhaps|unless|would|won't|will not|not planning)\b/iu;
const REPORTED =
  /(?:朋友|同事|姐姐|妹妹|哥哥|弟弟|爸爸|妈妈|他|她).{0,12}(?:说|打算|准备|计划|会去)|^(?:你说|你建议|你让我)|\b(?:he|she|they|friend|colleague)\b.{0,25}\b(?:said|says|plans?|will|has)\b/iu;
const REMINDER =
  /(?:提醒我|问问我|问我|记得问|到时候问|到时问|remind\s+me|ask\s+me|check\s+(?:in|on))/iu;
const TIMING =
  /明天|明日|后天|今天|今日|下周|\d{1,2}\s*天后|tomorrow|today|next\s+week|(?:in\s*)?\d{1,2}\s*days?/iu;
const USER_PLAN =
  /(?:我|我们).{0,15}(?:打算|计划|准备(?:去|做|参加|提交|试|写|发|完成)|会(?:去|做|参加|提交|试|写|发|完成|一起|共同)|要(?:去|做|参加|提交|试|写|发|完成)|试试|试一下)|\b(?:i|we)\s+(?:will|plan\s+to|am\s+going\s+to|are\s+going\s+to)\b/iu;
const USER_EVENT =
  /(?:有|参加|要去|要做|要考|要交|要开|安排了).{1,70}|\b(?:i\s+have|my\s+.{2,60}\s+is|the\s+.{2,60}\s+is)\b/iu;
const SHARED = /我们|一起|共同|\bwe\b|\btogether\b/iu;

/** Deliberately bounded extraction: uncertain or implicit adoption stays unscheduled.
 * Politeness, requests for analysis, and an assistant suggestion are not plans.
 * The expected outcome is reconstructed from the actual matter; model outcome
 * prose is never preserved as a claim of adoption, execution, or success. */
export function groundFollowUpCandidate(input: {
  candidate: FollowUpCandidateLike;
  sourceMessage: FollowUpEvidenceMessage;
  supportingMessages?: readonly FollowUpEvidenceMessage[];
}): FollowUpGroundingResult {
  const source = input.sourceMessage;
  const clauses = source.text
    .split(/(?<=[。！？!?；;\n])/u)
    .map((value) => value.trim())
    .filter(Boolean);
  const subject = input.candidate.subjectType;
  const matter = clauses.find(
    (clause) =>
      !UNCERTAIN.test(clause) &&
      !REPORTED.test(clause) &&
      !/^[“「『"']/u.test(clause) &&
      supportsSubject(clause, subject, source.role) &&
      hasConcreteMatter(clause) &&
      input.candidate.evidenceQuotes.some((quote) =>
        meaningfulOverlap(clause, quote),
      ),
  );
  if (matter === undefined) {
    return reject(
      UNCERTAIN.test(source.text) || REPORTED.test(source.text)
        ? "conditional_or_reported_basis"
        : "unsupported_follow_up_basis",
      "No concrete, unqualified event, plan, or follow-up request is supported by the source speaker. Analysis and acknowledgement do not establish adoption.",
    );
  }
  const sources = [source];
  if (subject === "shared_commitment") {
    const other = input.supportingMessages?.find(
      (message) =>
        message.role !== source.role &&
        SHARED.test(message.text) &&
        !UNCERTAIN.test(message.text) &&
        !REPORTED.test(message.text) &&
        (message.role === "assistant"
          ? characterCommitment(message.text)
          : USER_PLAN.test(message.text)) &&
        meaningfulOverlap(matter, message.text),
    );
    if (other === undefined)
      return reject(
        "missing_shared_commitment_evidence",
        "A shared commitment requires independent matching statements from both speakers.",
      );
    sources.push(other);
  }
  const reminder = source.role === "user" && REMINDER.test(matter);
  const basisKind =
    subject === "shared_commitment" || subject === "character_commitment"
      ? subject
      : reminder
        ? "explicit_follow_up_request"
        : USER_PLAN.test(matter)
          ? "user_plan"
          : "user_event";
  // Use the complete supporting clause so negation and event ownership cannot
  // be lost by selecting a few overlapping words from an unrelated sentence.
  const contextSummary = matter.slice(0, 1_000);
  return {
    accepted: true,
    basis: {
      version: 1,
      basisKind,
      modality: reminder ? "requested" : "planned",
      matter: contextSummary,
      timingSource: reminder ? "follow_up_request" : "event_or_plan",
      sourceMessageIds: sources.map((message) => message.id),
    },
    contextSummary,
    expectedOutcomeDescription:
      `仅询问所述事项是否发生、是否尝试或安排有无变化，不预设执行或成功。来源原话：${contextSummary}`.slice(
        0,
        1_000,
      ),
    timingText: matter,
  };
}

function hasConcreteMatter(text: string): boolean {
  const remaining = text
    .replace(
      /明天|明日|后天|今天|今日|下周|上午|下午|中午|晚上|早上|\d+(?:点|分|天后)?|我们|一起|共同|你说的|你建议的|问问我|问我|提醒我|记得|试试|试一下|我|你|会|打算|计划|准备|参加|提交|完成|有没有|是否|去|做|这个|那个|这样|那样|到时候|成功|办法|方法|建议|这件事|那件事/gu,
      "",
    )
    .replace(
      /\b(?:i|we|you|will|try|it|that|this|tomorrow|today|next|week|morning|afternoon|evening|remind|ask|me|plan|to|do|have|is|my|the|a)\b/giu,
      "",
    )
    .replace(/[^\p{L}]/gu, "");
  return remaining.length >= 2;
}

function supportsSubject(
  text: string,
  subject: FollowUpSubjectTypeLike,
  role: FollowUpEvidenceMessage["role"],
): boolean {
  if (
    !REMINDER.test(text) &&
    /[?？]|吗(?:[。!！]|$)|我觉得|我猜|我估计|\bi\s+(?:think|guess|wonder)\b/iu.test(
      text,
    )
  )
    return false;
  if (
    role === "user" &&
    /(?:不要|不用|别|不必|无需)(?:再)?(?:提醒|问|跟进)|取消.{0,5}(?:提醒|跟进)|don'?t (?:ask|remind)|do not (?:ask|remind)/iu.test(
      text,
    )
  )
    return false;
  const statement = text.split(/[，,]/u)[0]!.trim();
  if (
    !REMINDER.test(text) &&
    /(?<!有)没(?:有|打算|准备|去|做|参加)|不(?:去|做|参加|试)|\b(?:not|no|isn't|aren't|don't|doesn't)\b/iu.test(
      statement,
    )
  )
    return false;
  const ownerText = statement.replace(
    /^(?:明天|明日|后天|今天|今日|下周)(?:上午|下午|早上|晚上)?/u,
    "",
  );
  if (
    /^(?:我(?:的)?)?(?:朋友|同事|姐姐|妹妹|哥哥|弟弟|爸爸|妈妈|他|她)|^(?:my\s+)?(?:friend|colleague|sister|brother|mother|father|partner)\b/iu.test(
      ownerText,
    )
  )
    return false;
  if (subject === "character_commitment")
    return role === "assistant" && characterCommitment(text);
  if (subject === "shared_commitment")
    return (
      SHARED.test(text) &&
      (role === "assistant" ? characterCommitment(text) : USER_PLAN.test(text))
    );
  if (REMINDER.test(text)) return role === "user";
  if (
    /请|帮我|我想知道|要不要|该不该|能不能|是否该|如何|怎么|怎样|\b(?:please|help|should|could|would|how|why|what|whether)\b/iu.test(
      statement,
    )
  )
    return false;
  return (
    role === "user" &&
    (USER_PLAN.test(statement) ||
      USER_EVENT.test(statement) ||
      (TIMING.test(statement) &&
        /(?:我|我们)?(?:明天|明日|后天|今天).{0,5}(?:答辩|面试|考试|复诊|开会)|\b(?:my|the)\b.{1,60}\bis\b/iu.test(
          statement,
        )))
  );
}

function characterCommitment(text: string): boolean {
  const ownClause = text
    .replace(/^(?:好的?|行|嗯|没问题|可以)[，,]\s*/u, "")
    .split(/[，,]/u)[0]!
    .replace(
      /明天|明日|后天|今天|今日|下周|上午|下午|中午|晚上|早上|\d{1,2}[:：点]\d{0,2}/gu,
      "",
    )
    .trim();
  if (/[?？]|(?:打算|计划|准备)(?:你|他|她)|我觉得|我认为/iu.test(ownClause))
    return false;
  return (
    /^(?:我|我们)(?:也|就)?(?:会|打算|计划|准备)/u.test(ownClause) ||
    /^(?:tomorrow\s+)?(?:i|we)(?:'ll|\s+will|\s+promise|\s+plan\s+to)\b/iu.test(
      ownClause,
    )
  );
}

function meaningfulOverlap(left: string, right: string): boolean {
  const normalize = (text: string): string =>
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const a = normalize(left);
  const b = normalize(right);
  return b.length >= 2 && (a.includes(b) || b.includes(a));
}

function reject(
  reasonCode: FollowUpGroundingRejectionCode,
  reasonSummary: string,
): FollowUpGroundingResult {
  return { accepted: false, rejection: { reasonCode, reasonSummary } };
}
