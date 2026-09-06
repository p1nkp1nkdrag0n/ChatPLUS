import { normalizeText } from "./shared.js";

/** Generic distress words cannot move a practice from work to family or another topic. */
export function matchesConversationTopic(
  topic: string,
  currentText: string,
): boolean {
  const anchor = normalizeText(topic)
    .replace(/(?:烦恼|挫折|压力|问题|相关|事情|感受|关系|方面|的)/gu, "")
    .trim();
  if (anchor.length < 2) return false;
  const current = normalizeText(currentText);
  return /\p{Script=Han}/u.test(anchor)
    ? current.includes(anchor)
    : ` ${current} `.includes(` ${anchor} `);
}
