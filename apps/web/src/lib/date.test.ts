import { describe, expect, it } from "vitest";

import { nowWindow } from "./date";

describe("nowWindow", () => {
  it("anchors schedule queries to the simulated server clock", () => {
    expect(nowWindow(24, "2026-08-17T00:00:00.000Z", 2)).toEqual({
      fromUtc: "2026-08-16T22:00:00.000Z",
      toUtc: "2026-08-18T00:00:00.000Z",
    });
  });
});
