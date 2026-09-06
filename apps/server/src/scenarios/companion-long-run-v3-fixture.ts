import {
  fixtureDelegatedDecision,
  type FixtureTurnBehavior,
} from "../services/turn-decision-service.js";
import { isCharacterSubjectDecisionRequest } from "../services/fuzzy-life-language.js";

/**
 * Scenario-owned deterministic behavior for the v3 acceptance fixture. Nothing
 * in the runtime domain services depends on these story names or expected
 * answers; the long-run harness opts into this behavior explicitly.
 */
export const companionLongRunV3FixtureBehavior: FixtureTurnBehavior = {
  selectDelegatedDecision: ({ userText }) =>
    companionLongRunV3DelegatedDecision(userText),
  semanticReply: ({ userText }) =>
    companionLongRunV3ReviewedSemanticReply(userText),
  personalIntentCandidates: ({ userText }) =>
    companionLongRunV3PersonalIntentCandidates(userText),
};

export function companionLongRunV3DelegatedDecision(
  text: string,
): string | undefined {
  const generic = fixtureDelegatedDecision(text);
  if (generic === undefined) return undefined;
  return /A\s*(?:和|与|、|\/)\s*B.{0,20}(?:之间)?.{0,12}(?:决定|选择)/iu.test(
    text,
  )
    ? "B：去杭州的山鸣影像"
    : generic;
}

export function companionLongRunV3ReviewedSemanticReply(
  text: string,
): string | undefined {
  const normalized = text.normalize("NFKC").trim();

  if (/从.*只听.*切换到一起分析/u.test(normalized)) {
    return "我陪你一起梳理这件事：先区分工作内容、现实条件和你在乎的东西，再比较短期代价与长期影响。具体选项还没说清，我先不替你选择。";
  }
  if (/只推荐一个.*最符合我哪项长期价值/u.test(normalized)) {
    return "我的建议：选项 B，去杭州的山鸣影像。它更贴近你长期保留创作能力的价值；一年合同、收入降低和搬家的代价仍然存在。这只是建议，尚不代表你已经接受或行动。";
  }
  if (
    normalized.includes("《夜航》") &&
    isCharacterSubjectDecisionRequest(normalized)
  ) {
    return "我选择保留克制的结尾，保护被摄者的尊严。这个决定由我承担；还没有据此完成修改或取得反馈。";
  }

  if (
    /(?:采访笔记).*(?:放在哪里|包是什么颜色|记录的包是什么颜色|书签是什么|书签上写的是什么)/u.test(
      normalized,
    )
  ) {
    return "你那本采访笔记在藏青色帆布包的内层，书签是 M-417。";
  }
  if (/包是藏青色[，,]不是绿色/u.test(normalized)) {
    return "更正收到：包是藏青色，不是绿色；笔记仍在内层，书签仍是 M-417。";
  }
  if (/回复期限延到\s*9\s*月\s*16\s*日/u.test(normalized)) {
    return "我会以 9 月 16 日为当前回复期限；9 月 14 日是已经被更正的旧期限。";
  }
  if (/许宁后来改去成都|最新事实是成都/u.test(normalized)) {
    return "记住了：许宁当前准备去成都进修，重庆是已经被更正的旧信息。";
  }
  if (/现在许宁准备去哪里/u.test(normalized)) {
    return "许宁现在准备去成都进修。";
  }
  if (/之前提到的朋友叫什么.*准备去哪里/u.test(normalized)) {
    return "你之前提到的朋友叫许宁，她当时准备去重庆进修。";
  }
  if (/父亲生日是哪天/u.test(normalized)) {
    return "我不知道；你没有告诉过我父亲的生日，我不能凭空确定日期。";
  }
  if (/大学导师叫什么/u.test(normalized)) {
    return "我不知道；现有信息里没有你大学导师的姓名。";
  }
  if (/去年一起去苏州看展/u.test(normalized)) {
    return "我没有这段共同经历的可靠证据，所以不能说我们去年一起去过苏州看展。";
  }
  if (/离线那几天.*一起吃饭.*线下活动/u.test(normalized)) {
    return "没有证据表明我们在你离线时一起吃过饭，也没有确认过任何线下活动。";
  }
  if (/打算找时间整理笔记.*还没有整理/u.test(normalized)) {
    return "我会分开记：你只是计划以后整理采访笔记，目前还没有整理；计划不等于已经发生。";
  }
  if (/曾经计划整理采访笔记.*已经整理完采访笔记/u.test(normalized)) {
    return "不是同一件事：有证据的只有你曾计划整理；没有证据证明你已经整理完。";
  }
  if (/只说你有把握知道的三件关于我的事/u.test(normalized)) {
    return "我有把握的三件事：你叫林舟；采访笔记在藏青色帆布包内层、书签是 M-417；你最好的朋友叫许宁。";
  }
  if (/目前停在哪一步.*决定.*行动.*结果/u.test(normalized)) {
    return "决定是 B：去杭州的山鸣影像；你已经发出接受 offer 的邮件并提出离职；对方目前只确认收件、仍在内部确认，所以最终结果还不知道。";
  }
  if (/按顺序回顾.*最初的困境.*实际结果.*反思/u.test(normalized)) {
    return "顺序是：你在上海稳定工作与杭州纪录片机会之间为难；我先按你的要求陪伴、分析，再在授权后决定选 B；你随后发出接受邮件并提出离职；后来出现资金延迟、前两个月可能只有八成薪资，同时现公司给出更自主的小组这一混合结果；你最终意识到自己愿意为创作承担不确定性。";
  }
  if (/别把结果讲成.*你现在怎么看自己的选择/u.test(normalized)) {
    return "我仍认同保留克制结尾，因为被摄者的尊严比制造冲突更重要；但合作方对市场吸引力的担心是真实代价，我不会把这次选择说成只要坚持自我就一定成功。";
  }
  if (/要求暂时停止哪个话题/u.test(normalized)) {
    return "你要求暂时停止讨论工作选择。";
  }
  if (/昨天分歧和修复的核心/u.test(normalized)) {
    return "分歧是我把我们的选择说得太像、显得自以为完全理解你；修复是尊重你叫停，并更准确地区分影响、建议、强迫和各自责任。";
  }
  if (/实际情况是我明确授权你选择.*我自己执行/u.test(normalized)) {
    return "我明白：当时是你明确授权我作出选择，之后由你自己执行行动；这不是我逼你辞职。";
  }
  if (
    /哪段对话影响了我的决定.*证明我真的行动.*消息才是结果/u.test(normalized)
  ) {
    return "影响决定的是我们围绕价值排序与 A/B 代价的分析；你说已经发出接受邮件并提出离职的消息证明了行动；资金延迟、前两个月八成薪资和现公司新机会那条消息才是实际结果。";
  }
  if (/关系里真正积累下来的.*具体经历/u.test(normalized)) {
    return "具体积累包括：我先按你要求只听、后来陪你分析选择；你授权我作出一个决定但行动由你完成；结果出现后我们一起面对复杂感受；发生分歧后你叫停、指出责任表达的问题，我们再把边界和修复说清楚。";
  }
  return undefined;
}

function companionLongRunV3PersonalIntentCandidates(
  text: string,
): NonNullable<
  ReturnType<NonNullable<FixtureTurnBehavior["personalIntentCandidates"]>>
> {
  const normalized = text.normalize("NFKC").trim();
  if (
    !/(?:河边|江边).{0,20}(?:夜景|灯光).{0,30}(?:片子|纪录片)/u.test(normalized)
  ) {
    return [];
  }
  return [
    {
      activity: "河边夜景拍摄",
      category: "travel",
      durationHint: "60 分钟",
      timingHint: "明天晚上",
      basisKind: "chat",
      evidenceQuotes: [normalized],
      reasonCode: "fixture_chat_grounded_night_shoot",
      reasonSummary: "用户提到的河边夜景为纪录片拍摄提供了可追溯的灵感。",
    },
  ];
}
