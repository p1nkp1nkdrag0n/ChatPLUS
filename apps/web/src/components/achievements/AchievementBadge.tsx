import {
  Flower2,
  DoorOpen,
  CalendarDays,
  TreePine,
  Orbit,
  Feather,
  Leaf,
  Radio,
  MailOpen,
  Mailbox,
  Footprints,
  Heart,
  Mail,
  MessageCircle,
  Sparkles,
  Sprout,
  Star,
  Sun,
  UserRound,
} from "lucide-react";
import type { Achievement } from "@personasim/contracts";
import { useState } from "react";
import { achievementDate, badgeStatusLabel } from "./achievementPresentation";

const icons: Record<string, typeof Flower2> = {
  door: DoorOpen,
  sprout: Sprout,
  sun: Sun,
  calendar: CalendarDays,
  tree: TreePine,
  orbit: Orbit,
  quill: Feather,
  message: MessageCircle,
  envelope: Mail,
  mailbox: Mailbox,
  letter: MailOpen,
  leaf: Leaf,
  echo: Radio,
  flower: Flower2,
  star: Star,
  constellation: Sparkles,
};
function badgeIcon(key: string) {
  if (icons[key]) return icons[key];
  if (/letter|mail/.test(key)) return Mail;
  if (/message|chat/.test(key)) return MessageCircle;
  if (/character|create/.test(key)) return UserRound;
  if (/first|day_1|visit_1|sunrise/.test(key)) return Sun;
  if (/streak|visit|footstep|day/.test(key)) return Footprints;
  if (/bloom|flower/.test(key)) return Flower2;
  if (/star/.test(key)) return Star;
  if (/heart|relationship/.test(key)) return Heart;
  if (/sprout|seed/.test(key)) return Sprout;
  return Sparkles;
}

export function AchievementBadge({
  achievement,
  large = false,
}: {
  achievement: Achievement;
  large?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const url = large
    ? achievement.badge.imageUrl
    : (achievement.badge.thumbnailUrl ?? achievement.badge.imageUrl);
  const Icon = badgeIcon(achievement.badge.key);
  return (
    <span
      className={`achievement-badge achievement-badge--${achievement.category}${large ? " achievement-badge--large" : ""}`}
      aria-hidden="true"
    >
      {url && failedUrl !== url ? (
        <img
          src={url}
          alt=""
          loading={large ? "eager" : "lazy"}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <>
          <span className="achievement-badge__ring" />
          <Icon size={large ? 60 : 38} strokeWidth={1.2} />
          <span className="achievement-badge__spark">✦</span>
        </>
      )}
    </span>
  );
}

export function AchievementCard({
  achievement,
  onSelect,
}: {
  achievement: Achievement;
  onSelect: () => void;
}) {
  const status = badgeStatusLabel(achievement.badge.status);
  return (
    <button
      type="button"
      className="achievement-card"
      onClick={onSelect}
      aria-label={`查看成就：${achievement.title}${achievement.agentName ? `，与 ${achievement.agentName}` : ""}`}
    >
      <AchievementBadge achievement={achievement} />
      <span className="achievement-card__category">
        {achievement.agentName ? `与 ${achievement.agentName}` : "我的足迹"}
      </span>
      <strong className="achievement-card__title">{achievement.title}</strong>
      <span className="achievement-card__description">
        {achievement.description}
      </span>
      <time dateTime={achievement.unlockedAtUtc}>
        {achievementDate(achievement.unlockedAtUtc)}
      </time>
      {status ? (
        <span className="achievement-card__status">{status}</span>
      ) : null}
    </button>
  );
}
