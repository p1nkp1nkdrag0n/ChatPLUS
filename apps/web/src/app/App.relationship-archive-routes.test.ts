import { describe, expect, it } from "vitest";
import { RELATIONSHIP_ARCHIVE_ROUTE_PATHS } from "./App";

describe("relationship archive application routes", () => {
  it("registers the R3 archive, cabinet, artifact, and local share routes", () => {
    expect(RELATIONSHIP_ARCHIVE_ROUTE_PATHS).toEqual([
      "/characters/:characterId/relationship-archive",
      "/characters/:characterId/keepsakes",
      "/keepsakes/:keepsakeId",
      "/characters/:characterId/relationship-share",
    ]);
  });
});
