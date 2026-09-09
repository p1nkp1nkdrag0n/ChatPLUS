/** Checks for visible content without changing text or breaking emoji/ZWJ sequences. */
export function hasVisibleText(value: string): boolean {
  // Marks alone (including variation selectors) do not establish a visible reply.
  return value.replace(/[\p{Z}\p{Cc}\p{Cf}\p{M}]/gu, "").length > 0;
}
