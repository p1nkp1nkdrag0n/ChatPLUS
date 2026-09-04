import { describe, expect, it, vi } from "vitest";
import type {
  LetterDetailResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import {
  openLetterForMountedReader,
  persistThenSealLetter,
} from "./correspondenceMutations";

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
});
