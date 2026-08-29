import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { DatabaseStore } from "../db/store.js";
import {
  LONG_RUN_V2_AGENT_ID,
  LONG_RUN_V2_SESSION_ID,
  LONG_RUN_V2_START_UTC,
  buildGuLanCharacterSpec,
  buildGuLanInitialSchedule,
  buildGuLanInitialState,
  createCompanionLongRunV2Baseline,
} from "./companion-long-run-v2-baseline.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("companion long-run v2 baseline", () => {
  it("freezes Gu Lan, exact relationship values and a 72-hour schedule", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-long-run-v2-"));
    cleanup.push(directory);
    const path = join(directory, "baseline.sqlite");

    const descriptor = await createCompanionLongRunV2Baseline(path);
    expect(descriptor.databaseSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(descriptor.characterSpecSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(descriptor.scheduleItemCount).toBe(14);

    const database = openDatabase(path);
    try {
      const store = new DatabaseStore(database);
      expect(store.getCharacterSpec(LONG_RUN_V2_AGENT_ID)).toEqual(
        buildGuLanCharacterSpec(),
      );
      expect(store.getRuntimeState(LONG_RUN_V2_AGENT_ID)).toEqual(
        buildGuLanInitialState(buildGuLanCharacterSpec()),
      );
      expect(store.listSchedule(LONG_RUN_V2_AGENT_ID)).toEqual(
        buildGuLanInitialSchedule(),
      );
      expect(store.getSession(LONG_RUN_V2_SESSION_ID)).toMatchObject({
        agentId: LONG_RUN_V2_AGENT_ID,
        createdAtUtc: LONG_RUN_V2_START_UTC,
      });
    } finally {
      database.close();
    }
  });

  it("refuses to replace an existing frozen baseline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-long-run-v2-"));
    cleanup.push(directory);
    const path = join(directory, "baseline.sqlite");
    await createCompanionLongRunV2Baseline(path);
    await expect(createCompanionLongRunV2Baseline(path)).rejects.toThrow(
      "Refusing to replace",
    );
  });
});
