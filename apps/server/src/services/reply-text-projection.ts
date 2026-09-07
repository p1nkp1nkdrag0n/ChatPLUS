/** Inspect the complete utterance first so quotes/negations keep their scope.
 * Only then remove complete sentences intersecting rejected absolute spans. */
export function projectReplySentences(
  text: string,
  spans: readonly { start: number; end: number }[],
) {
  const removed: Array<{ text: string; start: number; end: number }> = [];
  const retained: string[] = [];
  for (const match of text.matchAll(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    if (spans.some((span) => span.start < end && span.end > start)) {
      removed.push({ text: match[0], start, end });
    } else retained.push(match[0]);
  }
  return { text: retained.join("").trim(), removed };
}
