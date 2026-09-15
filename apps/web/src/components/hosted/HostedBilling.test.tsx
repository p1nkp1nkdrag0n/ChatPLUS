import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttemptTable, LedgerTable, ReplyUsage } from "./HostedBilling";
import { MemoryRouter } from "react-router-dom";
import type { HostedAttempt } from "../../api/hosted";

describe("hosted billing presentation", () => {
  it("shows unknown user-key usage as zero platform cost without a charge-reconciliation action", () => {
    const attempt: HostedAttempt = {
      id: "own-1",
      operationId: "chat:own-1",
      purpose: "chat_turn",
      status: "unknown",
      costMicros: null,
      billingSource: "user",
      usage: null,
      createdAtUtc: "2026-09-15T00:00:00Z",
    };
    const markup = renderToStaticMarkup(
      <AttemptTable attempts={[attempt]} admin onReconcile={() => {}} />,
    );
    expect(markup).toContain("自己的 API");
    expect(markup).toContain("用量未知");
    expect(markup).toContain("0 · 不扣平台积分");
    expect(markup).not.toContain("人工核对");
    expect(markup).not.toContain("待确认");
    const reply = renderToStaticMarkup(
      <MemoryRouter>
        <ReplyUsage
          billing={{
            attempts: [attempt],
            isPending: false,
            error: null,
            retry: () => {},
          }}
        />
      </MemoryRouter>,
    );
    expect(reply).toContain("平台扣款 0 积分");
    expect(reply).not.toContain("另有待核对用量");
  });

  it("keeps pending platform charges visible when a reply also uses a user-key model", () => {
    const shared = {
      operationId: "chat:mixed",
      purpose: "chat_turn",
      usage: null,
      createdAtUtc: "2026-09-15T00:00:00Z",
    };
    const attempts: HostedAttempt[] = [
      {
        ...shared,
        id: "own",
        billingSource: "user",
        status: "unknown",
        costMicros: null,
      },
      {
        ...shared,
        id: "platform",
        billingSource: "platform",
        status: "reserved",
        costMicros: null,
      },
    ];
    const reply = renderToStaticMarkup(
      <MemoryRouter>
        <ReplyUsage
          billing={{ attempts, isPending: false, error: null, retry: () => {} }}
        />
      </MemoryRouter>,
    );
    expect(reply).toContain("自己的 API + 平台模型");
    expect(reply).toContain("另有待核对用量");
  });
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
