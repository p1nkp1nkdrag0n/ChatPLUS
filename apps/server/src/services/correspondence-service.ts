import { createHash } from "node:crypto";

import {
  CorrespondenceMailboxQuerySchema,
  CorrespondenceMailboxResponseSchema,
  CorrespondenceThreadSummaryResponseSchema,
  CreateLetterDraftRequestSchema,
  EntityIdSchema,
  LetterDetailResponseSchema,
  LetterReplyGenerationTaskPayloadSchema,
  LetterSummaryResponseSchema,
  OpenLetterResponseSchema,
  RetryLetterReplyGenerationRequestSchema,
  RetryLetterReplyGenerationResponseSchema,
  SealLetterRequestSchema,
  UpdateLetterDraftRequestSchema,
  UtcDateTimeSchema,
  type CorrespondenceMailboxQuery,
  type CorrespondenceMailboxResponse,
  type CorrespondenceReplyState,
  type CorrespondenceThread,
  type CreateLetterDraftRequest,
  type Letter,
  type LetterDetailResponse,
  type LetterReplyProposal,
  type LetterSummaryResponse,
  type OpenLetterResponse,
  type RetryLetterReplyGenerationRequest,
  type RetryLetterReplyGenerationResponse,
  type SealLetterRequest,
  type TemporalTask,
  type UpdateLetterDraftRequest,
} from "@personasim/contracts";
import {
  calculateFixedTransitArrivalUtc,
  canonicalLetterContent,
  deriveLetterTransitProgress,
} from "@personasim/features";
import { DateTime } from "luxon";

import type { DatabaseStore } from "../db/store.js";
import type { ActorQueue } from "../runtime/actor-queue.js";
import type { Clock } from "../runtime/clock.js";
import {
  CorrespondenceRepositoryError,
  type CorrespondenceRepository,
  type CorrespondenceRepositoryErrorCode,
  type LetterWithEncryptedBody,
} from "../repositories/correspondence-repository.js";
import type { SseHub } from "../sse/hub.js";
import {
  CorrespondenceOpenError,
  type CorrespondenceCryptoService,
  type CorrespondenceMode,
  type CorrespondenceOpenService,
} from "./correspondence-crypto-service.js";
import type {
  TemporalCatchUpResult,
  TemporalCatchUpService,
} from "./temporal-catch-up-service.js";

export type CorrespondenceServiceErrorCode =
  | "not_found"
  | "invalid_cursor"
  | "correspondence_disabled"
  | "correspondence_shadow_mode"
  | "correspondence_processing_paused"
  | "correspondence_turn_in_progress"
  | "idempotency_conflict"
  | "generation_not_retryable"
  | "reply_already_committed"
  | "reply_retry_in_progress"
  | "immutable_letter"
  | "letter_not_arrived"
  | "letter_not_openable"
  | "letter_integrity_error"
  | "invalid_state";

export class CorrespondenceServiceError extends Error {
  constructor(
    readonly code: CorrespondenceServiceErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CorrespondenceServiceError";
  }
}

export interface CorrespondenceServiceOptions {
  readonly mode: CorrespondenceMode;
  readonly transitPolicyVersion?: "fixed_5d_v1";
  readonly crypto?: CorrespondenceCryptoService;
  readonly openService?: CorrespondenceOpenService;
}

export interface CreateCorrespondenceDraftInput extends CreateLetterDraftRequest {
  readonly agentId: string;
}

export interface UpdateCorrespondenceDraftInput extends UpdateLetterDraftRequest {
  readonly letterId: string;
}

export interface SealCorrespondenceLetterInput extends SealLetterRequest {
  readonly letterId: string;
}

export interface OpenCorrespondenceLetterCommand {
  readonly letterId: string;
}

export interface RetryLetterReplyGenerationCommand extends RetryLetterReplyGenerationRequest {
  readonly letterId: string;
}

export interface ProcessCorrespondenceLetterInput {
  readonly letterId: string;
  readonly observedNowUtc?: string;
}

type SafeLetterState = Readonly<
  Pick<Letter, "id" | "direction" | "status" | "updatedAtUtc">
>;
type SafeTaskState = Readonly<
  Pick<
    TemporalTask,
    "id" | "entityId" | "status" | "attempt" | "dueAtUtc" | "lastErrorCode"
  >
>;

/**
 * Application boundary for the complete correspondence lifecycle.
 *
 * Catch-up is always entered before this service acquires the shared actor
 * queue. That ordering is deliberate: TemporalCatchUpService owns its own
 * short ActorQueue sections and ActorQueue is not re-entrant.
 */
export class CorrespondenceService {
  readonly #mode: CorrespondenceMode;
  readonly #transitPolicyVersion: "fixed_5d_v1";
  readonly #crypto: CorrespondenceCryptoService | undefined;
  readonly #openService: CorrespondenceOpenService | undefined;
  #auxiliaryCatchUp:
    ((agentId: string, observedNowUtc: string) => Promise<unknown>) | undefined;
  #relatedKeepsakeIds:
    ((replyLetterId: string) => readonly string[]) | undefined;

  constructor(
    private readonly repository: CorrespondenceRepository,
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly actors: Pick<ActorQueue, "runExclusive">,
    private readonly catchUp: TemporalCatchUpService,
    private readonly sse: Pick<SseHub, "publish">,
    options: CorrespondenceServiceOptions,
  ) {
    this.#mode = options.mode;
    this.#transitPolicyVersion = options.transitPolicyVersion ?? "fixed_5d_v1";
    this.#crypto = options.crypto;
    this.#openService = options.openService;
  }

  get mode(): CorrespondenceMode {
    return this.#mode;
  }

  setAuxiliaryCatchUp(
    handler: (agentId: string, observedNowUtc: string) => Promise<unknown>,
  ): void {
    this.#auxiliaryCatchUp = handler;
  }

  setRelatedKeepsakeResolver(
    resolver: (replyLetterId: string) => readonly string[],
  ): void {
    this.#relatedKeepsakeIds = resolver;
  }

  async createDraftLetter(
    rawInput: CreateCorrespondenceDraftInput,
  ): Promise<LetterDetailResponse> {
    this.assertWritesEnabled();
    const agentId = EntityIdSchema.parse(rawInput.agentId);
    const input = CreateLetterDraftRequestSchema.parse({
      clientRequestId: rawInput.clientRequestId,
      ...(rawInput.subject === undefined ? {} : { subject: rawInput.subject }),
      body: rawInput.body,
    });
    this.requireCharacterTimezone(agentId);

    // A prior return may have become due while the process was stopped. Catch
    // it up before the database enforces the one-active-turn invariant.
    await this.catchUpAgent(agentId);

    try {
      const letter = await this.actors.runExclusive(agentId, () => {
        const thread = this.repository.openThread(agentId, {
          nowUtc: this.clock.nowUtc(),
        });
        return this.repository.createDraftLetter({
          threadId: thread.id,
          agentId,
          direction: "user_to_agent",
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          body: input.body,
          clientRequestId: input.clientRequestId,
          nowUtc: this.clock.nowUtc(),
        });
      });
      const response = this.projectLetterDetail(letter);
      this.publishInvalidation("correspondence.updated", agentId, letter.id);
      return response;
    } catch (error) {
      throw translateCorrespondenceError(error);
    }
  }

  async updateDraftLetter(
    rawInput: UpdateCorrespondenceDraftInput,
  ): Promise<LetterDetailResponse> {
    this.assertWritesEnabled();
    const letterId = EntityIdSchema.parse(rawInput.letterId);
    const input = UpdateLetterDraftRequestSchema.parse({
      ...(rawInput.subject === undefined ? {} : { subject: rawInput.subject }),
      ...(rawInput.body === undefined ? {} : { body: rawInput.body }),
    });
    const current = this.requireLetter(letterId);

    try {
      const updated = await this.actors.runExclusive(current.agentId, () =>
        this.repository.updateDraftLetter(letterId, {
          ...(input.subject === undefined ? {} : { subject: input.subject }),
          ...(input.body === undefined ? {} : { body: input.body }),
          updatedAtUtc: this.clock.nowUtc(),
        }),
      );
      const response = this.projectLetterDetail(updated);
      this.publishInvalidation(
        "correspondence.updated",
        updated.agentId,
        updated.id,
      );
      return response;
    } catch (error) {
      throw translateCorrespondenceError(error);
    }
  }

  async sealLetter(
    rawInput: SealCorrespondenceLetterInput,
  ): Promise<LetterDetailResponse> {
    this.assertWritesEnabled();
    const letterId = EntityIdSchema.parse(rawInput.letterId);
    const input = SealLetterRequestSchema.parse({
      clientRequestId: rawInput.clientRequestId,
    });
    const initial = this.requireLetter(letterId);
    if (initial.direction !== "user_to_agent") {
      throw serviceError(
        "letter_not_openable",
        "Only user-authored drafts can be sealed through this endpoint",
      );
    }

    // Never call catch-up from inside runExclusive: the catch-up service takes
    // the same per-character lock for each effective-time transition.
    await this.catchUpAgent(initial.agentId);

    try {
      const sealed = await this.actors.runExclusive(initial.agentId, () => {
        const current = this.requireLetter(letterId);
        if (current.status !== "draft") {
          if (this.readSealRequestId(letterId) === input.clientRequestId) {
            return current;
          }
          throw serviceError(
            "immutable_letter",
            "This letter has already been sealed and cannot be changed",
            { letterId, status: current.status },
          );
        }
        if (current.body === undefined || current.body.trim().length === 0) {
          throw serviceError(
            "invalid_state",
            "A non-empty user letter body is required before sealing",
          );
        }
        const dispatchedAtUtc = UtcDateTimeSchema.parse(this.clock.nowUtc());
        const transitTimezone = this.requireCharacterTimezone(current.agentId);
        const arrivalDueAtUtc = calculateFixedTransitArrivalUtc(
          dispatchedAtUtc,
          transitTimezone,
          "outbound",
        );
        const contentHash = sha256(
          canonicalLetterContent({
            ...(current.subject === undefined
              ? {}
              : { subject: current.subject }),
            body: current.body,
          }),
        );
        return this.repository.sealLetter({
          letterId,
          contentHash,
          transitPolicyVersion: this.#transitPolicyVersion,
          transitTimezone,
          dispatchedAtUtc,
          arrivalDueAtUtc,
          effectiveAuthorTimeUtc: dispatchedAtUtc,
          clientRequestId: input.clientRequestId,
        }).letter;
      });
      const response = this.projectLetterDetail(sealed);
      this.publishInvalidation(
        "correspondence.updated",
        sealed.agentId,
        sealed.id,
      );
      return response;
    } catch (error) {
      // A cross-process winner may have committed after the pre-lock read.
      const raced = this.repository.getLetter(letterId);
      if (
        raced !== undefined &&
        raced.status !== "draft" &&
        this.readSealRequestId(letterId) === input.clientRequestId
      ) {
        return this.projectLetterDetail(raced);
      }
      throw translateCorrespondenceError(error);
    }
  }

  async listCorrespondence(
    agentIdInput: string,
    input: Partial<CorrespondenceMailboxQuery> = {},
  ): Promise<CorrespondenceMailboxResponse> {
    const agentId = EntityIdSchema.parse(agentIdInput);
    const query = CorrespondenceMailboxQuerySchema.parse(input);
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeMailboxCursor(query.cursor, agentId);
    this.requireCharacterTimezone(agentId);
    await this.catchUpAgent(agentId);
    const nowUtc = UtcDateTimeSchema.parse(this.clock.nowUtc());
    const page = this.repository.listLetterPage(agentId, {
      limit: query.limit,
      ...(cursor === undefined
        ? {}
        : {
            cursor: {
              createdAtUtc: cursor.createdAtUtc,
              rowId: cursor.rowId,
            },
          }),
    });
    const threadIds = new Set(page.items.map((letter) => letter.threadId));
    const openThread = this.repository.findOpenThread(agentId);
    if (openThread !== undefined) threadIds.add(openThread.id);
    const threads = this.repository
      .listThreadsByIds(agentId, [...threadIds])
      .map((thread) => this.projectThread(thread));
    const letters = page.items.map((letter) =>
      this.projectLetterSummary(
        letter,
        nowUtc,
        letter.direction === "agent_to_user" && letter.status === "read"
          ? this.decryptOpenedReply(letter)
          : undefined,
      ),
    );
    return CorrespondenceMailboxResponseSchema.parse({
      threads,
      letters,
      serverTimeUtc: nowUtc,
      ...(page.nextCursor === undefined
        ? {}
        : {
            nextCursor: encodeMailboxCursor({
              version: 1,
              scope: "correspondence_mailbox",
              agentId,
              createdAtUtc: page.nextCursor.createdAtUtc,
              rowId: page.nextCursor.rowId,
            }),
          }),
    });
  }

  async getLetterDetail(letterIdInput: string): Promise<LetterDetailResponse> {
    const letterId = EntityIdSchema.parse(letterIdInput);
    const initial = this.requireLetter(letterId);
    await this.catchUpAgent(initial.agentId);
    return this.projectLetterDetail(this.requireLetter(letterId));
  }

  async openLetter(
    rawInput: OpenCorrespondenceLetterCommand,
  ): Promise<OpenLetterResponse> {
    const letterId = EntityIdSchema.parse(rawInput.letterId);
    const initial = this.requireLetter(letterId);
    const nowUtc = UtcDateTimeSchema.parse(this.clock.nowUtc());

    if (this.#mode === "off") {
      if (
        (initial.status === "sealed" || initial.status === "in_transit") &&
        initial.arrivalDueAtUtc !== undefined &&
        Date.parse(initial.arrivalDueAtUtc) <= Date.parse(nowUtc)
      ) {
        throw serviceError(
          "correspondence_processing_paused",
          "Correspondence processing is paused while this arrived letter remains pending",
          { letterId },
        );
      }
    } else {
      await this.catchUpAgent(initial.agentId, nowUtc);
    }

    const openService = this.#openService;
    if (openService === undefined) {
      throw serviceError(
        "correspondence_processing_paused",
        "Encrypted correspondence is not available for this instance",
      );
    }

    try {
      const opened = await this.actors.runExclusive(initial.agentId, () =>
        openService.openLetter({
          letterId,
          agentId: initial.agentId,
          openedAtUtc: UtcDateTimeSchema.parse(this.clock.nowUtc()),
        }),
      );
      const letter = this.requireLetter(letterId);
      const response = projectOpenLetter(
        this.projectLetterSummary(
          letter,
          UtcDateTimeSchema.parse(this.clock.nowUtc()),
          opened.proposal,
        ),
        opened.proposal,
        this.#relatedKeepsakeIds?.(letter.id) ?? [],
      );
      if (!opened.replayed) {
        this.publishInvalidation("letter.opened", letter.agentId, letter.id);
        this.publishInvalidation(
          "correspondence.updated",
          letter.agentId,
          letter.id,
        );
      }
      return response;
    } catch (error) {
      throw translateCorrespondenceError(error);
    }
  }

  async retryLetterReplyGeneration(
    rawInput: RetryLetterReplyGenerationCommand,
  ): Promise<RetryLetterReplyGenerationResponse> {
    this.assertWritesEnabled();
    const letterId = EntityIdSchema.parse(rawInput.letterId);
    const input = RetryLetterReplyGenerationRequestSchema.parse({
      clientRequestId: rawInput.clientRequestId,
    });
    const incoming = this.requireLetter(letterId);
    this.requireCharacterTimezone(incoming.agentId);
    const requestedAtUtc = UtcDateTimeSchema.parse(this.clock.nowUtc());

    try {
      const result = await this.actors.runExclusive(incoming.agentId, () =>
        this.repository.enqueueReplyGenerationRetry({
          incomingLetterId: incoming.id,
          clientRequestId: input.clientRequestId,
          requestedAtUtc,
          source: "local_user",
        }),
      );
      if (!result.replayed) {
        this.publishInvalidation(
          "correspondence.updated",
          incoming.agentId,
          incoming.id,
        );
      }
      return RetryLetterReplyGenerationResponseSchema.parse({
        incomingLetterId: result.incomingLetterId,
        replayed: result.replayed,
      });
    } catch (error) {
      throw translateReplyGenerationRetryError(error);
    }
  }

  async catchUpAgent(
    agentIdInput: string,
    observedNowUtc = this.clock.nowUtc(),
  ): Promise<TemporalCatchUpResult | undefined> {
    const agentId = EntityIdSchema.parse(agentIdInput);
    UtcDateTimeSchema.parse(observedNowUtc);
    let result: TemporalCatchUpResult | undefined;
    if (this.#mode !== "off") {
      const beforeLetters = this.captureLetterState(agentId);
      const beforeTasks = this.captureTaskState(agentId);
      try {
        result = await this.catchUp.catchUpAgent(agentId, observedNowUtc);
      } finally {
        this.publishCatchUpInvalidations(agentId, beforeLetters, beforeTasks);
      }
    }
    await this.#auxiliaryCatchUp?.(agentId, observedNowUtc);
    return result;
  }

  async processLetter(
    input: ProcessCorrespondenceLetterInput,
  ): Promise<TemporalCatchUpResult> {
    const letter = this.requireLetter(EntityIdSchema.parse(input.letterId));
    if (this.#mode === "off") {
      throw serviceError(
        "correspondence_processing_paused",
        "Correspondence processing is disabled",
      );
    }
    const result = await this.catchUpAgent(
      letter.agentId,
      input.observedNowUtc ?? this.clock.nowUtc(),
    );
    if (result === undefined) {
      throw serviceError(
        "correspondence_processing_paused",
        "Correspondence processing is disabled",
      );
    }
    return result;
  }

  listTemporalTasks(
    agentIdInput: string,
    limit = 100,
  ): readonly TemporalTask[] {
    const agentId = EntityIdSchema.parse(agentIdInput);
    this.requireCharacterTimezone(agentId);
    return this.repository.listTasks(agentId, limit);
  }

  private projectLetterDetail(
    letter: LetterWithEncryptedBody,
  ): LetterDetailResponse {
    const nowUtc = UtcDateTimeSchema.parse(this.clock.nowUtc());
    if (letter.direction === "user_to_agent") {
      return LetterDetailResponseSchema.parse({
        letter: this.projectLetterSummary(letter, nowUtc),
        ...(letter.subject === undefined ? {} : { subject: letter.subject }),
        body: letter.body,
      });
    }
    if (letter.status !== "read") {
      return LetterDetailResponseSchema.parse({
        letter: this.projectLetterSummary(letter, nowUtc),
      });
    }

    const proposal = this.decryptOpenedReply(letter);
    return LetterDetailResponseSchema.parse({
      letter: this.projectLetterSummary(letter, nowUtc, proposal),
      subject: proposal.subject,
      body: proposal.paragraphs.join("\n\n"),
      salutation: proposal.salutation,
      closing: proposal.closing,
      signature: proposal.signature,
      ...(proposal.postscript === undefined
        ? {}
        : { postscript: proposal.postscript }),
      relatedKeepsakeIds: this.#relatedKeepsakeIds?.(letter.id) ?? [],
    });
  }

  private projectLetterSummary(
    letter: Readonly<Letter>,
    observedNowUtc: string,
    proposal?: Readonly<LetterReplyProposal>,
  ): LetterSummaryResponse {
    const timezone =
      letter.transitTimezone ?? this.requireCharacterTimezone(letter.agentId);
    const authoredAtUtc = letter.effectiveAuthorTimeUtc ?? letter.createdAtUtc;
    const authoredDisplayDate = DateTime.fromISO(authoredAtUtc, {
      zone: "utc",
    })
      .setZone(timezone)
      .toISODate();
    if (authoredDisplayDate === null) {
      throw serviceError(
        "invalid_state",
        "Letter authored time could not be projected",
        { letterId: letter.id },
      );
    }
    const previewText =
      letter.direction === "user_to_agent"
        ? preview(letter.body)
        : letter.status === "read" && proposal !== undefined
          ? preview(proposal.paragraphs.join(" "))
          : undefined;
    return LetterSummaryResponseSchema.parse({
      id: letter.id,
      threadId: letter.threadId,
      direction: letter.direction,
      status: letter.status,
      authoredDisplayDate,
      ...(letter.dispatchedAtUtc === undefined
        ? {}
        : { dispatchedAtUtc: letter.dispatchedAtUtc }),
      ...(letter.arrivalDueAtUtc === undefined
        ? {}
        : { arrivalDueAtUtc: letter.arrivalDueAtUtc }),
      progress: deriveLetterTransitProgress(letter, observedNowUtc),
      postmark: `${authoredDisplayDate} · ${timezone}`,
      canOpen:
        letter.direction === "agent_to_user" &&
        (letter.status === "delivered_unread" || letter.status === "read"),
      canEdit:
        letter.direction === "user_to_agent" && letter.status === "draft",
      ...(previewText === undefined ? {} : { previewText }),
    });
  }

  private projectThread(
    thread: Readonly<CorrespondenceThread>,
  ): ReturnType<typeof CorrespondenceThreadSummaryResponseSchema.parse> {
    const replyState = this.projectReplyState(thread);
    return CorrespondenceThreadSummaryResponseSchema.parse({
      id: thread.id,
      agentId: thread.agentId,
      status: thread.status,
      ...(thread.rootLetterId === undefined
        ? {}
        : { rootLetterId: thread.rootLetterId }),
      ...(thread.latestLetterId === undefined
        ? {}
        : { latestLetterId: thread.latestLetterId }),
      ...(replyState === undefined ? {} : { replyState }),
    });
  }

  private projectReplyState(
    thread: Readonly<CorrespondenceThread>,
  ): CorrespondenceReplyState | undefined {
    if (thread.status !== "open" || thread.latestLetterId === undefined) {
      return undefined;
    }
    const incoming = this.repository.getLetter(thread.latestLetterId);
    if (
      incoming === undefined ||
      incoming.agentId !== thread.agentId ||
      incoming.direction !== "user_to_agent" ||
      incoming.status !== "read"
    ) {
      return undefined;
    }

    const task = this.repository.findLatestGenerationTask(incoming.id);
    if (task === undefined || task.status === "completed") {
      // The thread was read before the task. A resident/hosted worker may have
      // committed the reply and completed the task between those reads, so
      // confirm the durable outcome after observing the terminal task state.
      if (
        this.repository.findCommittedRun(incoming.id) !== undefined ||
        this.repository.findReplyToLetter(incoming.id) !== undefined
      ) {
        return undefined;
      }
      return {
        kind: "failed",
        incomingLetterId: incoming.id,
        canRetry: false,
      };
    }
    if (task.agentId !== incoming.agentId) {
      return {
        kind: "failed",
        incomingLetterId: incoming.id,
        canRetry: false,
      };
    }
    if (task.status !== "dead_letter") {
      return {
        kind:
          task.kind === "letter.generation_retry"
            ? "retry_scheduled"
            : "waiting",
        incomingLetterId: incoming.id,
      };
    }

    const payload = LetterReplyGenerationTaskPayloadSchema.safeParse(
      task.payload,
    );
    const run = payload.success
      ? this.repository.getGenerationRunForEpoch(
          incoming.id,
          payload.data.generationEpoch,
        )
      : undefined;
    const snapshot =
      run === undefined
        ? undefined
        : this.repository.getSnapshot(run.snapshotId);
    if (
      this.repository.findCommittedRun(incoming.id) !== undefined ||
      this.repository.findReplyToLetter(incoming.id) !== undefined
    ) {
      return undefined;
    }
    const canRetry =
      this.#mode === "enforced" &&
      payload.success &&
      payload.data.incomingLetterId === incoming.id &&
      run?.status === "failed" &&
      run.agentId === incoming.agentId &&
      run.snapshotId === payload.data.snapshotId &&
      snapshot?.id === payload.data.snapshotId &&
      snapshot.agentId === incoming.agentId &&
      snapshot.incomingLetterId === incoming.id &&
      task.agentId === incoming.agentId;
    return {
      kind: "failed",
      incomingLetterId: incoming.id,
      canRetry,
    };
  }

  private decryptOpenedReply(
    letter: LetterWithEncryptedBody,
  ): LetterReplyProposal {
    if (
      this.#crypto === undefined ||
      letter.encryptedBody === undefined ||
      letter.contentHash === undefined ||
      letter.effectiveAuthorTimeUtc === undefined ||
      letter.arrivalDueAtUtc === undefined
    ) {
      throw serviceError(
        "letter_integrity_error",
        "Letter integrity verification failed",
      );
    }
    try {
      return this.#crypto.decryptReply({
        letterId: letter.id,
        direction: "agent_to_user",
        contentHash: letter.contentHash,
        authoredEffectiveAtUtc: letter.effectiveAuthorTimeUtc,
        arrivalDueAtUtc: letter.arrivalDueAtUtc,
        encryptedBody: letter.encryptedBody,
      });
    } catch (error) {
      throw serviceError(
        "letter_integrity_error",
        "Letter integrity verification failed",
        {},
        error,
      );
    }
  }

  private requireLetter(letterId: string): LetterWithEncryptedBody {
    const letter = this.repository.getLetter(letterId);
    if (letter === undefined) {
      throw serviceError("not_found", "Correspondence letter was not found", {
        letterId,
      });
    }
    return letter;
  }

  private requireCharacterTimezone(agentId: string): string {
    const spec = this.store.getCharacterSpec(agentId);
    if (spec === undefined) {
      throw serviceError("not_found", "Character was not found", { agentId });
    }
    return spec.identity.timezone;
  }

  private assertWritesEnabled(): void {
    if (this.#mode === "off") {
      throw serviceError(
        "correspondence_disabled",
        "Correspondence writing is disabled",
      );
    }
    if (this.#mode === "shadow") {
      throw serviceError(
        "correspondence_shadow_mode",
        "Correspondence writing is unavailable in shadow mode",
      );
    }
  }

  private readSealRequestId(letterId: string): string | undefined {
    const row = this.store.database
      .prepare("SELECT seal_request_id FROM letters WHERE id = ?")
      .get(letterId) as { seal_request_id: string | null } | undefined;
    return row?.seal_request_id ?? undefined;
  }

  private captureLetterState(agentId: string): Map<string, SafeLetterState> {
    return new Map(
      this.repository.listLetters(agentId, { limit: 500 }).map((letter) => [
        letter.id,
        {
          id: letter.id,
          direction: letter.direction,
          status: letter.status,
          updatedAtUtc: letter.updatedAtUtc,
        },
      ]),
    );
  }

  private captureTaskState(agentId: string): Map<string, SafeTaskState> {
    return new Map(
      this.repository.listTasks(agentId, 500).map((task) => [
        task.id,
        {
          id: task.id,
          entityId: task.entityId,
          status: task.status,
          attempt: task.attempt,
          dueAtUtc: task.dueAtUtc,
          ...(task.lastErrorCode === undefined
            ? {}
            : { lastErrorCode: task.lastErrorCode }),
        },
      ]),
    );
  }

  private publishCatchUpInvalidations(
    agentId: string,
    beforeLetters: ReadonlyMap<string, SafeLetterState>,
    beforeTasks: ReadonlyMap<string, SafeTaskState>,
  ): void {
    const afterLetters = this.captureLetterState(agentId);
    const afterTasks = this.captureTaskState(agentId);
    let changed = false;

    for (const letter of afterLetters.values()) {
      const before = beforeLetters.get(letter.id);
      if (
        before?.status !== letter.status ||
        before?.updatedAtUtc !== letter.updatedAtUtc
      ) {
        changed = true;
      }
      if (
        letter.direction === "agent_to_user" &&
        (letter.status === "delivered_unread" || letter.status === "read") &&
        before?.status !== "delivered_unread" &&
        before?.status !== "read"
      ) {
        this.publishInvalidation("letter.arrived", agentId, letter.id);
      }
    }
    for (const task of afterTasks.values()) {
      const before = beforeTasks.get(task.id);
      if (!sameTaskState(before, task)) changed = true;
      if (task.status === "retryable" && !sameTaskState(before, task)) {
        this.publishInvalidation(
          "letter.generation.retryable",
          agentId,
          task.entityId,
          task.id,
        );
      }
    }
    if (changed) {
      this.publishInvalidation("correspondence.updated", agentId);
    }
  }

  private publishInvalidation(
    type:
      | "correspondence.updated"
      | "letter.arrived"
      | "letter.opened"
      | "letter.generation.retryable",
    agentId: string,
    letterId?: string,
    taskId?: string,
  ): void {
    this.sse.publish({
      type,
      agentId,
      occurredAtUtc: this.clock.nowUtc(),
      data: {
        invalidate: ["correspondence", "letter", "messages", "timeline"],
        ...(letterId === undefined ? {} : { letterId }),
        ...(taskId === undefined ? {} : { taskId }),
      },
    });
  }
}

interface MailboxCursor {
  readonly version: 1;
  readonly scope: "correspondence_mailbox";
  readonly agentId: string;
  readonly createdAtUtc: string;
  readonly rowId: number;
}

function encodeMailboxCursor(cursor: MailboxCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMailboxCursor(
  rawCursor: string,
  expectedAgentId: string,
): MailboxCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(rawCursor)) throw new TypeError();
    const decodedBuffer = Buffer.from(rawCursor, "base64url");
    if (decodedBuffer.toString("base64url") !== rawCursor) {
      throw new TypeError();
    }
    const value: unknown = JSON.parse(decodedBuffer.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError();
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "agentId,createdAtUtc,rowId,scope,version") {
      throw new TypeError();
    }
    if (
      record["version"] !== 1 ||
      record["scope"] !== "correspondence_mailbox" ||
      EntityIdSchema.safeParse(record["agentId"]).success === false ||
      record["agentId"] !== expectedAgentId ||
      UtcDateTimeSchema.safeParse(record["createdAtUtc"]).success === false ||
      !Number.isSafeInteger(record["rowId"]) ||
      (record["rowId"] as number) <= 0
    ) {
      throw new TypeError();
    }
    return {
      version: 1,
      scope: "correspondence_mailbox",
      agentId: record["agentId"],
      createdAtUtc: record["createdAtUtc"] as string,
      rowId: record["rowId"] as number,
    };
  } catch {
    throw serviceError(
      "invalid_cursor",
      "The correspondence mailbox cursor is invalid for this character",
    );
  }
}

function projectOpenLetter(
  letter: LetterSummaryResponse,
  proposal: Readonly<LetterReplyProposal>,
  relatedKeepsakeIds: readonly string[],
): OpenLetterResponse {
  return OpenLetterResponseSchema.parse({
    letter,
    body: proposal.paragraphs.join("\n\n"),
    subject: proposal.subject,
    salutation: proposal.salutation,
    closing: proposal.closing,
    signature: proposal.signature,
    ...(proposal.postscript === undefined
      ? {}
      : { postscript: proposal.postscript }),
    relatedKeepsakeIds,
  });
}

function sameTaskState(
  before: SafeTaskState | undefined,
  after: SafeTaskState,
): boolean {
  return (
    before !== undefined &&
    before.status === after.status &&
    before.attempt === after.attempt &&
    before.dueAtUtc === after.dueAtUtc &&
    before.lastErrorCode === after.lastErrorCode
  );
}

function preview(value: string | undefined): string | undefined {
  const normalized = value?.trim().replaceAll(/\s+/gu, " ");
  if (normalized === undefined || normalized.length === 0) return undefined;
  return normalized.slice(0, 80);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function serviceError(
  code: CorrespondenceServiceErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CorrespondenceServiceError {
  return new CorrespondenceServiceError(
    code,
    message,
    details,
    cause === undefined ? undefined : { cause },
  );
}

function translateCorrespondenceError(error: unknown): Error {
  if (error instanceof CorrespondenceServiceError) return error;
  if (error instanceof CorrespondenceOpenError) {
    return serviceError(error.code, error.message, {}, error);
  }
  if (error instanceof CorrespondenceRepositoryError) {
    if (
      error.code === "invariant_violation" &&
      /awaiting reply|turn/i.test(error.message)
    ) {
      return serviceError(
        "correspondence_turn_in_progress",
        "The current correspondence turn must finish before another draft is created",
        error.details,
        error,
      );
    }
    const code: CorrespondenceServiceErrorCode =
      error.code === "invariant_violation" || error.code === "claim_conflict"
        ? "invalid_state"
        : error.code === "lease_expired"
          ? "invalid_state"
          : error.code;
    return serviceError(code, error.message, error.details, error);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function translateReplyGenerationRetryError(error: unknown): Error {
  if (error instanceof CorrespondenceServiceError) return error;
  if (!(error instanceof CorrespondenceRepositoryError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const safeErrors: Partial<
    Record<
      CorrespondenceRepositoryErrorCode,
      Readonly<{
        code: CorrespondenceServiceErrorCode;
        message: string;
      }>
    >
  > = {
    generation_not_retryable: {
      code: "generation_not_retryable",
      message: "Reply generation is not eligible for retry",
    },
    reply_already_committed: {
      code: "reply_already_committed",
      message: "A reply has already been committed for this letter",
    },
    reply_retry_in_progress: {
      code: "reply_retry_in_progress",
      message: "Reply generation retry is already in progress",
    },
    idempotency_conflict: {
      code: "idempotency_conflict",
      message: "The retry request conflicts with an existing request",
    },
  };
  const safe = safeErrors[error.code] ?? {
    code: "generation_not_retryable" as const,
    message: "Reply generation is not eligible for retry",
  };
  return serviceError(safe.code, safe.message, {}, error);
}
