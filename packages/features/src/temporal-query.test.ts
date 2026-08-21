import { describe, expect, it } from "vitest";

import { resolveTemporalQuery } from "./temporal-query.js";

describe("temporal query resolution", () => {
  it("uses local day boundaries across a DST transition", () => {
    const result = resolveTemporalQuery({
      text: "What happened yesterday?",
      nowUtc: "2026-03-09T12:00:00.000Z",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      kind: "resolved",
      expression: "yesterday",
      fromUtc: "2026-03-08T05:00:00.000Z",
      toUtc: "2026-03-09T04:00:00.000Z",
    });
  });

  it("resolves calendar month and most recent completed Tuesday", () => {
    const month = resolveTemporalQuery({
      text: "What happened last month?",
      nowUtc: "2026-08-21T12:00:00.000Z",
      timezone: "Asia/Shanghai",
    });
    expect(month).toEqual({
      kind: "resolved",
      expression: "last_month",
      fromUtc: "2026-06-30T16:00:00.000Z",
      toUtc: "2026-07-31T16:00:00.000Z",
    });

    const tuesday = resolveTemporalQuery({
      text: "What did we discuss Tuesday?",
      nowUtc: "2026-08-21T12:00:00.000Z",
      timezone: "Asia/Shanghai",
    });
    expect(tuesday).toEqual({
      kind: "resolved",
      expression: "last_tuesday",
      fromUtc: "2026-08-17T16:00:00.000Z",
      toUtc: "2026-08-18T16:00:00.000Z",
    });
  });

  it("requires a unique, reliable named anchor", () => {
    const ambiguous = resolveTemporalQuery({
      text: "What happened after the party?",
      nowUtc: "2026-08-21T12:00:00.000Z",
      timezone: "UTC",
      anchors: [
        {
          id: "party-1",
          label: "party",
          startAtUtc: "2026-08-10T18:00:00.000Z",
          certainty: "exact",
        },
        {
          id: "party-2",
          label: "party",
          startAtUtc: "2026-08-12T18:00:00.000Z",
          certainty: "exact",
        },
      ],
    });
    expect(ambiguous).toEqual({
      kind: "ambiguous",
      reasonCode: "ambiguous_anchor",
    });

    const resolved = resolveTemporalQuery({
      text: "What happened after the party?",
      nowUtc: "2026-08-21T12:00:00.000Z",
      timezone: "UTC",
      anchors: [
        {
          id: "party-1",
          label: "party",
          startAtUtc: "2026-08-10T18:00:00.000Z",
          endAtUtc: "2026-08-10T22:00:00.000Z",
          certainty: "exact",
        },
      ],
    });
    expect(resolved).toEqual({
      kind: "resolved",
      expression: "after_anchor",
      fromUtc: "2026-08-10T22:00:00.000Z",
      toUtc: "2026-08-11T22:00:00.000Z",
      anchorId: "party-1",
    });
  });

  it("marks an unresolved named direction as ambiguous instead of guessing", () => {
    expect(
      resolveTemporalQuery({
        text: "\u665a\u4f1a\u4e4b\u540e\u53d1\u751f\u4e86\u4ec0\u4e48\uff1f",
        nowUtc: "2026-08-21T12:00:00.000Z",
        timezone: "Asia/Shanghai",
      }),
    ).toEqual({
      kind: "ambiguous",
      reasonCode: "anchor_not_found",
    });
  });

  it("does not treat a generic completion preference as a missing temporal anchor", () => {
    expect(
      resolveTemporalQuery({
        text: "\u6211\u4e0d\u559c\u6b22\u54ea\u4e00\u79cd\u5e86\u529f\u65b9\u5f0f\uff1f\u4efb\u52a1\u5b8c\u6210\u540e\u6211\u66f4\u559c\u6b22\u53bb\u54ea\u91cc\u3001\u505a\u4ec0\u4e48\uff1f",
        nowUtc: "2026-08-21T12:00:00.000Z",
        timezone: "Asia/Shanghai",
      }),
    ).toEqual({ kind: "none" });
  });

  it("does not treat the ordinary word later as a missing temporal anchor", () => {
    expect(
      resolveTemporalQuery({
        text: "\u793e\u533a\u7eaa\u5f55\u7247\u6700\u7ec8\u58f0\u97f3\u6821\u5bf9\uff0c\u540e\u6765\u5b9e\u9645\u5b8c\u6210\u4e86\u5417\uff1f",
        nowUtc: "2026-08-21T12:00:00.000Z",
        timezone: "Asia/Shanghai",
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none instead of guessing without a temporal expression", () => {
    expect(
      resolveTemporalQuery({
        text: "Tell me about tea.",
        nowUtc: "2026-08-21T12:00:00.000Z",
        timezone: "UTC",
      }),
    ).toEqual({ kind: "none" });
  });
});
