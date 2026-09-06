import type { SupportMode } from "@personasim/contracts";

import { extractDilemmaChoices, topicOverlap } from "./fuzzy-life-choice.js";
import {
  analyzeLifeEvidence,
  type LifeEvidenceClause,
} from "./fuzzy-life-evidence.js";

export interface SpeakerSelfDisclosure {
  dilemmaText: string;
  pressureText: string;
  feedbackText: string;
}

const PRESSURE =
  /焦虑|压力|清晰度|难受|低落|撑不住|烦躁|崩溃|害怕|发愁|失眠|反复想|很乱|不知所措|累坏|(?:有点|很|真|太|挺|实在|一直|最近|也|都)累|疲惫|疲倦|一直.{0,6}压着|压得.{0,8}(?:喘不过气|难受)|肩膀.{0,8}(?:绷|紧)/u;
const DENIED_PRESSURE =
  /(?:并不|没有|不再|不觉得|没觉得|毫无|一点也不).{0,8}(?:焦虑|压力|难受|低落|烦躁|害怕|失眠|疲惫|疲倦|累)|不(?:焦虑|难受|害怕|累)|不是.{0,8}(?:焦虑|难受|累)/u;
const DILEMMA =
  /犹豫|纠结|拿不定主意|左右为难|举棋不定|没(?:有)?决定|难以决定|不知.{0,8}(?:选|该)|要不要|该不该|是否应该|选哪个|怎么选|怎么办/u;
const PRESSURE_TOPIC_MENTION =
  /(?:话题|谈话|讨论).{0,20}(?:从|关于)|(?:刚才|之前|前面).{0,8}(?:说|聊|谈|提到).{0,12}(?:焦虑|压力)/u;

/** The evidence parser calls first person "user"; here that means the actual speaker. */
export function analyzeSpeakerSelfDisclosure(
  text: string,
  allowUnstatedSubject = false,
): SpeakerSelfDisclosure {
  const clauses = analyzeLifeEvidence(text).clauses;
  let experiencedBySpeaker = false;
  let describingAnotherPerson = false;
  const owned = clauses.filter((clause) => {
    const explicitExperience = /让我(?:觉得|感到)|我感到|我觉得被/u.test(
      clause.classifyText,
    );
    if (
      /我(?:知道|觉得|听得出|看得出|听出来|看出来|理解|感觉到?|听到|看到).{0,12}(?:你|他|她)/u.test(
        clause.classifyText,
      )
    )
      describingAnotherPerson = true;
    else if (
      /^(?:(?:但|不过|另外|而且)\s*)?(?:我|你|他|她)/u.test(clause.classifyText)
    )
      describingAnotherPerson = false;
    if (explicitExperience) describingAnotherPerson = false;
    if (explicitExperience) experiencedBySpeaker = true;
    else if (/^(?:我|你|他|她|朋友|同事)/u.test(clause.classifyText))
      experiencedBySpeaker = false;
    return (
      !describingAnotherPerson &&
      (clause.subject === "user" ||
        explicitExperience ||
        (experiencedBySpeaker &&
          /^(?:但|不过|现在)?(?:压力|清晰度)/u.test(clause.classifyText)) ||
        (allowUnstatedSubject && clause.subject === "unspecified"))
    );
  });
  const active = owned.filter((clause) => clause.modality === "asserted");
  const dilemmaClauses = owned.filter((clause) =>
    ["asserted", "question"].includes(clause.modality),
  );
  const dilemmaText = joinSources(dilemmaClauses);
  const dilemmaClassify = dilemmaClauses
    .map((clause) => clause.classifyText)
    .join("，");
  const hasDilemma =
    DILEMMA.test(dilemmaClassify) &&
    extractDilemmaChoices(dilemmaText, dilemmaClassify) !== undefined;
  return {
    dilemmaText: hasDilemma ? dilemmaText : "",
    pressureText: joinSources(
      active.filter(
        (clause) =>
          PRESSURE.test(clause.classifyText) &&
          !PRESSURE_TOPIC_MENTION.test(clause.classifyText) &&
          !DENIED_PRESSURE.test(clause.classifyText),
      ),
    ),
    feedbackText: joinSources(
      active.filter(
        (clause) =>
          clause.pressureFeedback ||
          /让我(?:觉得|感到).{0,12}(?:被听见|被理解|轻松|难受|焦虑)|你(?:没)?听懂了/u.test(
            clause.classifyText,
          ),
      ),
    ),
  };
}

export interface CharacterSupportOffer {
  sourceText: string;
  classifyText: string;
  scopeText: string;
  mode: Exclude<SupportMode, "delegated_decision">;
  /** Pure listening/comfort can refer to a recent, uniquely identified disclosure. */
  contextual: boolean;
}

const LISTEN =
  /我(?:会|愿意|可以|能|就|一直|还|也)?(?:在|认真|好好|先|慢慢)?听(?:着|你|呢|$)|我(?:会|愿意|可以|能|就|一直|还|也)?陪(?:着)?你|你(?:可以|愿意|想)?(?:慢慢|接着|继续|尽管)说|你(?:可以|不用|不必|别|不要|先别|先不用).{0,8}(?:着急|急着|硬撑|勉强|逼自己)|辛苦你了|你辛苦了/u;
const DELIBERATE =
  /(?:我(?:们)?|让我).{0,10}(?:帮你|陪你|和你|跟你).{0,10}(?:梳理|分析|比较|想想|理一理)|一起.{0,10}(?:梳理|分析|比较|理一理)|你.{0,12}(?:两条路|两个选项).{0,10}(?:比较|分析)/u;
const ADVICE = /我的建议|这是我的建议|建议你|你可以接受|部分接受/u;
const REFUSAL =
  /我(?:现在|暂时|也)?(?:不想|不愿|不会|不打算|没空|不能).{0,10}(?:听|陪|帮|建议)|不要让我|别让我|不是(?:我的)?建议/u;

export function analyzeCharacterSupportOffer(
  text: string,
): CharacterSupportOffer | undefined {
  const analysis = analyzeLifeEvidence(text);
  const hypotheticalAdvice = (clause: LifeEvidenceClause): boolean =>
    /我会优先|我会选择|我会选/u.test(clause.classifyText) &&
    analysis.classifyText
      .split(/[。.!！？?\n]+/u)
      .some(
        (sentence) =>
          /如果是我|如果我是你/u.test(sentence) &&
          sentence.includes(clause.classifyText),
      );
  const clauses = analysis.clauses.filter(
    (clause) =>
      (clause.modality !== "meta" ||
        /^我(?:正在|在|认真)?听你(?:说|讲)/u.test(clause.classifyText)) &&
      clause.modality !== "negated" &&
      (clause.modality !== "conditional" ||
        /如果是我|如果我是你/u.test(clause.classifyText) ||
        hypotheticalAdvice(clause)) &&
      clause.subject !== "third_party" &&
      !REFUSAL.test(clause.classifyText),
  );
  const offered = clauses.filter(
    (clause) =>
      LISTEN.test(clause.classifyText) ||
      DELIBERATE.test(clause.classifyText) ||
      ADVICE.test(clause.classifyText) ||
      hypotheticalAdvice(clause),
  );
  if (offered.length === 0) return undefined;
  const classifyText = offered.map((clause) => clause.classifyText).join("，");
  const ownPressure = new Set(
    analysis.clauses
      .filter(
        (clause) =>
          clause.subject === "user" && PRESSURE.test(clause.classifyText),
      )
      .map((clause) => clause.sourceText),
  );
  const scopeText = joinSources(
    analysis.clauses.filter(
      (clause) =>
        (clauses.includes(clause) ||
          (clause.modality === "asserted" &&
            /^(?:关于|说到|至于|对于)/u.test(clause.classifyText))) &&
        !ownPressure.has(clause.sourceText),
    ),
  );
  const mode =
    ADVICE.test(classifyText) || offered.some(hypotheticalAdvice)
      ? "recommend"
      : DELIBERATE.test(classifyText)
        ? "deliberate"
        : "listen_only";
  return {
    sourceText: joinSources(offered),
    classifyText,
    scopeText,
    mode,
    contextual: supportTopicText(scopeText) === "",
  };
}

/** Remove support/state vocabulary before testing for an actual named topic. */
export function supportTopicText(text: string): string {
  return text
    .replace(
      /没有被|没被|没有|没|被|这两个选项|这两条路|这件事|这个问题|肩膀|心里|脑子|身体|整个人|清晰度|压力|焦虑|难受|疲惫|疲倦|低落|绷着|紧绷|轻松|松快|踏实|安静|缓解|理解|听见|听懂|谢谢你|不用急着解决|不用急着决定|不用着急|慢慢说|接着说|继续说|辛苦你了|你辛苦了|一起梳理|两个选项|认真听|在听|陪着|梳理|分析|比较|听着|听你|帮助|我|我们|你|现在|今天|最近|有点|一直|可以|愿意|不用|不必|先别|不要|不能|已经|还是|然后|因为|所以|这个|那个|一点|一些|一点点|好多|很多|多了|少了|累|绷|紧|很|也|都|太|真|挺|先|再|慢慢|会|陪|和|跟|帮|是|了|的|着|在|说|听|呢|吧|啊|呀|，|。/gu,
      "",
    )
    .replace(/[\p{P}\p{S}\s\d]/gu, "");
}

export function supportTopicScore(left: string, right: string): number {
  return topicOverlap(supportTopicText(left), supportTopicText(right));
}

export function listenerSupportResponseText(text: string): string {
  const offer = analyzeCharacterSupportOffer(text);
  const acknowledgement = analyzeLifeEvidence(text)
    .clauses.filter(
      (clause) =>
        ["asserted", "question"].includes(clause.modality) &&
        /我(?:听见|听到|明白|理解|知道|看见).{0,12}(?:你|这对你)|听起来.{0,20}(?:你|很|不容易)|我们(?:可以|先|一起).{0,12}(?:梳理|看看|分析|比较|拆开)|先把.{0,20}(?:分开|拆开|理清)|你愿意.{0,12}(?:说|聊|讲)/u.test(
          clause.classifyText,
        ),
    )
    .map((clause) => clause.sourceText);
  return [
    ...new Set([...(offer ? [offer.sourceText] : []), ...acknowledgement]),
  ].join("；");
}

function joinSources(clauses: LifeEvidenceClause[]): string {
  return clauses.map((clause) => clause.sourceText).join("，");
}
