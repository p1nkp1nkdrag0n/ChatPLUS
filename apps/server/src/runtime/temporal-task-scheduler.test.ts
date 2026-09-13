import type { TemporalTask, TemporalTaskKind } from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeClock } from "./clock.js";
import {
  TemporalTaskScheduler,
  type TemporalTaskSchedulerRepository,
} from "./temporal-task-scheduler.js";

const NOW = "2026-09-09T01:00:00.000Z";

describe("TemporalTaskScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["resident", "worker"] as const)(
    "starts %s with an immediate global scan independent of browser activity",
    async (execution) => {
      const repository = new MemorySchedulerRepository([
        task("task-offline-agent", "agent-without-sse", NOW),
      ]);
      const catchUpAgent = vi.fn((agentId: string) => {
        repository.removeAgent(agentId);
        return Promise.resolve();
      });
      const scheduler = createScheduler(repository, catchUpAgent, {
        execution,
      });

      await scheduler.start();

      expect(catchUpAgent).toHaveBeenCalledExactlyOnceWith(
        "agent-without-sse",
        NOW,
      );
      expect(scheduler.isRunning).toBe(true);
      await scheduler.dispose();
    },
  );

  it("arms the timer for the nearest actionable due instant", async () => {
    const dueAtUtc = "2026-09-09T01:00:10.000Z";
    const repository = new MemorySchedulerRepository([
      task("task-future", "agent-a", dueAtUtc),
    ]);
    const clock = new FakeClock(NOW);
    const catchUpAgent = vi.fn((agentId: string) => {
      repository.removeAgent(agentId);
      return Promise.resolve();
    });
    const scheduler = createScheduler(repository, catchUpAgent, {
      clock,
      idlePollMs: 60_000,
    });

    await scheduler.start();

    expect(catchUpAgent).not.toHaveBeenCalled();
    expect(scheduler.nextWakeAtUtc).toBe(dueAtUtc);

    clock.setUtc(dueAtUtc);
    await scheduler.tick();

    expect(catchUpAgent).toHaveBeenCalledExactlyOnceWith("agent-a", dueAtUtc);
    await scheduler.dispose();
  });

  it("isolates one agent failure and applies bounded per-agent backoff", async () => {
    const repository = new MemorySchedulerRepository([
      task("task-a", "agent-a", NOW, 10),
      task("task-b", "agent-b", NOW, 20),
    ]);
    let agentAFailures = 0;
    const catchUpAgent = vi.fn((agentId: string) => {
      if (agentId === "agent-a" && agentAFailures === 0) {
        agentAFailures += 1;
        const error = new Error(
          "sensitive details must not be logged",
        ) as Error & {
          code: string;
        };
        error.code = "database_busy";
        throw error;
      }
      repository.removeAgent(agentId);
      return Promise.resolve();
    });
    const logger = { error: vi.fn() };
    const clock = new FakeClock(NOW);
    const scheduler = createScheduler(repository, catchUpAgent, {
      clock,
      logger,
      errorBackoffMs: 5_000,
      idlePollMs: 60_000,
    });

    await scheduler.start();

    expect(catchUpAgent.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent-a",
      "agent-b",
    ]);
    expect(scheduler.nextWakeAtUtc).toBe("2026-09-09T01:00:05.000Z");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-a",
        taskId: "task-a",
        errorCode: "database_busy",
      }),
      "temporal correspondence scheduler pass failed",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "sensitive details",
    );

    clock.setUtc("2026-09-09T01:00:05.000Z");
    await scheduler.tick();

    expect(catchUpAgent.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent-a",
      "agent-b",
      "agent-a",
    ]);
    await scheduler.dispose();
  });

  it("serializes repeated ticks so one due task is not dispatched twice", async () => {
    const repository = new MemorySchedulerRepository([
      task("task-once", "agent-a", NOW),
    ]);
    const gate = deferred<void>();
    const catchUpAgent = vi.fn(async (agentId: string) => {
      await gate.promise;
      repository.removeAgent(agentId);
    });
    const scheduler = createScheduler(repository, catchUpAgent);

    const first = scheduler.tick();
    const second = scheduler.tick();
    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, second]);

    expect(catchUpAgent).toHaveBeenCalledTimes(1);
    await scheduler.dispose();
  });

  it("keeps lazy stopped and cancels resident timers on dispose", async () => {
    vi.useFakeTimers();
    const lazyRepository = new MemorySchedulerRepository([
      task("task-lazy", "agent-lazy", NOW),
    ]);
    const lazyCatchUp = vi.fn(() => Promise.resolve());
    const lazy = createScheduler(lazyRepository, lazyCatchUp, {
      execution: "lazy",
    });

    await lazy.start();

    expect(lazy.isRunning).toBe(false);
    expect(lazyRepository.queryCount).toBe(0);
    expect(lazyCatchUp).not.toHaveBeenCalled();

    const clock = new FakeClock(NOW);
    const residentRepository = new MemorySchedulerRepository([
      task("task-after-stop", "agent-resident", "2026-09-09T01:00:01.000Z"),
    ]);
    const residentCatchUp = vi.fn(() => Promise.resolve());
    const resident = createScheduler(residentRepository, residentCatchUp, {
      clock,
    });
    await resident.start();
    await resident.dispose();
    clock.setUtc("2026-09-09T01:00:02.000Z");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(resident.isRunning).toBe(false);
    expect(resident.nextWakeAtUtc).toBeUndefined();
    expect(residentCatchUp).not.toHaveBeenCalled();
  });

  it("runs coalesced lazy requests without a scan or resident timer", async () => {
    const repository = new MemorySchedulerRepository([]);
    const entered = deferred<void>();
    const gate = deferred<void>();
    const catchUpAgent = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const scheduler = createScheduler(repository, catchUpAgent, {
      execution: "lazy",
    });

    const first = scheduler.requestAgentCatchUp("agent-a", NOW);
    const second = scheduler.requestAgentCatchUp("agent-a", NOW);
    expect(first).toBe(second);
    expect(catchUpAgent).not.toHaveBeenCalled();
    await entered.promise;

    expect(catchUpAgent).toHaveBeenCalledExactlyOnceWith("agent-a", NOW);
    expect(scheduler.isRunning).toBe(false);
    expect(scheduler.nextWakeAtUtc).toBeUndefined();
    expect(repository.queryCount).toBe(0);
    gate.resolve();
    await first;
    await scheduler.dispose();
  });

  it("shares a resident pass with an HTTP request without a tail deadlock", async () => {
    const repository = new MemorySchedulerRepository([
      task("task-a", "agent-a", NOW),
    ]);
    const entered = deferred<void>();
    const gate = deferred<void>();
    const catchUpAgent = vi.fn(async (agentId: string) => {
      entered.resolve();
      await gate.promise;
      repository.removeAgent(agentId);
    });
    const scheduler = createScheduler(repository, catchUpAgent);

    const cycle = scheduler.start();
    await entered.promise;
    const request = scheduler.requestAgentCatchUp("agent-a", NOW);
    const nextCycle = scheduler.wake();
    gate.resolve();
    await Promise.all([cycle, request, nextCycle]);

    expect(catchUpAgent).toHaveBeenCalledTimes(1);
    await scheduler.dispose();
  });

  it("does not repeat work when the background request precedes a resident scan", async () => {
    const repository = new MemorySchedulerRepository([
      task("task-a", "agent-a", NOW),
    ]);
    const entered = deferred<void>();
    const gate = deferred<void>();
    const catchUpAgent = vi.fn(async (agentId: string) => {
      entered.resolve();
      await gate.promise;
      repository.removeAgent(agentId);
    });
    const scheduler = createScheduler(repository, catchUpAgent);

    const request = scheduler.requestAgentCatchUp("agent-a", NOW);
    await entered.promise;
    const cycle = scheduler.start();
    gate.resolve();
    await Promise.all([request, cycle]);

    expect(catchUpAgent).toHaveBeenCalledTimes(1);
    await scheduler.dispose();
  });

  it("retains the latest observation received during a running agent pass", async () => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    const catchUpAgent = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const scheduler = createScheduler(
      new MemorySchedulerRepository([]),
      catchUpAgent,
      { execution: "lazy" },
    );
    const later = "2026-09-09T02:00:00.000Z";
    const first = scheduler.requestAgentCatchUp("agent-a", NOW);
    await entered.promise;
    const second = scheduler.requestAgentCatchUp("agent-a", later);
    expect(second).toBe(first);
    gate.resolve();
    await second;

    expect(catchUpAgent.mock.calls).toEqual([
      ["agent-a", NOW],
      ["agent-a", later],
    ]);
    await scheduler.dispose();
  });

  it.each(["lazy", "resident", "worker"] as const)(
    "coalesces a %s driver's non-blocking auxiliary request into its current pass",
    async (execution) => {
      const repository = new MemorySchedulerRepository([
        task("task-a", "agent-a", NOW),
      ]);
      const catchUpAgent = vi.fn(
        async (agentId: string, observedNowUtc: string) => {
          void scheduler.requestAgentCatchUp(agentId, observedNowUtc);
          await Promise.resolve();
          repository.removeAgent(agentId);
        },
      );
      const scheduler = createScheduler(repository, catchUpAgent, {
        execution,
      });

      if (execution === "lazy") {
        await scheduler.requestAgentCatchUp("agent-a", NOW);
      } else {
        await scheduler.start();
      }
      await scheduler.dispose();

      expect(catchUpAgent).toHaveBeenCalledExactlyOnceWith("agent-a", NOW);
    },
  );

  it("contains background failures, applies backoff, and can retry later", async () => {
    const clock = new FakeClock(NOW);
    const logger = { error: vi.fn() };
    const error = Object.assign(new Error("private provider response"), {
      code: "database_busy",
    });
    const catchUpAgent = vi
      .fn<(agentId: string, observedNowUtc: string) => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const scheduler = createScheduler(
      new MemorySchedulerRepository([]),
      catchUpAgent,
      { execution: "lazy", clock, logger },
    );

    await expect(
      scheduler.requestAgentCatchUp("agent-a"),
    ).resolves.toBeUndefined();
    await scheduler.requestAgentCatchUp("agent-a");
    expect(catchUpAgent).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      {
        agentId: "agent-a",
        errorCode: "database_busy",
        retryAtUtc: "2026-09-09T01:00:05.000Z",
      },
      "temporal correspondence scheduler pass failed",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private");

    clock.setUtc("2026-09-09T01:00:05.000Z");
    await scheduler.requestAgentCatchUp("agent-a");
    expect(catchUpAgent).toHaveBeenCalledTimes(2);
    await scheduler.dispose();
  });

  it("does not expose an arbitrary error name in background diagnostics", async () => {
    const logger = { error: vi.fn() };
    const catchUpAgent = vi.fn(() => {
      throw Object.assign(new Error("private body"), {
        name: "private provider response and credentials",
      });
    });
    const scheduler = createScheduler(
      new MemorySchedulerRepository([]),
      catchUpAgent,
      { execution: "lazy", logger },
    );

    await scheduler.requestAgentCatchUp("agent-a");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "unknown_error" }),
      "temporal correspondence scheduler pass failed",
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private");
    await scheduler.dispose();
  });

  it.each(["lazy", "resident", "worker"] as const)(
    "drains %s background work on dispose, rejects new work, and resumes on start",
    async (execution) => {
      const entered = deferred<void>();
      const gate = deferred<void>();
      const catchUpAgent = vi.fn(async () => {
        entered.resolve();
        await gate.promise;
      });
      const repository = new MemorySchedulerRepository([]);
      const scheduler = createScheduler(repository, catchUpAgent, {
        execution,
      });
      const request = scheduler.requestAgentCatchUp("agent-a");
      await entered.promise;

      let disposed = false;
      const closing = scheduler.dispose().then(() => {
        disposed = true;
      });
      await scheduler.requestAgentCatchUp("agent-b");
      await scheduler.tick();
      expect(disposed).toBe(false);
      expect(catchUpAgent).toHaveBeenCalledTimes(1);
      gate.resolve();
      await Promise.all([request, closing]);
      expect(disposed).toBe(true);

      await scheduler.requestAgentCatchUp("agent-b");
      expect(catchUpAgent).toHaveBeenCalledTimes(1);
      await scheduler.start();
      await scheduler.requestAgentCatchUp("agent-b");
      expect(catchUpAgent).toHaveBeenCalledTimes(2);
      expect(scheduler.isRunning).toBe(execution !== "lazy");
      if (execution === "lazy") {
        expect(repository.queryCount).toBe(0);
        expect(scheduler.nextWakeAtUtc).toBeUndefined();
      }
      await scheduler.dispose();
    },
  );
});

class MemorySchedulerRepository implements TemporalTaskSchedulerRepository {
  queryCount = 0;

  constructor(readonly tasks: TemporalTask[]) {}

  findNextTemporalTask(
    observedNowUtc: string,
    kinds?: readonly TemporalTaskKind[],
    excludedAgentIds: readonly string[] = [],
  ): TemporalTask | undefined {
    this.queryCount += 1;
    return this.tasks
      .filter(
        (candidate) =>
          (kinds === undefined || kinds.includes(candidate.kind)) &&
          !excludedAgentIds.includes(candidate.agentId),
      )
      .sort((left, right) => compareSchedule(left, right, observedNowUtc))[0];
  }

  removeAgent(agentId: string): void {
    for (let index = this.tasks.length - 1; index >= 0; index -= 1) {
      if (this.tasks[index]?.agentId === agentId) this.tasks.splice(index, 1);
    }
  }
}

function createScheduler(
  repository: TemporalTaskSchedulerRepository,
  catchUpAgent: (agentId: string, observedNowUtc: string) => Promise<void>,
  options: {
    execution?: "lazy" | "resident" | "worker";
    clock?: FakeClock;
    logger?: { error: ReturnType<typeof vi.fn> };
    idlePollMs?: number;
    errorBackoffMs?: number;
  } = {},
): TemporalTaskScheduler {
  return new TemporalTaskScheduler(
    repository,
    { catchUpAgent },
    options.clock ?? new FakeClock(NOW),
    options.logger ?? { error: vi.fn() },
    {
      execution: options.execution ?? "resident",
      taskKinds: [
        "letter.outbound_arrival",
        "letter.reply_generation",
        "letter.return_arrival",
        "letter.generation_retry",
      ],
      ...(options.idlePollMs === undefined
        ? {}
        : { idlePollMs: options.idlePollMs }),
      ...(options.errorBackoffMs === undefined
        ? {}
        : { errorBackoffMs: options.errorBackoffMs }),
    },
  );
}

function task(
  id: string,
  agentId: string,
  dueAtUtc: string,
  priority = 10,
): TemporalTask {
  return {
    id,
    agentId,
    kind: "letter.outbound_arrival",
    entityId: `letter-${id}`,
    dueAtUtc,
    priority,
    status: "pending",
    attempt: 0,
    maxAttempts: 3,
    idempotencyKey: `scheduler:${id}`,
    payload: { letterId: `letter-${id}` },
    createdAtUtc: "2026-09-03T00:00:00.000Z",
    updatedAtUtc: "2026-09-03T00:00:00.000Z",
  };
}

function compareSchedule(
  left: TemporalTask,
  right: TemporalTask,
  observedNowUtc: string,
): number {
  const leftWake = taskWake(left, observedNowUtc);
  const rightWake = taskWake(right, observedNowUtc);
  if (leftWake !== rightWake) return leftWake < rightWake ? -1 : 1;
  if (left.dueAtUtc !== right.dueAtUtc)
    return left.dueAtUtc < right.dueAtUtc ? -1 : 1;
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function taskWake(taskValue: TemporalTask, observedNowUtc: string): string {
  return taskValue.status === "claimed" &&
    taskValue.leaseExpiresAtUtc !== undefined &&
    taskValue.leaseExpiresAtUtc > observedNowUtc
    ? taskValue.leaseExpiresAtUtc
    : taskValue.dueAtUtc;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}
