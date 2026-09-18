export type ApiKeyNoticeOrigin = "setup" | "model-settings" | "settings";

export function apiKeyNoticePath(origin: ApiKeyNoticeOrigin): string {
  return `/api-key-notice?from=${origin}`;
}

export function apiKeyNoticeOrigin(
  search: string,
  hosted: boolean,
): ApiKeyNoticeOrigin {
  const requested = new URLSearchParams(search).get("from");
  if (hosted && (requested === "setup" || requested === "model-settings"))
    return requested;
  return requested === "settings" || !hosted ? "settings" : "setup";
}

export function hasAcceptedApiKeyNotice(
  state: unknown,
  origin: ApiKeyNoticeOrigin,
): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    "apiKeyNoticeAccepted" in state &&
    state.apiKeyNoticeAccepted === origin
  );
}
