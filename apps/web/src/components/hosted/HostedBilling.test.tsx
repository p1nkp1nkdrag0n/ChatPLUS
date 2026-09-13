import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttemptTable, LedgerTable } from "./HostedBilling";

describe("hosted billing presentation", () => {
  it("preserves unknown usage and pending charges instead of showing zero", () => {
    const markup = renderToStaticMarkup(
      <AttemptTable
        attempts={[
          {
            id: "attempt-1",
            operationId: "chat:message-1",
            purpose: "chat_turn",
            status: "unknown",
            costMicros: null,
            usage: {
              inputTokens: 1250,
              outputTokens: 17,
              cacheReadTokens: null,
            },
            displayName: "林间轻语",
            createdAtUtc: "2026-09-12T00:00:00Z",
          },
        ]}
      />,
    );
    expect(markup).toContain("林间轻语");
    expect(markup).toContain("1,250");
    expect(markup).toContain("未知");
    expect(markup).toContain("待核对");
    expect(markup).toContain("待确认");
    expect(markup).not.toContain("0.00");
  });

  it("renders the actual ledger delta field without inventing a balance snapshot", () => {
    const markup = renderToStaticMarkup(
      <LedgerTable
        entries={[
          {
            id: "entry-1",
            kind: "charge",
            deltaMicros: -1,
            reason: "对话调用",
            createdAtUtc: "2026-09-12T00:00:00Z",
          },
        ]}
      />,
    );
    expect(markup).toContain("-0.000001");
    expect(markup).toContain("对话调用");
    expect(markup).not.toContain("待确认");
  });
});
