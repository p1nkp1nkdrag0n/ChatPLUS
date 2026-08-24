import {
  classifyNonAuthoritativeUserFactSource,
  isAuthoritativeUserFactSource,
  isCorrectionShapedUserFactSource,
  recallExactIdentifiers,
} from "@personasim/features";

export type MemoryEpistemicStatus =
  | "asserted_fact"
  | "hypothetical"
  | "quoted_third_party"
  | "negated"
  | "retracted"
  | "ordinary_dialogue";

const USER_FACT_RECALL_SIGNAL_PATTERN =
  /(?:(?:请|麻烦|能否|可以).{0,12}(?:说出|告诉|回答|确认)|(?:说出|告诉我|回答我)|(?:是什么|是谁|什么关系|哪里|哪儿|(?:放|在)哪(?:里|儿)?|位置|还在吗|是不是.{0,12}(?:放|住)在|是否.{0,12}(?:放|住|仍?在)|多少|哪一个|哪件)|(?:还?记得).{0,8}(?:吗|什么|哪里|哪儿))/u;
const USER_FACT_RECALL_SEGMENT_BOUNDARY = /[，,、。！？!?；;\n]+/u;
const USER_FACT_ADVICE_PATTERN =
  /(?:怎么办|怎么(?:做|处理|准备|缓解|冷静|推进|继续)|如何(?:做|处理|准备|缓解|冷静|推进|继续)|建议|步骤|方法|安慰|回应.{0,8}感受)/u;
const EXPLICIT_USER_HISTORY_PATTERN =
  /(?:我(?:刚才|之前|前面).{0,12}(?:说|提(?:到)?|告诉)|我说过|你还?记得我)/u;
const EXPLICIT_USER_FACT_TARGET_PATTERN =
  /(?:关于我的(?:偏好|生日|地址|住址|代号|编号|习惯)|我的(?:准确|当前|真实)?偏好|我(?:现在)?对.{1,24}的(?:准确|当前|真实)?偏好|[\p{Script=Han}]{2,8}和我的关系)/u;
const ENGLISH_EXPLICIT_USER_HISTORY_PATTERN =
  /\b(?:what|where|when|who)\s+did\s+i\s+(?:say|tell|mention)\b|\bwhere\s+did\s+i\s+(?:say\s+i\s+)?(?:put|keep|store)\b|\bdo\s+you\s+(?:still\s+)?remember\b.{0,48}\b(?:i|me|my)\b|\bwhat\s+(?:is|was)\s+my\b.{0,48}\b(?:preference|birthday|address|name|code|habit)\b/iu;
const EXTERNAL_FACT_OWNER_PATTERN =
  /(?:你认识的|你的|你那边的|你提到的)|\b(?:your|you\s+mentioned)\b/iu;
const BARE_IDENTIFIER_QUERY_PATTERN =
  /^(?:(?:那|那么|再确认(?:一次)?|请问|请(?:告诉我|帮我确认)?|麻烦(?:告诉我|确认)?)[：:，,\s]*)*(?:代号|编号)?\s*[A-Za-z0-9][A-Za-z0-9_.:/-]{2,80}\s*(?:(?:是|指(?:的)?是?|代表(?:的)?是?)?什么|(?:放|存|收|搁)(?:在)?哪(?:里|儿)?(?:一层|个位置)?(?:来着)?|在(?:哪(?:里|儿)?|什么位置)|(?:的)?(?:存放)?位置(?:(?:在)?哪(?:里|儿)?|是什么|是哪里)?|(?:还|仍然)在(?:哪(?:里|儿)?|.{1,24})?吗|(?:是不是|是否)(?:还|仍然)?(?:被)?(?:放|存|收|搁|住)?在.{1,32}|(?:放|存|收|搁|住)?在.{1,32}吗)\s*$/iu;
const BARE_ENGLISH_IDENTIFIER_QUERY_PATTERN =
  /^(?:please\s+)?(?:what\s+(?:is|was)\s+[A-Za-z0-9][A-Za-z0-9_.:/-]{2,80}|where\s+(?:is|was)\s+[A-Za-z0-9][A-Za-z0-9_.:/-]{2,80}|where\s+did\s+i\s+(?:put|keep|store)\s+[A-Za-z0-9][A-Za-z0-9_.:/-]{2,80}|is\s+[A-Za-z0-9][A-Za-z0-9_.:/-]{2,80}\s+(?:still\s+)?.+|what\s+is\s+the\s+(?:storage\s+)?location\s+of\s+[A-Za-z0-9][A-Za-z0-9_.:/-]{2,80})\s*$/iu;
const BARE_CJK_ENTITY_QUERY_PATTERN =
  /^(?:(?:那|那么|再(?:确认|问)(?:一次)?|请问|我想问(?:一下)?)[：:]?\s*)?([\p{Script=Han}]{2,6}?)(?:\s*是谁|\s*和我(?:是)?什么关系|\s*和我的关系是什么|(?:现在|目前)?\s*住(?:在)?\s*哪(?:里|儿)?|\s*(?:的)?位置(?:(?:在)?哪(?:里|儿)?|是什么|是哪里)?|\s*(?:还|仍然)在吗|\s*(?:现在|目前)?(?:还|仍然)?(?:住)?在.{1,24}吗|\s*(?:现在|目前)?(?:是不是|是否)(?:还|仍然)?(?:住)?在.{1,24})\s*$/u;

export interface UserFactRecallContext {
  knownUserMemoryContents?: readonly string[];
}

export function classifyMemoryEpistemicStatus(
  text: string,
): MemoryEpistemicStatus {
  const normalized = text.normalize("NFKC").trim();
  const guardedStatus = classifyNonAuthoritativeUserFactSource(normalized);
  if (guardedStatus !== undefined) return guardedStatus;
  if (isCorrectionShapedUserFactSource(normalized)) return "asserted_fact";
  if (/(?:^|[，。！？；\s])(?:我|我的|本人)/u.test(normalized)) {
    return "asserted_fact";
  }
  return "ordinary_dialogue";
}

export function memorySourceCanAuthorizeUserFact(input: {
  text: string;
  status?: unknown;
}): boolean {
  const status = isMemoryEpistemicStatus(input.status)
    ? input.status
    : classifyMemoryEpistemicStatus(input.text);
  return (
    status !== "hypothetical" &&
    status !== "quoted_third_party" &&
    status !== "negated" &&
    status !== "retracted" &&
    isAuthoritativeUserFactSource(input.text)
  );
}

export function isExplicitMemoryCorrection(text: string): boolean {
  return isCorrectionShapedUserFactSource(text);
}

export function isUserMemorySummaryRequest(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return /(?:说说|总结|概括).{0,24}(?:你.{0,8}(?:记得|了解|知道).{0,6}(?:我|关于我)|关于我的|我的事情)|(?:你.{0,8}(?:确定|确实).{0,6}记得.{0,8}(?:我|关于我))/u.test(
    normalized,
  );
}

export function isUserFactRecallRequest(
  text: string,
  context: UserFactRecallContext = {},
): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (isUserMemorySummaryRequest(normalized)) return true;
  if (ENGLISH_EXPLICIT_USER_HISTORY_PATTERN.test(normalized)) return true;

  const segments = normalized
    .split(USER_FACT_RECALL_SEGMENT_BOUNDARY)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.some(isExplicitUserFactRecallSegment)) return true;

  const knownContents = (context.knownUserMemoryContents ?? [])
    .map((content) => content.normalize("NFKC").trim())
    .filter(Boolean);
  if (knownContents.length === 0) return false;
  const knownIdentifiers = new Set(
    knownContents.flatMap((content) => recallExactIdentifiers(content)),
  );
  for (const segment of segments) {
    if (EXTERNAL_FACT_OWNER_PATTERN.test(segment)) continue;
    const queryIdentifiers = recallExactIdentifiers(segment);
    if (
      queryIdentifiers.some((identifier) => knownIdentifiers.has(identifier)) &&
      (BARE_IDENTIFIER_QUERY_PATTERN.test(segment) ||
        BARE_ENGLISH_IDENTIFIER_QUERY_PATTERN.test(segment))
    ) {
      return true;
    }
    const entity = BARE_CJK_ENTITY_QUERY_PATTERN.exec(segment)?.[1];
    if (
      entity !== undefined &&
      knownContents.some((content) => content.includes(entity))
    ) {
      return true;
    }
  }
  return false;
}

function isExplicitUserFactRecallSegment(segment: string): boolean {
  if (!USER_FACT_RECALL_SIGNAL_PATTERN.test(segment)) return false;
  const factTarget = EXPLICIT_USER_FACT_TARGET_PATTERN.test(segment);
  if (factTarget) return !USER_FACT_ADVICE_PATTERN.test(segment);
  return (
    EXPLICIT_USER_HISTORY_PATTERN.test(segment) &&
    !USER_FACT_ADVICE_PATTERN.test(segment)
  );
}

export function isMemoryEpistemicStatus(
  value: unknown,
): value is MemoryEpistemicStatus {
  return (
    value === "asserted_fact" ||
    value === "hypothetical" ||
    value === "quoted_third_party" ||
    value === "negated" ||
    value === "retracted" ||
    value === "ordinary_dialogue"
  );
}
