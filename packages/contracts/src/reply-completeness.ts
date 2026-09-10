/** Detect one unambiguous incomplete canonical reply without treating arbitrary
 * optional chunk differences as a reason to reject otherwise valid text. */
export function hasIncompleteSequentialReplyText(reply: {
  text: string;
  deliveryMode?: "single_block" | "sequential" | undefined;
  chunks?: readonly string[] | undefined;
}): boolean {
  if (reply.deliveryMode !== "sequential" || (reply.chunks?.length ?? 0) < 2)
    return false;
  const normalize = (value: string) => value.replace(/\r\n?/gu, "\n").trim();
  const text = normalize(reply.text);
  const chunks = reply.chunks!.map(normalize);
  return (
    text !== "" &&
    chunks[0] === text &&
    chunks.slice(1).some((chunk) => chunk !== "" && !text.includes(chunk))
  );
}

export const COMPLETE_REPLY_TEXT_REFINEMENT = {
  path: ["text"],
  message:
    "INCOMPLETE_CANONICAL_REPLY_TEXT: text contains only the first sequential chunk. Return the complete reply in text; optional chunks must faithfully preserve that complete text.",
};
