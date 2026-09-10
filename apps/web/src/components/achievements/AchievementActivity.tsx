import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import type { Achievement } from "@personasim/contracts";
import { achievementsApi } from "../../api/achievements";
import {
  achievementQueryKeys,
  isAppForeground,
  useAchievementActivity,
} from "../../hooks/useAchievements";
import { AchievementBadge } from "./AchievementBadge";

export function AchievementActivity() {
  const foreground = useAchievementActivity();
  const queryClient = useQueryClient();
  const seen = useRef(new Set<string>());
  const [displayed, setDisplayed] = useState<Achievement[]>([]);
  const query = useQuery({
    queryKey: achievementQueryKeys.notifications,
    queryFn: () => achievementsApi.list({ limit: 1 }),
    enabled: foreground,
    refetchOnWindowFocus: true,
    refetchInterval: foreground ? 60_000 : false,
  });
  const acknowledge = useMutation({
    mutationFn: achievementsApi.acknowledge,
    retry: 2,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: achievementQueryKeys.all,
      });
    },
  });
  const acknowledgeRef = useRef(acknowledge.mutate);
  acknowledgeRef.current = acknowledge.mutate;
  useEffect(() => {
    if (!foreground) return;
    const fresh =
      query.data?.notifications.filter(
        (item) => !item.notificationRead && !seen.current.has(item.id),
      ) ?? [];
    if (!fresh.length) return;
    for (const item of fresh) seen.current.add(item.id);
    setDisplayed((previous) => [...previous, ...fresh]);
  }, [query.data, foreground]);
  useEffect(() => {
    if (!foreground || !displayed.length) return;
    // Only acknowledge after the toast was actually rendered in the foreground.
    const acknowledgement = window.setTimeout(() => {
      if (isAppForeground())
        acknowledgeRef.current(displayed.map((item) => item.id));
    }, 800);
    const dismissal = window.setTimeout(() => setDisplayed([]), 9_000);
    return () => {
      window.clearTimeout(acknowledgement);
      window.clearTimeout(dismissal);
    };
  }, [displayed, foreground]);
  const first = displayed[0];
  if (!foreground || !first) return null;
  const dismiss = () => {
    acknowledge.mutate(displayed.map((item) => item.id));
    setDisplayed([]);
  };
  return (
    <aside
      className="achievement-toast"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <AchievementBadge achievement={first} />
      <Link
        to={
          displayed.length === 1
            ? `/achievements?achievement=${encodeURIComponent(first.id)}`
            : "/achievements"
        }
        onClick={dismiss}
      >
        <span>
          获得新成就
          {displayed.length > 1 ? ` · ${displayed.length} 枚纪念` : ""}
        </span>
        <strong>
          {displayed.length === 1
            ? first.title
            : displayed
                .slice(0, 2)
                .map((item) => item.title)
                .join("、")}
        </strong>
        <small>打开成就收藏</small>
      </Link>
      <button
        type="button"
        className="achievement-icon-button"
        aria-label="关闭成就提示"
        onClick={dismiss}
      >
        <X size={17} />
      </button>
    </aside>
  );
}
