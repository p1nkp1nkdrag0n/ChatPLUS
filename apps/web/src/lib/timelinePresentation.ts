import type { TimelineEvent } from "../api/types";

const ACTIVITY_EVENT_TITLES: Record<string, string> = {
  started: "一段经历开始了",
  completed: "一段经历有了结果",
  partial: "一段经历取得了部分进展",
  skipped: "一项原本想做的事没有继续",
  cancelled: "一项原本想做的事发生了变化",
};

export function timelineEventTitle(event: TimelineEvent): string {
  if (event.scheduleItemId) {
    return ACTIVITY_EVENT_TITLES[event.type] ?? "一段生活经历发生了变化";
  }
  return event.title;
}
