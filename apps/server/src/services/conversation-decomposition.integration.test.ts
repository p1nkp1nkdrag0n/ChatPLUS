import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import {
  REPLY_REPAIR_SERVICE_TOKEN,
  TURN_COMMIT_SERVICE_TOKEN,
  TURN_DECISION_SERVICE_TOKEN,
  WORLD_EFFECT_SERVICE_TOKEN,
} from "../composition/service-tokens.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ReplyRepairService } from "./reply-repair-service.js";
import type { TurnCommitService } from "./turn-commit-service.js";
import type { TurnDecisionService } from "./turn-decision-service.js";
import type { WorldEffectService } from "./world-effect-service.js";

describe("conversation service decomposition", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("injects the registered turn collaborators as one graph", async () => {
    const config = readConfig({
      nodeEnv: "test",
      databasePath: ":memory:",
      clockMode: "fake",
      seedDemo: false,
      developerRoutes: true,
    });
    app = await buildApp({
      config,
      database: openDatabase(":memory:"),
      clock: new FakeClock("2026-08-16T02:00:00.000Z"),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });

    const registry = app.personasim.kernel.registry;
    const replyRepairs = registry.resolve(REPLY_REPAIR_SERVICE_TOKEN);
    const decisions = registry.resolve(TURN_DECISION_SERVICE_TOKEN);
    const worldEffects = registry.resolve(WORLD_EFFECT_SERVICE_TOKEN);
    const commits = registry.resolve(TURN_COMMIT_SERVICE_TOKEN);
    const coordinator = app.personasim.conversations as unknown as {
      decisions: TurnDecisionService;
      worldEffects: WorldEffectService;
      commits: TurnCommitService;
    };

    const decisionBoundary = decisions as unknown as {
      repairs: ReplyRepairService;
    };
    const worldEffectBoundary = worldEffects as unknown as {
      decisions: TurnDecisionService;
      repairs: ReplyRepairService;
    };
    expect(coordinator.decisions).toBe(decisions);
    expect(coordinator.worldEffects).toBe(worldEffects);
    expect(coordinator.commits).toBe(commits);
    expect(decisionBoundary.repairs).toBe(replyRepairs);
    expect(worldEffectBoundary.decisions).toBe(decisions);
    expect(worldEffectBoundary.repairs).toBe(replyRepairs);
  });
});
