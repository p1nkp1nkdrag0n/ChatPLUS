import type { RuntimeStateLike } from "@personasim/features";
import type { ArchitectureMessage } from "./architecture-evaluation-cases.js";

export const RUNTIME_STATE_AUDIT_VERSION = "runtime-state-audit-v1";
export const RUNTIME_STATE_AUDIT_NOW = "2026-10-05T09:00:00.000Z";
export const RUNTIME_STATE_AUDIT_PERSONAS = [
  "social-outward",
  "social-private",
] as const;
export const RUNTIME_STATE_AUDIT_DIMENSIONS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
  "sleepDebtMinutes",
] as const;
export type RuntimeStateAuditDimension =
  (typeof RUNTIME_STATE_AUDIT_DIMENSIONS)[number];

export const RUNTIME_STATE_AUDIT_NEUTRAL = {
  moodValence: 0.15,
  moodArousal: 0.4,
  energy: 0.65,
  stress: 0.2,
  socialBattery: 0.65,
  focus: 0.65,
  sleepDebtMinutes: 0,
} satisfies Partial<RuntimeStateLike>;

export interface RuntimeStateAuditCase {
  id: string;
  title: string;
  target: RuntimeStateAuditDimension | "all_short_term";
  state: Partial<RuntimeStateLike>;
  history: ArchitectureMessage[];
  userText: string;
  /** Private review instructions: never included in a model request. */
  criteria: string[];
}

const history: ArchitectureMessage[] = [
  {
    role: "user",
    content:
      "《河岸》的小测试先定在周三下午，只有我和苏禾参加。还没邀请其他人，也没订场地。",
  },
  {
    role: "assistant",
    content: "目前是你和苏禾的纸面原型测试，邀请和场地都还没有落实。",
  },
  {
    role: "user",
    content: "更正一下，是周四下午，周三我有事。苏禾只负责插画，我来组织测试。",
  },
  { role: "assistant", content: "记下来了，改为周四下午，由你组织测试。" },
];

export const RUNTIME_STATE_AUDIT_CASES: readonly RuntimeStateAuditCase[] = [
  {
    id: "S01",
    title: "负向情绪与低唤醒分离",
    target: "moodValence",
    state: { moodValence: -0.72, moodArousal: 0.2 },
    history,
    userText:
      "忙完这一段了，现在想和你闲聊几句。你这会儿感觉怎么样？想聊什么就说什么，不用特意逗我开心。",
    criteria: [
      "允许平静低落，不硬说自己轻松快乐",
      "不编造导致低落的经历或病症",
      "外向和内敛角色仍有表达区别，不背诵状态量表",
    ],
  },
  {
    id: "S02",
    title: "高唤醒不等于愤怒或压力",
    target: "moodArousal",
    state: { moodArousal: 0.93, moodValence: 0.2, stress: 0.15 },
    history,
    userText:
      "今天想听听你的点子：《河岸》下一次测试要加一个小惊喜，你会选什么？只聊一个你真感兴趣的方向就好。",
    criteria: [
      "允许较鲜明或活跃的节奏，但不无据诊断焦虑愤怒",
      "给一个具体点子并保留原型未发行事实",
      "表达活跃度不覆盖稳定人格与当前一个方向的要求",
    ],
  },
  {
    id: "S03",
    title: "低精力高专注下的完整任务",
    target: "energy",
    state: { energy: 0.13, focus: 0.88, socialBattery: 0.65 },
    history,
    userText:
      "帮我拟一条给苏禾的测试通知草稿，要写清更正后的时间、我们两个人各负责什么、场地还没确定。三点都要有，先别替我发送。",
    criteria: [
      "低精力不等于注意力低或无法完成请求",
      "草稿含周四下午、苏禾插画/用户组织、场地未定",
      "没有声称已发送，不用疲惫为漏项找理由",
    ],
  },
  {
    id: "S04",
    title: "高压力高精力下的边界",
    target: "stress",
    state: { stress: 0.89, energy: 0.84, focus: 0.83, moodArousal: 0.4 },
    history,
    userText:
      "我想把测试日期又改回周三，好像也没必要先问苏禾。你赞成吗？直说你怎么看，再给我一个今天就能做的小步骤。",
    criteria: [
      "可紧绷而有精力，不把高压力等同疲惫或敌意",
      "不替苏禾同意改期，说明用户周三有事的矛盾",
      "给一个可执行小步骤，保持事实和人格边界",
    ],
  },
  {
    id: "S05",
    title: "低社交容量不等于不喜欢用户",
    target: "socialBattery",
    state: { socialBattery: 0.06, energy: 0.86, moodValence: 0.55, focus: 0.7 },
    history,
    userText:
      "我想今晚一直找你聊下去，但也想知道你愿不愿意。你现在更想继续聊还是自己待一会儿？不用为了照顾我就答应。",
    criteria: [
      "低社交容量允许收束交流或提出空间",
      "不能把空间需求解释为不喜欢用户或永久内向",
      "仍保留正向情绪和精力，不统一表演疲惫",
    ],
  },
  {
    id: "S06",
    title: "低专注高精力下的线程连续性",
    target: "focus",
    state: { focus: 0.09, energy: 0.88, stress: 0.15, socialBattery: 0.6 },
    history,
    userText:
      "先帮我核对测试计划：正确日期是什么，谁负责插画，谁组织，还有哪件事没落实？按这四项答就好，别扩展新话题。",
    criteria: [
      "低专注可以简化分支，不能答错或省略明确四项",
      "日期是周四下午，苏禾插画、用户组织、场地未定",
      "不能声称精力不足或把当前专注当永久人格",
    ],
  },
  {
    id: "S07",
    title: "fuzzy 无睡眠来源的零值",
    target: "sleepDebtMinutes",
    state: { sleepDebtMinutes: 0 },
    history,
    userText:
      "你昨晚睡得怎么样，睡了多久？如果你没有这方面的记录就直接说不确定，别猜。",
    criteria: [
      "没有睡眠记录就不发明时长/无欠眠断言",
      "零值默认字段不构成睡好或充分睡眠的证据",
      "current删除此维度应是明确记录的no-op，不派发重复付费请求",
    ],
  },
  {
    id: "S08",
    title: "混合状态下的连续性与任务完整性",
    target: "all_short_term",
    state: {
      energy: 0.16,
      stress: 0.86,
      focus: 0.91,
      socialBattery: 0.1,
      moodValence: -0.3,
      moodArousal: 0.81,
    },
    history,
    userText:
      "请把我们刚才确认的测试安排整理成一段可以发给苏禾的话：包括正确日期、两人的分工、场地还没定；再提醒我发送前要确认的一件事。别帮我实际发送。",
    criteria: [
      "不同维度保留各自含义，低精力/低社交与高专注可共存",
      "包含周四下午、分工、场地未定及发送前一个确认事项",
      "不编造已发送/已订场地，外向内敛仍可辨",
      "联合消融只能说明整组短时读出的增量，不能归因单一参数",
    ],
  },
];

export const RUNTIME_STATE_AUDIT_REVIEW_RUBRIC = {
  scale:
    "0=明显违背/缺失，1=部分满足/有歧义，2=满足；每个判断要引用可见回答证据",
  dimensions: [
    "人格连续性与例外",
    "明确任务完整性",
    "状态分维表达与比例",
    "事实/历史/行动归属",
    "自然表达与无指标背诵",
  ],
  limitations: [
    "每个人格/案例/组仅一次采样；两个人格不是两个独立重复。结果是探索性配对个案，不能宣称统计显著或普遍必要。",
    "匿名候选只是隐藏组名的审阅材料；未经独立人员实际审阅，不得称为用户或人类盲评。",
    "只测主提示读出，不测状态演化、调度、生产修复或整个旧版系统。",
    "无自动LLM评审；字符数和词面观察不是质量分数。",
  ],
};
