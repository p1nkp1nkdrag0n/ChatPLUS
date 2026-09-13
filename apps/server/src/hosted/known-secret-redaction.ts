/** Redacts only explicitly configured credentials, preserving unrelated data.
 * JSON is decoded before matching so escaped credentials cannot bypass the
 * check. Unchanged input is returned byte-for-byte, including signed URLs.
 * This helper has no logging, storage or mutation side effects.
 */
export function redactKnownSecrets(
  text: string,
  secrets: readonly string[],
): string {
  const known = [
    ...new Set(secrets.filter((secret) => secret.length > 0)),
  ].sort((left, right) => right.length - left.length);
  if (!known.length) return text;
  const marker = known.some((secret) => "[REDACTED_API_KEY]".includes(secret))
    ? ""
    : "[REDACTED_API_KEY]";
  const replace = (value: string) =>
    known.reduce((result, secret) => result.split(secret).join(marker), value);
  const assertDepth = (depth: number) => {
    if (depth > 128)
      throw new Error(
        "Response nesting exceeds the safe credential-redaction limit.",
      );
  };
  const visit = (value: unknown, depth: number): unknown => {
    assertDepth(depth);
    if (typeof value === "string") return redactText(replace(value), depth + 1);
    if (Array.isArray(value)) {
      const next: unknown[] = value.map((child) => visit(child, depth + 1));
      return next.some((child, index) => child !== value[index]) ? next : value;
    }
    if (value && typeof value === "object") {
      let changed = false;
      const entries = Object.entries(value).map(
        ([key, child]: [string, unknown]) => {
          const nextKey = replace(key);
          const nextValue = visit(child, depth + 1);
          if (nextKey !== key || nextValue !== child) changed = true;
          return [nextKey, nextValue];
        },
      );
      return changed ? Object.fromEntries(entries) : value;
    }
    return value;
  };
  const redactText = (value: string, depth: number): string => {
    assertDepth(depth);
    // Image responses can contain tens of MiB of base64. No literal match and
    // no JSON escape means there is no credential to decode or copy here.
    if (
      !known.some((secret) => value.includes(secret)) &&
      !value.includes("\\")
    )
      return value;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return replace(value);
    }
    // Keep traversal outside the parse catch: a resource failure must not
    // silently fall back to persisting unredacted, escaped JSON credentials.
    const redacted = visit(parsed, depth + 1);
    return redacted === parsed ? value : JSON.stringify(redacted);
  };
  return redactText(text, 0);
}
