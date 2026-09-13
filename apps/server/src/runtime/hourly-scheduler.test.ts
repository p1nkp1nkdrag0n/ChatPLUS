import { describe, expect, it, vi } from "vitest";
import type { SettlementService } from "../services/settlement-service.js";
import type { PersonalLifeService } from "../services/personal-life-service.js";
import type { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import { SseHub } from "../sse/hub.js";
import { ActorQueue } from "./actor-queue.js";
import { FakeClock } from "./clock.js";
import { HourlyScheduler } from "./hourly-scheduler.js";
const NOW = "2026-08-21T04:37:00.000Z";
function setup() {
  const sse = new SseHub();
  vi.spyOn(sse, "getActiveAgentIds").mockReturnValue(["agent-hourly"]);
  return {
    clock: new FakeClock(NOW),
    sse,
    actors: new ActorQueue(),
    logger: { error: vi.fn() },
  };
}
describe("hourly lifecycle", () => {
  it("serializes legacy settlement, planning and memory maintenance for one actor", async () => {
    const { clock, sse, actors, logger } = setup();
    const order: string[] = [];
    const settleAndExtend = vi.fn(() => {
      order.push("settle");
      expect(actors.activeActors).toBe(1);
      return Promise.resolve();
    });
    const ensureSelfInitiatedPlans = vi.fn(() => {
      order.push("plan");
    });
    const maintainAgent = vi.fn(() => {
      order.push("memory");
    });
    const scheduler = new HourlyScheduler(
      clock,
      sse,
      actors,
      { settleAndExtend } as unknown as SettlementService,
      logger,
      { ensureSelfInitiatedPlans } as unknown as Pick<
        PersonalLifeService,
        "ensureSelfInitiatedPlans"
      >,
      { maintainAgent } as unknown as Pick<
        MemoryLifecycleService,
        "maintainAgent"
      >,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = actors.runExclusive("agent-hourly", () => gate);
    const tick = scheduler.tick();
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([blocker, tick]);
    expect(order).toEqual(["settle", "plan", "memory"]);
    expect(settleAndExtend).toHaveBeenCalledWith("agent-hourly", {
      toUtc: NOW,
      hourlyBucket: "2026-08-21T04:00:00.000Z",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
  it("advances fuzzy life and memories without any legacy or proactive collaborators", async () => {
    const { clock, sse, actors, logger } = setup();
    const advance = vi.fn();
    const maintainAgent = vi.fn();
    const scheduler = new HourlyScheduler(
      clock,
      sse,
      actors,
      undefined,
      logger,
      undefined,
      { maintainAgent },
      { advance },
      "fuzzy",
    );
    await scheduler.tick();
    expect(advance).toHaveBeenCalledWith("agent-hourly", NOW);
    expect(maintainAgent).toHaveBeenCalledWith("agent-hourly");
    expect(logger.error).not.toHaveBeenCalled();
  });
  it("waits for an already queued tick before releasing its lifecycle", async () => {
    const { clock, sse, actors, logger } = setup();
    const advance = vi.fn();
    const scheduler = new HourlyScheduler(
      clock,
      sse,
      actors,
      undefined,
      logger,
      undefined,
      undefined,
      { advance },
      "fuzzy",
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = actors.runExclusive("agent-hourly", () => gate);
    const tick = scheduler.tick();
    let disposed = false;
    const closing = scheduler.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await Promise.all([blocker, tick, closing]);
    expect(disposed).toBe(true);
    expect(advance).toHaveBeenCalledOnce();
  });
});
