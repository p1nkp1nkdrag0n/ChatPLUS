import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Achievement } from "@personasim/contracts";
import { AchievementCard } from "./AchievementBadge";
import { achievementDate } from "./achievementPresentation";

const achievement: Achievement = {
  id: "earned-1",
  title: "岁月的回声",
  description: "每一段相处，都被温柔珍藏。",
  category: "character",
  agentId: "agent-1",
  agentName: "林间",
  unlockedAtUtc: "2026-09-10T16:30:00.000Z",
  badge: { key: "flower", status: "pending" },
  notificationRead: false,
};

describe("achievement collection presentation", () => {
  it("shows the earned keepsake and Shanghai date without rendering private state or progress", () => {
    const enriched = {
      ...achievement,
      closeness: 0.9,
      target: 1,
      stage: "close_friend",
      evidence: "private",
    };
    const markup = renderToStaticMarkup(
      <AchievementCard achievement={enriched} onSelect={() => undefined} />,
    );
    expect(markup).toContain("岁月的回声");
    expect(markup).toContain("与 林间");
    expect(markup).toContain("2026年9月11日");
    expect(markup).toContain("专属图案等待绘制");
    for (const hidden of [
      "closeness",
      "target",
      "close_friend",
      "private",
      "progress",
      "好感度",
      "下一档",
    ])
      expect(markup).not.toContain(hidden);
  });

  it("keeps earned achievement copy visible when image generation fails", () => {
    const markup = renderToStaticMarkup(
      <AchievementCard
        achievement={{
          ...achievement,
          badge: { key: "flower", status: "failed" },
        }}
        onSelect={() => undefined}
      />,
    );
    expect(markup).toContain("岁月的回声");
    expect(markup).toContain("专属图案暂未完成");
    expect(markup).toContain("<svg");
  });

  it("uses generated thumbnails once ready and never renders an unknown clock label", () => {
    const markup = renderToStaticMarkup(
      <AchievementCard
        achievement={{
          ...achievement,
          badge: {
            key: "flower",
            status: "ready",
            imageUrl: "/api/achievement-assets/full.webp",
            thumbnailUrl: "/api/achievement-assets/thumb.webp",
          },
        }}
        onSelect={() => undefined}
      />,
    );
    expect(markup).toContain('src="/api/achievement-assets/thumb.webp"');
    expect(markup).not.toContain("等待绘制");
    expect(achievementDate("2026-12-31T16:00:00.000Z")).toBe("2027年1月1日");
  });
});
