import type {
  KeepsakeDetailResponse,
  KeepsakeStatus,
  OpenLetterResponse,
} from "@personasim/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CachedLetterDetail, LetterRevealPhase } from "./correspondence";
import { relationshipArchiveQueryKeys } from "./relationshipArchive";

export function keepsakeStatusLabel(status: KeepsakeStatus): string {
  switch (status) {
    case "pending":
      return "专属图案等待绘制";
    case "generating":
      return "专属图案正在绘制";
    case "failed":
      return "专属图案暂未完成";
    case "ready":
      return "专属图案已完成";
  }
}

export function keepsakeStatusDescription(status: KeepsakeStatus): string {
  if (status === "ready") return "这件纪念物已收入你的陈列柜。";
  if (status === "failed") {
    return "这次未能完成专属图案，纪念物和它的来历已为你保存。";
  }
  return "这件纪念物已经属于你，专属图案完成后会在这里补全。可以继续阅读或聊天。";
}

/** A bounded, foreground-only fallback when an SSE update is missed. */
export function keepsakePollInterval(
  statuses: readonly KeepsakeStatus[],
  updateCount: number,
  failureCount: number,
): number | false {
  return updateCount < 60 &&
    failureCount < 2 &&
    statuses.some((status) => status === "pending" || status === "generating")
    ? 5_000
    : false;
}

export function keepsakeDetailQueryOptions(keepsakeId: string) {
  return queryOptions({
    queryKey: relationshipArchiveQueryKeys.keepsake(keepsakeId),
    queryFn: (): Promise<KeepsakeDetailResponse> =>
      api.keepsakes.get(keepsakeId),
    enabled: Boolean(keepsakeId),
    refetchInterval: (query) =>
      keepsakePollInterval(
        query.state.data ? [query.state.data.keepsake.status] : [],
        query.state.dataUpdateCount,
        query.state.fetchFailureCount,
      ),
    refetchIntervalInBackground: false,
  });
}

/** Attachment metadata is usable only within a successfully opened reader. */
export function openedLetterKeepsakeIds(
  detail: CachedLetterDetail | undefined,
  opened: OpenLetterResponse | undefined,
  phase: LetterRevealPhase,
): string[] {
  if (
    !detail ||
    !opened ||
    phase !== "reading" ||
    detail.letter.id !== opened.letter.id ||
    detail.letter.direction !== "agent_to_user" ||
    opened.letter.direction !== "agent_to_user" ||
    opened.letter.status !== "read"
  ) {
    return [];
  }
  const refreshedIds =
    detail.letter.status === "read" && "relatedKeepsakeIds" in detail
      ? (detail.relatedKeepsakeIds ?? [])
      : [];
  return [...new Set([...opened.relatedKeepsakeIds, ...refreshedIds])];
}
