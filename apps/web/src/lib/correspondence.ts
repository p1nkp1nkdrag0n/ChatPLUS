import type {
  CorrespondenceMailboxResponse,
  LetterDetailResponse,
  LetterStatus,
  LetterSummaryResponse,
} from "@personasim/contracts";
import { DateTime } from "luxon";

export type MailboxFilter = "all" | "inbox" | "transit" | "sent" | "archive";

export interface CachedAgentLetterDetail {
  letter: Omit<LetterSummaryResponse, "direction"> & {
    direction: "agent_to_user";
  };
}

export interface CachedUserLetterDetail {
  letter: Omit<LetterSummaryResponse, "direction"> & {
    direction: "user_to_agent";
  };
  subject?: string;
  body: string;
}

export type CachedLetterDetail =
  CachedAgentLetterDetail | CachedUserLetterDetail;

export function isCachedUserLetterDetail(
  detail: CachedLetterDetail,
): detail is CachedUserLetterDetail {
  return detail.letter.direction === "user_to_agent";
}

export const correspondenceQueryKeys = {
  mailbox: (agentId: string) => ["correspondence", agentId] as const,
  mailboxPages: (agentId: string) =>
    ["correspondence", agentId, "pages"] as const,
  letter: (letterId: string) => ["letter", letterId] as const,
  temporalTasks: (agentId: string) => ["temporal-tasks", agentId] as const,
};

export function mergeCorrespondenceMailboxPages(
  pages: readonly CorrespondenceMailboxResponse[],
): CorrespondenceMailboxResponse | undefined {
  const firstPage = pages[0];
  const lastPage = pages.at(-1);
  if (firstPage === undefined || lastPage === undefined) return undefined;

  const threads = new Map(
    pages.flatMap((page) => page.threads).map((thread) => [thread.id, thread]),
  );
  const letters = new Map(
    pages.flatMap((page) => page.letters).map((letter) => [letter.id, letter]),
  );
  return {
    threads: [...threads.values()],
    letters: [...letters.values()],
    serverTimeUtc: lastPage.serverTimeUtc,
    ...(lastPage.nextCursor === undefined
      ? {}
      : { nextCursor: lastPage.nextCursor }),
  };
}

export type ComposeAvailability =
  { kind: "new" } | { kind: "edit"; draftId: string } | { kind: "waiting" };

export function composeAvailability(
  mailbox: CorrespondenceMailboxResponse | undefined,
): ComposeAvailability {
  if (!mailbox) return { kind: "waiting" };
  const openThread = mailbox.threads.find((thread) => thread.status === "open");
  if (!openThread) return { kind: "new" };
  const threadLetters = mailbox.letters.filter(
    (letter) => letter.threadId === openThread.id,
  );
  const draft = threadLetters.find(
    (letter) =>
      letter.direction === "user_to_agent" && letter.status === "draft",
  );
  if (draft) return { kind: "edit", draftId: draft.id };
  const latest =
    threadLetters.find((letter) => letter.id === openThread.latestLetterId) ??
    findThreadLetters(mailbox, openThread.id).at(-1);
  if (!latest) return { kind: "new" };
  return latest.direction === "agent_to_user" && latest.status === "read"
    ? { kind: "new" }
    : { kind: "waiting" };
}

/**
 * The ordinary detail endpoint may return plaintext for an already-opened
 * agent reply. Query functions must pass through this projection so that the
 * full reply can never enter React Query's persistent cache.
 */
export function projectLetterDetailForCache(
  detail: LetterDetailResponse,
): CachedLetterDetail {
  if (detail.letter.direction === "agent_to_user") {
    return {
      letter: {
        ...detail.letter,
        direction: "agent_to_user",
      },
    };
  }

  return {
    letter: {
      ...detail.letter,
      direction: "user_to_agent",
    },
    ...(detail.subject === undefined ? {} : { subject: detail.subject }),
    body: detail.body ?? "",
  };
}

export function filterMailboxLetters(
  letters: readonly LetterSummaryResponse[],
  filter: MailboxFilter,
): LetterSummaryResponse[] {
  const filtered = letters.filter((letter) => {
    switch (filter) {
      case "inbox":
        return (
          letter.direction === "agent_to_user" &&
          (letter.status === "delivered_unread" || letter.status === "read")
        );
      case "transit":
        return letter.status === "sealed" || letter.status === "in_transit";
      case "sent":
        return (
          letter.direction === "user_to_agent" && letter.status !== "draft"
        );
      case "archive":
        return letter.status === "read" || letter.status === "cancelled";
      case "all":
        return true;
    }
  });

  return filtered.toSorted(
    (left, right) =>
      right.authoredDisplayDate.localeCompare(left.authoredDisplayDate) ||
      right.id.localeCompare(left.id),
  );
}

export function findThreadLetters(
  mailbox: CorrespondenceMailboxResponse,
  threadId: string,
): LetterSummaryResponse[] {
  return mailbox.letters
    .filter((letter) => letter.threadId === threadId)
    .toSorted(
      (left, right) =>
        left.authoredDisplayDate.localeCompare(right.authoredDisplayDate) ||
        left.id.localeCompare(right.id),
    );
}

export interface TransitPresentation {
  progress: number;
  statusLabel: string;
  dispatchedLabel?: string;
  arrivalLabel?: string;
  dayLabel?: string;
}

export function transitPresentation(
  letter: LetterSummaryResponse,
  serverTimeUtc: string,
  locale = "zh-CN",
  timezone = "UTC",
): TransitPresentation {
  const dispatched = parseUtc(letter.dispatchedAtUtc);
  const arrival = parseUtc(letter.arrivalDueAtUtc);
  const now = parseUtc(serverTimeUtc);
  const progress = dateProgress(dispatched, arrival, now, letter.progress);
  const directionLabel =
    letter.direction === "agent_to_user" ? "回信返程" : "信件在途";

  if (letter.status === "draft") {
    return { progress: 0, statusLabel: "草稿" };
  }
  if (letter.status === "cancelled") {
    return { progress: 0, statusLabel: "已取消" };
  }
  if (letter.status === "delivered_unread") {
    return {
      progress: 1,
      statusLabel: "已抵达，等待启封",
      ...(dispatched
        ? { dispatchedLabel: formatDay(dispatched, locale, timezone) }
        : {}),
      ...(arrival
        ? { arrivalLabel: formatDay(arrival, locale, timezone) }
        : {}),
    };
  }
  if (letter.status === "read") {
    return {
      progress: 1,
      statusLabel: letter.direction === "agent_to_user" ? "已启封" : "对方已读",
      ...(dispatched
        ? { dispatchedLabel: formatDay(dispatched, locale, timezone) }
        : {}),
      ...(arrival
        ? { arrivalLabel: formatDay(arrival, locale, timezone) }
        : {}),
    };
  }

  const elapsedDays =
    dispatched && now
      ? Math.max(1, Math.floor(now.diff(dispatched, "days").days) + 1)
      : 1;
  return {
    progress,
    statusLabel: directionLabel,
    ...(dispatched
      ? { dispatchedLabel: formatDay(dispatched, locale, timezone) }
      : {}),
    ...(arrival ? { arrivalLabel: formatDay(arrival, locale, timezone) } : {}),
    dayLabel: `第 ${elapsedDays} 天`,
  };
}

export function statusLabel(
  status: LetterStatus,
  direction: LetterSummaryResponse["direction"],
): string {
  switch (status) {
    case "draft":
      return "草稿";
    case "sealed":
      return "已封缄";
    case "in_transit":
      return direction === "agent_to_user" ? "正在返程" : "在途中";
    case "delivered_unread":
      return "已抵达，等待启封";
    case "read":
      return direction === "agent_to_user" ? "已归档" : "对方已读";
    case "cancelled":
      return "已取消";
  }
}

export function formatCorrespondenceDate(
  value: string | undefined,
  locale = "zh-CN",
): string {
  if (!value) return "日期待定";
  const date = DateTime.fromISO(value, { zone: "utc" });
  return date.isValid
    ? date.setLocale(locale).toLocaleString({
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : value;
}

export function arrivalEstimateLabel(
  timezone: string,
  now: DateTime = DateTime.utc(),
): string {
  return now
    .setZone(timezone)
    .plus({ days: 5 })
    .setLocale("zh-CN")
    .toLocaleString({ year: "numeric", month: "long", day: "numeric" });
}

export type LetterRevealPhase = "envelope" | "revealing" | "reading";

export function phaseAfterSuccessfulOpen(
  prefersReducedMotion: boolean,
): LetterRevealPhase {
  return prefersReducedMotion ? "reading" : "revealing";
}

function parseUtc(value: string | undefined): DateTime | undefined {
  if (!value) return undefined;
  const parsed = DateTime.fromISO(value, { zone: "utc" });
  return parsed.isValid ? parsed : undefined;
}

function dateProgress(
  dispatched: DateTime | undefined,
  arrival: DateTime | undefined,
  now: DateTime | undefined,
  fallback: number,
): number {
  if (!dispatched || !arrival || !now) return clampProgress(fallback);
  const duration = arrival.toMillis() - dispatched.toMillis();
  if (duration <= 0) return clampProgress(fallback);
  return clampProgress((now.toMillis() - dispatched.toMillis()) / duration);
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatDay(value: DateTime, locale: string, timezone: string): string {
  return value.setZone(timezone).setLocale(locale).toLocaleString({
    month: "long",
    day: "numeric",
  });
}
