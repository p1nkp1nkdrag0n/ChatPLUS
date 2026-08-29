import { describe, expect, it } from "vitest";

import {
  deriveExplicitUserMemoryClaim,
  hasExplicitMemoryCorrection,
} from "./memory-claim.js";
import {
  mergeMemoryProposal,
  type MemoryLike,
  type MemoryProposalLike,
} from "./memory-engine.js";

const OLD = "2026-08-21T10:00:00.000Z";
const NOW = "2026-08-21T10:01:00.000Z";

describe("verified user memory claim derivation", () => {
  it("maps a short relationship fact and its correction to one slot", () => {
    const first = deriveExplicitUserMemoryClaim({
      category: "user_fact",
      evidenceText: "小林是我大学同学。",
    });
    const corrected = deriveExplicitUserMemoryClaim({
      category: "user_fact",
      evidenceText: "更正：小林是我高中同学。",
    });

    expect(first).toEqual({
      subjectKey: "user_fact:relationship:小林",
      disposition: "affirmed",
    });
    expect(corrected).toEqual(first);
    expect(hasExplicitMemoryCorrection("更正：小林是我高中同学")).toBe(true);
  });

  it("derives one stable slot for a beverage preference", () => {
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_preference",
        evidenceText: "我喝咖啡通常喜欢无糖",
      }),
    ).toEqual({
      subjectKey: "user_preference:drink:咖啡",
      disposition: "affirmed",
    });
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_preference",
        evidenceText: "更新一下：我的咖啡偏好是加一份糖",
      }),
    ).toEqual({
      subjectKey: "user_preference:drink:咖啡",
      disposition: "affirmed",
    });
  });

  it("maps the long-run manifest drink update to the original preference slot", () => {
    const first = deriveExplicitUserMemoryClaim({
      category: "user_preference",
      evidenceText: "我平时更喜欢茉莉花茶，不太喝咖啡。",
    });
    const updated = deriveExplicitUserMemoryClaim({
      category: "user_preference",
      evidenceText: "更新一下：最近我不太喝茉莉花茶了，更常喝温水。",
    });
    const pairedFixture = deriveExplicitUserMemoryClaim({
      category: "user_preference",
      evidenceText: "我最近常喝温水。",
    });

    expect(first).toEqual({
      subjectKey: "user_preference:drink:usual",
      disposition: "affirmed",
    });
    expect(updated).toEqual(first);
    expect(pairedFixture).toEqual(first);
    expect(
      hasExplicitMemoryCorrection(
        "更新一下：最近我不太喝茉莉花茶了，更常喝温水。",
      ),
    ).toBe(true);
  });

  it("maps the long-run compound person correction to the original relation slot", () => {
    const first = deriveExplicitUserMemoryClaim({
      category: "user_fact",
      evidenceText: "小林是我大学同学，现在住在苏州。",
    });
    const corrected = deriveExplicitUserMemoryClaim({
      category: "user_fact",
      evidenceText: "我刚才说错了，小林其实是高中同学；他确实住在苏州。",
    });
    expect(first).toEqual({
      subjectKey: "user_fact:relationship:小林",
      disposition: "affirmed",
    });
    expect(corrected).toEqual(first);
    expect(
      hasExplicitMemoryCorrection(
        "我刚才说错了，小林其实是高中同学；他确实住在苏州。",
      ),
    ).toBe(true);
  });

  it("uses candidate content to select a supported fact from compound evidence", () => {
    const evidenceText = "小林是我大学同学，现在住在苏州。";
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText,
        candidateContent: "小林是用户的大学同学。",
      }),
    ).toEqual({
      subjectKey: "user_fact:relationship:小林",
      disposition: "affirmed",
    });
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText,
        candidateContent: "小林的居住地是苏州。",
      }),
    ).toEqual({
      subjectKey: "user_fact:小林:居住地",
      disposition: "affirmed",
    });
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText: "小林是我大学同学。",
        candidateContent: "小林的居住地是宁波。",
      }),
    ).toBeUndefined();
  });

  it("structures a direct fact after an explicit memory-instruction prefix", () => {
    const evidenceText = "再记一件：阿青是我的表姐，现在住在宁波。";
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText,
        candidateContent: "阿青是用户的表姐。",
      }),
    ).toEqual({
      subjectKey: "user_fact:relationship:阿青",
      disposition: "affirmed",
    });
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText,
        candidateContent: "阿青的居住地是宁波。",
      }),
    ).toEqual({
      subjectKey: "user_fact:阿青:居住地",
      disposition: "affirmed",
    });
  });

  it.each([
    "小林是我大学同学吗？",
    "小林是不是我大学同学",
    "小林是否是我大学同学",
    "如果小林是我大学同学，就太巧了。",
    "我假设小林是我大学同学",
    "比如小林是我大学同学。",
    "小林说他是我大学同学。",
    "朋友说小林是我大学同学",
    "同事声称小林是我大学同学",
    "小林不是我大学同学",
    "别把小林是我大学同学当成我的事实",
  ])("does not structure a non-assertive or disclaimed message: %s", (text) => {
    expect(
      deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText: text,
      }),
    ).toBeUndefined();
  });
});

describe("explicit correction memory identity", () => {
  it("does not reuse a highly similar active memory id", () => {
    const existing: MemoryLike = {
      id: "memory-old",
      agentId: "agent-1",
      kind: "semantic",
      content: "The user's emergency phone number is 13800000000.",
      importance: 0.9,
      confidence: 1,
      tags: ["user_fact"],
      sourceMessageIds: ["message-old"],
      sourceActivityEventIds: [],
      origin: "runtime_simulation",
      status: "active",
      dedupeKey: "old-key",
      claim: {
        subjectKey: "user_fact:user:emergency_phone_number",
        disposition: "affirmed",
        recordedAtUtc: OLD,
      },
      createdAtUtc: OLD,
      updatedAtUtc: OLD,
    };
    const proposal: MemoryProposalLike = {
      kind: "semantic",
      content: "The user's emergency phone number is 13800000001.",
      importance: 0.9,
      confidence: 1,
      tags: ["user_fact"],
      sourceMessageIds: ["message-new"],
      sourceActivityEventIds: [],
      origin: "runtime_simulation",
      claim: {
        subjectKey: "user_fact:user:emergency_phone_number",
        disposition: "affirmed",
        recordedAtUtc: NOW,
        revisionIntent: "explicit_correction",
      },
      reasonCode: "explicit_user_fact",
      reasonSummary: "The user explicitly corrected the fact.",
    };

    const merged = mergeMemoryProposal("agent-1", proposal, [existing], NOW);

    expect(merged?.memory.id).not.toBe(existing.id);
    expect(merged?.memory.claim?.revisionIntent).toBe("explicit_correction");
  });
});
