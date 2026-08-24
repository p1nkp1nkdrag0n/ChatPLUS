export interface EvidenceOnlyGroundingSource {
  readonly memoryContent: string;
  readonly evidenceQuote?: string;
}

export interface EvidenceOnlyClauseGroundingAudit {
  readonly clause: string;
  readonly kind: "meta" | "grounded" | "unsupported";
  readonly matchedSourceIndex: number | null;
  readonly matchedTokens: readonly string[];
  readonly unsupportedTokens: readonly string[];
}

export interface EvidenceOnlyTextGroundingAudit {
  readonly passed: boolean;
  readonly groundedClaimCount: number;
  readonly unsupportedClauses: readonly string[];
  readonly clauses: readonly EvidenceOnlyClauseGroundingAudit[];
}

export interface DirectUserFactAuthoritativeFact {
  readonly kind:
    | "schedule"
    | "memory"
    | "state"
    | "relationship"
    | "continuity"
    | "activity";
  readonly text: string;
}

export type NonAuthoritativeUserFactSourceStatus =
  "hypothetical" | "quoted_third_party" | "negated" | "retracted";

export interface ActiveCorrectionStatementProjection {
  readonly text: string;
  readonly evidenceQuote: string;
  readonly kind: "accuracy_marker" | "direct_contrast";
}

const USER_FACT_HYPOTHETICAL_SOURCE_PATTERN =
  /(?:^|[，,。！？!?；;：:\s])(?:假设|假定|假如|假若|假想(?:一下)?|试想(?:一下)?|想象(?:一下)?|设想|(?:我|本人)?(?:如果|要是|万一|倘若)|打个比方|举个例子|比如说)|(?:这里只是|这只是|只是|以上纯属).{0,12}(?:举例|假设)|\b(?:hypothetically|assume|assuming|suppose|supposing|imagine|for\s+example|if)\b|\b(?:this|that)\s+(?:is|was)\s+(?:a\s+)?hypothetical(?:\s+(?:scenario|example))?\b/iu;
const USER_FACT_RETRACTION_SOURCE_PATTERN =
  /(?:撤回|收回|撤销|作废).{0,24}(?:刚才|前面|说法|内容|要求)?|(?:刚才|前面).{0,24}(?:只是举例|不要.{0,12}记成|不算(?:事实|数))|(?:忽略|无视).{0,12}(?:真实|实际).{0,12}(?:日程|记录)|\b(?:i\s+(?:retract|withdraw)\s+(?:that|this|it)|i\s+take\s+(?:that|this|it)\s+back|(?:forget|disregard|ignore)\s+(?:that|this|the\s+(?:previous|preceding)\s+(?:statement|message)))\b/iu;
const CURRENT_ITEM_MEMORY_OPT_OUT_PATTERN =
  /(?:(?:这条|这件事|这段|这句话|这个内容|以上内容|上述内容).{0,8}(?:不要|别|不用|无需).{0,8}(?:记录|记下(?:来)?|记住|存储|保存|留存|写入(?:长期)?记忆)|(?:不要|别|不用|无需)(?:再)?(?:把|将)?(?:这条|这件事|这段|这句话|这个内容|以上内容|上述内容).{0,8}(?:记录|记下(?:来)?|记住|存储|保存|留存|写入(?:长期)?记忆)|(?:不要|别|不用|无需)(?:再)?(?:记录|记下(?:来)?|记住|存储|保存|留存|写入(?:长期)?记忆).{0,8}(?:这条|这件事|这段|这句话|这个内容|以上内容|上述内容)|\b(?:do\s+not|don't)\s+(?:remember|record|store|save)\s+(?:this|that|it)\b)/iu;
const USER_FACT_EPISTEMIC_NEGATION_PATTERN =
  /(?:(?:这|那|此)?(?:并)?不是真的|(?:这|那|此)?并非真的|(?:这|那|此)?不是事实|(?:并)?不是真实(?:的|事实|情况|内容|陈述|说法|宠物)?|并非真实(?:的|事实|情况|内容|陈述|说法)?|(?:这件事|此事)?(?:并)?没(?:有)?发生(?:过)?|从未发生过|并没有这回事|不是我说的)|\b(?:(?:this|that|it)(?:\s+(?:is|was)\s+not|['’]s\s+not|\s+(?:isn|wasn)['’]t)\s+(?:true|real|a\s+real\s+fact)|(?:this|that|it)\s+never\s+happened|i\s+(?:did\s+not|didn't)\s+say\s+(?:this|that))\b/iu;
const THIRD_PARTY_VIEW_DISCLAIMER_PATTERN =
  /(?:这(?:其实)?是|那(?:其实)?是|以上是).{0,24}(?:(?:的偏好|的说法|的观点).{0,12}(?:不是|并非)我的|(?:不是|并非)我的.{0,12}(?:偏好|说法|观点))|\b(?:this|that)\s+(?:is|was)\s+(?:his|her|their)\s+(?:preference|statement|view|opinion),?\s+not\s+mine\b/iu;
const ENGLISH_THIRD_PARTY_ATTRIBUTION_PATTERN =
  /\b(?:(?:he|she|they|someone|somebody)|my\s+(?:friend|colleague|classmate|roommate|partner|parent|mother|father|sister|brother))\s+(?:said|says|told\s+me|wrote|mentioned|texted\s+me)\b/iu;
const ENGLISH_NAMED_SPEAKER_ATTRIBUTION_PATTERN =
  /\b(?!We\b)[A-Z][a-z]{1,30}\s+(?:said|says|told\s+me|wrote|mentioned|texted\s+me)\b/u;
const THIRD_PARTY_PRONOUN_ATTRIBUTION_PATTERN =
  /(?:^|[，,。！？!?；;：:\s“”"'‘’])(?:他|她|他们|她们|别人|有人)(?:曾经|之前|此前|先前|刚才)?(?:说(?:过)?|表示(?:过)?|告诉(?:过)?(?:我|你|他|她|我们|你们|他们|大家)?)(?=$|[，,。！？!?；;：:\s“”"'‘’])/u;
const THIRD_PARTY_RELATION_ATTRIBUTION_PATTERN =
  /(?:^|[，,。！？!?；;：:\s“”"'‘’])(?:(?:我|本人)(?:的)?)?(?:朋友|同事|(?:大学|高中|小学)?同学|室友|家人|亲戚|伴侣|对象|丈夫|妻子|男友|女友|父亲|母亲|爸爸|妈妈|哥哥|姐姐|弟弟|妹妹|老师|学生|老板|领导|医生|邻居)(?:[\p{Script=Han}]{1,4})?(?:曾经|之前|此前|先前|刚才)?(?:说(?:过)?|表示(?:过)?|告诉(?:过)?(?:我|你|他|她|我们|你们|他们|大家)?)(?=$|[，,。！？!?；;：:\s“”"'‘’])/u;
const GENERIC_HAN_SPEAKER_ATTRIBUTION_PATTERN =
  /(?:^|[，,。！？!?；;：:\s“”"'‘’])([\p{Script=Han}]{2,4}?)(?:曾经|之前|此前|先前|刚才)?(?:说(?:过)?|表示(?:过)?|告诉(?:过)?(?:我|你|他|她|我们|你们|他们|大家)?)(?=$|[，,。！？!?；;：:\s“”"'‘’])/gu;
const GENERIC_REPORTED_SOURCE_ATTRIBUTION_PATTERN =
  /(?:据|根据|按)([\p{Script=Han}]{1,8}?)(?:的)?(?:说法|观点|表述|陈述|所说|所讲|说|讲|表示|告知|转述)(?=$|[，,。！？!?；;：:\s“”"'‘’])|(?:转述(?:自)?|转引)([\p{Script=Han}]{1,8}?)(?:的)?(?:说法|话|所说)?(?=$|[，,。！？!?；;：:\s“”"'‘’])/gu;
const COPULAR_HAN_SPEAKER_ATTRIBUTION_PATTERN =
  /(?:这句话是|此话是|以上(?:内容|说法)?是|这是|那是)([\p{Script=Han}]{1,8}?)(?:曾经|之前|此前|先前|刚才)?(?:说(?:过)?|表示(?:过)?|告诉(?:过)?(?:我|你|他|她|我们|你们|他们|大家)?|讲(?:过)?)(?:的)?(?=$|[，,。！？!?；;：:\s“”"'‘’])/gu;
const LISTENED_HAN_SPEAKER_ATTRIBUTION_PATTERN =
  /(?:^|[，,。！？!?；;：:\s“”"'‘’])听([\p{Script=Han}]{1,8}?)(?:曾经|之前|此前|先前|刚才)?(?:说|讲|提到)(?:过)?(?:的)?(?=$|[，,。！？!?；;：:\s“”"'‘’])/gu;
const GENERIC_INFORMATION_SOURCE_PATTERN =
  /(?:信息|消息|内容|说法|这句话|此话|以上(?:内容|说法)?)(?:的)?来源(?:是|为|来自)([\p{Script=Han}]{1,8})(?=$|[，,。！？!?；;：:\s“”"'‘’])/gu;
const NON_SPEAKER_DISCOURSE_SUBJECTS = new Set([
  "前面",
  "之前",
  "此前",
  "先前",
  "刚才",
  "原先",
  "早先",
  "上次",
  "前文",
  "上文",
  "具体",
  "简单",
  "严格",
  "准确",
  "确切",
  "客观",
  "总体",
  "通俗",
  "概括",
  "简要",
  "坦白",
  "老实",
  "实话",
  "换句话",
]);
const EXPLICIT_CORRECTION_CUE_SOURCE = String.raw`(?:我|本人)(?:要|想|来)?(?:纠正|更正|修正|改口)(?:一下)?`;
const EXPLICIT_CORRECTION_CUE_PATTERN = new RegExp(
  String.raw`(?:^|[，,。！？!?；;：:\s“”"'‘’])${EXPLICIT_CORRECTION_CUE_SOURCE}`,
  "u",
);
const LEADING_EXPLICIT_CORRECTION_CUE_PATTERN = new RegExp(
  `^${EXPLICIT_CORRECTION_CUE_SOURCE}`,
  "u",
);
const ACTIVE_CORRECTION_MARKER_SOURCE = String.raw`(?:(?:准确|正确|更准确|更正确)(?:的)?说法(?:是|为)|(?:更准确|更正确)地说(?:是|为)?)`;
const ACTIVE_CORRECTION_MARKER_PATTERN = new RegExp(
  ACTIVE_CORRECTION_MARKER_SOURCE,
  "gu",
);
const CORRECTION_SHAPED_SOURCE_PATTERN = new RegExp(
  `${ACTIVE_CORRECTION_MARKER_SOURCE}|前面.{0,20}(?:太绝对|说错|不准确)`,
  "u",
);
const DIRECT_CONTRAST_CORRECTION_PATTERN =
  /^(?<entity>[\p{L}\p{N}][\p{L}\p{N}_.·-]{0,23}?)不是(?<superseded>[^，,。！？!?；;\n]{1,60})[，,]\s*(?:而)?是(?<replacement>[^，,。！？!?；;\n]{1,60})(?:[。；;]\s*|$)(?<remainder>[\s\S]*)$/u;
const UNCHANGED_FACT_SUFFIX_PATTERN =
  /(?:(?:这件事|这一点|这点|这个事实|此事))?(?:一直|仍然|还是)?(?:没变|没有变化|不变)$/u;
const DIRECT_UNCHANGED_AFFIRMATIVE_FACT_PATTERN =
  /^(?<subject>[\p{Script=Han}]{2,6}|他|她|其)(?<predicate>(?:(?:最近|刚刚?|已经|已|目前|现在|仍然|仍|还)?(?:搬到|搬去|住在|来自|毕业于|出生于)[^，,。！？!?；;\n]{1,40}))$/u;
const NEGATIVE_REPLACEMENT_PATTERN =
  /^(?:(?:我|本人)(?:并)?(?:不|没|未|无)|(?:并)?(?:不|没|未|无)|从不)/u;
const DIRECT_CONTRAST_ENTITY_PATTERN = /^[\p{Script=Han}]{2,6}$/u;
const USER_RELATION_LABEL_SOURCE = String.raw`(?:大学同学|高中同学|中学同学|小学同学|同学|朋友|同事|室友|老师|学生|老板|领导|邻居|伴侣|男友|女友|丈夫|妻子|亲戚|家人)`;
const FIRST_PERSON_RELATION_PREDICATE_PATTERN = new RegExp(
  String.raw`^(?:我|本人)(?:的)?${USER_RELATION_LABEL_SOURCE}$`,
  "u",
);
const USER_OWNED_RELATION_THEN_ENTITY_PATTERN = new RegExp(
  String.raw`(?:^|[，,。！？!?；;：:\s])(?:我|本人|用户)(?:的)?(?:有(?:一(?:位|个))?)?(${USER_RELATION_LABEL_SOURCE})(?:叫|是)?([\p{Script=Han}]{2,8})(?=最近|刚刚?|已经|已|现在|目前|住|搬|[，,。！？!?；;：:\s]|$)`,
  "gu",
);
const ENTITY_THEN_USER_OWNED_RELATION_PATTERN = new RegExp(
  String.raw`(?:^|[，,。！？!?；;：:\s])([\p{Script=Han}]{2,8})(?:是|就是)(?:我|本人|用户)(?:的)?(${USER_RELATION_LABEL_SOURCE})(?=[，,。！？!?；;：:\s]|$)`,
  "gu",
);
const USER_AND_ENTITY_RELATION_PATTERN = new RegExp(
  String.raw`(?:^|[，,。！？!?；;：:\s])(?:我|本人|用户)(?:跟|和|与)([\p{Script=Han}]{2,8})(?:是|算是|就是)(${USER_RELATION_LABEL_SOURCE})(?=[，,。！？!?；;：:\s]|$)`,
  "gu",
);
const ENTITY_AND_USER_RELATION_PATTERN = new RegExp(
  String.raw`(?:^|[，,。！？!?；;：:\s])([\p{Script=Han}]{2,8})(?:跟|和|与)(?:我|本人|用户)(?:是|算是|就是)(${USER_RELATION_LABEL_SOURCE})(?=[，,。！？!?；;：:\s]|$)`,
  "gu",
);

function hasThirdPartyAttribution(value: string): boolean {
  if (
    THIRD_PARTY_VIEW_DISCLAIMER_PATTERN.test(value) ||
    ENGLISH_THIRD_PARTY_ATTRIBUTION_PATTERN.test(value) ||
    ENGLISH_NAMED_SPEAKER_ATTRIBUTION_PATTERN.test(value) ||
    THIRD_PARTY_PRONOUN_ATTRIBUTION_PATTERN.test(value) ||
    THIRD_PARTY_RELATION_ATTRIBUTION_PATTERN.test(value)
  ) {
    return true;
  }
  for (const match of value.matchAll(GENERIC_HAN_SPEAKER_ATTRIBUTION_PATTERN)) {
    const speaker = match[1];
    if (speaker !== undefined && isThirdPartySpeaker(speaker)) return true;
  }
  for (const match of value.matchAll(
    GENERIC_REPORTED_SOURCE_ATTRIBUTION_PATTERN,
  )) {
    const speaker = match[1] ?? match[2];
    if (speaker !== undefined && isThirdPartySpeaker(speaker)) return true;
  }
  for (const pattern of [
    COPULAR_HAN_SPEAKER_ATTRIBUTION_PATTERN,
    LISTENED_HAN_SPEAKER_ATTRIBUTION_PATTERN,
    GENERIC_INFORMATION_SOURCE_PATTERN,
  ]) {
    for (const match of value.matchAll(pattern)) {
      const speaker = match[1];
      if (speaker !== undefined && isThirdPartySpeaker(speaker)) return true;
    }
  }
  return false;
}

function isThirdPartySpeaker(speaker: string): boolean {
  return (
    !/^(?:(?:我|本人)(?:自己|之前|此前|先前|刚才|前面|原先|早先|上次)?|我们|咱们)$/u.test(
      speaker,
    ) &&
    !/(?:听我|问我|让我|跟我|对我|向我)$/u.test(speaker) &&
    !speaker.endsWith("来") &&
    !NON_SPEAKER_DISCOURSE_SUBJECTS.has(speaker)
  );
}

export function classifyNonAuthoritativeUserFactSource(
  value: string,
): NonAuthoritativeUserFactSourceStatus | undefined {
  return classifyNonAuthoritativeUserFactSourceStatuses(value)[0];
}

/**
 * Returns every independently observed non-authoritative source signal.
 * Consumers that intentionally permit one narrow frame (for example, a
 * conditional care directive) must still fail closed when the same text also
 * contains a retraction, third-party attribution, or epistemic negation.
 */
export function classifyNonAuthoritativeUserFactSourceStatuses(
  value: string,
): readonly NonAuthoritativeUserFactSourceStatus[] {
  const source = value.normalize("NFKC").trim();
  const statuses: NonAuthoritativeUserFactSourceStatus[] = [];
  if (
    USER_FACT_RETRACTION_SOURCE_PATTERN.test(source) ||
    CURRENT_ITEM_MEMORY_OPT_OUT_PATTERN.test(source)
  ) {
    statuses.push("retracted");
  }
  if (USER_FACT_HYPOTHETICAL_SOURCE_PATTERN.test(source)) {
    statuses.push("hypothetical");
  }
  if (hasThirdPartyAttribution(source)) statuses.push("quoted_third_party");
  if (USER_FACT_EPISTEMIC_NEGATION_PATTERN.test(source)) {
    statuses.push("negated");
  }
  return statuses;
}

export function isExplicitCorrectionCue(value: string): boolean {
  return EXPLICIT_CORRECTION_CUE_PATTERN.test(value.normalize("NFKC"));
}

export function isCorrectionShapedUserFactSource(value: string): boolean {
  const source = value.normalize("NFKC");
  return (
    isExplicitCorrectionCue(source) ||
    CORRECTION_SHAPED_SOURCE_PATTERN.test(source)
  );
}

export function isAuthoritativeEvidenceOnlyQuote(value: string): boolean {
  const quote = value.normalize("NFKC").trim();
  return (
    quote !== "" && classifyNonAuthoritativeUserFactSource(quote) === undefined
  );
}

/**
 * Closed-world grounding for evidence-only answers. Every factual clause must
 * be expressible using the semantic tokens of one selected evidence item.
 * This is intentionally stricter than checking for one or two shared anchors:
 * a grounded identifier cannot license an unrelated claim appended beside it.
 */
export function auditEvidenceOnlyTextGrounding(input: {
  readonly text: string;
  readonly sources: readonly EvidenceOnlyGroundingSource[];
  readonly requireGroundedClaim?: boolean;
}): EvidenceOnlyTextGroundingAudit {
  return auditGroundedReplyText({
    text: input.text,
    sources: input.sources,
    ...(input.requireGroundedClaim === undefined
      ? {}
      : { requireGroundedClaim: input.requireGroundedClaim }),
    isMetaClause: isEvidenceOnlyMetaClause,
    stripMetaPrefix: stripEvidenceOnlyMetaPrefix,
  });
}

/**
 * Closed-world grounding for a direct user-fact answer. Unlike a final
 * evidence-only summary, a direct answer may share a reply with facts that
 * were independently validated by the authoritative turn outcome. It may
 * also contain clearly non-factual care or guidance. Every other declarative
 * clause still has to be licensed by one selected memory item or one explicit
 * authoritative fact; a grounded recall anchor therefore cannot license an
 * appended user fact.
 */
export function auditDirectUserFactTextGrounding(input: {
  readonly text: string;
  readonly memorySources: readonly EvidenceOnlyGroundingSource[];
  readonly authoritativeFacts: readonly DirectUserFactAuthoritativeFact[];
  readonly requireGroundedMemoryClaim?: boolean;
  readonly userMessage?: string;
}): EvidenceOnlyTextGroundingAudit {
  const authoritativeSources = input.authoritativeFacts
    .map((fact) => ({ ...fact, text: fact.text.trim() }))
    .filter((fact) => fact.text !== "")
    .map((fact) => ({ memoryContent: fact.text }));
  const grounding = auditGroundedReplyText({
    text: input.text,
    sources: [...input.memorySources, ...authoritativeSources],
    isMetaClause: (clause) =>
      isEvidenceOnlyMetaClause(clause) || isDirectReplyNonFactualClause(clause),
    stripMetaPrefix: stripDirectReplyMetaPrefix,
    ...(input.requireGroundedMemoryClaim === true
      ? {
          requiredGroundedSourceCount: input.memorySources.length,
          ...(input.userMessage === undefined
            ? {}
            : { requiredGroundedSourceQuery: input.userMessage }),
        }
      : {}),
  });
  const ownershipSources = [
    ...input.memorySources,
    ...input.authoritativeFacts
      .filter((fact) => fact.kind === "memory")
      .map((fact) => ({ memoryContent: fact.text })),
  ];
  const ownershipReversals = assistantOwnedUserRelationClauses(
    input.text,
    ownershipSources,
  );
  if (ownershipReversals.length === 0) return grounding;

  const reversalClauses = new Set(ownershipReversals);
  const clauses = grounding.clauses.map((clause) =>
    reversalClauses.has(clause.clause)
      ? {
          ...clause,
          kind: "unsupported" as const,
          matchedSourceIndex: null,
          unsupportedTokens: [
            ...new Set([...clause.unsupportedTokens, "relation_owner"]),
          ],
        }
      : clause,
  );
  return {
    passed: false,
    groundedClaimCount: clauses.filter((clause) => clause.kind === "grounded")
      .length,
    unsupportedClauses: [
      ...new Set([...grounding.unsupportedClauses, ...ownershipReversals]),
    ],
    clauses,
  };
}

interface UserOwnedNamedRelation {
  readonly entity: string;
  readonly relation: string;
}

/**
 * User-model evidence keeps the user's original first-person wording. A reply
 * must project that owner to second person instead of adopting the relation as
 * the character's own biography. Quoted spans are removed before this check so
 * repeating the user's exact words remains possible.
 */
function assistantOwnedUserRelationClauses(
  text: string,
  sources: readonly EvidenceOnlyGroundingSource[],
): string[] {
  const relations = uniqueUserOwnedNamedRelations(sources);
  if (relations.length === 0) return [];
  const unquotedText = stripQuotedSpans(text.normalize("NFKC"));
  const reversedRelations = new Set(
    relations
      .filter((relation) =>
        assistantClaimsRelationOwnership(unquotedText, relation),
      )
      .map((relation) => relation.relation),
  );
  if (reversedRelations.size === 0) return [];

  const unsupported = splitEvidenceOnlyClauses(unquotedText).filter((clause) =>
    [...reversedRelations].some((relation) =>
      clauseClaimsAssistantRelationOwnership(clause, relation),
    ),
  );
  return unsupported.length > 0 ? unsupported : [text.trim()];
}

function uniqueUserOwnedNamedRelations(
  sources: readonly EvidenceOnlyGroundingSource[],
): UserOwnedNamedRelation[] {
  const unique = new Map<string, UserOwnedNamedRelation>();
  for (const source of sources) {
    for (const raw of [source.memoryContent, source.evidenceQuote]) {
      if (raw === undefined) continue;
      const projected = authoritativeUserFactSourceProjection(raw);
      if (projected === undefined) continue;
      for (const relation of extractUserOwnedNamedRelations(projected)) {
        unique.set(`${relation.entity}\u0000${relation.relation}`, relation);
      }
    }
  }
  return [...unique.values()];
}

function extractUserOwnedNamedRelations(
  value: string,
): UserOwnedNamedRelation[] {
  const relations: UserOwnedNamedRelation[] = [];
  for (const match of value.matchAll(USER_OWNED_RELATION_THEN_ENTITY_PATTERN)) {
    const relation = match[1];
    const entity = match[2];
    if (entity !== undefined && relation !== undefined) {
      relations.push({ entity, relation });
    }
  }
  for (const pattern of [
    ENTITY_THEN_USER_OWNED_RELATION_PATTERN,
    USER_AND_ENTITY_RELATION_PATTERN,
    ENTITY_AND_USER_RELATION_PATTERN,
  ]) {
    for (const match of value.matchAll(pattern)) {
      const entity = match[1];
      const relation = match[2];
      if (entity !== undefined && relation !== undefined) {
        relations.push({ entity, relation });
      }
    }
  }
  return relations;
}

function assistantClaimsRelationOwnership(
  text: string,
  relation: UserOwnedNamedRelation,
): boolean {
  const entity = escapeRegExp(relation.entity);
  const label = escapeRegExp(relation.relation);
  return [
    new RegExp(
      `${entity}(?:啊|呀|呢|是|就是|算是|，|,|\\s){0,4}我(?:的)?${label}`,
      "u",
    ),
    new RegExp(`我(?:的)?${label}(?:叫|是|就是)?${entity}`, "u"),
    new RegExp(`${entity}(?:跟|和|与)我(?:是|算是|就是)${label}`, "u"),
    new RegExp(`我(?:跟|和|与)${entity}(?:是|算是|就是)${label}`, "u"),
  ].some((pattern) => pattern.test(text));
}

function clauseClaimsAssistantRelationOwnership(
  clause: string,
  relation: string,
): boolean {
  const label = escapeRegExp(relation);
  return (
    new RegExp(`我(?:的)?${label}`, "u").test(clause) ||
    new RegExp(`(?:跟|和|与)我(?:是|算是|就是)${label}`, "u").test(clause) ||
    new RegExp(`我(?:跟|和|与).{1,8}(?:是|算是|就是)${label}`, "u").test(clause)
  );
}

function stripQuotedSpans(value: string): string {
  return value.replace(
    /“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|'[^'\n]*'/gu,
    (quoted) => " ".repeat(quoted.length),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function auditGroundedReplyText(input: {
  readonly text: string;
  readonly sources: readonly EvidenceOnlyGroundingSource[];
  readonly requireGroundedClaim?: boolean;
  readonly requiredGroundedSourceCount?: number;
  readonly requiredGroundedSourceQuery?: string;
  readonly isMetaClause: (clause: string) => boolean;
  readonly stripMetaPrefix: (clause: string) => string;
}): EvidenceOnlyTextGroundingAudit {
  const sources = input.sources.map(buildSourceAuthorization);
  const clauses = splitEvidenceOnlyClauses(input.text).map((clause) => {
    if (input.isMetaClause(clause)) {
      return {
        clause,
        kind: "meta" as const,
        matchedSourceIndex: null,
        matchedTokens: [],
        unsupportedTokens: [],
      };
    }
    const claim = input.stripMetaPrefix(clause);
    if (claim === "" || input.isMetaClause(claim)) {
      return {
        clause,
        kind: "meta" as const,
        matchedSourceIndex: null,
        matchedTokens: [],
        unsupportedTokens: [],
      };
    }
    const claimTokens = [...semanticTokens(claim)];
    const candidates = sources.map((source, sourceIndex) => ({
      sourceIndex,
      ...auditClaimAgainstSource(claim, claimTokens, source),
    }));
    const best = candidates.sort(
      (left, right) =>
        left.unsupportedTokens.length - right.unsupportedTokens.length ||
        right.matchedTokens.length - left.matchedTokens.length,
    )[0];
    const grounded =
      claimTokens.length > 0 && best !== undefined && best.grounded;
    return {
      clause,
      kind: grounded ? ("grounded" as const) : ("unsupported" as const),
      matchedSourceIndex: grounded ? best.sourceIndex : null,
      matchedTokens: best?.matchedTokens ?? [],
      unsupportedTokens:
        claimTokens.length === 0
          ? [normalizeEvidenceOnlyText(claim)]
          : (best?.unsupportedTokens ?? claimTokens),
    };
  });
  const groundedClaimCount = clauses.filter(
    (clause) => clause.kind === "grounded",
  ).length;
  const unsupportedClauses = clauses
    .filter((clause) => clause.kind === "unsupported")
    .map((clause) => clause.clause);
  const requiredGroundedSourceCount = input.requiredGroundedSourceCount;
  const passed =
    unsupportedClauses.length === 0 &&
    (input.requireGroundedClaim !== true || groundedClaimCount > 0) &&
    (requiredGroundedSourceCount === undefined ||
      clauses.some(
        (clause) =>
          clause.kind === "grounded" &&
          clause.matchedSourceIndex !== null &&
          clause.matchedSourceIndex < requiredGroundedSourceCount &&
          groundedMemoryClaimAnswersQuery(
            clause.matchedTokens,
            input.requiredGroundedSourceQuery,
          ),
      ));
  return { passed, groundedClaimCount, unsupportedClauses, clauses };
}

interface EvidenceSourceAuthorization {
  readonly contentSentences: readonly ReadonlySet<string>[];
  readonly contentNegativeClauses: readonly string[];
  readonly quoteSentences?: readonly ReadonlySet<string>[];
  readonly quoteNegativeClauses?: readonly string[];
}

function buildSourceAuthorization(
  source: EvidenceOnlyGroundingSource,
): EvidenceSourceAuthorization {
  const authorizedContent = authoritativeUserFactSourceProjection(
    source.memoryContent,
  );
  const contentSentences =
    authorizedContent === undefined
      ? []
      : evidenceSentenceTokens(authorizedContent);
  const contentNegativeClauses =
    authorizedContent === undefined
      ? []
      : negativeEvidenceClauses(authorizedContent);
  const quote = source.evidenceQuote?.trim();
  // Some production callers select an explicit memory record without a
  // source quote; in that case the selected memory is the sole authority.
  if (quote === undefined || quote === "") {
    return { contentSentences, contentNegativeClauses };
  }
  // A concrete quote is an independent epistemic boundary. It must be
  // authoritative, and every claim must be supported by both persisted
  // content and quote. Pollution on either side therefore grants no authority.
  const authorizedQuote = authoritativeUserFactSourceProjection(quote);
  if (authorizedQuote === undefined) {
    return {
      contentSentences,
      contentNegativeClauses,
      quoteSentences: [],
      quoteNegativeClauses: [],
    };
  }
  return {
    contentSentences,
    contentNegativeClauses,
    quoteSentences: evidenceSentenceTokens(authorizedQuote),
    quoteNegativeClauses: negativeEvidenceClauses(authorizedQuote),
  };
}

function authoritativeUserFactSourceProjection(
  value: string,
): string | undefined {
  const source = value.trim();
  if (!isAuthoritativeEvidenceOnlyQuote(source)) return undefined;
  const activeCorrection = projectActiveCorrectionStatement(source);
  if (activeCorrection !== undefined) return activeCorrection.text;
  return isCorrectionShapedUserFactSource(source) ? undefined : source;
}

/**
 * True only when the complete raw source can license a user fact. Correction-
 * shaped sources additionally need a safe, explicit active replacement.
 */
export function isAuthoritativeUserFactSource(value: string): boolean {
  return authoritativeUserFactSourceProjection(value) !== undefined;
}

/**
 * A correction source can quote a superseded proposition before stating the
 * replacement. Only the explicit replacement is authoritative for recall.
 * Accuracy markers authorize their exact active suffix. A marker-less source is
 * accepted only for a bounded "entity is not old, but is replacement" contrast;
 * that path projects away the superseded proposition.
 */
export function projectActiveCorrectionStatement(
  value: string,
): ActiveCorrectionStatementProjection | undefined {
  const text = value.trim();
  if (!isAuthoritativeEvidenceOnlyQuote(text)) return undefined;
  const leadingCue = LEADING_EXPLICIT_CORRECTION_CUE_PATTERN.exec(text);
  if (leadingCue === null) return undefined;
  const markers = [...text.matchAll(ACTIVE_CORRECTION_MARKER_PATTERN)];
  const marker = markers.at(-1);
  if (marker?.index !== undefined) {
    const statement = text
      .slice(marker.index + marker[0].length)
      .replace(/^[\s，,:：]+/u, "")
      .trim();
    return statement === ""
      ? undefined
      : { text: statement, evidenceQuote: statement, kind: "accuracy_marker" };
  }
  const body = text
    .slice(leadingCue[0].length)
    .replace(/^[\s，,:：。；;]+/u, "")
    .trim();
  const contrast = DIRECT_CONTRAST_CORRECTION_PATTERN.exec(body)?.groups;
  const entity = contrast?.["entity"]?.trim();
  const superseded = contrast?.["superseded"]?.trim();
  const replacement = contrast?.["replacement"]?.trim();
  if (
    entity === undefined ||
    superseded === undefined ||
    replacement === undefined ||
    !DIRECT_CONTRAST_ENTITY_PATTERN.test(entity) ||
    !FIRST_PERSON_RELATION_PREDICATE_PATTERN.test(superseded) ||
    !FIRST_PERSON_RELATION_PREDICATE_PATTERN.test(replacement) ||
    /(?:说|表示|告诉|听说|据说|认为)/u.test(entity) ||
    NEGATIVE_REPLACEMENT_PATTERN.test(replacement) ||
    normalizedCorrectionPredicate(superseded) ===
      normalizedCorrectionPredicate(replacement)
  ) {
    return undefined;
  }
  const affirmativeFacts = [`${entity}是${replacement}`];
  for (const clause of (contrast?.["remainder"] ?? "")
    .split(/[。！？!?；;\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean)) {
    if (!UNCHANGED_FACT_SUFFIX_PATTERN.test(clause)) return undefined;
    const fact = clause.replace(UNCHANGED_FACT_SUFFIX_PATTERN, "").trim();
    const preservedFact =
      DIRECT_UNCHANGED_AFFIRMATIVE_FACT_PATTERN.exec(fact)?.groups;
    const subject = preservedFact?.["subject"];
    if (
      fact === "" ||
      subject === undefined ||
      (subject !== entity && !/^(?:他|她|其)$/u.test(subject)) ||
      normalizedCorrectionPredicate(fact).includes(
        normalizedCorrectionPredicate(superseded),
      )
    ) {
      return undefined;
    }
    affirmativeFacts.push(fact);
  }
  return {
    text: `${affirmativeFacts.join("。")}。`,
    evidenceQuote: text,
    kind: "direct_contrast",
  };
}

export function extractActiveCorrectionStatement(
  value: string,
): string | undefined {
  return projectActiveCorrectionStatement(value)?.text;
}

function normalizedCorrectionPredicate(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s的]/gu, "")
    .replace(/^(?:我|本人|你|他|她)/u, "")
    .trim();
}

function auditClaimAgainstSource(
  claim: string,
  claimTokens: readonly string[],
  source: EvidenceSourceAuthorization,
): {
  readonly grounded: boolean;
  readonly matchedTokens: readonly string[];
  readonly unsupportedTokens: readonly string[];
} {
  const contentMatch = bestSentenceMatch(claimTokens, source.contentSentences);
  const quoteMatch =
    source.quoteSentences === undefined
      ? contentMatch
      : bestSentenceMatch(claimTokens, source.quoteSentences);
  const polarityConflict =
    !hasNegativePolarity(claim) &&
    [
      ...source.contentNegativeClauses,
      ...(source.quoteNegativeClauses ?? []),
    ].some((negativeClaim) =>
      negativeEvidenceConflictsWithClaim(negativeClaim, claimTokens),
    );
  const matchedTokens = claimTokens.filter(
    (token) => contentMatch.tokens.has(token) && quoteMatch.tokens.has(token),
  );
  const unsupportedTokens = polarityConflict
    ? [...claimTokens]
    : claimTokens.filter(
        (token) =>
          !contentMatch.tokens.has(token) || !quoteMatch.tokens.has(token),
      );
  return {
    grounded:
      claimTokens.length > 0 &&
      matchedTokens.length > 0 &&
      unsupportedTokens.length === 0,
    matchedTokens,
    unsupportedTokens,
  };
}

function evidenceSentenceTokens(text: string): ReadonlySet<string>[] {
  return text
    .normalize("NFKC")
    .split(/[。！？!?；;\n]+|(?<!\p{N})[:：]|[:：](?!\p{N})/gu)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .flatMap((sentence) => {
      const propositions = splitEvidenceOnlyClauses(sentence);
      const identifierTokens = semanticTokens(
        (sentence.match(DISTINCTIVE_IDENTIFIERS) ?? []).join(" "),
      );
      return propositions.map(
        (proposition) =>
          new Set([...semanticTokens(proposition), ...identifierTokens]),
      );
    });
}

function bestSentenceMatch(
  claimTokens: readonly string[],
  sentences: readonly ReadonlySet<string>[],
): { readonly tokens: ReadonlySet<string>; readonly unsupportedCount: number } {
  const candidates = sentences.map((tokens) => ({
    tokens,
    unsupportedCount: claimTokens.filter((token) => !tokens.has(token)).length,
  }));
  return (
    candidates.sort(
      (left, right) => left.unsupportedCount - right.unsupportedCount,
    )[0] ?? { tokens: new Set<string>(), unsupportedCount: claimTokens.length }
  );
}

function tokensContainClaim(
  evidenceTokens: ReadonlySet<string>,
  claimTokens: readonly string[],
): boolean {
  return (
    claimTokens.length > 0 &&
    claimTokens.every((token) => evidenceTokens.has(token))
  );
}

function negativeEvidenceConflictsWithClaim(
  negativeClaim: string,
  claimTokens: readonly string[],
): boolean {
  const evidenceTokens = semanticTokens(stripNegativePolarity(negativeClaim));
  return (
    tokensContainClaim(evidenceTokens, claimTokens) ||
    (evidenceTokens.size > 0 &&
      [...evidenceTokens].every((token) => claimTokens.includes(token)))
  );
}

function negativeEvidenceClauses(text: string): string[] {
  return splitEvidenceOnlyClauses(text).filter(hasNegativePolarity);
}

function hasNegativePolarity(value: string): boolean {
  return /(?:并非|不是|不能|无法|没有|从未|不再|不(?:喜欢|爱|吃|接受|能|会|是|在|有|要|属于|认识|养|住|搬|叫))/u.test(
    normalizeEvidenceOnlyText(value),
  );
}

function stripNegativePolarity(value: string): string {
  return normalizeEvidenceOnlyText(value).replace(
    /(?:并非|不是|不能|无法|没有|从未|不再|不(?=(?:喜欢|爱|吃|接受|能|会|是|在|有|要|属于|认识|养|住|搬|叫)))/gu,
    "",
  );
}

export function splitEvidenceOnlyClauses(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(
      /(?:而且|并且|同时|此外|另外|不过|但是|可是|然而|但|却|而(?=你|您)|(?<!证据)说明|(?<!证据)表明|(?<!不)意味着|(?<!证据)证明|可见|所以)/gu,
      (connector) => `。${connector}`,
    )
    .split(/[。！？!?；;，,\n]+|(?<!\p{N})[:：]|[:：](?!\p{N})/gu)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

export function isEvidenceOnlyMetaClause(clause: string): boolean {
  const text = clause.normalize("NFKC").trim();
  return (
    text === "" ||
    /^(?:嗯|好|好的|明白|对|没错|另外|此外|不过|但是|可是|然而|但|却|而|所以|除此之外|其余|其他|别的)$/u.test(
      text,
    ) ||
    /^(?:也)?(?:我)?(?:不知道|不确定|不记得|没记得|无法确认|不能确认|没有.{0,10}(?:证据|依据|记录)|不猜|不会猜|不能猜)/u.test(
      text,
    ) ||
    /^(?:除此之外|其余|其他|别的).{0,24}(?:不确定|不补充|不猜|没有.{0,8}(?:证据|依据|记录))/u.test(
      text,
    ) ||
    /^(?:这是目前有依据的关系|这是目前有依据的部分|以上是我能确认的部分|我只能确认这些|这个部分我确定|这才是目前有依据的部分|这些是我能确认的内容)$/u.test(
      text,
    ) ||
    /^(?:这|那)(?:才)?是(?:纠正|更正|修正)后(?:的)?(?:准确|正确)说法$/u.test(
      text,
    ) ||
    /^(?:我(?:确定|确实)?记得|根据你之前明确告诉我的|根据现有证据|准确说法是)$/u.test(
      text,
    )
  );
}

function isDirectReplyNonFactualClause(clause: string): boolean {
  const text = clause.normalize("NFKC").trim();
  if (text === "") return true;
  if (containsEmbeddedDurableUserFact(text)) return false;
  if (isDirectReplyQuestion(text)) return true;
  if (isDirectReplyGuidance(text)) return true;
  if (isDirectReplyCompanionship(text)) return true;
  return isTransientEmotionAcknowledgement(text);
}

function containsEmbeddedDurableUserFact(text: string): boolean {
  const assertion =
    /(?:你|您)(?:已经|已|其实|目前|现在|仍然|仍|还)?(?:是(?!否)|不是|有|没有|没|叫|结婚|已婚|未婚|住在|住到|搬到|来自|喜欢|不喜欢|毕业于|就读于|出生于|养(?:了|着)?)(?!不)/u;
  const possessiveAssertion =
    /[\p{Script=Han}a-z0-9_-]{1,24}是(?:你|您)(?:的)?[\p{Script=Han}a-z0-9_-]{1,24}/iu;
  if (/(?:不是吗|对吗|没错吧|是吧)[?？]?$/u.test(text)) {
    return assertion.test(text) || possessiveAssertion.test(text);
  }
  const frame = /(?:告诉|提醒|承认|解释|说明|写下|记下|说给|把|将)/u.exec(text);
  if (frame === null) return false;
  const embedded = text.slice(frame.index + frame[0].length);
  return assertion.test(embedded) || possessiveAssertion.test(embedded);
}

function isDirectReplyQuestion(text: string): boolean {
  return (
    /[?？]$/u.test(text) ||
    /(?:吗|么|呢|如何|怎么(?:样)?|为什么|哪里|哪(?:个|些|里|儿)|什么|谁)$/u.test(
      text,
    ) ||
    /^(?:要不要|需不需要|愿不愿意|想不想|能不能|可不可以|是否|是不是|有没有)/u.test(
      text,
    )
  );
}

function isDirectReplyGuidance(text: string): boolean {
  if (/^(?:你)?可以(?:接受|容忍|适应|承受|吃|喝)/u.test(text)) {
    return false;
  }
  return /^(?:(?:建议|不妨|试着|试试|何不|尽量|记得|先|接着|然后|再|最后|别急着|不用急着|不必急着)|(?:你|我们)(?:(?:现在|今晚|接下来|这会儿|先)\s*)?(?:可以(?:先|试试|从|把|用|去|暂时|给自己|选择)|不妨|最好|先|试着|尽量|记得|不用|不必|要不要))/u.test(
    text,
  );
}

function isDirectReplyCompanionship(text: string): boolean {
  return (
    /^(?:我(?:(?:会)?在(?:这里|这儿)(?:陪着你|陪你|听着)?|(?:会)?陪着你|听着|在听)|你(?:愿意的话|想说的话)|慢慢来|别急|没关系|辛苦了)$/u.test(
      text,
    ) ||
    /^我们(?:可以)?(?:一起|慢慢|一步一步)(?:想|看看|梳理|处理|找办法|想办法|面对|来)/u.test(
      text,
    )
  );
}

function isTransientEmotionAcknowledgement(text: string): boolean {
  const emotion =
    /(?:紧张|难受|压力|焦虑|委屈|害怕|担心|疲惫|很累|心累|烦躁|不安|失落|开心|高兴|兴奋|生气|沮丧|压得慌|喘不过气)/u;
  if (
    !emotion.test(text) ||
    /(?:结婚|已婚|未婚|孩子|儿子|女儿|配偶|丈夫|妻子|住在|搬到|毕业于|生日|年龄|宠物|养了)/u.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /^(?:听起来|听上去|看起来|看上去|感觉|我(?:能)?(?:听出|听得出|感觉到|看得出)|这(?:份|种|样的))/u.test(
      text,
    ) || /^(?:你)?(?:现在|这会儿|刚才|想到|面对)/u.test(text)
  );
}

function stripEvidenceOnlyMetaPrefix(value: string): string {
  let text = value.trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stripped = text
      .replace(
        /^(?:而且|并且|同时|此外|另外|不过|但是|可是|然而|但|却|而|所以)\s*/u,
        "",
      )
      .replace(/^(?:我)?(?:确定|确实)?记得\s*/u, "")
      .replace(
        /^(?:根据你之前明确告诉我的|根据你之前说的|根据现有证据)\s*/u,
        "",
      )
      .replace(/^(?:里面|其中)(?:装着|装的)?(?:是|有)\s*/u, "")
      .replace(/^(?:我能确认|准确说法是|准确地说)\s*/u, "");
    if (stripped === text) break;
    text = stripped.trim();
  }
  return text;
}

function stripDirectReplyMetaPrefix(value: string): string {
  let text = stripEvidenceOnlyMetaPrefix(value);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stripped = text
      .replace(
        /^(?:至于|关于)(?:刚|已经|已|当前|目前)?(?:确认|生效)?(?:的)?(?:共同)?(?:安排|日程)(?:方面)?\s*/u,
        "",
      )
      .replace(
        /^(?:你问的)?(?:刚|已经|已|当前|目前)?(?:确认|生效)?(?:的)?(?:共同)?(?:安排|日程)(?:是|为|有)\s*/u,
        "",
      )
      .replace(
        /^(?:我们|咱们|我和你)(?:已经|已|刚刚|刚)?(?:确认|约好|约定|约)(?:了|的)?(?:共同)?(?:安排|日程)?(?:是|为|在)?\s*/u,
        "",
      );
    if (stripped === text) break;
    text = stripped.trim();
  }
  return text;
}

function semanticTokens(value: string): Set<string> {
  const normalized = normalizeEvidenceOnlyText(value);
  const tokens = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_-]{1,}/giu) ?? []) {
    const lowered = token.toLocaleLowerCase();
    if (!GENERIC_LATIN_TOKENS.has(lowered)) tokens.add(lowered);
  }
  const cjkOnly = normalized
    .replace(/[a-z0-9][a-z0-9_-]*/giu, " ")
    .replace(new RegExp(`[${GRAMMATICAL_CJK_CHARS}]`, "gu"), " ");
  for (const run of cjkOnly.match(/[\p{Script=Han}]+/gu) ?? []) {
    for (let index = 0; index <= run.length - 2; index += 1) {
      const token = run.slice(index, index + 2);
      if (!GENERIC_CJK_TOKENS.has(token)) tokens.add(token);
    }
    for (const character of run) {
      if (!GENERIC_CJK_SINGLE_CHARS.has(character)) tokens.add(character);
    }
  }
  return tokens;
}

function normalizeEvidenceOnlyText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(
      /(\p{N}{1,2}[:：]\p{N}{2})\s*(?:到|至|[-–—~～])\s*(\p{N}{1,2}[:：]\p{N}{2})/gu,
      "$1-$2",
    )
    .replace(/(?:一点点|一点儿|一点|少许)(?:的)?香菜/gu, "少量香菜")
    .replace(/指的?是/gu, "是")
    .replace(/(?:能够|能|可以)接受/gu, "接受")
    .replace(/一整把/gu, "整把")
    .replace(/不(?:太|怎么|大)?喜欢/gu, "不喜欢")
    .replace(/(?:现在|目前|如今)?住在/gu, "搬到")
    .replace(/(?:刚刚|刚)(?=搬)/gu, "")
    .replace(/搬(?:到了|去了|至)/gu, "搬到")
    .replace(/(?:高中时期|高中时候)(?:的)?同学/gu, "高中同学")
    .replace(/(?:大学时期|大学时候)(?:的)?同学/gu, "大学同学")
    .replace(/有一位(?=(?:大学|高中|中学|小学)同学)/gu, "")
    .replace(/(?<=[a-z])\p{P}+[\p{Z}\s]*(?=[a-z])/giu, "\uE000")
    .replace(/(?<=[a-z0-9])[\p{Z}\s]+(?=[a-z0-9])/giu, "\uE000")
    .replace(/[\p{P}\p{Z}\s]/gu, "")
    .replace(/\uE000/gu, " ");
}

function groundedMemoryClaimAnswersQuery(
  matchedTokens: readonly string[],
  userMessage: string | undefined,
): boolean {
  if (
    userMessage === undefined ||
    !/(?:是什么|什么(?:东西|物品)|谁|什么关系|放.{0,8}(?:哪(?:里|儿)?|什么位置)|(?:在|住在).{0,5}(?:哪(?:里|儿)?|什么位置)|哪里|哪儿|什么位置)/u.test(
      userMessage,
    )
  ) {
    return true;
  }
  const queryTokens = semanticTokens(userMessage);
  return matchedTokens.some(
    (token) =>
      !queryTokens.has(token) &&
      (DISTINCTIVE_IDENTIFIER_TOKEN.test(token) ||
        (token.length >= 2 && !GENERIC_MEMORY_ANSWER_TOKENS.has(token))),
  );
}

const DISTINCTIVE_IDENTIFIERS =
  /(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9_-]{2,}/giu;

const DISTINCTIVE_IDENTIFIER_TOKEN =
  /^(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9][a-z0-9_-]{2,}$/iu;

const GENERIC_MEMORY_ANSWER_TOKENS = new Set([
  "代号",
  "编号",
  "代码",
  "东西",
  "物品",
  "位置",
]);

const GRAMMATICAL_CJK_CHARS =
  "我你您他她它的了呢啊呀吗吧是为和与及并且又也很太更最这那其在于把被将会曾还都只就让给从";

const GENERIC_CJK_TOKENS = new Set([
  "今天",
  "现在",
  "目前",
  "我们",
  "你说",
  "我想",
  "可以",
  "一下",
  "这个",
  "那个",
  "有点",
  "觉得",
  "愿意",
  "已经",
  "记得",
  "确定",
  "另外",
  "前面",
  "说法",
  "准确",
  "部分",
  "证据",
  "内容",
  "事实",
  "事情",
  "偏好",
  "关系",
]);

const GENERIC_CJK_SINGLE_CHARS = new Set(
  [...GENERIC_CJK_TOKENS].flatMap((token) => [...token]),
);

const GENERIC_LATIN_TOKENS = new Set([
  "the",
  "and",
  "but",
  "you",
  "your",
  "user",
  "remember",
  "know",
]);
