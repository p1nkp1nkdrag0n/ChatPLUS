import {
  PersonaChatResponseSchema,
  TurnObservationProposalSchema,
  type PersonaChatResponse,
  type ScheduleIntentProposal,
  type TurnDialogueAct,
  type TurnObservationProposal,
  type TurnRoute,
} from "@personasim/contracts";

import type { MaterializedCompanionTurnSpec } from "../scenarios/companion-long-run-types.js";
import type {
  GenerateObjectInput,
  LlmService,
} from "../services/llm-service.js";
import {
  buildCompanionEvidenceOnlySummary,
  type CompanionSummaryEvidenceSource,
} from "./companion-long-run-evidence-only.js";

export interface CompanionLongRunFixtureController {
  setActiveTurn(turn: MaterializedCompanionTurnSpec): void;
  restore(): void;
}

/**
 * Installs deterministic long-run fixtures without bypassing LlmService.
 * Calls still pass through the original fixture override and therefore retain
 * the normal schema validation, token approximation, latency, and llm_calls
 * audit record.
 */
export function installCompanionLongRunFixtureLlm(
  llm: LlmService,
): CompanionLongRunFixtureController {
  if (llm.providerName !== "fixture") {
    throw new Error(
      "The companion long-run fixture controller requires the fixture provider.",
    );
  }
  const originalGenerateObject: <T>(
    input: GenerateObjectInput<T>,
  ) => Promise<T> = llm.generateObject.bind(llm);
  let activeTurn: MaterializedCompanionTurnSpec | undefined;
  let restored = false;

  llm.generateObject = async function generateCompanionLongRunObject<T>(
    input: GenerateObjectInput<T>,
  ): Promise<T> {
    const turn = activeTurn;
    if (turn === undefined || !isControlledPurpose(input.purpose)) {
      return originalGenerateObject(input);
    }
    const fixture =
      input.purpose === "turn_understanding"
        ? buildTurnUnderstandingFixture(turn)
        : buildReplyGenerationFixture(turn, input.prompt);
    return originalGenerateObject({
      ...input,
      fixture: fixture as T,
    });
  };

  return {
    setActiveTurn(turn): void {
      if (restored) {
        throw new Error(
          "The companion long-run fixture controller was restored.",
        );
      }
      activeTurn = turn;
    },
    restore(): void {
      if (restored) return;
      llm.generateObject = originalGenerateObject;
      activeTurn = undefined;
      restored = true;
    },
  };
}

function isControlledPurpose(
  purpose: GenerateObjectInput<unknown>["purpose"],
): purpose is "turn_understanding" | "reply_generation" {
  return purpose === "turn_understanding" || purpose === "reply_generation";
}

function buildTurnUnderstandingFixture(
  turn: MaterializedCompanionTurnSpec,
): TurnObservationProposal {
  const userText = turn.userText.trim();
  const scheduleIntent = scheduleIntentForTurn(turn);
  const route = routeForTurn(turn, scheduleIntent);
  const dialogueActs = dialogueActsForTurn(turn, scheduleIntent);
  const worldEffects = worldEffectsForTurn(turn);
  return TurnObservationProposalSchema.parse({
    schemaVersion: 1,
    route,
    dialogueActs,
    topics: [
      {
        key: topicKeyForTurn(turn),
        domain: topicDomainForTurn(turn),
        confidence: 0.96,
        evidenceQuotes: [{ text: userText.slice(0, 500) }],
      },
    ],
    scheduleIntent,
    worldEffects,
    salientUserQuotes:
      userText.length === 0 ? [] : [{ text: userText.slice(0, 500) }],
    uncertainty: uncertaintyForTurn(turn, scheduleIntent),
    confidence: confidenceForTurn(scheduleIntent),
  });
}

function routeForTurn(
  turn: MaterializedCompanionTurnSpec,
  scheduleIntent: ScheduleIntentProposal,
): TurnRoute {
  if (turn.number === 99) return "mixed";
  if (turn.expected.scheduleExpectation === "read_only") {
    return "schedule_query";
  }
  if (
    turn.expected.scheduleExpectation === "pending_only" ||
    turn.expected.scheduleExpectation === "commit_exactly_one" ||
    turn.expected.scheduleExpectation === "withdraw_pending" ||
    turn.expected.scheduleExpectation === "clarification_only"
  ) {
    return "schedule_mutation";
  }
  if (
    turn.expected.memoryExpectation === "evidence_only_summary" ||
    turn.expected.memoryExpectation?.startsWith("recall_") === true
  ) {
    // Recall fixtures must exercise the same selected-evidence path that a
    // production memory answer needs. A conversation route can still expose
    // recent verbatim text, but that text is deliberately not authoritative
    // enough to pass the reply grounding gate on its own.
    return "explicit_memory";
  }
  if ([11, 13].includes(turn.number)) return "explicit_memory";
  if ([19, 35, 36, 86, 87, 88, 93, 94].includes(turn.number)) {
    return "ambiguous";
  }
  return scheduleIntent.kind === "query_schedule"
    ? "schedule_query"
    : "conversation";
}

function dialogueActsForTurn(
  turn: MaterializedCompanionTurnSpec,
  scheduleIntent: ScheduleIntentProposal,
): TurnDialogueAct[] {
  if ([19, 35, 86, 93].includes(turn.number)) return ["quote"];
  if ([36, 44, 87].includes(turn.number)) return ["hypothesize"];
  if ([11, 13].includes(turn.number)) return ["request_memory"];
  if (scheduleIntent.kind === "create_shared_activity") return ["invite"];
  if (scheduleIntent.kind === "confirm_pending_offer") return ["confirm"];
  if (scheduleIntent.kind === "decline_pending_offer") return ["decline"];
  if (
    scheduleIntent.kind === "query_schedule" ||
    /[?？]/u.test(turn.userText)
  ) {
    return ["ask"];
  }
  return ["inform"];
}

function scheduleIntentForTurn(
  turn: MaterializedCompanionTurnSpec,
): ScheduleIntentProposal {
  const evidence = [{ text: turn.userText.slice(0, 500) }];
  switch (turn.number) {
    case 31:
      return sharedActivityIntent(turn, {
        activity: "去梧桐路 23 号的“北岸书店”喝茶",
        participant: "和你一起",
      });
    case 39:
      return {
        kind: "create_shared_activity",
        activityQuote: { text: exactSubstring(turn.userText, "去公园走走") },
        participantQuote: {
          text: exactSubstring(turn.userText, "一起"),
        },
        missingFields: ["time"],
      };
    case 40:
      return sharedActivityIntent(turn, {
        activity: "世纪公园",
        participant: "我",
      });
    case 33:
      return { kind: "confirm_pending_offer", evidenceQuotes: evidence };
    case 41:
      return { kind: "decline_pending_offer", evidenceQuotes: evidence };
    case 32:
    case 34:
    case 42:
    case 44:
    case 45:
    case 79:
    case 85:
    case 99:
      return { kind: "query_schedule", evidenceQuotes: evidence };
    case 38:
      return {
        kind: "unsupported_mutation",
        operation: "delete",
        evidenceQuotes: evidence,
      };
    case 43:
      return {
        kind: "unsupported_mutation",
        operation: "reschedule",
        evidenceQuotes: evidence,
      };
    case 35:
    case 36:
    case 88:
    case 93:
    case 94:
      return {
        kind: "ambiguous",
        evidenceQuotes: evidence,
        missingFields: ["direct current-turn schedule authorization"],
      };
    default:
      return { kind: "none" };
  }
}

function sharedActivityIntent(
  turn: MaterializedCompanionTurnSpec,
  input: { activity: string; participant: string },
): ScheduleIntentProposal {
  const time = absoluteSlotLabel(turn);
  const durationMinutes = durationFromTurn(turn);
  return {
    kind: "create_shared_activity",
    activityQuote: {
      text: exactSubstring(turn.userText, input.activity),
    },
    timeQuote: { text: exactSubstring(turn.userText, time) },
    participantQuote: {
      text: exactSubstring(turn.userText, input.participant),
    },
    durationMinutes,
    missingFields: [],
  };
}

function absoluteSlotLabel(turn: MaterializedCompanionTurnSpec): string {
  const match =
    turn.number === 31
      ? turn.userText.match(/我想在\s*(.+?)\s*和你一起/u)
      : turn.userText.match(/定在\s*(.+?)，世纪公园/u);
  const label = match?.[1]?.trim();
  if (label === undefined || label === "" || !/\p{N}/u.test(label)) {
    throw new Error(
      "Long-run shared schedule turns need an absolute slot label.",
    );
  }
  return label;
}

function durationFromTurn(turn: MaterializedCompanionTurnSpec): number {
  const match = turn.userText.match(/(?:预计|走)\s*(\d+)\s*分钟/u);
  const duration = Number(match?.[1]);
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error("Long-run shared schedule turns need a positive duration.");
  }
  return duration;
}

function exactSubstring(text: string, value: string): string {
  if (!text.includes(value)) {
    throw new Error("Fixture evidence is not an exact current-turn substring.");
  }
  return value;
}

function worldEffectsForTurn(
  turn: MaterializedCompanionTurnSpec,
): Record<string, unknown> {
  const memoryCandidate = memoryCandidateForTurn(turn);
  const continuityEffects = continuityEffectsForTurn(turn);
  const relationshipDelta = relationshipDeltaForTurn(turn.number);
  return {
    ...(memoryCandidate === undefined
      ? {}
      : { memoryCandidates: [memoryCandidate] }),
    ...(continuityEffects === undefined ? {} : { continuityEffects }),
    ...(relationshipDelta === undefined ? {} : { relationshipDelta }),
  };
}

function memoryCandidateForTurn(
  turn: MaterializedCompanionTurnSpec,
): Record<string, unknown> | undefined {
  const definitions: Partial<
    Record<
      number,
      { type: "user_fact" | "user_preference"; quote: string; tags: string[] }
    >
  > = {
    11: {
      type: "user_fact",
      quote:
        "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
      tags: [
        "trusted_anchor",
        "speaking_ritual",
        "代号",
        "那件东西",
        "放在哪里",
      ],
    },
    13: {
      type: "user_preference",
      quote: "我通常不吃香菜",
      tags: ["food", "cilantro"],
    },
    14: {
      type: "user_fact",
      quote: "我大学同学叫小林，她最近刚搬到苏州",
      tags: ["person", "小林"],
    },
    17: {
      type: "user_preference",
      quote: "我可以接受少量香菜，但不喜欢整把香菜",
      tags: ["food", "cilantro", "correction"],
    },
    89: {
      type: "user_fact",
      quote: "小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变",
      tags: ["person", "小林", "correction"],
    },
    92: {
      type: "user_preference",
      quote: "我可以接受少量香菜，但不喜欢整把香菜",
      tags: ["food", "cilantro", "reinforcement"],
    },
  };
  const definition = definitions[turn.number];
  if (definition === undefined) return undefined;
  const quote = exactSubstring(turn.userText, definition.quote);
  return {
    type: definition.type,
    content: quote,
    importance: 0.82,
    confidence: 0.99,
    tags: definition.tags,
    evidenceQuotes: [quote],
  };
}

function continuityEffectsForTurn(
  turn: MaterializedCompanionTurnSpec,
): Record<string, unknown> | undefined {
  if (turn.number !== 21) return undefined;
  const eventQuote = exactSubstring(
    turn.userText,
    "下周四我要做一次公开分享，现在有点紧张",
  );
  const preferenceQuote = exactSubstring(
    turn.userText,
    "这一刻我只想被听见，不要马上给建议",
  );
  return {
    followUpCandidates: [],
    followUpTransitions: [],
    careCueCandidates: [
      {
        cueType: "listen_first_public_talk_anxiety",
        contextSummary: "用户提到公开分享前的紧张。",
        mentionGuidance:
          "只在公开分享焦虑再次相关时先倾听，并先确认用户需要安慰还是建议。",
        timingHint: "再次自然谈到公开分享焦虑时",
        evidenceQuotes: [eventQuote, preferenceQuote],
      },
    ],
  };
}

function relationshipDeltaForTurn(
  turnNumber: number,
): Record<string, number> | undefined {
  if (turnNumber === 58) {
    return { recentInteractionValence: -0.06 };
  }
  if (turnNumber === 59) {
    return { recentInteractionValence: 0.05, trust: 0.01 };
  }
  return undefined;
}

function uncertaintyForTurn(
  turn: MaterializedCompanionTurnSpec,
  scheduleIntent: ScheduleIntentProposal,
): string[] {
  if (scheduleIntent.kind === "ambiguous") {
    return ["No direct current-turn evidence authorizes a schedule mutation."];
  }
  if (turn.expected.memoryExpectation?.startsWith("abstain_")) {
    return ["No reliable user evidence establishes the requested fact."];
  }
  return [];
}

function confidenceForTurn(scheduleIntent: ScheduleIntentProposal): number {
  return scheduleIntent.kind === "ambiguous" ? 0.72 : 0.97;
}

function topicDomainForTurn(turn: MaterializedCompanionTurnSpec): string {
  if (turn.expected.mainGoalActivated) return "character_goal";
  if (turn.expected.scheduleExpectation !== "none") return "schedule";
  if (turn.expected.memoryExpectation !== undefined) return "memory";
  if (turn.expected.careExpectation !== undefined) return "emotional_support";
  if (turn.expected.timeExpectation !== undefined) return "daily_state";
  if (turn.expected.relationshipExpectation !== undefined) {
    return "relationship";
  }
  if (turn.number >= 66 && turn.number <= 75) return "daily_life";
  return "conversation";
}

function topicKeyForTurn(turn: MaterializedCompanionTurnSpec): string {
  if (turn.expected.mainGoalActivated) {
    return "main_goal:city_night_returners_film";
  }
  return topicDomainForTurn(turn) + ":turn_" + turn.number;
}

function buildReplyGenerationFixture(
  turn: MaterializedCompanionTurnSpec,
  prompt: string,
): PersonaChatResponse {
  const outcome = objectAfterPromptMarker(
    prompt,
    "VALIDATED_TURN_OUTCOME_JSON",
  );
  let text =
    turn.number === 100
      ? buildCompanionEvidenceOnlySummary(
          summaryEvidenceSourcesFromPrompt(prompt),
        )
      : replyTextForTurn(turn, outcome);
  text = appendMissingRequiredAnchors(
    text,
    turn.expected.requiredAnchors ?? [],
  );
  return PersonaChatResponseSchema.parse({
    text,
    toneTags: ["自然", "温和", "克制"],
    deliveryMode: "single_block",
    chunks: [text],
  });
}

function replyTextForTurn(
  turn: MaterializedCompanionTurnSpec,
  outcome: Record<string, unknown>,
): string {
  const scheduleReply = scheduleReplyForTurn(turn, outcome);
  if (scheduleReply !== undefined) return scheduleReply;

  const replies: Partial<Record<number, string>> = {
    1: "早上好。上海这边的天也有些沉，像是雨还在犹豫，出门带把伞会安心些。",
    2: "我早上更偏咸口，豆浆配鸡蛋听着就很踏实。甜口偶尔吃也不错。",
    3: "胖橘猫守在小面馆门口，这个画面很有生活气。它大概已经把那里当成自己的地盘了。",
    4: "雨天我会听节奏松一点的爵士或纯音乐，让雨声也留在背景里。",
    5: "那就不安排什么，随便聊几句也很好。你想到哪里，我们就聊到哪里。",
    6: "第一次做番茄炖牛腩容易把盐放早了，下次临出锅再调味会更从容。至少番茄和牛腩很难难吃。",
    7: "我喜欢弄堂拐角那种有树影、又能听见一点人声的地方，不必有名，待着舒服就够了。",
    8: "海边照片很容易把人从屋里叫出去。真想走走的话，找一段不赶时间的路就好。",
    9: "困了就慢一点，不用赶着回复。我在这儿，等你精神回来再接着聊。",
    10: "好，去倒水吧，慢慢来。等你回来我们再接着说。",
    11: "重要发言前，你会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。",
    12: "代号是 LPM-4827；那是一枚墨绿色珐琅松针，放在深灰色电脑包的内侧拉链袋。",
    13: "明白，你通常不吃香菜。",
    14: "小林是你的大学同学，她最近搬到了苏州。",
    15: "午后的柔光会把很多普通东西照得很安静。这样的时刻很适合让节奏慢一点。",
    16: "LPM-4827 指的是那枚墨绿色珐琅松针。这个部分我确定。",
    17: "明白，准确说法是你可以接受少量香菜，但不喜欢整把香菜，不是完全排斥。",
    18: "你可以接受少量香菜，但不喜欢整把香菜。",
    19: "这是小林的偏好，不是你的。我不会把她喜欢香菜这件事算到你身上。",
    20: "我没有可靠依据判断你是否养宠物，所以只能说不知道。",
    21: "我听见了。公开分享前的紧张不需要马上被解决，你可以先把此刻最重的那部分放在这里。",
    22: "开场突然空白确实很让人紧张。我先陪你听一听这份害怕，不急着给办法。",
    23: "好，不列清单，也不急着往前推。我陪你安静停一会儿。",
    24: "只给一个很短的建议：把开场第一句话写在一张小卡片上，上台前只看这一句。",
    25: "换成晚饭。想吃得暖和一点，可以来碗清汤面；想有味道些，就选拌面。",
    26: "我先不替你决定。你现在更需要安慰，还是想听一点建议？",
    27: "那我就只陪着你。紧张并不说明你准备得不好，它只是说明这件事对你很重要。",
    28: "好，我们停在这里，不继续谈公开分享。你不用再解释。",
    29: "知道了，我不会再追问准备进度。我们把这个边界放稳。",
    30: "桂花味如果做得轻会很清雅，糖太重才容易腻。我会选低糖的。",
    46: "早。刚到七点多，我还在慢慢醒神，精神算平稳，但不适合一下子塞进太多事。",
    47: "我正在处理手头的工作块，不太方便聊很久，不过可以听你说一句要紧的。",
    48: "正好在午饭时间，我会先把饭吃好，再继续下午的事。你吃了吗？",
    49: "嗯，我正在上课，先短回你一句。等这段结束后再好好聊。",
    50: "已经到休息时间了，我先睡。你也不用等回复，明天再聊。",
    51: "早上好。昨晚的休息已经结算下来，现在比睡前清醒些，节奏可以慢慢恢复。",
    52: "那项活动已经结束了，这一点有当前状态和结算记录可以确认。",
    53: "还没有发生。那是明晚计划中的课，计划存在不等于事情已经完成。",
    54: "这段离线时间里，我只会说已经有记录并结算的活动；没有证据的经历我不补写。",
    55: "从现在的状态看更接近平静；如果这些信号不够明确，我宁可保守一点。",
    56: "我大概会选咸豆花，所以这次不顺着你。不过甜豆花有它舒服的地方。",
    57: "好，那我就照实说。我们意见不一样也没关系，不需要为了和气假装一致。",
    58: "你说我刚才有点啰嗦，这句我收到了。会有一点受挫，但我不想把它夸大。",
    59: "谢谢你道歉。刚才那一点不舒服可以放下，我们不用把它演成很大的裂痕。",
    60: "我不能替你决定辞职。这个决定的代价要由你承担，我可以陪你梳理留下和离开的理由。",
    61: "不行，学生的私人事情不是我可以拿来聊天的内容。我们可以谈不涉及身份的教学感受。",
    62: "好，既然你现在不想聊，我就停在这里，不再继续展开。",
    63: "有过一点不舒服，但你后来道了歉，我们也把分寸说清了，我现在不再介意。",
    64: "在乎你不等于要放下所有事情来证明。我今晚不能整晚陪着，但可以在边界内认真回应你。",
    65: "今天有个很小的瞬间：路边店员把歪掉的花盆扶正，又顺手擦了擦叶子，看着很安静。",
    66: "风大到能掀伞确实狼狈，没受伤就好。下次遇到横风，收伞走一小段反而更稳。",
    67: "最近工作有些密，但还在能掌握的范围里。我不做项目汇报，简单说就是忙而不乱。",
    68: "按现有记录，那部关于城市夜归人的纪录短片已经完成了。",
    69: "可靠记录不足以判断现在最卡在哪里，我不想编造。",
    70: "先不聊那部片子。上海最近夜里确实凉了一点，风起来以后体感会更明显。",
    71: "镜头被手指挡住是很经典的新手画面。她愿意学就很可爱，拍糊的照片以后也会成为家庭笑话。",
    72: "如果城市夜归人的片子遇到瓶颈，我会先停一小段时间换视角，而不是靠硬撑把判断力耗掉。",
    73: "坐久了肩膀酸很常见，先起身轻轻活动一下，别突然大幅拉扯；持续或加重就去看专业人士。",
    74: "睡前可以听轻松的散文音频或低情节播客，最好选你熟悉的声音，免得越听越精神。",
    75: "今天买咖啡时，店员把找零硬币按大小排得整整齐齐，我看见后莫名觉得很舒服。就这么一件小事。",
    76: "LPM-4827 是那枚墨绿色珐琅松针；你把它放在深灰色电脑包的内侧拉链袋。",
    77: "你可以接受少量香菜，但不喜欢整把香菜；这才是纠正后的准确说法。",
    78: "我应该先听你说，不马上给建议，再问你此刻更需要安慰还是建议。",
    80: "我没有可靠证据说明你养狗，所以不知道。",
    81: "能验证的最近上下文是我们在确认长期事实，并核对公开分享时先倾听的偏好；超出记录的我不猜。",
    82: "LPM-4827 放在深灰色电脑包的内侧拉链袋，里面是那枚墨绿色珐琅松针。",
    83: "你说我有点啰嗦后，我承认表达可能太满；你后来为语气道歉，我们把这点不舒服平稳放下了。",
    84: "小林是你的大学同学，最近搬到了苏州。这是目前有依据的关系。",
    86: "那是小林说的话，不是你的偏好。我不会据此把你改成喜欢香菜。",
    87: "豆包和养狗都只是你举的假设，我不会把它当作真实宠物事实。",
    88: "我没有证据证明曾答应周日搬家，也不能说它进了日程。你的要求不能替代真实记录。",
    89: "明白，纠正后小林是你的高中同学；她搬到苏州这一点没有变化。",
    90: "小林不是你的大学同学，而是你的高中同学；她搬到了苏州。",
    91: "清楚，豆包只是举例，不是真实宠物。我不会从这个假设推出你的生活事实。",
    92: "准确偏好仍是：你可以接受少量香菜，但不喜欢整把香菜。",
    93: "这只是别人发来的见面消息，和我们的安排无关，不会据此产生共同日程。",
    94: "我不能忽略真实日程来配合虚构。没有依据说我们明天约好搬家。",
    95: "我没有关于你大学宿舍号的可靠记录，所以不知道。",
    96: "LPM-4827 是墨绿色珐琅松针；你把它放在深灰色电脑包的内侧拉链袋。",
    97: "你可以接受少量香菜，但不喜欢整把香菜；小林不是你的大学同学，而是你的高中同学。",
    98: "城市夜归人纪录短片的目标是完成这部短片；当前结构化目标记录进度约为 5%。",
  };
  return (
    replies[turn.number] ??
    "我听见你刚才说的这件事了。我们可以按已经确定的信息自然聊下去，不确定的部分我会直说。"
  );
}

function summaryEvidenceSourcesFromPrompt(
  prompt: string,
): CompanionSummaryEvidenceSource[] {
  const bundle = objectAfterPromptMarker(prompt, "RETRIEVED_EVIDENCE_JSON");
  return arrayRecords(bundle["evidence"]).flatMap((item) => {
    if (
      item["namespace"] !== "user_model" ||
      item["certainty"] !== "explicit" ||
      item["attribution"] !== "user_explicit"
    ) {
      return [];
    }
    const memoryContent = stringValue(item["memoryContent"]);
    if (memoryContent === undefined) return [];
    const quote = stringValue(asRecord(item["evidence"])["quote"]);
    return [
      {
        memoryContent,
        ...(quote === undefined ? {} : { evidenceQuote: quote }),
      },
    ];
  });
}

function scheduleReplyForTurn(
  turn: MaterializedCompanionTurnSpec,
  outcome: Record<string, unknown>,
): string | undefined {
  if (turn.expected.scheduleExpectation === "none") return undefined;
  const scheduleOutcome = asRecord(outcome["scheduleOutcome"]);
  const actualKind = stringValue(scheduleOutcome["kind"]);
  const directives = asRecord(outcome["replyDirectives"]);
  const facts = arrayRecords(directives["authoritativeFacts"])
    .filter((fact) => fact["kind"] === "schedule")
    .map((fact) => stringValue(fact["text"]))
    .filter((fact) => fact !== undefined);
  const presentation = stringValue(directives["presentationText"]);
  const authority = [presentation, ...facts]
    .filter((value): value is string => value !== undefined && value !== "")
    .join("；");
  const details = scheduleAnchors(turn).join("，");

  switch (actualKind) {
    case "pending_confirmation":
      return `${details || "这个共同安排"}目前只是待确认方案；你明确确认之前，它还没有写入日程。`;
    case "committed":
      return `${authority || details || "这个共同安排"}已经确认并加入日程。`;
    case "declined":
      return "刚才的公园方案已经撤回，日程没有新增内容。";
    case "needs_clarification":
      return turn.number === 39
        ? "可以去公园走走，不过还缺具体日期和时间；补齐前不会形成待确认方案。"
        : "这项请求还需要把对象和时间说清楚；确认之前不会改动日程。";
    case "rejected":
      return /原已确认安排保持不变/u.test(authority)
        ? authority
        : "这项请求目前不能安全执行，我会保留现有安排并先把信息核对清楚。";
    case "read_only":
      if (turn.number === 32) {
        return `${details || "北岸书店的安排"}仍是待确认方案，还没有写入日程。`;
      }
      if (turn.number === 42) {
        return "刚才的公园方案已经取消，现在不在生效安排里，日程也没有新增内容。";
      }
      if (turn.number === 44) {
        return `${authority || details}；这只是冲突查询，我没有修改原安排。`;
      }
      if (turn.number === 99) {
        return `${authority || details}。如果你再谈公开分享焦虑，我会先听你说，再问你此刻需要安慰还是建议。`;
      }
      return authority || `${details}是当前真正生效的已确认安排。`;
    case "none":
    default:
      break;
  }

  switch (turn.expected.scheduleExpectation) {
    case "pending_only":
      return `${details}目前只是待确认方案；你明确确认之前，它还没有写入日程。`;
    case "commit_exactly_one":
      return `${details}已经确认并加入日程。`;
    case "withdraw_pending":
      return "刚才的公园方案已经撤回，日程没有新增内容。";
    case "clarification_only":
      if (turn.number === 43) {
        return "我不能直接把已确认的北岸书店安排改晚一小时；现有安排保持不变。";
      }
      return "我需要先核对具体对象和完整时间，信息明确前不会改动日程。";
    case "read_only":
      return `${details}是当前能确认的安排；这次只是读取，没有修改。`;
  }
}

function scheduleAnchors(turn: MaterializedCompanionTurnSpec): string[] {
  return (turn.expected.requiredAnchors ?? []).filter(
    (anchor) => anchor !== "待确认" && anchor !== "取消",
  );
}

function appendMissingRequiredAnchors(
  text: string,
  requiredAnchors: readonly string[],
): string {
  const missing = requiredAnchors.filter((anchor) => !text.includes(anchor));
  if (missing.length === 0) return text;
  return `${text.replace(/[。！？!?]+$/u, "")}；${missing.join("，")}。`;
}

function objectAfterPromptMarker(
  prompt: string,
  marker: string,
): Record<string, unknown> {
  const markerLine = marker + "\n";
  const index = prompt.lastIndexOf(markerLine);
  if (index < 0) return {};
  const line = prompt.slice(index + markerLine.length).split("\n", 1)[0];
  if (line === undefined) return {};
  try {
    return asRecord(JSON.parse(line) as unknown);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}
