import { describe, expect, it, vi } from "vitest";
import type {
  LetterDetailResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import {
  acquireReplyGenerationRetryLease,
  openLetterForMountedReader,
  persistThenSealLetter,
  releaseReplyGenerationRetryLease,
  replyGenerationRetryLeaseAfterError,
  replyGenerationRetryErrorMessage,
  runReplyGenerationRetryAttempt,
  shouldContinueReplyGenerationRetry,
} from "./correspondenceMutations";
import { ApiError } from "../api/types";

const draft: LetterDetailResponse = {
  letter: {
    id: "letter-draft",
    threadId: "thread-1",
    direction: "user_to_agent",
    status: "draft",
    authoredDisplayDate: "2026-09-03",
    progress: 0,
    postmark: "上海 · 2026-09-03",
    canOpen: false,
    canEdit: true,
  },
  body: "写给远方。",
};

const sealed: LetterDetailResponse = {
  letter: {
    ...draft.letter,
    status: "in_transit",
    dispatchedAtUtc: "2026-09-03T00:00:00.000Z",
    arrivalDueAtUtc: "2026-09-08T00:00:00.000Z",
    canEdit: false,
  },
  body: draft.body,
};

const opened: OpenLetterResponse = {
  letter: {
    id: "reply-1",
    threadId: "thread-1",
    direction: "agent_to_user",
    status: "read",
    authoredDisplayDate: "2026-09-13",
    dispatchedAtUtc: "2026-09-08T00:00:00.000Z",
    arrivalDueAtUtc: "2026-09-13T00:00:00.000Z",
    progress: 1,
    postmark: "杭州 · 2026-09-08",
    canOpen: true,
    canEdit: false,
  },
  subject: "回信",
  body: "只交给当前阅读组件的正文。",
  salutation: "你好。",
  closing: "祝安。",
  signature: "林枫",
  relatedKeepsakeIds: [],
};

describe("correspondence mutation ordering", () => {
  it("waits for draft persistence before sealing and never invents an optimistic result", async () => {
    let resolvePersist: ((value: LetterDetailResponse) => void) | undefined;
    const persistDraft = vi.fn(
      () =>
        new Promise<LetterDetailResponse>((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const sealDraft = vi.fn().mockResolvedValue(sealed);

    const result = persistThenSealLetter({ persistDraft, sealDraft });
    expect(persistDraft).toHaveBeenCalledOnce();
    expect(sealDraft).not.toHaveBeenCalled();

    resolvePersist?.(draft);
    await expect(result).resolves.toBe(sealed);
    expect(sealDraft).toHaveBeenCalledOnce();
    expect(sealDraft).toHaveBeenCalledWith("letter-draft");
  });

  it("delivers open plaintext only after the server succeeds and honors reduced motion", async () => {
    let resolveOpen: ((value: OpenLetterResponse) => void) | undefined;
    const open = vi.fn(
      () =>
        new Promise<OpenLetterResponse>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const onOpened = vi.fn();

    const result = openLetterForMountedReader({
      open,
      prefersReducedMotion: true,
      onOpened,
    });
    expect(onOpened).not.toHaveBeenCalled();

    resolveOpen?.(opened);
    await expect(result).resolves.toBeUndefined();
    expect(onOpened).toHaveBeenCalledOnce();
    expect(onOpened).toHaveBeenCalledWith(opened, "reading");
  });

  it("does not publish any local plaintext when opening fails", async () => {
    const onOpened = vi.fn();
    await expect(
      openLetterForMountedReader({
        open: () => Promise.reject(new Error("not arrived")),
        prefersReducedMotion: false,
        onOpened,
      }),
    ).rejects.toThrow("not arrived");
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("reuses one reply-recovery request id until that request is acknowledged", () => {
    const createId = vi
      .fn()
      .mockReturnValueOnce("reply-retry:first")
      .mockReturnValueOnce("reply-retry:second");
    const first = acquireReplyGenerationRetryLease(
      undefined,
      "agent-1",
      "incoming-1",
      createId,
    );
    const replay = acquireReplyGenerationRetryLease(
      first,
      "agent-1",
      "incoming-1",
      createId,
    );
    const otherLetter = acquireReplyGenerationRetryLease(
      replay,
      "agent-1",
      "incoming-2",
      createId,
    );

    expect(replay).toBe(first);
    expect(first.clientRequestId).toBe("reply-retry:first");
    expect(otherLetter).toEqual({
      agentId: "agent-1",
      incomingLetterId: "incoming-2",
      clientRequestId: "reply-retry:second",
      uncertain: false,
    });
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it("only releases the acknowledged reply-recovery request", () => {
    const current = {
      agentId: "agent-1",
      incomingLetterId: "incoming-1",
      clientRequestId: "reply-retry:first",
      uncertain: false,
    };

    expect(
      releaseReplyGenerationRetryLease(current, {
        agentId: "agent-1",
        incomingLetterId: "incoming-1",
        clientRequestId: "reply-retry:other",
        uncertain: false,
      }),
    ).toBe(current);
    expect(releaseReplyGenerationRetryLease(current, current)).toBeUndefined();
  });

  it("keeps ambiguous recovery IDs but discards deterministically rejected IDs", () => {
    const current = {
      agentId: "agent-1",
      incomingLetterId: "incoming-1",
      clientRequestId: "reply-retry:first",
      uncertain: false,
    };

    expect(
      replyGenerationRetryLeaseAfterError(
        current,
        current,
        new TypeError("network response lost"),
      ),
    ).toEqual({ ...current, uncertain: true });
    expect(
      replyGenerationRetryLeaseAfterError(
        current,
        current,
        new ApiError({
          code: "idempotency_conflict",
          message: "conflict",
          status: 409,
        }),
      ),
    ).toBeUndefined();
  });

  it("continues an acknowledged ambiguous replay with one fresh request", () => {
    const uncertain = {
      agentId: "agent-1",
      incomingLetterId: "incoming-1",
      clientRequestId: "reply-retry:first",
      uncertain: true,
    };

    expect(
      shouldContinueReplyGenerationRetry(uncertain, {
        incomingLetterId: "incoming-1",
        replayed: true,
      }),
    ).toBe(true);
    expect(
      shouldContinueReplyGenerationRetry(
        { ...uncertain, uncertain: false },
        { incomingLetterId: "incoming-1", replayed: true },
      ),
    ).toBe(false);
    expect(
      shouldContinueReplyGenerationRetry(uncertain, {
        incomingLetterId: "incoming-1",
        replayed: false,
      }),
    ).toBe(false);
  });

  it("turns an ambiguous replay into exactly one fresh recovery request", async () => {
    const initial = {
      agentId: "agent-1",
      incomingLetterId: "incoming-1",
      clientRequestId: "reply-retry:first",
      uncertain: true,
    };
    const followUp = {
      ...initial,
      clientRequestId: "reply-retry:second",
      uncertain: false,
    };
    const submit = vi
      .fn()
      .mockResolvedValueOnce({
        incomingLetterId: "incoming-1",
        replayed: true,
      })
      .mockResolvedValueOnce({
        incomingLetterId: "incoming-1",
        replayed: false,
      });
    const onAttempt = vi.fn();
    const onAcknowledged = vi.fn();
    const onRejected = vi.fn();

    await expect(
      runReplyGenerationRetryAttempt({
        initialLease: initial,
        confirmFollowUp: vi.fn().mockResolvedValue(true),
        createFollowUpLease: () => followUp,
        submit,
        onAttempt,
        onAcknowledged,
        onRejected,
      }),
    ).resolves.toEqual({
      incomingLetterId: "incoming-1",
      replayed: false,
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, initial);
    expect(submit).toHaveBeenNthCalledWith(2, followUp);
    expect(onAttempt).toHaveBeenNthCalledWith(1, initial);
    expect(onAttempt).toHaveBeenNthCalledWith(2, followUp);
    expect(onAcknowledged).toHaveBeenNthCalledWith(1, initial);
    expect(onAcknowledged).toHaveBeenNthCalledWith(2, followUp);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("attributes a lost follow-up response to the exact fresh lease", async () => {
    const initial = {
      agentId: "agent-1",
      incomingLetterId: "incoming-1",
      clientRequestId: "reply-retry:first",
      uncertain: true,
    };
    const followUp = {
      ...initial,
      clientRequestId: "reply-retry:second",
      uncertain: false,
    };
    const lostResponse = new TypeError("response lost");
    const onAcknowledged = vi.fn();
    const onRejected = vi.fn();

    await expect(
      runReplyGenerationRetryAttempt({
        initialLease: initial,
        confirmFollowUp: vi.fn().mockResolvedValue(true),
        createFollowUpLease: () => followUp,
        submit: vi
          .fn()
          .mockResolvedValueOnce({
            incomingLetterId: "incoming-1",
            replayed: true,
          })
          .mockRejectedValueOnce(lostResponse),
        onAttempt: vi.fn(),
        onAcknowledged,
        onRejected,
      }),
    ).rejects.toBe(lostResponse);
    expect(onAcknowledged).toHaveBeenCalledOnce();
    expect(onAcknowledged).toHaveBeenCalledWith(initial);
    expect(onRejected).toHaveBeenCalledOnce();
    expect(onRejected).toHaveBeenCalledWith(followUp, lostResponse);
  });

  it("does not issue a fresh request when the authoritative state has converged", async () => {
    const initial = {
      agentId: "agent-1",
      incomingLetterId: "incoming-1",
      clientRequestId: "reply-retry:first",
      uncertain: true,
    };
    const submit = vi.fn().mockResolvedValue({
      incomingLetterId: "incoming-1",
      replayed: true,
    });

    await expect(
      runReplyGenerationRetryAttempt({
        initialLease: initial,
        confirmFollowUp: vi.fn().mockResolvedValue(false),
        createFollowUpLease: vi.fn(),
        submit,
        onAttempt: vi.fn(),
        onAcknowledged: vi.fn(),
        onRejected: vi.fn(),
      }),
    ).resolves.toEqual({
      incomingLetterId: "incoming-1",
      replayed: true,
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("treats only superseding follow-up conflicts as successful convergence", async () => {
    const initial = {
      agentId: "agent-1",
      incomingLetterId: "incoming-1",
      clientRequestId: "reply-retry:first",
      uncertain: true,
    };
    const followUp = {
      ...initial,
      clientRequestId: "reply-retry:second",
      uncertain: false,
    };
    const inProgress = new ApiError({
      code: "reply_retry_in_progress",
      message: "already active",
      status: 409,
    });

    await expect(
      runReplyGenerationRetryAttempt({
        initialLease: initial,
        confirmFollowUp: vi.fn().mockResolvedValue(true),
        createFollowUpLease: () => followUp,
        submit: vi
          .fn()
          .mockResolvedValueOnce({
            incomingLetterId: "incoming-1",
            replayed: true,
          })
          .mockRejectedValueOnce(inProgress),
        onAttempt: vi.fn(),
        onAcknowledged: vi.fn(),
        onRejected: vi.fn(),
      }),
    ).resolves.toEqual({
      incomingLetterId: "incoming-1",
      replayed: true,
    });

    const notRetryable = new ApiError({
      code: "generation_not_retryable",
      message: "history invariant failed",
      status: 409,
    });
    await expect(
      runReplyGenerationRetryAttempt({
        initialLease: initial,
        confirmFollowUp: vi.fn().mockResolvedValue(true),
        createFollowUpLease: () => followUp,
        submit: vi
          .fn()
          .mockResolvedValueOnce({
            incomingLetterId: "incoming-1",
            replayed: true,
          })
          .mockRejectedValueOnce(notRetryable),
        onAttempt: vi.fn(),
        onAcknowledged: vi.fn(),
        onRejected: vi.fn(),
      }),
    ).rejects.toBe(notRetryable);
  });

  it("maps reply-recovery failures to fixed safe product copy", () => {
    const internal = new ApiError({
      code: "reply_retry_in_progress",
      message: "PRIVATE provider task constraint detail",
      status: 409,
      issues: [{ path: "snapshotId", message: "PRIVATE_SNAPSHOT" }],
      requestId: "PRIVATE_REQUEST_ID",
    });

    expect(replyGenerationRetryErrorMessage(internal)).toBe(
      "这封回信已经在重新准备，请稍后再看。",
    );
    expect(
      replyGenerationRetryErrorMessage(
        new Error("SENTINEL_NETWORK_OR_PROVIDER_DETAIL"),
      ),
    ).toBe("未能确认这次请求，请稍后再次尝试。");
  });
});
