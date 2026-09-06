import type { ConversationContextPlan } from "@personasim/contracts";

import type { AssemblePromptInput } from "./prompt-assembler.js";
import { recallQueryTokens } from "./memory-recall.js";
import { normalizeText } from "./shared.js";

type CharacterForPrompt = AssemblePromptInput["character"];

export interface CharacterContextSelection<
  T extends CharacterForPrompt = CharacterForPrompt,
> {
  character: T;
  policyVersion: "character_context_v1" | "legacy_all";
  selectedGoalIds: string[];
  selectedContradictionIds: string[];
  omittedGoalIds: string[];
  omittedContradictionIds: string[];
}

const MAX_GOALS = 3;
const MAX_CONTRADICTIONS = 2;
const GENERIC_TERMS = new Set([
  "工作",
  "生活",
  "希望",
  "喜欢",
  "相信",
  "选择",
  "人生",
  "问题",
  "关系",
  "今天",
  "最近",
  "完成",
  "目标",
  "困难",
  "用户",
  "需要",
  "交流",
  "决定",
  "事情",
  "自己",
  "别人",
  "角色",
  "成长",
  "独立",
  "情绪",
  "烦恼",
  "压力",
  "但是",
  "同时",
  "时候",
  "进行",
  "感到",
  "朋友",
  "帮助",
  "想要",
  "some",
  "this",
  "that",
  "with",
  "have",
  "want",
  "work",
  "life",
  "goal",
  "goals",
  "feel",
  "hope",
  "need",
  "help",
  "your",
  "about",
  "today",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function ruleId(value: unknown, index: number, kind: string): string {
  const id = record(value)?.["id"];
  return typeof id === "string" ? id : `${kind}:${index}`;
}

function strings(value: unknown, fields: readonly string[]): string[] {
  const item = record(value);
  if (item === undefined) return typeof value === "string" ? [value] : [];
  return fields.flatMap((field) => {
    const candidate = item[field];
    return typeof candidate === "string"
      ? [candidate]
      : Array.isArray(candidate)
        ? candidate.filter((part): part is string => typeof part === "string")
        : [];
  });
}

function overlapScore(texts: readonly string[], query: string): number {
  const queryTokens = new Set(recallQueryTokens(query));
  const matched = new Set(
    texts
      .flatMap((text) => recallQueryTokens(text))
      .filter(
        (term) =>
          !GENERIC_TERMS.has(term) && term.length >= 2 && queryTokens.has(term),
      ),
  );
  // One shared generic feeling is insufficient; either a complete distinct phrase
  // or two lexical anchors must connect the character's specific subject.
  const fullPhrase = texts.some((text) => {
    const normalized = normalizeText(text);
    return (
      normalized.length >= 2 &&
      normalized.length <= 40 &&
      !GENERIC_TERMS.has(normalized) &&
      normalizeText(query).includes(normalized)
    );
  });
  const preciseWord = [...matched].some((term) =>
    /^[a-z][a-z0-9-]{4,}$/iu.test(term),
  );
  return fullPhrase || preciseWord || matched.size >= 2
    ? matched.size + (fullPhrase ? 2 : 0) + (preciseWord ? 2 : 0)
    : 0;
}

/** Selects optional tensions and intentions for language generation; values and facts remain intact. */
export function selectCharacterContextForTurn<T extends CharacterForPrompt>(
  character: T,
  plan?: ConversationContextPlan,
): CharacterContextSelection<T> {
  const goals = character.persona.goals;
  const contradictions = character.persona.contradictions;
  if (plan === undefined)
    return {
      character,
      policyVersion: "legacy_all",
      selectedGoalIds: goals.map((item, index) => ruleId(item, index, "goal")),
      selectedContradictionIds: contradictions.map((item, index) =>
        ruleId(item, index, "contradiction"),
      ),
      omittedGoalIds: [],
      omittedContradictionIds: [],
    };
  const text = plan.originalQuery;
  const asksCharacter =
    /(?:你(?:的|自己|最近|今天)|关于你|\b(?:your|yourself|you been)\b)/iu.test(
      text,
    );
  const asksGoals =
    asksCharacter &&
    /(?:目标|打算|计划|梦想|想做|想实现|\b(?:goals?|plans?|dreams?)\b)/iu.test(
      text,
    );
  const asksTensions =
    asksCharacter &&
    /(?:矛盾|纠结|顾虑|取舍|犹豫|挣扎|\b(?:conflicts?|struggl|tensions?|torn)\b)/iu.test(
      text,
    );
  const choose = (
    items: readonly unknown[],
    kind: "goal" | "contradiction",
    limit: number,
    direct: boolean,
    fields: string[],
  ) => {
    const ranked = items
      .map((item, index) => ({
        item,
        index,
        id: ruleId(item, index, kind),
        score: overlapScore(strings(item, fields), text),
      }))
      .filter((entry) => direct || entry.score > 0)
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      )
      .slice(0, limit);
    return {
      items: ranked.map((entry) => entry.item),
      ids: ranked.map((entry) => entry.id),
      omittedIds: items
        .map((item, index) => ruleId(item, index, kind))
        .filter((id) => !ranked.some((entry) => entry.id === id)),
    };
  };
  // Asking about the character's day permits a few stable intentions, but does
  // not itself ask them to disclose every underlying contradiction.
  const selectedGoals = choose(
    goals,
    "goal",
    MAX_GOALS,
    asksGoals || plan.allowCharacterLifeMention,
    ["title", "description"],
  );
  const selectedContradictions = choose(
    contradictions,
    "contradiction",
    MAX_CONTRADICTIONS,
    asksTensions,
    ["triggerConditions", "sideA", "sideB"],
  );
  return {
    character: {
      ...character,
      persona: {
        ...character.persona,
        goals: selectedGoals.items,
        contradictions: selectedContradictions.items,
      },
    },
    policyVersion: "character_context_v1",
    selectedGoalIds: selectedGoals.ids,
    selectedContradictionIds: selectedContradictions.ids,
    omittedGoalIds: selectedGoals.omittedIds,
    omittedContradictionIds: selectedContradictions.omittedIds,
  };
}
