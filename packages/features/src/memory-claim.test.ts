import { describe, expect, it } from "vitest";

import {
  deriveExplicitUserMemoryClaim,
  extractExplicitDeadlineFact,
  extractExplicitStoredItemFact,
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

  it("maps item, deadline, and destination corrections to generic stable slots", () => {
    const cases = [
      [
        "我刚才说错了，包是藏青色，不是绿色。笔记仍在内层，书签还是 M-417。",
        "user_fact:item:notes:storage",
      ],
      [
        "更正一个事实：山鸣影像后来把回复期限延到 9 月 16 日，不是 9 月 14 日。",
        "user_fact:deadline:山鸣影像:reply",
      ],
      [
        "更正另一件事：许宁后来改去成都进修，不去重庆了。",
        "user_fact:person:许宁:destination",
      ],
    ] as const;

    for (const [evidenceText, subjectKey] of cases) {
      expect(hasExplicitMemoryCorrection(evidenceText)).toBe(true);
      expect(
        deriveExplicitUserMemoryClaim({ category: "user_fact", evidenceText }),
      ).toEqual({ subjectKey, disposition: "affirmed" });
    }
  });

  it("derives storage and deadline identity from unrelated domain language", () => {
    expect(
      extractExplicitStoredItemFact("护照放在书桌右侧抽屉。"),
    ).toMatchObject({
      item: "护照",
      subjectKey: "user_fact:item:护照:storage",
    });
    expect(
      extractExplicitStoredItemFact(
        "更正：护照放在玄关柜第二层，不在书桌右侧抽屉。",
      ),
    ).toMatchObject({
      item: "护照",
      subjectKey: "user_fact:item:护照:storage",
    });
    expect(
      extractExplicitStoredItemFact(
        "我准备留在这座城市，也建议朋友去另一个团队。",
      ),
    ).toBeUndefined();

    expect(
      extractExplicitDeadlineFact("清岚工作室的申请截止是 10 月 5 日。"),
    ).toEqual({
      subject: "清岚工作室",
      deadlineKind: "application",
      value: "10月5日",
      subjectKey: "user_fact:deadline:清岚工作室:application",
    });
    expect(
      extractExplicitDeadlineFact(
        "更正：清岚工作室的申请截止改到 10 月 8 日，不是 10 月 5 日。",
      ),
    ).toEqual({
      subject: "清岚工作室",
      deadlineKind: "application",
      value: "10月8日",
      subjectKey: "user_fact:deadline:清岚工作室:application",
    });
  });

  it.each([
    ["我把护照放在玄关柜第二层。", "护照"],
    ["我有一本很重要的采访笔记，放在帆布包的内层。", "notes"],
    ["备用钥匙的位置是书桌右侧抽屉。", "备用钥匙"],
    ["不锈钢杯收在橱柜里。", "不锈钢杯"],
    ["合同保管于档案室。", "合同"],
    ["今天有点累。我在想怎么休息。护照放在抽屉里。", "护照"],
    ["护照放在哪里？钥匙收在柜子里。", "钥匙"],
    ["更正：包是灰色，不是白色。笔记仍在内层。", "notes"],
  ])("binds storage to the item in its own assertion: %s", (text, item) => {
    expect(extractExplicitStoredItemFact(text)).toEqual({
      item,
      subjectKey: `user_fact:item:${item}:storage`,
    });
  });

  it.each([
    "我在想休息一下，还是说，对于这件事你有别的看法。",
    "拿笔在纸上蹭了几下，还是说，对于画画我没那么紧张了。",
    "我还在想今天的会议。",
    "护照放在柜子里吗？",
    "护照放在柜子里，还是抽屉里？",
    "护照放在哪里。",
    "如果护照放在柜子里，明天就容易找了。",
    "朋友说护照放在柜子里。",
    "听说护照放在柜子里。",
    "别把护照放在柜子里当成我的事实。",
    "护照没有放在柜子里。",
    "我没把护照放在柜子里。",
    "我想把护照放在柜子里。",
    "我准备把护照放在柜子里。",
    "护照可能放在柜子里。",
    "我有一本笔记。放在包的内层。",
  ])("does not infer item storage from unsupported language: %s", (text) => {
    expect(extractExplicitStoredItemFact(text)).toBeUndefined();
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
