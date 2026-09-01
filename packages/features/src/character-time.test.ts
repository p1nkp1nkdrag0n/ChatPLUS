import { describe, expect, it } from "vitest";

import {
  projectCharacterTime,
  projectPromptTemporalData,
} from "./character-time.js";

describe("character story time", () => {
  it("keeps realtime characters on the infrastructure clock", () => {
    const projection = projectCharacterTime(
      { timezone: "Asia/Shanghai" },
      "2026-09-01T01:00:00.000Z",
    );

    expect(projection).toMatchObject({
      mode: "realtime",
      localDate: "2026-09-01",
      hour: 9,
    });
    expect(projection.promptContext).toHaveProperty(
      "currentTimeUtc",
      "2026-09-01T01:00:00.000Z",
    );
  });

  it("advances an anchored historical story without exposing the host year", () => {
    const identity = {
      timezone: "Europe/Minsk",
      temporalFrame: {
        mode: "anchored_story" as const,
        eraLabel: "1951 年战后明斯克",
        storyAnchorLocalDate: "1951-09-01",
        systemAnchorUtc: "2026-09-01T01:00:00.000Z",
        knowledgeCutoff: "1951-09-01",
      },
    };
    const projection = projectCharacterTime(
      identity,
      "2026-09-03T01:00:00.000Z",
    );

    expect(projection).toMatchObject({
      mode: "anchored_story",
      localDate: "1951-09-03",
    });
    expect(JSON.stringify(projection.promptContext)).toContain("1951");
    expect(JSON.stringify(projection.promptContext)).not.toContain("2026");

    const promptData = projectPromptTemporalData(identity, {
      asOfUtc: "2026-09-03T01:00:00.000Z",
      nested: [
        { createdAtUtc: "2026-09-02T01:00:00.000Z", content: "保留正文" },
      ],
    }) as Record<string, unknown>;
    expect(JSON.stringify(promptData)).not.toContain("2026");
    expect(promptData).toHaveProperty(
      "asOfCharacterLocal",
      expect.stringContaining("1951-09-03"),
    );
  });
});
