import { independentConsentEvidenceText } from "./consent-modality.js";

export type EvidenceSubject =
  "user" | "character" | "third_party" | "unspecified";
export type EvidenceModality =
  "asserted" | "planned" | "conditional" | "negated" | "question" | "meta";
export type EvidenceValence = "positive" | "negative" | "mixed" | "neutral";
export type EvidenceActionKind =
  "initiated" | "advanced" | "completed" | "abandoned";

export interface LifeEvidenceClause {
  /** The exact normalized source clause, including quoted material. */
  sourceText: string;
  /** Quotes are inert for classification, but remain in sourceText. */
  classifyText: string;
  subject: EvidenceSubject;
  modality: EvidenceModality;
  action: boolean;
  outcome: boolean;
  reflection: boolean;
  pressureFeedback: boolean;
  actionKind: EvidenceActionKind;
  valence: EvidenceValence;
}

export interface LifeEvidenceAnalysis {
  sourceText: string;
  classifyText: string;
  clauses: LifeEvidenceClause[];
}

const ACTION_VERB =
  /提交|办理|报名|申请|搬走|搬家|分手|辞职|离职|答应|拒绝|开始做|完成|做完|办完|做了|去了|联系|签(?:了|约|署)|取消|执行|行动|发(?:出|给|了)|提出|确认|启动|出门|回来|走完|散步|画(?:了|完)|补(?:了|完)|涂(?:了|完)|蹭(?:了|完)|放下|拿起|停下|摊开|收起/u;
const COMPLETED_TIME =
  /已经|刚刚|刚才|刚(?=\S)|后来|今天|昨晚|昨天|最终|正式|确实|实际/u;
const FUTURE =
  /明天|后天|下周|下个月|^(?:我|我们|你)?以后|将来|未来|下次|回头(?!看)|接下来|头两周/u;
const INTENTION =
  /打算|计划|准备|想要|考虑|期待|希望|安排是|决定(?=提交|办理|报名|申请|搬|分手|辞职|离职|联系|执行|行动|出门)|想(?=提交|办理|报名|申请|搬|分手|辞职|离职|联系|执行|行动|出门)|(?:我|我们|你)(?:今天|现在)?(?:会|将)|(?:^|还|也|就)(?:会|将)(?=把|去|提交|执行|出门)|要先|先去|等.{0,16}(?:再|才)|先(?:看|观察|盯|等|跟进|考虑).{0,12}(?:执行|行动|结果|是否|是不是)/u;
const UNCERTAIN =
  /^(?:如果|假如|要是|若|万一|假设)|可能|也许|或许|预计|(?<!比)预期/u;
const META =
  /(?:请|帮我).{0,12}(?:翻译|改写|复述|朗读|解释这句话)|(?:假装|扮演|模拟)(?:一下)?(?:我|你|用户|角色)|请.{0,16}(?:区分|回顾|总结).{0,40}(?:决定|行动|结果)|按顺序回顾|哪条消息.{0,24}(?:证明|行动|结果)|原文|据说|听说|传闻|转述/u;
const EXAMPLE_FRAME =
  /(?:只是|这是|仅为)(?:一个|个)?(?:例句|例子|示例|反例)|(?:测试|练习)(?:文本|句子)|场景设定|举例来说/u;
const NON_OCCURRENCE =
  /(?:还没|没有|尚未|并未|从未|不会|不等于|没)(?:有)?[^，,。；;就便却]{0,12}(?:提交|办理|报名|申请|搬|分手|开始|完成|联系|签|执行|行动|发邮件|辞职|答应|出门|回来|画|补|涂|蹭|放下|拿起)|(?:只是|仍是).{0,8}(?:计划|打算)|事实没有变化|没有新的确认/u;
const NEGATED_STATE_CHANGE =
  /(?:还没|没有|尚未|并未|并不|不是).{0,8}(?:好(?:多|些)了|轻松|松快|安静|放松|踏实|更难受|更糟|缓解|减轻|退了|少了)|并没有.{0,8}(?:成功|同意|通过)/u;
const PENDING_RESULT =
  /(?:还没|尚未|没有|并未).{0,12}(?:最终结果|结果|反馈|确认|同意|通过|成功|收到)|(?:仍然|仍)不是最终结果|只有行动.{0,8}没有结果|事实没有变化|没有新的确认/u;
const REFLECTION =
  /回头看|现在想想|我觉得这个决定|我对这个选择|我后悔|我很庆幸|我才明白|我想明白|我(?:现在)?的理解是|重新想/u;
const PRESSURE_FEEDBACK =
  /好多了|轻松(?:多|些|了)|松快(?:了|些)|安静了(?:一些|不少|一点)?|没那么(?:焦虑|难受|乱)|想清楚了|清楚多了|被(?:你)?听见|被理解|谢谢你.*(?:听|陪)|更焦虑|更难受|更糟|还是很乱|完全没用|压力更大|没(?:有)?被(?:听见|理解)|(?:嗡嗡(?:声)?|紧绷|焦虑|压力|难受).{0,16}(?:退了|小了|少了|松了|减轻|缓解|散了|没了)|(?:心里|脑子|身体|整个人).{0,12}(?:松快|轻松|安静|放松|踏实)(?:了|些)|松了(?:一)?口气/u;
const ACTUAL_OUTCOME =
  /(?:同意|拒绝|通过|失败|成功)(?:了|的通知|的结果)|(?:结果|后来|因此|所以|最终|现在).{0,28}(?:同意|拒绝|通过|失败|成功|变得|让我|轻松|开心|难受|后悔|更好|更糟|有了)|拿到(?:了)?.{0,16}(?:岗位|职位|录用|批准|许可)|(?:收到|收到了).{0,16}(?:录用|拒绝|批准|通过|失败|结果|通知)|几天后的结果是|这是混合结果|出现的实际反馈|收入比.{0,12}(?:少|多)|薪资.{0,12}(?:降低|提高)/u;

/**
 * Extracts reported events, not instructions to perform them. Sentence and
 * clause boundaries limit tense, subject and negation; one future plan must
 * not erase an independent completed action elsewhere in the message.
 */
export function analyzeLifeEvidence(text: string): LifeEvidenceAnalysis {
  const sourceText = independentConsentEvidenceText(text)
    .normalize("NFKC")
    .replace(/[^\S\n]+/gu, " ")
    .trim();
  const classifyText = maskEvidenceQuotes(sourceText);
  const clauses: LifeEvidenceClause[] = [];
  let inheritedSubject: EvidenceSubject = "unspecified";
  let inheritedOrganization = false;
  for (const sentence of alignedParts(
    sourceText,
    classifyText,
    /[。.!！？?\n]+/gu,
  )) {
    const question = /[?？]/u.test(sentence.separator);
    const sentenceExample = EXAMPLE_FRAME.test(sentence.classifyText);
    let conditional = false;
    let planned = false;
    let reflectionFrame = false;
    let metaFrame = false;
    for (const clause of alignedParts(
      sentence.sourceText,
      sentence.classifyText,
      /[，,；;：:]+/gu,
    )) {
      const value = clause.classifyText.trim();
      if (!value) continue;
      const freshSubject = explicitSubject(value);
      if (freshSubject !== undefined) {
        inheritedSubject = freshSubject.subject;
        inheritedOrganization = freshSubject.organization;
      }
      const independentPivot =
        /^(?:另外|此外|另一个话题|不过我|但我|而我|而且我|然后我)/u.test(value);
      if (independentPivot) {
        conditional = false;
        planned = false;
        metaFrame = false;
      }
      metaFrame ||= META.test(value);
      if (UNCERTAIN.test(value)) conditional = true;
      if (FUTURE.test(value) || INTENTION.test(value)) planned = true;
      // Explicit actual-time assertions can start a new independent event.
      if (
        COMPLETED_TIME.test(value) &&
        !INTENTION.test(value) &&
        !FUTURE.test(value)
      )
        planned = false;
      const subject = inheritedSubject;
      const reflection = REFLECTION.test(value);
      reflectionFrame ||= reflection;
      let modality: EvidenceModality =
        sentenceExample ||
        metaFrame ||
        /^(?:请|别|不要|不用|不必)(?!担心)/u.test(value)
          ? "meta"
          : question || /是否|有没有|(?:吗|么)$|是不是/u.test(value)
            ? "question"
            : conditional
              ? "conditional"
              : planned && !reflection
                ? "planned"
                : NON_OCCURRENCE.test(value) || NEGATED_STATE_CHANGE.test(value)
                  ? "negated"
                  : "asserted";
      // Asking somebody else for reflection is not the speaker reflecting.
      if (/你现在怎么看|有没有改变你|如何理解自己的选择/u.test(value))
        modality = "question";
      const asserted = modality === "asserted";
      const actorAllowed = subject !== "third_party";
      const feedback =
        asserted && actorAllowed && PRESSURE_FEEDBACK.test(value);
      const action =
        asserted &&
        actorAllowed &&
        !inheritedOrganization &&
        !reflectionFrame &&
        isOccurredAction(value);
      const outcome =
        asserted &&
        (actorAllowed || inheritedOrganization) &&
        !PENDING_RESULT.test(value) &&
        !reflectionFrame &&
        (ACTUAL_OUTCOME.test(value) || (feedback && hasStateChange(value)));
      clauses.push({
        sourceText: clause.sourceText.trim(),
        classifyText: value,
        subject: outcome && inheritedOrganization ? "unspecified" : subject,
        modality,
        action,
        outcome,
        reflection:
          asserted && subject !== "character" && actorAllowed && reflection,
        pressureFeedback: feedback && subject !== "character",
        actionKind: actionKind(value),
        valence: asserted ? evidenceValence(value) : "neutral",
      });
    }
    if (question || sentenceExample || metaFrame) {
      inheritedSubject = "unspecified";
      inheritedOrganization = false;
    }
  }
  return { sourceText, classifyText, clauses };
}

function isOccurredAction(text: string): boolean {
  if (!ACTION_VERB.test(text)) return false;
  if (
    /先(?:看|观察|盯|等|跟进|考虑).{0,12}(?:执行|行动|结果)|(?:打算|计划|准备|想要).{0,16}(?:做|去|执行|行动)|不是.{0,8}(?:已经|实际)/u.test(
      text,
    )
  )
    return false;
  if (
    /(?:已经|刚刚|刚才|刚|后来|今天|昨晚|昨天|最终|正式|确实|实际).{0,48}(?:提交|办理|报名|申请|搬走|搬家|分手|辞职|离职|答应了|拒绝了|开始做|完成|做了|去了|联系|签了|签约|签署|取消|执行|行动|发出|发给|发了|提出|确认|启动|出门|回来|散步)/u.test(
      text,
    )
  )
    return true;
  return /(?:出门|回来|走完)(?:了|一趟)?(?:$|[^\p{Script=Han}])|(?:散步|走路|跑步|运动|办事|买菜|上课)回来|(?:画|补|涂|蹭)(?:了|完).{0,12}(?:笔|线|画|颜色)|(?:把|将).{0,12}(?:笔|纸|画具|书|工具).{0,6}(?:放下|拿起|摊开|收起|停下)(?:了)?|(?:已经|刚才|刚刚).{0,12}(?:放下|拿起|停下|摊开|收起)/u.test(
    text,
  );
}

function hasStateChange(text: string): boolean {
  return /好多了|轻松多了|松快了|没那么(?:焦虑|难受|乱)|(?:退了|小了|少了|松了|减轻|缓解|散了|没了)|(?:心里|脑子|身体|整个人).{0,12}(?:安静|放松|踏实)了|更焦虑|更难受|更糟|压力更大/u.test(
    text,
  );
}

function actionKind(text: string): EvidenceActionKind {
  if (
    /完成|办完|做完|结束|落实|走完|(?:散步|走路|跑步|运动|办事|买菜|上课)回来/u.test(
      text,
    )
  )
    return "completed";
  if (/取消|放弃|没再继续|停下/u.test(text)) return "abandoned";
  if (/继续|推进|又做|第二步|(?:补|涂|画|蹭)了/u.test(text)) return "advanced";
  return "initiated";
}

/** Negated reassurance is not a negative result; negative states keep polarity. */
export function evidenceValence(text: string): EvidenceValence {
  if (/混合结果|不是纯好消息|好的一面和坏的一面/u.test(text)) return "mixed";
  const normalized = maskEvidenceQuotes(text).replace(
    /(?:别|不用|不要|不必|无需|没必要|没有|并未|并不|不是).{0,3}(?:担心|失败|拒绝|难受|更糟|后悔|失望|痛苦|损失|开心|成功|同意|通过)|没(?:有)?那么(?:焦虑|难受|乱)/gu,
    " ",
  );
  const negative =
    /失败|拒绝|难受|更糟|后悔|失望|痛苦|损失|不稳定|担心|变少|减少|延迟|麻木/u.test(
      normalized,
    );
  const positive =
    /成功|通过|同意|轻松|松快|开心|更好|庆幸|值得|满意|(?<!不)稳定|放心|动力|安静了|踏实了|(?:嗡嗡(?:声)?|紧绷|焦虑|压力).{0,16}(?:退了|小了|少了|松了|减轻|缓解|散了|没了)/u.test(
      normalized,
    ) || /没(?:有)?那么(?:焦虑|难受|乱)/u.test(text);
  return positive && negative
    ? "mixed"
    : positive
      ? "positive"
      : negative
        ? "negative"
        : "neutral";
}

export function evidenceSubject(
  analysis: LifeEvidenceAnalysis,
  kind: "action" | "outcome",
): EvidenceSubject {
  const subjects = new Set(
    analysis.clauses
      .filter((clause) => clause[kind])
      .map((clause) => clause.subject)
      .filter((subject) => subject !== "unspecified"),
  );
  return subjects.size > 1
    ? "third_party"
    : ([...subjects][0] ?? "unspecified");
}

function explicitSubject(
  text: string,
): { subject: EvidenceSubject; organization: boolean } | undefined {
  const clause = text.replace(
    /^(?:(?:另外|此外|但(?:是)?|不过|可是|而且|然后|随后|后来|今天|现在|目前|最终|正式|刚刚|刚才|这次|几天后|一周后)\s*)+/u,
    "",
  );
  if (
    /^(?:我(?:的)?(?:朋友|同事|家人|伴侣|父母|母亲|父亲)|朋友|同事|家人|伴侣|父母|母亲|父亲|老师|医生|经理|他|她)/u.test(
      clause,
    )
  )
    return { subject: "third_party", organization: false };
  if (/^(?:公司|团队|平台|对方|甲方|机构|学校)/u.test(clause))
    return { subject: "third_party", organization: true };
  if (/^(?:我|我们)/u.test(clause))
    return { subject: "user", organization: false };
  if (/^(?:你|角色)/u.test(clause))
    return { subject: "character", organization: false };
  return undefined;
}

function maskEvidenceQuotes(text: string): string {
  return [
    /“[^”]*”/gu,
    /‘[^’]*’/gu,
    /「[^」]*」/gu,
    /『[^』]*』/gu,
    /【[^】]*】/gu,
    /《[^》]*》/gu,
    /"[^"]*"/gu,
    /'[^']*'/gu,
    /\[[^\]]*\]/gu,
    /```[\s\S]*?```/gu,
    /`[^`]*`/gu,
  ].reduce(
    (masked, pattern) =>
      masked.replace(pattern, (quote) => " ".repeat(quote.length)),
    text,
  );
}

function alignedParts(
  source: string,
  classified: string,
  boundary: RegExp,
): Array<{ sourceText: string; classifyText: string; separator: string }> {
  const parts: Array<{
    sourceText: string;
    classifyText: string;
    separator: string;
  }> = [];
  let start = 0;
  for (const match of classified.matchAll(boundary)) {
    const index = match.index;
    parts.push({
      sourceText: source.slice(start, index),
      classifyText: classified.slice(start, index),
      separator: match[0],
    });
    start = index + match[0].length;
  }
  if (start < source.length)
    parts.push({
      sourceText: source.slice(start),
      classifyText: classified.slice(start),
      separator: "",
    });
  return parts;
}
