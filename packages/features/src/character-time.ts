import type { CharacterIdentity } from "@personasim/contracts";
import { DateTime } from "luxon";

export interface CharacterTimeProjection {
  mode: "realtime" | "anchored_story";
  localDateTime: string;
  localDate: string;
  hour: number;
  promptContext: Record<string, unknown>;
}

/**
 * Removes host-calendar UTC fields from any data that will be shown to an
 * anchored-story model. Values are projected onto the same frozen story clock
 * and keys are renamed so an offset-bearing local timestamp is never falsely
 * labelled as UTC. Database/audit values remain untouched.
 */
export function projectPromptTemporalData(
  identity: Pick<CharacterIdentity, "timezone" | "temporalFrame">,
  value: unknown,
): unknown {
  if (identity.temporalFrame?.mode !== "anchored_story") return value;
  if (Array.isArray(value)) {
    return value.map((item) => projectPromptTemporalData(identity, item));
  }
  if (!isPlainRecord(value)) return value;

  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && isUtcTimestampField(key, item)) {
      projected[characterLocalTimestampField(key)] = projectCharacterTime(
        identity,
        item,
      ).localDateTime;
      continue;
    }
    projected[key] = projectPromptTemporalData(identity, item);
  }
  return projected;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtcTimestampField(key: string, value: string): boolean {
  if (!key.endsWith("Utc")) return false;
  return DateTime.fromISO(value, { setZone: true }).isValid;
}

function characterLocalTimestampField(key: string): string {
  return key.endsWith("AtUtc")
    ? `${key.slice(0, -5)}AtCharacterLocal`
    : `${key.slice(0, -3)}CharacterLocal`;
}

/**
 * Projects infrastructure time into the character's own civil/story clock.
 * The infrastructure instant remains useful for ordering and idempotency but
 * is deliberately omitted from an anchored-story prompt so that (for example)
 * a 1951 character is not told that the canonical story year is 2026.
 */
export function projectCharacterTime(
  identity: Pick<CharacterIdentity, "timezone" | "temporalFrame">,
  systemTimeUtc: string,
): CharacterTimeProjection {
  const systemNow = DateTime.fromISO(systemTimeUtc, { setZone: true });
  const frame = identity.temporalFrame;
  if (frame?.mode !== "anchored_story") {
    const local = systemNow.setZone(identity.timezone);
    return {
      mode: "realtime",
      localDateTime: local.toISO()!,
      localDate: local.toISODate()!,
      hour: local.hour,
      promptContext: {
        temporalMode: "realtime",
        currentTimeUtc: systemTimeUtc,
        characterLocalTimezone: identity.timezone,
        characterLocalDateTime: local.toISO(),
      },
    };
  }

  const systemAnchor = DateTime.fromISO(
    frame.systemAnchorUtc ?? systemTimeUtc,
    { setZone: true },
  );
  const anchorWallClock = systemAnchor.setZone(identity.timezone);
  const storyAnchor = DateTime.fromISO(frame.storyAnchorLocalDate, {
    zone: identity.timezone,
  }).set({
    hour: anchorWallClock.hour,
    minute: anchorWallClock.minute,
    second: anchorWallClock.second,
    millisecond: anchorWallClock.millisecond,
  });
  const local = storyAnchor.plus({
    milliseconds: systemNow.toMillis() - systemAnchor.toMillis(),
  });
  return {
    mode: "anchored_story",
    localDateTime: local.toISO()!,
    localDate: local.toISODate()!,
    hour: local.hour,
    promptContext: {
      temporalMode: "anchored_story",
      timeAuthority: "character_story_clock",
      characterLocalTimezone: identity.timezone,
      characterLocalDateTime: local.toISO(),
      eraLabel: frame.eraLabel,
      anchorPrecision: frame.anchorPrecision ?? "day",
      ...(frame.knowledgeCutoff === undefined
        ? {}
        : { knowledgeCutoff: frame.knowledgeCutoff }),
      semantics:
        "This is the character's canonical civil/story time. Host ordering time is not the story year.",
    },
  };
}
