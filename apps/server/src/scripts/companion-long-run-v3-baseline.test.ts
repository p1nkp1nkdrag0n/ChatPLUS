import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import {
  LONG_RUN_V3_AGENT_ID,
  createCompanionLongRunV3Baseline,
} from "./companion-long-run-v3-baseline.js";

describe("companion long-run v3 baseline", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("creates one fuzzy day and no exact schedule", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personasim-v3-baseline-"));
    directories.push(directory);
    const path = join(directory, "baseline.sqlite");
    const descriptor = await createCompanionLongRunV3Baseline(path);
    expect(descriptor.scheduleItemCount).toBe(0);
    expect(descriptor.dailyContextCount).toBe(1);

    const database = openDatabase(path);
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM schedule_items").get(),
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM daily_life_contexts WHERE agent_id = ?",
          )
          .get(LONG_RUN_V3_AGENT_ID),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM decision_records")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("refuses to overwrite an existing baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "personasim-v3-baseline-"));
    directories.push(directory);
    const path = join(directory, "baseline.sqlite");
    await createCompanionLongRunV3Baseline(path);
    await expect(createCompanionLongRunV3Baseline(path)).rejects.toThrow(
      /Refusing to replace/u,
    );
  });
});
