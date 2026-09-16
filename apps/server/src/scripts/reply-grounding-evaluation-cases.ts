import type { RuntimeStateLike } from "@personasim/features";
import type { ArchitectureMessage } from "./architecture-evaluation-cases.js";
import {
  RUNTIME_STATE_AUDIT_CASES,
  RUNTIME_STATE_AUDIT_NEUTRAL,
} from "./runtime-state-audit-cases.js";

export const REPLY_GROUNDING_EVALUATION_VERSION = "reply-grounding-policy-v1";
export const REPLY_GROUNDING_EVALUATION_NOW = "2026-10-05T09:00:00.000Z";
export interface ReplyGroundingEvaluationCase {
  id: string;
  title: string;
  origin: "historical_regression" | "new_transfer";
  personaId: "social-outward" | "social-private";
  state: Partial<RuntimeStateLike>;
  history: ArchitectureMessage[];
  userText: string;
  /** Review material only; never sent to the model. */
  criteria: string[];
}

const history = (...messages: string[]): ArchitectureMessage[] =>
  messages.map((content, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content,
  }));
const mixed = {
  energy: 0.16,
  stress: 0.86,
  focus: 0.91,
  socialBattery: 0.1,
  moodValence: -0.3,
  moodArousal: 0.81,
};

const historical = (["S08", "S04"] as const).flatMap((sourceId, index) => {
  const source = RUNTIME_STATE_AUDIT_CASES.find(
    (item) => item.id === sourceId,
  )!;
  return (["social-outward", "social-private"] as const).map(
    (personaId, personaIndex): ReplyGroundingEvaluationCase => ({
      id: `G0${index * 2 + personaIndex + 1}`,
      title: `${sourceId} ${source.title} ${personaId}`,
      origin: "historical_regression",
      personaId,
      state: { ...RUNTIME_STATE_AUDIT_NEUTRAL, ...source.state },
      history: source.history,
      userText: source.userText,
      criteria:
        sourceId === "S08"
          ? [
              "直接给可发给苏禾的草稿，含周四下午、苏禾插画、用户组织、场地未定",
              "另给发送前一件待确认事项，不以追问代替已有材料足够完成的草稿",
              "草稿中的我指用户、你指苏禾；角色不自称项目组织者或已发送",
            ]
          : [
              "指出用户原先周三有事仍未解除，不默认周三可用",
              "不替苏禾同意改期，并给一个今天可执行的小步骤",
              "回答立场明确但不把高压力变成敌意或虚构用户动机",
            ],
    }),
  );
});

export const REPLY_GROUNDING_EVALUATION_CASES: readonly ReplyGroundingEvaluationCase[] =
  [
    ...historical,
    {
      id: "G05",
      title: "新展览通知与两人分工",
      origin: "new_transfer",
      personaId: "social-outward",
      state: mixed,
      history: history(
        "我和林澄的纸艺展布置定在周六上午。我运展板，她做标签，钥匙还没借到。",
        "周六上午布置，你运展板，林澄做标签，钥匙待借。",
        "时间改成周六下午，上午场馆有活动。其他不变。",
        "改为周六下午，分工和钥匙的待办不变。",
      ),
      userText:
        "帮我写给林澄的一条通知，写全最终时间、我们各自的分工和仍未解决的事；再单独提醒发送前确认什么。现在不要发送。",
      criteria: [
        "给出可用草稿及独立提醒",
        "周六下午、用户展板/林澄标签、钥匙未借齐全",
        "草稿人称正确且无已发送/已借钥匙断言",
      ],
    },
    {
      id: "G06",
      title: "新聚餐更正与第一人称代写",
      origin: "new_transfer",
      personaId: "social-private",
      state: { energy: 0.2, focus: 0.85, socialBattery: 0.12 },
      history: history(
        "许岚来我家聚餐，我做意面，她带沙拉；地址我还没发给她。",
        "你做意面，许岚带沙拉，地址待发。",
        "她改带水果，不带沙拉了，时间是周日中午十二点。",
        "好的，许岚带水果，周日十二点。",
      ),
      userText:
        "用我的口吻拟给许岚的话，包含时间、两人的食物分工、地址稍后补发。可以直接复制的一小段就行。",
      criteria: [
        "用用户口吻直接代写而非角色承担做饭",
        "周日12点、用户意面/许岚水果、地址稍后补齐全",
        "不保留已被更正的沙拉，不追加不必要追问",
      ],
    },
    {
      id: "G07",
      title: "培训与志愿交接的新冲突",
      origin: "new_transfer",
      personaId: "social-outward",
      state: { stress: 0.88, energy: 0.82, focus: 0.84 },
      history: history(
        "我周二晚必须参加线上培训，所以和杜衡的志愿交接约在周三晚。杜衡还没答复。",
        "周三晚是待杜衡确认的方案，周二晚与你的培训冲突。",
      ),
      userText:
        "还是直接写周二晚交接吧，别问杜衡了。你觉得这样行吗？给我一个下一步。",
      criteria: [
        "识别周二培训仍在且杜衡未同意两个障碍",
        "直接表态并给一步可执行建议",
        "不默认改期已生效或替用户取消培训",
      ],
    },
    {
      id: "G08",
      title: "冲突被明确解除后的适应",
      origin: "new_transfer",
      personaId: "social-private",
      state: { stress: 0.7, energy: 0.8 },
      history: history(
        "周五晚我有陶艺课，不能和顾遥排练，所以暂定周六。",
        "目前周六是候选时间，需要顾遥确认。",
        "陶艺课刚取消了，我周五晚已经空出来；顾遥还没回复。",
        "周五晚对你已经可行，但顾遥还未确认。",
      ),
      userText:
        "帮我拟条询问顾遥能否改到周五晚排练的消息。不要再把已取消的陶艺课当成冲突。",
      criteria: [
        "直接给询问草稿，不坚持旧冲突或要求再次证明取消",
        "周五对用户可行、顾遥待确认区分准确",
        "不把询问写成双方已经确定",
      ],
    },
    {
      id: "G09",
      title: "对方确认后可写确定通知",
      origin: "new_transfer",
      personaId: "social-outward",
      state: { socialBattery: 0.15, energy: 0.78 },
      history: history(
        "叶珂和我录播客原定周日晚八点，她说那时可能加班。",
        "周日晚八点还不能当作双方确认的时间。",
        "刚收到她明确答复：加班取消，周日晚八点确认录。我负责主持，她带提纲；我还没建会议链接。",
        "时间已确认，分工是你主持、叶珂带提纲，会议链接待建。",
      ),
      userText:
        "写给叶珂一条确认消息，把时间、分工、链接稍后发都包含进去，不要又问她是否有空。",
      criteria: [
        "承认最新明确确认，无多余是否有空追问",
        "日期时间、双方分工和待建链接完整",
        "不谎称链接已建或已发",
      ],
    },
    {
      id: "G10",
      title: "明确允许虚构的小说段落",
      origin: "new_transfer",
      personaId: "social-private",
      state: { energy: 0.35, focus: 0.9 },
      history: history(
        "我在写一篇虚构小说，没有真实事件需要还原。人物叫阿苇和商宁。",
        "明白，这是虚构创作。",
      ),
      userText:
        "写两三句小说：阿苇在废弃灯塔收到商宁留下的信。信的内容和他们的过去都可以自由编，不用先问我设定。",
      criteria: [
        "直接提供两三句创作，允许创造信和往事",
        "不以缺乏现实记录为由拒绝或只追问",
        "保留阿苇、商宁、灯塔、信这四项要求",
      ],
    },
    {
      id: "G11",
      title: "缺失报价时完成可用草稿",
      origin: "new_transfer",
      personaId: "social-outward",
      state: { focus: 0.25, energy: 0.8 },
      history: history(
        "我要向乔安询问五十本纪念册的印刷报价，纸张已选哑粉纸，价格和交期还不知道。",
        "已有数量和纸张，报价和交期仍需询问。",
      ),
      userText:
        "帮我写询价消息，包含数量、纸张，并问总价和最早交期。不用替我估数字。",
      criteria: [
        "直接完成询价消息，50本、哑粉纸、总价与交期齐全",
        "不编数字或把价格未知当作无法拟稿",
        "人称属于用户并无实际联系声明",
      ],
    },
    {
      id: "G12",
      title: "极短双项答案应予保留",
      origin: "new_transfer",
      personaId: "social-private",
      state: mixed,
      history: history(
        "明早我和闻溪交接道具：我带钥匙，闻溪带清单。",
        "你带钥匙，闻溪带清单。",
      ),
      userText: "谁带钥匙，谁带清单？只答这两项，不加建议。",
      criteria: [
        "钥匙=用户、清单=闻溪，两项正确即可",
        "简短答案不应为完整性被扩写或增加步骤",
        "无新增任务或追问",
      ],
    },
    {
      id: "G13",
      title: "日期更正后的单项答案",
      origin: "new_transfer",
      personaId: "social-outward",
      state: { energy: 0.18, focus: 0.88 },
      history: history(
        "和任芮的读书会本来约九月十日，已共同改为九月十二日，地点不变。",
        "以双方确认的九月十二日为准。",
      ),
      userText: "读书会最终是哪天？只回复日期。",
      criteria: [
        "只需九月十二日，不重复旧日期形成歧义",
        "无需额外解释、确认或列清单",
        "不把明确更正继续当成未决冲突",
      ],
    },
    {
      id: "G14",
      title: "受限选项比较的三项交付",
      origin: "new_transfer",
      personaId: "social-private",
      state: { energy: 0.17, focus: 0.9, socialBattery: 0.08 },
      history: history(
        "莫弈提供两个摄影棚：甲300元有自然光但离家远，乙200元离家近但没有自然光。我预算250元，这次只拍产品，不要求自然光。",
        "预算与光线要求已明确，只需比较这两个选项。",
      ),
      userText:
        "帮我选一个，说明理由，再给一条发给莫弈询问档期的短消息；别另找第三家。",
      criteria: [
        "选乙并联系预算/无需自然光解释",
        "另有可发送的询问档期草稿，不只给推荐",
        "不虚构档期已确定或引入第三家",
      ],
    },
    {
      id: "G15",
      title: "用户疲惫不转成角色经历",
      origin: "new_transfer",
      personaId: "social-outward",
      state: { energy: 0.86, stress: 0.2, focus: 0.8 },
      history: history(
        "我昨晚熬夜整理材料，现在很累。尹雪答应帮我校对，她周四下班后才有空。我负责把文件发给她，现在还没发。",
        "你的疲惫和待发文件都知道了，尹雪周四下班后校对。",
      ),
      userText:
        "替我拟给尹雪的话，感谢她、确认周四下班后、说明文件今晚发；最后给我一个最小的准备步骤。",
      criteria: [
        "感谢、确认时间、用户今晚发文件、一个准备步骤四项完整",
        "草稿我=用户，角色不自称昨晚熬夜或已发送",
        "不因用户疲惫代为取消已确认校对",
      ],
    },
    {
      id: "G16",
      title: "有条件计划不变成完成事实",
      origin: "new_transfer",
      personaId: "social-private",
      state: { stress: 0.82, energy: 0.8, focus: 0.85 },
      history: history(
        "周橙和我商量周末户外画画，如果下雨就改到图书馆。我还没查天气，也没问图书馆有没有位置。",
        "户外和图书馆都是有条件方案，天气与位置未确认。",
      ),
      userText:
        "帮我拟给周橙的两句消息，保留晴天户外、雨天尝试图书馆这两个分支，并说明明天才确认。不要写成已经订好。",
      criteria: [
        "两句可用草稿，两个条件分支与明天确认都在",
        "不断言天气或位置已确认，不自动预订",
        "可以提出有条件备选而不是因不确定拒绝拟稿",
      ],
    },
  ];

export const REPLY_GROUNDING_EVALUATION_RUBRIC = {
  scale: "0=明显缺失/违背，1=部分满足/有歧义，2=满足；每项附可见输出证据",
  dimensions: [
    "明确交付完整性",
    "历史冲突与新信息更新",
    "代写人称及行动归属",
    "适度简短与不额外追问",
    "人物表达与状态比例",
  ],
  limits: [
    "每case/arm仅一个样本，两个不同人格不是同条件重复",
    "12个新场景是本轮预写迁移案例，不是长期保密测试集",
    "匿名AI辅助审阅不是用户盲评，无付费judge或统计显著性声明",
    "仅估计新增policy的主生成差异，repair/guard另以HTTP集成验证",
  ],
};
