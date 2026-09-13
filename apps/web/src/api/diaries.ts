import {
  DiaryEntrySchema,
  DiaryVolumeSchema,
  type DiaryEntry,
  type DiaryVolume,
  type GenerateDiaryInput,
} from "@personasim/contracts";
import { z } from "zod";
import { request } from "./client";
import { ApiError } from "./types";

export type { DiaryEntry, DiaryVolume, GenerateDiaryInput };

export const diaryQueryKeys = {
  all: ["diaries"] as const,
  volumes: () => ["diaries", "volumes"] as const,
  entries: (agentId: string, month: string) =>
    ["diaries", "entries", agentId, month] as const,
};

export const diariesApi = {
  async volumes(
    input: { agentId?: string; year?: number; month?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (input.agentId) query.set("agentId", input.agentId);
    if (input.year !== undefined) query.set("year", String(input.year));
    if (input.month !== undefined) query.set("month", String(input.month));
    const suffix = query.size ? `?${query}` : "";
    return z
      .object({ volumes: z.array(DiaryVolumeSchema) })
      .parse(await request<unknown>(`/api/diaries/volumes${suffix}`));
  },
  async entries(agentId: string, month: string) {
    return z
      .object({ entries: z.array(DiaryEntrySchema) })
      .parse(
        await request<unknown>(
          `/api/agents/${encodeURIComponent(agentId)}/diaries?month=${encodeURIComponent(month)}`,
        ),
      );
  },
  async generate(agentId: string, input: GenerateDiaryInput) {
    return z.object({ entry: DiaryEntrySchema }).parse(
      await request<unknown>(
        `/api/agents/${encodeURIComponent(agentId)}/diaries`,
        {
          method: "POST",
          body: JSON.stringify(input),
        },
      ),
    );
  },
};

export function diaryErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "暂时没能完成，请稍后再试。";
  const messages: Record<string, string> = {
    diary_no_material: "这一天还没有可以写进手记的聊天。选一个聊过天的日子吧。",
    diary_too_much_material:
      "这一天的聊天较长，暂时无法整理成手记。原有日记会保留。",
    diary_generation_in_progress: "这一天的手记正在整理中，请稍后再来翻阅。",
    diary_revision_conflict: "这篇手记已有更新，已重新读取。请确认后再整理。",
    diary_source_changed: "整理期间聊天发生了变化，请重新整理一次。",
    diary_timezone_conflict: "这篇手记的日期归属已有记录，请重新读取后再整理。",
    diary_request_conflict: "这次请求已有处理记录，请重新读取手记后再试。",
    diary_generation_invalid:
      "这次没有整理出合适的手记，可以稍后再试。原有日记会保留。",
    diary_generation_failed:
      "暂时没能写好这篇手记，请稍后再试。原有日记会保留。",
  };
  return (
    messages[error.code] ??
    (error.status === 400
      ? "请检查角色和日期，再试一次。"
      : "暂时无法读取或整理手记，请稍后再试。")
  );
}

export function localDiaryDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function diaryTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
