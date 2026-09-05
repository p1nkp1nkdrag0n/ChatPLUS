export const CONSENT_MODALITY_POLICY_VERSION =
  "third_party_consent_modality_v1" as const;

export type ThirdPartyConsentStatus =
  "possible" | "pending" | "granted" | "denied" | "revoked";

export type ThirdPartyConsentScopeKind =
  | "view"
  | "publish"
  | "display"
  | "share"
  | "forward"
  | "download"
  | "copy"
  | "use"
  | "adapt";

export interface ThirdPartyConsentClaim {
  sourceKind: "assertion" | "query";
  subject: string;
  subjectKey: string;
  beneficiary?: string;
  beneficiaryKey?: string;
  restrictions?: string[];
  status: ThirdPartyConsentStatus;
  scopeKind: ThirdPartyConsentScopeKind;
  scopeKey: string;
  scopeLabel: string;
  resource: string;
  evidenceText: string;
}

export interface ThirdPartyConsentAnalysis {
  claims: ThirdPartyConsentClaim[];
  consentOnly: boolean;
  independentText: string;
}

interface ConsentScope {
  kind: ThirdPartyConsentScopeKind;
  label: string;
  resource: string;
  beneficiary?: string;
  beneficiaryKey?: string;
  restrictions?: readonly string[];
}

interface ConsentResourceMention {
  value: string;
  index: number;
}

interface ConsentScopeAction {
  kind: ThirdPartyConsentScopeKind;
  label: string;
  index: number;
  end: number;
}

interface AnalyzeOptions {
  initialSubject?: string;
  initialScopes?: readonly ConsentScope[];
  contextualCandidate?: boolean;
  questionAsPending?: boolean;
  inheritInitialContext?: boolean;
  preserveInitialRestrictions?: boolean;
}

interface SubjectResolution {
  subject?: string;
  explicitlyExcluded: boolean;
}

const CONTROLLED_RESOURCE_SOURCE =
  "修复稿|预览稿|预览|底片|照片|相片|影像|肖像|相册|原件|文件|资料|内容|作品|稿件|录音|录像|视频|信件|书信|日记|档案|数据|名字|姓名|联系方式|邮件";
const CONTROLLED_RESOURCE = new RegExp(
  `(?:(?:(?:这|那|该|另一)(?:张|份|个|封|段)?)|(?:(?:姨妈|姑妈|舅妈|婶婶|伯母|阿姨|外婆|奶奶|妈妈|母亲|爸爸|父亲|姐姐|妹妹|哥哥|弟弟|朋友|同事|老师|医生|作者|受访者|被摄者|当事人|她|他|对方)的))?(?:${CONTROLLED_RESOURCE_SOURCE})`,
  "gu",
);
const KNOWN_THIRD_PARTY_SUBJECT =
  /朋友(?!(?:说|表示|说明|确认|认为|相信|建议|要求|劝|请))[\p{Script=Han}A-Za-z·]{1,6}(?=(?:说|表示|同意|允许|授权|许可|答应|批准|愿意|拒绝|撤回|收回|取消))|[\p{Script=Han}A-Za-z·]{1,6}医生(?=(?:说|表示|同意|允许|授权|许可|答应|批准|愿意|拒绝|撤回|收回|取消))|姨妈(?:(?:的)?(?:儿子|女儿))?|姑妈(?:(?:的)?(?:儿子|女儿))?|舅妈(?:(?:的)?(?:儿子|女儿))?|婶婶|伯母|阿姨|外婆|外祖母|奶奶|祖母|妈妈|母亲|爸爸|父亲|姐姐|妹妹|哥哥|弟弟|伴侣|配偶|朋友|同事|老师|医生|作者|受访者|被摄者|当事人|照片主人|内容所有者|版权人|权利人|她本人|他本人|她|他|对方/gu;
const AFFIRMATIVE_CONSENT_PREDICATE =
  /同意|允许|授权|许可|答应|批准|准许|(?<!获)(?:只|仅)?准(?!备|时|确|则)(?:许)?(?:了)?(?:我|我们|你|用户|[\p{Script=Han}A-Za-z·]{1,8}).{0,12}(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编)|(?:让|准)(?:我|我们|你|用户).{0,12}(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编)|愿意.{0,8}(?:让|给)|可以.{0,8}(?:让|给)|给了?.{0,8}(?:权限|许可)|通过了?.{0,12}(?:申请)/u;
const NEGATIVE_CONSENT_PREDICATE =
  /不同意|不允许|不授权|不许可|不答应|不愿意|不准(?:许)?|不许|不予批准|尚不批准|明确不批|拒绝.{0,8}(?:同意|允许|授权|许可|答应|批准|让|给)/u;
const REVOKED_CONSENT_PREDICATE =
  /撤回|收回|撤销|废止|取消.{0,8}(?:授权|许可|同意)|删除.{0,16}(?:授权|许可)(?:条款|规定)?|(?:授权|许可).{0,8}(?:作废|叫停)|把.{0,12}(?:授权|许可).{0,8}作废|不再.{0,8}(?:同意|允许|授权|许可)|反悔/u;
const NEGATED_CONSENT_POLARITY =
  /(?:没|没有|并没|并没有|未|并未|还没|尚未|从未|不曾|否认|不承认|不是要).{0,14}(?:同意|允许|授权|许可|答应|批准|准许|准(?=我|我们|你|用户)|首肯|点头|默许|应允|给.{0,6}(?:权限|许可)|通过.{0,8}申请|说(?:过)?(?:行|可以)|不同意|不允许|不授权|不许可|不可以|拒绝|撤回|收回|撤销|废止|取消|作废|叫停)|既没.{0,12}(?:同意|允许|授权|许可).{0,8}也没.{0,8}(?:拒绝|不同意|不允许)/u;
const NEGATED_SCOPE_PROPOSITION =
  /(?:同意|允许|批准).{0,12}(?:我|你|用户|我们)?(?:不要|不再|不|别|停止|放弃)(?:看|查看|公开|发布|分享|转发|下载|复制|使用|商用|改编)|(?:同意|批准).{0,16}(?:公开|发布|分享|转发|使用).{0,8}(?:不妥|不合适|不应该|不可)|(?:批准|同意).{0,12}(?:禁止|否决).{0,8}(?:看|查看|公开|发布|分享|转发|下载|复制|使用|商用|改编)/u;
const PENDING_CONSENT_PREDICATE =
  /考虑(?:是否|要不要)?.{0,12}(?:让|给|同意|允许|授权|许可|批准|准许)|(?:还没|还没有|尚未|未|没有|并未)(?:明确|正式)?(?:同意|允许|授权|许可|答应|批准|准许|首肯|确认|给.{0,6}(?:权限|许可)|通过.{0,8}申请)|(?:没|没有|未|从未|不曾|否认|不承认|尚不能|不便|并非|不是).{0,8}(?:说|表示|确认|同意|允许|授权|许可|答应|批准|准许|愿意)(?:过)?.{0,8}(?:同意|允许|授权|许可|答应|批准|准许|愿意|可以|能|让|给)?|(?:等待|等).{0,12}(?:回复|确认|答复)|还在考虑|尚在考虑|没有最终答复|尚未回复|还没回复/u;
const CONDITIONAL_CONSENT_PREDICATE =
  /(?:(?:需|须)?经|要(?:先)?(?:得到|取得|拿到|征得)?|只有|在|待|等|一旦|除非|未经|得到|征得|获得|取得|拿到).{0,24}(?:同意|允许|授权|许可|答应|批准|准许|通过.{0,8}申请).{0,24}(?:才|才能|方可|方能|再|就|否则|不得|不可|之后|以后|后)/u;
const AMBIGUOUS_ACQUIESCENCE_PREDICATE =
  /不反对|没有反对|没反对|没有异议|无异议|不介意|没有提出异议|没提出异议|未提出异议/u;
const CONTEXTUAL_CONSENT_GRANT_IDIOM =
  /点(?:了)?头(?:了)?|亮(?:了)?绿灯|开(?:了)?绿灯(?:了)?|默认了?|默许了?|首肯了?|已经批了?|签字放行|正式放行|已经获批|给了准话|给出了?肯定答复|拍板了?|予以认可|应承下来|盖章确认|作出了?准予决定|已经核准|审批(?:已经)?通过|申请(?:已经)?通过|审批已经完成.{0,8}准予|查看资格已经核发|获准了?|(?:拥有|取得|获得)(?:了)?查看权|权限(?:已经)?有了|(?:她|他)准了|应允了?|允诺了?|说好(?:了)?|说没问题|(?:她|他|对方)?(?:(?:回复|答复)(?:说)?|说)(?:了)?(?:行|可以)|(?:答复|结论)是(?:行|可以|准予)|(?:(?:她|他|对方|姨妈|姑妈|舅妈|阿姨|外婆|奶奶|妈妈|爸爸)(?:已经|已)?确认(?:过)?(?:可以|了)?|^(?:已经)?确认(?:过)?(?:了)?$)|(?:姨妈|姑妈|舅妈|阿姨|外婆|奶奶|妈妈|爸爸)说(?:OK|ok|行)了?|(?:她|他|对方).{0,4}让(?:我|你|用户)(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编)|授权(?:现在|现已|已经)?生效/u;
const SOURCE_CONSENT_GRANT_IDIOM =
  /(?:点(?:了)?头(?:了)?|开(?:了)?绿灯(?:了)?|默认了?|默许了?|应允了?|允诺了?|说好(?:了)?|说没问题).{0,8}(?:让|给|我|你|用户).{0,8}(?:单独看|私下看|查看|阅览|预览|看|公开|发布|披露|公示|展示|展出|参展|分享|共享|转发|转送|下载|复制|拷贝|复印|使用|改编|剪辑)/u;
const CONTEXTUAL_GRANT_INFERENCE =
  /(?:有|获得|取得)(?:了)?(?:单独看|私下看|查看|阅览|预览|看|公开|发布|披露|公示|展示|展出|参展|分享|共享|转发|转送|下载|复制|拷贝|复印|使用|改编|剪辑)?(?:权限|许可)|(?:已经|现在)?(?:有权限|权限(?:都|已经)?有)(?:了)?/u;
const UNRESOLVED_CONTEXT_RESOURCE = "未指明的上下文资源";
const CONSENT_SCOPE_CUE =
  /单独看|私下看|查看|阅览|预览|阅读|审阅|浏览|打开|检查|公开|发布|披露|公示|公布|上传|投稿|刊登|转载|传播|群里发|展示|展出|参展|分享|共享|给人看|发给|转给|传给|寄给|交给|转发|转送|下载|复制|拷贝|复印|扫描|截屏|翻拍|存储|存到|印刷|印成|使用|用于|商用|广告|出售|售卖|赚钱|训练|改编|二次创作|衍生作品|加工|剪辑/u;
const CONSENT_ANCHOR =
  /撤回|收回|取消|不再|不同意|不允许|不授权|不许可|不答应|不愿意|不准(?:许)?|不许|拒绝|禁止|不得|无权|尚未|还没|还没有|未确认|没有同意|并未同意|考虑|等待|等.{0,8}(?:回复|确认)|同意|允许|授权|许可|答应|批准|准许|(?:只|仅)?准(?=[\p{Script=Han}A-Za-z·])|愿意|首肯|点头|开(?:了)?绿灯|获准|新开的口子|新口子|可以放心|放心.{0,4}(?:看|查看|使用)|(?:你|用户).{0,4}(?:就|去)(?:看|查看|使用)|(?:可以|可否|能).{0,8}(?:单独看|私下看|查看|看|公开|发布|上传|投稿|刊登|转载|传播|展示|分享|发给|转给|传给|寄给|交给|转发|下载|复制|扫描|截屏|翻拍|存储|印刷|使用|商用|广告|出售|售卖|赚钱|训练|改编|二创|加工)/u;
const EXCLUDED_SUBJECT_PREFIX =
  /^(?:我本人|我|我们|你本人|你|你们|用户|角色|助手|模型|公司|机构|团队|平台|学校|博物馆|系统|应用|项目|部门|委员会|组织)/u;
const NON_SUBJECT_DISCOURSE_PREFIX =
  /^(?:要|需|需要|等待|等|问题|证据|信息|表述|说法|这句话|当前表述|这|那|就|才|方|但|不过|然而|却|而是|也|又|还|后来|更正|纠正|不|没|未|没有|并未|不是|并非|已经|正在|目前|现在|所以|因此|放心|公开|发布|披露|公示|展示|展出|参展|分享|共享|转发|转送|下载|复制|拷贝|复印|使用|用于|改编|剪辑)/u;
const ORGANIZATION_SUBJECT_SUFFIX =
  /(?:公司|机构|团队|平台|学校|博物馆|系统|应用|项目|部门|委员会|组织)$/u;
const CONSENT_INTERNAL_CLAUSE_BREAK =
  /(?=(?:但是|但|不过|然而|却|而是)(?:这|那|她|他|本人|对方|不|没|未|还|目前|现在|已经|明确|正式|允许|同意|授权|许可|答应|拒绝|撤回|收回|取消|禁止|不得|无权|不准|不许|别|停止|放弃|否决|公开|发布|展示|分享|转发|下载|复制|使用|改编))|(?=(?:而且|并且|同时|也|又)(?:她|他|本人|对方)?(?:不允许|不同意|不授权|不许可|不答应|不愿意|允许|同意|授权|许可|答应|拒绝|撤回|收回|取消|禁止|不得|无权|不准|不许))|(?=(?:所以|因此)(?:你|用户|那|这|不|没|未|不能|无法|现在|目前))|(?=(?:(?:但是|但|不过|然而|却|而是|而且|并且|同时|也|又)?(?:禁止|不得|无权|不准(?:许)?|不许|别|停止|放弃|否决|不再|不(?=公开|发布|披露|公示|展示|展出|分享|共享|转发|转送|下载|复制|拷贝|复印|保存|使用|商用|改编|剪辑)))(?:公开|发布|披露|公示|展示|展出|分享|共享|转发|转送|下载|复制|拷贝|复印|保存|备份|扫描|查看|看|使用|商用|改编|剪辑))|(?=(?:然后|接着|随后|另一个话题(?:是)?)(?:我|你|用户|谢谢|请|记住|提醒|安排|联系))|(?=(?:也)?记住)|(?=(?:以及|而且|并且|同时|另外|此外|顺便|并|还有)(?:我|谢谢|请|帮我|记得我|还要记得))|(?=我最好的朋友)|(?=我的(?:狗|猫|宠物))|(?=(?:不等于|不代表|不意味着|不能说|不能确定|无法确认|不能证明|无法证明|没有证据(?:表明|证明)|不足以(?:证明|说明)|别当作|别当成|不要当作|不要当成|不能当作|不能当成|不能算|尚不能视为|不能推出|不能据此))/u;

/**
 * Extracts privacy and usage-permission statements made about a concrete third
 * party and a controlled resource. This contract parser is intentionally
 * precise: ordinary agreement, invitations, delegated decisions, and
 * organizational approvals remain outside its ownership boundary.
 */
export function analyzeThirdPartyConsentModality(
  sourceText: string,
): ThirdPartyConsentAnalysis {
  return analyzeConsentText(sourceText, {});
}

/** A consent question is not evidence of a grant, but it still creates a
 * reply-containment boundary so a model cannot answer the question as fact. */
export function analyzeThirdPartyConsentQuery(
  sourceText: string,
): ThirdPartyConsentAnalysis {
  const analysis = analyzeThirdPartyConsentContainment(sourceText);
  const claims = analysis.claims.filter(
    (claim) => claim.sourceKind === "query",
  );
  return {
    claims,
    consentOnly: claims.length > 0 && analysis.consentOnly,
    independentText: analysis.independentText,
  };
}

/** Includes asserted states and non-authoritative questions for reply safety. */
export function analyzeThirdPartyConsentContainment(
  sourceText: string,
): ThirdPartyConsentAnalysis {
  return analyzeConsentText(sourceText, { questionAsPending: true });
}

/** Resolves an elliptical consent follow-up against the most recent typed
 * claims. Questions never inherit a grant status: they become pending query
 * boundaries over the inherited subject/resource/scope. */
export function analyzeThirdPartyConsentFollowUp(
  sourceText: string,
  priorClaims: readonly ThirdPartyConsentClaim[],
): ThirdPartyConsentAnalysis {
  const questionFollowUp = looksLikeConsentFollowUp(sourceText);
  const clauses = splitConsentClauses(sourceText);
  const firstStatus = consentStateFollowUpStatus(clauses[0] ?? "");
  const stateFollowUp = firstStatus !== undefined;
  if (priorClaims.length === 0 || (!questionFollowUp && !stateFollowUp)) {
    return { claims: [], consentOnly: false, independentText: sourceText };
  }
  const priorClaimKeys = new Set(
    priorClaims.map(
      (claim) =>
        `${claim.subjectKey}:${claim.scopeKey}:${claim.beneficiaryKey ?? "unspecified"}`,
    ),
  );
  if (stateFollowUp) {
    // Source statements must not reuse candidate-reply inference. In a reply,
    // "she confirmed receipt" can be suspicious; as user evidence it is a
    // different proposition and cannot establish permission. Only complete,
    // object-free answers may inherit the immediately preceding consent topic.
    let status = firstStatus;
    const evidence: string[] = [];
    let index = 0;
    for (const clause of clauses) {
      const nextStatus = consentStateFollowUpStatus(clause);
      if (nextStatus === undefined) break;
      status = nextStatus;
      evidence.push(clause);
      index += 1;
    }
    const independentText = independentConsentText(
      sourceText,
      clauses,
      new Set(
        clauses
          .map((_, clauseIndex) => clauseIndex)
          .filter((clauseIndex) => clauseIndex < index),
      ),
    );
    return {
      claims: priorClaims.map((claim) => ({
        ...claim,
        sourceKind: "assertion",
        status: priorClaimKeys.size === 1 ? status : "pending",
        evidenceText: evidence.join("。"),
      })),
      consentOnly: independentText === "",
      independentText,
    };
  }
  const claims: ThirdPartyConsentClaim[] = [];
  let consentOnly = true;
  let independentText = "";
  const claimsBySubject = new Map<string, ThirdPartyConsentClaim[]>();
  for (const claim of priorClaims) {
    const existing = claimsBySubject.get(claim.subjectKey) ?? [];
    existing.push(claim);
    claimsBySubject.set(claim.subjectKey, existing);
  }
  for (const subjectClaims of claimsBySubject.values()) {
    const analysis = analyzeConsentText(sourceText, {
      initialSubject: subjectClaims[0]!.subject,
      initialScopes: subjectClaims.map(scopeFromClaim),
      questionAsPending: true,
      inheritInitialContext: true,
    });
    claims.push(...analysis.claims);
    consentOnly &&= analysis.consentOnly;
    if (independentText === "") independentText = analysis.independentText;
  }
  const unique = new Map<string, ThirdPartyConsentClaim>();
  for (const claim of claims) {
    unique.set(
      `${claim.subjectKey}:${claim.scopeKey}:${claim.beneficiaryKey ?? "unspecified"}`,
      claim,
    );
  }
  return {
    claims: [...unique.values()],
    consentOnly: unique.size > 0 && consentOnly,
    independentText,
  };
}

/**
 * Returns true when a candidate reply asserts a consent state that the current
 * authoritative wording does not support. Candidate analysis may inherit a
 * sole subject/resource/scope from the contract because conversational replies
 * routinely omit context (for example, "所以你现在能看了").
 */
export function isUnsupportedConsentAssertion(input: {
  authoritativeText: string;
  candidateText: string;
  authoritativeClaims?: readonly ThirdPartyConsentClaim[];
}): boolean {
  const authoritative =
    input.authoritativeClaims === undefined
      ? analyzeThirdPartyConsentContainment(input.authoritativeText)
      : {
          claims: [...input.authoritativeClaims],
          consentOnly: false,
          independentText: "",
        };
  if (authoritative.claims.length === 0) return false;

  const canonicalSubjectKeys = new Set(
    authoritative.claims.map((claim) => claim.subjectKey),
  );
  const soleSubject =
    canonicalSubjectKeys.size === 1
      ? authoritative.claims[0]?.subject
      : undefined;
  const remainingCandidateClauses: string[] = [];
  for (const clause of splitConsentClauses(input.candidateText)) {
    if (
      isRhetoricalGrantQuestion(clause) &&
      authoritative.claims.some((claim) => claim.status !== "granted")
    ) {
      return true;
    }
    if (
      isConsentConstraintExpansion(
        input.authoritativeText,
        authoritative.claims,
        clause,
      ) ||
      isUnknownPermissionExpansion(clause)
    ) {
      return true;
    }
    const boundary = inspectCandidateConsentBoundary({
      clause,
      authoritativeClaims: authoritative.claims,
      ...(soleSubject === undefined ? {} : { initialSubject: soleSubject }),
    });
    if (boundary === "unsupported") return true;
    if (boundary === "safe") continue;
    if (isUnpermittedOperationalScope(clause, authoritative.claims)) {
      return true;
    }
    remainingCandidateClauses.push(clause);
  }
  const contextual = analyzeConsentText(remainingCandidateClauses.join("。"), {
    ...(soleSubject === undefined ? {} : { initialSubject: soleSubject }),
    initialScopes: authoritative.claims.map(scopeFromClaim),
    contextualCandidate: true,
  });

  for (const proposed of contextual.claims) {
    const proposedSubjectKey = normalizeCandidateSubjectKey(
      proposed.subjectKey,
      canonicalSubjectKeys,
    );
    const supported = authoritative.claims.find(
      (claim) =>
        claim.subjectKey === proposedSubjectKey &&
        claim.scopeKey === proposed.scopeKey &&
        claim.beneficiaryKey === proposed.beneficiaryKey,
    );
    if (
      supported === undefined ||
      !isCompatibleConsentStatus(supported.status, proposed.status) ||
      !preservesConsentRestrictions(supported, proposed)
    ) {
      return true;
    }
  }
  return false;
}

/** Generic model-owned memories and continuity records are not a consent
 * ledger. Until a typed ledger exists, keep every consent-derived candidate
 * out while preserving unrelated candidates from a mixed user turn. */
export function isConsentDerivedSemanticCandidate(input: {
  authoritativeText: string;
  candidateText: string;
  authoritativeClaims?: readonly ThirdPartyConsentClaim[];
}): boolean {
  const authoritative =
    input.authoritativeClaims === undefined
      ? analyzeThirdPartyConsentContainment(input.authoritativeText)
      : {
          claims: [...input.authoritativeClaims],
          consentOnly: false,
          independentText: "",
        };
  if (authoritative.claims.length === 0) return false;
  const candidateText = normalizeConsentText(input.candidateText);
  if (candidateText === "") return false;
  if (
    analyzeConsentText(candidateText, {
      ...(new Set(authoritative.claims.map((claim) => claim.subjectKey))
        .size === 1
        ? { initialSubject: authoritative.claims[0]!.subject }
        : {}),
      initialScopes: authoritative.claims.map(scopeFromClaim),
      contextualCandidate: true,
    }).claims.length > 0
  ) {
    return true;
  }

  const authoritativeResources = new Set(
    authoritative.claims.map((claim) => consentResourceKey(claim.resource)),
  );
  const candidateResources = extractResources(candidateText).map((resource) =>
    consentResourceKey(resource.value),
  );
  return (
    candidateResources.some((resource) =>
      authoritativeResources.has(resource),
    ) &&
    CONSENT_SCOPE_CUE.test(candidateText) &&
    /(?:同意|允许|授权|许可|答应|批准|准许|获准|权限|可以|可否|能否|能不能|能够|有权|不得|不可|不能|不可以|不要|放心|随便|尽管|只管|直接|拿去|发出去|就行|即可)/u.test(
      candidateText,
    )
  );
}

/** Detects an attempted controlled operation over the same protected resource
 * even when the operation text omits permission words (for example, a schedule
 * title that only says "公开修复稿"). Scope equality is deliberately not
 * required: permission to view a resource must never authorize a broader
 * publish, forward, copy, use, or adaptation effect. This is intentionally
 * separate from consent-fact detection because effect payloads describe
 * execution, not modality. */
export function isConsentControlledActivity(input: {
  claims: readonly ThirdPartyConsentClaim[];
  candidateText: string;
}): boolean {
  const candidate = normalizeConsentText(input.candidateText);
  if (candidate === "") return false;
  if (extractScopeActions(candidate).length === 0) return false;
  const candidateResources = extractResources(candidate).map(
    (resource) => resource.value,
  );
  return input.claims.some((claim) => {
    if (claim.resource === UNRESOLVED_CONTEXT_RESOURCE) return true;
    return candidateResources.some((resource) =>
      consentActivityResourceMatches(resource, claim.resource),
    );
  });
}

/** Returns true when a provider-owned evidence field is an excerpt of a typed
 * consent claim (or contains that claim). Raw effect normalization accepts
 * literal user substrings, including short ones such as "看修复稿"; checking
 * only whether that substring independently restates modality would therefore
 * allow consent-derived cancel or move effects to shed their provenance. */
export function isConsentClaimEvidenceExcerpt(input: {
  claims: readonly ThirdPartyConsentClaim[];
  candidateText: string;
}): boolean {
  const candidate = normalizeConsentText(input.candidateText);
  if (candidate === "") return false;
  return input.claims.some((claim) => {
    const evidence = normalizeConsentText(claim.evidenceText);
    return (
      evidence !== "" &&
      (evidence.includes(candidate) || candidate.includes(evidence))
    );
  });
}

export function containsThirdPartyConsentSemantics(text: string): boolean {
  return analyzeThirdPartyConsentContainment(text).claims.length > 0;
}

export function consentClaimsFromUnknown(value: unknown): string {
  const values: string[] = [];
  collectStrings(value, values, new Set<unknown>());
  return values.join(" ").slice(0, 8_000);
}

function analyzeConsentText(
  sourceText: string,
  options: AnalyzeOptions,
): ThirdPartyConsentAnalysis {
  const text = normalizeConsentText(sourceText);
  if (text === "" || isMetaLanguageRequest(text)) {
    return { claims: [], consentOnly: false, independentText: text };
  }

  const clauses = splitConsentClauses(text);
  const claims = new Map<string, ThirdPartyConsentClaim>();
  const relevantClauses = new Set<number>();
  let lastClaimKeys: string[] = [];
  let currentSubject = options.initialSubject;
  let currentScopes = (options.initialScopes ?? []).map((scope) => {
    const copy = { ...scope };
    if (
      options.contextualCandidate === true &&
      options.preserveInitialRestrictions !== true
    ) {
      delete copy.restrictions;
    }
    return copy;
  });
  let topicalResources = [
    ...new Set((options.initialScopes ?? []).map((scope) => scope.resource)),
  ];
  let epistemicLeadInClauses: number[] = [];
  let affirmativeLeadInClauses: number[] = [];
  let conditionalLeadInClauses: number[] = [];
  let invalidatingLeadInClauses: number[] = [];

  for (const [index, clause] of clauses.entries()) {
    if (
      options.contextualCandidate !== true &&
      /^(?:(?:另外|此外|顺便|还有|同时|现在)(?:我)?|我|我们)(?:现在|目前|正式|明确|已经)*(?:授权(?:你|给你)|委托你|请你替我)/u.test(
        clause,
      )
    ) {
      // A new first-person delegation has a different authority and task.
      // Neither this clause nor subsequent option clauses inherit the third
      // party's scope. The original text remains available to support parsing.
      currentSubject = undefined;
      currentScopes = [];
      topicalResources = [];
      lastClaimKeys = [];
      epistemicLeadInClauses = [];
      affirmativeLeadInClauses = [];
      conditionalLeadInClauses = [];
      invalidatingLeadInClauses = [];
      continue;
    }
    if (
      isEpistemicConsentLeadIn(clause) ||
      isIndirectReporterLeadIn(clause, clauses[index + 1])
    ) {
      epistemicLeadInClauses.push(index);
      continue;
    }
    if (isInvalidatingConsentLeadIn(clause)) {
      invalidatingLeadInClauses.push(index);
      continue;
    }
    if (isAmbivalentConsentLeadIn(clause)) {
      const leadInSubject = resolveThirdPartySubject(
        clause,
        currentSubject,
      ).subject;
      if (leadInSubject !== undefined) currentSubject = leadInSubject;
      invalidatingLeadInClauses.push(index);
      continue;
    }
    const clauseResources = extractResources(clause);
    if (
      extractScopeActions(clause).length === 0 &&
      clauseResources.length > 0 &&
      isConsentTopicLeadIn(clause)
    ) {
      const topicalSubject = resolveThirdPartySubject(
        clause,
        currentSubject,
      ).subject;
      if (
        topicalSubject !== undefined &&
        !isPronominalSubject(topicalSubject)
      ) {
        currentSubject = topicalSubject;
      }
      topicalResources = clauseResources.map((resource) => resource.value);
      relevantClauses.add(index);
      continue;
    }
    if (isConfirmationTagQuestion(clause)) {
      if (lastClaimKeys.length > 0) {
        relevantClauses.add(index);
        for (const key of lastClaimKeys) {
          const prior = claims.get(key);
          if (prior === undefined) continue;
          if (options.questionAsPending === true) {
            claims.set(key, {
              ...prior,
              sourceKind: "query",
              status: "pending",
              evidenceText: `${prior.evidenceText}，${clause}`,
            });
          } else {
            claims.delete(key);
          }
        }
      }
      continue;
    }
    if (
      currentSubject !== undefined &&
      currentScopes.length > 0 &&
      isConsentInferenceDisclaimer(clause)
    ) {
      relevantClauses.add(index);
      for (const key of lastClaimKeys) {
        const prior = claims.get(key);
        if (prior?.status === "granted") {
          claims.set(key, {
            ...prior,
            status: "pending",
            evidenceText: `${prior.evidenceText}，${clause}`,
          });
        }
      }
      continue;
    }
    if (
      currentSubject !== undefined &&
      currentScopes.length > 0 &&
      isConsentRestrictionContinuation(clause)
    ) {
      const restrictions = extractConsentRestrictions(clause);
      relevantClauses.add(index);
      currentScopes = currentScopes.map((scope) => ({
        ...scope,
        restrictions: [
          ...new Set([...(scope.restrictions ?? []), ...restrictions]),
        ],
      }));
      for (const scope of currentScopes) {
        const key = `${consentKeyPart(currentSubject)}:${scope.kind}:${consentResourceKey(scope.resource)}:${scope.beneficiaryKey ?? "unspecified"}`;
        const current = claims.get(key);
        if (current !== undefined) {
          claims.set(key, {
            ...current,
            restrictions: [...(scope.restrictions ?? [])],
            evidenceText: `${current.evidenceText}，${clause}`,
          });
        }
      }
      continue;
    }
    const consentQuestion = isConsentQuestionClause(clause);
    if (
      options.contextualCandidate === true &&
      consentQuestion &&
      !isRhetoricalGrantQuestion(clause)
    ) {
      continue;
    }
    if (
      options.contextualCandidate !== true &&
      consentQuestion &&
      options.questionAsPending !== true
    ) {
      continue;
    }
    const subjectResolution = resolveThirdPartySubject(clause, currentSubject);
    if (
      subjectResolution.subject !== undefined &&
      !isPronominalSubject(subjectResolution.subject)
    ) {
      currentSubject = subjectResolution.subject;
    }
    if (
      options.contextualCandidate !== true &&
      currentSubject !== undefined &&
      isConditionalConsentLeadIn(clause) &&
      extractScopeActions(clause).length === 0
    ) {
      conditionalLeadInClauses.push(index);
      continue;
    }
    if (
      options.contextualCandidate !== true &&
      currentSubject !== undefined &&
      isAffirmativeConsentLeadIn(clause) &&
      extractScopeActions(clause).length === 0
    ) {
      affirmativeLeadInClauses.push(index);
      continue;
    }

    const linkedContinuation =
      currentSubject !== undefined && isLinkedConsentContinuation(clause);
    const rhetoricalGrant =
      options.contextualCandidate === true && isRhetoricalGrantQuestion(clause);
    const status = rhetoricalGrant
      ? "granted"
      : consentQuestion && options.questionAsPending === true
        ? "pending"
        : invalidatingLeadInClauses.length > 0
          ? "pending"
          : epistemicLeadInClauses.length > 0
            ? "possible"
            : conditionalLeadInClauses.length > 0
              ? "pending"
              : affirmativeLeadInClauses.length > 0
                ? "granted"
                : classifyConsentStatus(
                    clause,
                    options.contextualCandidate === true,
                    linkedContinuation,
                  );
    const permissionSignal =
      rhetoricalGrant ||
      invalidatingLeadInClauses.length > 0 ||
      hasPermissionSignal(
        clause,
        options.contextualCandidate === true,
        linkedContinuation,
      ) ||
      conditionalLeadInClauses.length > 0 ||
      affirmativeLeadInClauses.length > 0 ||
      (consentQuestion &&
        options.questionAsPending === true &&
        (hasConsentQueryPermissionSignal(clause) ||
          (currentSubject !== undefined &&
            extractScopeActions(clause).length > 0 &&
            /(?:可否|能否|能不能|可以|能|是否有权|有没有权限)/u.test(clause)) ||
          (options.inheritInitialContext === true &&
            (extractScopeActions(clause).length > 0 ||
              /(?:同意|允许|授权|许可|答应|回复|答复|确认|结果|消息)/u.test(
                clause,
              )))));
    const explicitScopes = extractConsentScopes(
      clause,
      currentScopes,
      options.contextualCandidate === true,
      topicalResources,
      options.contextualCandidate === true ||
        options.inheritInitialContext === true ||
        linkedContinuation,
      options.inheritInitialContext === true,
    );
    const clauseRestrictions = extractConsentRestrictions(clause);
    const contextualScopes =
      explicitScopes.length > 0
        ? explicitScopes
        : status !== undefined && permissionSignal
          ? currentScopes
          : [];
    if (explicitScopes.length > 0) {
      currentScopes = explicitScopes.map((scope) => ({
        ...scope,
        ...(clauseRestrictions.length === 0
          ? {}
          : {
              restrictions: [
                ...new Set([
                  ...(scope.restrictions ?? []),
                  ...clauseRestrictions,
                ]),
              ],
            }),
      }));
      topicalResources = [
        ...new Set(explicitScopes.map((scope) => scope.resource)),
      ];
    }

    const affirmativeGrantContinuation =
      affirmativeLeadInClauses.length > 0 &&
      isAffirmativeGrantContinuation(clause);
    const conditionalGrantContinuation =
      conditionalLeadInClauses.length > 0 &&
      isConditionalGrantContinuation(clause);
    const topicalQuestionContinuation =
      consentQuestion &&
      currentSubject !== undefined &&
      topicalResources.length === 1 &&
      extractScopeActions(clause).length > 0;
    const impliedSubjectAllowed =
      currentSubject !== undefined &&
      (!subjectResolution.explicitlyExcluded ||
        affirmativeGrantContinuation ||
        conditionalGrantContinuation) &&
      (options.contextualCandidate === true ||
        options.inheritInitialContext === true ||
        isLinkedConsentContinuation(clause) ||
        topicalQuestionContinuation ||
        affirmativeGrantContinuation ||
        conditionalGrantContinuation);
    const subject =
      subjectResolution.subject ??
      (impliedSubjectAllowed ? currentSubject : undefined);
    const consentRelated =
      subject !== undefined &&
      contextualScopes.length > 0 &&
      status !== undefined &&
      permissionSignal;

    if (consentRelated) {
      relevantClauses.add(index);
      for (const leadInIndex of epistemicLeadInClauses) {
        relevantClauses.add(leadInIndex);
      }
      for (const leadInIndex of affirmativeLeadInClauses) {
        relevantClauses.add(leadInIndex);
      }
      for (const leadInIndex of conditionalLeadInClauses) {
        relevantClauses.add(leadInIndex);
      }
      for (const leadInIndex of invalidatingLeadInClauses) {
        relevantClauses.add(leadInIndex);
      }
      epistemicLeadInClauses = [];
      affirmativeLeadInClauses = [];
      conditionalLeadInClauses = [];
      invalidatingLeadInClauses = [];
      const clauseClaimKeys: string[] = [];
      for (const scope of contextualScopes) {
        const resource = canonicalizeConsentResourceOwner(
          scope.resource,
          subject,
        );
        const effectiveRestrictions =
          clauseRestrictions.length > 0
            ? clauseRestrictions
            : (scope.restrictions ?? []);
        const claim: ThirdPartyConsentClaim = {
          sourceKind:
            consentQuestion && options.questionAsPending === true
              ? "query"
              : "assertion",
          subject,
          subjectKey: consentKeyPart(subject),
          ...(scope.beneficiary === undefined
            ? {}
            : {
                beneficiary: scope.beneficiary,
                beneficiaryKey: scope.beneficiaryKey,
              }),
          ...(effectiveRestrictions.length === 0
            ? {}
            : { restrictions: [...effectiveRestrictions] }),
          status,
          scopeKind: scope.kind,
          scopeKey: `${scope.kind}:${consentResourceKey(resource)}`,
          scopeLabel:
            resource === scope.resource
              ? scope.label
              : scope.label.replace(scope.resource, resource),
          resource,
          evidenceText: clause,
        };
        // Later wording owns the current state for the same subject and scope.
        // Historical evidence belongs in a future consent ledger, not as a
        // second simultaneously-active claim in this turn contract.
        const claimKey = `${claim.subjectKey}:${claim.scopeKey}:${claim.beneficiaryKey ?? "unspecified"}`;
        claims.set(claimKey, claim);
        clauseClaimKeys.push(claimKey);
      }
      lastClaimKeys = clauseClaimKeys;
      continue;
    }

    if (
      currentSubject !== undefined &&
      currentScopes.length > 0 &&
      isConsentRestrictionContinuation(clause)
    ) {
      const restrictions = extractConsentRestrictions(clause);
      relevantClauses.add(index);
      currentScopes = currentScopes.map((scope) => ({
        ...scope,
        restrictions: [
          ...new Set([...(scope.restrictions ?? []), ...restrictions]),
        ],
      }));
      for (const scope of currentScopes) {
        const key = `${consentKeyPart(currentSubject)}:${scope.kind}:${consentResourceKey(scope.resource)}:${scope.beneficiaryKey ?? "unspecified"}`;
        const current = claims.get(key);
        if (current !== undefined) {
          claims.set(key, {
            ...current,
            restrictions: [...(scope.restrictions ?? [])],
            evidenceText: `${current.evidenceText}，${clause}`,
          });
        }
      }
      continue;
    }

    if (
      currentSubject !== undefined &&
      currentScopes.length > 0 &&
      isConsentMetaContinuation(clause)
    ) {
      relevantClauses.add(index);
      if (
        isConsentInferenceDisclaimer(clause) ||
        isConsentAssertionRetraction(clause)
      ) {
        for (const scope of currentScopes) {
          const key = `${consentKeyPart(currentSubject)}:${scope.kind}:${consentResourceKey(scope.resource)}:${scope.beneficiaryKey ?? "unspecified"}`;
          const current = claims.get(key);
          if (current?.status === "granted") {
            claims.set(key, {
              ...current,
              status: "pending",
              evidenceText: clause,
            });
          }
        }
      }
      continue;
    }
    epistemicLeadInClauses = [];
    affirmativeLeadInClauses = [];
    conditionalLeadInClauses = [];
    invalidatingLeadInClauses = [];
    lastClaimKeys = [];
  }

  const values = [...claims.values()];
  return {
    claims: values,
    consentOnly:
      values.length > 0 &&
      !clauses.some(hasIndependentMixedIntent) &&
      clauses.every(
        (clause, index) =>
          relevantClauses.has(index) || isIgnorableConsentDiscourse(clause),
      ),
    independentText: independentConsentText(text, clauses, relevantClauses),
  };
}

/** Preserve punctuation within each surviving run. A comma can bind a user's
 * explicit delegation to its options; replacing it with a full stop changes
 * the speech act. Removed consent runs are separated from independent runs. */
function independentConsentText(
  source: string,
  clauses: readonly string[],
  relevantClauses: ReadonlySet<number>,
): string {
  const text = normalizeConsentText(source);
  const runs: string[] = [];
  let cursor = 0;
  let runStart: number | undefined;
  let runEnd = 0;
  for (const [index, clause] of clauses.entries()) {
    let start = text.indexOf(clause, cursor);
    let end = start + clause.length;
    if (start < 0) {
      // Clause normalization can remove quotation marks or join a discourse
      // prefix across punctuation. Recover its span without matching letters
      // from a different clause as separators.
      const pattern = [...clause]
        .map((char) => char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join('[\\s，,。！？!?；;：:“”"「」『』]*');
      const match = new RegExp(pattern, "u").exec(text.slice(cursor));
      if (match === null) {
        return clauses
          .filter(
            (value, clauseIndex) =>
              !relevantClauses.has(clauseIndex) &&
              !isIgnorableConsentDiscourse(value),
          )
          .join("。");
      }
      start = cursor + match.index;
      end = start + match[0].length;
    }
    cursor = end;
    if (relevantClauses.has(index) || isIgnorableConsentDiscourse(clause)) {
      if (runStart !== undefined) runs.push(text.slice(runStart, runEnd));
      runStart = undefined;
    } else {
      runStart ??= start;
      runEnd = end;
    }
  }
  if (runStart !== undefined) runs.push(text.slice(runStart, runEnd));
  return runs.join("。");
}

function splitConsentClauses(text: string): string[] {
  const parts = [...text.matchAll(/([^，,。！？!?；;：:\n]+)([！？!?]?)/gu)]
    .flatMap((match) =>
      `${match[1] ?? ""}${match[2] ?? ""}`.split(CONSENT_INTERNAL_CLAUSE_BREAK),
    )
    .map((clause) =>
      clause
        .trim()
        .replace(/^[“”"「」『』]+|[“”"「」『』]+$/gu, "")
        .trim(),
    )
    .filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      extractScopeActions(previous).length > 0 &&
      extractResources(previous).length > 0 &&
      /^(?:(?:可以|可否|能|行)(?:吗|么)?|(?:需要|要).{0,12}(?:同意|允许|授权|许可|点头|确认)(?:吗|么)?|(?:(?:姨妈|姑妈|舅妈|婶婶|伯母|阿姨|外婆|奶奶|妈妈|母亲|爸爸|父亲|姐姐|妹妹|哥哥|弟弟|她|他|对方)(?:本人)?)?(?:同意|允许|授权|许可|答应|批准|确认)(?:了)?(?:吗|么|没有|没)?)[？?！!。.]?$/u.test(
        part,
      )
    ) {
      merged[merged.length - 1] = `${previous}，${part}`;
      continue;
    }
    if (
      previous !== undefined &&
      /^(?:但|但是|但这|但是这|不过|不过这(?:还)?|然而|然而这|却|而是|而且|并且|同时|也|又|所以|因此)$/u.test(
        previous,
      )
    ) {
      merged[merged.length - 1] = `${previous}${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}

function resolveThirdPartySubject(
  clause: string,
  currentSubject: string | undefined,
): SubjectResolution {
  const anchorIndex = clause.search(CONSENT_ANCHOR);
  const knownMatches = [...clause.matchAll(KNOWN_THIRD_PARTY_SUBJECT)];
  const prefixBeforeAnchor =
    anchorIndex < 0 ? "" : clause.slice(0, anchorIndex).trim();
  const possessiveOwnerQuery = knownMatches.find((match) => {
    const end = (match.index ?? 0) + match[0].length;
    return (
      (isConsentQuestionClause(clause) ||
        /^(?:我|我们|用户).{0,12}(?:能|能不能|可以|可不可以|是否获准|有没有获准|能否获准|获准)/u.test(
          clause,
        )) &&
      new RegExp(`^的?(?:${CONTROLLED_RESOURCE_SOURCE})`, "u").test(
        clause.slice(end),
      )
    );
  })?.[0];
  const explicitGrantorBeforeAnchor =
    anchorIndex >= 0 &&
    knownMatches.some(
      (match) =>
        (match.index ?? 0) < anchorIndex && !isPronominalSubject(match[0]),
    );
  if (possessiveOwnerQuery !== undefined && !explicitGrantorBeforeAnchor) {
    return { subject: possessiveOwnerQuery, explicitlyExcluded: false };
  }
  const contextualBeneficiary =
    currentSubject !== undefined &&
    /^(?:(?:你|你们|用户)|[\p{Script=Han}A-Za-z·]{1,8})(?:现在|已经|终于)?(?:也|就|都)?$/u.test(
      prefixBeforeAnchor,
    ) &&
    /^(?:可以|能|获准)/u.test(clause.slice(anchorIndex)) &&
    (extractScopeActions(clause.slice(anchorIndex)).length > 0 ||
      isContextualPermissionExecution(clause));
  if (contextualBeneficiary) {
    // A reply such as "你现在也可以公开了" names the beneficiary, not a
    // new grantor. Candidate parsing may inherit the authoritative grantor;
    // standalone source parsing still has no grantor and therefore no claim.
    return { explicitlyExcluded: false };
  }
  if (
    currentSubject !== undefined &&
    extractResources(prefixBeforeAnchor).length > 0 &&
    /(?:也|现在|目前)?$/u.test(prefixBeforeAnchor)
  ) {
    return { explicitlyExcluded: false };
  }
  if (
    anchorIndex >= 0 &&
    !knownMatches.some((match) => (match.index ?? 0) < anchorIndex) &&
    EXCLUDED_SUBJECT_PREFIX.test(prefixBeforeAnchor)
  ) {
    return { explicitlyExcluded: true };
  }
  const knownMatch =
    anchorIndex < 0
      ? knownMatches.at(-1)
      : [...knownMatches].sort((left, right) => {
          const leftIndex = left.index ?? 0;
          const rightIndex = right.index ?? 0;
          const leftAfter = leftIndex > anchorIndex ? 1 : 0;
          const rightAfter = rightIndex > anchorIndex ? 1 : 0;
          if (leftAfter !== rightAfter) return leftAfter - rightAfter;
          return (
            Math.abs(leftIndex - anchorIndex) -
            Math.abs(rightIndex - anchorIndex)
          );
        })[0];
  const known = knownMatch?.[0];
  if (known !== undefined) {
    if (
      known === "她" ||
      known === "他" ||
      known === "对方" ||
      known === "她本人" ||
      known === "他本人"
    ) {
      if (currentSubject !== undefined) {
        return { subject: currentSubject, explicitlyExcluded: false };
      }
      const anaphorIndex = knownMatch?.index ?? 0;
      const antecedent = knownMatches
        .filter(
          (match) =>
            (match.index ?? 0) < anaphorIndex && !isPronominalSubject(match[0]),
        )
        .sort((left, right) => (right.index ?? 0) - (left.index ?? 0))[0]?.[0];
      return {
        subject: antecedent ?? known,
        explicitlyExcluded: false,
      };
    }
    return { subject: known, explicitlyExcluded: false };
  }

  if (anchorIndex < 0) {
    return { explicitlyExcluded: false };
  }
  const prefix = clause
    .slice(0, anchorIndex)
    .replace(
      /^(?:如果|假如|要是|若|听说|刚才说了?|更正(?:一下)?|准确地说|所以|因此|但是|但|不过|然而|而且|并且|也|又|目前|现在|之前|后来|原本|仍然|还)[，,]?\s*/u,
      "",
    )
    .replace(/(?:也许|可能|或许|大概|似乎|好像|明确|正式|刚刚|刚才)$/u, "")
    .trim();
  const generic = prefix.match(
    /([\p{Script=Han}A-Za-z·]{1,12}?)(?:说|表示|说明|确认)?$/u,
  )?.[1];
  if (generic === undefined) return { explicitlyExcluded: false };
  if (NON_SUBJECT_DISCOURSE_PREFIX.test(generic)) {
    return { explicitlyExcluded: false };
  }
  if (
    /^(?:我|你|用户)(?:现在|已经|终于)?(?:也|就)?$/u.test(generic) &&
    /^(?:可以|能)(?:放心)?(?:去|来)?(?:单独|私下)?(?:查看|阅览|预览|看(?!见|展)|公开|发布|上传|投稿|刊登|转载|传播|展示|分享|转给|转发|下载|复制|存储|印刷|使用|商用|训练|改编|二创)/u.test(
      clause.slice(anchorIndex),
    )
  ) {
    // In "你现在能看了", the second-person phrase is the beneficiary,
    // not a new grantor. A contextual candidate may inherit the sole grantor;
    // standalone contract parsing still has no subject and therefore no claim.
    return { explicitlyExcluded: false };
  }
  if (
    EXCLUDED_SUBJECT_PREFIX.test(generic) ||
    generic === "本人" ||
    ORGANIZATION_SUBJECT_SUFFIX.test(generic)
  ) {
    return { explicitlyExcluded: true };
  }
  return { subject: generic, explicitlyExcluded: false };
}

function extractConsentScopes(
  clause: string,
  fallbackScopes: readonly ConsentScope[],
  allowUnresolvedContextResource: boolean,
  fallbackResources: readonly string[] = [],
  inheritFallbackBeneficiary = false,
  inheritFallbackRestrictions = false,
): ConsentScope[] {
  const resources = extractResources(clause);
  const actions = extractScopeActions(clause).filter(
    (action) =>
      !resources.some(
        (resource) =>
          resource.index === action.index &&
          resource.value.length > action.end - action.index,
      ),
  );
  const scopes: ConsentScope[] = [];
  for (const action of actions) {
    const localResources = resourcesForAction(
      clause,
      action,
      actions,
      resources,
    );
    const fallbackResource =
      fallbackResourceForAction(action.kind, fallbackScopes) ??
      ([...new Set(fallbackResources)].length === 1
        ? fallbackResources[0]
        : undefined);
    const resolvedResources =
      localResources.length > 0
        ? localResources.map((resource) => resource.value)
        : fallbackResource !== undefined
          ? [fallbackResource]
          : allowUnresolvedContextResource && fallbackScopes.length > 0
            ? [UNRESOLVED_CONTEXT_RESOURCE]
            : isExplicitPermissionApplicationClause(clause)
              ? [UNRESOLVED_CONTEXT_RESOURCE]
              : [];
    const explicitBeneficiary = extractConsentBeneficiary(clause, action);
    const fallbackBeneficiaries = [
      ...new Map(
        fallbackScopes
          .filter((scope) => scope.beneficiaryKey !== undefined)
          .map((scope) => [scope.beneficiaryKey, scope.beneficiary] as const),
      ).entries(),
    ];
    const beneficiary =
      explicitBeneficiary ??
      (inheritFallbackBeneficiary && fallbackBeneficiaries.length === 1
        ? fallbackBeneficiaries[0]?.[1]
        : undefined);
    const inheritedRestrictions = inheritFallbackRestrictions
      ? [
          ...new Set(
            fallbackScopes.flatMap((scope) => scope.restrictions ?? []),
          ),
        ]
      : [];
    for (const resource of resolvedResources) {
      const label = `${action.label}${resource}`;
      if (
        scopes.some(
          (scope) => scope.kind === action.kind && scope.resource === resource,
        )
      ) {
        continue;
      }
      scopes.push({
        kind: action.kind,
        label,
        resource,
        ...(beneficiary === undefined
          ? {}
          : {
              beneficiary,
              beneficiaryKey: consentBeneficiaryKey(beneficiary),
            }),
        ...(inheritedRestrictions.length === 0
          ? {}
          : { restrictions: inheritedRestrictions }),
      });
    }
  }
  return scopes;
}

function extractConsentBeneficiary(
  clause: string,
  action: ConsentScopeAction,
): string | undefined {
  const actionText = clause.slice(action.index, action.end);
  const actionRecipient =
    actionText.match(/给([\p{Script=Han}A-Za-z·]{1,8}?)看$/u)?.[1] ??
    actionText.match(
      /(?:发给|转给|传给|寄给|交给|转交给)([\p{Script=Han}A-Za-z·]{1,8}?)(?:吗|么|呢|吧|了)?$/u,
    )?.[1];
  if (actionRecipient !== undefined) return actionRecipient;
  const prefix = clause.slice(0, action.index).replace(/\s+/gu, "");
  const capabilityBeneficiary =
    prefix.match(/(我|我们|你|你们|用户|大家|所有人|任何人)$/u)?.[1] ??
    prefix.match(/^([\p{Script=Han}A-Za-z·]{1,8})$/u)?.[1];
  if (
    capabilityBeneficiary !== undefined &&
    /^(?:可以|可否|能)/u.test(actionText) &&
    !NON_SUBJECT_DISCOURSE_PREFIX.test(capabilityBeneficiary) &&
    !/(?:说|听|表示|说明|回复|答复|确认|认为|准备|打算|计划|预计)/u.test(
      capabilityBeneficiary,
    )
  ) {
    return capabilityBeneficiary;
  }
  const permissionHolder = prefix.match(
    /(?:给|授予)(我|我们|你|你们|用户|大家|所有人|任何人)(?:开|开放|赋予)(?:了)?$/u,
  )?.[1];
  if (permissionHolder !== undefined) return permissionHolder;
  const sharedBeneficiary = prefix.match(
    /(我|你|用户)(?:现在|已经)?(?:可以|能)?(?:和|跟|与)([\p{Script=Han}A-Za-z·]{1,8}?)(?:一起)?$/u,
  );
  if (sharedBeneficiary !== null) {
    return `${sharedBeneficiary[1]}和${sharedBeneficiary[2]}`;
  }
  const alternativeQuestion = prefix.match(
    /(?:让不让|给不给)(我|我们|你|你们|用户|大家|所有人|任何人)$/u,
  )?.[1];
  if (alternativeQuestion !== undefined) return alternativeQuestion;
  const directed = prefix.match(
    /(?:(?:只|仅)?(?:同意|答应|批准)(?:了)?(?:让|给)?|(?:只|仅)?(?:让|给|允许|授权|许可|准(?!备|时|确|则)(?:许)?)(?:了)?)(我|我们|你|你们|用户|大家|所有人|任何人|[\p{Script=Han}A-Za-z·]{1,8})(?:(?:只|仅|今天|今日|明天|后天|本周|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|下个月|这个月|上午|下午|晚上|早上|中午|\d{1,2}点|[一二三四五六七八九十两]{1,3}点|这次|本次|以后|之后|在家里|在家中|在场时|陪同下|单独|私下|自己|一起|都))*$/u,
  )?.[1];
  const normalizedDirected =
    directed?.match(
      /^(我|我们|你|你们|用户)(?=(?:(?:今天|今日|明天|后天|本周|下周[一二三四五六日天]?|周[一二三四五六日天]|星期[一二三四五六日天]|下个月|这个月|上午|下午|晚上|早上|中午|\d{1,2}点|[一二三四五六七八九十两]{1,3}点|这次|本次|以后|之后|在家里|在家中|在场时|陪同下|单独|私下|自己|一起|都))+?$)/u,
    )?.[1] ?? directed;
  if (
    normalizedDirected !== undefined &&
    !/^(?:关于|对于|针对|把|将|我提出的|你提出的|用户提出的|这个|这项|该)/u.test(
      normalizedDirected,
    ) &&
    !/(?:只|仅|就|才|方|后才|后方|方可|才能|方能|以后|之后|后|今天|今日|明天|后天|下周|下个月|这次|本次|明确|正式|删除|修改|撤销|撤回|反对|不|没|未|再|提出的|认为|主张|说|不该|不应|不能|不可以)$/u.test(
      normalizedDirected,
    )
  ) {
    return normalizedDirected;
  }
  const topicalViewer = prefix.match(
    /(?:^|[，,。；;：:])([\p{Script=Han}A-Za-z·]{1,8})(?:现在|已经|终于)?(?:也|就|都|一起)*(?:可以|可否|能)$/u,
  )?.[1];
  if (
    topicalViewer !== undefined &&
    !NON_SUBJECT_DISCOURSE_PREFIX.test(topicalViewer) &&
    !/(?:说|听|表示|说明|回复|答复|确认|认为|准备|打算|计划|预计)/u.test(
      topicalViewer,
    )
  ) {
    return topicalViewer;
  }
  const leading = prefix.match(
    /(?:^|[，,。；;：:])(?:所以|因此|那|现在|目前)?(我|我们|你|你们|用户|大家|所有人|任何人)(?:俩|两人)?(?:现在|已经|终于)?(?:也|就|都|一起)*(?:可以|能)?$/u,
  )?.[1];
  return leading;
}

function consentBeneficiaryKey(beneficiary: string): string {
  if (/^(?:我|你|用户)$/u.test(beneficiary)) return "user";
  const shared = beneficiary.match(/^(?:我|你|用户)和(.+)$/u)?.[1];
  if (shared !== undefined) {
    return `user_plus:${consentKeyPart(shared)}`;
  }
  if (/^(?:我们|你们|大家|所有人|任何人)$/u.test(beneficiary)) {
    return "group";
  }
  return consentKeyPart(beneficiary);
}

function extractConsentRestrictions(text: string): string[] {
  const restrictions: string[] = [];
  if (/(?:单独|私下)/u.test(text)) restrictions.push("visibility:private");
  if (
    /(?:只限|仅限|限于|只同意|仅同意).{0,12}(?:今天|今日)|(?:同意|允许|授权|许可|答应).{0,12}(?:我|你|用户)?.{0,6}(?:今天|今日).{0,8}(?:看|查看|公开|分享|转发|使用)/u.test(
      text,
    )
  ) {
    restrictions.push("time:today");
  }
  if (/(?:只限|仅限|限于|只同意|仅同意).{0,12}(?:这次|本次)/u.test(text)) {
    restrictions.push("occasion:this");
  }
  if (
    /(?:只限|仅限|只能|仅能|只可|不得超过).{0,12}(?:一次|一遍|单次)|(?:看|查看|公开|分享|转发|使用).{0,4}(?:一次|一遍)/u.test(
      text,
    )
  ) {
    restrictions.push("count:once");
  }
  if (/(?:必须|需要|须).{0,10}(?:陪同|在场|陪着|监督)/u.test(text)) {
    restrictions.push("presence:grantor_required");
  }
  if (
    /(?:不得|不可|不能|禁止|非).{0,10}(?:商用|商业)|仅限.{0,8}非商业/u.test(
      text,
    )
  ) {
    restrictions.push("commercial:prohibited");
  }
  const purpose = text.match(
    /(?:只限|仅限|只能|仅能)(?:用于|用作)?(论文|研究|教学|展览|档案|个人收藏)/u,
  )?.[1];
  if (purpose !== undefined) restrictions.push(`purpose:${purpose}`);
  return [...new Set(restrictions)];
}

function isConsentRestrictionContinuation(clause: string): boolean {
  return (
    extractConsentRestrictions(clause).length > 0 &&
    /^(?:但|不过|而且|并且|同时|还|只|仅|必须|需要|须|不得|不可|不能|禁止|非|用途)/u.test(
      clause,
    )
  );
}

function resourcesForAction(
  clause: string,
  action: ConsentScopeAction,
  actions: readonly ConsentScopeAction[],
  resources: readonly ConsentResourceMention[],
): ConsentResourceMention[] {
  const nextActionIndex = actions
    .filter((candidate) => candidate.index > action.index)
    .reduce(
      (nearest, candidate) => Math.min(nearest, candidate.index),
      clause.length,
    );
  const following = resources
    .filter(
      (resource) =>
        resource.index >= action.end && resource.index < nextActionIndex,
    )
    .sort((left, right) => left.index - right.index);
  const firstFollowing = following[0];
  if (
    firstFollowing !== undefined &&
    firstFollowing.index - action.index <= 28
  ) {
    return coordinatedResourceGroup(clause, following);
  }

  const previousActionEnd = actions
    .filter((candidate) => candidate.index < action.index)
    .reduce((latest, candidate) => Math.max(latest, candidate.end), 0);
  const preceding = resources
    .filter(
      (resource) =>
        resource.index + resource.value.length <= action.index &&
        resource.index >= previousActionEnd,
    )
    .sort((left, right) => left.index - right.index);
  const nearestPreceding = preceding.at(-1);
  if (
    nearestPreceding === undefined ||
    action.index - (nearestPreceding.index + nearestPreceding.value.length) > 28
  ) {
    return [];
  }
  const group: ConsentResourceMention[] = [nearestPreceding];
  for (let index = preceding.length - 2; index >= 0; index -= 1) {
    const candidate = preceding[index]!;
    const next = group[0]!;
    if (!isResourceConjunction(clause, candidate, next)) break;
    group.unshift(candidate);
  }
  return group;
}

function coordinatedResourceGroup(
  clause: string,
  resources: readonly ConsentResourceMention[],
): ConsentResourceMention[] {
  const first = resources[0];
  if (first === undefined) return [];
  const group = [first];
  for (const candidate of resources.slice(1)) {
    if (!isResourceConjunction(clause, group.at(-1)!, candidate)) break;
    group.push(candidate);
  }
  return group;
}

function isResourceConjunction(
  clause: string,
  left: ConsentResourceMention,
  right: ConsentResourceMention,
): boolean {
  const bridge = clause
    .slice(left.index + left.value.length, right.index)
    .replace(/\s+/gu, "");
  return /^(?:、|和|及|以及|还有|与|跟|或|或者|(?:以及|还有)?(?:她|他|其)的)$/u.test(
    bridge,
  );
}

function fallbackResourceForAction(
  kind: ThirdPartyConsentScopeKind,
  scopes: readonly ConsentScope[],
): string | undefined {
  const sameKind = scopes.find((scope) => scope.kind === kind)?.resource;
  if (sameKind !== undefined) return sameKind;
  const resources = [...new Set(scopes.map((scope) => scope.resource))];
  return resources.length === 1 ? resources[0] : undefined;
}

function isExplicitPermissionApplicationClause(clause: string): boolean {
  return /(?:批准|准许|通过|驳回|拒绝|未通过|没有通过).{0,16}(?:申请|请求)|(?:同意|批准).{0,16}(?:撤销|撤回|取消).{0,8}(?:申请|请求)|(?:给|授予|没有给|未给).{0,12}(?:权限|许可)/u.test(
    clause,
  );
}

function extractScopeActions(clause: string): ConsentScopeAction[] {
  const definitions: ReadonlyArray<{
    kind: ThirdPartyConsentScopeKind;
    pattern: RegExp;
    label: (matched: string) => string;
  }> = [
    {
      kind: "view",
      pattern:
        /(?:可以|能)?(?:单独|私下|自己|仅限[^，,。；;]{0,8})?(?:查看|阅览|预览|阅读|审阅|浏览|打开|检查|看(?!起来|上去|见|展|法))/gu,
      label: (matched) =>
        matched.replace(/^(?:可以|能)/u, "").replace(/了$/u, ""),
    },
    {
      kind: "publish",
      pattern:
        /公开|发布|披露|公示|对外公布|公布|上传|投稿|刊登|转载|传播|登在.{0,8}(?:报纸|杂志|网站|平台)上|登到.{0,8}(?:报纸|杂志|网站|平台)|交由.{0,8}(?:出版社|报社|媒体).{0,4}(?:刊发|发表|发布)|在群里发|发到(?:家庭|工作|同学|朋友)?群|发送至(?:家庭|工作|同学|朋友)?群|群发|放到网上|发到网上|发出去|拿去发/gu,
      label: () => "公开",
    },
    {
      kind: "display",
      pattern:
        /展示|展出|参展|进入.{0,12}(?:展览|影展)|用于.{0,8}(?:展览|影展)/gu,
      label: () => "展示",
    },
    {
      kind: "share",
      pattern:
        /分享|共享|给别人看|拿给别人看|给(?:我的?)?(?:朋友|同事|家人|同学)看|给(?!(?:我|我们|你|用户))[\p{Script=Han}A-Za-z·]{1,8}看|(?:发给|转给|传给|寄给|交给|转交给)[\p{Script=Han}A-Za-z·]{1,8}|发朋友圈/gu,
      label: () => "分享",
    },
    { kind: "forward", pattern: /转发|转送/gu, label: () => "转发" },
    { kind: "download", pattern: /下载/gu, label: () => "下载" },
    {
      kind: "copy",
      pattern:
        /复制|拷贝|复印|保存(?:一份|副本)|另存一份|备份(?:下来|一份)?|留(?:一|个)?份?副本|截图|截屏|扫描|翻拍|打印|抄录|刻成光盘|存储|存到(?:云盘|网盘)|存进(?:云盘|网盘)|同步到(?:服务器|云端|云盘|网盘)|印刷|印成册/gu,
      label: () => "复制",
    },
    {
      kind: "use",
      pattern:
        /使用|用于|商用|商业使用|做广告|用于广告|出售|售卖|卖掉|赚钱|盈利|获利|收取报酬|有偿使用|训练模型|拿.{0,8}训练/gu,
      label: () => "使用",
    },
    {
      kind: "adapt",
      pattern:
        /改编|二次创作|二创|加工成.{0,8}|做成.{0,8}(?:衍生作品|新作品|视频|短视频|图册|海报)|制作成.{0,8}(?:衍生作品|新作品|视频|短视频|图册|海报)|剪辑/gu,
      label: () => "改编",
    },
  ];
  return definitions
    .flatMap((definition) =>
      [...clause.matchAll(definition.pattern)].map((match) => ({
        kind: definition.kind,
        label: definition.label(match[0]),
        index: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      })),
    )
    .sort((left, right) => left.index - right.index || left.end - right.end);
}

function extractResources(text: string): ConsentResourceMention[] {
  return [...text.matchAll(CONTROLLED_RESOURCE)].map((match) => {
    const baseIndex = match.index ?? 0;
    const prefix = text.slice(0, baseIndex);
    const qualifier = prefix.match(
      /(?:\d{2,4}年(?:(?:拍摄|拍的|记录|形成)的?|的)?|第[\p{Script=Han}\p{N}]{1,6}(?:版|封)(?:的)?|(?:初始|初稿|初版|原始|最终|终版|定稿|修订|新版|旧版|电子|纸质|扫描)版?(?:的)?|(?:(?:婚礼|葬礼|毕业|旅行|家庭|工作)(?:上|时|当天)?(?:拍摄|拍的)?的?)|(?:红色|蓝色|绿色|黄色|黑色|白色)|(?:遗嘱|合同|协议|病历|诊疗|财务|版权|身份|论文))$/u,
    )?.[0];
    if (qualifier === undefined) {
      return { value: match[0], index: baseIndex };
    }
    return {
      value: `${qualifier}${match[0]}`,
      index: baseIndex - qualifier.length,
    };
  });
}

function classifyConsentStatus(
  clause: string,
  contextualCandidate: boolean,
  linkedContinuation: boolean,
): ThirdPartyConsentStatus | undefined {
  if (isConsentInferenceDisclaimer(clause)) return undefined;
  if (isConsentAssertionRetraction(clause)) return "pending";
  if (isNegatedConsentDenial(clause)) return "pending";
  if (isNegatedContextualGrantCompletion(clause)) return "pending";
  if (NEGATED_CONSENT_POLARITY.test(clause)) return "pending";
  if (CONDITIONAL_CONSENT_PREDICATE.test(clause)) return "pending";
  if (isConsentPropositionAgreement(clause)) return "pending";
  if (NEGATED_SCOPE_PROPOSITION.test(clause)) return "denied";
  if (
    /(?:决定|明确表示|正式表示).{0,8}不通过.{0,12}(?:申请|请求)/u.test(clause)
  ) {
    return "denied";
  }
  if (isPendingConsentRequestOrProcess(clause)) return "pending";
  if (isFutureConsentEvent(clause)) return "possible";
  if (
    /也许|可能|或许|大概|似乎|好像|不一定|未必|说不定|倾向于|我觉得|我认为|我以为|我猜|如果我没记错|应该(?:会)?|看起来|估计|八成|多半|恐怕|误传|传言|不实|这句话不对|说错了|^(?:如果|假如|要是|若)|(?:听说|据说|据[^，,。；;]{1,12}说)|(?:朋友|小林)说.{0,16}(?:姨妈|姑妈|舅妈|阿姨|外婆|奶奶|妈妈|爸爸|她|他).{0,12}(?:同意|允许|授权|许可|答应|愿意)|(?:群里有人|听[^，,。；;]{0,12})说.{0,16}(?:同意|允许|授权|许可|答应|愿意)|(?:希望|期望|盼望|建议|认为|相信|劝).{0,24}(?:同意|允许|授权|许可|答应|批准|准许)|(?:明天|后天|下周|下个月|稍后|晚点|过几天|到时候|预计).{0,10}(?:会|将会?|可能会?)?(?:同意|允许|授权|许可|答应|批准|准许)|等以后|以后|将来|未来/u.test(
      clause,
    ) ||
    isReportedThirdPartyConsent(clause)
  ) {
    return "possible";
  }
  if (REVOKED_CONSENT_PREDICATE.test(clause)) return "revoked";
  if (
    NEGATIVE_CONSENT_PREDICATE.test(clause) ||
    isScopedConsentDenial(clause, contextualCandidate || linkedContinuation)
  ) {
    return "denied";
  }
  if (AMBIGUOUS_ACQUIESCENCE_PREDICATE.test(clause) && contextualCandidate) {
    return "granted";
  }
  if (contextualCandidate && isContextualConsentDenial(clause)) {
    return "denied";
  }
  if (
    contextualCandidate &&
    /(?:不用|无需|不必).{0,8}(?:等|等待).{0,8}(?:确认|回复|答复)/u.test(clause)
  ) {
    return "granted";
  }
  if (
    PENDING_CONSENT_PREDICATE.test(clause) ||
    AMBIGUOUS_ACQUIESCENCE_PREDICATE.test(clause) ||
    (contextualCandidate && isContextualConsentDenial(clause)) ||
    /(?:是否|能否|可不可以|可以吗|愿意吗|同意吗|允许吗|授权吗)/u.test(clause) ||
    /以前|过去|曾经|曾|一度|当时|此前|之前|去年|当年|(?:同意|允许|授权|许可|答应|批准)过/u.test(
      clause,
    )
  ) {
    return "pending";
  }
  return hasAffirmativeSourcePermissionSignal(clause) ||
    (contextualCandidate && isContextualPermissionExecution(clause))
    ? "granted"
    : undefined;
}

function hasPermissionSignal(
  clause: string,
  contextualCandidate: boolean,
  linkedContinuation = false,
): boolean {
  return (
    hasAffirmativeSourcePermissionSignal(clause) ||
    NEGATIVE_CONSENT_PREDICATE.test(clause) ||
    REVOKED_CONSENT_PREDICATE.test(clause) ||
    PENDING_CONSENT_PREDICATE.test(clause) ||
    isNegatedConsentDenial(clause) ||
    isNegatedContextualGrantCompletion(clause) ||
    NEGATED_CONSENT_POLARITY.test(clause) ||
    CONDITIONAL_CONSENT_PREDICATE.test(clause) ||
    isScopedConsentDenial(clause, contextualCandidate || linkedContinuation) ||
    AMBIGUOUS_ACQUIESCENCE_PREDICATE.test(clause) ||
    (contextualCandidate && isContextualPermissionExecution(clause))
  );
}

function hasAffirmativeSourcePermissionSignal(clause: string): boolean {
  return (
    AFFIRMATIVE_CONSENT_PREDICATE.test(clause) ||
    /(?:说|表示|确认)(?:过)?(?:我|你|用户)(?:现在|已经)?(?:可以|能).{0,8}(?:单独看|私下看|查看|阅览|预览|看(?!见|展)|公开|发布|披露|公示|展示|展出|参展|分享|共享|转发|转送|下载|复制|拷贝|复印|使用|用于|改编|剪辑)/u.test(
      clause,
    ) ||
    /(?:说|表示|确认|回复(?:说)?).{0,12}(?:可以|能).{0,8}(?:单独看|私下看|查看|阅览|预览|看(?!见|展)|公开|发布|披露|公示|展示|展出|参展|分享|共享|转发|转送|下载|复制|拷贝|复印|使用|用于|改编|剪辑)/u.test(
      clause,
    ) ||
    SOURCE_CONSENT_GRANT_IDIOM.test(clause)
  );
}

function isContextualPermissionExecution(clause: string): boolean {
  if (isNegatedContextualGrantCompletion(clause)) return false;
  if (
    CONTEXTUAL_CONSENT_GRANT_IDIOM.test(clause) ||
    CONTEXTUAL_GRANT_INFERENCE.test(clause) ||
    /(?:不用|无需|不必).{0,8}(?:等|等待).{0,8}(?:确认|回复|答复)/u.test(clause)
  ) {
    return true;
  }
  if (
    /(?:她|他|姨妈|姑妈|舅妈|阿姨|外婆|奶奶|妈妈|爸爸).{0,4}愿意$/u.test(clause)
  ) {
    return true;
  }
  if (extractScopeActions(clause).length === 0) return false;
  return (
    /放心|没问题|没关系|随便|尽管|只管|直接|都行|就好|获准|得到许可|取得许可/u.test(
      clause,
    ) ||
    /想.{0,6}就/u.test(clause) ||
    /(?<![不没未])(?:可以|能)(?!否)/u.test(clause) ||
    /(?:那|你|用户|所以|现在|目前).{0,8}就/u.test(clause) ||
    /(?:拿去|发出去|发给|给别人看|放到网上|发到网上|发朋友圈|保存一份|留(?:一|个)?份?副本|截图|打印).{0,6}(?:吧|了|即可|就行)?$/u.test(
      clause,
    ) ||
    /(?:吧|即可|就行)$/u.test(clause)
  );
}

function isNegatedContextualGrantCompletion(clause: string): boolean {
  return /(?:没有|没|未|尚未|并未|不是|并非|不曾|从未).{0,10}(?:肯定答复|拍板|认可|应承|通过|准予|核准|核发|确认|批准|获批|放行|生效|查看权|权限|绿灯)/u.test(
    clause,
  );
}

function isNegatedConsentDenial(clause: string): boolean {
  return /(?:没有|没|未|尚未|并未|不是|并非|不曾|从未).{0,8}(?:拒绝|否决|不同意|不允许|不授权|不许可|不答应|不准(?:许)?|不许)/u.test(
    clause,
  );
}

function isContextualConsentDenial(clause: string): boolean {
  return /^(?:(?:后来|现在|目前)?(?:她|他|对方|姨妈|姑妈|妈妈|爸爸)?(?:明确|正式)?)(?:拒绝|否决)(?:了)?[！!。.]?$/u.test(
    clause,
  );
}

function isScopedConsentDenial(
  clause: string,
  contextualCandidate: boolean,
): boolean {
  return (
    /(?:不同意|不允许|不授权|不许可|不答应|不愿意|不准(?:许)?|不许|拒绝|禁止|不得|无权|别|停止|放弃|否决).{0,12}(?:查看|阅览|预览|阅读|审阅|浏览|打开|检查|看(?!见|展)|公开|发布|披露|展示|展出|分享|共享|转发|下载|复制|拷贝|复印|保存|备份|扫描|截图|截屏|翻拍|打印|使用|改编)/u.test(
      clause,
    ) ||
    /(?:明确|正式)?(?:说|表示|要求).{0,6}(?:我|你|用户)?(?:不得|不可|不能|不可以).{0,6}(?:查看|看(?!见|展)|公开|发布|披露|展示|展出|分享|共享|转发|下载|复制|拷贝|复印|保存|备份|扫描|截图|截屏|翻拍|打印|使用|改编)/u.test(
      clause,
    ) ||
    (contextualCandidate &&
      /^(?:(?:所以|因此|但是|但|不过|然而|目前|现在|你|用户).{0,4})?(?:不得|不可|不能|不可以|不要|不(?=查看|看|公开|发布|披露|展示|展出|分享|共享|转发|下载|复制|保存|使用|改编)).{0,6}(?:查看|看(?!见|展)|公开|发布|披露|展示|展出|分享|共享|转发|下载|复制|拷贝|复印|保存|备份|扫描|截图|截屏|翻拍|打印|使用|改编)/u.test(
        clause,
      )) ||
    /(?:查看|公开|发布|展示|分享|转发|下载|复制|拷贝|复印|保存|备份|扫描|截图|截屏|翻拍|打印|使用|改编).{0,4}(?:不行|不可以|不能)/u.test(
      clause,
    )
  );
}

function isConsentInferenceDisclaimer(clause: string): boolean {
  return (
    /(?:不等于|不代表|不意味着|不能说|不能确定|无法确认|不能证明|无法证明|没有证据(?:表明|证明)|不足以(?:证明|说明)|别当作|别当成|不要当作|不要当成|不能当作|不能当成|不能算|算不上|尚不能视为|不能推出|不能据此|不说明|还不是|并不是|并非|不是).{0,18}(?:同意|允许|授权|许可|答应|获准|权限|公开|分享|转发)/u.test(
      clause,
    ) ||
    /(?:别|不要|不能|不应).{0,6}(?:假设|假定|认定|断言).{0,16}(?:同意|允许|授权|许可|答应|获准)/u.test(
      clause,
    ) ||
    /(?:问题|证据|信息|表述|说法|这句话|当前表述)?(?:里|中)?(?:没有|缺少|不存在|无).{0,8}(?:授权|同意|许可).{0,6}(?:证据|依据|证明)/u.test(
      clause,
    )
  );
}

function isLinkedConsentContinuation(clause: string): boolean {
  return /^(?:所以|因此|但是|但|不过|然而|却|而是|更正|纠正|而且|并且|同时|另外|此外|顺便|也|又|还|目前|现在|内容是|范围是|之前|后来|原本|仍然|不|没|未|拒绝|禁止|不得|无权|不准|不许|别|停止|放弃|否决|撤回|收回|取消|同意|允许|授权|许可|答应|可以|能)/u.test(
    clause,
  );
}

function isAffirmativeGrantContinuation(clause: string): boolean {
  return /^(?:(?:我|我们|你|你们|用户)(?:现在|已经|终于)?(?:也|就|都)?(?:可以|能)|(?:内容|范围)是)/u.test(
    clause,
  );
}

function isConditionalGrantContinuation(clause: string): boolean {
  return /^(?:(?:我|我们|你|你们|用户)(?:才|方)?(?:可以|能|能否)|(?:才|方)?(?:可以|能|方可|方能|才能)|就(?:可以|能))/u.test(
    clause,
  );
}

function isConsentMetaContinuation(clause: string): boolean {
  return (
    isConsentInferenceDisclaimer(clause) ||
    isConsentAssertionRetraction(clause) ||
    /(?:刚才|前面|上一轮).{0,12}(?:说错|说成|误解|误写)|(?:更正|纠正).{0,16}(?:同意|允许|授权|许可)/u.test(
      clause,
    ) ||
    /^(?:我再(?:告诉你|说|回复)|有(?:回复|确认)后我再(?:告诉你|说)|等(?:回复|确认)后再说)/u.test(
      clause,
    )
  );
}

function isIgnorableConsentDiscourse(clause: string): boolean {
  return /^(?:更正一下|更正|纠正一下|纠正|准确地说|也就是说|所以|因此|总之|老实说|坦白讲|截至目前|最新情况是|刚才说错了|我只是把边界说准|更新一下|关于这件事|有个情况|顺带一提|顺便说一句|说到(?:这件事)?|那份|这份)$/u.test(
    clause,
  );
}

function isEpistemicConsentLeadIn(clause: string): boolean {
  return /^(?:据说|据(?:转发)?消息|据[^，,。；;]{1,12}(?:说|表示|转述|称)|根据[^，,。；;]{1,12}(?:的)?转述|听说|如果我没记错|我记得可能|我以为|我猜|群里有人说|听[^，,。；;]{1,12}说)$/u.test(
    clause,
  );
}

function isIndirectReporterLeadIn(
  clause: string,
  nextClause: string | undefined,
): boolean {
  if (nextClause === undefined) return false;
  const reporter = clause.match(
    /^([\p{Script=Han}A-Za-z·]{1,8})(?:说|表示|转述|称)$/u,
  )?.[1];
  if (reporter === undefined) return false;
  const nextSubjects = [...nextClause.matchAll(KNOWN_THIRD_PARTY_SUBJECT)]
    .map((match) => match[0])
    .filter((subject) => !isPronominalSubject(subject));
  const nextGrantor = nextSubjects[0];
  return (
    nextGrantor !== undefined &&
    consentKeyPart(nextGrantor) !== consentKeyPart(reporter)
  );
}

function isAffirmativeConsentLeadIn(clause: string): boolean {
  if (
    NEGATED_CONSENT_POLARITY.test(clause) ||
    NEGATIVE_CONSENT_PREDICATE.test(clause) ||
    /(?:没有|没|未|并未|不曾|从未|否认|不承认).{0,12}(?:同意|允许|授权|许可|答应|批准|准许|行|可以)/u.test(
      clause,
    )
  ) {
    return false;
  }
  return /(?:口头)?(?:回复)?说(?:了)?(?:没问题|行|可以)[“”"「」『』]?$|(?:同意|允许|授权|许可|答应|批准)(?:了)?[“”"「」『』]?$|批(?:下来|下去)(?:了)?[“”"「」『』]?$|给了?.{0,8}(?:书面|口头)?(?:授权|许可)[“”"「」『』]?$|(?:批准|通过)了?.{0,12}(?:申请)[“”"「」『』]?$/u.test(
    clause,
  );
}

function isConditionalConsentLeadIn(clause: string): boolean {
  return /^(?:只有|除非|待|等|(?:需|须)?经|要(?:先)?|得到|取得|拿到|征得|获得).{0,24}(?:同意|允许|授权|许可|答应|批准|准许)(?:之后|以后|后)?$/u.test(
    clause,
  );
}

function isPendingConsentRequestOrProcess(clause: string): boolean {
  return /(?:正在)?(?:争取|请求|请|要求|催促).{0,24}(?:同意|允许|授权|许可|答应|批准|准许)|正在考虑.{0,16}(?:批准|准许|通过)/u.test(
    clause,
  );
}

function isReportedThirdPartyConsent(clause: string): boolean {
  const grantor =
    "姨妈|姑妈|舅妈|婶婶|伯母|阿姨|外婆|奶奶|妈妈|母亲|爸爸|父亲|姐姐|妹妹|哥哥|弟弟|伴侣|配偶|朋友|同事|老师|医生|作者|受访者|被摄者|当事人|她|他|对方";
  return new RegExp(
    `(?:(?:据[^，,。；;]{1,10}(?:说|表示|转述|称)?)|(?:(?:有人|群里|消息|传闻|[\\p{Script=Han}A-Za-z·]{1,8})(?:说|表示|转述|称))).{0,18}(?:${grantor}).{0,16}(?:(?:同意|允许|授权|许可|答应|批准|准许|愿意)|(?:说|回复说).{0,4}(?:可以|能))`,
    "u",
  ).test(clause);
}

function isConsentPropositionAgreement(clause: string): boolean {
  return (
    /(?:同意|允许|批准).{0,4}[“"「『].{0,24}(?:公开|发布|查看|看|分享|转发|下载|复制|使用|改编).{0,24}[”"」』](?:这一?)?(?:判断|观点|看法|规定|决定|说法|提议|主张)?/u.test(
      clause,
    ) ||
    /(?:同意|允许|批准).{0,28}(?:不是好主意|会侵犯|会泄露|不应|严禁|禁止|放弃|否决).{0,16}(?:判断|观点|看法|规定|决定|说法|提议|主张)?$/u.test(
      clause,
    ) ||
    /(?:同意|允许|批准).{0,28}(?:查看|阅览|预览|看过?|公开|发布|展示|分享|转发|下载|复制|使用|改编).{0,16}(?:很重要|有意义|这个事实|这一事实|这个判断|这一判断|这个观点|这一观点|这个说法|这一说法)$/u.test(
      clause,
    ) ||
    /(?:同意|允许|批准).{0,24}(?:反对|质疑|否认|撤销|撤回|取消|否决|放弃|说|认为|主张).{0,12}(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编)/u.test(
      clause,
    ) ||
    /(?:同意|允许|批准).{0,18}(?:不该|不应|不宜|不能|不可以).{0,10}(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编)/u.test(
      clause,
    ) ||
    /(?:撤销|废止|取消).{0,16}(?:不许|不准|禁止|不得|不可|不能).{0,12}(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编).{0,12}(?:规定|条款|要求|禁令)/u.test(
      clause,
    ) ||
    /(?:同意|允许|批准).{0,32}(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编).{0,18}(?:的)?(?:次数太多|次数太少|是不对的|不正确|不妥|不合适|不应该|不该|的规定|的看法|的观点|的判断|的说法|的议题|的主张|的评价)$/u.test(
      clause,
    ) ||
    /(?:同意|允许|批准)(?:了)?.{0,16}(?:关于|对于|针对|提出的).{0,18}(?:查看|阅览|预览|看|公开|发布|展示|分享|转发|下载|复制|使用|改编).{0,18}(?:规定|看法|观点|判断|说法|议题|主张|评价)$/u.test(
      clause,
    )
  );
}

function isConsentAssertionRetraction(clause: string): boolean {
  return /(?:那|这)(?:是)?我说错了|(?:同意|允许|授权|许可|答应).{0,24}(?:说法|消息|理解|传闻).{0,10}(?:不对|不准确|有误|错误|是假的|不是真的)|所谓.{0,24}(?:同意|允许|授权|许可|答应).{0,16}(?:误会|误传|传言|不实)|我误以为.{0,24}(?:同意|允许|授权|许可|答应)|(?:同意|允许|授权|许可|答应).{0,20}(?:才怪|其实是误会)|(?:这|那)句话(?:不对|不准确)|只是(?:误传|传言)|并不属实|消息(?:不实|未经证实)|说法不是真的|(?:后来)?(?:更正|纠正)(?:为|成)?(?:没有|没|未|并未|不是|并非).{0,6}(?:同意|允许|授权|许可|答应|批准|准许)/u.test(
    clause,
  );
}

function isFutureConsentEvent(clause: string): boolean {
  const predicate =
    /(?:同意|允许|授权|许可|答应|批准|准许|给.{0,6}(?:权限|许可)|通过.{0,8}申请)/u;
  const predicateIndex = clause.search(predicate);
  if (predicateIndex < 0) return false;
  const eventPrefix = clause.slice(0, predicateIndex);
  return /(?:会|将|将会|准备|打算|计划|预计|很快|稍后|过会儿|周末|明天|后天|下周|下个月|晚点|过几天|到时候).{0,10}$/u.test(
    eventPrefix,
  );
}

function isInvalidatingConsentLeadIn(clause: string): boolean {
  return /^(?:不能|不应|无法)因为.{0,24}(?:同意|允许|授权|许可|答应).*(?:就|便)?$/u.test(
    clause,
  );
}

function isAmbivalentConsentLeadIn(clause: string): boolean {
  return (
    extractScopeActions(clause).length === 0 &&
    /(?:没有|没|未|尚未|并未).{0,10}(?:表示|说明|确认|说).{0,6}(?:同意|允许|授权|许可|答应|批准|不允许|不同意|拒绝)$/u.test(
      clause,
    )
  );
}

function isConsentTopicLeadIn(clause: string): boolean {
  return (
    /^(?:说到|关于|至于|那份|这份|提到).{0,20}(?:修复稿|预览稿|预览|底片|照片|相片|影像|肖像|原件|文件|资料|内容|作品|稿件|录音|录像|视频|信件|书信|日记|档案|数据|名字|姓名|联系方式|邮件)$/u.test(
      clause,
    ) ||
    (extractResources(clause).length > 0 &&
      /(?:姨妈|姑妈|舅妈|婶婶|伯母|阿姨|外婆|奶奶|妈妈|母亲|爸爸|父亲|姐姐|妹妹|哥哥|弟弟|朋友|同事|老师|医生|作者|受访者|被摄者|当事人|她|他|对方)的/u.test(
        clause,
      ))
  );
}

function hasIndependentMixedIntent(clause: string): boolean {
  if (
    /(?:另外|此外|顺便|同时|并请|还请).{0,24}(?:提醒|安排|记录|预约|联系|创建|取消|改期)|(?:提醒我|帮我安排|请.{0,6}提醒).{0,24}(?:今天|明天|明早|后天|周|星期|\d{1,2}[点:：])/u.test(
      clause,
    )
  ) {
    return true;
  }
  return [
    ...clause.matchAll(
      /(?:并且|而且|同时|另外|此外|顺便|并(?=记住|谢谢|请|提醒|安排|记录|告诉|联系))/gu,
    ),
  ].some((match) => {
    const suffix = clause.slice((match.index ?? 0) + match[0].length).trim();
    return (
      suffix !== "" &&
      extractScopeActions(suffix).length === 0 &&
      !hasPermissionSignal(suffix, false) &&
      !isConsentMetaContinuation(suffix)
    );
  });
}

function isConsentQuestionClause(clause: string): boolean {
  if (
    /(?:吗|么)[！？!?]?$/u.test(clause) ||
    /[？?]$/u.test(clause) ||
    /(?:同不同意|允不允许|愿不愿意|答不答应|是不是同意|让不让)/u.test(clause) ||
    /(?:同意|允许|授权|许可|答应|愿意|让|给).{0,20}吧[！!。.]?$/u.test(
      clause,
    ) ||
    /^(?:请问|你觉得|你认为|怎样|怎么|如何|为什么)/u.test(clause)
  ) {
    return true;
  }
  if (PENDING_CONSENT_PREDICATE.test(clause)) return false;
  return /(?:是否|能否|会不会|有没有|可不可以|可否).{0,24}(?:同意|允许|授权|许可|答应|愿意|有权|获准|查看|看|公开|发布|展示|分享|转发|下载|复制|使用|改编|寄给|交给|发给|转给)/u.test(
    clause,
  );
}

function looksLikeConsentFollowUp(text: string): boolean {
  const normalized = normalizeConsentText(text);
  if (!splitConsentClauses(normalized).some(isConsentQuestionClause)) {
    return false;
  }
  return (
    /^(?:那|所以|后来|现在|目前)?(?:她|他|对方)?(?:同意|允许|授权|许可|答应|回复|答复|确认)(?:了)?(?:吗|么|没有|没)[？?！!。.]?$/u.test(
      normalized,
    ) ||
    /^(?:那|所以|后来|现在|目前)?(?:她|他|对方)?(?:有|有没有)(?:回复|答复|结果|消息)(?:了)?(?:吗|么|没有|没)?[？?！!。.]?$/u.test(
      normalized,
    ) ||
    (extractResources(normalized).length > 0 &&
      extractScopeActions(normalized).length > 0)
  );
}

function consentStateFollowUpStatus(
  text: string,
): ThirdPartyConsentStatus | undefined {
  const normalized = normalizeConsentText(text);
  const match = normalized.match(
    /^(?:(?:后来|现在|目前|刚刚|刚才)(?:她|他|对方)?|(?:她|他|对方))(?:已经|明确|正式|终于|还是|又)?(.+)$/u,
  );
  if (match === null) return undefined;
  const answer = match[1]!;
  if (/^(?:确认|回复|答复)(?:过)?了?$/u.test(answer)) return "pending";
  if (
    /^(?:还没|尚未|没有|没)(?:明确)?(?:同意|允许|授权|答应|确认|回复|答复)$/u.test(
      answer,
    )
  )
    return "pending";
  if (/^(?:不同意|不允许|不答应|拒绝|否决)(?:了)?$/u.test(answer))
    return "denied";
  if (/^(?:撤回|收回|撤销|取消)(?:了)?(?:授权|许可)?(?:了)?$/u.test(answer))
    return "revoked";
  if (
    /^(?:(?:回复|答复|说|确认)(?:说)?(?:可以|同意|允许|行)|同意|允许|授权|答应|批准|准许|首肯)(?:了)?$/u.test(
      answer,
    )
  )
    return "granted";
  return undefined;
}

function isRhetoricalGrantQuestion(clause: string): boolean {
  return (
    /^(?:(?:不是|难道)(?:.{0,20}(?:不是|已经|早就))?.{0,12}|这不就(?:说明|证明).{0,16}|(?:她|他|对方).{0,8}(?:明明|都).{0,8})(?:已经|早就|明明)?(?:同意|允许|授权|许可|答应)|^(?:不是说|难道不是).{0,20}(?:同意|允许|授权|许可|答应)/u.test(
      clause,
    ) ||
    /(?:不是(?:都|已经|早就|明确)?.{0,10}(?:同意|允许|授权|许可|答应).{0,8}(?:吗|么)|(?:这|那)?还不算(?:同意|授权|许可).{0,4}(?:吗|么)|怎么(?:会)?不算.{0,8}(?:同意|授权|许可)|都(?:已经)?点头了?.{0,8}还不算(?:同意|授权)|权限(?:都|已经)?有了?.{0,10}还不能)/u.test(
      clause,
    )
  );
}

function isConsentConstraintExpansion(
  authoritativeText: string,
  authoritativeClaims: readonly ThirdPartyConsentClaim[],
  candidateClause: string,
): boolean {
  if (
    isConsentQuestionClause(candidateClause) ||
    isConsentInferenceDisclaimer(candidateClause) ||
    CONDITIONAL_CONSENT_PREDICATE.test(candidateClause) ||
    /(?:也许|可能|或许|大概|似乎|好像|不一定|未必|说不定|仍待|还待|需要等|要等)/u.test(
      candidateClause,
    )
  ) {
    return false;
  }
  const restrictions = new Set(
    authoritativeClaims.flatMap((claim) => claim.restrictions ?? []),
  );
  if (
    restrictions.has("time:today") &&
    /(?:(?:明天|以后|今后|明年|长期|永久|一直|随时).{0,12}(?:看|查看|公开|分享|转发|使用|也行|可以|能)|有效期.{0,4}(?:不限|永久|长期))/u.test(
      candidateClause,
    )
  ) {
    return true;
  }
  if (
    restrictions.has("count:once") &&
    /(?:不限次数|不设上限|无数遍|反复|多次|想看几次|每次)/u.test(
      candidateClause,
    )
  ) {
    return true;
  }
  if (
    restrictions.has("presence:grantor_required") &&
    /(?:不在场也行|不用.{0,8}陪|无需.{0,8}陪|可以单独|自己看|缺席.{0,8}(?:也|不).{0,8}(?:影响|可以|能))/u.test(
      candidateClause,
    )
  ) {
    return true;
  }
  if (
    restrictions.has("visibility:private") &&
    /(?:当众|公开场合|大家面前|所有人一起|你们(?:俩|两人)?都|大家都|(?:跟|和|与).{1,8}一起看|一起看)/u.test(
      candidateClause,
    )
  ) {
    return true;
  }
  const affirmativeCandidate =
    hasAffirmativeSourcePermissionSignal(candidateClause) ||
    isContextualPermissionExecution(candidateClause) ||
    CONTEXTUAL_CONSENT_GRANT_IDIOM.test(candidateClause) ||
    CONTEXTUAL_GRANT_INFERENCE.test(candidateClause);
  if (!affirmativeCandidate) return false;
  if (
    restrictions.has("commercial:prohibited") &&
    /(?:商用|商业|广告|有偿|出售|收费|盈利)/u.test(candidateClause)
  ) {
    return true;
  }
  const constrainedPurpose = [...restrictions].find((restriction) =>
    restriction.startsWith("purpose:"),
  );
  if (
    constrainedPurpose !== undefined &&
    /(?:广告|宣传|商用|商业|出售|训练|展览)/u.test(candidateClause) &&
    !candidateClause.includes(constrainedPurpose.slice("purpose:".length))
  ) {
    return true;
  }
  if (
    /(?:仅限|只限|只同意|仅同意).{0,12}(?:今天|今日|这次|一次)/u.test(
      authoritativeText,
    ) &&
    /(?:今后|以后|一直|随时|长期|永久|反复|每次|不限次数)/u.test(
      candidateClause,
    )
  ) {
    return true;
  }
  return (
    /(?:单独|私下|仅限[^，,。；;]{0,8}(?:看|查看))/u.test(authoritativeText) &&
    /(?:当众|公开场合|大家面前|所有人一起|你们(?:俩|两人)?都|大家都|(?:跟|和|与).{1,8}一起看|一起看)/u.test(
      candidateClause,
    )
  );
}

function isUnknownPermissionExpansion(clause: string): boolean {
  if (
    (isConsentQuestionClause(clause) && !isRhetoricalGrantQuestion(clause)) ||
    isConsentInferenceDisclaimer(clause) ||
    CONDITIONAL_CONSENT_PREDICATE.test(clause)
  ) {
    return false;
  }
  return /(?:没问题了?|已经放行|都说可以了?|随意处置|任意处置|没有任何(?:使用|用途|传播|处理)?限制|不会反对.{0,12}(?:公开|发布|分享|转发|使用)|想怎么(?:用|处理|处置)都行|任何方式都可以)/u.test(
    clause,
  );
}

function isConfirmationTagQuestion(clause: string): boolean {
  return /^(?:对不对|是不是|是吗|对吗|对吧|是吧|对么|不是吗|没错吧|好不好|真的吗)[？?！!。.]?$/u.test(
    clause,
  );
}

function hasConsentQueryPermissionSignal(clause: string): boolean {
  return (
    /(?:能|可以)?(?:让|给)(?:我|我们|你|用户).{0,10}(?:单独看|私下看|查看|阅览|预览|看(?!见|展)|公开|发布|展示|分享|转发|下载|复制|使用|改编)/u.test(
      clause,
    ) ||
    (/(?:我|我们|用户).{0,8}(?:能|能不能|能否|可以|可不可以)/u.test(clause) &&
      extractScopeActions(clause).length > 0 &&
      extractResources(clause).length > 0 &&
      resolveThirdPartySubject(clause, undefined).subject !== undefined) ||
    (/(?:我|我们|用户).{0,8}(?:是否|有没有|能否).{0,6}(?:有权|获准|得到许可|取得许可)/u.test(
      clause,
    ) &&
      extractScopeActions(clause).length > 0 &&
      extractResources(clause).length > 0 &&
      resolveThirdPartySubject(clause, undefined).subject !== undefined) ||
    (/(?:能不能|能否|可以|可不可以|可否|能|是否获准|有没有获准|能否获准).{0,16}(?:吗|么|没有|没|不)?[？?！!。.]?$/u.test(
      clause,
    ) &&
      extractResources(clause).some((resource) =>
        /^(?:姨妈|姑妈|舅妈|婶婶|伯母|阿姨|外婆|奶奶|妈妈|母亲|爸爸|父亲|姐姐|妹妹|哥哥|弟弟|朋友|同事|老师|医生|作者|受访者|被摄者|当事人|她|他|对方)的/u.test(
          resource.value,
        ),
      )) ||
    (/(?:需要|要).{0,12}(?:本人|她|他|对方)?(?:同意|允许|授权|许可|点头|确认).{0,4}(?:吗|么)?[？?！!。.]?$/u.test(
      clause,
    ) &&
      extractScopeActions(clause).length > 0 &&
      extractResources(clause).length > 0)
  );
}

function inspectCandidateConsentBoundary(input: {
  clause: string;
  authoritativeClaims: readonly ThirdPartyConsentClaim[];
  initialSubject?: string;
}): "safe" | "unsupported" | undefined {
  const disclaimer = isConsentInferenceDisclaimer(input.clause);
  const operationalBoundary =
    !NEGATIVE_CONSENT_PREDICATE.test(input.clause) &&
    !REVOKED_CONSENT_PREDICATE.test(input.clause) &&
    !/(?:说|表示|要求).{0,8}(?:不得|不可|不能|不可以|不要)/u.test(
      input.clause,
    ) &&
    isScopedConsentDenial(input.clause, true);
  if (!disclaimer && !operationalBoundary) return undefined;

  const fallbackScopes = input.authoritativeClaims.map(scopeFromClaim);
  const explicitScopes = extractConsentScopes(
    input.clause,
    fallbackScopes,
    true,
    [],
    true,
    false,
  );
  const targetScopes =
    explicitScopes.length > 0 ? explicitScopes : fallbackScopes;
  const resolvedSubject = resolveThirdPartySubject(
    input.clause,
    input.initialSubject,
  ).subject;
  const subjectKeys =
    resolvedSubject === undefined
      ? new Set(input.authoritativeClaims.map((claim) => claim.subjectKey))
      : new Set([consentKeyPart(resolvedSubject)]);
  const contradictsGrant = targetScopes.some((scope) =>
    input.authoritativeClaims.some(
      (claim) =>
        subjectKeys.has(claim.subjectKey) &&
        claim.scopeKind === scope.kind &&
        (scope.resource === UNRESOLVED_CONTEXT_RESOURCE ||
          consentResourceKey(claim.resource) ===
            consentResourceKey(scope.resource)) &&
        claim.status === "granted",
    ),
  );
  return contradictsGrant ? "unsupported" : "safe";
}

function isUnpermittedOperationalScope(
  clause: string,
  authoritativeClaims: readonly ThirdPartyConsentClaim[],
): boolean {
  if (
    isConsentQuestionClause(clause) ||
    isConsentInferenceDisclaimer(clause) ||
    CONDITIONAL_CONSENT_PREDICATE.test(clause) ||
    !/(?:刻成|存进|同步到|抄录|备份|另存|做成|制作成|交由|交给|转交|发送至|收取报酬|赚钱|盈利|获利|售卖|卖掉|出售|投稿|刊登|转载|传播)/u.test(
      clause,
    )
  ) {
    return false;
  }
  const scopes = extractConsentScopes(
    clause,
    authoritativeClaims.map(scopeFromClaim),
    true,
    [],
    true,
    false,
  );
  return scopes.some((scope) => {
    const supported = authoritativeClaims.find(
      (claim) =>
        claim.status === "granted" &&
        claim.scopeKind === scope.kind &&
        consentResourceKey(claim.resource) ===
          consentResourceKey(scope.resource) &&
        claim.beneficiaryKey === scope.beneficiaryKey,
    );
    if (supported === undefined) return true;
    const required = supported.restrictions ?? [];
    if (required.length === 0) return false;
    const stated = new Set(extractConsentRestrictions(clause));
    return required.some((restriction) => !stated.has(restriction));
  });
}

function isMetaLanguageRequest(text: string): boolean {
  return /^(?:请)?(?:翻译|分析|解释|改写|复述|测试|判断|识别|模拟|举例|引用|转述).{0,20}[“"「『].*(?:同意|允许|授权|许可|愿意).*[”"」』]/u.test(
    text,
  );
}

function isCompatibleConsentStatus(
  authoritative: ThirdPartyConsentStatus,
  proposed: ThirdPartyConsentStatus,
): boolean {
  if (authoritative === "possible" || authoritative === "pending") {
    return proposed === "possible" || proposed === "pending";
  }
  if (authoritative === "revoked") {
    return proposed === "revoked" || proposed === "denied";
  }
  return authoritative === proposed;
}

function preservesConsentRestrictions(
  authoritative: ThirdPartyConsentClaim,
  proposed: ThirdPartyConsentClaim,
): boolean {
  const required = authoritative.restrictions ?? [];
  if (required.length === 0) return true;
  if (proposed.status !== "granted") return true;
  const proposedRestrictions = new Set(proposed.restrictions ?? []);
  return required.every((restriction) => proposedRestrictions.has(restriction));
}

function normalizeCandidateSubjectKey(
  proposed: string,
  canonical: ReadonlySet<string>,
): string {
  return (proposed === consentKeyPart("她") ||
    proposed === consentKeyPart("他") ||
    proposed === consentKeyPart("她本人") ||
    proposed === consentKeyPart("他本人") ||
    proposed === consentKeyPart("对方")) &&
    canonical.size === 1
    ? [...canonical][0]!
    : proposed;
}

function isPronominalSubject(subject: string): boolean {
  return /^(?:她|他|她本人|他本人|对方)$/u.test(subject);
}

function scopeFromClaim(claim: ThirdPartyConsentClaim): ConsentScope {
  return {
    kind: claim.scopeKind,
    label: claim.scopeLabel,
    resource: claim.resource,
    ...(claim.beneficiary === undefined
      ? {}
      : {
          beneficiary: claim.beneficiary,
          beneficiaryKey: claim.beneficiaryKey,
        }),
    ...(claim.restrictions === undefined
      ? {}
      : { restrictions: [...claim.restrictions] }),
  };
}

function consentActivityResourceMatches(
  candidateResource: string,
  authoritativeResource: string,
): boolean {
  const candidateKey = consentResourceKey(candidateResource);
  const authoritativeKey = consentResourceKey(authoritativeResource);
  if (candidateKey === authoritativeKey) return true;
  const basePattern = new RegExp(`(?:${CONTROLLED_RESOURCE_SOURCE})$`, "u");
  const candidateBase = candidateResource.match(basePattern)?.[0];
  const authoritativeBase = authoritativeResource.match(basePattern)?.[0];
  return (
    candidateBase !== undefined &&
    candidateBase === authoritativeBase &&
    consentResourceKey(candidateResource) === consentResourceKey(candidateBase)
  );
}

function canonicalizeConsentResourceOwner(
  resource: string,
  subject: string,
): string {
  return isPronominalSubject(subject)
    ? resource
    : resource.replace(/^(?:她|他|对方)的/u, `${subject}的`);
}

function normalizeConsentText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function consentKeyPart(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80);
}

function consentResourceKey(value: string): string {
  return consentKeyPart(
    value
      .replace(/相片/gu, "照片")
      .replace(/影像/gu, "照片")
      .replace(/书信/gu, "信件")
      .replace(/录像/gu, "视频")
      .replace(/姓名/gu, "名字"),
  );
}

function collectStrings(
  value: unknown,
  output: string[],
  seen: Set<unknown>,
): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectStrings(item, output, seen);
  }
}
