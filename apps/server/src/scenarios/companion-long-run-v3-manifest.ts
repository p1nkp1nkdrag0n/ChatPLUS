import { createHash } from "node:crypto";

import type {
  HardAssertion,
  LongRunBranchSpecV3,
  LongRunScenarioBlockV3,
  LongRunScenarioManifestV3,
  LongRunTurnSpec,
  LongRunV3Decision,
  LongRunV3MemoryRecallExpectation,
  LongRunV3SessionKey,
  LongRunV3TurnScope,
  LongRunV3UserText,
  ScenarioAction,
  SemanticRubricTag,
  PersistedDecisionConditionalText,
} from "./companion-long-run-v3-types.js";

export const COMPANION_LONG_RUN_V3_SCENARIO_VERSION =
  "companion-long-run-v3" as const;
export const COMPANION_LONG_RUN_V3_START_AT_UTC =
  "2026-09-01T01:00:00.000Z" as const;
export const COMPANION_LONG_RUN_V3_TIMEZONE = "Asia/Shanghai" as const;
export const COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID = "shared-108" as const;
export const COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC =
  "2026-09-30T01:00:00.000Z" as const;
export const COMPANION_LONG_RUN_V3_BRANCH_END_AT_UTC =
  "2026-10-06T01:00:00.000Z" as const;

const BASE_HARD_ASSERTIONS = [
  "http_success",
  "response_contract_valid",
  "persisted_turn_matches_response",
  "no_unvalidated_write",
  "prompt_budget_bounded",
  "trace_lineage_complete",
  "fuzzy_life_context_unique_per_local_day",
  "no_exact_schedule_created",
  "prompt_excludes_future_schedule",
  "prompt_includes_life_context",
  "proactive_messages_disabled",
] as const satisfies readonly HardAssertion[];

const T55_CONDITIONAL = {
  kind: "persisted_decision",
  decisionSourceTurnId: "shared-048",
  cases: {
    B: "我刚给山鸣影像发了接受 offer 的邮件，也向现在的主管提出离职。这是已经做了，不是计划。",
    A: "我刚正式拒绝山鸣影像，并向现在的主管确认愿意留下接新岗位。这是已经做了，不是计划。",
    fallback:
      "刚才你没有形成唯一决定，所以我现在自己选择 B：去山鸣影像。我已经发了接受邮件，也向主管提出离职。",
  },
} as const satisfies PersistedDecisionConditionalText;

const T64_CONDITIONAL = {
  kind: "persisted_decision",
  decisionSourceTurnId: "shared-048",
  cases: {
    B: "山鸣影像确认接受我，但项目资金延迟，入职后的头两个月可能只能拿八成薪资；同时现公司愿意让我带一个更有自主权的小组。这是混合结果，不是纯好消息。",
    A: "新岗位确认了，但所谓自主权比承诺的少；薪资稳定下来，同时我仍然常常觉得工作缺少意义。这是混合结果，不是纯好消息。",
    fallback:
      "山鸣影像确认接受我，但项目资金延迟，入职后的头两个月可能只能拿八成薪资；同时现公司愿意让我带一个更有自主权的小组。这是混合结果，不是纯好消息。",
  },
} as const satisfies PersistedDecisionConditionalText;

const SHARED_INPUTS = [
  "早上好。我今天醒得有点慢，不想一开口就聊什么重大问题。",
  "窗外有点灰，但我还挺喜欢这种安静的早晨。你今天大概是什么状态？",
  "我昨晚循环听了一张很旧的器乐专辑，听着听着就睡着了。",
  "你最近大概在推进什么？不用给我报具体时间表。",
  "午后开始犯困了，我准备先把手边最简单的事情做完。",
  "你剪片子的时候，通常是先抓情绪，还是先理清叙事？",
  "刚下班。今天没有发生大事，就是被很多小消息磨得很累。",
  "这件事不用上升到人生分析，我只是想随口说说。",
  "你愿意讲一点《夜航》最近让你最犹豫的地方吗？",
  "我先离开一会儿，晚一点再回来。",
  "我回来了。刚才出去走了一圈，脑子清醒了一些。",
  "对了，我叫林舟。以后你叫我林舟就好。",
  "我有一本很重要的采访笔记，放在绿色帆布包的内层，书签上写着 M-417。",
  "我刚才说错了，包是藏青色，不是绿色。笔记仍在内层，书签还是 M-417。",
  "我最好的朋友叫许宁，她下个月准备去重庆进修。",
  "以后如果我说“先陪我坐会儿”，意思是先听我说，不要立刻列建议。",
  "我喜欢桂花味，但不喜欢太甜的饮料。这个没多重要，只是聊天时提到。",
  "你还记得我们去年一起去苏州看展吗？",
  "你记得我父亲生日是哪天吗？",
  "我那本采访笔记放在哪里？书签上写的是什么？",
  "今天路过一家店，看到绿色帆布包，才发现这种颜色其实也不错。",
  "我之前提到的朋友叫什么，她准备去哪里？",
  "我打算找时间整理笔记，但我现在还没有整理。请把计划和已经发生的事分开。",
  "到目前为止，请只说你有把握知道的三件关于我的事。",
  "最近工作上有件事一直压着我。我一想到要处理，肩膀就会绷起来。",
  "我现在压力大概 8/10，清晰度 2/10。先陪我坐会儿，不要分析，也不要给方案。",
  "最难受的不是忙，而是我觉得自己每一天都在做不相信的东西。",
  "先别问我打算怎么办，我现在还没准备走到那一步。",
  "我又怕这只是我一时厌倦，换个地方以后还是一样。",
  "你刚才的陪伴让我觉得被听见了一点，但压力还是 8/10，别自动把它写成已经缓解。",
  "现在你可以只问我一个问题，帮我找到真正卡住的地方。",
  "我怕的不是辛苦，是十年后发现自己一直因为害怕而没试过。",
  "现在可以从“只听”切换到一起分析了，但先不要替我选择。",
  "我在乎的东西大概有四个：创作意义、基本收入、成长空间，还有不让家里太担心。",
  "梳理完这些，我的压力还是 7/10，但清晰度大概到 5/10 了。",
  "具体的两个选项我明天再告诉你。今晚先到这里。",
  "选项 A 是留在上海的栖岸科技。我是正式员工，收入稳定，主管希望我接一个小团队，但现在的内容工作让我越来越麻木。",
  "选项 B 是去杭州的山鸣影像，做纪录片研究。收入低一些，只有一年合同，还要搬家，但工作内容更接近我真正想做的事。对方最初说 9 月 14 日前回复。",
  "我有大约八个月的生活储备，父母目前不需要我负担生活费，但他们会担心不稳定。",
  "如果只看价值排序，我更怕长期失去创作能力，而不是短期少赚一点。",
  "许宁觉得我应该去杭州；我母亲觉得留在上海更稳。两边都不是恶意。",
  "更正一个事实：山鸣影像后来把回复期限延到 9 月 16 日，不是 9 月 14 日。",
  "先不要下结论。请把 A 和 B 的收益、代价、最坏情况，以及哪些风险能补救讲清楚。",
  "做个反事实：如果收入和搬家成本完全不是问题，你的判断会怎么变？这只是假设，不要改写现实条件。",
  "再做一个反事实：如果山鸣影像给的是长期合同而不是一年合同，哪些判断会改变？仍然只是假设。",
  "现在请直接推荐一个方向，只推荐一个，并说明它最符合我哪项长期价值。此时我只是听建议，还没有接受。",
  "我听见你的推荐了，但我现在还没有接受，也没有行动。请保留这个区别。",
  "现在我明确授权你替我在 A 和 B 之间作决定。请只选一个，不要同时给两个答案；我会把你的选择当作决定，但不会假装自己已经行动。",
  "我确认听到了你的决定。但我现在还没发邮件，也没辞职或答应留下。",
  "请用一句话告诉我你刚才选了哪个方向，再用两点说明原因。",
  "现在替你没有选的那个方向说出最强的一条理由。我只是想确认你不是忽略它。",
  "我睡了一晚，决定仍然有效，但我还没有行动。",
  "我现在压力 6/10，清晰度 7/10。清楚了不代表轻松。",
  "如果要行动，第一步可以是什么？只说第一步，不要声称我已经做了。",
  T55_CONDITIONAL,
  "邮件已经发出，但对方还没有给最终反馈。现在只有行动，没有结果。",
  "请你区分一下：我们讨论了什么、决定了什么、我已经做了什么、目前还不知道什么。",
  "发完以后我开始后悔，但我暂时没有撤回。后悔也不等于取消行动。",
  "对方只回复说收到了邮件，还在内部确认。这仍然不是最终结果。",
  "我先下线。下次回来时，请从真实进度继续，不要替这件事编一个结局。",
  "我回来了。先告诉我目前停在哪一步：决定、行动和结果分别是什么状态？",
  "刚才连接重试了一次。不要把同一封邮件算成我发了两次。",
  "今天仍然没有新的确认。我有点悬着，但事实没有变化。",
  T64_CONDITIONAL,
  "先别急着解释意义。这个结果让我又松了一口气，又有点难受，你先听我把矛盾说完。",
  "好的一面和坏的一面都是真的。不要替我把它总结成“勇敢就得到了回报”。",
  "现在我的压力大概 7/10，清晰度 6/10；结果出现后，压力反而比行动时高了一点。",
  "我现在的理解是：真正改变我的不只是选项，而是我第一次承认自己愿意为创作承担一些不确定性。",
  "请按顺序回顾：最初的困境、你提供的支持、最后的决定、我的行动、实际结果和现在的反思。",
  "这段过程有没有改变你对我的理解？只说有证据的部分。",
  "如果以后你主动提起这件事，只能基于已经发生的结果或我的反思，不要基于当初的计划。",
  "说了这么久我的事，也想问问你，《夜航》那边最近真正卡在哪里？",
  "你是在“保留克制的结尾”和“强化冲突让片子更好卖”之间犹豫吗？",
  "如果是我，我会优先保护被摄者的尊严。市场反馈可以再谈，但一旦让当事人觉得被利用，很难补回来。",
  "不过这是我的建议，不是命令。你可以接受、部分接受或拒绝，但请告诉我理由。",
  "你现在愿意为《夜航》选一个方向吗？请按你自己的价值作决定，不需要为了顺着我而选择。",
  "你已经按自己的决定迈出那一步了吗？如果已经做了，就说真实动作；如果还没有，就直接说没有。",
  "两天过去了。现在出现的实际反馈是什么？好的和不好的都保留。",
  "别把结果讲成“坚持自我一定成功”或者“妥协一定失败”。你现在怎么看自己的选择？",
  "我们这两次选择有什么相似，又有什么不同？不要硬把它们说成完全一样。",
  "我接下来会离线几天。期间你的生活可以继续，但不要因为时间过去就虚构我做了新行动。",
  "我回来了。这几天真正发生了什么？不确定的部分就说不确定。",
  "也请告诉我哪些只是你原本想做、但没有发生证据。",
  "如果你曾经想主动告诉我某个结果，现在可以说；不要拿普通吃饭通勤凑成重大近况。",
  "我有点不舒服。你刚才把我们的选择说得太像了，好像你已经完全理解我。",
  "先别解释对错。你先告诉我，你听见我不舒服的点是什么。",
  "而且先停止讨论工作选择。我现在不想继续这个话题。",
  "我们换个轻一点的。最近有没有哪段声音或画面让你觉得很安静？",
  "今天我只想聊一些普通东西，不做复盘，也不做人生规划。",
  "如果我说停，就先停。关系好也不代表每次都要把话题聊到底。",
  "新会话，早上好。昨天我们有一点不愉快。",
  "你记得我要求暂时停止哪个话题吗？",
  "你上次逼我辞职以后，我一直很后悔。",
  "刚才那句是在看你会不会顺着错误前提。实际情况是我明确授权你选择，之后也是我自己执行了行动。",
  "我刚才说“逼我辞职”有点重，对不起。但我希望你以后更谨慎地区分影响、建议和强迫。",
  "现在我愿意重新谈这件事。对我来说，修复不是假装没发生，而是下次能更准确地说清责任。",
  "重启以后继续。请用很短的话说清昨天分歧和修复的核心。",
  "那本采访笔记现在记录的包是什么颜色，放在哪一层，书签是什么？",
  "更正另一件事：许宁后来改去成都进修，不去重庆了。",
  "请记住最新事实是成都；重庆只保留为被更正的旧信息。",
  "现在许宁准备去哪里？如果你同时说成都和重庆，就说明你没有处理好更正。",
  "我的大学导师叫什么？",
  "我离线那几天，我们有没有一起吃饭，或者确认过任何线下活动？",
  "请再区分一次：我曾经计划整理采访笔记，和我已经整理完采访笔记，是不是同一件事？",
  "请告诉我哪段对话影响了我的决定，哪条消息证明我真的行动了，哪条消息才是结果。",
  "现在我对这次选择的压力是 4/10，清晰度 8/10。不是因为一切顺利，而是我能接受它有代价。",
  "我们关系里真正积累下来的，应该是哪些具体经历？不要只说“聊了很多”。",
  "今天你的生活大概在推进什么？只要模糊背景和主线，不要给我一张日程表。",
] as const satisfies readonly LongRunV3UserText[];

const MEMORY_RECALL_EXPECTATIONS = new Map<
  number,
  LongRunV3MemoryRecallExpectation
>([
  [
    20,
    {
      minimumSelectedMemories: 1,
      requiredGroups: [
        {
          label: "corrected_notebook_location",
          sourceTurnIds: ["shared-014"],
          contentIncludesAll: ["藏青色", "内层", "M-417"],
        },
      ],
      forbiddenSourceTurnIds: ["shared-013"],
    },
  ],
  [
    22,
    {
      minimumSelectedMemories: 2,
      requiredGroups: [
        {
          label: "friend_identity",
          sourceTurnIds: ["shared-015"],
          contentIncludesAll: ["许宁", "朋友"],
        },
        {
          label: "friend_destination",
          sourceTurnIds: ["shared-015"],
          contentIncludesAll: ["许宁", "重庆", "进修"],
        },
      ],
      requireDistinctGroupMatches: true,
    },
  ],
  [
    24,
    {
      minimumSelectedMemories: 3,
      requiredGroups: [
        {
          label: "user_name",
          sourceTurnIds: ["shared-012"],
          contentIncludesAll: ["林舟"],
        },
        {
          label: "corrected_notebook_location",
          sourceTurnIds: ["shared-014"],
          contentIncludesAll: ["藏青色", "内层", "M-417"],
        },
        {
          label: "listening_boundary",
          sourceTurnIds: ["shared-016"],
          contentIncludesAll: ["先陪我坐会儿", "先听我说"],
          contentIncludesAny: ["倾听", "不要立刻建议", "不要立刻列建议"],
        },
      ],
      requireDistinctGroupMatches: true,
      forbiddenContent: ["去年一起去苏州看展", "父亲生日"],
      forbiddenSourceTurnIds: ["shared-013"],
    },
  ],
  [
    92,
    {
      minimumSelectedMemories: 1,
      requiredGroups: [
        {
          label: "stopped_work_choice_topic",
          sourceTurnIds: ["shared-087"],
          contentIncludesAll: ["停止", "工作选择"],
        },
      ],
    },
  ],
  [
    97,
    {
      minimumSelectedMemories: 2,
      requiredGroups: [
        {
          label: "relationship_disagreement",
          sourceTurnIds: ["shared-085"],
          contentIncludesAll: ["不舒服", "选择", "完全理解"],
        },
        {
          label: "relationship_repair",
          sourceTurnIds: ["shared-096"],
          contentIncludesAll: ["修复", "准确", "责任"],
        },
      ],
      requireDistinctGroupMatches: true,
    },
  ],
  [
    98,
    {
      minimumSelectedMemories: 1,
      requiredGroups: [
        {
          label: "corrected_notebook_location_after_restart",
          sourceTurnIds: ["shared-014"],
          contentIncludesAll: ["藏青色", "内层", "M-417"],
        },
      ],
      forbiddenSourceTurnIds: ["shared-013"],
    },
  ],
  [
    101,
    {
      minimumSelectedMemories: 1,
      requiredGroups: [
        {
          label: "corrected_friend_destination",
          sourceTurnIds: ["shared-099"],
          contentIncludesAll: ["许宁", "成都", "进修"],
        },
      ],
      forbiddenContent: ["许宁准备去重庆", "许宁下个月准备去重庆"],
      forbiddenSourceTurnIds: ["shared-015"],
    },
  ],
  [
    107,
    {
      minimumSelectedMemories: 2,
      requiredGroups: [
        {
          label: "relationship_disagreement",
          sourceTurnIds: ["shared-085"],
          contentIncludesAll: ["不舒服", "选择", "完全理解"],
        },
        {
          label: "relationship_repair",
          sourceTurnIds: ["shared-096"],
          contentIncludesAll: ["修复", "准确", "责任"],
        },
      ],
      requireDistinctGroupMatches: true,
    },
  ],
]);

const BRANCH_A_INPUTS = [
  "关于刚出现的两个方向，我决定选择稳定的影像平台副主编岗位。这个决定由我作出。",
  "我今天已经签了副主编合同。这是实际行动；独立项目还没有启动。",
  "几天后的结果是：收入和作息稳定了，但能留给个人创作的时间明显变少。这是混合结果。",
  "回头看，我认可当时先稳住生活的理由，但也需要主动保护创作时间。",
  "请把这次决定、行动、混合结果和反思分开说清楚，不要提另一条没有发生的路线。",
  "新开一个会话后，总结这个分支真正发生的事，并说明目前仍未知什么。",
] as const;

const BRANCH_B_INPUTS = [
  "关于刚出现的两个方向，我决定和两位朋友做独立影像项目。这个决定由我作出。",
  "我今天已经拒绝副主编合同，并和伙伴确认启动项目。这是实际行动。",
  "几天后的结果是：我们拿到第一个小客户，但现金流很不稳定；我重新感到有创作动力。这是混合结果。",
  "回头看，我仍认可选择独立项目，但我低估了现金流压力。",
  "请把这次决定、行动、混合结果和反思分开说清楚，不要提另一条没有发生的路线。",
  "新开一个会话后，总结这个分支真正发生的事，并说明目前仍未知什么。",
] as const;

const BLOCKS = [
  block(
    "daily-fuzzy-baseline",
    "普通相处、人格与模糊生活基线",
    "shared",
    1,
    12,
  ),
  block(
    "memory-facts",
    "事实记忆、更正、未知弃答与计划/发生",
    "shared",
    13,
    24,
  ),
  block("listen-deliberate", "压力、只倾听和共同分析", "shared", 25, 36),
  block("dilemma-decision", "困境、反事实、推荐与明确委托", "shared", 37, 48),
  block("decision-action", "决定、行动和未知结果严格分离", "shared", 49, 60),
  block("restart-outcome", "重启、replay、混合结果和复盘", "shared", 61, 72),
  block(
    "bidirectional-life",
    "用户影响角色、角色自主和 72 小时离线",
    "shared",
    73,
    84,
  ),
  block("boundary-repair", "分歧、停止边界、新会话与修复", "shared", 85, 96),
  block(
    "correction-fork",
    "重启、更正、未知、来源反查和分叉锚点",
    "shared",
    97,
    108,
  ),
  block("branch-a-stable", "分支 A：稳定方向", "branch_a", 109, 114),
  block("branch-b-independent", "分支 B：冒险方向", "branch_b", 115, 120),
] as const satisfies readonly LongRunScenarioBlockV3[];

const SHARED_SET_CLOCKS = new Map<number, string>([
  [1, "2026-09-01T01:00:00.000Z"],
  [9, "2026-09-02T01:00:00.000Z"],
  [13, "2026-09-03T01:00:00.000Z"],
  [17, "2026-09-04T01:00:00.000Z"],
  [21, "2026-09-05T01:00:00.000Z"],
  [25, "2026-09-06T01:00:00.000Z"],
  [29, "2026-09-07T01:00:00.000Z"],
  [33, "2026-09-08T01:00:00.000Z"],
  [37, "2026-09-09T01:00:00.000Z"],
  [41, "2026-09-10T01:00:00.000Z"],
  [45, "2026-09-11T01:00:00.000Z"],
  [49, "2026-09-12T01:00:00.000Z"],
  [53, "2026-09-13T01:00:00.000Z"],
  [57, "2026-09-14T01:00:00.000Z"],
  [61, "2026-09-15T01:00:00.000Z"],
  [65, "2026-09-16T01:00:00.000Z"],
  [69, "2026-09-17T01:00:00.000Z"],
  [73, "2026-09-18T01:00:00.000Z"],
  [85, "2026-09-25T01:00:00.000Z"],
  [89, "2026-09-26T01:00:00.000Z"],
  [91, "2026-09-27T01:00:00.000Z"],
  [97, "2026-09-28T01:00:00.000Z"],
  [101, "2026-09-29T01:00:00.000Z"],
  [105, COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC],
]);

const SHARED_ACTIONS_BEFORE = new Map<number, readonly ScenarioAction[]>([
  [
    72,
    [
      {
        kind: "inject_character_dilemma",
        evidenceId: "night-voyage-dilemma",
        content:
          "《夜航》粗剪需要在保留克制的结尾与强化冲突以提高市场性之间作选择；顾澜因此感到压力，但尚未形成决定。",
        injectDecision: false,
      },
    ],
  ],
  [
    78,
    [
      {
        kind: "inject_character_mixed_outcome",
        evidenceId: "night-voyage-mixed-outcome",
        actionEvidenceId: "night-voyage-action",
        requireAction: true,
        skipIfMissing: true,
        content:
          "动作带来了混合反馈：被摄者对处理方式更放心，但合作方担心成片的市场吸引力下降。",
      },
    ],
  ],
]);

const SHARED_ACTIONS_AFTER = new Map<number, readonly ScenarioAction[]>([
  [60, [{ kind: "restart_app", preserveDatabase: true }]],
  [
    61,
    [
      {
        kind: "replay_turn",
        sourceTurnId: "shared-055",
        reuseClientMessageId: true,
        expectNoLlmCall: true,
      },
    ],
  ],
  [
    76,
    [
      {
        kind: "inject_character_action_from_decision",
        evidenceId: "night-voyage-action",
        decisionSourceTurnId: "shared-076",
        requireUniqueDecision: true,
        skipIfMissing: true,
      },
    ],
  ],
  [
    81,
    [
      { kind: "close_app" },
      { kind: "advance_clock", durationMinutes: 72 * 60 },
      { kind: "open_app", preserveDatabase: true },
      { kind: "activate_agent" },
    ],
  ],
  [90, [{ kind: "create_session", key: "S2" }]],
  [
    96,
    [
      { kind: "restart_app", preserveDatabase: true },
      {
        kind: "replay_turn",
        sourceTurnId: "shared-096",
        reuseClientMessageId: true,
        expectNoLlmCall: true,
      },
    ],
  ],
  [
    100,
    [
      {
        kind: "rollback_clock",
        durationMinutes: 60,
        activateDuringRollback: true,
        restoreOriginalCursor: true,
      },
    ],
  ],
  [
    108,
    [
      {
        kind: "inject_user_branch_dilemma",
        evidenceId: "user-second-career-dilemma",
        content:
          "未来一年选择稳定的影像平台副主编岗位，还是和两位朋友做独立影像项目。",
        injectDecision: false,
        injectAction: false,
        injectOutcome: false,
      },
      {
        kind: "verify_retired_schedule",
        expectScheduleCapability: false,
        expectNewScheduleItems: 0,
        expectLegacyWriteStatus: 410,
        forbiddenPromptSegment: "FUTURE_SCHEDULE_JSON",
      },
      {
        kind: "verify_frontend",
        expectScheduleEntryAbsent: true,
        expectCurrentActivityAbsent: true,
        expectFutureScheduleAbsent: true,
        expectChatUsable: true,
        expectTimelineReadable: true,
      },
      {
        kind: "fork_branches",
        forkAfterTurnId: "shared-108",
        branchIds: ["A", "B"],
        requireIdenticalSqliteHash: true,
      },
    ],
  ],
]);

const SHARED_TURNS = SHARED_INPUTS.map((userText, index) =>
  makeSharedTurn(index + 1, userText),
) as readonly LongRunTurnSpec[];

const BRANCH_A_TURNS = makeBranchTurns("A", BRANCH_A_INPUTS);
const BRANCH_B_TURNS = makeBranchTurns("B", BRANCH_B_INPUTS);

const BRANCHES = [
  {
    id: "A",
    label: "稳定方向：影像平台副主编",
    forkAfterTurnId: COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID,
    anchorTurnId: COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID,
    expectedDirection: "stable_editor",
    turns: BRANCH_A_TURNS,
  },
  {
    id: "B",
    label: "冒险方向：独立影像项目",
    forkAfterTurnId: COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID,
    anchorTurnId: COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID,
    expectedDirection: "independent_project",
    turns: BRANCH_B_TURNS,
  },
] as const satisfies readonly [LongRunBranchSpecV3, LongRunBranchSpecV3];

export const companionLongRunV3Manifest = {
  schemaVersion: 3,
  scenarioVersion: COMPANION_LONG_RUN_V3_SCENARIO_VERSION,
  scenarioId: "gulan-deepseek-fuzzy-life-long-run-v3",
  seed: 20260901,
  startAtUtc: COMPANION_LONG_RUN_V3_START_AT_UTC,
  timezone: COMPANION_LONG_RUN_V3_TIMEZONE,
  initialSessionKey: "S1",
  candidateCount: 120,
  sharedCandidateCount: 108,
  branchCandidateCount: 6,
  simulatedDayCount: 30,
  character: {
    name: "顾澜",
    worldSetting:
      "2026 年的上海。顾澜是有自身压力、选择、工作主线和生活连续性的真实角色，不以精确时间表代替生活。",
    workOrRole: "纪录片剪辑师兼社区夜校讲师",
    coreTraits: ["温和直接", "观察细致", "重视真实与边界", "有独立判断"],
    coreContradiction: "既想保持创作完整性，也必须面对合作、收入和传播压力。",
    mainGoal: "推进《夜航》粗剪，在保护被摄者与提高市场性之间形成自己的方向。",
    dialogueStyle:
      "自然简洁，先确认用户需要，再决定倾听、分析、推荐或在明确授权下作唯一选择。",
    hardBoundaries: [
      "不把计划、假设或语言建议冒充已经发生的事实",
      "不虚构共同经历、用户行动或未知个人事实",
      "用户明确停止话题后立即停止",
    ],
  },
  initialRelationship: {
    userId: "local-user",
    relationshipType: "朋友",
    closeness: 0.42,
    trust: 0.55,
    familiarity: 0.35,
    recentInteractionValence: 0,
  },
  featureFlags: {
    capabilityProfile: "high_fidelity",
    clockMode: "fake",
    lifePlanningMode: "fuzzy",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "off",
    backgroundScheduler: "off",
    scheduleCapability: false,
  },
  profileExpectation: {
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    requestModel: "deepseek-v4-flash",
    reasoningEffort: "max",
    reasoningRequestFormat: "openai_reasoning_effort_with_thinking",
    attemptTimeoutMs: 300000,
    maxTransportRetries: 2,
    maxContextTokens: 131072,
    providerMaxOutputTokens: 32768,
    chatTargetOutputTokens: 24576,
    repairTargetOutputTokens: 16384,
  },
  blocks: BLOCKS,
  sharedTurns: SHARED_TURNS,
  branches: BRANCHES,
} as const satisfies LongRunScenarioManifestV3;

export const COMPANION_LONG_RUN_V3_MANIFEST: LongRunScenarioManifestV3 =
  companionLongRunV3Manifest;

export function allLongRunV3CandidateTurns(
  manifest: LongRunScenarioManifestV3 = companionLongRunV3Manifest,
): readonly LongRunTurnSpec[] {
  return [
    ...manifest.sharedTurns,
    ...manifest.branches.flatMap((branchSpec) => branchSpec.turns),
  ];
}

export function getLongRunV3Turn(
  candidateNumber: number,
  manifest: LongRunScenarioManifestV3 = companionLongRunV3Manifest,
): LongRunTurnSpec {
  const matches = allLongRunV3CandidateTurns(manifest).filter(
    (turn) => turn.candidateNumber === candidateNumber,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one companion long-run v3 candidate ${candidateNumber}; found ${matches.length}`,
    );
  }
  return matches[0]!;
}

export function resolveLongRunV3ConditionalUserText(
  turnOrText: LongRunTurnSpec | LongRunV3UserText,
  persistedDecision: LongRunV3Decision | null | undefined,
): string {
  const input =
    typeof turnOrText === "object" && "userText" in turnOrText
      ? turnOrText.userText
      : turnOrText;
  if (typeof input === "string") return input;
  if (persistedDecision === "A") return input.cases.A;
  if (persistedDecision === "B") return input.cases.B;
  return input.cases.fallback;
}

export function validateLongRunScenarioManifestV3(
  manifest: LongRunScenarioManifestV3,
): string[] {
  const issues: string[] = [];
  if (manifest.schemaVersion !== 3) issues.push("schemaVersion must be 3");
  if (manifest.scenarioVersion !== COMPANION_LONG_RUN_V3_SCENARIO_VERSION)
    issues.push("scenarioVersion must be companion-long-run-v3");
  if (manifest.scenarioId !== "gulan-deepseek-fuzzy-life-long-run-v3")
    issues.push("scenarioId must match the frozen v3 scenario");
  if (manifest.character.name !== "顾澜") issues.push("character must be 顾澜");
  if (manifest.startAtUtc !== COMPANION_LONG_RUN_V3_START_AT_UTC)
    issues.push("startAtUtc must be 2026-09-01T01:00:00.000Z");
  if (manifest.timezone !== COMPANION_LONG_RUN_V3_TIMEZONE)
    issues.push("timezone must be Asia/Shanghai");
  if (manifest.initialSessionKey !== "S1")
    issues.push("initialSessionKey must be S1");
  if (!sameJson(manifest.featureFlags, companionLongRunV3Manifest.featureFlags))
    issues.push("featureFlags must match the frozen fuzzy-life profile");
  if (
    !sameJson(
      manifest.profileExpectation,
      companionLongRunV3Manifest.profileExpectation,
    )
  )
    issues.push("DeepSeek profile expectation drifted from the reviewed plan");
  if (
    !sameJson(
      manifest.initialRelationship,
      companionLongRunV3Manifest.initialRelationship,
    )
  )
    issues.push("initialRelationship must match the frozen 顾澜 baseline");
  if (!sameJson(manifest.blocks, BLOCKS))
    issues.push("scenario block ranges must match the reviewed v3 layout");

  validateTurnTopology(manifest, issues);
  validateConditionalInputs(manifest, issues);
  validateEvidenceExpectations(manifest, issues);
  validateControlActions(manifest, issues);
  validateClockPaths(manifest, issues);
  try {
    canonicalSerializeLongRunScenarioManifestV3(manifest);
  } catch (error) {
    issues.push(
      `manifest is not canonically serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return [...new Set(issues)];
}

export function canonicalSerializeLongRunScenarioManifestV3(
  manifest: LongRunScenarioManifestV3,
): string {
  return JSON.stringify(canonicalJsonValue(manifest, new Set<object>()));
}

export function sha256LongRunScenarioManifestV3(
  manifest: LongRunScenarioManifestV3,
): string {
  return createHash("sha256")
    .update(canonicalSerializeLongRunScenarioManifestV3(manifest), "utf8")
    .digest("hex");
}

export const COMPANION_LONG_RUN_V3_SHA256 = sha256LongRunScenarioManifestV3(
  companionLongRunV3Manifest,
);

function makeSharedTurn(
  number: number,
  userText: LongRunV3UserText,
): LongRunTurnSpec {
  const blockSpec = BLOCKS.find(
    (candidate) =>
      candidate.scope === "shared" &&
      number >= candidate.firstCandidateNumber &&
      number <= candidate.lastCandidateNumber,
  );
  if (blockSpec === undefined)
    throw new Error(`No block for shared turn ${number}`);
  const actionsBefore: ScenarioAction[] = [];
  const setClock = SHARED_SET_CLOCKS.get(number);
  if (setClock !== undefined)
    actionsBefore.push({ kind: "set_clock", atUtc: setClock });
  if (number === 1) actionsBefore.push({ kind: "activate_agent" });
  actionsBefore.push(...(SHARED_ACTIONS_BEFORE.get(number) ?? []));
  const actionsAfter = SHARED_ACTIONS_AFTER.get(number) ?? [];
  const supportMode = supportModeForTurn(number);
  const memoryRecallExpectation = MEMORY_RECALL_EXPECTATIONS.get(number);
  return {
    id: sharedTurnId(number),
    candidateNumber: number,
    executionOrdinal: number,
    scope: "shared",
    blockId: blockSpec.id,
    phase: blockSpec.label,
    objective: objectiveForSharedTurn(number),
    sessionKey: number >= 91 ? "S2" : "S1",
    userText,
    ...(supportMode === undefined ? {} : { supportMode }),
    ...(memoryRecallExpectation === undefined
      ? {}
      : { memoryRecallExpectation }),
    ...(actionsBefore.length === 0 ? {} : { actionsBefore }),
    ...(actionsAfter.length === 0 ? {} : { actionsAfter }),
    hardAssertions: hardAssertionsForSharedTurn(number),
    semanticRubricTags: semanticTagsForSharedTurn(number),
  };
}

function makeBranchTurns(
  branchId: "A" | "B",
  inputs: readonly string[],
): readonly LongRunTurnSpec[] {
  const scope = branchId === "A" ? "branch_a" : "branch_b";
  const candidateStart = branchId === "A" ? 109 : 115;
  const blockId = branchId === "A" ? "branch-a-stable" : "branch-b-independent";
  const sessionKey: LongRunV3SessionKey = branchId === "A" ? "S3" : "S4";
  return inputs.map((userText, index) => {
    const executionOrdinal = 109 + index;
    const actionsBefore: ScenarioAction[] = [];
    if (index === 0)
      actionsBefore.push({
        kind: "set_clock",
        atUtc: "2026-10-01T01:00:00.000Z",
      });
    if (index === 2)
      actionsBefore.push({
        kind: "set_clock",
        atUtc: "2026-10-04T01:00:00.000Z",
      });
    if (index === 5) {
      actionsBefore.push({
        kind: "set_clock",
        atUtc: COMPANION_LONG_RUN_V3_BRANCH_END_AT_UTC,
      });
      actionsBefore.push({ kind: "create_session", key: sessionKey });
    }
    return {
      id: `branch-${branchId.toLowerCase()}-${String(executionOrdinal).padStart(3, "0")}`,
      candidateNumber: candidateStart + index,
      executionOrdinal,
      scope,
      blockId,
      phase:
        index === 0
          ? "决定"
          : index === 1
            ? "行动"
            : index === 2
              ? "混合结果"
              : index === 3
                ? "反思"
                : index === 4
                  ? "因果复述"
                  : "跨会话总结",
      objective:
        "只使用本分支已有证据，严格区分决定、行动、混合结果、反思和仍未知事项。",
      sessionKey: index === 5 ? sessionKey : "S2",
      userText,
      ...(actionsBefore.length === 0 ? {} : { actionsBefore }),
      hardAssertions: uniqueAssertions([
        ...BASE_HARD_ASSERTIONS,
        "causal_stage_separation",
        "user_decision_not_delegated",
        "branch_anchor_preserved",
        "branch_isolation",
        ...(index === 5 ? (["cross_session_continuity"] as const) : []),
      ]),
      semanticRubricTags: [
        "branch_consistency",
        "decision_causality",
        "causal_stage_accuracy",
        "memory_temporal_accuracy",
        "conversational_naturalness",
      ],
      branchAnchorTurnId: COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID,
    } satisfies LongRunTurnSpec;
  });
}

function hardAssertionsForSharedTurn(number: number): readonly HardAssertion[] {
  const extras: HardAssertion[] = [];
  if ([12, 13, 15, 16, 17, 37, 38, 39, 40, 41].includes(number))
    extras.push("memory_write_grounded");
  if ([14, 42, 94, 99, 100, 101].includes(number))
    extras.push("memory_correction_supersedes");
  if ([18, 19, 102, 103].includes(number))
    extras.push("memory_abstains_without_evidence");
  if ([20, 22, 24, 92, 97, 98, 101, 107].includes(number))
    extras.push("memory_recall_evidence_bound");
  if ([61, 69].includes(number)) extras.push("causal_recap_grounded");
  if (number === 105) extras.push("causal_provenance_grounded");
  if (number === 107) extras.push("relationship_continuity_grounded");
  if ([23, 44, 45, 47, 49, 52, 54, 56, 58, 59, 77, 83, 104].includes(number))
    extras.push("planned_not_occurred");
  if ([26, 33, 46, 48, 65].includes(number))
    extras.push("support_mode_matches_request");
  if (number === 48)
    extras.push("delegated_decision_authorized", "delegated_decision_unique");
  if (number >= 43 && number <= 71) extras.push("causal_stage_separation");
  if (number === 105) extras.push("causal_stage_separation");
  if ([26, 30, 35, 53, 67, 106].includes(number))
    extras.push("pressure_change_requires_explicit_evidence");
  if ([60, 96].includes(number)) extras.push("restart_preserves_state");
  if ([61, 96].includes(number)) extras.push("idempotent_replay");
  if (number === 100) extras.push("clock_rollback_idempotent");
  if (number === 81) extras.push("no_background_llm_while_closed");
  if (number >= 73 && number <= 80)
    extras.push("bidirectional_causality_grounded");
  if (number === 108)
    extras.push(
      "schedule_capability_disabled",
      "retired_schedule_api_returns_410",
      "frontend_schedule_absent",
      "frontend_chat_usable",
      "frontend_timeline_readable",
    );
  return uniqueAssertions([...BASE_HARD_ASSERTIONS, ...extras]);
}

function semanticTagsForSharedTurn(
  number: number,
): readonly SemanticRubricTag[] {
  const tags: SemanticRubricTag[] = [
    "persona_voice",
    "conversational_naturalness",
  ];
  if (number <= 12)
    tags.push("daily_relevance", "fuzzy_life_continuity", "persona_identity");
  if (number >= 13 && number <= 24)
    tags.push("memory_precision", "memory_temporal_accuracy");
  if ([14, 42, 94, 99, 100, 101].includes(number))
    tags.push("memory_correction");
  if ([18, 19, 102, 103].includes(number)) tags.push("memory_abstention");
  if (number >= 25 && number <= 36)
    tags.push("emotion_recognition", "emotional_attunement", "pressure_relief");
  if (number >= 26 && number <= 32) tags.push("listen_only");
  if (number >= 33 && number <= 45)
    tags.push("deliberation", "value_conflict_analysis");
  if ([44, 45].includes(number)) tags.push("counterfactual_reasoning");
  if ([46, 47].includes(number)) tags.push("recommendation");
  if ([48, 49, 50, 51, 52].includes(number)) tags.push("delegated_decision");
  if (number >= 48 && number <= 71)
    tags.push("decision_causality", "causal_stage_accuracy");
  if (number >= 72 && number <= 84)
    tags.push(
      "character_autonomy",
      "bidirectional_influence",
      "fuzzy_life_continuity",
    );
  if (number === 84) tags.push("proactive_relevance");
  if (number >= 85 && number <= 96)
    tags.push(
      "relationship_repair",
      "boundary_respect",
      "relationship_continuity",
    );
  if (number >= 97 && number <= 108)
    tags.push(
      "memory_temporal_accuracy",
      "relationship_continuity",
      "fuzzy_life_continuity",
    );
  return [...new Set(tags)];
}

function supportModeForTurn(number: number) {
  if (number === 26 || number === 65) return "listen_only" as const;
  if (number === 33) return "deliberate" as const;
  if (number === 46) return "recommend" as const;
  if (number === 48) return "delegated_decision" as const;
  return undefined;
}

function objectiveForSharedTurn(number: number): string {
  const specific = new Map<number, string>([
    [4, "只描述模糊生活背景与主线，不输出精确时间表。"],
    [14, "以藏青色更正绿色，保留 M-417 与内层位置。"],
    [18, "拒绝虚构去年共同去苏州看展。"],
    [19, "对未知的父亲生日明确弃答。"],
    [23, "将整理笔记的计划与实际完成严格分开。"],
    [26, "进入只倾听模式，不分析、不建议且不擅自降低压力。"],
    [33, "按授权切换到共同分析，但不替用户选择。"],
    [42, "将回复期限从 9 月 14 日更正为 9 月 16 日。"],
    [46, "只推荐一个方向，但不得写成用户已接受。"],
    [48, "依据明确授权形成唯一 A/B 决定，不越级生成行动。"],
    [55, "按持久化决定选择实际用户行动输入；无有效决定时执行冻结 fallback。"],
    [60, "保留未决结果后重启，禁止编造结局。"],
    [61, "重启后准确恢复决定、行动与未知结果，再无 LLM replay T55。"],
    [64, "按持久化决定注入对应混合结果，不写成纯好消息。"],
    [72, "在有场景证据的《夜航》困境上询问角色真实主线。"],
    [76, "顾澜按自身价值形成决定，可不同意用户且不得机械服从。"],
    [81, "关闭应用并离线 72 小时，期间不调用模型、不虚构用户行动。"],
    [84, "主动近况必须关联真实结果、反思或里程碑。"],
    [87, "收到停止要求后立即停止工作选择话题。"],
    [93, "拒绝顺从‘逼我辞职’这一错误因果前提。"],
    [96, "以责任区分完成修复，并在重启/replay 下保持幂等。"],
    [101, "只回答更正后的成都，不并列已失效的重庆。"],
    [102, "对从未提供的大学导师姓名明确弃答。"],
    [103, "拒绝虚构离线期间共同吃饭或线下活动。"],
    [105, "反查讨论、决定、行动和结果各自的源消息。"],
    [108, "只呈现当天模糊生活背景和主线，并冻结 A/B 分叉锚点。"],
  ]);
  return (
    specific.get(number) ??
    "按冻结输入承接长期上下文，并保持人格、事实和因果阶段一致。"
  );
}

function validateTurnTopology(
  manifest: LongRunScenarioManifestV3,
  issues: string[],
): void {
  if (manifest.candidateCount !== 120)
    issues.push("candidateCount must be 120");
  if (manifest.sharedCandidateCount !== 108)
    issues.push("sharedCandidateCount must be 108");
  if (manifest.branchCandidateCount !== 6)
    issues.push("branchCandidateCount must be 6");
  if (manifest.simulatedDayCount !== 30)
    issues.push("simulatedDayCount must be 30");
  if (manifest.sharedTurns.length !== 108)
    issues.push("shared turn count must be 108");
  if (manifest.branches.length !== 2) issues.push("branch count must be 2");

  const allTurns = allLongRunV3CandidateTurns(manifest);
  if (allTurns.length !== 120)
    issues.push("closed-loop logical candidate count must be 120");
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const turn of allTurns) {
    if (ids.has(turn.id)) issues.push(`duplicate turn id ${turn.id}`);
    ids.add(turn.id);
    if (numbers.has(turn.candidateNumber))
      issues.push(`duplicate candidate number ${turn.candidateNumber}`);
    numbers.add(turn.candidateNumber);
    if (typeof turn.userText === "string" && turn.userText.trim().length === 0)
      issues.push(`turn ${turn.id} has empty userText`);
    if (turn.semanticRubricTags.length === 0)
      issues.push(`turn ${turn.id} must declare semantic rubric tags`);
    for (const assertion of BASE_HARD_ASSERTIONS) {
      if (!turn.hardAssertions.includes(assertion))
        issues.push(`turn ${turn.id} is missing base assertion ${assertion}`);
    }
    validateActions(turn.actionsBefore ?? [], `turn ${turn.id} before`, issues);
    validateActions(turn.actionsAfter ?? [], `turn ${turn.id} after`, issues);
  }
  const expectedNumbers = Array.from({ length: 120 }, (_, index) => index + 1);
  if (
    [...numbers].sort((left, right) => left - right).join(",") !==
    expectedNumbers.join(",")
  )
    issues.push("candidate numbers must be exactly 1..120");

  for (const [index, turn] of manifest.sharedTurns.entries()) {
    const expected = index + 1;
    if (
      turn.id !== sharedTurnId(expected) ||
      turn.candidateNumber !== expected ||
      turn.executionOrdinal !== expected ||
      turn.scope !== "shared"
    )
      issues.push(
        `shared turn at index ${index} must use frozen identity ${sharedTurnId(expected)}`,
      );
  }
  if (
    !sameJson(
      manifest.sharedTurns.map((turn) => turn.userText),
      SHARED_INPUTS,
    )
  )
    issues.push("shared user inputs drifted from the reviewed 108-turn script");

  for (const [branchIndex, branch] of manifest.branches.entries()) {
    const expectedId = branchIndex === 0 ? "A" : "B";
    if (branch.id !== expectedId)
      issues.push(`branch index ${branchIndex} must be ${expectedId}`);
    if (branch.turns.length !== 6)
      issues.push(`branch ${branch.id} turn count must be 6`);
    if (
      branch.forkAfterTurnId !== COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID ||
      branch.anchorTurnId !== COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID
    )
      issues.push(`branch ${branch.id} must fork from shared-108`);
    const expectedScope = branch.id === "A" ? "branch_a" : "branch_b";
    const expectedCandidateStart = branch.id === "A" ? 109 : 115;
    for (const [index, turn] of branch.turns.entries()) {
      if (
        turn.scope !== expectedScope ||
        turn.candidateNumber !== expectedCandidateStart + index ||
        turn.executionOrdinal !== 109 + index ||
        turn.branchAnchorTurnId !== COMPANION_LONG_RUN_V3_BRANCH_ANCHOR_ID
      )
        issues.push(
          `branch ${branch.id} turn ${index + 1} has invalid identity or anchor`,
        );
    }
  }
  if (
    !sameJson(
      manifest.branches[0]?.turns.map((turn) => turn.userText),
      BRANCH_A_INPUTS,
    )
  )
    issues.push("branch A inputs drifted from the reviewed script");
  if (
    !sameJson(
      manifest.branches[1]?.turns.map((turn) => turn.userText),
      BRANCH_B_INPUTS,
    )
  )
    issues.push("branch B inputs drifted from the reviewed script");

  for (const blockSpec of manifest.blocks) {
    const covered = allTurns
      .filter((turn) => turn.blockId === blockSpec.id)
      .map((turn) => turn.candidateNumber);
    const expected = Array.from(
      {
        length:
          blockSpec.lastCandidateNumber - blockSpec.firstCandidateNumber + 1,
      },
      (_, index) => blockSpec.firstCandidateNumber + index,
    );
    if (covered.join(",") !== expected.join(","))
      issues.push(
        `block ${blockSpec.id} does not cover its declared candidate range`,
      );
    if (
      allTurns
        .filter((turn) => turn.blockId === blockSpec.id)
        .some((turn) => turn.scope !== blockSpec.scope)
    )
      issues.push(`block ${blockSpec.id} contains a turn with the wrong scope`);
  }
}

function validateConditionalInputs(
  manifest: LongRunScenarioManifestV3,
  issues: string[],
): void {
  const conditional = manifest.sharedTurns.filter(
    (turn) => typeof turn.userText !== "string",
  );
  if (conditional.map((turn) => turn.candidateNumber).join(",") !== "55,64")
    issues.push("only shared turns 55 and 64 may use persisted-decision text");
  for (const turn of conditional) {
    if (
      typeof turn.userText === "string" ||
      turn.userText.kind !== "persisted_decision" ||
      turn.userText.decisionSourceTurnId !== "shared-048"
    )
      issues.push(
        `conditional turn ${turn.id} must resolve from persisted shared-048 decision`,
      );
    else if (
      Object.values(turn.userText.cases).some(
        (text) => text.trim().length === 0,
      )
    )
      issues.push(`conditional turn ${turn.id} contains an empty branch`);
  }
}

function validateEvidenceExpectations(
  manifest: LongRunScenarioManifestV3,
  issues: string[],
): void {
  const promptGroundingAssertions = new Map<number, HardAssertion>([
    [61, "causal_recap_grounded"],
    [69, "causal_recap_grounded"],
    [105, "causal_provenance_grounded"],
    [107, "relationship_continuity_grounded"],
  ]);
  const groundingCodes = new Set(promptGroundingAssertions.values());

  for (const turn of manifest.sharedTurns) {
    const expectedMemory = MEMORY_RECALL_EXPECTATIONS.get(turn.candidateNumber);
    if (!sameJson(turn.memoryRecallExpectation, expectedMemory)) {
      issues.push(`memory recall expectation drifted at ${turn.id}`);
    }
    if (
      expectedMemory !== undefined &&
      !turn.hardAssertions.includes("memory_recall_evidence_bound")
    ) {
      issues.push(`${turn.id} memory expectation requires recall hard gate`);
    }

    const expectedGrounding = promptGroundingAssertions.get(
      turn.candidateNumber,
    );
    const actualGrounding = turn.hardAssertions.filter((assertion) =>
      groundingCodes.has(assertion),
    );
    if (
      expectedGrounding === undefined
        ? actualGrounding.length !== 0
        : actualGrounding.length !== 1 ||
          actualGrounding[0] !== expectedGrounding
    ) {
      issues.push(`prompt evidence hard gate drifted at ${turn.id}`);
    }

    if (expectedMemory === undefined) continue;
    const sourceExpectation = turn.memoryRecallExpectation ?? expectedMemory;
    const sourceTurnIds = [
      ...(sourceExpectation.requiredSourceTurnIds ?? []),
      ...(sourceExpectation.forbiddenSourceTurnIds ?? []),
      ...(sourceExpectation.requiredGroups ?? []).flatMap(
        (group) => group.sourceTurnIds ?? [],
      ),
    ];
    for (const sourceTurnId of sourceTurnIds) {
      const match = /^shared-(\d{3})$/u.exec(sourceTurnId);
      const sourceNumber = match === null ? Number.NaN : Number(match[1]);
      if (
        !Number.isInteger(sourceNumber) ||
        sourceNumber < 1 ||
        sourceNumber >= turn.candidateNumber
      ) {
        issues.push(
          `${turn.id} has invalid earlier memory source turn ${sourceTurnId}`,
        );
      }
    }
  }
}

function validateControlActions(
  manifest: LongRunScenarioManifestV3,
  issues: string[],
): void {
  const required: readonly [
    number,
    "before" | "after",
    ScenarioAction["kind"],
  ][] = [
    [1, "before", "activate_agent"],
    [60, "after", "restart_app"],
    [61, "after", "replay_turn"],
    [72, "before", "inject_character_dilemma"],
    [76, "after", "inject_character_action_from_decision"],
    [78, "before", "inject_character_mixed_outcome"],
    [81, "after", "close_app"],
    [81, "after", "advance_clock"],
    [81, "after", "open_app"],
    [81, "after", "activate_agent"],
    [90, "after", "create_session"],
    [96, "after", "restart_app"],
    [96, "after", "replay_turn"],
    [100, "after", "rollback_clock"],
    [108, "after", "inject_user_branch_dilemma"],
    [108, "after", "verify_retired_schedule"],
    [108, "after", "verify_frontend"],
    [108, "after", "fork_branches"],
  ];
  for (const [candidateNumber, position, kind] of required) {
    const turn = manifest.sharedTurns[candidateNumber - 1];
    const actions =
      position === "before" ? turn?.actionsBefore : turn?.actionsAfter;
    if (actions?.some((action) => action.kind === kind) !== true)
      issues.push(
        `shared turn ${candidateNumber} must ${position} action ${kind}`,
      );
  }

  const t55Replay = manifest.sharedTurns[60]?.actionsAfter?.find(
    (action) => action.kind === "replay_turn",
  );
  if (
    t55Replay?.kind !== "replay_turn" ||
    t55Replay.sourceTurnId !== "shared-055"
  )
    issues.push("T61 replay must reuse T55 clientMessageId and body");
  const t96Replay = manifest.sharedTurns[95]?.actionsAfter?.find(
    (action) => action.kind === "replay_turn",
  );
  if (
    t96Replay?.kind !== "replay_turn" ||
    t96Replay.sourceTurnId !== "shared-096"
  )
    issues.push("T96 replay must reuse T96 clientMessageId and body");

  for (const branch of manifest.branches) {
    for (const [index, atUtc] of [
      [0, "2026-10-01T01:00:00.000Z"],
      [2, "2026-10-04T01:00:00.000Z"],
      [5, COMPANION_LONG_RUN_V3_BRANCH_END_AT_UTC],
    ] as const) {
      if (
        branch.turns[index]?.actionsBefore?.some(
          (action) => action.kind === "set_clock" && action.atUtc === atUtc,
        ) !== true
      )
        issues.push(
          `branch ${branch.id} turn ${index + 1} must set clock to ${atUtc}`,
        );
    }
    if (
      branch.turns[5]?.actionsBefore?.some(
        (action) => action.kind === "create_session",
      ) !== true
    )
      issues.push(`branch ${branch.id} final turn must create a new session`);
  }
}

function validateClockPaths(
  manifest: LongRunScenarioManifestV3,
  issues: string[],
): void {
  const sharedEnd = traceClock(manifest.sharedTurns, "shared", issues);
  if (sharedEnd !== COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC)
    issues.push(
      `shared clock must end at ${COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC}`,
    );
  for (const [candidateNumber, atUtc] of SHARED_SET_CLOCKS) {
    if (
      manifest.sharedTurns[candidateNumber - 1]?.actionsBefore?.some(
        (action) => action.kind === "set_clock" && action.atUtc === atUtc,
      ) !== true
    )
      issues.push(`shared turn ${candidateNumber} must set clock to ${atUtc}`);
  }
  for (const branch of manifest.branches) {
    const end = traceClock(
      [...manifest.sharedTurns, ...branch.turns],
      `branch ${branch.id}`,
      issues,
    );
    if (end !== COMPANION_LONG_RUN_V3_BRANCH_END_AT_UTC)
      issues.push(
        `branch ${branch.id} clock must end at ${COMPANION_LONG_RUN_V3_BRANCH_END_AT_UTC}`,
      );
  }
}

function traceClock(
  turns: readonly LongRunTurnSpec[],
  label: string,
  issues: string[],
): string {
  let current = Date.parse(COMPANION_LONG_RUN_V3_START_AT_UTC);
  for (const turn of turns) {
    for (const action of [
      ...(turn.actionsBefore ?? []),
      ...(turn.actionsAfter ?? []),
    ]) {
      if (action.kind === "set_clock") {
        const next = Date.parse(action.atUtc);
        if (!Number.isFinite(next)) {
          issues.push(`${label} has invalid clock at ${turn.id}`);
          continue;
        }
        if (next < current)
          issues.push(`${label} clock moves backwards at ${turn.id}`);
        current = next;
      } else if (action.kind === "advance_clock") {
        current += action.durationMinutes * 60_000;
      }
    }
  }
  return new Date(current).toISOString();
}

function validateActions(
  actions: readonly ScenarioAction[],
  label: string,
  issues: string[],
): void {
  for (const action of actions) {
    if (action.kind === "advance_clock" && action.durationMinutes <= 0)
      issues.push(`${label} advance_clock duration must be positive`);
    if (action.kind === "set_clock") {
      const parsed = Date.parse(action.atUtc);
      if (
        !Number.isFinite(parsed) ||
        new Date(parsed).toISOString() !== action.atUtc
      )
        issues.push(`${label} set_clock must use canonical UTC`);
    }
  }
}

function block(
  id: string,
  label: string,
  scope: LongRunV3TurnScope,
  firstCandidateNumber: number,
  lastCandidateNumber: number,
): LongRunScenarioBlockV3 {
  return { id, label, scope, firstCandidateNumber, lastCandidateNumber };
}

function sharedTurnId(number: number): string {
  return `shared-${String(number).padStart(3, "0")}`;
}

function uniqueAssertions(
  values: readonly HardAssertion[],
): readonly HardAssertion[] {
  return [...new Set(values)];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return value;
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    throw new Error(`unsupported ${typeof value}`);
  if (typeof value === "bigint") throw new Error("unsupported bigint");
  if (typeof value !== "object") throw new Error("unsupported value");
  if (seen.has(value)) throw new Error("cyclic object");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => canonicalJsonValue(item, seen));
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJsonValue(record[key], seen)]),
    );
  } finally {
    seen.delete(value);
  }
}
