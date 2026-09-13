import {
  EntityIdSchema,
  UtcDateTimeSchema,
  type TemporalTask,
  type TemporalTaskKind,
} from "@personasim/contracts";

import type { Clock } from "./clock.js";

const DEFAULT_IDLE_POLL_MS = 30_000;
const DEFAULT_ERROR_BACKOFF_MS = 5_000;
const DEFAULT_MAX_ERROR_BACKOFF_MS = 5 * 60_000;
const DEFAULT_MAX_AGENT_PASSES_PER_CYCLE = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export type CorrespondenceExecutionDriver = "lazy" | "resident" | "worker";

export interface TemporalTaskSchedulerRepository {
  findNextTemporalTask(
    observedNowUtc: string,
    kinds?: readonly TemporalTaskKind[],
    excludedAgentIds?: readonly string[],
  ): TemporalTask | undefined;
}

export interface TemporalCatchUpDriver {
  catchUpAgent(agentId: string, observedNowUtc?: string): Promise<unknown>;
}

export interface TemporalTaskSchedulerLogger {
  error(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export interface TemporalTaskSchedulerOptions {
  readonly execution: CorrespondenceExecutionDriver;
  readonly taskKinds: readonly TemporalTaskKind[];
  readonly idlePollMs?: number;
  readonly errorBackoffMs?: number;
  readonly maxErrorBackoffMs?: number;
  readonly maxAgentPassesPerCycle?: number;
}

interface AgentBackoff {
  readonly failures: number;
  readonly untilUtc: string;
}

interface AgentPass {
  observedNowUtc: string;
  readonly result: Promise<boolean>;
  readonly completion: Promise<void>;
}

/**
 * Database-driven resident/worker driver for the shared catch-up service.
 *
 * This class deliberately has no SSE or browser-session dependency. Resident
 * and worker are the same loop; SQLite task claims and leases provide the
 * cross-process fence. Lazy execution never starts the loop.
 */
export class TemporalTaskScheduler {
  readonly #execution: CorrespondenceExecutionDriver;
  readonly #taskKinds: readonly TemporalTaskKind[];
  readonly #idlePollMs: number;
  readonly #errorBackoffMs: number;
  readonly #maxErrorBackoffMs: number;
  readonly #maxAgentPassesPerCycle: number;
  readonly #agentBackoffs = new Map<string, AgentBackoff>();
  readonly #agentPasses = new Map<string, AgentPass>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #acceptingRequests = true;
  #tail: Promise<void> = Promise.resolve();
  #nextWakeAtUtc: string | undefined;

  constructor(
    private readonly repository: TemporalTaskSchedulerRepository,
    private readonly catchUp: TemporalCatchUpDriver,
    private readonly clock: Clock,
    private readonly logger: TemporalTaskSchedulerLogger,
    options: TemporalTaskSchedulerOptions,
  ) {
    this.#execution = options.execution;
    this.#taskKinds = Object.freeze([...options.taskKinds]);
    this.#idlePollMs = positiveInteger(
      options.idlePollMs ?? DEFAULT_IDLE_POLL_MS,
      "idlePollMs",
    );
    this.#errorBackoffMs = positiveInteger(
      options.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS,
      "errorBackoffMs",
    );
    this.#maxErrorBackoffMs = positiveInteger(
      options.maxErrorBackoffMs ?? DEFAULT_MAX_ERROR_BACKOFF_MS,
      "maxErrorBackoffMs",
    );
    this.#maxAgentPassesPerCycle = positiveInteger(
      options.maxAgentPassesPerCycle ?? DEFAULT_MAX_AGENT_PASSES_PER_CYCLE,
      "maxAgentPassesPerCycle",
    );
    if (this.#maxErrorBackoffMs < this.#errorBackoffMs) {
      throw new TypeError(
        "maxErrorBackoffMs must be greater than or equal to errorBackoffMs",
      );
    }
  }

  get execution(): CorrespondenceExecutionDriver {
    return this.#execution;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  get nextWakeAtUtc(): string | undefined {
    return this.#nextWakeAtUtc;
  }

  /** Starts with an immediate global database scan. */
  start(): Promise<void> {
    this.#acceptingRequests = true;
    if (this.#execution === "lazy") return Promise.resolve();
    if (this.#running) return this.#tail;
    this.#running = true;
    return this.tick();
  }

  /**
   * Requests an immediate rescan, for example after an in-process write. The
   * periodic idle poll still discovers writes made by another worker.
   */
  wake(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    this.#clearTimer();
    return this.tick();
  }

  /**
   * Runs one managed, coalesced pass without requiring a resident loop. The
   * returned promise always settles successfully after operational failures
   * are logged; HTTP callers may safely leave it running in the background.
   */
  requestAgentCatchUp(
    agentIdInput: string,
    observedNowUtc = this.clock.nowUtc(),
  ): Promise<void> {
    if (!this.#acceptingRequests) return Promise.resolve();
    const agentId = EntityIdSchema.parse(agentIdInput);
    UtcDateTimeSchema.parse(observedNowUtc);
    const pass = this.#runAgentPass(agentId, observedNowUtc);
    // Do not queue this pass behind a resident cycle: that cycle may already
    // need to await the same agent. Both are still drained before disposal.
    this.#tail = Promise.all([this.#tail, pass.completion]).then(
      () => undefined,
    );
    return pass.completion;
  }

  /** Runs one serialized global scheduling cycle. */
  tick(): Promise<void> {
    if (!this.#acceptingRequests) return Promise.resolve();
    const cycle = this.#tail
      .catch(() => undefined)
      .then(() => this.#runCycle());
    this.#tail = cycle.catch(() => undefined);
    return cycle;
  }

  stop(): void {
    this.#acceptingRequests = false;
    this.#running = false;
    this.#clearTimer();
    this.#nextWakeAtUtc = undefined;
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.#tail;
  }

  async #runCycle(): Promise<void> {
    if (!this.#acceptingRequests) return;
    const observedNowUtc = UtcDateTimeSchema.parse(this.clock.nowUtc());
    const observedNowMs = Date.parse(observedNowUtc);
    const excludedAgents = new Set<string>();
    for (const [agentId, backoff] of this.#agentBackoffs) {
      if (Date.parse(backoff.untilUtc) > observedNowMs) {
        excludedAgents.add(agentId);
      }
    }

    let futureWakeAtUtc: string | undefined;
    let passes = 0;
    try {
      while (this.#acceptingRequests && passes < this.#maxAgentPassesPerCycle) {
        const candidate = this.repository.findNextTemporalTask(
          observedNowUtc,
          this.#taskKinds,
          [...excludedAgents],
        );
        if (candidate === undefined) break;
        const actionableAtUtc = actionableAt(candidate, observedNowUtc);
        if (Date.parse(actionableAtUtc) > observedNowMs) {
          futureWakeAtUtc = actionableAtUtc;
          break;
        }

        passes += 1;
        const succeeded = await this.#runAgentPass(
          candidate.agentId,
          observedNowUtc,
          candidate,
        ).result;
        if (!succeeded) {
          excludedAgents.add(candidate.agentId);
        }
      }
      if (passes >= this.#maxAgentPassesPerCycle) {
        this.logger.error(
          {
            observedNowUtc,
            maxAgentPassesPerCycle: this.#maxAgentPassesPerCycle,
          },
          "temporal correspondence scheduler cycle limit reached",
        );
      }
    } catch (error) {
      this.logger.error(
        { observedNowUtc, errorCode: safeErrorCode(error) },
        "temporal correspondence scheduler scan failed",
      );
      futureWakeAtUtc = addMilliseconds(observedNowUtc, this.#errorBackoffMs);
    } finally {
      if (this.#running) {
        const backoffWakeAtUtc = earliestFutureBackoff(
          this.#agentBackoffs,
          observedNowUtc,
        );
        const idleWakeAtUtc = addMilliseconds(observedNowUtc, this.#idlePollMs);
        this.#schedule(
          earliestUtc(futureWakeAtUtc, backoffWakeAtUtc, idleWakeAtUtc),
        );
      }
    }
  }

  #runAgentPass(
    agentId: string,
    observedNowUtc: string,
    task?: Readonly<TemporalTask>,
  ): AgentPass {
    const existing = this.#agentPasses.get(agentId);
    if (existing !== undefined) {
      if (observedNowUtc > existing.observedNowUtc) {
        existing.observedNowUtc = observedNowUtc;
      }
      return existing;
    }
    const result = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const passNowUtc = pass.observedNowUtc;
          const backoff = this.#agentBackoffs.get(agentId);
          if (backoff !== undefined && backoff.untilUtc > passNowUtc) {
            return false;
          }
          try {
            await this.catchUp.catchUpAgent(agentId, passNowUtc);
            this.#agentBackoffs.delete(agentId);
          } catch (error) {
            const retry = this.#recordAgentFailure(agentId, passNowUtc);
            this.logger.error(
              {
                agentId,
                ...(task === undefined
                  ? {}
                  : { taskId: task.id, taskKind: task.kind }),
                retryAtUtc: retry.untilUtc,
                errorCode: safeErrorCode(error),
              },
              "temporal correspondence scheduler pass failed",
            );
            return false;
          }
          if (pass.observedNowUtc === passNowUtc) return true;
        }
      } finally {
        this.#agentPasses.delete(agentId);
      }
    });
    const pass: AgentPass = {
      observedNowUtc,
      result,
      completion: result.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.#agentPasses.set(agentId, pass);
    return pass;
  }

  #recordAgentFailure(agentId: string, observedNowUtc: string): AgentBackoff {
    const failures = (this.#agentBackoffs.get(agentId)?.failures ?? 0) + 1;
    const delayMs = Math.min(
      this.#maxErrorBackoffMs,
      this.#errorBackoffMs * 2 ** Math.min(failures - 1, 20),
    );
    const backoff = Object.freeze({
      failures,
      untilUtc: addMilliseconds(observedNowUtc, delayMs),
    });
    this.#agentBackoffs.set(agentId, backoff);
    return backoff;
  }

  #schedule(wakeAtUtc: string): void {
    this.#clearTimer();
    const nowUtc = UtcDateTimeSchema.parse(this.clock.nowUtc());
    const requestedDelayMs = Math.max(
      0,
      Date.parse(wakeAtUtc) - Date.parse(nowUtc),
    );
    const delayMs = Math.min(requestedDelayMs, MAX_TIMER_DELAY_MS);
    this.#nextWakeAtUtc = addMilliseconds(nowUtc, delayMs);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#nextWakeAtUtc = undefined;
      void this.tick();
    }, delayMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

function actionableAt(task: Readonly<TemporalTask>, observedNowUtc: string) {
  return task.status === "claimed" &&
    task.leaseExpiresAtUtc !== undefined &&
    Date.parse(task.leaseExpiresAtUtc) > Date.parse(observedNowUtc)
    ? task.leaseExpiresAtUtc
    : task.dueAtUtc;
}

function earliestFutureBackoff(
  backoffs: ReadonlyMap<string, AgentBackoff>,
  observedNowUtc: string,
): string | undefined {
  let earliest: string | undefined;
  for (const backoff of backoffs.values()) {
    if (backoff.untilUtc <= observedNowUtc) continue;
    if (earliest === undefined || backoff.untilUtc < earliest) {
      earliest = backoff.untilUtc;
    }
  }
  return earliest;
}

function earliestUtc(...values: ReadonlyArray<string | undefined>): string {
  const candidates = values.filter(
    (value): value is string => value !== undefined,
  );
  if (candidates.length === 0) {
    throw new TypeError("At least one scheduler wake time is required");
  }
  return candidates.reduce((left, right) => (left < right ? left : right));
}

function addMilliseconds(valueUtc: string, milliseconds: number): string {
  return new Date(Date.parse(valueUtc) + milliseconds).toISOString();
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(error.code)
  ) {
    return error.code;
  }
  return error instanceof Error && /^[A-Za-z0-9_-]{1,64}$/u.test(error.name)
    ? error.name
    : "unknown_error";
}
