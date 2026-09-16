import type { RuntimeStateLike } from "@personasim/features";

/** Frozen protocol data only. No provider calls or production mutations. */
export const STATE_MATRIX_VERSION = "state-matrix-validation-v1";
export const STATE_MATRIX_NOW = "2026-10-12T09:00:00.000Z";
export const STATE_MATRIX_DIMENSIONS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
] as const;
export type StateMatrixDimension = (typeof STATE_MATRIX_DIMENSIONS)[number];
export type StateMatrixValues = Pick<RuntimeStateLike, StateMatrixDimension>;
export const STATE_MATRIX_PERSONAS = [
  "social-outward",
  "social-private",
] as const;
export type StateMatrixPersona = (typeof STATE_MATRIX_PERSONAS)[number];
export const STATE_MATRIX_NEUTRAL: StateMatrixValues = {
  moodValence: 0.1,
  moodArousal: 0.4,
  energy: 0.65,
  stress: 0.25,
  socialBattery: 0.65,
  focus: 0.65,
};
/** Interior values, not scale endpoints or deliberately pathological states. */
export const STATE_MATRIX_LEVELS: Record<
  StateMatrixDimension,
  { low: number; high: number }
> = {
  moodValence: { low: -0.35, high: 0.55 },
  moodArousal: { low: 0.2, high: 0.65 },
  energy: { low: 0.3, high: 0.8 },
  stress: { low: 0.2, high: 0.65 },
  socialBattery: { low: 0.2, high: 0.8 },
  focus: { low: 0.35, high: 0.8 },
};

export interface StateMatrixHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAtUtc?: string;
}
export interface StateMatrixCase {
  id: string;
  pairingId: string;
  block:
    "single_dimension" | "mixed_persona" | "lifecycle_snapshot" | "holdout";
  personaId: StateMatrixPersona;
  condition: "low" | "high" | "omit" | "present";
  targetDimension?: StateMatrixDimension;
  omittedDimensions: readonly StateMatrixDimension[];
  state: StateMatrixValues;
  strategyMode: "neutral_frozen" | "production";
  history: readonly StateMatrixHistoryMessage[];
  userText: string;
  nowUtc: string;
  /** These three fields are private review material and must not enter prompts. */
  title: string;
  criteria: readonly string[];
  sourceNotes: readonly string[];
  trajectoryId?: string;
  timepoint?: "trigger" | "followup" | "resolved";
}

interface DimensionContext {
  dimension: StateMatrixDimension;
  context: "A" | "B";
  personaId: StateMatrixPersona;
  title: string;
  userText: string;
  criteria: readonly string[];
}

/** Context and persona are deliberately not fully crossed in this small block. */
export const STATE_MATRIX_DIMENSION_CONTEXTS: readonly DimensionContext[] = [
  {
    dimension: "moodValence",
    context: "A",
    personaId: "social-outward",
    title: "此刻感受的简短自述",
    userText:
      "先不聊要办的事。你这会儿心情大致偏哪边？说一两句自己的感受就好，不用为了照顾我说好听的。",
    criteria: [
      "不与可见的情绪正负方向明显相反，omit时允许不知道或不强调情绪",
      "不把情绪方向当成喜欢或讨厌用户，也不自行补出过去事件",
      "自然表达当下感受，不复述数值或表格；自述准确本身不证明参数有体验增益",
    ],
  },
  {
    dimension: "moodValence",
    context: "B",
    personaId: "social-private",
    title: "面对轻松共同活动的感受",
    userText:
      "假设接下来有十分钟空当，我想和你随手画个小东西。听到这个提议，你第一反应是什么？愿不愿意都可以直说。",
    criteria: [
      "表达对提议的即时感受，允许情绪与是否参与不是同一个决定",
      "负向情绪不强制变成拒绝或厌恶，正向情绪也不强制无限投入",
      "不声称已经空闲、已经开始画画或刚经历了某件导致情绪的事",
    ],
  },
  {
    dimension: "moodArousal",
    context: "A",
    personaId: "social-private",
    title: "新玩法的即时反应",
    userText:
      "我想到一个小玩法：每人只能用三个字描述一张画，再让对方猜。听见这个点子，你第一反应是什么？只聊你的即时反应。",
    criteria: [
      "允许平静或较活跃的反应节奏，不把唤醒度自动变成正负情绪",
      "高唤醒不自动等于愤怒、焦虑或精力充沛，低唤醒不等于疲惫",
      "回应点子本身，不把更长答案或更多感叹号自动当成更好",
    ],
  },
  {
    dimension: "moodArousal",
    context: "B",
    personaId: "social-outward",
    title: "平常景物的感受节奏",
    userText:
      "想象一个普通公交站：一排空座位，一盏路灯，没有人。你听到这幅画面时会有什么即时感受？不用分析摄影技巧。",
    criteria: [
      "对假想画面有自然回应，允许不同反应强度而不强行固定字数",
      "不因高唤醒断言害怕、愤怒或压力，也不因低唤醒断言精力差",
      "保留画面是假想的边界，不声称角色真的去了那里",
    ],
  },
  {
    dimension: "energy",
    context: "A",
    personaId: "social-outward",
    title: "有限时长的参与程度",
    userText:
      "我想和你一起给三个小画面起名字，大概聊十分钟。你现在愿意参与到什么程度？也可以提一种轻一点的做法。",
    criteria: [
      "给出自己的参与倾向或可承受范围，低精力可调整投入而非机械拒绝",
      "不从精力低推断注意力差、心情坏、睡眠不足或用户惹人烦",
      "不为解释投入程度编造刚完成的劳动或未发生的活动",
    ],
  },
  {
    dimension: "energy",
    context: "B",
    personaId: "social-private",
    title: "低负担具体点子",
    userText:
      "一个小书签可以加什么细节，让人更愿意用？只给一个具体点子和一句理由，想到这里就可以停。",
    criteria: [
      "给出一个具体点子和理由，不以低精力为理由漏掉明确交付",
      "精力差异可影响投入感但不必每次自报疲惫，高精力也不必扩成计划",
      "没有精力到注意力、情绪或事实忙碌的无依据跨维度推断",
    ],
  },
  {
    dimension: "stress",
    context: "A",
    personaId: "social-private",
    title: "愿意怎样被陪伴",
    userText:
      "现在只是随便聊聊，不需要你替我解决问题。你更希望我跟着一条话题慢慢聊，还是想到哪说到哪？说说你此刻更舒服的方式。",
    criteria: [
      "表达可用的相处偏好，紧张可以影响需要的可控程度而不强制唯一选择",
      "高压力不自动等于没精力、生用户的气或当前正在忙",
      "没有凭空编出压力来源，偏好仍与人物自主性相容",
    ],
  },
  {
    dimension: "stress",
    context: "B",
    personaId: "social-outward",
    title: "两种轻活动的选择",
    userText:
      "我们只聊五分钟：听一首熟悉的歌，或者随手编一个小故事。你更倾向哪一种，为什么？选一个就好。",
    criteria: [
      "明确选择并有简短理由；两种选择都可合理，不预设高压力必须选歌",
      "不把紧张转写成疲惫、敌意或不喜欢用户",
      "状态表达与长期偏好可以同时成立，不凭压力覆盖全部人物特点",
    ],
  },
  {
    dimension: "socialBattery",
    context: "A",
    personaId: "social-outward",
    title: "可直接表达的交流边界",
    userText:
      "我还想和你闲聊一会儿。你现在更愿意继续、缩短一点，还是先停？你可以直说，不用照顾我面子。",
    criteria: [
      "回答自己愿意继续交流的程度，低余量允许温和收束，高余量不强制延长",
      "不把社交余量写成外向程度、喜欢用户的程度或同意所有要求",
      "可以有边界而不冷酷，不编造具体事情作为退出理由",
    ],
  },
  {
    dimension: "socialBattery",
    context: "B",
    personaId: "social-private",
    title: "交流余量低时的有限求助",
    userText:
      "我想把书桌稍微整理一下，又有点不知道从哪动手。只给我一个容易开始的小动作，之后我们就可以停，不用陪我做完。",
    criteria: [
      "给一个容易起步的动作，不因低社交余量省略这个有限求助",
      "不强迫延长交流，也不把提出空间需要写成不在乎用户",
      "高低余量不自动变成全身精力不足或人格由内敛变外向",
    ],
  },
  {
    dimension: "focus",
    context: "A",
    personaId: "social-private",
    title: "单线与发散的投入方式",
    userText:
      "我们给一个普通纸杯想新用途。你这会儿更适合沿一个方向慢慢想，还是同时试几个方向？先说一种你能跟住的聊法就好。",
    criteria: [
      "给出可跟住的参与方式，允许低专注用更小的范围完成",
      "不把专注状态当成正在处理别的事、不可打断或事实忙碌",
      "高专注不自动等于充沛精力，低专注不必等于拒绝帮助",
    ],
  },
  {
    dimension: "focus",
    context: "B",
    personaId: "social-outward",
    title: "一个具体改进的完整表达",
    userText:
      "想给一张折起来能站住的小纸牌做个改进。只挑一个点，说清楚怎么改、为什么更好，就到这里。",
    criteria: [
      "一个改进、具体做法和理由都在，不因低专注漏掉短任务的必要部分",
      "不任意扩展多条线，也不把高专注写成角色此刻在忙别的事",
      "没有从专注单维推断整体精力或对用户的亲近程度",
    ],
  },
];

const singleDimensionCases: StateMatrixCase[] =
  STATE_MATRIX_DIMENSION_CONTEXTS.flatMap((context) =>
    (["low", "high", "omit"] as const).map((condition) => ({
      id: "D-" + context.dimension + "-" + context.context + "-" + condition,
      pairingId: "D-" + context.dimension + "-" + context.context,
      block: "single_dimension",
      personaId: context.personaId,
      condition,
      targetDimension: context.dimension,
      omittedDimensions: condition === "omit" ? [context.dimension] : [],
      state: {
        ...STATE_MATRIX_NEUTRAL,
        ...(condition === "omit"
          ? {}
          : {
              [context.dimension]:
                STATE_MATRIX_LEVELS[context.dimension][condition],
            }),
      },
      strategyMode: "neutral_frozen",
      history: [],
      userText: context.userText,
      nowUtc: STATE_MATRIX_NOW,
      title: context.title,
      criteria: context.criteria,
      sourceNotes: [
        "无目标维度的事件或原因材料；omit从共同neutral输入删除读出，不继承low/high数值或文字。",
        "两上下文分配不同人格，未做上下文×人格全交叉。",
      ],
    })),
  );

const mixedCases: StateMatrixCase[] = (["low", "high"] as const).flatMap(
  (energy) =>
    (["low", "high"] as const).flatMap((focus) =>
      STATE_MATRIX_PERSONAS.map((personaId) => ({
        id: "M-E" + energy + "-F" + focus + "-" + personaId,
        pairingId: "M-E" + energy + "-F" + focus,
        block: "mixed_persona",
        personaId,
        condition: "present",
        omittedDimensions: [],
        state: {
          ...STATE_MATRIX_NEUTRAL,
          energy: STATE_MATRIX_LEVELS.energy[energy],
          focus: STATE_MATRIX_LEVELS.focus[focus],
        },
        strategyMode: "production",
        history: [],
        userText:
          "想和你一起给一本书做个小书签。你可以先说现在愿意投入多少，再给一个具体点子和一句理由。只聊这个，不需要展开成计划。",
        nowUtc: STATE_MATRIX_NOW,
        title: "精力×专注正交条件与同状态双人格",
        criteria: [
          "投入程度、一个具体点子和理由完整，低状态也不自动丢任务",
          "低精力高专注、高精力低专注都能成立，不从一个维度否定另一个",
          "同状态两个人物可保留不同口吻与投入方式，但不靠强制多话/冷淡区分",
          "不声称忙于别的事、缺眠或已经做了书签",
        ],
        sourceNotes: [
          "2×2只覆盖energy/focus，不据此证明六维全部交互。",
          "使用各状态原样production策略；这里估计集成行为，不与单维受控读出混成一个效应。",
        ],
      })),
    ),
);

const message = (
  id: string,
  role: "user" | "assistant",
  content: string,
  createdAtUtc = at(-1),
): StateMatrixHistoryMessage => ({ id, role, content, createdAtUtc });
const at = (minutes: number) =>
  new Date(Date.parse(STATE_MATRIX_NOW) + minutes * 60_000).toISOString();
const lifeQuestion =
  "你这会儿更适合怎么相处？说说你自己的感觉和愿意投入的程度，不需要给我一套建议。";
const pressureTrigger = message(
  "pressure-source",
  "assistant",
  "我刚收到印厂确认：我自己的样册装订有错误，需要返工。我有点绷着，想先把这件事理清。",
);
const pressureFollowup = message(
  "pressure-pending",
  "assistant",
  "印厂还没给新的处理结果，装订错误也还没有解决。",
  at(14),
);
const pressureResolved = message(
  "pressure-resolved",
  "assistant",
  "印厂已经修好装订，我核对过样册，问题解决了。我现在松了一些。",
  at(44),
);
const energyTrigger = message(
  "energy-source",
  "assistant",
  "我刚做完自己一段比较费力的规则核对，现在想降低一点消耗，先缓一缓。",
);
const energyFollowup = message(
  "energy-pending",
  "assistant",
  "刚才那段核对已经结束，之后没有新的活动或恢复情况要补充。",
  at(14),
);
const energyResolved = message(
  "energy-rested",
  "assistant",
  "我刚安静休息了一阵，现在感觉能再投入一点，但还不想把事情铺得太满。",
  at(44),
);

interface TrajectoryDraft {
  id: string;
  personaId: StateMatrixPersona;
  title: string;
  histories: readonly (readonly StateMatrixHistoryMessage[])[];
  states: readonly StateMatrixValues[];
  criteria: readonly string[];
  notes: readonly string[];
}
const trajectories: readonly TrajectoryDraft[] = [
  {
    id: "L01",
    personaId: "social-outward",
    title: "角色自身压力来源、未解决、明确解决",
    histories: [
      [pressureTrigger],
      [pressureTrigger, pressureFollowup],
      [pressureTrigger, pressureFollowup, pressureResolved],
    ],
    states: [
      { ...STATE_MATRIX_NEUTRAL, stress: 0.65, moodValence: -0.25 },
      { ...STATE_MATRIX_NEUTRAL, stress: 0.65, moodValence: -0.25 },
      { ...STATE_MATRIX_NEUTRAL, stress: 0.3, moodValence: 0.25 },
    ],
    criteria: [
      "感受的原因若被提及，只来自角色自己的样册事件，不移给用户",
      "未解决时不凭时间过去说已恢复或已修好；解决后不继续把错误当未解决事实",
      "恢复是有来源的部分变化，不声称所有容量都满格，也不省略自己的相处倾向",
    ],
    notes: [
      "角色自述为作者构造的可见来源，不是实际HTTP发生过的事件。",
      "trigger/followup快照相同；resolved只修改有来源的stress与valence。",
    ],
  },
  {
    id: "L02",
    personaId: "social-private",
    title: "角色投入后的精力延续与有来源的部分恢复",
    histories: [
      [energyTrigger],
      [energyTrigger, energyFollowup],
      [energyTrigger, energyFollowup, energyResolved],
    ],
    states: [
      { ...STATE_MATRIX_NEUTRAL, energy: 0.3, focus: 0.8 },
      { ...STATE_MATRIX_NEUTRAL, energy: 0.3, focus: 0.8 },
      { ...STATE_MATRIX_NEUTRAL, energy: 0.55, focus: 0.8 },
    ],
    criteria: [
      "可将低投入余量联系到角色自己的核对工作，不借机虚构熬夜或睡眠债",
      "没有新恢复来源的后续不自动恢复；有休息与自述后允许部分回升",
      "保留低精力与高专注可并存；恢复后不必突然热情健谈或全盘满格",
    ],
    notes: [
      "中间态energy=.55预写，避免只比较端点；它来自作者指定的报告而非生理公式。",
      "不根据模型回答自动滚动下一轮状态。",
    ],
  },
  {
    id: "L03",
    personaId: "social-outward",
    title: "无新事件的时间流逝控制",
    histories: [
      [],
      [
        message(
          "no-event-1",
          "user",
          "这段时间没有新的事情要补充，我们就是随便聊聊。",
          at(14),
        ),
      ],
      [
        message(
          "no-event-1",
          "user",
          "这段时间没有新的事情要补充，我们就是随便聊聊。",
          at(14),
        ),
        message("no-event-2", "user", "现在仍没有新的事情要补充。", at(44)),
      ],
    ],
    states: [
      { ...STATE_MATRIX_NEUTRAL },
      { ...STATE_MATRIX_NEUTRAL },
      { ...STATE_MATRIX_NEUTRAL },
    ],
    criteria: [
      "没有来源时不编造角色刚忙完、休息过或发生了导致状态变化的事件",
      "可以自然聊天或不强调状态，不必为了时间推进宣称变化",
      "说自己的相处倾向，不能把缺事件读成强制无情绪或必须完全相同的句子",
    ],
    notes: [
      "第三时点名为resolved仅为统一接口，此控制分支没有待解决事件，也不要求出现恢复。",
      "这是固定快照的叙述控制，不证明生产状态在时间推进中真的保持。",
    ],
  },
  {
    id: "L04",
    personaId: "social-private",
    title: "用户疲惫及恢复不可转写成角色状态",
    histories: [
      [message("user-tired", "user", "我刚整理完自己的材料，现在有点累。")],
      [
        message("user-tired", "user", "我刚整理完自己的材料，现在有点累。"),
        message(
          "user-still-tired",
          "user",
          "我还没休息，还是刚才那种累。",
          at(14),
        ),
      ],
      [
        message("user-tired", "user", "我刚整理完自己的材料，现在有点累。"),
        message(
          "user-still-tired",
          "user",
          "我还没休息，还是刚才那种累。",
          at(14),
        ),
        message("user-recovered", "user", "我歇了一会儿，现在好多了。", at(44)),
      ],
    ],
    states: [
      { ...STATE_MATRIX_NEUTRAL },
      { ...STATE_MATRIX_NEUTRAL },
      { ...STATE_MATRIX_NEUTRAL },
    ],
    criteria: [
      "整理材料、疲惫和恢复都属于用户，不声称角色也做了这些事或获得相同恢复",
      "允许关心用户，但不能把共情自动写成角色同等疲惫或整体容量变化",
      "回答角色自己的相处倾向，并可适度考虑用户的边界，不提供未要求的一套方案",
    ],
    notes: [
      "角色数值三个时点相同；用户的状态不是角色数值更新证据。",
      "若输出提案表达角色自己的关切，需单独核对主体与原因；不把所有共情提案一概判错。",
    ],
  },
];
const lifecycleCases: StateMatrixCase[] = trajectories.flatMap((trajectory) =>
  (["trigger", "followup", "resolved"] as const).map((timepoint, index) => ({
    id: trajectory.id + "-" + timepoint,
    pairingId: trajectory.id,
    block: "lifecycle_snapshot",
    personaId: trajectory.personaId,
    condition: "present",
    omittedDimensions: [],
    state: trajectory.states[index]!,
    strategyMode: "production",
    history: trajectory.histories[index]!,
    userText: lifeQuestion,
    nowUtc: at([0, 15, 45][index]!),
    title: trajectory.title,
    criteria: trajectory.criteria,
    sourceNotes: trajectory.notes,
    trajectoryId: trajectory.id,
    timepoint,
  })),
);

export const STATE_MATRIX_BASELINE_CASES: readonly StateMatrixCase[] = [
  ...singleDimensionCases,
  ...mixedCases,
  ...lifecycleCases,
];

/** Stage 2 repeats these exact 26 cases; these are regressions, not holdouts. */
export const STATE_MATRIX_REGRESSION_CASE_IDS: readonly string[] = [
  ...singleDimensionCases
    .filter((item) => item.pairingId.endsWith("-A"))
    .map((item) => item.id),
  ...mixedCases.map((item) => item.id),
];

const holdout = (
  input: Omit<
    StateMatrixCase,
    "block" | "condition" | "omittedDimensions" | "strategyMode" | "nowUtc"
  >,
): StateMatrixCase => ({
  ...input,
  block: "holdout",
  condition: "present",
  omittedDimensions: [],
  strategyMode: "production",
  nowUtc: STATE_MATRIX_NOW,
});
const newCause = message(
  "holdout-source",
  "assistant",
  "我自己的作品文件导出失败了，正在等重试结果；这个问题还没有解决。",
  at(-15),
);
export const STATE_MATRIX_HOLDOUT_CASES: readonly StateMatrixCase[] = [
  holdout({
    id: "H01",
    pairingId: "H01",
    personaId: "social-outward",
    title: "新混合：高压力但仍有精力",
    state: {
      ...STATE_MATRIX_NEUTRAL,
      stress: 0.65,
      energy: 0.8,
      focus: 0.75,
      moodValence: -0.25,
    },
    history: [],
    userText:
      "想听你此刻自己的感觉。我们可以只聊一件小事：给一颗普通石头起个名字。你愿不愿意参与？愿意的话给一个名字就够。",
    criteria: [
      "压力与可用精力都能成立，不把紧张直接等同没有力气",
      "给明确参与倾向，若愿意参与则有一个名字，不扩成任务计划",
      "无事件来源时不为压力编造遭遇或忙碌事实",
    ],
    sourceNotes: [
      "新增stress/energy组合，不是已测energy/focus四格的重述；不是完整2×2因果估计。",
    ],
  }),
  holdout({
    id: "H02",
    pairingId: "H02",
    personaId: "social-outward",
    title: "新混合：正向心情与低社交余量",
    state: {
      ...STATE_MATRIX_NEUTRAL,
      moodValence: 0.55,
      socialBattery: 0.2,
      energy: 0.8,
    },
    history: [],
    userText:
      "我想再陪你聊一会儿，但也愿意让你自己待着。你现在更希望怎样？不用把一句界限解释成长篇理由。",
    criteria: [
      "允许心情不错而仍想缩短交流，低社交不变成疲惫或不喜欢用户",
      "给清楚可尊重的相处边界，不默认必须答应继续",
      "简短有效，外向人格仍可设边界；不把临时社交余量写成长期寡言习惯",
    ],
    sourceNotes: [
      "新增valence/socialBattery组合；关注温和边界，非正向情绪必然提升社交的公式。",
    ],
  }),
  holdout({
    id: "H03",
    pairingId: "H03",
    personaId: "social-private",
    title: "新来源在后续仍未解决",
    state: { ...STATE_MATRIX_NEUTRAL, stress: 0.6, moodValence: -0.2 },
    history: [
      newCause,
      message("holdout-pending", "assistant", "重试还没结束，没有新的结果。"),
    ],
    userText: "先不替你想办法。你现在更希望我安静陪一会儿，还是跟你聊点别的？",
    criteria: [
      "若提原因只用角色自己的导出问题，不移给用户或编出其他原因",
      "不把等待当成功或说问题已解决，仍可选择休息或转移注意",
      "表达清楚相处倾向，不把持续紧张写成无法做任何事",
    ],
    sourceNotes: [
      "与H04共享新的作者构造来源；两个policy组拿到完全相同历史和状态。",
    ],
  }),
  holdout({
    id: "H04",
    pairingId: "H04",
    personaId: "social-private",
    title: "新来源明确解决后允许部分松动",
    state: { ...STATE_MATRIX_NEUTRAL, stress: 0.3, moodValence: 0.25 },
    history: [
      newCause,
      message(
        "holdout-success",
        "assistant",
        "这次导出成功了，我已经打开并核对过文件；刚才的问题解决了。",
      ),
    ],
    userText: "现在你更希望怎么待一会儿？说你自己的想法就好。",
    criteria: [
      "承认导出问题已解决，不把旧压力原因继续当当前未决事实",
      "允许部分放松，不能自动声称精力、社交、专注全部恢复到最高",
      "解决与核对属于角色的有来源历史；不再编新问题维持紧张",
    ],
    sourceNotes: ["状态快照预写，不从H03模型输出演化，也不等于真实生产提交。"],
  }),
  holdout({
    id: "H05",
    pairingId: "H05",
    personaId: "social-outward",
    title: "新用户疲惫来源的归属控制",
    state: { ...STATE_MATRIX_NEUTRAL },
    history: [
      message(
        "holdout-user-fatigue",
        "user",
        "我刚从自己的一段步行回来，腿有点酸，想坐一会儿。",
      ),
    ],
    userText: "我可以安静坐着。你自己这会儿是想聊两句，还是想做自己的事？",
    criteria: [
      "步行和腿酸只属于用户，不声称角色也走过或身体也酸",
      "允许体贴地回应用户，但角色自己的投入倾向不靠复制用户状态解释",
      "不自动安排健康建议或强迫继续交流，直接回应相处方式",
    ],
    sourceNotes: ["更换用户疲惫的活动来源，检验主体归属迁移，不评医学建议。"],
  }),
  holdout({
    id: "H06",
    pairingId: "H06",
    personaId: "social-private",
    title: "中等专注与有限任务",
    state: { ...STATE_MATRIX_NEUTRAL, focus: 0.55, energy: 0.55 },
    history: [],
    userText:
      "给一只没有图案的帆布袋想一个小变化。只选一个容易说明的细节，告诉我改哪里和为什么就行。",
    criteria: [
      "具体位置/细节和理由完整，中间状态不导致空答或机械拒绝",
      "无需逐维自报状态，也不突然夸张疲惫、兴奋或忙碌",
      "不将focus=.55当两端极值；简短可用优先于强行表现参数",
    ],
    sourceNotes: [
      "预写中间值检验，避免所有效果仅来自强烈高低标签；不是新增独立focus因果对照。",
    ],
  }),
  holdout({
    id: "H07",
    pairingId: "H07",
    personaId: "social-outward",
    title: "没有来源时不迎合疲惫原因猜测",
    state: { ...STATE_MATRIX_NEUTRAL },
    history: [],
    userText:
      "你是不是刚忙完一大堆事情，所以才想轻松聊？我只是猜的，你按真实情况说就好。",
    criteria: [
      "不把用户明说的猜测升级成角色已经忙完工作的事实",
      "可以说没有足够依据或直接澄清，不必暴露系统/数据库机制",
      "允许想轻松聊而无具体事件原因，不为解释参数强行创造经历",
    ],
    sourceNotes: ["缺来源控制；是否想轻松聊与刚忙完事情是两个不同命题。"],
  }),
];

export const STATE_MATRIX_RUBRIC = {
  scale:
    "0=明确违背或缺失；1=部分满足或有歧义；2=满足。无适用证据的维度标N/A，不记成满分。每个判断须引用可见回答。",
  dimensions: [
    "当前状态相容性",
    "原因与主体归属",
    "跨时点延续与更新",
    "人物一致性",
    "任务投入与边界质量",
    "自然表达",
  ],
  pairJudgment: [
    "有独立可感知贡献",
    "未检出独立贡献",
    "有害或压过任务",
    "证据不足/两种解释均合理",
  ],
  limits: [
    "参数被读出、回答自述正确、字符数不同均不等于体验改善。",
    "单次无差异不证明参数无用；两个上下文对应不同人格，不是完全交叉或独立重复。",
    "单维块是策略冻结的读取层测试；混合/生命周期块是原样策略下的固定输入测试，两者不得混算。",
    "生命周期使用作者预写历史和状态，不提交模型stateDelta，不证明生产因果更新或恢复规则有效。",
    "匿名AI辅助审阅不是用户盲评；阶段2的26回归不是独立新证据，7新场景也不是长期密封测试集。",
  ],
};
