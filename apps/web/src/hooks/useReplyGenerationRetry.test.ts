import { describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { CachedUserLetterDetail } from "../lib/correspondence";
import { confirmReplyGenerationStillRetryable } from "./useReplyGenerationRetry";

const earlierLetter: CachedUserLetterDetail = {
  letter: {
    id: "earlier-letter",
    threadId: "thread-1",
    direction: "user_to_agent",
    status: "read",
    authoredDisplayDate: "2026-09-03",
    progress: 1,
    postmark: "上海 · 2026-09-03",
    canOpen: false,
    canEdit: false,
    replyState: {
      kind: "failed",
      incomingLetterId: "earlier-letter",
      canRetry: true,
    },
  },
  body: "较早寄出的信。",
};

describe("reply recovery for concurrent letters", () => {
  it("checks an older letter directly even if it is absent from the latest mailbox page", async () => {
    const detail = vi
      .spyOn(api.letters, "getCacheSafe")
      .mockResolvedValue(earlierLetter);
    const mailbox = vi.spyOn(api.correspondence, "list");
    await expect(
      confirmReplyGenerationStillRetryable("earlier-letter"),
    ).resolves.toBe(true);
    expect(detail).toHaveBeenCalledWith("earlier-letter");
    expect(mailbox).not.toHaveBeenCalled();
  });

  it("does not retry using another incoming letter's failed state", async () => {
    vi.spyOn(api.letters, "getCacheSafe").mockResolvedValue({
      ...earlierLetter,
      letter: {
        ...earlierLetter.letter,
        replyState: {
          kind: "failed",
          incomingLetterId: "newer-letter",
          canRetry: true,
        },
      },
    });
    await expect(
      confirmReplyGenerationStillRetryable("earlier-letter"),
    ).resolves.toBe(false);
  });

  it("does not submit a follow-up recovery after the original request scheduled a retry", async () => {
    vi.spyOn(api.letters, "getCacheSafe").mockResolvedValue({
      ...earlierLetter,
      letter: {
        ...earlierLetter.letter,
        replyState: {
          kind: "retry_scheduled",
          incomingLetterId: "earlier-letter",
        },
      },
    });
    await expect(
      confirmReplyGenerationStillRetryable("earlier-letter"),
    ).resolves.toBe(false);
  });
});
