import type {
  Achievement,
  AchievementImageSettings,
  AchievementImageSettingsInput,
  AchievementPage,
} from "@personasim/contracts";
import { ApiError } from "./types";

export type AchievementCategory = "all" | "global" | "character";
export interface AchievementFilters {
  category?: AchievementCategory;
  agentId?: string;
  cursor?: string;
  limit?: number;
}

async function request<T>(
  path: string,
  method = "GET",
  input?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      ...(input === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError({
      code: payload.error?.code ?? "HTTP_ERROR",
      message: payload.error?.message ?? `请求失败（${response.status}）`,
      status: response.status,
      issues: [],
    });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const achievementsApi = {
  list: (filters: AchievementFilters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return request<AchievementPage>(`/api/achievements?${query}`);
  },
  get: (id: string) =>
    request<Achievement>(`/api/achievements/${encodeURIComponent(id)}`),
  visit: () =>
    request<{ serverTimeUtc: string }>("/api/activity/visit", "POST", {}),
  acknowledge: async (ids: string[]) => {
    // A long-offline collection can deliver another batch while the first toast
    // is still visible. Respect the server's per-request acknowledgement limit.
    for (let offset = 0; offset < ids.length; offset += 100) {
      await request<void>("/api/achievements/notifications/ack", "POST", {
        ids: ids.slice(offset, offset + 100),
      });
    }
  },
  retryBadge: (id: string) =>
    request<Achievement>(
      `/api/achievements/${encodeURIComponent(id)}/badge/retry`,
      "POST",
      {},
    ),
  imageSettings: () =>
    request<AchievementImageSettings>("/api/achievement-image/settings"),
  saveImageSettings: (input: AchievementImageSettingsInput) =>
    request<AchievementImageSettings>(
      "/api/achievement-image/settings",
      "PUT",
      input,
    ),
  testImageSettings: () =>
    request<{ success: boolean; message?: string }>(
      "/api/achievement-image/test",
      "POST",
      {},
    ),
};
