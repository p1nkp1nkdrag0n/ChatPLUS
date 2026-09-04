import { createHash } from "node:crypto";

import {
  EncryptedLetterBodySchema,
  LetterReplyGenerationTaskPayloadSchema,
  LetterReplyProposalSchema,
  ReasonCodeSchema,
  type EncryptedLetterBody,
  type Letter,
  type LetterGenerationRun,
  type LetterGenerationSnapshot,
  type LetterReplyGenerationTaskPayload,
  type LetterReplyProposal,
  type TemporalTask,
} from "@personasim/contracts";
import {
  buildLetterReplyPrompt,
  calculateFixedTransitArrivalUtc,
  canonicalCorrespondenceJson,
  canonicalLetterContent,
  canonicalLetterGenerationSnapshot,
  canonicalLetterReplyContent,
  deriveAllowedLetterReplyReferenceIds,
  deriveLetterStrategy,
  type LetterReplyPrompt,
} from "@personasim/features";
import type { ZodType } from "zod";

import type {
  CommitGenerationRunResult,
  CorrespondenceRepository,
  RetryGenerationRunInput,
} from "../repositories/correspondence-repository.js";
import type {
  ExternalTemporalTaskContext,
  ExternalTemporalTaskHandler,
} from "./temporal-catch-up-service.js";

const GENERATION_TASK_KINDS = [
  "letter.reply_generation",
  "letter.generation_retry",
] as const;
const MAX_EXECUTION_ATTEMPTS = 3;

export type LetterReplyGenerationRepository = Pick<
  CorrespondenceRepository,
  | "getLetter"
  | "getSnapshot"
  | "claimGenerationRun"
  | "getGenerationRun"
  | "getGenerationRunForEpoch"
  | "commitGenerationRun"
  | "retryGenerationRun"
>;

export interface LetterReplyModelRequest<T> {
  purpose: "letter_reply";
  system: string;
  prompt: string;
  schema: ZodType<T>;
  agentId: string;
  maxRetries?: number;
  maxOutputTokens?: number;
}

export interface LetterReplyModel {
  generateObject<T>(input: LetterReplyModelRequest<T>): Promise<T>;
}

export interface LetterReplyEncryptor {
  encryptReply(input: {
    letterId: string;
    direction: "agent_to_user";
    contentHash: string;
    authoredEffectiveAtUtc: string;
    arrivalDueAtUtc: string;
    proposal: LetterReplyProposal;
    createdAtUtc: string;
  }): EncryptedLetterBody;
}

export interface LetterReplyGenerationServiceOptions {
  readonly provider: string;
  readonly model: string;
  readonly providerRepairAttempts?: number;
}

export interface CommittedLetterReplyNotice {
  readonly agentId: string;
  readonly incomingLetterId: string;
  readonly replyLetterId: string;
}

export type PreparedLetterReplyGeneration =
  | {
      readonly status: "already_committed";
      readonly task: Readonly<TemporalTask>;
      readonly payload: Readonly<LetterReplyGenerationTaskPayload>;
      readonly snapshot: Readonly<LetterGenerationSnapshot>;
      readonly run: Readonly<LetterGenerationRun>;
    }
  | {
      readonly status: "claimed";
      readonly task: Readonly<TemporalTask>;
      readonly payload: Readonly<LetterReplyGenerationTaskPayload>;
      readonly incomingLetter: Readonly<Letter>;
      readonly snapshot: Readonly<LetterGenerationSnapshot>;
      readonly snapshotHash: string;
      readonly run: Readonly<LetterGenerationRun>;
      readonly prompt: Readonly<LetterReplyPrompt>;
    };

export type LetterReplyExecutionResult =
  | { readonly status: "already_committed" }
  | {
      readonly status: "succeeded";
      readonly proposal: Readonly<LetterReplyProposal>;
      readonly resultHash: string;
    }
  | {
      readonly status: "failed";
      readonly errorCode: string;
      readonly retryable: boolean;
      readonly resultHash?: string;
    };

export type LetterReplyPostflightResult =
  | {
      readonly status: "committed";
      readonly result: CommitGenerationRunResult;
    }
  | { readonly status: "already_committed" }
  | { readonly status: "discarded_stale_claim" };

export class LetterReplyGenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryDelayMs: number | undefined = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LetterReplyGenerationError";
  }
}

export class LetterReplyGenerationService {
  readonly #providerRepairAttempts: number;
  #onReplyCommitted:
    | ((notice: Readonly<CommittedLetterReplyNotice>) => void | Promise<void>)
    | undefined;

  constructor(
    private readonly repository: LetterReplyGenerationRepository,
    private readonly llm: LetterReplyModel,
    private readonly encryptor: LetterReplyEncryptor,
    private readonly options: LetterReplyGenerationServiceOptions,
  ) {
    this.#providerRepairAttempts = boundedInteger(
      options.providerRepairAttempts ?? 1,
      0,
      2,
      "providerRepairAttempts",
    );
    if (
      options.provider.trim().length === 0 ||
      options.model.trim().length === 0
    ) {
      throw new LetterReplyGenerationError(
        "letter_reply_invalid_configuration",
        "Letter reply provider and model must be non-empty",
        false,
      );
    }
  }

  setReplyCommittedHandler(
    handler: (
      notice: Readonly<CommittedLetterReplyNotice>,
    ) => void | Promise<void>,
  ): void {
    this.#onReplyCommitted = handler;
  }

  createExternalHandler(): ExternalTemporalTaskHandler {
    return {
      kinds: GENERATION_TASK_KINDS,
      prepare: (context) => this.preflight(context),
      execute: ({ prepared }) => this.compose(this.requirePrepared(prepared)),
      commit: ({ prepared, result, observedNowUtc }) => {
        this.postflight(
          this.requirePrepared(prepared),
          this.requireExecutionResult(result),
          observedNowUtc,
        );
      },
    };
  }

  preflight(
    context: ExternalTemporalTaskContext,
  ): PreparedLetterReplyGeneration {
    const { task, observedNowUtc } = context;
    if (!GENERATION_TASK_KINDS.includes(task.kind as never)) {
      throw failure(
        "letter_reply_invalid_task",
        "The temporal task is not a letter generation task",
        false,
      );
    }
    if (
      task.status !== "claimed" ||
      task.claimToken === undefined ||
      task.leaseExpiresAtUtc === undefined
    ) {
      throw failure(
        "letter_reply_missing_task_claim",
        "Letter generation requires an active temporal task claim",
        false,
      );
    }
    if (task.maxAttempts !== MAX_EXECUTION_ATTEMPTS) {
      throw failure(
        "letter_reply_invalid_attempt_budget",
        "Letter generation tasks must use exactly three execution attempts",
        false,
      );
    }
    const payload = LetterReplyGenerationTaskPayloadSchema.parse(task.payload);
    if (payload.incomingLetterId !== task.entityId) {
      throw failure(
        "letter_reply_task_payload_mismatch",
        "Generation task payload does not match its incoming letter",
        false,
      );
    }

    const incomingLetter = this.repository.getLetter(payload.incomingLetterId);
    if (
      incomingLetter === undefined ||
      incomingLetter.agentId !== task.agentId ||
      incomingLetter.direction !== "user_to_agent" ||
      incomingLetter.status !== "read" ||
      incomingLetter.body === undefined ||
      incomingLetter.contentHash === undefined ||
      incomingLetter.deliveredEffectiveAtUtc === undefined ||
      incomingLetter.readAtUtc !== incomingLetter.deliveredEffectiveAtUtc ||
      incomingLetter.transitTimezone === undefined
    ) {
      throw failure(
        "letter_reply_incoming_not_read",
        "Generation requires one effectively read incoming user letter",
        false,
      );
    }
    const expectedIncomingHash = sha256(
      canonicalLetterContent({
        ...(incomingLetter.subject === undefined
          ? {}
          : { subject: incomingLetter.subject }),
        body: incomingLetter.body,
      }),
    );
    if (incomingLetter.contentHash !== expectedIncomingHash) {
      throw failure(
        "letter_reply_content_hash_mismatch",
        "Incoming letter content no longer matches its sealed hash",
        false,
      );
    }

    const snapshot = this.repository.getSnapshot(payload.snapshotId);
    if (
      snapshot === undefined ||
      snapshot.incomingLetterId !== incomingLetter.id ||
      snapshot.agentId !== task.agentId ||
      snapshot.effectiveAtUtc !== incomingLetter.deliveredEffectiveAtUtc ||
      snapshot.contextJson.effectiveAtUtc !== snapshot.effectiveAtUtc
    ) {
      throw failure(
        "letter_reply_snapshot_mismatch",
        "Generation task does not match its immutable arrival snapshot",
        false,
      );
    }
    const snapshotHash = sha256(
      canonicalLetterGenerationSnapshot({
        contextJson: snapshot.contextJson,
        evidenceIds: snapshot.evidenceIds,
      }),
    );
    if (snapshot.contextHash !== snapshotHash) {
      throw failure(
        "letter_reply_snapshot_hash_mismatch",
        "Generation snapshot failed its canonical hash check",
        false,
      );
    }

    const run = this.repository.claimGenerationRun({
      incomingLetterId: incomingLetter.id,
      snapshotId: snapshot.id,
      snapshotHash,
      agentId: task.agentId,
      generationEpoch: payload.generationEpoch,
      claimToken: task.claimToken,
      nowUtc: observedNowUtc,
      leaseExpiresAtUtc: task.leaseExpiresAtUtc,
      provider: this.options.provider,
      model: this.options.model,
    });
    if (run?.status === "committed") {
      return Object.freeze({
        status: "already_committed",
        task,
        payload,
        snapshot,
        run,
      });
    }
    if (
      run === undefined ||
      run.status !== "generating" ||
      run.claimToken !== task.claimToken ||
      run.generationEpoch !== payload.generationEpoch ||
      run.snapshotId !== snapshot.id ||
      run.attempt > MAX_EXECUTION_ATTEMPTS
    ) {
      const existingRun = run ?? this.findRunForGenerationTask(payload);
      if (existingRun?.status === "committed") {
        return Object.freeze({
          status: "already_committed",
          task,
          payload,
          snapshot,
          run: existingRun,
        });
      }
      if (existingRun?.status === "generating") {
        // A different live run claim is unreachable when task and run leases
        // obey the shared-claim protocol. Treat legacy/corrupt drift as a
        // fail-closed recovery delay: do not call the model, and do not burn
        // through task attempts before the extant run lease can be reclaimed.
        throw new LetterReplyGenerationError(
          "letter_reply_run_unavailable",
          "Another generation claim still owns this logical run",
          true,
          retryDelayUntilLease(existingRun, observedNowUtc),
        );
      }
      const isTerminal =
        existingRun?.status === "failed" || existingRun?.status === "discarded";
      throw failure(
        isTerminal
          ? "letter_reply_attempts_exhausted"
          : "letter_reply_run_unavailable",
        "The logical generation run could not be fenced for this task claim",
        !isTerminal,
      );
    }

    const characterVerbosity = numberProperty(
      snapshot.contextJson.character.dialogue,
      "verbosity",
    );
    const strategy = deriveLetterStrategy(incomingLetter.body, {
      ...(characterVerbosity === undefined ? {} : { characterVerbosity }),
      relationship: {
        closeness:
          numberProperty(snapshot.contextJson.relationship, "closeness") ?? 0.5,
        trust:
          numberProperty(snapshot.contextJson.relationship, "trust") ?? 0.5,
      },
      stationeryType: stationeryTypeFrom(snapshot.contextJson.budgets),
    });
    const prompt = buildLetterReplyPrompt({
      snapshot,
      incomingLetter: {
        id: incomingLetter.id,
        ...(incomingLetter.subject === undefined
          ? {}
          : { subject: incomingLetter.subject }),
        body: incomingLetter.body,
        contentHash: incomingLetter.contentHash,
      },
      strategy,
    });
    return Object.freeze({
      status: "claimed",
      task,
      payload,
      incomingLetter,
      snapshot,
      snapshotHash,
      run,
      prompt,
    });
  }

  async compose(
    prepared: PreparedLetterReplyGeneration,
  ): Promise<LetterReplyExecutionResult> {
    if (prepared.status === "already_committed") {
      return { status: "already_committed" };
    }
    try {
      const generated = await this.llm.generateObject({
        purpose: "letter_reply",
        system: prepared.prompt.system,
        prompt: prepared.prompt.prompt,
        schema: LetterReplyProposalSchema,
        agentId: prepared.task.agentId,
        maxRetries: this.#providerRepairAttempts,
        maxOutputTokens: prepared.prompt.maxOutputTokens,
      });
      const proposal = LetterReplyProposalSchema.parse(generated);
      const resultHash = sha256(canonicalCorrespondenceJson(proposal));
      const allowedEvidenceIds = new Set(
        deriveAllowedLetterReplyReferenceIds(prepared.snapshot),
      );
      if (
        proposal.referencedEvidenceIds.some(
          (evidenceId) => !allowedEvidenceIds.has(evidenceId),
        )
      ) {
        return Object.freeze({
          status: "failed",
          errorCode: "letter_reply_evidence_out_of_scope",
          retryable: false,
          resultHash,
        });
      }
      return Object.freeze({ status: "succeeded", proposal, resultHash });
    } catch (error) {
      return Object.freeze({
        status: "failed",
        errorCode: safeReasonCode(error, "letter_reply_model_failed"),
        retryable: true,
      });
    }
  }

  postflight(
    prepared: PreparedLetterReplyGeneration,
    execution: LetterReplyExecutionResult,
    observedNowUtc: string,
  ): LetterReplyPostflightResult {
    if (
      prepared.status === "already_committed" ||
      execution.status === "already_committed"
    ) {
      return { status: "already_committed" };
    }
    const currentRun = this.repository.getGenerationRun(prepared.run.id);
    if (
      currentRun === undefined ||
      currentRun.status !== "generating" ||
      currentRun.claimToken !== prepared.run.claimToken ||
      currentRun.generationEpoch !== prepared.payload.generationEpoch ||
      currentRun.snapshotId !== prepared.snapshot.id
    ) {
      return { status: "discarded_stale_claim" };
    }
    const currentSnapshot = this.repository.getSnapshot(prepared.snapshot.id);
    const currentSnapshotHash =
      currentSnapshot === undefined
        ? undefined
        : sha256(
            canonicalLetterGenerationSnapshot({
              contextJson: currentSnapshot.contextJson,
              evidenceIds: currentSnapshot.evidenceIds,
            }),
          );
    if (
      currentSnapshot === undefined ||
      currentSnapshot.contextHash !== prepared.snapshotHash ||
      currentSnapshotHash !== prepared.snapshotHash
    ) {
      return this.failClaimedRun(
        prepared,
        {
          status: "failed",
          errorCode: "letter_reply_snapshot_hash_mismatch",
          retryable: false,
        },
        observedNowUtc,
      );
    }
    if (execution.status === "failed") {
      return this.failClaimedRun(prepared, execution, observedNowUtc);
    }

    const replyLetterId = stableLetterReplyId(prepared.incomingLetter.id);
    const effectiveAuthorTimeUtc = prepared.snapshot.effectiveAtUtc;
    const transitTimezone = prepared.incomingLetter.transitTimezone!;
    const arrivalDueAtUtc = calculateFixedTransitArrivalUtc(
      effectiveAuthorTimeUtc,
      transitTimezone,
      "return",
    );
    const contentHash = sha256(canonicalLetterReplyContent(execution.proposal));
    let encrypted: EncryptedLetterBody;
    try {
      encrypted = EncryptedLetterBodySchema.parse(
        this.encryptor.encryptReply({
          letterId: replyLetterId,
          direction: "agent_to_user",
          contentHash,
          authoredEffectiveAtUtc: effectiveAuthorTimeUtc,
          arrivalDueAtUtc,
          proposal: execution.proposal,
          createdAtUtc: observedNowUtc,
        }),
      );
      if (encrypted.letterId !== replyLetterId) {
        throw new Error("Encrypted reply envelope used another letter ID");
      }
    } catch (error) {
      return this.failClaimedRun(
        prepared,
        {
          status: "failed",
          errorCode: "letter_reply_encryption_failed",
          retryable: false,
          resultHash: execution.resultHash,
        },
        observedNowUtc,
        error,
      );
    }
    const { letterId: encryptedLetterId, ...encryptedBody } = encrypted;
    if (encryptedLetterId !== replyLetterId) {
      throw failure(
        "letter_reply_encryption_failed",
        "Encrypted reply identity changed before commit",
        false,
      );
    }

    try {
      const result = this.repository.commitGenerationRun({
        runId: prepared.run.id,
        claimToken: prepared.run.claimToken!,
        generationEpoch: prepared.payload.generationEpoch,
        snapshotHash: prepared.snapshotHash,
        nowUtc: observedNowUtc,
        replyLetterId,
        contentHash,
        transitPolicyVersion: "fixed_5d_v1",
        transitTimezone,
        effectiveAuthorTimeUtc,
        arrivalDueAtUtc,
        encryptedBody,
        provider: this.options.provider,
        model: this.options.model,
        resultHash: execution.resultHash,
        taskId: stableReturnArrivalTaskId(replyLetterId),
        taskPriority: 30,
      });
      this.#notifyReplyCommitted({
        agentId: prepared.task.agentId,
        incomingLetterId: prepared.incomingLetter.id,
        replyLetterId: result.reply.id,
      });
      return { status: "committed", result };
    } catch (error) {
      const racedRun = this.repository.getGenerationRun(prepared.run.id);
      if (
        racedRun?.status === "committed" ||
        racedRun?.claimToken !== prepared.run.claimToken
      ) {
        return { status: "discarded_stale_claim" };
      }
      return this.failClaimedRun(
        prepared,
        {
          status: "failed",
          errorCode: safeReasonCode(error, "letter_reply_commit_failed"),
          retryable: true,
          resultHash: execution.resultHash,
        },
        observedNowUtc,
        error,
      );
    }
  }

  #notifyReplyCommitted(notice: CommittedLetterReplyNotice): void {
    const handler = this.#onReplyCommitted;
    if (handler === undefined) return;
    // The letter transaction has already committed. Keepsake work is a
    // best-effort follow-on and may never delay, roll back, or retry the reply.
    queueMicrotask(() => {
      try {
        void Promise.resolve(handler(Object.freeze({ ...notice }))).catch(
          () => undefined,
        );
      } catch {
        // Intentionally swallowed: reply durability outranks artifact creation.
      }
    });
  }

  private failClaimedRun(
    prepared: Extract<PreparedLetterReplyGeneration, { status: "claimed" }>,
    execution: Extract<LetterReplyExecutionResult, { status: "failed" }>,
    observedNowUtc: string,
    cause?: unknown,
  ): never {
    this.repository.retryGenerationRun({
      runId: prepared.run.id,
      claimToken: prepared.run.claimToken!,
      generationEpoch: prepared.payload.generationEpoch,
      errorCode: execution.errorCode,
      ...(execution.resultHash === undefined
        ? {}
        : { resultHash: execution.resultHash }),
      nowUtc: observedNowUtc,
      retryable: execution.retryable,
    } satisfies RetryGenerationRunInput);
    throw new LetterReplyGenerationError(
      execution.errorCode,
      "Letter reply generation attempt did not commit",
      execution.retryable,
      execution.retryable
        ? 60_000 * 2 ** Math.max(0, prepared.run.attempt - 1)
        : undefined,
      cause === undefined ? undefined : { cause },
    );
  }

  private findRunForGenerationTask(
    payload: LetterReplyGenerationTaskPayload,
  ): LetterGenerationRun | undefined {
    return this.repository.getGenerationRunForEpoch(
      payload.incomingLetterId,
      payload.generationEpoch,
    );
  }

  private requirePrepared(value: unknown): PreparedLetterReplyGeneration {
    if (
      typeof value !== "object" ||
      value === null ||
      !("status" in value) ||
      (value.status !== "claimed" && value.status !== "already_committed")
    ) {
      throw failure(
        "letter_reply_invalid_preflight",
        "Letter reply handler received an invalid preflight value",
        false,
      );
    }
    return value as PreparedLetterReplyGeneration;
  }

  private requireExecutionResult(value: unknown): LetterReplyExecutionResult {
    if (
      typeof value !== "object" ||
      value === null ||
      !("status" in value) ||
      !["already_committed", "succeeded", "failed"].includes(
        String(value.status),
      )
    ) {
      throw failure(
        "letter_reply_invalid_execution",
        "Letter reply handler received an invalid execution value",
        false,
      );
    }
    return value as LetterReplyExecutionResult;
  }
}

export function stableLetterReplyId(incomingLetterId: string): string {
  return `letter_reply_${sha256(`letter-reply:${incomingLetterId}:v1`).slice(0, 32)}`;
}

function stableReturnArrivalTaskId(replyLetterId: string): string {
  return `task_return_${sha256(`letter-arrival:${replyLetterId}`).slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeReasonCode(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ReasonCodeSchema.safeParse(error.code).success
  ) {
    return String(error.code);
  }
  return fallback;
}

function retryDelayUntilLease(
  run: Readonly<LetterGenerationRun>,
  observedNowUtc: string,
): number | undefined {
  if (run.leaseExpiresAtUtc === undefined) return undefined;
  const remainingMs =
    Date.parse(run.leaseExpiresAtUtc) - Date.parse(observedNowUtc);
  return Number.isFinite(remainingMs) && remainingMs >= 0
    ? Math.max(1, remainingMs + 1)
    : undefined;
}

function failure(
  code: string,
  message: string,
  retryable: boolean,
): LetterReplyGenerationError {
  return new LetterReplyGenerationError(code, message, retryable);
}

function numberProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function stationeryTypeFrom(
  budgets: Readonly<Record<string, unknown>>,
): "postcard" | "standard" | "extended" {
  const value = budgets["stationeryType"];
  return value === "postcard" || value === "extended" ? value : "standard";
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw failure(
      "letter_reply_invalid_configuration",
      `${field} must be an integer between ${minimum} and ${maximum}`,
      false,
    );
  }
  return value;
}
