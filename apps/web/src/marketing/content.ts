import copy from "../../../../docs/design/early-summer/copy.zh-CN.json";

export const content = copy;
export const art = "/art/early-summer";

// No endpoint probing: a host may explicitly configure an app destination.
export function getStartDestination(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "/start";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    /* An absent or invalid host setting uses the local guide. */
  }
  return "/start";
}
