import { describe, expect, it } from "vitest";
import type {
  CorrespondenceMailboxResponse,
  LetterDetailResponse,
  LetterSummaryResponse,
} from "@personasim/contracts";
import {
  correspondenceQueryKeys,
  composeAvailability,
  filterMailboxLetters,
  mergeCorrespondenceMailboxPages,
  phaseAfterSuccessfulOpen,
  projectLetterDetailForCache,
  transitPresentation,
} from "./correspondence";

const baseLetter = {
  id: "letter-1",
  threadId: "thread-1",
  authoredDisplayDate: "2026-09-03",
  progress: 1,
  postmark: "上海 · 2026-09-03",
  canOpen: true,
  canEdit: false,
} satisfies Omit<
  LetterSummaryResponse,
  "direction" | "status" | "dispatchedAtUtc" | "arrivalDueAtUtc"
>;

describe("correspondence query and privacy boundaries", () => {
  it("uses the exact Stage 4 query keys", () => {
    expect(correspondenceQueryKeys.mailbox("agent-1")).toEqual([
      "correspondence",
      "agent-1",
    ]);
    expect(correspondenceQueryKeys.mailboxPages("agent-1")).toEqual([
      "correspondence",
      "agent-1",
      "pages",
    ]);
    expect(correspondenceQueryKeys.letter("letter-1")).toEqual([
      "letter",
      "letter-1",
    ]);
    expect(correspondenceQueryKeys.temporalTasks("agent-1")).toEqual([
      "temporal-tasks",
      "agent-1",
    ]);
  });

  it("merges mailbox pages in order, deduplicates records, and follows the final cursor", () => {
    const firstLetter: LetterSummaryResponse = {
      ...baseLetter,
      direction: "agent_to_user",
      status: "read",
    };
    const secondLetter: LetterSummaryResponse = {
      ...firstLetter,
      id: "letter-2",
    };
    const pages: CorrespondenceMailboxResponse[] = [
      {
        threads: [
          {
            id: "thread-1",
            agentId: "agent-1",
            status: "open",
            latestLetterId: "letter-1",
          },
        ],
        letters: [firstLetter],
        serverTimeUtc: "2026-09-03T00:00:00.000Z",
        nextCursor: "page-2",
      },
      {
        threads: [
          {
            id: "thread-1",
            agentId: "agent-1",
            status: "open",
            latestLetterId: "letter-1",
          },
        ],
        letters: [firstLetter, secondLetter],
        serverTimeUtc: "2026-09-03T01:00:00.000Z",
      },
    ];

    expect(mergeCorrespondenceMailboxPages(pages)).toEqual({
      threads: pages[1]!.threads,
      letters: [firstLetter, secondLetter],
      serverTimeUtc: "2026-09-03T01:00:00.000Z",
    });
    expect(mergeCorrespondenceMailboxPages([])).toBeUndefined();
  });

  it("removes all full plaintext fields from an opened agent reply before caching", () => {
    const secret = "SENTINEL_FULL_DECRYPTED_REPLY";
    const detail: LetterDetailResponse = {
      letter: {
        ...baseLetter,
        direction: "agent_to_user",
        status: "read",
        dispatchedAtUtc: "2026-09-08T00:00:00.000Z",
        arrivalDueAtUtc: "2026-09-13T00:00:00.000Z",
      },
      subject: "九月来信",
      body: secret,
      salutation: "你好。",
      closing: "祝安。",
      signature: "林枫",
      postscript: "附言也不能进入详情 Query。",
      relatedKeepsakeIds: [],
    };

    const cached = projectLetterDetailForCache(detail);

    expect(cached).toEqual({ letter: detail.letter });
    expect(JSON.stringify(cached)).not.toContain(secret);
    expect(JSON.stringify(cached)).not.toContain("附言也不能进入详情 Query");
  });

  it("retains user-authored draft text because it is editable by its author", () => {
    const detail: LetterDetailResponse = {
      letter: {
        ...baseLetter,
        direction: "user_to_agent",
        status: "draft",
        progress: 0,
        canOpen: false,
        canEdit: true,
      },
      subject: "近况",
      body: "这是用户自己的草稿。",
    };

    expect(projectLetterDetailForCache(detail)).toMatchObject({
      subject: "近况",
      body: "这是用户自己的草稿。",
    });
  });
});

describe("correspondence date presentation", () => {
  it("derives transit progress and day copy from dates without a countdown", () => {
    const letter: LetterSummaryResponse = {
      ...baseLetter,
      direction: "user_to_agent",
      status: "in_transit",
      dispatchedAtUtc: "2026-09-03T00:00:00.000Z",
      arrivalDueAtUtc: "2026-09-08T00:00:00.000Z",
      progress: 0.2,
      canOpen: false,
    };

    const view = transitPresentation(letter, "2026-09-05T00:00:00.000Z");

    expect(view.progress).toBe(0.4);
    expect(view.statusLabel).toBe("信件在途");
    expect(view.dayLabel).toBe("第 3 天");
    expect(JSON.stringify(view)).not.toMatch(/秒|小时|倒计时/);
  });

  it("bypasses reveal motion when the user prefers reduced motion", () => {
    expect(phaseAfterSuccessfulOpen(true)).toBe("reading");
    expect(phaseAfterSuccessfulOpen(false)).toBe("revealing");
  });

  it("keeps unopened replies in transit, not received mail, without inventing previews", () => {
    const reply: LetterSummaryResponse = {
      ...baseLetter,
      direction: "agent_to_user",
      status: "in_transit",
      dispatchedAtUtc: "2026-09-08T00:00:00.000Z",
      arrivalDueAtUtc: "2026-09-13T00:00:00.000Z",
      progress: 0.4,
      canOpen: false,
    };
    expect(filterMailboxLetters([reply], "inbox")).toEqual([]);
    expect(filterMailboxLetters([reply], "transit")).toEqual([reply]);
    expect(reply.previewText).toBeUndefined();
  });
});

describe("one-open-turn presentation", () => {
  it("routes back to an existing draft instead of opening a parallel turn", () => {
    const draft: LetterSummaryResponse = {
      ...baseLetter,
      direction: "user_to_agent",
      status: "draft",
      progress: 0,
      canOpen: false,
      canEdit: true,
    };
    expect(
      composeAvailability({
        threads: [
          {
            id: "thread-1",
            agentId: "agent-1",
            status: "open",
            latestLetterId: draft.id,
          },
        ],
        letters: [draft],
        serverTimeUtc: "2026-09-03T00:00:00.000Z",
      }),
    ).toEqual({ kind: "edit", draftId: draft.id });
  });

  it("waits while a turn is travelling and reopens compose after a reply is read", () => {
    const travelling: LetterSummaryResponse = {
      ...baseLetter,
      direction: "agent_to_user",
      status: "in_transit",
      dispatchedAtUtc: "2026-09-08T00:00:00.000Z",
      arrivalDueAtUtc: "2026-09-13T00:00:00.000Z",
      progress: 0.4,
      canOpen: false,
    };
    const mailbox = {
      threads: [
        {
          id: "thread-1",
          agentId: "agent-1",
          status: "open" as const,
          latestLetterId: travelling.id,
        },
      ],
      letters: [travelling],
      serverTimeUtc: "2026-09-10T00:00:00.000Z",
    };
    expect(composeAvailability(mailbox)).toEqual({ kind: "waiting" });
    expect(
      composeAvailability({
        ...mailbox,
        letters: [
          { ...travelling, status: "read", canOpen: true, progress: 1 },
        ],
      }),
    ).toEqual({ kind: "new" });
  });
});
