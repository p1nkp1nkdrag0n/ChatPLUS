import { describe, expect, it } from "vitest";

import { PromptDiagnosticsTracker } from "./prompt-diagnostics.js";

describe("prompt diagnostics", () => {
  it("compares actual serialized messages by purpose without logging text", () => {
    const tracker = new PromptDiagnosticsTracker();
    const messages = [
      { role: "system" as const, content: "private static role" },
      { role: "user" as const, content: "history\ncurrentTime: 01" },
    ];
    const first = tracker.observe("chat", messages);
    expect(first.comparison).toBe("no_baseline");
    expect(first.commonPrefixCharacters).toBeUndefined();
    expect(tracker.observe("letter", messages).comparison).toBe("no_baseline");
    const next = [
      messages[0]!,
      { ...messages[1]!, content: "history\ncurrentTime: 02" },
    ];
    const second = tracker.observe("chat", next);
    expect(second.firstChangedMessageIndex).toBe(1);
    expect(second.commonPrefixCharacters).toBe(
      JSON.stringify(messages).indexOf("01") + 1,
    );
    expect(second.messages[0]?.contentSha256).toBe(
      first.messages[0]?.contentSha256,
    );
    expect(JSON.stringify(second)).not.toContain("private static role");
    expect(JSON.stringify(second)).not.toContain("history");
  });

  it("reports schema/system changes, appended repair, removed messages and identical requests honestly", () => {
    const tracker = new PromptDiagnosticsTracker();
    const original = [{ role: "system" as const, content: "rules" }];
    tracker.observe("chat", original);
    expect(tracker.observe("chat", original).commonPrefixCharacters).toBe(
      JSON.stringify(original).length,
    );
    const repaired = [
      ...original,
      { role: "user" as const, content: "repair" },
    ];
    expect(tracker.observe("chat", repaired).firstChangedMessageIndex).toBe(1);
    expect(tracker.observe("chat", original).firstChangedMessageIndex).toBe(1);
    expect(
      tracker.observe("chat", [{ role: "system", content: "new rules" }])
        .firstChangedMessageIndex,
    ).toBe(0);
    expect(
      new PromptDiagnosticsTracker().observe("chat", original).comparison,
    ).toBe("no_baseline");
  });

  it("bounds memory and discards an oversized baseline instead of comparing to an older request", () => {
    const tracker = new PromptDiagnosticsTracker(1, 100);
    const messages = [{ role: "user" as const, content: "small" }];
    tracker.observe("chat", messages);
    tracker.observe("letter", messages);
    expect(tracker.observe("chat", messages).comparison).toBe("no_baseline");
    expect(
      tracker.observe("chat", [{ role: "user", content: "x".repeat(200) }])
        .comparison,
    ).toBe("size_limit");
    expect(tracker.observe("chat", messages).comparison).toBe("no_baseline");
    expect(() => new PromptDiagnosticsTracker(0)).toThrow(TypeError);
  });
});
