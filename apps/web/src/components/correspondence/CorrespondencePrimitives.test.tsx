import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  LetterSummaryResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import {
  EnvelopePanel,
  OpenedLetterPaper,
  PaperSelector,
  TransitProgress,
} from "./CorrespondencePrimitives";

const unopened: LetterSummaryResponse = {
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

describe("correspondence visual primitives", () => {
  it("renders an unopened reply as an accessible envelope without plaintext", () => {
    const unsafeInput = {
      ...unopened,
      body: "SENTINEL_UNOPENED_BODY",
      subject: "SENTINEL_UNOPENED_SUBJECT",
    } as LetterSummaryResponse;
    const markup = renderToStaticMarkup(
      <EnvelopePanel
        correspondent="林枫"
        letter={unsafeInput}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain("来自 林枫 的信封");
    expect(markup).toContain("启封阅读");
    expect(markup).not.toContain("SENTINEL_UNOPENED_BODY");
    expect(markup).not.toContain("SENTINEL_UNOPENED_SUBJECT");
  });

  it("exposes exactly three keyboard-operable paper radios", () => {
    const markup = renderToStaticMarkup(
      <PaperSelector value="plain" onChange={vi.fn()} />,
    );

    expect(markup.match(/type="radio"/g)).toHaveLength(3);
    expect(markup).toContain("棉纸");
    expect(markup).toContain("素笺");
    expect(markup).toContain("夜蓝");
    expect(markup).toMatch(/<input[^>]*checked=""[^>]*value="plain"/);
  });

  it("keeps opened letter content as semantic selectable text", () => {
    const opened: OpenLetterResponse = {
      letter: { ...unopened, status: "read" },
      subject: "九月来信",
      body: "这是一段可以选择和复制的正文。",
      salutation: "你好。",
      closing: "祝安。",
      signature: "林枫",
      postscript: "下次再谈。",
      relatedKeepsakeIds: [],
    };
    const markup = renderToStaticMarkup(
      <OpenedLetterPaper
        opened={opened}
        readingMode={false}
        headingRef={{ current: null }}
      />,
    );

    expect(markup).toContain("<article");
    expect(markup).toContain("<h1");
    expect(markup).toContain("这是一段可以选择和复制的正文。");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("data-body");
  });

  it("labels an already-opened envelope as a repeat read", () => {
    const markup = renderToStaticMarkup(
      <EnvelopePanel
        correspondent="林枫"
        letter={{ ...unopened, status: "read" }}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain("再次阅读");
    expect(markup).not.toContain("启封阅读");
  });

  it("uses a date progressbar without a seconds countdown", () => {
    const markup = renderToStaticMarkup(
      <TransitProgress
        letter={{ ...unopened, status: "in_transit", progress: 0.4 }}
        serverTimeUtc="2026-09-10T00:00:00.000Z"
      />,
    );
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("预计抵达");
    expect(markup).not.toContain("秒");
  });
});
