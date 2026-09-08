import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LetterSummaryResponse } from "@personasim/contracts";
import { LetterListRow } from "./CorrespondenceMailboxPage";

const incoming: LetterSummaryResponse = {
  id: "reply-1",
  threadId: "thread-1",
  direction: "agent_to_user",
  status: "delivered_unread",
  authoredDisplayDate: "2026-09-13",
  dispatchedAtUtc: "2026-09-08T00:00:00.000Z",
  arrivalDueAtUtc: "2026-09-13T00:00:00.000Z",
  progress: 1,
  postmark: "杭州 · 2026-09-08",
  canOpen: true,
  canEdit: false,
};

function renderRow(letter: LetterSummaryResponse) {
  return renderToStaticMarkup(
    <LetterListRow
      letter={letter}
      correspondent="林枫"
      serverTimeUtc="2026-09-13T00:00:00.000Z"
      timezone="Asia/Shanghai"
      selected
      onSelect={vi.fn()}
    />,
  );
}

describe("illustrated mailbox rows", () => {
  it("keeps unopened reply titles and previews out of the row even if unsafe fields are supplied", () => {
    const unsafe = {
      ...incoming,
      subject: "PRIVATE_UNOPENED_TITLE",
      body: "PRIVATE_UNOPENED_BODY",
      previewText: "PRIVATE_UNOPENED_PREVIEW",
    };
    const markup = renderRow(unsafe);

    expect(markup).toContain("林枫的来信");
    expect(markup).toContain("待拆阅");
    expect(markup).toContain("/dearvale/art/welcome.png");
    expect(markup).not.toContain("PRIVATE_UNOPENED");
    expect(markup).toContain('aria-current="true"');
  });

  it("shows the safe preview and paper thumbnail after a reply has been opened", () => {
    const markup = renderRow({
      ...incoming,
      status: "read",
      previewText: "那天的风很温柔。",
    });

    expect(markup).toContain("已启封");
    expect(markup).toContain("那天的风很温柔。");
    expect(markup).toContain("/dearvale/art/letter-paper.png");
    expect(markup).toContain("2026.09.13");
  });

  it("distinguishes a user's outgoing letter and preserves its safe preview", () => {
    const markup = renderRow({
      ...incoming,
      direction: "user_to_agent",
      status: "in_transit",
      progress: 0.4,
      previewText: "这是我亲手写下的话。",
    });

    expect(markup).toContain("寄给林枫");
    expect(markup).toContain("在途中");
    expect(markup).toContain("这是我亲手写下的话。");
    expect(markup).not.toContain("PRIVATE_UNOPENED");
  });
});
