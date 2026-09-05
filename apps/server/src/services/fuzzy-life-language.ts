import type {
  DecisionRecord,
  DilemmaEpisode,
  LifeDomain,
  PressureEpisode,
  SupportMode,
} from "@personasim/contracts";

import { clamp01, inferDomain } from "./fuzzy-life-planning.js";
import { independentConsentEvidenceText } from "./consent-modality.js";

function analyzeDelegatedDecision(text: string): boolean {
  const sentences = semanticSentences(text);
  let delegated = false;
  for (const sentence of sentences) {
    let pendingAuthorization = false;
    let delegatedInSentence = false;
    let blockedBySentenceContext: SpeechContextBlock = "none";
    const segments = semanticSegments(sentence);
    for (const segment of segments) {
      const strongCurrentAuthorization = hasStrongCurrentAuthorization(segment);
      if (delegated && isFutureDelegationScopeLimit(segment)) {
        pendingAuthorization = false;
        continue;
      }

      const contextBlock = delegationContextBlock(segment);
      if (contextBlock !== "none") {
        const deniesDelegation = contextBlock === "delegation_denial";
        if (
          delegated &&
          isHardDelegationContextBlock(contextBlock) &&
          (deniesDelegation ||
            delegatedInSentence ||
            isCrossSentenceSemanticQualifier(segment))
        ) {
          delegated = false;
          delegatedInSentence = false;
        }
        blockedBySentenceContext = mergeDelegationContextBlock(
          blockedBySentenceContext,
          contextBlock,
        );
        pendingAuthorization = false;
        continue;
      }
      if (isDelegationRevocation(segment)) {
        delegated = false;
        delegatedInSentence = false;
        pendingAuthorization = false;
        continue;
      }

      if (
        canClearDelegationContext(
          blockedBySentenceContext,
          segment,
          strongCurrentAuthorization,
        )
      ) {
        blockedBySentenceContext = "none";
      }
      if (blockedBySentenceContext !== "none") continue;

      const authorizationTail = currentAuthorizationTail(segment);
      if (strongCurrentAuthorization && authorizationTail !== undefined) {
        if (hasDecisionActionScope(authorizationTail)) {
          delegated = true;
          delegatedInSentence = true;
          pendingAuthorization = false;
        } else {
          const tailBlock = delegationContextBlock(authorizationTail);
          if (isHardDelegationContextBlock(tailBlock)) {
            blockedBySentenceContext = tailBlock;
            pendingAuthorization = false;
          } else {
            pendingAuthorization = true;
          }
        }
        continue;
      }
      if (pendingAuthorization && hasDecisionActionScope(segment)) {
        delegated = true;
        delegatedInSentence = true;
        pendingAuthorization = false;
        continue;
      }

      if (authorizationTail !== undefined) {
        pendingAuthorization = true;
        if (hasDecisionActionScope(authorizationTail)) {
          delegated = true;
          delegatedInSentence = true;
          pendingAuthorization = false;
        }
        continue;
      }
      if (
        isDirectDelegation(segment) ||
        (pendingAuthorization && hasDecisionActionScope(segment))
      ) {
        delegated = true;
        delegatedInSentence = true;
        pendingAuthorization = false;
      }
    }
  }
  return delegated;
}

type SpeechContextBlock =
  | "none"
  | "historical"
  | "future_condition"
  | "utterance_meta"
  | "delegation_denial";

function semanticSentences(text: string): string[] {
  return semanticSentenceParts(text).map((sentence) => sentence.classifyText);
}

function semanticSegments(sentence: string): string[] {
  return splitAlignedText(
    sentence,
    sentence,
    /(?:[，,：:；;]+|(?<!不)(?=(?:但是|但(?!凡)|不过|可是|而是)\s*))/gu,
  )
    .map((segment) => segment.classifyText.trim())
    .filter((segment) => segment !== "");
}

interface SemanticTextPart {
  sourceText: string;
  classifyText: string;
}

function semanticSentenceParts(text: string): SemanticTextPart[] {
  const sourceText = text
    .normalize("NFKC")
    .replace(/[^\S\n]+/gu, " ")
    .trim();
  const classifyText = maskQuotedContent(sourceText).replace(
    /你说了算(?=\s*[?？])/gu,
    "是否如此",
  );
  return splitAlignedText(sourceText, classifyText, /[。.!！？?…\n]+/gu);
}

function semanticClauseParts(sentence: SemanticTextPart): SemanticTextPart[] {
  return splitAlignedText(
    sentence.sourceText,
    sentence.classifyText,
    /(?:[，,：:；;]+|(?<!不)(?=(?:但是|但(?!凡)|不过|可是|而是)\s*))/gu,
  );
}

function splitAlignedText(
  sourceText: string,
  classifyText: string,
  boundary: RegExp,
): SemanticTextPart[] {
  const parts: SemanticTextPart[] = [];
  let start = 0;
  for (const match of classifyText.matchAll(boundary)) {
    const index = match.index;
    const { sourceText: sourcePart, classifyText: classifyPart } =
      trimAlignedText(
        sourceText.slice(start, index),
        classifyText.slice(start, index),
      );
    if (sourcePart !== "" || classifyPart !== "") {
      parts.push({ sourceText: sourcePart, classifyText: classifyPart });
    }
    start = index + match[0].length;
  }
  const { sourceText: sourcePart, classifyText: classifyPart } =
    trimAlignedText(sourceText.slice(start), classifyText.slice(start));
  if (sourcePart !== "" || classifyPart !== "") {
    parts.push({ sourceText: sourcePart, classifyText: classifyPart });
  }
  return parts;
}

function trimAlignedText(
  sourceText: string,
  classifyText: string,
): SemanticTextPart {
  if (sourceText.length !== classifyText.length) {
    return {
      sourceText: sourceText.trim(),
      classifyText: classifyText.trim(),
    };
  }
  let start = 0;
  let end = sourceText.length;
  while (
    start < end &&
    /\s/u.test(sourceText[start]!) &&
    /\s/u.test(classifyText[start]!)
  ) {
    start += 1;
  }
  while (
    end > start &&
    /\s/u.test(sourceText[end - 1]!) &&
    /\s/u.test(classifyText[end - 1]!)
  ) {
    end -= 1;
  }
  return {
    sourceText: sourceText.slice(start, end),
    classifyText: classifyText.slice(start, end),
  };
}

function maskQuotedContent(text: string): string {
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
      masked.replace(pattern, (quoted) => " ".repeat(quoted.length)),
    text,
  );
}

function isDelegationRevocation(segment: string): boolean {
  if (isRecommendationOnlyModifier(segment)) return true;
  if (isAuthorityRevocationStatement(segment)) return true;
  return [
    /^(?:(?:但|不过|但是|可是|而且)\s*)?(?:(?:这次|现在|今天)\s*)?(?:我\s*)?(?:也\s*)?(?:你\s*)?(?:(?:先|暂时)\s*)?(?:不要|不用|不需要|无需|别|不能|不会|不再)\s*(?:你\s*)?(?:直接\s*)?(?:替我|代我|帮我|为我|你来|代选)/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:不要|别|不用|无需|不需要)\s*(?:再\s*)?(?:替我)?(?:作主|做主|自作主张)/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:你\s*)?(?:只能|只负责|只需要)\s*(?:帮我|替我)?(?:分析|比较|梳理|权衡)/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:(?:先|暂时)\s*)?(?:不要|别)\s*(?:现在\s*)?(?:(?:替我|代我|帮我|为我)\s*)?(?:作出|做出|作|做|下)?\s*(?:决定|选择|选(?!项))/u,
    /(?:没有|并未|不存在).{0,16}(?:授权|代选|替我|代我|你说了算)/u,
    /我.{0,6}(?:不想让|不愿让|不同意|不允许)(?:你)?(?:替我|代我|帮我|为我|代选)/u,
    /(?:不是|并非)\s*(?:在\s*)?(?:请你\s*)?(?:授权|代选|替我|代我|你说了算)/u,
    /(?:不等于|不代表).{0,24}(?:授权|代选|替我|代我|你说了算)/u,
    /^(?:也\s*)?(?:不要|别)因为.{0,32}(?:替我|代我|代选|你说了算)/u,
    /^(?:也\s*)?(?:不要|别).{0,16}(?:把|将).{0,24}(?:代选|替我|代我|你说了算)/u,
    /(?:撤回|取消).{0,12}(?:授权|代选)|收回.{0,12}(?:授权|决定权|选择权)|撤回(?:刚才|前面).{0,8}(?:的话|请求|委托)/u,
    /^(?:(?:等等|但|不过|但是|可是)\s*)?(?:不\s*)?(?:最终\s*)?(?:还是\s*)?我(?:最终\s*)?(?:还是\s*)?(?:自己|亲自)(?:来\s*)?(?:决定|选择|选)?(?:这件事|这个)?(?:吧|了)?$/u,
    /^(?:还是\s*)?我(?:还是\s*)?(?:自己|亲自)来(?:吧|了)?$/u,
    /(?:决定权|选择权).{0,10}(?:还是|仍然|依然)?(?:保留)?(?:在|归)(?:我|用户)/u,
    /(?:我|用户).{0,8}保留.{0,8}(?:最终)?(?:决定权|选择权)/u,
    /(?:最后|最终)\s*(?:还是\s*)?由我(?:自己)?(?:来)?(?:决定|选择|选)/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:还是\s*)?由我(?:自己)?(?:来)?(?:决定|选择|选)/u,
    /我\s*(?:会\s*)?(?:只\s*)?把(?:你(?:的)?(?:话|回答|意见|建议|选择)|它|这|这个).{0,12}(?:当作|当成|看作|当)(?:一条|一个)?建议/u,
    /(?:你的选择|你的话|你的回答|它|这|这个).{0,12}(?:只)?供(?:我)?参考/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:只|仅)?(?:当作|当成|看作|当)?(?:一条|一个)?建议$/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:只|仅)?供我参考$/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:你的)?(?:选择|意见|回答)?(?:只|仅)供(?:我)?参考$/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:只|仅)?是(?:一条|一个)?建议$/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:最后|最终)我(?:自己)?来(?:决定|选择|选|拍板)/u,
    /^(?:(?:但|不过|但是|可是)\s*)?(?:其实\s*)?(?:这次\s*)?我(?:只)?(?:想听|要听|想要)(?:一条|一个)?建议/u,
    /^(?:但|不过|可是)?\s*(?:这次\s*)?不是现在(?:再说)?$/u,
    /(?:这句话|这是|这个).{0,16}(?:举例|示例|例句|翻译|原句|错误示范)|^(?:是|只是).{0,12}(?:举例|示例|例句|翻译|原句|错误示范)$/u,
    /^(?:算了|我改主意了|先等等|等等|明天再说|以后再说|下次再说|改天再说)$/u,
  ].some((pattern) => pattern.test(segment));
}

function isFutureDelegationScopeLimit(segment: string): boolean {
  return /(?:不代表|不等于|不意味着).{0,24}(?:以后|未来|长期|每次|所有|一律|都).{0,24}(?:授权|替我|代我|代选|决定)|(?:以后|未来).{0,16}(?:都|一律).{0,16}(?:授权|替我|代我|代选|决定)|^(?:以后|未来)(?:是否|要不要).{0,24}(?:授权|请你|让你|替我|代我|帮我).{0,16}(?:再说|另说)|^(?:以后|未来)需要时.{0,20}(?:另行|重新)授权/u.test(
    segment,
  );
}

function delegationContextBlock(segment: string): SpeechContextBlock {
  if (isDelegationDenialContext(segment)) return "delegation_denial";
  if (isUtteranceMetaContext(segment)) return "utterance_meta";
  if (/^(?:如果|假如|要是|除非|若|万一|只要(?!听)|前提是)/u.test(segment)) {
    return isPastClarificationCondition(segment)
      ? "historical"
      : "future_condition";
  }
  if (hasStrongCurrentAuthorization(segment)) return "none";
  if (
    /^(?:明天|后天|下周|下个月|以后|将来|未来|下次)$|^(?:明天|后天|下周|下个月|过几天)(?:如果|假如|要是|若|万一)|^等(?:我|你|他|她|到)|^在.{0,24}(?:明天|后天|下周|下个月|以后|将来|未来|下次|还没|尚未|仍未).{0,24}(?:情况下|前提下|之前|之后|时)$|^(?:(?:或者|或|并且|且|同时)\s*)?(?:我|你|他|她)?.{0,16}(?:明天|后天|下周|下个月|以后|将来|未来|下次).{0,16}(?:(?:还|仍|尚)?(?:没|未)(?:回复|回应|回答|决定|选择|收到|回来|联系|确认)|(?:需要|才|再))|^(?:(?:或者|或|并且|且|同时)\s*)?(?:我|你|他|她)?(?:还没|尚未|仍未).{0,16}(?:回复|回应|回答|决定|选择|收到|回来|联系|确认)|^(?:后天|下周|下个月|过几天).{0,24}(?:如果|假如|要是|若|还没|尚未|仍未).{0,32}(?:授权|代选|替我|代我|帮我|为我|分析|比较|推荐|你来|由你|你说了算)|(?:明天|后天|下周|下个月|以后|将来|未来|下次|等.{0,24}(?:后|再)).{0,32}(?:授权|代选|替我|代我|帮我|为我|你来|由你|你说了算)/u.test(
      segment,
    )
  ) {
    return "future_condition";
  }
  if (hasCurrentDelegationPivot(segment)) return "none";
  if (
    /(?:还记得|记得)|^(?:上次|之前|过去|曾经|那次|刚才|刚刚|今天上午|今天早上|昨天|昨晚|前天|上周|上个月|去年)$|(?:上次|之前|过去|曾经|那次|刚才|刚刚|今天上午|今天早上|昨天|昨晚|前天|上周|上个月|去年).{0,32}(?:授权|代选|替我|代我|帮我|为我|你来|由你|你说了算)|(?:复述|回顾|总结|核对).{0,32}(?:授权|代选|替我|代我|你说了算|决定权|选择权)|(?:替我|代我|帮我|为我|你来).{0,16}(?:决定(?:过了?|了)(?:$|[吧啊呀])|(?:选择|选(?!项))(?:过|了).{0,16}(?:$|[吧啊呀]))/u.test(
      segment,
    )
  ) {
    return "historical";
  }
  return "none";
}

function isDelegationDenialContext(segment: string): boolean {
  if (isAuthorityRevocationStatement(segment)) return true;
  return /(?:这|这次|当前).{0,8}(?:不是|并非|不算).{0,12}授权|我.{0,8}(?:没有|并未|不|拒绝).{0,12}授权|(?:没有|并未|不存在|拒绝).{0,12}授权|(?:不等于|不代表).{0,16}授权|(?:不许|不准).{0,8}(?:你)?(?:替我|代我|帮我|为我|你来)|我.{0,6}(?:不想让|不愿让|不同意|不允许)(?:你)?(?:替我|代我|帮我|为我|代选)/u.test(
    segment,
  );
}

function isAuthorityRevocationStatement(segment: string): boolean {
  return /(?:我\s*)?(?:反悔了?|收回.{0,10}(?:委托|决定权|选择权))|(?:我的事|这件事).{0,10}(?:还是|仍然)?我自己做主|(?:最终|最后)?拍板的人是我|我.{0,8}(?:没有|并未).{0,8}把(?:决定权|选择权).{0,4}给你|我.{0,6}(?:拒绝让|不希望|不想让|不愿让)你(?:替我|代我|帮我|为我).{0,8}(?:决定|选择|选)?|我(?:可)?没(?:有)?(?:让|叫|说让|答应让)你(?:替我|代我|帮我|为我)?.{0,8}(?:决定|选择|选|代选)?|(?:我\s*)?(?:现在\s*)?不同意了?$|你无权(?:替我|代我|帮我|为我).{0,8}(?:决定|选择|选)?|别(?:再)?自作主张/u.test(
    segment,
  );
}

function isUtteranceMetaContext(segment: string): boolean {
  if (/^另请(?:说明|举例|示例|例句|翻译|改写|引用|解释)/u.test(segment)) {
    return true;
  }
  if (
    /^(?:(?:我\s*)?(?:是\s*)?(?:只是|正在|在)?(?:转述|复述|引用).{0,16}(?:话|原话|内容)?|(?:同事|朋友|他|她|角色|故事人物)的?(?:原话|台词)(?:是)?|(?:客服|同事|朋友|老师|他|她).{0,8}(?:让我|请我|要我)(?:转告|转述|复述)(?:给)?你?|(?:我来|让我|现在)?举个例子|(?:请)?分析(?:这|那)?(?:句|段)(?:台词|原话|文本|句子)|(?:英文|中文|中英)?翻译任务|(?:我\s*)?(?:正在|在)?模拟.{0,20}(?:用户|角色|助手).{0,12}(?:怎么说|会说|说法)|(?:我\s*)?(?:不会|没有|没)(?:对你)?说|(?:我\s*)?(?:是\s*)?(?:在)?开玩笑(?:的)?|(?:在)?(?:这个|该)?故事(?:中|里))$/u.test(
      segment,
    )
  ) {
    return true;
  }
  if (
    /^(?:假设|模拟|例如|比如|譬如).{0,24}(?:该不该|要不要|怎么选|选哪个|怎么办|是否应该).{0,24}(?:时|时候|情形|场景)?$/u.test(
      segment,
    )
  ) {
    return true;
  }
  return /(?:这句话|这个说法|(?:这条)?规则)|^(?:(?:顺便|另外|还有|然后)\s*)?(?:请\s*)?(?:(?:把|将).{0,32})?(?:说明|举例|示例|例句|翻译|改写|引用|解释)|^举例来说|^(?:授权)?(?:示例|例句)|^(?:原文(?:是)?|原句(?:是)?|例子|例如|譬如|假设|测试文本|测试用例|转述)(?:为|是)?$|^(?:假设|例如|比如|譬如)\s*(?:说|输入|文本|句子|对话|场景|例子|示例|测试|用户说|助手说|角色说).+|^(?:假设|模拟).{0,24}(?:该不该|要不要|怎么选|选哪个|怎么办|是否应该)(?:时|时候|情形|场景)?$|^(?:测试文本|测试用例|场景设定|角色扮演|练习句子|假想情景)(?:是|为|\s).+|^模拟(?:一下)?(?:场景|输入|对话|流程|测试|回答|句子).+|^(?:在)?(?:这个|该)?模拟(?:场景)?里$|^作为(?:一个|一条)?(?:例子|示例|测试|反例)$|^假装(?:我|你|他|她).+|^(?:(?:请)?测试(?:一下)?(?:识别|分类|规则|系统|功能)?|场景(?:设定|设置)|角色设定|角色扮演|练习句子|假想情景|测试用例|模拟(?:一下)?(?:场景|输入|对话|流程)?)$|^(?:为了?|用于|用来)(?:测试|举例|演示|模拟)|^反例|(?:是什么意思|意思是|错误示范)|(?:(?:这\s*)?(?:只)?是|(?:这\s*)?仅为|只是).{0,12}(?:例子|举例|示例|例句|反例|说法|假设|测试|翻译|原句|原文|错误示范)|(?:不是|并非)(?:在)?(?:问|咨询|讨论).{0,24}(?:要不要|该不该|怎么选|选哪个|怎么办|是否应该)|(?:这篇|一篇|这段|该篇)?(?:文章|报道|帖子|视频|书|论文|标题).{0,16}(?:讨论|讲|写|是|关于).{0,24}(?:要不要|该不该|怎么选|选哪个|怎么办|是否应该)|(?:老师|课程|课堂|作业).{0,16}(?:让|要求|需要|讨论|写).{0,24}(?:要不要|该不该|怎么选|选哪个|怎么办|是否应该)|我要写.{0,16}(?:关于|讨论).{0,16}(?:要不要|该不该|怎么选|选哪个|怎么办|是否应该)|(?:翻译|改写|引用|解释|原样复制).{0,32}(?:授权|代选|替我|代我|你说了算|决定权|选择权)|(?:原样复制|照抄)|^(?:不要|别)(?:说|写|复述)|^只有我说|才(?:可以|能|算).{0,8}授权|^我是在(?:测试|举例|假设)|^(?:(?:你|他|她)\s*(?:(?:刚才\s*(?:对我)?)|对我)\s*(?:说|回答)|(?:他|她|朋友|同事|家人|妈妈|母亲|爸爸|父亲|老师|医生|经理|主管|闻溪|助手|模型|角色|智能体|agent)\s*(?:说|回答))$/u.test(
    segment,
  );
}

function isCrossSentenceSemanticQualifier(segment: string): boolean {
  if (
    /^(?:(?:这句话|这个请求|刚才(?:那句话|的请求)?|(?:这\s*)?(?:只)?是|(?:这\s*)?仅为|只是).{0,16}(?:例子|举例|示例|例句|反例|说法|假设|测试|翻译|原句|原文|错误示范)|我是在(?:测试|举例|假设|转述|复述|模拟)|(?:我\s*)?(?:是\s*)?(?:在)?开玩笑(?:的)?|(?:算了|我改主意了|先等等|等等)(?:吧)?$|(?:明天|以后|下次|改天)再说(?:这件事|这个|吧)?$)/u.test(
      segment,
    )
  ) {
    return true;
  }
  return /^(?:如果|假如|要是|除非|若|万一|只要|前提是)(?:(?:有)?(?:需要|必要)(?:的话)?|.{0,20}(?:还|仍|尚)?(?:没|未)(?:回复|回应|回答|决定|选择|收到|回来|联系|确认).{0,12}(?:的话)?|.{0,20}(?:授权|替我|代我|代选|帮我分析).{0,12}(?:才|的话))$/u.test(
    segment,
  );
}

function isPastClarificationCondition(segment: string): boolean {
  return /^(?:如果|假如|要是|若)(?:(?:我\s*)?(?:刚才|刚刚|之前|前面).{0,20}(?:(?:没|没有|未|不).{0,8}(?:说|讲|表达).{0,4}清楚|(?:说|讲|表达).{0,4}(?:不|没).{0,4}(?:清楚|明白)|让你误解|有歧义)|(?:你\s*)?(?:刚才|刚刚).{0,12}(?:没|没有|未).{0,6}(?:听清楚|听明白)|(?:刚才|刚刚).{0,12}(?:信号|网络|通话).{0,8}(?:不好|中断|断了))/u.test(
    segment,
  );
}

function isHardDelegationContextBlock(block: SpeechContextBlock): boolean {
  return (
    block === "future_condition" ||
    block === "utterance_meta" ||
    block === "delegation_denial"
  );
}

function mergeDelegationContextBlock(
  current: SpeechContextBlock,
  incoming: SpeechContextBlock,
): SpeechContextBlock {
  if (current === "future_condition" || incoming === "future_condition") {
    return "future_condition";
  }
  if (current === "utterance_meta" || incoming === "utterance_meta") {
    return "utterance_meta";
  }
  if (current === "delegation_denial" || incoming === "delegation_denial") {
    return "delegation_denial";
  }
  if (current === "historical" || incoming === "historical") {
    return "historical";
  }
  return "none";
}

function canClearDelegationContext(
  block: SpeechContextBlock,
  segment: string,
  strongCurrentAuthorization: boolean,
): boolean {
  if (block === "historical") {
    return strongCurrentAuthorization || hasCurrentDelegationPivot(segment);
  }
  if (block === "utterance_meta" || block === "delegation_denial") {
    return (
      /^(?:而是|但(?:是)?|不过)\s*/u.test(segment) && strongCurrentAuthorization
    );
  }
  return false;
}

function hasCurrentDelegationPivot(segment: string): boolean {
  return /^(?:(?:好|行|可以|那么|那|嗯|而是|但|但是|不过|可是)\s*)?(?:(?:现在|这次|今天)\s*(?:我|请|由你|你来|你|直接)|你\s*(?:现在|这次|今天)\s*(?:就\s*)?(?:直接\s*)?(?:替我|代我|帮我|为我)|我\s*(?:现在|这次|今天)\s*(?:(?:明确|正式)\s*)?授权你)/u.test(
    segment,
  );
}

function hasStrongCurrentAuthorization(segment: string): boolean {
  return /^(?:(?:好|行|可以|那么|那|嗯|而是|但是|但|不过)\s*)?(?:(?:现在|这次|今天)\s*我|我\s*(?:现在|这次|今天))\s*(?:(?:明确|正式)\s*)?授权你/u.test(
    segment,
  );
}

function currentAuthorizationTail(segment: string): string | undefined {
  const match = segment.match(
    /^(?:(?:好|行|可以|那么|那|嗯|而是|但是|但|不过)\s*)?(?:(?:现在|这次|今天)\s*)?(?:我\s*(?:(?:现在|这次|今天)\s*)?)?(?:(?:明确|正式)\s*)?授权你(?<tail>.*)$/u,
  );
  return match?.groups?.tail;
}

function isDirectDelegation(segment: string): boolean {
  const remainder = segment
    .replace(/^(?:好|行|可以|那么|那|嗯|而是|但|但是|不过|可是)\s*/u, "")
    .replace(/^(?:现在|这次|今天)\s*/u, "")
    .trim();
  const actorMatch = remainder.match(
    /^(?:(?:请你|请|麻烦你|麻烦|我请你|我想请你|我要请你)\s*)?(?:你\s*)?(?:(?:现在|这次|今天)\s*)?(?:就\s*)?(?:直接\s*)?(?:替我|代我|帮我|为我)\s*(?<tail>.*)$/u,
  );
  if (actorMatch?.groups?.tail !== undefined) {
    return hasDecisionActionScope(actorMatch.groups.tail);
  }
  const ownerMatch = remainder.match(
    /^(?:(?:请你|请|麻烦你)\s*)?(?:这件事\s*)?(?:就\s*)?(?:由你|你来)\s*(?<tail>.*)$/u,
  );
  if (ownerMatch?.groups?.tail !== undefined) {
    return hasDecisionActionScope(ownerMatch.groups.tail);
  }
  const requestMatch = remainder.match(
    /^(?:请你|我请你|麻烦你|麻烦|请)\s*(?:直接\s*)?(?<tail>.*)$/u,
  );
  if (requestMatch?.groups?.tail !== undefined) {
    return hasDecisionActionScope(requestMatch.groups.tail);
  }
  if (
    /^(?:(?:请你|请|麻烦你)\s*)?(?:你\s*)?(?:直接\s*)?代选(?!项)/u.test(
      remainder,
    )
  ) {
    return true;
  }
  if (
    /^(?:我\s*)?(?:把\s*)?(?:(?:这次|这件事)的?\s*)?(?:决定权|选择权)\s*(?:就\s*)?交给你(?:了|吧)?$/u.test(
      remainder,
    )
  ) {
    return true;
  }
  return /^(?:这件事\s*)?(?:就\s*)?你说了算(?:吧|了)?$/u.test(remainder);
}

function hasDecisionActionScope(value: string): boolean {
  let remainder = value.trim();
  for (let index = 0; index < 4; index += 1) {
    const before = remainder;
    remainder = remainder
      .replace(/^只\s*/u, "")
      .replace(/^直接\s*/u, "")
      .replace(/^(?:由你|你来|替我|代我|帮我|为我)\s*/u, "")
      .replace(/^(?:在|从).{0,96}?(?:之间|当中|中)\s*/u, "")
      .trim();
    if (remainder === before) break;
  }
  return /^(?:来\s*)?(?:(?:作出|做出|作|做|下)\s*(?:一个|一次|这次|最后|最终)?\s*(?:决定|选择)|(?:决定|选择)(?!权|项|的|性)|选(?!项|择)|定(?:吧|了)?$|代选(?!项))/u.test(
    remainder,
  );
}

type NonDelegatedSupportMode = Exclude<SupportMode, "delegated_decision">;

export type LifeEvidenceSubject =
  "user" | "character" | "third_party" | "unspecified";

export interface SupportSpeechActAnalysis {
  delegated: boolean;
  explicitSupport: boolean;
  supportMode: SupportMode;
  dilemmaLike: boolean;
  operativeDilemmaText: string;
  operativeDilemmaClassifyText: string;
}

const DILEMMA_LANGUAGE =
  /要不要|该不该|怎么选|选哪个|怎么办|是否应该|拿不定主意|很犹豫|左右为难|举棋不定|还没决定|难以决定|做(?:不出|不了)决定|面临.{0,8}(?:决定|选择)|不知道(?:该)?选.{1,32}(?:还是|或)|到底选.{1,32}还是/u;

export function analyzeSupportSpeechAct(
  text: string,
): SupportSpeechActAnalysis {
  const support = analyzeExplicitSupport(text);
  const delegated = support.delegated;
  const dilemmaLike = hasUserDilemmaLanguage(
    support.operativeDilemmaClassifyText,
  );
  const supportMode = delegated
    ? "delegated_decision"
    : support.supportExplicitlyDeclined
      ? "listen_only"
      : (support.explicitMode ??
        (dilemmaLike ||
        (support.hasActiveRequest &&
          isRecommendationRequest(support.operativeDilemmaClassifyText))
          ? "deliberate"
          : "listen_only"));
  return {
    delegated,
    explicitSupport: delegated || support.hasActiveRequest,
    supportMode,
    dilemmaLike,
    operativeDilemmaText: support.operativeDilemmaText,
    operativeDilemmaClassifyText: support.operativeDilemmaClassifyText,
  };
}

function hasUserDilemmaLanguage(text: string): boolean {
  if (!DILEMMA_LANGUAGE.test(text)) return false;
  const explicitUser =
    /(?:我(?!的?(?:朋友|同事|家人|伴侣|父母|母亲|父亲))|我们).{0,40}(?:要不要|该不该|怎么选|选哪个|怎么办|是否应该|拿不定主意|很犹豫|左右为难|举棋不定|还没决定|难以决定|做(?:不出|不了)决定|不知道(?:该)?选|到底选)|(?:要不要|该不该|怎么选|选哪个|怎么办|是否应该).{0,16}(?:我|我们)/u.test(
      text,
    );
  if (explicitUser) return true;
  const explicitNonUser =
    /(?:我(?:的)?(?:朋友|同事|家人|伴侣|父母|母亲|父亲)|朋友|同事|家人|伴侣|父母|母亲|父亲|老师|医生|经理|他|她|你|角色).{0,32}(?:要不要|该不该|怎么选|选哪个|怎么办|是否应该|拿不定主意|很犹豫|左右为难|举棋不定|还没决定|难以决定|做(?:不出|不了)决定|不知道(?:该)?选|到底选)/u.test(
      text,
    );
  return !explicitNonUser;
}

export function isDelegatedDecision(text: string): boolean {
  return analyzeSupportSpeechAct(text).delegated;
}

export function isDilemma(text: string): boolean {
  return analyzeSupportSpeechAct(text).dilemmaLike;
}

function isRecommendationRequest(text: string): boolean {
  return /(?:请|直接|只|给我).{0,10}推荐|给我.{0,8}(?:明确)?建议|你觉得|你会怎么做|帮我分析|替我分析/u.test(
    text,
  );
}

export function isPressureDisclosure(text: string): boolean {
  const pressureLanguage =
    /焦虑|压力|清晰度|难受|低落|撑不住|烦躁|崩溃|害怕|我又怕|失眠|反复想|很乱|不知所措|累坏|一直.{0,6}压着|压得.{0,8}(?:喘不过气|难受)|肩膀.{0,8}绷/u;
  if (!pressureLanguage.test(text) || isSpeculativeLifeEvidence(text)) {
    return false;
  }
  return isUserPressureEvidenceSubject(text);
}

export function isUserPressureEvidenceSubject(text: string): boolean {
  const explicitUser =
    /(?:我(?!的?(?:朋友|同事|家人|伴侣|父母|母亲|父亲))|我们).{0,32}(?:焦虑|压力|清晰度|难受|低落|撑不住|烦躁|崩溃|害怕|失眠|很乱|不知所措|累坏)|(?:焦虑|压力|难受|低落|烦躁|崩溃|害怕|失眠|很乱|不知所措).{0,12}(?:我|我们)/u.test(
      text,
    );
  if (explicitUser) return true;
  return !/(?:我(?:的)?(?:朋友|同事|家人|伴侣|父母|母亲|父亲)|朋友|同事|家人|伴侣|父母|母亲|父亲|老师|医生|经理|他|她|你|角色).{0,20}(?:焦虑|压力|难受|低落|撑不住|烦躁|崩溃|害怕|失眠|很乱|不知所措|累坏)/u.test(
    text,
  );
}

export function isPressureTrajectoryContinuation(text: string): boolean {
  return /最难受|每天.{0,12}不相信|我又怕|十年后.{0,16}没试过|这(?:次|个|条).{0,10}(?:选择|决定|结果|压力)|这个结果|结果出现后|压力(?:大概|大约|差不多|还是|是|到|降到|升到)?\s*\d|清晰度(?:大概|大约|差不多|还是|是|到|降到|升到)?\s*\d|梳理完这些|清楚了不代表轻松|能接受.{0,8}代价|真正改变我的/u.test(
    text,
  );
}

export function isIdentityFacetOfLifeChoice(text: string): boolean {
  return /工作|职业|创作|收入|合同|搬家|选择|决定|结果|长期|十年后|害怕|不相信|意义|代价/u.test(
    text,
  );
}

export function isPressureFeedbackText(text: string): boolean {
  return /好多了|轻松多了|没那么(?:焦虑|难受|乱)|想清楚了|清楚多了|被(?:你)?听见|被理解|谢谢你.*(?:听|陪)|更焦虑|更难受|更糟|还是很乱|完全没用|压力更大|没(?:有)?被(?:听见|理解)/u.test(
    text,
  );
}

type SupportRequestKind = NonDelegatedSupportMode | "delegation";

interface SupportRequestEvent {
  mode: SupportRequestKind;
  unitId: number;
}

interface ExplicitSupportAnalysis {
  delegated: boolean;
  explicitMode: NonDelegatedSupportMode | undefined;
  hasActiveRequest: boolean;
  supportExplicitlyDeclined: boolean;
  operativeDilemmaText: string;
  operativeDilemmaClassifyText: string;
}

function analyzeExplicitSupport(text: string): ExplicitSupportAnalysis {
  let events: SupportRequestEvent[] = [];
  let supportExplicitlyDeclined = false;
  let operativeClauses: Array<{
    sourceText: string;
    classifyText: string;
    unitId: number;
  }> = [];
  const sentences = semanticSentenceParts(text);

  for (const [unitId, sentence] of sentences.entries()) {
    let scope: SpeechContextBlock = "none";
    let authorityDenied = false;
    let pendingAuthorization = false;
    let delegationConditionBlocked = false;
    const clauses = semanticClauseParts(sentence);
    for (const [clauseIndex, clause] of clauses.entries()) {
      const segment = clause.classifyText.trim();
      if (segment === "") continue;

      if (isFutureDelegationScopeLimit(segment)) continue;

      const context = supportContextBlock(segment);
      if (isCurrentConditionalFrame(segment)) {
        delegationConditionBlocked = true;
      }
      if (context === "delegation_denial") {
        events = events.filter((event) => event.mode !== "delegation");
        authorityDenied = true;
        pendingAuthorization = false;
        continue;
      }
      if (context === "utterance_meta" || context === "future_condition") {
        if (isCrossSentenceSemanticQualifier(segment)) {
          const hasCurrentUnitContent =
            events.some((event) => event.unitId === unitId) ||
            operativeClauses.some((item) => item.unitId === unitId);
          const hasLaterClause = clauseIndex < clauses.length - 1;
          const targetUnitId =
            hasCurrentUnitContent || hasLaterClause
              ? unitId
              : unitId > 0
                ? unitId - 1
                : unitId;
          events = events.filter((event) => event.unitId !== targetUnitId);
          operativeClauses = operativeClauses.filter(
            (item) => item.unitId !== targetUnitId,
          );
        }
        scope = context;
        pendingAuthorization = false;
        continue;
      }
      if (context === "historical") {
        scope = "historical";
        pendingAuthorization = false;
        continue;
      }

      const strongCurrentAuthorization = hasStrongCurrentAuthorization(segment);
      if (
        delegationConditionBlocked &&
        /^(?:而是|但(?:是)?|不过|可是)\s*(?:现在|这次|今天)/u.test(segment) &&
        (strongCurrentAuthorization || hasCurrentDelegationPivot(segment))
      ) {
        delegationConditionBlocked = false;
      }
      if (
        authorityDenied &&
        /^(?:而是|但(?:是)?|不过)\s*/u.test(segment) &&
        strongCurrentAuthorization
      ) {
        authorityDenied = false;
      }
      if (
        canClearDelegationContext(scope, segment, strongCurrentAuthorization)
      ) {
        scope = "none";
        authorityDenied = false;
      } else if (scope === "historical" && hasCurrentSupportPivot(segment)) {
        scope = "none";
      }
      if (scope !== "none") continue;

      if (isCancelAllSupport(segment)) {
        events = [];
        operativeClauses = [];
        supportExplicitlyDeclined = true;
        pendingAuthorization = false;
        continue;
      }

      const replacement = supportReplacementText(segment);
      if (replacement !== undefined) {
        events = [];
        supportExplicitlyDeclined = false;
        authorityDenied = false;
        pendingAuthorization = false;
      }
      const actText = replacement ?? segment;
      if (isNonOperativePastSupportStatement(actText)) {
        continue;
      }
      const authorizationTail = currentAuthorizationTail(actText);
      const containsDelegationRequest =
        isDelegationRequestClause(actText) ||
        (pendingAuthorization && hasDecisionActionScope(actText));
      if (
        authorizationTail !== undefined &&
        !hasDecisionActionScope(authorizationTail)
      ) {
        pendingAuthorization = true;
      } else if (containsDelegationRequest) {
        pendingAuthorization = false;
      }
      if (isRecommendationOnlyModifier(segment)) {
        const hadDelegationRequest =
          containsDelegationRequest ||
          events.some((event) => event.mode === "delegation");
        if (hadDelegationRequest) {
          events = events.filter((event) => event.mode !== "delegation");
          events.push({ mode: "recommend", unitId });
          supportExplicitlyDeclined = false;
          operativeClauses.push({
            sourceText: clause.sourceText,
            classifyText: clause.classifyText,
            unitId,
          });
          continue;
        }
      }

      if (isDelegationRevocation(segment)) {
        events = events.filter((event) => event.mode !== "delegation");
        authorityDenied = true;
      }

      const negatedSupportModes = getNegatedSupportModes(segment);
      if (negatedSupportModes.size > 0) {
        events = events.filter(
          (event) =>
            event.mode === "delegation" || !negatedSupportModes.has(event.mode),
        );
        if (negatedSupportModes.has("deliberate")) {
          supportExplicitlyDeclined = events.length === 0;
        }
      }

      const explicitMode =
        negatedSupportModes.size > 0
          ? undefined
          : explicitSupportModeForClause(actText);
      if (explicitMode !== undefined) {
        events.push({ mode: explicitMode, unitId });
        supportExplicitlyDeclined = false;
      } else if (
        containsDelegationRequest &&
        !authorityDenied &&
        !delegationConditionBlocked &&
        negatedSupportModes.size === 0
      ) {
        events.push({ mode: "delegation", unitId });
        supportExplicitlyDeclined = false;
      }

      if (negatedSupportModes.size === 0 || explicitMode !== undefined) {
        operativeClauses.push({
          sourceText: clause.sourceText,
          classifyText: clause.classifyText,
          unitId,
        });
      }
    }
  }

  const lastEvent = events.at(-1);
  return {
    delegated: lastEvent?.mode === "delegation",
    explicitMode:
      lastEvent === undefined || lastEvent.mode === "delegation"
        ? undefined
        : lastEvent.mode,
    hasActiveRequest: lastEvent !== undefined,
    supportExplicitlyDeclined,
    operativeDilemmaText: joinOperativeClauses(
      operativeClauses,
      (item) => item.sourceText,
    ),
    operativeDilemmaClassifyText: joinOperativeClauses(
      operativeClauses,
      (item) => item.classifyText,
    ),
  };
}

function joinOperativeClauses(
  clauses: readonly {
    sourceText: string;
    classifyText: string;
    unitId: number;
  }[],
  selectText: (clause: (typeof clauses)[number]) => string,
): string {
  return clauses
    .map((clause, index) => {
      if (index === 0) return selectText(clause);
      return `${clauses[index - 1]?.unitId === clause.unitId ? "，" : "。"}${selectText(clause)}`;
    })
    .join("");
}

function supportContextBlock(segment: string): SpeechContextBlock {
  if (isCurrentConditionalFrame(segment)) return "none";
  if (isResolvedOrDeniedDilemmaReference(segment)) return "historical";
  const delegationBlock = delegationContextBlock(segment);
  if (delegationBlock !== "none") return delegationBlock;
  if (
    /(?:上次|之前|过去|曾经|那次|那时|当时|刚才|刚刚).{0,32}(?:一起分析|帮我分析|替我分析|替我.{0,8}(?:比较|列出)|推荐|犹豫|要不要|该不该|怎么选|选哪个|还没决定)/u.test(
      segment,
    )
  ) {
    return "historical";
  }
  return "none";
}

function isResolvedOrDeniedDilemmaReference(segment: string): boolean {
  return /(?:已经|早就).{0,16}(?:不纠结|不犹豫|决定(?:了|好)|选好(?:了)?)|不再.{0,8}(?:纠结|犹豫)|(?:不用|无需|不必).{0,8}(?:再)?(?:问|讨论|分析).{0,12}(?:该不该|要不要|怎么选|选哪个|怎么办|是否应该)|(?:不存在|并没有|没有).{0,8}(?:怎么选|拿不定主意|犹豫|纠结)(?:的)?(?:问题|情况|状态)?/u.test(
    segment,
  );
}

function isCurrentConditionalFrame(segment: string): boolean {
  return (
    /^(?:如果是我|换作我|换成我|要是我)(?:\s|$|，|,)/u.test(segment) ||
    /^(?:如果|假如|要是|若)\s*(?:只|仅)?(?:看|从).{0,16}(?:价值|排序|优先级|取舍|代价|风险|现实|经济|家庭|长期|短期)/u.test(
      segment,
    ) ||
    /^(?:如果|假如|要是|若|万一).{0,16}(?:现在|当前|眼下|今天).{0,12}(?:必须|需要|只能|就要|得).{0,8}(?:二选一|选择|决定|选|定)/u.test(
      segment,
    ) ||
    /^(?:如果|假如|要是|若).{0,12}(?:按|基于).{0,12}当前(?:信息|情况|条件|证据).{0,12}(?:判断|比较|分析|推荐|选择|决定)?/u.test(
      segment,
    ) ||
    /^(?:假设|假如|如果|要是|若|模拟(?:一下)?).{0,36}(?:选择|选(?:了)?|决定|留下|离开|辞职|入职|接受|拒绝).{0,32}(?:后|结果|会|将|风险|代价|后果|影响|最坏情况|三个月|半年|一年)/u.test(
      segment,
    )
  );
}

function hasCurrentSupportPivot(segment: string): boolean {
  return /^(?:(?:好|行|可以|那么|那|嗯|而是|但|但是|不过|可是)\s*)?(?:现在|这次|今天)\s*(?:请|你|帮我|替我|一起|直接|真的|我|已经|最终|明确)/u.test(
    segment,
  );
}

function supportReplacementText(segment: string): string | undefined {
  const match = segment.match(
    /^(?:(?:好|那|那么|现在)\s*)?(?:还是\s*)?改(?:成|为|作)\s*(?<replacement>.+)$/u,
  );
  return match?.groups?.replacement?.trim();
}

function isDelegationRequestClause(segment: string): boolean {
  return isDirectDelegation(segment) || analyzeDelegatedDecision(segment);
}

function explicitSupportModeForClause(
  segment: string,
): NonDelegatedSupportMode | undefined {
  if (isExplicitDeliberation(segment)) return "deliberate";
  if (isExplicitListenOnly(segment)) return "listen_only";
  if (isExplicitRecommendation(segment)) return "recommend";
  return undefined;
}

function isExplicitDeliberation(text: string): boolean {
  return /一起分析|帮我分析|替我分析|只负责分析|替我.{0,8}(?:比较|列出).{0,8}(?:选项|方案)|梳理|理一理|权衡|收益.{0,16}代价|最坏情况|(?:哪些|有(?:什么|哪些)|会有(?:什么|哪些)).{0,8}(?:风险|代价|后果|影响)|反事实|模拟.{0,48}(?:选择|选(?:了)?|决定|留下|离开|辞职|入职|接受|拒绝).{0,24}(?:后|结果|影响|生活)|帮我找到.{0,8}(?:卡住|关键)|只问我一个问题/u.test(
    text,
  );
}

function isExplicitListenOnly(text: string): boolean {
  return /先陪我|陪我坐会|先听|只听|只要听|听我.{0,8}(?:说|讲)|不要分析|别分析|不要给.{0,6}(?:方案|建议)|先别急着解释/u.test(
    text,
  );
}

function isExplicitRecommendation(text: string): boolean {
  if (/不要.{0,8}(?:推荐|建议)|先不要下结论/u.test(text)) {
    return false;
  }
  return /(?:请|直接|只).{0,8}推荐|只推荐一个|给我一个明确(?:方向|建议)|明确建议|你(?:只能|只负责)(?:给|提)?(?:建议|意见)|(?:给我?)?建议(?:一下)?(?:就好|就行|即可)|我只需要你的建议|只是给个参考/u.test(
    text,
  );
}

function isRecommendationOnlyModifier(text: string): boolean {
  if (
    /(?:不要|别|不会|不愿|不想|不是|并非|不)\s*(?:只\s*)?把.{0,24}(?:当作|当成|看作|当)(?:一条|一个)?建议|(?:不是|并非|不会|不).{0,8}(?:仅|只)?(?:供|作(?:为)?)参考/u.test(
      text,
    )
  ) {
    return false;
  }
  return /(?:我\s*(?:会\s*)?(?:只\s*)?把(?:你(?:的)?(?:话|回答|意见|建议|选择)|它|这|这个).{0,12}(?:当作|当成|看作|当)(?:一条|一个)?建议)|(?:(?:你的)?(?:选择|意见|话|回答|答案)?\s*(?:只|仅)?(?:供(?:我)?|作(?:为)?|当作|当成|看作)参考)|(?:(?:只|仅|只能)(?:作(?:为)?|供|当作|当成|看作)(?:我)?参考)|(?:(?:决定权|选择权|拍板权).{0,10}(?:还是|仍然|依然)?(?:保留)?(?:在|归)(?:我|用户))|(?:(?:我|用户).{0,8}保留.{0,8}(?:最终)?(?:决定权|选择权|拍板权))|(?:(?:最后|最终)\s*(?:还是\s*)?由我(?:自己)?(?:来)?(?:决定|选择|选))|(?:(?:最后|最终)\s*(?:还是\s*)?我(?:自己)?(?:来)?(?:决定|选择|选|拍板))|(?:我.{0,8}(?:最后|最终)?\s*(?:还是\s*)?(?:自己|亲自)(?:来)?(?:决定|选择|选|拍板))|(?:我(?:才)?是(?:最后|最终)?(?:决定|拍板)的人)|(?:(?:最后|最终).{0,6}(?:要|由)?我(?:来)?确认)|(?:是否采纳.{0,8}由我(?:来)?(?:决定)?)|(?:我.{0,8}(?:只)?想听(?:一条|一个)?建议)|我只需要你的建议|你(?:只能|只负责)(?:给|提)?(?:建议|意见)|(?:给我?)?建议(?:一下)?(?:就好|就行|即可)|只是给个参考|(?:(?:只|仅)(?:(?:当作|当成|看作|当))?(?:一条|一个)?建议)|(?:(?:当作|当成|看作|当)(?:一条|一个)?建议)|(?:(?:只|仅)是(?:一条|一个)?建议)/u.test(
    text,
  );
}

function isNonOperativePastSupportStatement(text: string): boolean {
  return /(?:从来(?:都)?没有|从未|(?:以前|之前|此前|过去|刚才|刚刚|一直|还)(?:都)?没(?:有)?).{0,16}(?:帮我|替我|陪我|和我|给我|为我)?.{0,8}(?:分析|比较|梳理|权衡|推荐|建议|意见)(?:过|了)?/u.test(
    text,
  );
}

function getNegatedSupportModes(
  text: string,
): ReadonlySet<NonDelegatedSupportMode> {
  const modes = new Set<NonDelegatedSupportMode>();
  const negativePrefix =
    /(?:并非|不是).{0,8}(?:要|让|请)?你?(?:帮我|替我|陪我|和我)?|^(?:(?:但|不过|但是|可是)\s*)?(?:请\s*)?(?:(?:先|暂时)\s*)?(?:不要|别|不用|无需|不需要|不必).{0,10}(?:你)?(?:帮我|替我|陪我|和我)?|^(?:(?:但|不过|但是|可是)\s*)?(?:我\s*)?(?:不想|不愿)(?:再)?(?:听|要|看).{0,8}/u;
  if (
    new RegExp(`(?:${negativePrefix.source})(?:分析|比较|梳理|权衡)`, "u").test(
      text,
    )
  ) {
    modes.add("deliberate");
  }
  if (
    new RegExp(
      `(?:${negativePrefix.source})(?:(?:给|提)(?:我)?(?:任何|明确|一个|一条)?(?:建议|意见|方案)|推荐|建议|意见)`,
      "u",
    ).test(text)
  ) {
    modes.add("recommend");
  }
  return modes;
}

function isCancelAllSupport(text: string): boolean {
  return /^(?:算了|我改主意了?|先等等|等等|先不用了?|不用了?|都不用了?)(?:吧|啊|呀)?$/u.test(
    text,
  );
}

export function hasExplicitSupportIntent(text: string): boolean {
  return analyzeSupportSpeechAct(text).explicitSupport;
}

export function supportMode(
  text: string,
  delegated: boolean,
  dilemmaLike: boolean,
): SupportMode {
  if (delegated) return "delegated_decision";
  const analysis = analyzeSupportSpeechAct(text);
  if (analysis.supportMode !== "delegated_decision") {
    if (
      analysis.explicitSupport ||
      analysis.supportMode !== "listen_only" ||
      !dilemmaLike
    ) {
      return analysis.supportMode;
    }
  }
  return dilemmaLike ? "deliberate" : "listen_only";
}

export function userToCharacterSupportMode(text: string): SupportMode {
  if (/如果是我|我的建议|建议你|我会优先|我会选择|我会选/u.test(text)) {
    return "recommend";
  }
  return "deliberate";
}

export function supportIntendedEffect(
  mode: SupportMode,
  receiver: "user" | "character",
): string {
  const subject = receiver === "user" ? "用户" : "角色";
  if (mode === "listen_only") return `让${subject}感到被听见并降低反刍负担`;
  if (mode === "deliberate") return `帮助${subject}看清选项、价值冲突和代价`;
  if (mode === "recommend")
    return `向${subject}提供一个明确但不代行决定权的方向`;
  return `依据${subject}的明确授权代为作出选择`;
}

export function decisionSupportDirection(
  dilemma: DilemmaEpisode,
  authority: "subject" | "delegated",
  decidedBy: "user" | "character",
): {
  offeredBy: "user" | "character";
  receivedBy: "user" | "character";
} {
  if (dilemma.subject === "user") {
    return { offeredBy: "character", receivedBy: "user" };
  }
  if (dilemma.subject === "character") {
    return { offeredBy: "user", receivedBy: "character" };
  }
  if (authority === "delegated") {
    return decidedBy === "user"
      ? { offeredBy: "user", receivedBy: "character" }
      : { offeredBy: "character", receivedBy: "user" };
  }
  return decidedBy === "user"
    ? { offeredBy: "character", receivedBy: "user" }
    : { offeredBy: "user", receivedBy: "character" };
}

export function isUserOwnedDecision(text: string): boolean {
  if (
    /还没决定|没有决定|尚未决定|决定仍然有效|授权你|替我(?:决定|选择|选)|你来(?:决定|选择|选)|不要.{0,8}(?:替我|帮我).{0,6}(?:决定|选择|选)|不会假装/u.test(
      text,
    )
  ) {
    return false;
  }
  return /我(?:现在|已经|最终|明确)?(?:决定选择|决定了|决定要|选择了|选择)|这个决定由我作出/u.test(
    text,
  );
}

export function isCharacterSubjectDecisionRequest(text: string): boolean {
  return /你现在愿意.{0,20}(?:选一个方向|作决定)|请按你自己的价值作决定|由你自己.{0,8}(?:决定|选择)|你愿意为.{0,16}(?:决定|选)/u.test(
    text,
  );
}

export function isUserAdviceToCharacter(text: string): boolean {
  return /如果是我|我的建议|这是我的建议|建议你|我会优先|我会选择|我会选|你可以接受|部分接受|拒绝/u.test(
    text,
  );
}

export function isCharacterDilemmaTurn(
  text: string,
  dilemma: DilemmaEpisode,
): boolean {
  if (
    isUserAdviceToCharacter(text) ||
    isCharacterSubjectDecisionRequest(text)
  ) {
    return true;
  }
  return dilemmaRelevance(dilemma, text) >= 8;
}

export function isCharacterReflectionRequest(text: string): boolean {
  return /你现在怎么看自己的选择|你现在怎么看.{0,8}(?:决定|选择)|回头看.{0,12}你.{0,8}(?:决定|选择)|你如何理解自己的选择/u.test(
    text,
  );
}

export function parseScaleMetric(
  text: string,
  metric: "pressure" | "clarity",
): number | undefined {
  const label = metric === "pressure" ? "压力" : "清晰度";
  const match = text.match(
    new RegExp(
      `${label}(?:(?:大概|大约|差不多|还是|是|到|降到|升到)\\s*)*\\s*(\\d+(?:\\.\\d+)?)\\s*\\/\\s*10`,
      "u",
    ),
  );
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? clamp01(value / 10) : undefined;
}

export function selectDilemmaOption(
  dilemma: DilemmaEpisode,
  evidenceText: string,
): DilemmaEpisode["options"][number] {
  return [...dilemma.options].sort(
    (left, right) =>
      optionRelevance(right, evidenceText) -
      optionRelevance(left, evidenceText),
  )[0]!;
}

function optionRelevance(
  option: DilemmaEpisode["options"][number],
  evidenceText: string,
): number {
  const evidence = normalizeForMatch(evidenceText);
  if (evidence === "") return 0;
  const label = normalizeForMatch(maskQuotedContent(option.label));
  const description = normalizeForMatch(maskQuotedContent(option.description));
  const exactBonus =
    evidence.includes(label) || label.includes(evidence) ? label.length * 2 : 0;
  return (
    exactBonus +
    longestCommonSubstringLength(evidence, label) * 4 +
    longestCommonSubstringLength(evidence, description) * 2
  );
}

export function dilemmaRelevance(
  dilemma: DilemmaEpisode,
  evidenceText: string,
): number {
  const evidence = normalizeForMatch(evidenceText);
  if (evidence === "") return 0;
  const base = Math.max(
    longestCommonSubstringLength(
      evidence,
      normalizeForMatch(maskQuotedContent(dilemma.title)),
    ),
    longestCommonSubstringLength(
      evidence,
      normalizeForMatch(maskQuotedContent(dilemma.summary)),
    ),
  );
  const option = Math.max(
    ...dilemma.options.map((candidate) =>
      optionRelevance(candidate, evidenceText),
    ),
  );
  const domainBonus = inferDomain(evidenceText) === dilemma.domain ? 3 : 0;
  return base * 2 + option + domainBonus;
}

export function hasMeaningfulDilemmaContextAnchor(
  dilemma: DilemmaEpisode,
  evidenceText: string,
): boolean {
  const evidence = normalizeForMatch(evidenceText);
  if (evidence === "") return false;
  const optionEvidence = dilemma.options.flatMap((option) => [
    option.label,
    option.description,
    ...option.likelyTradeoffs,
    ...option.valuesAtStake,
  ]);
  return [dilemma.title, ...optionEvidence].some(
    (source) =>
      longestCommonSubstringLength(
        evidence,
        normalizeForMatch(maskQuotedContent(source)),
      ) >= 2,
  );
}

export function hasExplicitDilemmaContextFrame(text: string): boolean {
  return /(?:价值(?:排序|取舍)|决策优先级|选择标准|取舍底线)/u.test(text);
}

export function decisionRelevance(
  decision: DecisionRecord,
  dilemma: DilemmaEpisode | undefined,
  evidenceText: string,
): number {
  const evidence = normalizeForMatch(evidenceText);
  if (evidence === "") return 0;
  const selectionScore =
    longestCommonSubstringLength(
      evidence,
      normalizeForMatch(decision.selectionSummary),
    ) * 4;
  const dilemmaScore =
    dilemma === undefined ? 0 : dilemmaRelevance(dilemma, evidenceText);
  const subjectBonus =
    decision.subject === "character" && /你|你的|角色|对方/u.test(evidenceText)
      ? 8
      : decision.subject === "user" && /我|我的/u.test(evidenceText)
        ? 4
        : 0;
  return selectionScore + dilemmaScore + subjectBonus;
}

export const DECISION_EVIDENCE_RELEVANCE_THRESHOLD = 12;
export const REFLECTION_CONTINUITY_RELEVANCE_THRESHOLD = 8;
export const PRESSURE_DILEMMA_RELEVANCE_THRESHOLD = 12;
export const DILEMMA_CONTEXT_EVIDENCE_RELEVANCE_THRESHOLD = 8;
const STRONG_TWO_CHARACTER_CAUSAL_TERMS = [
  "辞职",
  "离职",
  "签约",
  "搬家",
  "分手",
  "拒绝",
  "接受",
  "报名",
  "申请",
] as const;
const AMBIGUOUS_TWO_CHARACTER_REFLECTION_TOPICS = new Set([
  "生活",
  "工作",
  "事情",
  "感觉",
  "理解",
  "需要",
  "可以",
  "应该",
  "时候",
  "还是",
]);
const PRESSURE_DILEMMA_CONCEPT_GROUPS = [
  ["工作", "职业", "公司", "员工"],
  ["长期", "十年后", "未来"],
  ["害怕", "怕", "担心"],
  ["创作", "纪录片", "内容"],
  ["稳定", "收入", "合同"],
  ["搬家", "换个地方", "城市", "异地"],
  ["关系", "伴侣", "分手", "朋友", "家人"],
  ["健康", "睡眠", "生病", "身体"],
  ["学习", "考试", "课程", "学校"],
] as const;

export function decisionEvidenceSemanticRelevance(
  decision: DecisionRecord,
  dilemma: DilemmaEpisode | undefined,
  evidenceText: string,
): number {
  const sources = [
    decision.selectionSummary,
    ...(dilemma === undefined
      ? []
      : [
          dilemma.title,
          dilemma.summary,
          ...dilemma.options.flatMap((option) => [
            option.label,
            option.description,
            ...option.likelyTradeoffs,
            ...option.valuesAtStake,
          ]),
        ]),
  ];
  return Math.max(
    0,
    ...sources.map((source) => causalTextRelevance(evidenceText, source)),
  );
}

export function decisionStagePredecessorRelevance(
  stage: "action" | "outcome" | "reflection",
  evidenceText: string,
  actionSummaries: readonly string[],
  outcomeSummaries: readonly string[],
): number {
  const sources =
    stage === "outcome"
      ? actionSummaries
      : stage === "reflection"
        ? [...outcomeSummaries, ...actionSummaries]
        : [];
  return Math.max(
    0,
    ...sources.map((source) => causalTextRelevance(evidenceText, source)),
  );
}

export function reflectionContinuityRelevance(
  decision: DecisionRecord,
  dilemma: DilemmaEpisode | undefined,
  evidenceText: string,
  actionSummaries: readonly string[],
  outcomeSummaries: readonly string[],
): number {
  const sources = [
    decision.selectionSummary,
    ...actionSummaries,
    ...outcomeSummaries,
    ...(dilemma === undefined
      ? []
      : [
          dilemma.title,
          dilemma.summary,
          ...dilemma.options.flatMap((option) => [
            option.label,
            option.description,
            ...option.likelyTradeoffs,
            ...option.valuesAtStake,
          ]),
        ]),
  ];
  return Math.max(
    0,
    ...sources.map((source) =>
      reflectionTopicTextRelevance(evidenceText, source),
    ),
  );
}

function reflectionTopicTextRelevance(left: string, right: string): number {
  return (
    longestMeaningfulCommonSubstringLength(
      normalizeCausalMatch(left),
      normalizeCausalMatch(right),
      AMBIGUOUS_TWO_CHARACTER_REFLECTION_TOPICS,
    ) * 4
  );
}

export function reflectionSubjectMatches(
  decision: DecisionRecord,
  evidenceText: string,
  preferCharacter: boolean,
): boolean {
  if (preferCharacter) return decision.subject === "character";
  if (/我|我的|我们/u.test(evidenceText)) return decision.subject === "user";
  return decision.subject !== "character";
}

export function pressureDilemmaSemanticRelevance(
  episode: PressureEpisode,
  dilemma: DilemmaEpisode,
  pressureEvidenceTexts: readonly string[],
): number {
  const pressureTexts = [episode.triggerSummary, ...pressureEvidenceTexts].map(
    maskQuotedContent,
  );
  const dilemmaTexts = [
    dilemma.title,
    dilemma.summary,
    ...dilemma.options.flatMap((option) => [
      option.label,
      option.description,
      ...option.likelyTradeoffs,
      ...option.valuesAtStake,
    ]),
  ].map(maskQuotedContent);
  const strongestDirectMatch = Math.max(
    0,
    ...pressureTexts.flatMap((pressureText) =>
      dilemmaTexts.map((dilemmaText) =>
        causalTextRelevance(pressureText, dilemmaText),
      ),
    ),
  );
  const pressureCorpus = pressureTexts.join(" ");
  const dilemmaCorpus = dilemmaTexts.join(" ");
  const sharedConceptCount = PRESSURE_DILEMMA_CONCEPT_GROUPS.filter(
    (terms) =>
      terms.some((term) => pressureCorpus.includes(term)) &&
      terms.some((term) => dilemmaCorpus.includes(term)),
  ).length;
  return Math.max(strongestDirectMatch, sharedConceptCount * 4);
}

function causalTextRelevance(left: string, right: string): number {
  const normalizedLeft = normalizeCausalMatch(left);
  const normalizedRight = normalizeCausalMatch(right);
  const common = longestCommonSubstringLength(normalizedLeft, normalizedRight);
  if (common >= 3) return common * 4;
  return STRONG_TWO_CHARACTER_CAUSAL_TERMS.some(
    (term) => normalizedLeft.includes(term) && normalizedRight.includes(term),
  )
    ? DECISION_EVIDENCE_RELEVANCE_THRESHOLD
    : 0;
}

function normalizeCausalMatch(text: string): string {
  return normalizeForMatch(maskQuotedContent(text)).replace(
    /今天|刚刚|刚才|后来|最终|实际|事实|已经|仍然|一下|一封|普通|这个|那个|这次|上述|自己的|我的|你的|我们|他们|她们|自己|决定|选择|方向|行动|结果|反馈|我|你|他|她/gu,
    "",
  );
}

export function hasExplicitCausalStageReference(
  text: string,
  stage: "action" | "outcome" | "reflection",
): boolean {
  if (stage === "action") {
    return /(?:落实|执行|照着|按照|为了).{0,12}(?:决定|选择|方向)|(?:这个|这次|上述).{0,8}(?:决定|选择).{0,16}(?:做了|行动|落实|执行)/u.test(
      text,
    );
  }
  if (stage === "outcome") {
    return /(?:这个|这次|上述).{0,8}(?:决定|选择|行动).{0,16}(?:带来|导致|产生|结果|后果|反馈)|后来.{0,12}(?:公司|对方|机构|学校).{0,12}(?:同意|拒绝|通过|回复|确认)/u.test(
      text,
    );
  }
  return /(?:对|回看|回头看|关于).{0,12}(?:决定|选择|结果)|怎么看(?:自己)?的?(?:决定|选择)|如何理解自己的选择/u.test(
    text,
  );
}

export function exactlyOne<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function longestMeaningfulCommonSubstringLength(
  left: string,
  right: string,
  ambiguousTwoCharacterFragments: ReadonlySet<string>,
): number {
  const maximum = Math.min(left.length, right.length, 24);
  for (let length = maximum; length >= 2; length -= 1) {
    const fragments = new Set<string>();
    for (let index = 0; index <= left.length - length; index += 1) {
      fragments.add(left.slice(index, index + length));
    }
    for (const fragment of fragments) {
      if (
        right.includes(fragment) &&
        (length > 2 || !ambiguousTwoCharacterFragments.has(fragment))
      ) {
        return length;
      }
    }
  }
  return 0;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(/这个|那个|现在|已经|决定|选择|方向/gu, "");
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (left.length === 0 || right.length === 0) return 0;
  const previous = new Array<number>(right.length + 1).fill(0);
  let best = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        previous[rightIndex] = diagonal + 1;
        best = Math.max(best, previous[rightIndex]!);
      } else {
        previous[rightIndex] = 0;
      }
      diagonal = above;
    }
  }
  return best;
}

export function extractSelectedDirection(text: string): string {
  const explicit = text.match(
    /(?:我的决定|我的建议|我建议你|我会选|就选)[：:\s]*([^。！？!\n]{1,160})/u,
  )?.[1];
  if (explicit?.trim()) return explicit.trim();
  return text
    .replace(/\s+/gu, " ")
    .trim()
    .split(/[。！？!]/u)[0]!
    .slice(0, 160);
}

export function shortTitle(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 80);
}

export function pressureKind(
  domain: LifeDomain,
): PressureEpisode["pressureKind"] {
  if (domain === "work" || domain === "study" || domain === "creative")
    return "work";
  if (domain === "relationship" || domain === "social") return "relationship";
  if (domain === "identity" || domain === "self_reflection") return "identity";
  if (domain === "health" || domain === "rest") return "health";
  return "decision";
}

export function compactLifePromptText(text: string, maximum = 600): string {
  const compact = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return compact.length <= maximum
    ? compact
    : `${compact.slice(0, maximum - 1)}…`;
}

function isSpeculativeLifeEvidence(text: string): boolean {
  if (/^(?:如果|假如|要是|若|万一|假设)/u.test(text)) return true;
  return (
    /(?:明天|后天|下周|下个月|以后|将来|未来|下次).{0,36}(?:可能|也许|或许|大概|预计|预期|会|将|才|再)/u.test(
      text,
    ) ||
    /(?:可能|也许|或许|预计|预期).{0,24}(?:会|将|提交|办理|报名|申请|搬|分手|辞职|行动|结果|反馈|同意|拒绝|成功|失败|焦虑|压力|难受|后悔|庆幸|值得)/u.test(
      text,
    )
  );
}

const ACTION_SUBJECT_CUE =
  /提交|办理|报名|申请|搬走|搬家|分手|辞职|离职|答应|拒绝|开始做|完成|做了|去了|联系|签了|取消|执行|行动|发(?:出|给|了)|提出|确认|启动/u;
const OUTCOME_SUBJECT_CUE =
  /决定|选择|提交|申请|搬走|搬家|分手|辞职|离职|行动|执行|结果|反馈|后果|同意|拒绝|通过|失败|成功|变得|收到|通知|轻松|开心|难受|后悔|更好|更糟/u;

export function actionEvidenceSubject(text: string): LifeEvidenceSubject {
  return inferLeadingEvidenceSubject(text, ACTION_SUBJECT_CUE, true);
}

export function outcomeEvidenceSubject(text: string): LifeEvidenceSubject {
  const outcomeSubject = inferLeadingEvidenceSubject(
    text,
    OUTCOME_SUBJECT_CUE,
    false,
  );
  return outcomeSubject === "unspecified"
    ? inferLeadingEvidenceSubject(text, ACTION_SUBJECT_CUE, false)
    : outcomeSubject;
}

function inferLeadingEvidenceSubject(
  text: string,
  cue: RegExp,
  includeOrganizationActors: boolean,
): LifeEvidenceSubject {
  const subjects = new Set<Exclude<LifeEvidenceSubject, "unspecified">>();
  for (const rawClause of text.split(/[，,。；;：:!?！？\n]+/u)) {
    if (!cue.test(rawClause)) continue;
    const clause = rawClause
      .trim()
      .replace(/^(?:但(?:是)?|不过|可是|而且|然后|随后)\s*/u, "")
      .replace(
        /^(?:(?:后来|今天|现在|目前|最终|正式|刚刚|刚才|这次|几天后|一周后)\s*)+/u,
        "",
      );
    const thirdParty = includeOrganizationActors
      ? /^(?:我(?:的)?(?:朋友|同事|家人|伴侣|父母|母亲|父亲)|朋友|同事|家人|伴侣|父母|母亲|父亲|老师|医生|经理|公司|团队|平台|对方|他|她)/u
      : /^(?:我(?:的)?(?:朋友|同事|家人|伴侣|父母|母亲|父亲)|朋友|同事|家人|伴侣|父母|母亲|父亲|老师|医生|经理|他|她)/u;
    if (thirdParty.test(clause)) {
      subjects.add("third_party");
    } else if (
      /^(?:我(?!的?(?:朋友|同事|家人|伴侣|父母|母亲|父亲))|我们)/u.test(clause)
    ) {
      subjects.add("user");
    } else if (/^(?:你|角色)/u.test(clause)) {
      subjects.add("character");
    }
  }
  if (subjects.size === 0) return "unspecified";
  if (subjects.size > 1) return "third_party";
  return [...subjects][0]!;
}

function hasNonUserReflectionSubject(text: string): boolean {
  return /(?:我(?:的)?(?:朋友|同事|家人|伴侣|父母|母亲|父亲)|朋友|同事|家人|伴侣|父母|母亲|父亲|老师|医生|经理|他|她|你|角色)[^，,。；;!?！？\n]{0,24}(?:回头看|现在想想|觉得这个决定|对这个选择|后悔|庆幸|才明白|想明白|理解是|重新想)/u.test(
    text,
  );
}

export function isActionEvidence(text: string): boolean {
  text = independentConsentEvidenceText(text);
  if (
    isSpeculativeLifeEvidence(text) ||
    actionEvidenceSubject(text) === "third_party" ||
    isCausalRecapOrProvenanceRequest(text) ||
    /(?:还没|没有|尚未|并未|不会|不等于).{0,20}(?:提交|办理|报名|申请|搬|分手|开始|完成|联系|签|执行|行动|发邮件|辞职|答应)|(?:只是|仍是).{0,12}(?:计划|打算)|如果.{0,16}(?:行动|已经做)|(?:吗|是否|有没有).{0,12}(?:行动|做了|迈出)|没有新的确认|事实没有变化/u.test(
      text,
    )
  ) {
    return false;
  }
  const strongEvidence =
    /(?:已经|刚刚|刚|后来|今天|最终|正式).{0,48}(?:提交(?:了)?|办理(?:了)?|报名(?:了)?|申请(?:了)?|搬走(?:了)?|分手了|答应了|拒绝了|开始做|完成(?:了)?|做了|去了|说了|联系(?:了)?|签了|取消(?:了)?|执行(?:了)?|行动(?:了)?|发(?:出|了)|提出(?:了)?|确认(?:了)?|启动(?:了)?)/u;
  if (strongEvidence.test(text)) return true;
  if (
    /只是想|(?:决定|打算|计划|准备|考虑|想要).{0,12}(?:辞职|离职|搬|分手|报名|申请)/u.test(
      text,
    )
  ) {
    return false;
  }
  return /(?:已经|刚刚|后来|最终).{0,8}(?:辞职|离职|搬家)/u.test(text);
}

export function isActionRestatement(text: string): boolean {
  return /(?:同一封)?邮件已经发出|同一封邮件|不要把.{0,12}(?:算成|记成).{0,8}(?:两次|重复)|连接重试|重复发送|这仍是同一个行动|只是重述.{0,8}行动|实际情况.{0,32}(?:自己|由我).{0,12}(?:执行|行动)|之后也是我自己执行/u.test(
    text,
  );
}

export function inferActionKind(
  text: string,
): "initiated" | "advanced" | "completed" | "abandoned" {
  if (/完成|办完|做完|结束|落实/u.test(text)) return "completed";
  if (/取消|放弃|没再继续|停下/u.test(text)) return "abandoned";
  if (/继续|推进|又做|第二步/u.test(text)) return "advanced";
  return "initiated";
}

export function isOutcomeEvidence(text: string): boolean {
  text = independentConsentEvidenceText(text);
  if (
    isSpeculativeLifeEvidence(text) ||
    outcomeEvidenceSubject(text) === "third_party" ||
    isCausalRecapOrProvenanceRequest(text) ||
    isCharacterReflectionRequest(text) ||
    /没有(?:最终)?结果|还没有.{0,16}(?:反馈|确认|结果)|仍然不是最终结果|仍不是最终结果|只有行动.{0,8}没有结果|事实没有变化|没有新的确认|(?:什么|哪些|现在).{0,8}(?:反馈|结果).{0,4}(?:是|吗)|如果.{0,12}(?:出现|有了).{0,8}结果|(?:这个|该|上述)结果.{0,8}(?:让我|使我|令我|带给我)|听到.{0,8}结果.{0,8}(?:我|感觉)/u.test(
      text,
    )
  ) {
    return false;
  }
  if (
    parseScaleMetric(text, "pressure") !== undefined &&
    parseScaleMetric(text, "clarity") !== undefined &&
    !/(?:资金|薪资|公司|合同|接受|拒绝|通过|失败|成功|通知|反馈|确认收件|混合结果)/u.test(
      text,
    )
  ) {
    return false;
  }
  return (
    /(?:结果|后来|因此|所以|最终|现在).{0,28}(?:同意|拒绝|通过|失败|成功|变得|让我|轻松|开心|难受|后悔|更好|更糟|收到|有了)|(?:同意|拒绝|通过|失败|成功|收到).{0,20}(?:了|结果|通知)/u.test(
      text,
    ) || /几天后的结果是|这是混合结果|出现的实际反馈/u.test(text)
  );
}

function isCausalRecapOrProvenanceRequest(text: string): boolean {
  return /请.{0,16}(?:区分|回顾|总结).{0,40}(?:决定|行动|结果)|目前停在哪一步.{0,24}(?:决定|行动|结果)|哪段对话.{0,32}(?:影响|决定).{0,48}哪条消息|哪条消息.{0,24}(?:证明|行动|结果)|按顺序回顾/u.test(
    text,
  );
}

export function hasMixedCausation(text: string): boolean {
  return /混合原因|既有.{0,12}行动.{0,16}也有.{0,12}外部|外部因素|同时.{0,20}(?:资金|政策|市场|公司另行)/u.test(
    text,
  );
}

export function inferOutcomeValence(
  text: string,
): "positive" | "negative" | "mixed" | "neutral" {
  if (/混合结果|不是纯好消息|好的一面和坏的一面/u.test(text)) {
    return "mixed";
  }
  const positive =
    /成功|通过|同意|轻松|开心|更好|庆幸|值得|满意|稳定|放心|动力/u.test(text);
  const negative =
    /失败|拒绝|难受|更糟|后悔|失望|痛苦|损失|不稳定|担心|变少|减少|延迟|麻木/u.test(
      text,
    );
  if (positive && negative) return "mixed";
  if (positive) return "positive";
  if (negative) return "negative";
  return "neutral";
}

export function isReflectionEvidence(text: string): boolean {
  text = independentConsentEvidenceText(text);
  if (
    isSpeculativeLifeEvidence(text) ||
    hasNonUserReflectionSubject(text) ||
    /有没有改变你|请.{0,8}(?:回顾|总结|区分)|你现在怎么看/u.test(text)
  ) {
    return false;
  }
  return /回头看|现在想想|我觉得这个决定|我对这个选择|我后悔|我很庆幸|我才明白|我想明白|我(?:现在)?的理解是|重新想/u.test(
    text,
  );
}

export function reflectionLesson(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}…`;
}

export function reflectionStance(
  text: string,
): "affirm" | "question" | "reverse" | "mixed" | "unclear" {
  if (/后悔|改主意|不该|选错|反悔/u.test(text)) return "reverse";
  if (
    /一方面|但也|有好有坏|复杂|(?:仍)?认同.{0,80}(?:但|代价)|(?:但|同时).{0,48}(?:代价|担心)/u.test(
      text,
    )
  )
    return "mixed";
  if (/庆幸|值得|选对|没选错|很满意|(?:仍)?认同|仍会选择/u.test(text))
    return "affirm";
  if (/怀疑|不确定|是不是/u.test(text)) return "question";
  return "unclear";
}
