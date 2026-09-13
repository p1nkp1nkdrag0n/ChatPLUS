import { createUuid } from "./uuid";

let csrfToken: string | undefined;
let hosted = false;

export const HOSTED_SESSION_EXPIRED = "dearvale:hosted-session-expired";

export function configureHostedSession(enabled: boolean, token?: string): void {
  hosted = enabled;
  csrfToken = enabled ? token : undefined;
}

export function hostedRequestHeaders(
  method = "GET",
  input?: unknown,
): Record<string, string> {
  if (
    !hosted ||
    !csrfToken ||
    ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
  )
    return {};
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = undefined;
    }
  }
  const record =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const requestId = record["clientMessageId"] ?? record["requestId"];
  return {
    "X-CSRF-Token": csrfToken,
    "Idempotency-Key": typeof requestId === "string" ? requestId : createUuid(),
  };
}

export function notifyHostedSessionExpired(path: string, status: number): void {
  if (
    hosted &&
    status === 401 &&
    !path.startsWith("/api/hosted/auth/") &&
    path !== "/api/hosted/me"
  ) {
    window.dispatchEvent(new Event(HOSTED_SESSION_EXPIRED));
  }
}

/** Browser conveniences must not carry another participant's draft into a login. */
export function resetHostedLocalState(userId?: string): void {
  try {
    const previous = localStorage.getItem("dearvale.hosted-user.v1");
    if (previous !== userId) {
      for (const key of [
        "personasim.active-character.v1",
        "dearvale.last-conversation.v1",
        "dearvale.character-interview.v1",
      ])
        localStorage.removeItem(key);
    }
    if (userId) localStorage.setItem("dearvale.hosted-user.v1", userId);
    else localStorage.removeItem("dearvale.hosted-user.v1");
  } catch {
    // Private browsing can disable storage; server ownership remains authoritative.
  }
}
