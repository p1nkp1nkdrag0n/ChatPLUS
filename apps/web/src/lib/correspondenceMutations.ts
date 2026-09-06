import type {
  LetterDetailResponse,
  OpenLetterResponse,
  RetryLetterReplyGenerationResponse,
} from "@personasim/contracts";
import {
  phaseAfterSuccessfulOpen,
  type LetterRevealPhase,
} from "./correspondence";
import { ApiError } from "../api/types";

export interface ReplyGenerationRetryLease {
  readonly agentId: string;
  readonly incomingLetterId: string;
  readonly clientRequestId: string;
  readonly uncertain: boolean;
}

type CreateClientRequestId = () => string;

export async function runReplyGenerationRetryAttempt(input: {
  initialLease: ReplyGenerationRetryLease;
  confirmFollowUp: () => Promise<boolean>;
  createFollowUpLease: () => ReplyGenerationRetryLease | undefined;
  submit: (
    lease: ReplyGenerationRetryLease,
  ) => Promise<RetryLetterReplyGenerationResponse>;
  onAttempt: (lease: ReplyGenerationRetryLease) => void;
  onAcknowledged: (lease: ReplyGenerationRetryLease) => void;
  onRejected: (lease: ReplyGenerationRetryLease, error: unknown) => void;
}): Promise<RetryLetterReplyGenerationResponse> {
  input.onAttempt(input.initialLease);
  const firstResponse = await submitReplyGenerationRetryLease(
    input,
    input.initialLease,
  );
  if (!shouldContinueReplyGenerationRetry(input.initialLease, firstResponse)) {
    return firstResponse;
  }
  if (!(await input.confirmFollowUp())) return firstResponse;

  const followUpLease = input.createFollowUpLease();
  if (followUpLease === undefined) return firstResponse;
  input.onAttempt(followUpLease);
  try {
    return await submitReplyGenerationRetryLease(input, followUpLease);
  } catch (error) {
    if (isReplyGenerationRetryConvergenceError(error)) return firstResponse;
    throw error;
  }
}

export function acquireReplyGenerationRetryLease(
  current: ReplyGenerationRetryLease | undefined,
  agentId: string,
  incomingLetterId: string,
  createClientRequestId: CreateClientRequestId = createReplyGenerationRetryClientRequestId,
): ReplyGenerationRetryLease {
  if (
    current?.agentId === agentId &&
    current.incomingLetterId === incomingLetterId
  ) {
    return current;
  }
  return {
    agentId,
    incomingLetterId,
    clientRequestId: createClientRequestId(),
    uncertain: false,
  };
}

export function releaseReplyGenerationRetryLease(
  current: ReplyGenerationRetryLease | undefined,
  acknowledged: ReplyGenerationRetryLease,
): ReplyGenerationRetryLease | undefined {
  return sameReplyGenerationRetryLease(current, acknowledged)
    ? undefined
    : current;
}

export function replyGenerationRetryLeaseAfterError(
  current: ReplyGenerationRetryLease | undefined,
  attempted: ReplyGenerationRetryLease,
  error: unknown,
): ReplyGenerationRetryLease | undefined {
  if (!sameReplyGenerationRetryLease(current, attempted)) return current;
  if (error instanceof ApiError && error.status < 500) return undefined;
  return { ...attempted, uncertain: true };
}

export function shouldContinueReplyGenerationRetry(
  attempted: ReplyGenerationRetryLease,
  response: RetryLetterReplyGenerationResponse,
): boolean {
  return (
    attempted.uncertain &&
    response.replayed &&
    response.incomingLetterId === attempted.incomingLetterId
  );
}

export function replyGenerationRetryErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "未能确认这次请求，请稍后再次尝试。";
  }
  switch (error.code) {
    case "reply_retry_in_progress":
      return "这封回信已经在重新准备，请稍后再看。";
    case "reply_already_committed":
      return "回信已经完成，正在刷新书信状态。";
    case "generation_not_retryable":
      return "当前状态不能重新尝试，请刷新后再查看。";
    case "idempotency_conflict":
      return "未能确认这次请求，请刷新状态后再试。";
    default:
      return "未能确认这次请求，请稍后再次尝试。";
  }
}

function createReplyGenerationRetryClientRequestId(): string {
  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `letter-reply-retry:${value}`;
}

async function submitReplyGenerationRetryLease(
  input: {
    submit: (
      lease: ReplyGenerationRetryLease,
    ) => Promise<RetryLetterReplyGenerationResponse>;
    onAcknowledged: (lease: ReplyGenerationRetryLease) => void;
    onRejected: (lease: ReplyGenerationRetryLease, error: unknown) => void;
  },
  lease: ReplyGenerationRetryLease,
): Promise<RetryLetterReplyGenerationResponse> {
  try {
    const response = await input.submit(lease);
    input.onAcknowledged(lease);
    return response;
  } catch (error) {
    input.onRejected(lease, error);
    throw error;
  }
}

function isReplyGenerationRetryConvergenceError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "reply_retry_in_progress" ||
      error.code === "reply_already_committed")
  );
}

function sameReplyGenerationRetryLease(
  left: ReplyGenerationRetryLease | undefined,
  right: ReplyGenerationRetryLease,
): boolean {
  return (
    left?.agentId === right.agentId &&
    left.incomingLetterId === right.incomingLetterId &&
    left.clientRequestId === right.clientRequestId
  );
}

export async function persistThenSealLetter(input: {
  persistDraft: () => Promise<LetterDetailResponse>;
  sealDraft: (letterId: string) => Promise<LetterDetailResponse>;
}): Promise<LetterDetailResponse> {
  const persisted = await input.persistDraft();
  return input.sealDraft(persisted.letter.id);
}

/**
 * Hands decrypted content directly to the currently mounted reader. It does
 * not return that content and does not accept a QueryClient, preventing the
 * open response from being written to React Query by this flow.
 */
export async function openLetterForMountedReader(input: {
  open: () => Promise<OpenLetterResponse>;
  prefersReducedMotion: boolean;
  onOpened: (response: OpenLetterResponse, phase: LetterRevealPhase) => void;
}): Promise<void> {
  const response = await input.open();
  input.onOpened(
    response,
    phaseAfterSuccessfulOpen(input.prefersReducedMotion),
  );
}
