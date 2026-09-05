import { z } from "zod";

export const PRODUCT_LIFE_INPUT_PROTOCOL = "named-public-history-v3";
export const PRODUCT_LIFE_USER_NAME = "林舟";
export const PRODUCT_LIFE_CHARACTER_NAME = "顾澜";

export interface ProductLifeHistoryMessage {
  sourceId: string;
  role: "user" | "assistant";
  content: string;
  authoredAtUtc?: string;
  authoredDisplayDate?: string;
  firstVisibleAtUtc: string;
  channel?: string;
}

/** Reopening a letter is an API check, not a second exposure of its text. */
export function appendProductLifeHistory(
  history: ProductLifeHistoryMessage[],
  messages: readonly ProductLifeHistoryMessage[],
): void {
  for (const message of messages) {
    const existing = history.find((item) => item.sourceId === message.sourceId);
    if (existing) {
      if (
        existing.content !== message.content ||
        existing.role !== message.role
      )
        throw new Error("public_history_source_changed");
      continue;
    }
    history.push(message);
  }
}

export function productLifePublicContext(
  history: readonly ProductLifeHistoryMessage[],
  nowUtc: string,
  maximumCharacters = 48000,
) {
  const visible = history.filter(
    (message) => Date.parse(message.firstVisibleAtUtc) <= Date.parse(nowUtc),
  );
  const bounded = [...visible];
  while (
    bounded.reduce((total, message) => total + message.content.length, 0) >
    maximumCharacters
  )
    bounded.shift();
  return {
    currentTimeUtc: nowUtc,
    currentTimeLocal: shanghaiTime(nowUtc),
    timezone: "Asia/Shanghai",
    participants: {
      simulatedUser: { id: "user", name: PRODUCT_LIFE_USER_NAME },
      productCharacter: { id: "assistant", name: PRODUCT_LIFE_CHARACTER_NAME },
    },
    publicHistory: bounded.map((message) => ({
      ...message,
      speakerName:
        message.role === "user"
          ? PRODUCT_LIFE_USER_NAME
          : PRODUCT_LIFE_CHARACTER_NAME,
      authoredAtLocal: message.authoredAtUtc
        ? shanghaiTime(message.authoredAtUtc)
        : message.authoredDisplayDate,
      firstVisibleAtLocal: shanghaiTime(message.firstVisibleAtUtc),
    })),
    omittedEarlierMessages: visible.length - bounded.length,
  };
}

/** Deliberately constrained measurement points; neither prompt can leak an answer. */
export function productLifeUserTextSchema(turn: number) {
  const probe = productLifeRecallProbe(turn);
  return z
    .object({
      text: probe ? z.enum(probe.questions) : z.string().trim().min(1).max(800),
    })
    .strict();
}

export function productLifeRecallProbe(turn: number):
  | {
      kind: "weekday_recall" | "open_recall";
      questions: [string, string, ...string[]];
    }
  | undefined {
  if (turn === 33)
    return {
      kind: "weekday_recall",
      questions: [
        "顾澜，你还记得我后来更正的画画安排是每周哪一天吗？",
        "之前那个画画的星期安排，我后来更正过。你还记得改成哪天了吗？",
      ],
    };
  if (turn === 36)
    return {
      kind: "open_recall",
      questions: [
        "顾澜，好久不见。你还记得我们上次聊到哪里吗？",
        "好久没来了。顾澜，你还记得我们上一次聊的是什么吗？",
      ],
    };
  return undefined;
}

/** Narrow deterministic guard. Passing it is not a semantic quality verdict. */
export function inspectProductLifeUserText(
  text: string,
  userName = PRODUCT_LIFE_USER_NAME,
): string[] {
  const escaped = userName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const selfAddress = new RegExp(
    `(?:^|[。！？!?\\n])\\s*${escaped}\\s*[，,：:]\\s*(?:你|别|我|好|这|回|那)`,
    "u",
  );
  const speakerLabel = new RegExp(
    `(?:^|\\n)\\s*(?:顾澜|assistant|角色)\\s*[:：]`,
    "iu",
  );
  return [
    ...(selfAddress.test(text) ? ["simulated_user_addresses_own_name"] : []),
    ...(speakerLabel.test(text)
      ? ["simulated_user_writes_character_dialogue"]
      : []),
  ];
}

function shanghaiTime(value: string): string {
  return `${new Date(Date.parse(value) + 8 * 3600000).toISOString().replace("Z", "+08:00")}`;
}
