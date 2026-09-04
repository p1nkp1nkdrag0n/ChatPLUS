import {
  EntityIdSchema,
  ReasonCodeSchema,
  UtcDateTimeSchema,
  type Letter,
  type LetterDirection,
  type TemporalTask,
  type TemporalTaskKind,
} from "@personasim/contracts";

import { createEntityId } from "../domain/id.js";
import type { ActorQueue } from "../runtime/actor-queue.js";
import type { Clock } from "../runtime/clock.js";
import type {
  ClaimDueTaskInput,
  CompleteTaskInput,
  MarkDeliveredInput,
  RetryTaskInput,
} from "../repositories/correspondence-repository.js";

const DETERMINISTIC_TASK_KINDS = [
  "letter.outbound_arrival",
  "letter.return_arrival",
] as const satisfies readonly TemporalTaskKind[];

const MODEL_TASK_KINDS = [
  "letter.reply_generation",
  "letter.generation_retry",
] as const satisfies readonly TemporalTaskKind[];

const DEFAULT_LEASE_MS = 1_800_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_TASKS_PER_PASS = 10_000;

type DeterministicTaskKind = (typeof DETERMINISTIC_TASK_KINDS)[number];
type ModelTaskKind = (typeof MODEL_TASK_KINDS)[number];

export interface TemporalCatchUpRepository {
  findEarliestDueTask(
    agentId: string,
    observedNowUtc: string,
    kinds?: readonly TemporalTaskKind[],
  ): TemporalTask | undefined;
  claimDueTask(input: ClaimDueTaskInput): TemporalTask | undefined;
  completeTask(input: CompleteTaskInput): TemporalTask;
  retryTask(input: RetryTaskInput): TemporalTask;
  getLetter(letterId: string): Letter | undefined;
  markDelivered(input: MarkDeliveredInput): Letter;
}

export interface TemporalLifeAdvancer {
  advance(agentId: string, toUtc: string): void | Promise<void>;
}

export interface ExternalTemporalTaskContext {
  readonly task: Readonly<TemporalTask>;
  readonly observedNowUtc: string;
}

export interface PreparedExternalTemporalTaskContext extends ExternalTemporalTaskContext {
  readonly prepared: unknown;
}

export interface CompletedExternalTemporalTaskContext extends PreparedExternalTemporalTaskContext {
  readonly result: unknown;
}

/**
 * The prepare and commit callbacks execute inside the per-agent ActorQueue and
 * must remain synchronous, short database/domain operations. Only `execute`
 * runs outside that lock and may call a model or another external provider.
 * Commit must be idempotent because an external execution can be repeated
 * after a crash even though its business result may only commit once.
 */
export interface ExternalTemporalTaskHandler {
  readonly kinds?: readonly ModelTaskKind[];
  prepare?(context: ExternalTemporalTaskContext): unknown;
  execute(context: PreparedExternalTemporalTaskContext): Promise<unknown>;
  commit(context: CompletedExternalTemporalTaskContext): void;
}

export type OutboundArrivalHandlerMode = "shadow" | "enforced";

/**
 * Optional deterministic arrival seam used by correspondence snapshot
 * freezing. It runs synchronously inside the same per-agent ActorQueue section
 * as the effective-time life advance and database claim. The handler owns the
 * complete outbound-arrival transaction, including task completion.
 *
 * `mode` is deliberately visible at this boundary: shadow may freeze the
 * deterministic snapshot and enqueue generation, but the caller must not also
 * register a model-backed external handler in that mode.
 */
export interface OutboundArrivalTaskHandler {
  readonly mode: OutboundArrivalHandlerMode;
  commit(context: ExternalTemporalTaskContext): void;
}

export interface TemporalCatchUpServiceOptions {
  readonly leaseMs?: number;
  readonly externalRetryDelayMs?: number;
  readonly maxTasksPerPass?: number;
  readonly createClaimToken?: (task: Readonly<TemporalTask>) => string;
  readonly externalTaskHandler?: ExternalTemporalTaskHandler;
  readonly outboundArrivalTaskHandler?: OutboundArrivalTaskHandler;
}

export interface TemporalCatchUpResult {
  readonly agentId: string;
  readonly observedNowUtc: string;
  readonly completedTaskIds: readonly string[];
  readonly retriedTaskIds: readonly string[];
  readonly externalExecutionCount: number;
  readonly blockedTaskId?: string;
  readonly finalAdvancedToUtc: string;
}

export type TemporalCatchUpErrorCode =
  | "invalid_configuration"
  | "task_claim_mismatch"
  | "task_direction_mismatch"
  | "task_not_found"
  | "task_limit_exceeded"
  | "locked_handler_must_be_synchronous";

export class TemporalCatchUpError extends Error {
  constructor(
    readonly code: TemporalCatchUpErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TemporalCatchUpError";
  }
}

type CatchUpStep =
  | { readonly type: "none" }
  | { readonly type: "raced" }
  | {
      readonly type: "blocked";
      readonly taskId: string;
      readonly effectiveBoundaryUtc: string;
    }
  | { readonly type: "completed"; readonly taskId: string }
  | { readonly type: "retried"; readonly taskId: string }
  | {
      readonly type: "external";
      readonly task: Readonly<TemporalTask>;
      readonly prepared: unknown;
    };

/**
 * Processes one character's eligible temporal work in effective-time order.
 *
 * Public callers must invoke this before entering their own ActorQueue section;
 * ActorQueue is intentionally non-reentrant. The service acquires only short
 * per-task critical sections and releases the actor while external work runs.
 */
export class TemporalCatchUpService {
  readonly #passTails = new Map<string, Promise<void>>();
  readonly #leaseMs: number;
  readonly #externalRetryDelayMs: number;
  readonly #maxTasksPerPass: number;
  readonly #createClaimToken: (task: Readonly<TemporalTask>) => string;
  readonly #externalTaskHandler: ExternalTemporalTaskHandler | undefined;
  readonly #outboundArrivalTaskHandler: OutboundArrivalTaskHandler | undefined;
  readonly #handledKinds: readonly TemporalTaskKind[];

  constructor(
    private readonly repository: TemporalCatchUpRepository,
    private readonly life: TemporalLifeAdvancer,
    private readonly actors: Pick<ActorQueue, "runExclusive">,
    private readonly clock: Clock,
    options: TemporalCatchUpServiceOptions = {},
  ) {
    this.#leaseMs = positiveInteger(
      options.leaseMs ?? DEFAULT_LEASE_MS,
      "leaseMs",
    );
    this.#externalRetryDelayMs = positiveInteger(
      options.externalRetryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "externalRetryDelayMs",
    );
    this.#maxTasksPerPass = positiveInteger(
      options.maxTasksPerPass ?? DEFAULT_MAX_TASKS_PER_PASS,
      "maxTasksPerPass",
    );
    this.#createClaimToken =
      options.createClaimToken ?? (() => createEntityId("temporal_claim"));
    this.#externalTaskHandler = options.externalTaskHandler;
    this.#outboundArrivalTaskHandler = options.outboundArrivalTaskHandler;

    if (
      options.outboundArrivalTaskHandler?.mode === "shadow" &&
      options.externalTaskHandler !== undefined
    ) {
      throw new TemporalCatchUpError(
        "invalid_configuration",
        "Shadow outbound arrival must not register a model-backed task handler",
      );
    }

    const externalKinds =
      options.externalTaskHandler === undefined
        ? []
        : [...(options.externalTaskHandler.kinds ?? MODEL_TASK_KINDS)];
    if (
      externalKinds.some(
        (kind) =>
          !(MODEL_TASK_KINDS as readonly TemporalTaskKind[]).includes(kind),
      )
    ) {
      throw new TemporalCatchUpError(
        "invalid_configuration",
        "External temporal handlers may only claim model-backed task kinds",
        { externalKinds },
      );
    }
    this.#handledKinds = [...DETERMINISTIC_TASK_KINDS, ...externalKinds];
  }

  catchUpAgent(
    agentId: string,
    observedNowUtc = this.clock.nowUtc(),
  ): Promise<TemporalCatchUpResult> {
    EntityIdSchema.parse(agentId);
    UtcDateTimeSchema.parse(observedNowUtc);

    const predecessor = this.#passTails.get(agentId) ?? Promise.resolve();
    const result = predecessor
      .catch(() => undefined)
      .then(() => this.#runCatchUpPass(agentId, observedNowUtc));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#passTails.set(agentId, tail);
    void tail.then(() => {
      if (this.#passTails.get(agentId) === tail) {
        this.#passTails.delete(agentId);
      }
    });
    return result;
  }

  async #runCatchUpPass(
    agentId: string,
    observedNowUtc: string,
  ): Promise<TemporalCatchUpResult> {
    const completedTaskIds: string[] = [];
    const retriedTaskIds: string[] = [];
    let externalExecutionCount = 0;
    let iterations = 0;

    while (true) {
      if (iterations >= this.#maxTasksPerPass) {
        throw new TemporalCatchUpError(
          "task_limit_exceeded",
          `Temporal catch-up exceeded ${this.#maxTasksPerPass} tasks in one pass`,
          { agentId, observedNowUtc, completedTaskIds, retriedTaskIds },
        );
      }

      const step = await this.actors.runExclusive(agentId, () =>
        this.#claimAndPrepareNext(agentId, observedNowUtc),
      );
      if (step.type === "none") break;
      if (step.type === "blocked") {
        // An active queue head is an ordering barrier. By protocol, its owner
        // advanced life to the due boundary before taking the claim, so this
        // pass reports that known boundary without repeating the advance. It
        // must not process later tasks or jump life to observedNow.
        return Object.freeze({
          agentId,
          observedNowUtc,
          completedTaskIds: Object.freeze([...completedTaskIds]),
          retriedTaskIds: Object.freeze([...retriedTaskIds]),
          externalExecutionCount,
          blockedTaskId: step.taskId,
          finalAdvancedToUtc: step.effectiveBoundaryUtc,
        });
      }
      iterations += 1;
      if (step.type === "raced") continue;
      if (step.type === "completed") {
        completedTaskIds.push(step.taskId);
        continue;
      }
      if (step.type === "retried") {
        retriedTaskIds.push(step.taskId);
        continue;
      }

      externalExecutionCount += 1;
      const externalOutcome = await this.#executeExternalStep(
        step,
        observedNowUtc,
      );
      if (externalOutcome === "completed") {
        completedTaskIds.push(step.task.id);
      } else {
        retriedTaskIds.push(step.task.id);
      }
    }

    // Deliberately not in a finally block: a failed effective-time advance or
    // deterministic commit must prevent the pass from jumping to observedNow.
    await this.actors.runExclusive(agentId, () =>
      this.life.advance(agentId, observedNowUtc),
    );

    return Object.freeze({
      agentId,
      observedNowUtc,
      completedTaskIds: Object.freeze([...completedTaskIds]),
      retriedTaskIds: Object.freeze([...retriedTaskIds]),
      externalExecutionCount,
      finalAdvancedToUtc: observedNowUtc,
    });
  }

  async #claimAndPrepareNext(
    agentId: string,
    observedNowUtc: string,
  ): Promise<CatchUpStep> {
    const candidate = this.repository.findEarliestDueTask(
      agentId,
      observedNowUtc,
      this.#handledKinds,
    );
    if (candidate === undefined) return { type: "none" };

    if (isActivelyClaimed(candidate, observedNowUtc)) {
      return {
        type: "blocked",
        taskId: candidate.id,
        effectiveBoundaryUtc: candidate.dueAtUtc,
      };
    }

    // This is intentionally before the database claim. If fuzzy-life advance
    // fails, the task is untouched and remains eligible for the next pass.
    await this.life.advance(agentId, candidate.dueAtUtc);

    const claimToken = EntityIdSchema.parse(this.#createClaimToken(candidate));
    const claimed = this.repository.claimDueTask({
      taskId: candidate.id,
      agentId,
      kinds: this.#handledKinds,
      nowUtc: observedNowUtc,
      leaseExpiresAtUtc: addMilliseconds(observedNowUtc, this.#leaseMs),
      claimToken,
    } satisfies ClaimDueTaskInput);
    if (claimed === undefined) return { type: "raced" };
    if (claimed.id !== candidate.id) {
      throw new TemporalCatchUpError(
        "task_claim_mismatch",
        "The claimed temporal task differed from the effective-time candidate",
        { candidateTaskId: candidate.id, claimedTaskId: claimed.id },
      );
    }

    if (isDeterministicKind(claimed.kind)) {
      try {
        this.#commitDeterministicTask(claimed, observedNowUtc);
        return { type: "completed", taskId: claimed.id };
      } catch (error) {
        this.#retryClaimedTask(
          claimed,
          claimed.dueAtUtc,
          observedNowUtc,
          error,
        );
        throw error;
      }
    }

    const handler = this.#externalTaskHandler;
    if (handler === undefined || !isModelKind(claimed.kind)) {
      throw new TemporalCatchUpError(
        "invalid_configuration",
        `No external handler is registered for ${claimed.kind}`,
        { taskId: claimed.id, kind: claimed.kind },
      );
    }

    try {
      const context = Object.freeze({ task: claimed, observedNowUtc });
      const prepared = handler.prepare?.(context);
      assertNotPromiseLike(prepared, "prepare", claimed.id);
      return { type: "external", task: claimed, prepared };
    } catch (error) {
      this.#retryClaimedTask(
        claimed,
        addMilliseconds(observedNowUtc, this.#externalRetryDelayMs),
        observedNowUtc,
        error,
      );
      return { type: "retried", taskId: claimed.id };
    }
  }

  #commitDeterministicTask(
    task: Readonly<TemporalTask>,
    processedAtUtc: string,
  ): void {
    const letter = this.repository.getLetter(task.entityId);
    if (letter === undefined) {
      throw new TemporalCatchUpError(
        "task_not_found",
        `Temporal task ${task.id} references a missing letter`,
        { taskId: task.id, letterId: task.entityId },
      );
    }
    const expectedDirection: LetterDirection =
      task.kind === "letter.outbound_arrival"
        ? "user_to_agent"
        : "agent_to_user";
    if (letter.direction !== expectedDirection) {
      throw new TemporalCatchUpError(
        "task_direction_mismatch",
        `${task.kind} cannot deliver a ${letter.direction} letter`,
        {
          taskId: task.id,
          letterId: letter.id,
          expectedDirection,
          actualDirection: letter.direction,
        },
      );
    }

    if (
      task.kind === "letter.outbound_arrival" &&
      this.#outboundArrivalTaskHandler !== undefined
    ) {
      const commitResult = this.#outboundArrivalTaskHandler.commit(
        Object.freeze({ task, observedNowUtc: processedAtUtc }),
      );
      assertNotPromiseLike(commitResult, "outboundArrival", task.id);
      return;
    }

    // These writes intentionally form a replay-safe pair even when the
    // repository cannot expose a cross-method transaction: markDelivered is
    // idempotent, while completeTask is claim-token CAS protected. If a crash
    // or transient error happens between them, retryTask keeps the same
    // effective due time and the next pass converges by replaying delivery.
    this.repository.markDelivered({
      letterId: letter.id,
      effectiveAtUtc: task.dueAtUtc,
      processedAtUtc,
    } satisfies MarkDeliveredInput);
    this.repository.completeTask({
      taskId: task.id,
      claimToken: requiredClaimToken(task),
      completedAtUtc: processedAtUtc,
    } satisfies CompleteTaskInput);
  }

  async #executeExternalStep(
    step: Extract<CatchUpStep, { type: "external" }>,
    observedNowUtc: string,
  ): Promise<"completed" | "retried"> {
    const handler = this.#externalTaskHandler!;
    const preparedContext = Object.freeze({
      task: step.task,
      observedNowUtc,
      prepared: step.prepared,
    });

    let result: unknown;
    try {
      result = await handler.execute(preparedContext);
    } catch (error) {
      await this.actors.runExclusive(step.task.agentId, () =>
        this.#retryClaimedTask(
          step.task,
          addMilliseconds(observedNowUtc, this.#externalRetryDelayMs),
          observedNowUtc,
          error,
        ),
      );
      return "retried";
    }

    try {
      await this.actors.runExclusive(step.task.agentId, () => {
        const commitResult = handler.commit(
          Object.freeze({ ...preparedContext, result }),
        );
        assertNotPromiseLike(commitResult, "commit", step.task.id);
        this.repository.completeTask({
          taskId: step.task.id,
          claimToken: requiredClaimToken(step.task),
          completedAtUtc: observedNowUtc,
        });
      });
      return "completed";
    } catch (error) {
      await this.actors.runExclusive(step.task.agentId, () =>
        this.#retryClaimedTask(
          step.task,
          addMilliseconds(observedNowUtc, this.#externalRetryDelayMs),
          observedNowUtc,
          error,
        ),
      );
      return "retried";
    }
  }

  #retryClaimedTask(
    task: Readonly<TemporalTask>,
    nextDueAtUtc: string,
    processedAtUtc: string,
    error: unknown,
  ): void {
    const retryable = retryableDisposition(error);
    const effectiveNextDueAtUtc = retryable
      ? retryDueAtUtc(error, processedAtUtc, nextDueAtUtc)
      : undefined;
    this.repository.retryTask({
      taskId: task.id,
      claimToken: requiredClaimToken(task),
      errorCode: safeErrorCode(error),
      nowUtc: processedAtUtc,
      retryable,
      ...(effectiveNextDueAtUtc === undefined
        ? {}
        : { nextDueAtUtc: effectiveNextDueAtUtc }),
    } satisfies RetryTaskInput);
  }
}

function isDeterministicKind(
  kind: TemporalTaskKind,
): kind is DeterministicTaskKind {
  return (DETERMINISTIC_TASK_KINDS as readonly TemporalTaskKind[]).includes(
    kind,
  );
}

function isModelKind(kind: TemporalTaskKind): kind is ModelTaskKind {
  return (MODEL_TASK_KINDS as readonly TemporalTaskKind[]).includes(kind);
}

function isActivelyClaimed(
  task: Readonly<TemporalTask>,
  observedNowUtc: string,
): boolean {
  return (
    task.status === "claimed" &&
    task.leaseExpiresAtUtc !== undefined &&
    Date.parse(task.leaseExpiresAtUtc) > Date.parse(observedNowUtc)
  );
}

function requiredClaimToken(task: Readonly<TemporalTask>): string {
  if (task.claimToken !== undefined) return task.claimToken;
  throw new TemporalCatchUpError(
    "task_claim_mismatch",
    `Claimed temporal task ${task.id} has no claim token`,
    { taskId: task.id },
  );
}

function addMilliseconds(valueUtc: string, milliseconds: number): string {
  return new Date(Date.parse(valueUtc) + milliseconds).toISOString();
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TemporalCatchUpError(
      "invalid_configuration",
      `${field} must be a positive integer`,
      { field, value },
    );
  }
  return value;
}

function assertNotPromiseLike(
  value: unknown,
  callback: "prepare" | "commit" | "outboundArrival",
  taskId: string,
): void {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    throw new TemporalCatchUpError(
      "locked_handler_must_be_synchronous",
      `External handler ${callback} must not return a Promise inside ActorQueue`,
      { callback, taskId },
    );
  }
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ReasonCodeSchema.safeParse(error.code).success
  ) {
    return String(error.code);
  }
  return "temporal_external_task_failed";
}

function retryableDisposition(error: unknown): boolean {
  return !(
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === false
  );
}

function retryDueAtUtc(
  error: unknown,
  processedAtUtc: string,
  fallbackDueAtUtc: string,
): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "retryDelayMs" in error &&
    typeof error.retryDelayMs === "number" &&
    Number.isInteger(error.retryDelayMs) &&
    error.retryDelayMs > 0
  ) {
    return addMilliseconds(processedAtUtc, error.retryDelayMs);
  }
  return fallbackDueAtUtc;
}
