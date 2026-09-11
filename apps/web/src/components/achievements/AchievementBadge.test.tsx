import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Achievement } from "@personasim/contracts";
import { AchievementBadge, AchievementCard } from "./AchievementBadge";
import { achievementDate } from "./achievementPresentation";

const achievement: Achievement = {
  id: "earned-1",
  title: "独一份纪念",
  description: "这一份纪念，只属于你们的故事。",
  category: "character",
  agentId: "agent-1",
  agentName: "林间",
  unlockedAtUtc: "2026-09-10T16:30:00.000Z",
  badge: { key: "star", status: "pending" },
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
    expect(markup).toContain("独一份纪念");
    expect(markup).toContain("与 林间");
    expect(markup).toContain("2026年9月11日");
    expect(markup).toContain("专属图案等待绘制");
    expect(markup).toContain(
      'src="/dearvale/achievements/wax-v2/star.thumb.webp"',
    );
    expect(markup).toContain('data-wax-tier="5"');
    expect(markup).toContain("achievement-card__seal");
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
          badge: { key: "constellation", status: "failed" },
        }}
        onSelect={() => undefined}
      />,
    );
    expect(markup).toContain("独一份纪念");
    expect(markup).toContain("专属图案暂未完成");
    expect(markup).toContain(
      'src="/dearvale/achievements/wax-v2/constellation.thumb.webp"',
    );
    expect(markup).toContain('data-wax-tier="6"');
  });

  it("uses generated thumbnails once ready and never renders an unknown clock label", () => {
    const markup = renderToStaticMarkup(
      <AchievementCard
        achievement={{
          ...achievement,
          badge: {
            key: "star",
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

  it("keeps the active custom image during repaint and uses the full image in details", () => {
    const markup = renderToStaticMarkup(
      <AchievementBadge
        achievement={{
          ...achievement,
          badge: {
            key: "star",
            status: "generating",
            imageUrl: "/api/achievement-assets/full.webp?v=old-hash",
            thumbnailUrl: "/api/achievement-assets/thumb.webp?v=old-hash",
          },
        }}
        large
      />,
    );
    expect(markup).toContain(
      'src="/api/achievement-assets/full.webp?v=old-hash"',
    );
    expect(markup).toContain('loading="eager"');
  });

  it("renders fixed achievements with the matching complete wax asset", () => {
    const markup = renderToStaticMarkup(
      <AchievementBadge
        achievement={{
          ...achievement,
          badge: { key: "door", status: "fixed" },
        }}
      />,
    );
    expect(markup).toContain(
      'src="/dearvale/achievements/wax-v2/door.thumb.webp"',
    );
    expect(markup).toContain('data-wax-tier="1"');
    expect(markup).not.toContain("achievement-badge__ring");
  });
});
