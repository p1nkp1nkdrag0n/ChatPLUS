import type { Achievement } from "@personasim/contracts";

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function badgeStatusLabel(
  status: Achievement["badge"]["status"],
): string | undefined {
  if (status === "pending") return "专属图案等待绘制";
  if (status === "generating") return "专属图案绘制中";
  if (status === "failed") return "专属图案暂未完成";
  return undefined;
}

export function achievementDate(value: string): string {
  return dateFormat.format(new Date(value));
}
