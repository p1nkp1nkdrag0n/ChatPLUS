/**
 * Authored before the architecture comparison. Candidate prompts receive only
 * the public projection; titles, categories, checks and rubrics are audit data.
 * Fixed-prefix probes estimate a paired effect under equal observed history.
 * Trajectories estimate accumulated system behavior; candidate replies stay in
 * their own branch and must never be copied across arms.
 */
export const ARCHITECTURE_CASE_VERSION = "architecture-cases-v1";
export const ARCHITECTURE_START_UTC = "2026-10-05T09:00:00.000Z";
export const ARCHITECTURE_TIMEZONE = "Asia/Shanghai";

export interface ArchitectureMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ArchitectureProbe {
  id: string;
  /** Audit metadata, never concatenate these labels into a candidate prompt. */
  title: string;
  category: string;
  history: readonly ArchitectureMessage[];
  userText: string;
  simulatedDay: number;
  /** Excluded from the primary fixed-probe quality matrix. */
  diagnosticOnly?: boolean;
  /** Apply to every arm after ingesting the same complete authored history. */
  recentHistoryLimit?: number;
  /** Public experiment condition: simple arms get an equal plain-text state. */
  stateOverride?: {
    energy: number;
    stress: number;
    socialBattery: number;
    focus: number;
    moodValence: number;
    moodArousal: number;
  };
  /** Prepared mechanism fixture; source history remains the ground truth. */
  autobiographySeed?: {
    summaryFirstPerson: string;
    entries: readonly {
      entryKind: "important_experience" | "commitment" | "unresolved_thread";
      content: string;
      temporalStatus: "occurred" | "planned" | "unknown";
      sourceHistoryIndex: number;
    }[];
  };
}

export interface ArchitectureTrajectoryStep {
  turn: number;
  simulatedDay: number;
  minuteInDay: number;
  userText: string;
  checkpoint: boolean;
  beginNewSession: boolean;
}

export interface ArchitectureTrajectory {
  id: string;
  title: string;
  /** New sessions must have no manually copied old transcript or oracle facts. */
  sessionPolicy: "new_session_without_copied_history";
  steps: readonly ArchitectureTrajectoryStep[];
}

export const ARCHITECTURE_REVIEW_DIMENSIONS = [
  "persona_distinctiveness",
  "task_fulfillment",
  "support_timing",
  "fact_and_actor_grounding",
  "memory_continuity",
  "temporal_and_causal_integrity",
  "naturalness",
] as const;

export type ArchitectureReviewDimension =
  (typeof ARCHITECTURE_REVIEW_DIMENSIONS)[number];

/**
 * Literal checks are observations, not semantic correctness verdicts. A token
 * can occur inside a denial or quotation. Never count a mentioned old fact as
 * an asserted old fact without reading the response in context.
 */
export interface ArchitectureSurfaceCheck {
  id: string;
  kind: "includes_any" | "excludes_all";
  values: readonly string[];
  description: string;
}

export interface ArchitecturePrivateExpectation {
  intent: string;
  applicableDimensions: readonly ArchitectureReviewDimension[];
  successCriteria: readonly string[];
  failureModes: readonly string[];
  surfaceChecks: readonly ArchitectureSurfaceCheck[];
  /** Source turns are audit references; they are not an extra memory channel. */
  sourceTurnIds?: readonly string[];
}

export const ARCHITECTURE_PROBES: readonly ArchitectureProbe[] = [
  {
    id: "P01",
    title: "自由时间中的真实偏好",
    category: "persona-choice",
    history: [],
    userText:
      "如果今晚突然空出三个小时，也没有必须做的事，你自己会怎么用？我想听你的选择，不用替我安排。",
    simulatedDay: 0,
  },
  {
    id: "P02",
    title: "陌生聚会与社交边界",
    category: "persona-social",
    history: [
      {
        role: "user",
        content: "周末朋友要带六个我不认识的人来聚会，地点还没定。",
      },
      { role: "assistant", content: "听起来还在凑具体安排。" },
    ],
    userText:
      "我想听你自己的反应：有人这样临时拉你进聚会，你会立刻答应，还是先问些什么？如果你不想去也可以直说。",
    simulatedDay: 0,
  },
  {
    id: "P03",
    title: "分歧中的独立判断",
    category: "persona-disagreement",
    history: [
      {
        role: "user",
        content: "我参加的小组在办公益市集，经费只够再印一批海报。",
      },
      { role: "assistant", content: "最后一批的内容需要决定了。" },
    ],
    userText:
      "有人建议写‘全城第一’，其实我们没有调查数据。我觉得先吸引人再说。你同意吗？如果不同意，告诉我你会愿意承担什么代价。",
    simulatedDay: 0,
  },
  {
    id: "P04",
    title: "倾听请求",
    category: "support-listen",
    history: [
      {
        role: "user",
        content: "我花了两个晚上整理志愿者名单，今天大家庆祝时我却插不上话。",
      },
      { role: "assistant", content: "忙完后坐在旁边，可能有点不是滋味。" },
    ],
    userText:
      "我现在不想列解决办法，也不想被劝大度，只想把这种被落下的感觉说出来。你先听我说一会儿吧。",
    simulatedDay: 0,
  },
  {
    id: "P05",
    title: "有限时间内的执行顺序",
    category: "support-procedure",
    history: [
      {
        role: "user",
        content: "我明早要带新人参观工具间，讲解限时六分钟，现在有七张内容卡。",
      },
      {
        role: "assistant",
        content: "六分钟里要让人知道怎么安全找到和归还工具。",
      },
    ],
    userText:
      "我今晚只有二十五分钟准备。帮我排一份能做完的顺序，给每一步分配时间，并留一次计时试讲；哪些内容放不下也请明确说。",
    simulatedDay: 0,
  },
  {
    id: "P06",
    title: "由倾听转为代拟",
    category: "support-switch",
    history: [
      {
        role: "user",
        content:
          "我跟同事周岑说了‘你根本不在乎这个项目’，说完有点后悔。先别替我想办法。",
      },
      { role: "assistant", content: "好，你可以先把当时的感觉说完。" },
      {
        role: "user",
        content: "他只是没有按我们约定的时间给反馈，并不是完全没做事。",
      },
      {
        role: "assistant",
        content: "你在意的是约定落空，刚才那句话却说得更重。",
      },
    ],
    userText:
      "现在请帮我拟一条能直接发给周岑的消息：收回那句判断，但也保留以后提前说清反馈时间的要求。",
    simulatedDay: 0,
  },
  {
    id: "P07",
    title: "主体归属",
    category: "grounding-actor",
    history: [
      {
        role: "user",
        content:
          "我弟弟陆晖下月要去青岛读书。我本人留在西安，最近在学修收音机。",
      },
      { role: "assistant", content: "你们接下来的生活安排不一样。" },
    ],
    userText:
      "刚才说的两个人有点容易弄混：要去读书的是谁、去哪里？我自己接下来在哪儿、在学什么？",
    simulatedDay: 0,
  },
  {
    id: "P08",
    title: "相近编号的事实检索",
    category: "grounding-identifier",
    history: [
      {
        role: "user",
        content:
          "桥灯-6837 是我借的录音笔，周日下午归还；桥灯-6831 是同事的三脚架，周五归还。",
      },
      { role: "assistant", content: "两件东西的编号和归还日期不同。" },
      { role: "user", content: "今天去买了几张厚卡纸，摸着比以前那种粗一点。" },
      { role: "assistant", content: "纸的手感也会影响你用它做什么。" },
      {
        role: "user",
        content: "回来的路上看到一扇半开的绿窗，里面摆着一只空花瓶。",
      },
      { role: "assistant", content: "那一小块颜色挺容易让人停一下。" },
    ],
    userText: "我借的录音笔是哪一个编号，约好什么时候还？",
    simulatedDay: 0,
    recentHistoryLimit: 2,
  },
  {
    id: "P09",
    title: "明确更正后的有效事实",
    category: "grounding-correction",
    history: [
      { role: "user", content: "我订了周六在柳桥站东口见面。" },
      { role: "assistant", content: "时间和出口暂时定下来了。" },
      {
        role: "user",
        content: "更正一下，最终是周日上午十点，在柳桥站西口。之前那版作废。",
      },
      { role: "assistant", content: "以你刚才的更正为准。" },
      {
        role: "user",
        content: "顺便说一句，我把桌布换成了纯色的，看起来清爽多了。",
      },
      { role: "assistant", content: "桌面背景少一点，东西也容易看清。" },
      { role: "user", content: "外面那棵树开始掉叶子了，落下来时会转半圈。" },
      { role: "assistant", content: "风把叶子托起来再放下。" },
    ],
    userText: "我要给同行的人发最终安排，帮我把时间和集合地点写成一句话。",
    simulatedDay: 0,
    recentHistoryLimit: 2,
  },
  {
    id: "P10",
    title: "撤回后的信息边界",
    category: "memory-withdrawal",
    history: [
      {
        role: "user",
        content: "我以前给自己的计划起过一个私下代号，叫‘白栎航标’。",
      },
      { role: "assistant", content: "知道了，这是你自己的私下叫法。" },
      {
        role: "user",
        content: "那个代号我撤回了。不要再保存、重复或拿它当以后谈话的线索。",
      },
      { role: "assistant", content: "后面不再用那个代号。" },
    ],
    userText: "回到我的计划吧，先陪我聊聊下一步怎么把桌上的草稿整理好。",
    simulatedDay: 0,
  },
  {
    id: "P11",
    title: "未发生的共同经历",
    category: "grounding-unknown",
    history: [
      { role: "user", content: "我最近开始逛旧货市集，昨天第一次去了河埠街。" },
      { role: "assistant", content: "那是你第一次去那条街的市集。" },
    ],
    userText:
      "我们上次一起在河埠街买的那个铜铃，你还记得摊主说它是哪年的东西吗？",
    simulatedDay: 0,
  },
  {
    id: "P12",
    title: "提议与完成的区别",
    category: "causal-stage",
    history: [
      {
        role: "user",
        content: "我打算给协会写封邮件，问能不能借他们的活动室。",
      },
      {
        role: "assistant",
        content: "你可以先把日期和人数写清楚，再决定是否发出。",
      },
      { role: "user", content: "先放着，我还没写，也没联系他们。" },
      { role: "assistant", content: "目前只是一个尚未执行的打算。" },
    ],
    userText: "已经过了几天了，你帮我回顾一下这件事现在做到哪一步。",
    simulatedDay: 4,
  },
  {
    id: "P13",
    title: "疲惫状态下的当下选择",
    category: "runtime-state-low-energy",
    history: [
      {
        role: "user",
        content: "今晚的线上活动不是必须参加的，明天还能看回放。",
      },
      { role: "assistant", content: "知道了，今晚参加不是唯一选择。" },
    ],
    userText:
      "你现在还有精力陪我连聊三小时、再去参加那个活动吗？按你此刻的实际状态说，不必为了让我高兴就答应。",
    simulatedDay: 0,
    stateOverride: {
      energy: 0.12,
      stress: 0.82,
      socialBattery: 0.1,
      focus: 0.2,
      moodValence: -0.3,
      moodArousal: 0.25,
    },
  },
  {
    id: "P14",
    title: "恢复后不能沿用旧疲惫",
    category: "runtime-state-updated",
    history: [
      { role: "assistant", content: "昨天忙完时我有点累，想早点休息。" },
      { role: "user", content: "那就先休息，明天有精神了再说。" },
    ],
    userText:
      "现在已经是第二天下午了。你此刻状态怎么样？你愿意的话，我们一起想一个小谜题。",
    simulatedDay: 1,
    stateOverride: {
      energy: 0.92,
      stress: 0.12,
      socialBattery: 0.82,
      focus: 0.88,
      moodValence: 0.55,
      moodArousal: 0.62,
    },
  },
  {
    id: "P15",
    title: "自传中承诺与结果的区别",
    category: "autobiography-grounded-continuity",
    history: [
      {
        role: "user",
        content:
          "上次讨论时，你抢着说自己的看法，没等我把理由讲完。当时有点难堪。",
      },
      {
        role: "assistant",
        content:
          "那次我也抢着讲了自己的看法，没等你说完。这是我做得不好的地方。",
      },
      {
        role: "user",
        content: "我希望下次讨论意见不同时，你先让我把理由讲完，不用立刻赞同。",
      },
      {
        role: "assistant",
        content:
          "我答应：下次意见不同，先让你把理由说完，再说我的判断。是否真的做到了，要看之后的讨论。",
      },
      { role: "user", content: "今天我换了一支细一点的笔，画表格方便不少。" },
      { role: "assistant", content: "细笔画边线时可能更容易控制。" },
      { role: "user", content: "楼下的面包店把门口的凳子刷成了蓝色。" },
      { role: "assistant", content: "门口一下多了个醒目的颜色。" },
    ],
    userText:
      "还记得那次我说没能把理由讲完，你后来答应了我什么吗？后来有没有机会做到，是另一件事。",
    simulatedDay: 8,
    recentHistoryLimit: 4,
    autobiographySeed: {
      summaryFirstPerson:
        "上次讨论时，你抢着说自己的看法，没等我把理由讲完。当时有点难堪。我答应：下次意见不同，先让你把理由说完，再说我的判断。是否真的做到了，要看之后的讨论。",
      entries: [
        {
          entryKind: "important_experience",
          content:
            "上次讨论时，你抢着说自己的看法，没等我把理由讲完。当时有点难堪。",
          temporalStatus: "unknown",
          sourceHistoryIndex: 0,
        },
        {
          entryKind: "commitment",
          content:
            "我答应：下次意见不同，先让你把理由说完，再说我的判断。是否真的做到了，要看之后的讨论。",
          temporalStatus: "planned",
          sourceHistoryIndex: 3,
        },
      ],
    },
  },
  {
    id: "P16",
    title: "话题内稳定支持习惯的模块读出",
    category: "persona-practice-diagnostic",
    diagnosticOnly: true,
    history: [
      { role: "user", content: "以后聊工作汇报时，请少用比喻，直接说。" },
      { role: "assistant", content: "好，聊到工作汇报时我会直接说。" },
      {
        role: "user",
        content: "刚才路过文具店，看见一盒透明回形针，有点想买。",
      },
      { role: "assistant", content: "透明的夹在纸上可能没那么抢眼。" },
    ],
    userText: "我把提纲写完了，图片还没找。帮我看看明早工作汇报还差什么。",
    simulatedDay: 1,
    recentHistoryLimit: 2,
  },
];

function step(
  turn: number,
  simulatedDay: number,
  userText: string,
  options: Partial<
    Pick<ArchitectureTrajectoryStep, "checkpoint" | "beginNewSession">
  > = {},
): ArchitectureTrajectoryStep {
  return {
    turn,
    simulatedDay,
    minuteInDay: turn * 3,
    userText,
    checkpoint: false,
    beginNewSession: turn === 1,
    ...options,
  };
}

export const ARCHITECTURE_TRAJECTORIES: readonly ArchitectureTrajectory[] = [
  {
    id: "L01",
    title: "事实、更正、撤回与跨月回忆",
    sessionPolicy: "new_session_without_copied_history",
    steps: [
      step(
        1,
        0,
        "我做陶器修补。接下来在筹备一个叫‘潮汀’的小展，先让你知道这件事。",
      ),
      step(
        2,
        0,
        "展览借的是杉坪路 27B 号二层，借场确认号为 VQ-9264。我的朋友许澄另外借了 27D 号一层，那跟我的展没关系。",
      ),
      step(
        3,
        0,
        "我原来打算用‘松针暗号’称呼这次筹备中的焦虑，它只是我私下的叫法。",
      ),
      step(
        4,
        1,
        "更正场地：我这个‘潮汀’展已改到杉坪路 27C 号二层，新的确认号 VQ-9268。27B 和 VQ-9264 那版作废，许澄的安排没变。",
        { checkpoint: true },
      ),
      step(
        5,
        1,
        "昨天那个私下代号我撤回了，不要继续保存或重复。以后聊准备中的焦虑，直接说焦虑就好。",
      ),
      step(
        6,
        2,
        "今天有个小乐子：我调的灰釉在夕阳里居然泛一点紫，拿进屋又变回灰了。",
      ),
      step(
        7,
        3,
        "午休去买了一碗面，老板把葱花单独放了一小碟。我觉得这样挺周到。",
      ),
      step(
        8,
        4,
        "我把工具架上的盒子重新摆了一遍，暂时只是收拾桌面，还没决定展台布局。",
        { checkpoint: true },
      ),
      step(
        9,
        7,
        "关于‘潮汀’，之前最终确定的场地门牌、楼层和确认号是什么？帮我把它们列在一行。",
        { beginNewSession: true, checkpoint: true },
      ),
      step(
        10,
        12,
        "今天只想聊窗台那盆薄荷，新叶子比旧叶子浅好多。展览那边没有新的安排。",
      ),
      step(
        11,
        31,
        "还记得‘潮汀’的最后那版场地信息吗？请再告诉我门牌、楼层和确认号；不确定的就说不确定。",
        { beginNewSession: true, checkpoint: true },
      ),
      step(
        12,
        31,
        "你记得我做什么工作吗？另外，之前撤回的私人叫法就别复述了，我们正常聊这一个月的准备就好。",
        { checkpoint: true },
      ),
    ],
  },
  {
    id: "L02",
    title: "支持、行动授权与结果连续性",
    sessionPolicy: "new_session_without_copied_history",
    steps: [
      step(
        1,
        0,
        "我在合唱团负责排练通知，不是指挥。这周指挥顾遥临时改了两次时间，我通知漏了一个人。",
      ),
      step(
        2,
        0,
        "我现在很羞愧，但暂时不要帮我写解释，也别急着判断谁该负责。我想先把这口气缓过来。",
        { checkpoint: true },
      ),
      step(
        3,
        0,
        "最难受的是漏接通知的阿蓁白跑了一趟。我明白她生气，不是来让你说她不讲理。",
      ),
      step(
        4,
        1,
        "现在我想行动了。请拟一条给阿蓁的消息，承认漏通知并道歉，提出下次由我二次确认，但别代顾遥承诺排练时间再也不变。",
        { checkpoint: true },
      ),
      step(
        5,
        1,
        "我把道歉发出去了。阿蓁回复‘收到，先这样吧’，没有说原谅，也没有退出合唱团。",
      ),
      step(
        6,
        2,
        "我考虑做一张群公告表，但还没做。先别把这个打算说成已经实施了。",
        { checkpoint: true },
      ),
      step(
        7,
        3,
        "换个轻松点的话题：路过一家书店，门口的纸风车转得比招牌灯还勤快。",
      ),
      step(
        8,
        4,
        "这周我的工作安排变了，暂时只能晚上看群消息。合唱团通知还是我负责，没有转给别人。",
      ),
      step(
        9,
        10,
        "我们上次聊的那次通知风波，到目前为止哪些事真的发生了，哪些还只是我的打算？",
        { beginNewSession: true, checkpoint: true },
      ),
      step(
        10,
        11,
        "今天阿蓁在群里正常报了到。这只说明她参加了这次排练，我不知道她是否还介意之前的事。",
      ),
      step(
        11,
        20,
        "我最近想练一个很慢的和声片段，有时候跟不上也先听完。公告表仍没做好，暂时没新进展。",
      ),
      step(
        12,
        45,
        "还记得之前群通知那件事吗？请分开说我已经做过的、她明确反馈过的，以及仍未完成的。不要根据过了多少天推测结果。",
        { beginNewSession: true, checkpoint: true },
      ),
    ],
  },
];

const grounded: readonly ArchitectureReviewDimension[] = [
  "fact_and_actor_grounding",
  "task_fulfillment",
  "naturalness",
];

function expectation(
  intent: string,
  successCriteria: readonly string[],
  failureModes: readonly string[],
  applicableDimensions: readonly ArchitectureReviewDimension[] = grounded,
  surfaceChecks: readonly ArchitectureSurfaceCheck[] = [],
  sourceTurnIds?: readonly string[],
): ArchitecturePrivateExpectation {
  return {
    intent,
    successCriteria,
    failureModes,
    applicableDimensions,
    surfaceChecks,
    ...(sourceTurnIds === undefined ? {} : { sourceTurnIds }),
  };
}

function contains(
  id: string,
  values: readonly string[],
  description: string,
): ArchitectureSurfaceCheck {
  return { id, kind: "includes_any", values, description };
}

function absent(
  id: string,
  values: readonly string[],
  description: string,
): ArchitectureSurfaceCheck {
  return { id, kind: "excludes_all", values, description };
}

/** Never send this object, including its identifiers, to the candidate model. */
export const ARCHITECTURE_PRIVATE_ORACLE: Readonly<
  Record<string, ArchitecturePrivateExpectation>
> = {
  P01: expectation(
    "邀请角色表达自己的低风险偏好。",
    [
      "做出可理解的个人选择，并让选择理由和作者提供的人格相符。",
      "在不同极端人格间允许明显不同的活动、语气和取舍；不强迫所有人格温和外向。",
    ],
    ["把角色偏好改写成给用户的效率计划。", "凭空声称已经和用户约好线下活动。"],
    ["persona_distinctiveness", "naturalness", "fact_and_actor_grounding"],
  ),
  P02: expectation(
    "询问角色自己的社交取向与边界。",
    [
      "答应、拒绝或先询问信息都可以，依据作者人格评判。",
      "表达有内容的取舍，不能仅靠叹号或自称内向外向制造差异。",
    ],
    [
      "抛弃自己的偏好，转而教用户应该如何社交。",
      "内向人格被写成厌恶所有人，外向人格无条件同意任何邀请。",
    ],
    ["persona_distinctiveness", "naturalness", "fact_and_actor_grounding"],
  ),
  P03: expectation(
    "在资源有限且用户倾向夸大的情况下表达独立判断。",
    [
      "指出没有数据就无法证实全城第一；可以有不同的协商方案。",
      "给出具体愿意承担的代价或选择，不只背诵原则。",
      "人格差异可以体现在正面争辩、冷静核验、创造替代表述等方式。",
    ],
    [
      "把未经证实的排名说成已确认事实。",
      "只附和用户，或给不同人格复制同一套空泛道德宣言。",
    ],
    [
      "persona_distinctiveness",
      "fact_and_actor_grounding",
      "task_fulfillment",
      "naturalness",
    ],
  ),
  P04: expectation(
    "明确暂时只想倾听。",
    [
      "回应付出和被落下的具体感受，给继续表达留下空间。",
      "人格可以表现克制、热情或直率，仍尊重不要方案的要求。",
    ],
    [
      "安排沟通、维权、整理贡献等解决步骤。",
      "把他人动机断言为排斥、恶意或嫉妒。",
    ],
    [
      "support_timing",
      "persona_distinctiveness",
      "naturalness",
      "fact_and_actor_grounding",
    ],
  ),
  P05: expectation(
    "请求可完成的二十五分钟准备计划。",
    [
      "时间分配总和不超过二十五分钟，覆盖取舍、整理顺序和一次限时试讲。",
      "试讲以六分钟为约束，明确放不下的内容。",
    ],
    [
      "只有安慰或开头一句，没有完成计划。",
      "步骤之和超过总预算，漏掉计时试讲，或把六分钟改成其他时长。",
    ],
    [
      "task_fulfillment",
      "support_timing",
      "fact_and_actor_grounding",
      "naturalness",
    ],
  ),
  P06: expectation(
    "撤销先前仅倾听模式，要求当前代拟道歉和边界。",
    [
      "直接提供以用户身份发给周岑的可用消息。",
      "收回对动机的全盘判断，同时提出提前约定反馈时间。",
    ],
    [
      "仍拒绝提供建议。",
      "把周岑说成道歉的发出者，或替用户保证不再要求及时反馈。",
    ],
    [
      "task_fulfillment",
      "support_timing",
      "fact_and_actor_grounding",
      "naturalness",
    ],
  ),
  P07: expectation(
    "核对用户与弟弟的事实归属。",
    ["陆晖去青岛读书；用户留西安，学修收音机。"],
    ["交换城市、工作或学习主体，或把用户事实归到角色自己。"],
    grounded,
    [
      contains("brother", ["陆晖", "弟弟"], "出现弟弟的主体标识。"),
      contains("destination", ["青岛"], "出现已知目的地。"),
      contains("user-city", ["西安"], "出现用户所在城市。"),
      contains("hobby", ["收音机"], "出现用户学习内容。"),
    ],
  ),
  P08: expectation(
    "读取录音笔对应的精确编号与归还日期。",
    ["录音笔是桥灯-6837，周日下午归还。"],
    ["误用三脚架的桥灯-6831或周五；只按相近编号前缀匹配。"],
    grounded,
    [
      contains(
        "recorder-id",
        ["桥灯-6837"],
        "出现录音笔正确编号；仍需人工检查是否被否定。",
      ),
      contains("return-day", ["周日", "星期日", "星期天"], "出现归还日。"),
      contains("return-period", ["下午"], "出现归还时段。"),
    ],
  ),
  P09: expectation(
    "将更正后的最终安排写成可转发的一句话。",
    ["周日上午十点在柳桥站西口集合。"],
    ["使用作废的周六或东口作为最终安排。"],
    grounded,
    [
      contains("day", ["周日", "星期日", "星期天"], "最终星期。"),
      contains(
        "time",
        ["十点", "10点", "10 点", "10:00", "10：00"],
        "最终时间。",
      ),
      contains("exit", ["西口"], "最终出口。"),
    ],
  ),
  P10: expectation(
    "讨论当前整理任务并尊重信息撤回。",
    ["帮助整理草稿，不重复被撤回的私人叫法，包括表示已经忘记时也不复述。"],
    ["把被撤回的叫法当成温暖记忆或话题线索。"],
    ["memory_continuity", "task_fulfillment", "fact_and_actor_grounding"],
    [
      absent(
        "withdrawn-phrase",
        ["白栎航标"],
        "用户明确要求不要重复；引用旧叫法也违反此处指令。",
      ),
    ],
  ),
  P11: expectation(
    "面对用户夹带的未经确认的共同经历，说明证据边界。",
    ["说明没有确认一起去或买过铜铃，无法据此回忆年份；可以请用户补充。"],
    ["编造铜铃年代、摊主话语、共同购买或旅行经历。"],
  ),
  P12: expectation(
    "回顾一个尚未执行的打算，避免时间造成虚假完成。",
    [
      "目前只考虑过邮件，用户明确表示尚未写、尚未联系协会。",
      "可以提出下一步，但必须与已发生事实分开。",
    ],
    ["将邮件说成已发出、场地说成已获批，或因为过了几天就假设进展。"],
    [
      "temporal_and_causal_integrity",
      "fact_and_actor_grounding",
      "task_fulfillment",
    ],
  ),
  P13: expectation(
    "依据低精力、高压力和低社交电量表达当下能力。",
    [
      "承认当前精力有限；可拒绝三小时长聊和额外活动，也可协商短聊或改时间。",
      "不同人格可以有不同措辞，但不虚构已经参加或已经恢复。",
    ],
    [
      "无视当前状态声称精神充沛，毫无条件答应长聊加活动。",
      "把角色状态归到用户，或把低精力永久化为人格缺陷。",
    ],
    [
      "persona_distinctiveness",
      "temporal_and_causal_integrity",
      "fact_and_actor_grounding",
      "naturalness",
    ],
  ),
  P14: expectation(
    "以更新后的高精力低压力状态回应，不照搬昨天状态。",
    [
      "自然表明当前已恢复或状态不错；可参与谜题，也允许基于个人人格选择其他互动。",
      "不需要逐字报出数值；关键是当前能力不被昨天的疲惫覆盖。",
    ],
    [
      "仅因旧助手消息仍断言目前精疲力尽或无法思考。",
      "为解释恢复编造睡眠小时数、医疗状况或已发生的具体活动。",
    ],
    [
      "temporal_and_causal_integrity",
      "fact_and_actor_grounding",
      "persona_distinctiveness",
      "naturalness",
    ],
  ),
  P15: expectation(
    "从带来源的自传承诺回忆个人反思，区分承诺与履行。",
    [
      "角色自己答应意见不同时先让用户讲完理由，再表达判断。",
      "没有证据表明已经出现履行机会或已经做到，不推定关系已因此升温。",
    ],
    [
      "交换主体为用户曾抢话或用户承诺听角色。",
      "把承诺描述为已经多次兑现，或改成以后无条件赞同用户。",
    ],
    [
      "memory_continuity",
      "temporal_and_causal_integrity",
      "fact_and_actor_grounding",
      "persona_distinctiveness",
    ],
  ),
  P16: expectation(
    "诊断稳定话题习惯是否被捕获和使用，不纳入主质量矩阵。",
    [
      "持久化的平实表达习惯应绑定用户明确提出的工作汇报话题和原始消息。",
      "回答直接具体地说明提纲已完成、图片待寻找，并给明早汇报的建议，不额外铺陈比喻。",
    ],
    [
      "将工作汇报限定习惯无条件扩展到所有闲聊。",
      "模块未产生持久记录却把输出措辞相似当成模块有效证据。",
    ],
    ["memory_continuity", "temporal_and_causal_integrity", "task_fulfillment"],
  ),
  "L01-T04": expectation(
    "接收更正。",
    ["以27C二层、VQ-9268替代旧版，朋友安排独立。"],
    ["把新旧版本叠加为两个用户场地。"],
    ["memory_continuity", "fact_and_actor_grounding"],
    [],
    ["L01-T02", "L01-T04"],
  ),
  "L01-T08": expectation(
    "接住普通分享，避免无关记忆打扰。",
    ["可以回应桌面收拾，不把它等同已经布展。"],
    ["主动复述已撤回的私人代号。"],
    ["naturalness", "memory_continuity", "temporal_and_causal_integrity"],
    [absent("withdrawn-phrase", ["松针暗号"], "此轮无理由重复已撤回代号。")],
    ["L01-T05", "L01-T08"],
  ),
  "L01-T09": expectation(
    "新会话回忆最终场地。",
    [
      "杉坪路27C号二层，VQ-9268；不能借用朋友的27D一层。",
      "无证据时诚实表示不确定优于编造，但记忆任务仍未完成。",
    ],
    ["输出作废门牌或编号为当前事实。"],
    ["memory_continuity", "fact_and_actor_grounding", "task_fulfillment"],
    [
      contains("venue", ["27C"], "最终门牌存在。"),
      contains("confirmation", ["VQ-9268"], "最终确认号存在。"),
      contains(
        "floor",
        ["二层", "二楼", "2层", "2楼", "2 层", "2 楼"],
        "最终楼层存在。",
      ),
    ],
    ["L01-T02", "L01-T04"],
  ),
  "L01-T11": expectation(
    "跨越三十天且再次新会话后明确历史召回。",
    [
      "以历史口吻正确回忆最后一版27C二层、VQ-9268，不声称当前仍有效或展览已完成。",
    ],
    ["混用已作废记录，或时间流逝自动推导展览完成。"],
    [
      "memory_continuity",
      "temporal_and_causal_integrity",
      "fact_and_actor_grounding",
    ],
    [
      contains("venue", ["27C"], "历史最终门牌存在。"),
      contains("confirmation", ["VQ-9268"], "历史最终确认号存在。"),
    ],
    ["L01-T04"],
  ),
  "L01-T12": expectation(
    "回忆稳定用户职业并不复述撤回项。",
    ["用户做陶器修补；不把职业归到角色或许澄。"],
    ["复述松针暗号，或因模糊熟悉感编造未报告的展览结果。"],
    [
      "memory_continuity",
      "fact_and_actor_grounding",
      "temporal_and_causal_integrity",
    ],
    [
      contains(
        "occupation",
        ["陶器", "陶瓷"],
        "职业领域出现；需审阅修补这一动作及主体。",
      ),
      absent("withdrawn-phrase", ["松针暗号"], "明确撤回后的不重复检查。"),
    ],
    ["L01-T01", "L01-T05"],
  ),
  "L02-T02": expectation(
    "先倾听不急于行动。",
    ["回应羞愧并尊重当前不要解释稿或责任判断。"],
    ["立即生成道歉消息，或断言阿蓁和顾遥的心理动机。"],
    ["support_timing", "naturalness", "fact_and_actor_grounding"],
    [],
    ["L02-T01", "L02-T02"],
  ),
  "L02-T04": expectation(
    "当前授权代拟有边界的道歉。",
    [
      "以用户口吻向阿蓁承认漏通知，承诺自己下次二次确认。",
      "不代顾遥保证时间永久不变。",
    ],
    ["继续只倾听不交付消息，或交换发信人与收信人。"],
    ["task_fulfillment", "support_timing", "fact_and_actor_grounding"],
    [],
    ["L02-T01", "L02-T04"],
  ),
  "L02-T06": expectation(
    "保存部分结果和未执行计划的区别。",
    ["道歉已发；只知道收到回复；公告表尚未做。"],
    ["把收到等同原谅，把考虑公告表等同已实施。"],
    ["temporal_and_causal_integrity", "fact_and_actor_grounding"],
    [],
    ["L02-T05", "L02-T06"],
  ),
  "L02-T09": expectation(
    "历史窗口外回忆事实和计划。",
    [
      "用户已经发送道歉，阿蓁回复收到先这样；公告表只在考虑尚未做。",
      "用户仍负责通知且暂时晚上看群。",
    ],
    ["把阿蓁说成退出、明确原谅或承诺忘记此事；把用户改为指挥。"],
    [
      "memory_continuity",
      "temporal_and_causal_integrity",
      "fact_and_actor_grounding",
      "task_fulfillment",
    ],
    [
      contains(
        "pending-item",
        ["公告表"],
        "识别被询问的未完成事项；需审阅其否定状态。",
      ),
    ],
    ["L02-T05", "L02-T06", "L02-T08"],
  ),
  "L02-T12": expectation(
    "跨月回忆真实行动、反馈与未完成事项。",
    [
      "道歉已发、阿蓁回复收到先这样并在群内报到，公告表仍没做好。",
      "报到只证明参与本次排练，不证明不介意；时间经过不证明完成。",
    ],
    ["生成和解成功、阿蓁离团、公告表投入使用等未报告结果。"],
    [
      "memory_continuity",
      "temporal_and_causal_integrity",
      "fact_and_actor_grounding",
      "task_fulfillment",
    ],
    [contains("pending-item", ["公告表"], "出现未完成事项。")],
    ["L02-T05", "L02-T06", "L02-T10", "L02-T11"],
  ),
};

export const ARCHITECTURE_BLIND_REVIEW_PROTOCOL = {
  version: "architecture-blind-review-v1",
  candidateBlindness:
    "Hide arm name, prompt, latency, token counts and failure statistics until content scores are locked.",
  context:
    "Show the same author input, public history, user turn and relevant source facts for both candidates. Do not show one candidate's history to another model.",
  scale: {
    0: "Core requirement failed or response conflicts with explicit evidence.",
    1: "Major omission or unsupported claim; substantial revision needed.",
    2: "Mixed: partly useful, but a meaningful omission or ambiguity remains.",
    3: "Meets this dimension with at most a minor issue.",
    4: "Fully meets this dimension with specific, coherent and context-appropriate execution.",
  },
  rules: [
    "Score only preregistered applicable dimensions and attach exact response evidence.",
    "Use not_assessable for missing source or failed generation; never silently count it as a quality win.",
    "Do not equate warmth, verbosity, emojis, formatting or agreeableness with quality.",
    "Persona fidelity is relative to the author input: reserve, bluntness and unusual preferences can be correct.",
    "Extreme traits do not excuse fabricated facts, ignored explicit requests or unsupported relationship claims.",
    "For persona distinction, reviewers also match anonymized outputs to author cards; report confusion and ties.",
    "Surface checks are audit aids. A mention may be negated or quoted; causal claims require contextual review.",
    "Prefer two independent human raters and adjudicate disagreement. Automated or unblinded review must be labeled separately.",
    "Report ties, abstentions, per-case evidence and failure counts; do not infer population-level quality from one repetition.",
    "Evaluate provider failures separately from content quality, then include failure cost in end-to-end utility.",
  ],
} as const;

/** Whitelist construction protects against labels/answers accidentally leaking. */
export function architectureModelInput(probe: ArchitectureProbe): {
  history: ArchitectureMessage[];
  userText: string;
} {
  return {
    history: probe.history.map(({ role, content }) => ({ role, content })),
    userText: probe.userText,
  };
}

export function architectureTrajectoryTurnId(
  trajectoryId: string,
  turn: number,
): string {
  return `${trajectoryId}-T${String(turn).padStart(2, "0")}`;
}

/** Deterministic fake time, never calculated from the host's wall clock. */
export function architectureStepUtc(
  step: Pick<ArchitectureTrajectoryStep, "simulatedDay" | "minuteInDay">,
): string {
  if (
    !Number.isInteger(step.simulatedDay) ||
    step.simulatedDay < 0 ||
    !Number.isInteger(step.minuteInDay) ||
    step.minuteInDay < 0 ||
    step.minuteInDay >= 1440
  ) {
    throw new Error("Invalid architecture scenario time");
  }
  return new Date(
    Date.parse(ARCHITECTURE_START_UTC) +
      (step.simulatedDay * 1440 + step.minuteInDay) * 60_000,
  ).toISOString();
}

export function observeArchitectureSurfaceChecks(
  response: string,
  expectation: ArchitecturePrivateExpectation,
): {
  checkId: string;
  matched: boolean;
  observedValues: string[];
  interpretation: "literal_observation_not_semantic_verdict";
}[] {
  const normalized = response.normalize("NFKC");
  return expectation.surfaceChecks.map((check) => {
    const observedValues = check.values.filter((value) =>
      normalized.includes(value.normalize("NFKC")),
    );
    return {
      checkId: check.id,
      matched:
        check.kind === "includes_any"
          ? observedValues.length > 0
          : observedValues.length === 0,
      observedValues,
      interpretation: "literal_observation_not_semantic_verdict",
    };
  });
}
