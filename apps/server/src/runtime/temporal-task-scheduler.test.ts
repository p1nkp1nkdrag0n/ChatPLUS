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
