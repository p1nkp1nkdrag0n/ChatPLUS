import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { RotateCcw, X } from "lucide-react";
import { achievementsApi } from "../../api/achievements";
import { achievementQueryKeys } from "../../hooks/useAchievements";
import { ErrorBlock, LoadingBlock } from "../Feedback";
import { AchievementBadge } from "./AchievementBadge";
import { achievementDate, badgeStatusLabel } from "./achievementPresentation";

export function AchievementDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: achievementQueryKeys.detail(id),
    queryFn: () => achievementsApi.get(id),
  });
  const retry = useMutation({
    mutationFn: () => achievementsApi.retryBadge(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: achievementQueryKeys.all,
      });
    },
  });
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const item = query.data;
  const status = item ? badgeStatusLabel(item.badge.status) : undefined;
  return (
    <dialog
      className="achievement-dialog"
      ref={dialog}
      aria-labelledby="achievement-detail-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="achievement-dialog__content">
        <button
          type="button"
          className="achievement-icon-button achievement-dialog__close"
          aria-label="关闭成就详情"
          onClick={onClose}
          autoFocus
        >
          <X size={21} />
        </button>
        {query.isPending ? <LoadingBlock label="正在打开这枚纪念…" /> : null}
        {query.error ? <ErrorBlock error={query.error} /> : null}
        {item ? (
          <>
            <AchievementBadge achievement={item} large />
            <p className="achievement-dialog__eyebrow">
              {item.agentName ? `与 ${item.agentName} 的纪念` : "我的足迹"}
            </p>
            <h2 id="achievement-detail-title">{item.title}</h2>
            <p className="achievement-dialog__description">
              {item.description}
            </p>
            <time dateTime={item.unlockedAtUtc}>
              {achievementDate(item.unlockedAtUtc)} · 收入收藏
            </time>
            {status ? (
              <div className="achievement-dialog__drawing">
                <p>{status}。这枚纪念已经属于你。</p>
                {item.badge.status === "failed" ? (
                  <div className="achievement-dialog__actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate()}
                    >
                      <RotateCcw size={15} />
                      {retry.isPending ? "正在安排…" : "重新绘制"}
                    </button>
                    <Link
                      to="/settings"
                      className="text-link"
                      onClick={onClose}
                    >
                      生图设置
                    </Link>
                  </div>
                ) : item.badge.status === "pending" ? (
                  <Link to="/settings" className="text-link" onClick={onClose}>
                    生图设置
                  </Link>
                ) : null}
              </div>
            ) : null}
            {retry.error ? <ErrorBlock error={retry.error} /> : null}
          </>
        ) : null}
      </div>
    </dialog>
  );
}
