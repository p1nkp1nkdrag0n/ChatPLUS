import { describe, expect, it } from "vitest";
import { CORRESPONDENCE_ROUTE_PATHS } from "./App";

describe("correspondence application routes", () => {
  it("registers every route from the accepted Stage 4 specification", () => {
    expect(CORRESPONDENCE_ROUTE_PATHS).toEqual([
      "/characters/:characterId/correspondence",
      "/characters/:characterId/correspondence/compose",
      "/letters/:letterId",
      "/correspondence/threads/:threadId",
    ]);
  });
});
