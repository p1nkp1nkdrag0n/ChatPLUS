import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { achievementsApi, type AchievementFilters } from "../api/achievements";

export const achievementQueryKeys = {
  all: ["achievements"] as const,
  list: (filters: AchievementFilters) =>
    ["achievements", "list", filters] as const,
  detail: (id: string) => ["achievements", "detail", id] as const,
  notifications: ["achievements", "notifications"] as const,
  imageSettings: ["achievement-image", "settings"] as const,
};

export function useAchievements(filters: AchievementFilters) {
  return useQuery({
    queryKey: achievementQueryKeys.list(filters),
    queryFn: () => achievementsApi.list(filters),
  });
}

export function isAppForeground(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

// Shared by first-open, foreground returns and midnight polling; never accepts a
// client date. The server owns calendar boundaries and cross-tab deduplication.
export function startForegroundActivity(options: {
  visit: () => Promise<unknown>;
  refresh: () => void;
  onForeground: (foreground: boolean) => void;
  document: Pick<
    Document,
    "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener"
  >;
  window: Pick<
    Window,
    "addEventListener" | "removeEventListener" | "setInterval" | "clearInterval"
  >;
}): () => void {
  let disposed = false;
  let pending = false;
  const check = () => {
    const foreground =
      options.document.visibilityState === "visible" &&
      options.document.hasFocus();
    options.onForeground(foreground);
    if (!foreground || pending || disposed) return;
    pending = true;
    void options
      .visit()
      .then(() => {
        if (!disposed) options.refresh();
      })
      .catch(() => {
        // Reconnection, the next foreground event or minute will retry the visit.
      })
      .finally(() => {
        pending = false;
      });
  };
  options.document.addEventListener("visibilitychange", check);
  options.window.addEventListener("focus", check);
  options.window.addEventListener("blur", check);
  options.window.addEventListener("online", check);
  const interval = options.window.setInterval(check, 60_000);
  check();
  return () => {
    disposed = true;
    options.document.removeEventListener("visibilitychange", check);
    options.window.removeEventListener("focus", check);
    options.window.removeEventListener("blur", check);
    options.window.removeEventListener("online", check);
    options.window.clearInterval(interval);
  };
}

/** Mount exactly once above the route shell, including landing/welcome routes. */
export function useAchievementActivity(): boolean {
  const queryClient = useQueryClient();
  const [foreground, setForeground] = useState(isAppForeground);
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: achievementQueryKeys.all,
      });
    };
    return startForegroundActivity({
      visit: achievementsApi.visit,
      refresh,
      onForeground: setForeground,
      document,
      window,
    });
  }, [queryClient]);
  useEffect(() => {
    const source = new EventSource("/api/achievements/events");
    const refresh = () => {
      void queryClient.invalidateQueries({
        queryKey: achievementQueryKeys.all,
      });
    };
    source.addEventListener("achievements.changed", refresh);
    source.addEventListener("ready", refresh);
    source.onopen = refresh;
    return () => {
      source.close();
    };
  }, [queryClient]);
  return foreground;
}
