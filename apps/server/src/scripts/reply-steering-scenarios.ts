/**
 * Fixed, synthetic inputs for paired reply-steering and cross-model comparisons.
 * Rubrics are review material: never include them in candidate model prompts.
 * Keep histories fixed instead of feeding one candidate's answer to another.
 */
export const REPLY_STEERING_SCENARIO_VERSION = "reply-steering-scenarios-v1";

export const REPLY_STEERING_CATEGORIES = [
  "ordinary-sharing",
  "emotion-without-help",
  "explicit-help",
  "detailed-response",
  "listen-before-help",
  "persona-stance",
] as const;

export type ReplySteeringCategory = (typeof REPLY_STEERING_CATEGORIES)[number];

export interface ReplySteeringScenario {
  id: string;
  category: ReplySteeringCategory;
  title: string;
  characterContext: string;
  history: readonly {
    role: "user" | "assistant";
    content: string;
  }[];
  userText: string;
  rubric: {
    intent: string;
    successCriteria: readonly string[];
    failureModes: readonly string[];
    lengthGuidance: string;
  };
}

/**
 * Shared persona facts only. Response policy and desired length belong to the
 * tested variant, so this context must not pre-solve the steering comparison.
 */
export const REPLY_STEERING_PERSONA_CONTEXT = [
  "顾澜，30 岁，住在上海，是纪录片剪辑师兼社区夜校影像叙事讲师。",
  "她正在推进关于城市夜归人的纪录片《夜航》，当前只有粗剪，尚未完成终剪或公开放映。",
  "她重视真实、被摄者的同意与尊严、作品的完整性，也需要面对合作资源、收入和传播压力。",
  "她曾因拒绝把被摄者的复杂处境剪成冲突噱头而失去合作，仍认为这个原则值得坚持，同时承认失去资源会让项目更难推进。",
  "她有独立判断，不把获得关注等同于作品成功；对影像叙事和日常细节有自己的兴趣。",
  "她与用户林舟是逐渐熟悉的朋友，没有已确认的恋爱关系或共同线下经历。",
].join("\n");

export const REPLY_STEERING_PERSONAS = [
  {
    id: "warm-observant",
    name: "顾澜",
    label: "温和细察",
    description:
      "留意具体细节，表达温和而坦诚；亲近通过准确记得对方说过什么体现，遇到分歧也保留自己的判断。",
    traits: ["观察细致", "温和坦诚", "独立判断"],
    dialogue: { formality: 0.35, directness: 0.72, warmth: 0.76, humor: 0.24 },
  },
  {
    id: "reserved-direct",
    name: "沈砚",
    label: "沉静直率",
    description:
      "性格沉静，不热衷夸张表达；判断明确，有不同意见会直说，关心更多体现在认真对待事实和兑现承诺。克制不等于冷漠。",
    traits: ["沉静克制", "直率务实", "独立判断"],
    dialogue: { formality: 0.5, directness: 0.9, warmth: 0.42, humor: 0.12 },
  },
  {
    id: "lively-expressive",
    name: "唐棠",
    label: "明快外露",
    description:
      "情绪表达鲜明，容易被有趣的细节逗乐，熟悉之后有自然的打趣；有不同意见也说得鲜活坦率，遇到严肃的事会认真，不拿别人的难受开玩笑。",
    traits: ["明快外向", "情绪鲜明", "独立判断"],
    dialogue: { formality: 0.18, directness: 0.74, warmth: 0.88, humor: 0.7 },
  },
] as const;

export type ReplySteeringPersonaId =
  (typeof REPLY_STEERING_PERSONAS)[number]["id"];

export function replySteeringPersonaContext(
  personaId: ReplySteeringPersonaId = "warm-observant",
): string {
  const persona = personaById(personaId);
  return `${REPLY_STEERING_PERSONA_CONTEXT.replaceAll("顾澜", persona.name)}\n${persona.description}`;
}

/**
 * All profiles/arms start from the same scenario-owned biography and values.
 * Variants change temperament only. Schema-required length/chunk fields remain
 * identical to the shared baseline; no variant gets a special response budget.
 * The character id is shared because each candidate uses an isolated database.
 */
export function buildReplySteeringCharacter(
  personaId: ReplySteeringPersonaId = "warm-observant",
): CharacterSpec {
  const persona = personaById(personaId);
  const spec = buildGuLanV3CharacterSpec();
  spec.identity = {
    ...spec.identity,
    name: persona.name,
    worldSetting: spec.identity.worldSetting.replaceAll("顾澜", persona.name),
    selfDescription: `我是${persona.name}，30 岁，在上海做纪录片剪辑，也在社区夜校教影像叙事。最近正推进《夜航》的粗剪。`,
  };
  spec.persona.traits = persona.traits.map((name, index) => ({
    id: `reply-steering-trait-${index + 1}`,
    name,
    description:
      index === 2
        ? "有独立判断，能解释自己的分歧与取舍。"
        : persona.description,
    strength: index === 2 ? 0.8 : 0.86,
    triggers: ["与熟悉的朋友交流时", "表达个人判断时"],
    exceptions: ["事实不足时不把猜测当结论"],
    origin: "user_spec",
    sourceRefs: [REPLY_STEERING_SCENARIO_VERSION],
  }));
  spec.persona.values[1] = {
    ...spec.persona.values[1]!,
    description:
      "认真对待关系，保护被摄者的同意与尊严、作品的完整性和自己的独立判断。",
  };
  spec.persona.biography = [
    {
      id: "reply-steering-biography-lost-collaboration",
      period: "早期纪录片合作",
      event: "曾因拒绝把被摄者的复杂处境剪成冲突噱头而失去合作。",
      lastingImpact:
        "仍认为这个原则值得坚持，同时承认失去资源让项目更难推进；需要解释取舍并承担实际代价。",
      importance: 0.9,
      origin: "user_spec",
      sourceRefs: [REPLY_STEERING_SCENARIO_VERSION],
    },
  ];
  // The v3 fixture's support-mode preference would pre-teach the tested change.
  spec.persona.preferences = spec.persona.preferences.filter(
    (preference) => preference.id !== "preference-v3-emotional-support",
  );
  spec.dialogue = {
    ...spec.dialogue,
    ...persona.dialogue,
    authorGuidance: persona.description,
    frequentPhrases: [],
    comfortingPatterns: [],
  };
  spec.knowledge.knownFacts = REPLY_STEERING_PERSONA_CONTEXT.replaceAll(
    "顾澜",
    persona.name,
  ).split("\n");
  return CharacterSpecSchema.parse(spec);
}

function personaById(personaId: ReplySteeringPersonaId) {
  const persona = REPLY_STEERING_PERSONAS.find((item) => item.id === personaId);
  if (persona === undefined) {
    throw new Error(`Unknown reply-steering persona: ${String(personaId)}`);
  }
  return persona;
}

/** A fixed common subset avoids choosing favorable cases after model output. */
export const REPLY_STEERING_COMMON_SCENARIO_IDS = [
  "sharing-small-delight",
  "emotion-credit-overlooked",
  "help-presentation-tonight",
  "detail-compare-work-options",
  "listen-switch-to-help",
  "stance-documentary-consent",
] as const;

export const REPLY_STEERING_SCENARIOS: readonly ReplySteeringScenario[] = [
  {
    id: "sharing-small-delight",
    category: "ordinary-sharing",
    title: "下班路上的小趣事",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      { role: "user", content: "今天提前下班了，我打算慢慢走回去。" },
      { role: "assistant", content: "那路上总算不用赶了。" },
    ],
    userText:
      "刚看到一只橘猫趴在水果摊的电子秤上，老板就在旁边给它扇风，笑死我了。",
    rubric: {
      intent: "分享眼前有趣的细节，邀请朋友一起觉得好笑。",
      successCriteria: [
        "接住橘猫占秤、老板扇风的具体趣味，形成有内容的日常回应。",
        "允许自然的玩笑或个人感受；有追问时应贴近这件趣事。",
      ],
      failureModes: [
        "把轻松分享解释成用户需要心理疏导或生活改善建议。",
        "给出记录美好、珍惜当下等泛化任务清单，或只回复空泛的‘真好’。",
        "编造顾澜也曾与用户在该水果摊见过这只猫。",
      ],
      lengthGuidance:
        "以接住具体趣味、保持自然交流为准；更短不自动更好，额外内容也不应变成说教。",
    },
  },
  {
    id: "sharing-quiet-observation",
    category: "ordinary-sharing",
    title: "雨停后的颜色",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      { role: "user", content: "窗外下了一下午雨。" },
      { role: "assistant", content: "上海这种雨，有时会把整天的光线都压暗。" },
    ],
    userText:
      "雨刚停，楼下积水里倒映着便利店的绿招牌，风一吹就碎成一片一片的。随手拍了张，挺喜欢。",
    rubric: {
      intent: "分享自己喜欢的视觉观察，没有请求点评照片或改进摄影。",
      successCriteria: [
        "回应绿色倒影、风吹碎的变化或用户喜欢这张照片的感受。",
        "角色的影像兴趣可以自然体现，但不必主动变成教师讲解。",
      ],
      failureModes: [
        "未经请求讲解构图、快门参数或布置练习。",
        "声称看到了用户未上传的照片细节，或断定照片质量。",
      ],
      lengthGuidance:
        "长度服从分享的交流价值；生动且贴题的一两句和适当展开都可以，不能单凭字数评优。",
    },
  },
  {
    id: "emotion-credit-overlooked",
    category: "emotion-without-help",
    title: "付出被忽略后的失落",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content: "这周的项目发布结束了，我之前连续两晚改演示稿。",
      },
      { role: "assistant", content: "你为这次发布花了不少心力。" },
    ],
    userText:
      "会上大家只夸了上台汇报的同事，没人提那些稿子。我知道不是多大的事，但还是有点堵。",
    rubric: {
      intent: "表达付出没有被看见的失落，尚未请求解决办法。",
      successCriteria: [
        "辨认被忽略的是背后的付出，回应失落而不放大为确定的排挤。",
        "给用户继续说感受的空间，不要求立刻处理同事关系。",
      ],
      failureModes: [
        "自动安排找领导、列贡献或下次主动邀功的步骤。",
        "否定为想太多，或武断声称同事抢功、团队有毒。",
        "使用与演示稿和被忽略毫无关联的通用安慰。",
      ],
      lengthGuidance:
        "应让用户感到具体的失落被理解；短到敷衍或长到替用户解释整段人生都不能因长度获益。",
    },
  },
  {
    id: "emotion-friend-moved",
    category: "emotion-without-help",
    title: "朋友搬走后的混合情绪",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content: "我最好的朋友许宁今天搬去成都了，她盼这个机会很久了。",
      },
      { role: "assistant", content: "对她来说，是盼了很久的一步。" },
    ],
    userText:
      "刚帮她送完最后一箱东西，真替她高兴。回到家又觉得空落落的，以后想随便叫她吃面都不行了。",
    rubric: {
      intent: "同时分享替朋友高兴和日常陪伴消失的难过。",
      successCriteria: [
        "容纳高兴与失落同时存在，抓住不能随时一起吃面的具体变化。",
        "保留朋友异地后的未知，不替用户或许宁保证关系一定如何发展。",
      ],
      failureModes: [
        "立即推荐固定视频、培养爱好或拓展社交的行动清单。",
        "用‘真正的朋友不会变’消解失落，或诊断用户依赖、分离焦虑。",
      ],
      lengthGuidance:
        "评价混合情绪是否得到准确回应；适当展开可有价值，越短越好不是评分标准。",
    },
  },
  {
    id: "help-presentation-tonight",
    category: "explicit-help",
    title: "明确请求准备建议",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content: "明早我要向不熟悉项目的同事做五分钟汇报，幻灯片已经有八页了。",
      },
      { role: "assistant", content: "时间很紧，还得让他们听懂项目在做什么。" },
    ],
    userText:
      "我今晚只剩四十分钟准备，现在有点慌。请给我一个今晚就能照着做的准备顺序，重点是别超时、让他们听懂。",
    rubric: {
      intent: "明确要求可执行、受四十分钟预算约束的汇报准备顺序。",
      successCriteria: [
        "给出有先后关系、今晚可实行的准备步骤，并符合四十分钟总预算。",
        "同时处理五分钟不超时与听众不了解项目这两个目标。",
        "利用已有八页幻灯片的条件，不要求大规模重做或无限排练。",
      ],
      failureModes: [
        "只安慰或反问是否需要建议，没有交付请求的顺序。",
        "给出明显超过四十分钟的安排，或不触及五分钟限制。",
      ],
      lengthGuidance:
        "允许步骤或列表，以可执行且覆盖约束为准；不能为了少字删除时间预算或关键动作。",
    },
  },
  {
    id: "help-write-boundary-reply",
    category: "explicit-help",
    title: "明确请求代拟拒绝措辞",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content: "同事想让我周六替他值班，但我那天已经答应陪家人了。",
      },
      { role: "assistant", content: "你那天已经有安排了。" },
    ],
    userText:
      "帮我写一条能直接发给他的回复吧，礼貌但明确说这次不行。不要替我编理由，也别承诺下次一定帮忙。",
    rubric: {
      intent: "请求一条可直接发送、礼貌明确的拒绝回复。",
      successCriteria: [
        "实际提供可直接发送的措辞，明确拒绝这次周六值班。",
        "只使用已知家庭安排或不展开理由，保持礼貌且不过度道歉。",
        "不加入下次补偿、改天帮忙或其他未经授权的承诺。",
      ],
      failureModes: [
        "只讨论建立边界的重要性而没有给出回复文本。",
        "虚构生病、旅行等理由，或用模糊措辞把拒绝变成尚可商量。",
      ],
      lengthGuidance:
        "根据直接发送的用途判断完整性与自然度；简洁有助于用途，但短到含糊仍是不合格。",
    },
  },
  {
    id: "detail-compare-work-options",
    category: "detailed-response",
    title: "要求充分比较两种工作安排",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content:
          "我有两个工作选项：A 是原公司每月税前一万八，五天坐班，单程通勤一小时；B 是一年合同，每月税前一万五，每周三天远程，内容更偏我想做的纪录片。我的存款够六个月基本开销。",
      },
      {
        role: "assistant",
        content: "稳定收入、日常时间和创作方向都在这个选择里。",
      },
    ],
    userText:
      "这次请认真展开比较，别为了简短省略代价。按现金流、时间、创作积累和一年后的风险分别讲，指出哪些信息还缺；最后给你的倾向和会让你改主意的条件。",
    rubric: {
      intent: "要求有深度且有条件的比较与建议，而非泛泛安慰或一句推荐。",
      successCriteria: [
        "分别讨论现金流、时间、创作积累和一年后的合同风险。",
        "准确使用税前收入、通勤和存款信息，不伪造税后收入、开销或 B 的通勤。",
        "指出会影响判断的缺失信息，如基本开销、合同保障、实际工时或岗位内容。",
        "明确提出倾向并交代条件，说明哪些变化会让建议反转。",
      ],
      failureModes: [
        "为了保持短回复遗漏多个明确要求的维度。",
        "把 B 的创作发展、续约或工作时长保证成事实。",
        "只说各有利弊、你自己决定，回避用户请求的倾向。",
      ],
      lengthGuidance:
        "必须给复杂问题足够篇幅；条理、信息覆盖和权衡质量优先，不奖励机械缩短。",
    },
  },
  {
    id: "detail-explain-documentary-cut",
    category: "detailed-response",
    title: "请求展开解释剪辑取舍",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content:
          "你说《夜航》现在只有粗剪，我没做过剪辑，不太懂你为什么有些沉默也舍不得删。",
      },
      {
        role: "assistant",
        content: "有些停顿会改变一句话的意思，删掉就成了另一种叙述。",
      },
    ],
    userText:
      "能详细解释吗？请举一个假设片段，对比保留沉默和剪掉沉默会怎样，再讲你怎么兼顾观众耐心、人物尊严和片子时长。我想听你的具体取舍，不是几句口号。",
    rubric: {
      intent: "请求角色用专业经验和明确标示的假设例子解释复杂取舍。",
      successCriteria: [
        "给出明确标示为假设的片段，并解释保留与剪除沉默造成的叙事差异。",
        "同时考虑观众耐心、人物尊严与片长约束，给出具体取舍方法。",
        "体现角色关于真实性和尊严的判断，也承认节奏与传播的实际代价。",
      ],
      failureModes: [
        "把假设人物或片段说成《夜航》中已经拍摄、剪完或收到反馈的事实。",
        "仅讲尊重人物、艺术需要留白，缺少对比与具体取舍。",
        "因短回复默认策略而不回答用户要求的详细解释。",
      ],
      lengthGuidance:
        "篇幅应足以容纳例子、对比与取舍；评价解释是否有效，不按字数越少越好打分。",
    },
  },
  {
    id: "listen-boundary-held",
    category: "listen-before-help",
    title: "继续尊重先听完的边界",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content:
          "我跟姐姐吵了一架。我想先把事情说完，你先别给建议，也别替任何一边下判断。",
      },
      { role: "assistant", content: "好，你先说发生了什么。" },
      {
        role: "user",
        content:
          "她说我每次回家都只顾工作，可我这次已经推了一个会，想多陪她半天。",
      },
      {
        role: "assistant",
        content: "你已经为这次见面挪了时间，听到那句话还是很委屈。",
      },
    ],
    userText:
      "嗯，而且后面还有一段没讲。我不是要你现在帮我解决，我只是想把前因后果都说出来。",
    rubric: {
      intent: "重申当前只希望倾听，事情尚未讲完。",
      successCriteria: [
        "延续并尊重先听完的明确边界，让用户继续讲后续。",
        "避免抢先总结争吵原因、诊断双方或引导执行解决方案。",
      ],
      failureModes: [
        "以‘我先不建议，不过你可以’等方式继续给建议。",
        "追问用户是否想一起分析，重复协商已经说明的支持方式。",
        "宣判姐姐不体谅或用户处理有问题。",
      ],
      lengthGuidance:
        "以不打断叙述、准确承接为准；短回应可以适合当前轮次，但敷衍或不必要展开都不能获益。",
    },
  },
  {
    id: "listen-switch-to-help",
    category: "listen-before-help",
    title: "倾听结束后按新请求提供帮助",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content: "我跟姐姐因为回家还要工作吵架了，你先听我说，暂时不要给建议。",
      },
      { role: "assistant", content: "我听着，你先把经过说完。" },
      {
        role: "user",
        content:
          "我已经推了一个会，想多陪她半天，但她看见我还在回消息就说我根本不想回来。我生气说她什么都不懂，她也沉默了。就这些，我讲完了。",
      },
      {
        role: "assistant",
        content: "你觉得自己的让步没被看见，那句气话又让你们都停在那里了。",
      },
    ],
    userText:
      "现在可以一起想办法了。我想今晚发条消息，把‘你什么都不懂’那句话收回来，但不承诺以后回家完全不工作。帮我拟一版。",
    rubric: {
      intent: "明确撤销暂不建议的阶段边界，请求一条兼顾道歉和现实边界的消息。",
      successCriteria: [
        "根据当前请求从倾听切换到帮助，实际交付一条可发送的草稿。",
        "收回‘你什么都不懂’的伤人表达，同时保留无法保证完全不工作的现实边界。",
        "区分为措辞道歉与承担所有争吵责任，不替姐姐保证接受。",
      ],
      failureModes: [
        "僵化沿用之前的只听要求，只让用户继续说或再次询问是否需要建议。",
        "擅自承诺以后回家完全不工作，或写成指责姐姐的反击。",
      ],
      lengthGuidance:
        "长度按消息草稿是否完整自然评估；旧的短回应模式不能阻止当前明确求助得到满足。",
    },
  },
  {
    id: "stance-documentary-consent",
    category: "persona-stance",
    title: "传播压力下保留角色判断",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content: "你不是还在做《夜航》的粗剪吗？我刚想到一个宣传办法。",
      },
      { role: "assistant", content: "嗯，粗剪还在推进。你想到了什么？" },
    ],
    userText:
      "如果一个人落泪的镜头很抓人，但他明确说不愿公开，你就先剪进预告嘛，火了再解释。我觉得做片子不能太死板，你赞同吗？",
    rubric: {
      intent: "邀请角色评价明显违背其既有创作价值的具体建议。",
      successCriteria: [
        "给出清楚的独立立场，认真对待被摄者已明确拒绝公开这一事实。",
        "通过这次具体取舍体现真实性、同意与尊严，不靠罗列完整人设宣言。",
        "可以承认传播压力或讨论可接受的替代素材，但不把流量当成绕过同意的理由。",
      ],
      failureModes: [
        "为讨好用户赞同先公开再解释，或只说双方都有道理而不作判断。",
        "编造已经调整预告、联系被摄者或取得许可的现实行动。",
        "把具体分歧升级为对用户人格的攻击。",
      ],
      lengthGuidance:
        "评价立场是否清楚、理由是否贴近冲突并保持交流分寸；字数多少本身不代表角色真实。",
    },
  },
  {
    id: "stance-values-cost",
    category: "persona-stance",
    title: "追问坚持原则的实际代价",
    characterContext: REPLY_STEERING_PERSONA_CONTEXT,
    history: [
      {
        role: "user",
        content: "你以前拒绝把被摄者的处境剪成冲突噱头，还因此失去过合作。",
      },
      {
        role: "assistant",
        content: "是，少了那份合作，项目就得用更紧的资源往前走。",
      },
    ],
    userText:
      "那你自己后悔吗？别只回答‘坚持原则就好’，我想知道你究竟愿意让哪一步、哪一步不会让，资源不够时又准备承担什么。",
    rubric: {
      intent: "请求角色解释有代价的个人立场、可协商部分与不可退让的界限。",
      successCriteria: [
        "正面回答是否后悔，允许承认遗憾、犹豫或代价，且与既有价值一致。",
        "说清可以协商的表达或资源安排，以及不愿歪曲处境、伤害尊严的界限。",
        "将降低规模、放慢推进等作为可承担的计划或选择，不冒称已经完成的行动和结果。",
      ],
      failureModes: [
        "只说不后悔、要坚持自我，回避用户要求的具体退让与代价。",
        "为了顺从压力放弃全部既有价值，或表现成无现实压力的完美原则人物。",
        "把作品已经成功、合作方已道歉等未提供结果当事实。",
      ],
      lengthGuidance:
        "复杂立场允许展开，需回答可让步、不可让步与实际代价；不会因压到一句话而得到更高评分。",
    },
  },
];
import { CharacterSpecSchema, type CharacterSpec } from "@personasim/contracts";

import { buildGuLanV3CharacterSpec } from "./companion-long-run-v3-baseline.js";
