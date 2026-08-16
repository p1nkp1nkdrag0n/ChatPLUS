/** Return an RFC 3339 UTC instant with a fixed three-digit millisecond field. */
export function canonicalUtc(value: string): string {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds))
    throw new TypeError("Expected a valid UTC instant.");
  return new Date(milliseconds).toISOString();
}

export function compareUtc(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}
