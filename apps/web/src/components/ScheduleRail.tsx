import { Check, Circle, Sparkles } from "lucide-react";
import type { ScheduleItem } from "../api/types";
import { formatLocalTime } from "../lib/date";

export function ScheduleRail({
  items,
  timezone,
  compact = false,
}: {
  items: ScheduleItem[];
  timezone: string;
  compact?: boolean;
}) {
  if (items.length === 0) {
    return <p className="schedule-empty">未来 24 小时没有已承诺的活动。</p>;
  }
  return (
    <ol className={`schedule-rail${compact ? " schedule-rail--compact" : ""}`}>
      {items.map((item) => (
        <li
          key={item.id}
          className={`schedule-item schedule-item--${item.status}${item.source === "user_invitation" ? " is-user-invitation" : ""}`}
        >
          <time>{formatLocalTime(item.startAtUtc, timezone)}</time>
          <span className="schedule-item__node" aria-hidden="true">
            {item.status === "completed" ? (
              <Check size={12} />
            ) : (
              <Circle size={10} />
            )}
          </span>
          <div>
            <strong>{item.title}</strong>
            <span>{item.description || labelForStatus(item.status)}</span>
          </div>
          {item.source === "user_invitation" ? (
            <span className="schedule-item__change">
              <Sparkles size={12} /> 新安排
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function labelForStatus(status: ScheduleItem["status"]): string {
  return {
    planned: "计划中",
    in_progress: "正在进行",
    completed: "已完成",
    partial: "部分完成",
    skipped: "已跳过",
    cancelled: "已取消",
  }[status];
}
