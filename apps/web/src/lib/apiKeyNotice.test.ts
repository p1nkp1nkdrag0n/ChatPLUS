import { describe, expect, it } from "vitest";
import {
  apiKeyNoticeOrigin,
  apiKeyNoticePath,
  hasAcceptedApiKeyNotice,
} from "./apiKeyNotice";

describe("own API configuration notice routing", () => {
  it("returns only supported in-app destinations for each deployment", () => {
    expect(apiKeyNoticeOrigin("?from=setup", true)).toBe("setup");
    expect(apiKeyNoticeOrigin("?from=model-settings", true)).toBe(
      "model-settings",
    );
    expect(apiKeyNoticeOrigin("?from=settings", false)).toBe("settings");
    for (const search of [
      "",
      "?from=https://example.com",
      "?from=//example.com",
      "?from=%2Fadmin",
      "?from=model-settings",
      "?from=setup",
    ])
      expect(apiKeyNoticeOrigin(search, false)).toBe("settings");
    expect(apiKeyNoticeOrigin("?from=https://example.com", true)).toBe("setup");
  });
  it("requires an explicit acknowledgement scoped to the form being opened", () => {
    for (const state of [
      undefined,
      null,
      {},
      true,
      "setup",
      { apiKeyNoticeAccepted: true },
      { apiKeyNoticeAccepted: "settings" },
    ])
      expect(hasAcceptedApiKeyNotice(state, "setup")).toBe(false);
    expect(
      hasAcceptedApiKeyNotice({ apiKeyNoticeAccepted: "setup" }, "setup"),
    ).toBe(true);
    expect(apiKeyNoticePath("model-settings")).toBe(
      "/api-key-notice?from=model-settings",
    );
  });
});
