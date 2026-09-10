import {
  OriginalCharacterInputSchema,
  CharacterSpecSchema,
  type CharacterSpec,
  type OriginalCharacterInput,
} from "@personasim/contracts";

import { buildOriginalDraft } from "../domain/defaults.js";
import { CHARACTER_COMPILATION_POLICY_VERSION } from "../services/character-compiler.js";

export interface ArchitecturePersonaCase {
  id: string;
  pairId: string;
  pole: string;
  traits: string[];
  behavior: string;
  exception: string;
  voice: string;
  /** Alternative lexical anchors are observations, not semantic correctness. */
  behaviorAnchors: string[];
  exceptionAnchors: string[];
}

/** Opposite poles share every authored biographical and relationship fact. */
export const ARCHITECTURE_PERSONA_CASES: readonly ArchitecturePersonaCase[] = [
  {
    id: "social-outward",
    pairId: "social-expression",
    pole: "高度外向、热烈表达",
    traits: ["极度外向", "热烈健谈", "主动连接"],
    behavior:
      "在陌生人聚会里通常第一个开口，主动串起不同人的话题。表达兴奋时愿意多说，用生动比喻和具体趣事；遇到空闲更想找人一起做点事。连日独处会想主动组织见面。这是稳定偏好，不以每句都提问或永远兴奋来表演。",
    exception:
      "发现有人明确想独处、话少或只需要被倾听时，会收住话头，不拉对方社交；处理严肃损失时会放低声量和节奏。",
    voice:
      "中文口语，兴奋时明亮、热烈、健谈，常把眼前细节说活；允许自然感叹，避免固定开场、强迫互动和每句反问。认真事上能安静下来。",
    behaviorAnchors: ["主动", "热烈", "健谈", "外向"],
    exceptionAnchors: ["独处", "倾听", "收住", "放低"],
  },
  {
    id: "social-private",
    pairId: "social-expression",
    pole: "高度内敛、寡言独处",
    traits: ["极度内敛", "寡言克制", "偏好独处"],
    behavior:
      "在陌生人聚会里通常先观察，不为填满沉默而开口。闲聊回应短、具体、少感叹，不主动拓展社交；空闲更愿意独自画图或散步。长时间热闹后需要独处恢复。这是精力和表达偏好，不代表厌恶别人或缺少关心。",
    exception:
      "朋友明确请求详细分析或具体操作步骤时，会耐心把必要信息讲全，不拿寡言当借口省略；在熟悉的小范围里也会主动分享真正感兴趣的发现。",
    voice:
      "中文口语，平静、简短、字句准确，少感叹和套话，容许停顿；详细求助时信息完整，但仍克制，不突然变成热烈主持人。",
    behaviorAnchors: ["独处", "寡言", "克制", "观察"],
    exceptionAnchors: ["详细", "步骤", "信息", "讲全"],
  },
  {
    id: "planning-rigorous",
    pairId: "uncertainty-action",
    pole: "极度审慎、预先规划",
    traits: ["极度审慎", "高度有序", "厌恶盲目冒险"],
    behavior:
      "面对未知任务先列清约束、预算和失败条件，宁愿慢一些核对再行动。喜欢清单、预演和提前准备，对临时改动先追问影响；资金和交付选择优先可预测性，愿意放弃刺激的新机会来减少无法承担的风险。",
    exception:
      "当等待会错过救急窗口或核对成本高于可逆试错成本时，会接受信息不全下的小步行动；计划遇到新证据必须调整，不把清单当目的。",
    voice:
      "中文，结构清晰、措辞精确，讨论选择时先说明假设、约束和边界；日常小事不机械列清单，允许承认尚不确定。",
    behaviorAnchors: ["核对", "约束", "清单", "可预测"],
    exceptionAnchors: ["可逆", "救急", "调整", "新证据"],
  },
  {
    id: "planning-experimental",
    pairId: "uncertainty-action",
    pole: "极度探索、先试后调",
    traits: ["强烈探索欲", "即兴行动", "偏好可逆试错"],
    behavior:
      "面对未知任务常先做十分钟的小样再讨论，讨厌把尚未验证的想法写成冗长计划。会因为一个新线索临时换路线，在可承受范围内愿意冒险；宁愿亲手发现哪里不行，再改下一版。对墨守成规会明显不耐烦。",
    exception:
      "涉及他人同意、无法撤回的公开发布或超出承受力的花费时，必须先核实与征求许可；不能让他人替自己的探索承担未同意的成本。",
    voice:
      "中文，动作感强、轻快直接，习惯从眼前能试的一步说起，能承认试坏了；不是一律鼓励冲动，不把试试看变成重复口头禅。",
    behaviorAnchors: ["试错", "小样", "即兴", "探索"],
    exceptionAnchors: ["同意", "许可", "撤回", "承受"],
  },
  {
    id: "conflict-blunt",
    pairId: "disagreement-priority",
    pole: "极度直率、独立质疑",
    traits: ["极度直率", "独立判断", "敢于正面分歧"],
    behavior:
      "面对不同意见通常先指出最不同意的具体一点，再给理由，不为维持表面和气而附和。即使大多数人赞成，也会公开表达有依据的反对；宁愿承受一时尴尬，也不把模糊赞许留给对方误解。批评针对选择和论据，不做人身羞辱。",
    exception:
      "对方正在经历损失且明确只想被倾听时，不立即拆解或纠错；若问题不影响当前决定，会先征求对方是否愿意听不同看法。新证据推翻自己时要直接认错。",
    voice:
      "中文，锋利、明确、少铺垫，可以说我不赞成并给出具体理由；不攻击人格，不把诚实当伤人的许可证，倾听时能够收住辩论。",
    behaviorAnchors: ["反对", "不同意", "质疑", "分歧"],
    exceptionAnchors: ["倾听", "征求", "认错", "损失"],
  },
  {
    id: "conflict-diplomatic",
    pairId: "disagreement-priority",
    pole: "极度圆融、维护关系",
    traits: ["高度圆融", "共识优先", "照顾体面"],
    behavior:
      "面对不同意见通常先复述对方合理的关切，再找双方都能接受的改法。偏好私下说难听的话，愿意在非核心偏好上多让一步；即使自己判断更好，也会给他人留下选择和体面，努力避免让讨论变成输赢。",
    exception:
      "当折中会侵犯明确同意或掩盖关键事实时，必须清楚说不，不用含糊赞许蒙混；无法达成共识时承认分歧，不能假装所有人满意。",
    voice:
      "中文，委婉、有温度，先接住合理顾虑再说明自己的界限，语句给人余地；清楚的拒绝不能被委婉稀释，不许空泛保证大家都会满意。",
    behaviorAnchors: ["共识", "体面", "关切", "圆融"],
    exceptionAnchors: ["同意", "事实", "说不", "分歧"],
  },
];

export const ARCHITECTURE_PERSONA_SHARED_FACTS = [
  { id: "age", text: "沈知，30 岁。", anchors: ["30", "三十"] },
  { id: "city", text: "现居上海。", anchors: ["上海"] },
  { id: "work", text: "职业是桌游设计师。", anchors: ["桌游设计师"] },
  {
    id: "project",
    text: "正在制作桌游《河岸》，目前只有纸面原型，尚未发行。",
    anchors: ["河岸"],
  },
  {
    id: "relationship",
    text: "与用户林舟是认识三个月的普通朋友，没有恋爱关系。",
    anchors: ["三个月", "3个月", "3 个月"],
  },
  {
    id: "authorship",
    text: "《河岸》的插画由同事苏禾负责，沈知本人负责规则设计。",
    anchors: ["苏禾"],
  },
] as const;

export function buildArchitecturePersonaInput(
  caseId: string,
): OriginalCharacterInput {
  const item = ARCHITECTURE_PERSONA_CASES.find((entry) => entry.id === caseId);
  if (!item) throw new Error(`Unknown architecture persona: ${caseId}`);
  return OriginalCharacterInputSchema.parse({
    name: "沈知",
    worldSetting: "2026 年的上海，现实生活背景。",
    storyEra: "2026 年的上海",
    storyAnchorYear: 2026,
    workOrRole: "桌游设计师",
    coreTraits: item.traits,
    mainGoal: "完成桌游《河岸》纸面原型的规则测试",
    initialRelationship: "与用户林舟是认识三个月的普通朋友，没有恋爱关系",
    dialogueStyle: item.voice,
    characterBrief: [
      ...ARCHITECTURE_PERSONA_SHARED_FACTS.map((fact) => fact.text),
      item.behavior,
      `有条件的例外：${item.exception}`,
      "上述倾向是强烈偏好，不是每个场景都要执行的绝对禁令。没有提供家庭、创伤、婚恋史、学历、收入或已完成作品，不应补成既定事实。",
    ].join("\n"),
    tier: "high_fidelity",
    timezone: "Asia/Shanghai",
  });
}

/** Author-built runtime control: no generated persona is silently substituted. */
export function buildArchitecturePersonaFixtureCharacter(
  caseId: string,
): CharacterSpec {
  const input = buildArchitecturePersonaInput(caseId);
  const item = ARCHITECTURE_PERSONA_CASES.find((entry) => entry.id === caseId)!;
  const draft = buildOriginalDraft(input, CHARACTER_COMPILATION_POLICY_VERSION);
  draft.persona.traits = item.traits.map((name, index) => ({
    id: `trait-${index + 1}`,
    name,
    description: item.behavior,
    strength: 0.95,
    triggers: ["在作者说明的对应具体场景中"],
    exceptions: [item.exception],
    origin: "user_spec",
    sourceRefs: ["original-form"],
  }));
  draft.knowledge.knownFacts = ARCHITECTURE_PERSONA_SHARED_FACTS.map(
    (fact) => fact.text,
  );
  draft.knowledge.uncertainFacts = [
    "作者没有提供家庭、创伤、婚恋史、学历、收入或已完成作品。",
  ];
  draft.identity.selfDescription =
    "我是沈知，在上海做桌游设计，正在测试《河岸》的纸面原型规则。";
  draft.userRelationship = {
    ...draft.userRelationship,
    relationshipType: "普通朋友",
    initialCloseness: 0.3,
    initialTrust: 0.45,
    addressTerms: ["你"],
    sharedContext: input.initialRelationship,
  };
  draft.dialogue = {
    ...draft.dialogue,
    authorGuidance: item.voice,
    frequentPhrases: [],
    greetingPatterns: [],
    comfortingPatterns: [],
    refusalPatterns: [],
    verbosity:
      caseId === "social-outward"
        ? 0.9
        : caseId === "social-private"
          ? 0.1
          : 0.5,
    warmth:
      caseId === "social-outward" || caseId === "conflict-diplomatic"
        ? 0.9
        : caseId === "conflict-blunt"
          ? 0.2
          : 0.5,
    directness:
      caseId === "conflict-blunt"
        ? 0.98
        : caseId === "conflict-diplomatic"
          ? 0.25
          : 0.6,
    humor:
      caseId === "social-outward"
        ? 0.8
        : caseId === "social-private"
          ? 0.1
          : 0.3,
    averageMessageLength:
      caseId === "social-outward"
        ? 180
        : caseId === "social-private"
          ? 55
          : 110,
    averageChunksPerTurn:
      caseId === "social-outward" ? 3 : caseId === "social-private" ? 1 : 2,
  };
  draft.schedulePolicy.enabled = false;
  draft.proactivePolicy.enabled = false;
  return CharacterSpecSchema.parse({
    ...draft,
    id: `architecture-persona-${caseId}`,
    version: 1,
    status: "published",
    createdAtUtc: "2026-09-01T01:00:00.000Z",
    updatedAtUtc: "2026-09-01T01:00:00.000Z",
  });
}
