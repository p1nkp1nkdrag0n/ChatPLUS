import { describe, expect, it } from "vitest";
import {
  deriveFactQueryNeeds,
  extractExplicitCurrentFactProjections,
  isFactHistoryQuery,
} from "./current-fact-projection.js";

describe("finite current fact projections", () => {
  it("binds no-reason corrections independently and omits the old value", () => {
    const facts = extractExplicitCurrentFactProjections(
      "同事叫林桥，不是林乔。妹妹叫沈禾。项目编号是 BGW-7429，不是 BGW-4729。",
    );
    expect(
      facts.map(({ entity, value, revisionIntent }) => ({
        entity,
        value,
        revisionIntent,
      })),
    ).toEqual([
      { entity: "同事", value: "林桥", revisionIntent: "explicit_correction" },
      { entity: "妹妹", value: "沈禾", revisionIntent: undefined },
      {
        entity: "项目",
        value: "BGW-7429",
        revisionIntent: "explicit_correction",
      },
    ]);
    expect(facts.map((fact) => fact.content).join(" ")).not.toMatch(
      /林乔|BGW-4729/,
    );
    for (const fact of facts)
      expect(
        extractExplicitCurrentFactProjections(fact.content)[0],
      ).toMatchObject({ subjectKey: fact.subjectKey, value: fact.value });
  });
  it("retains the temporal distinction without claiming the old drink was wrong", () => {
    expect(
      extractExplicitCurrentFactProjections("以前喝咖啡，现在喝茶。"),
    ).toEqual([
      expect.objectContaining({
        value: "茶",
        previousValue: "咖啡",
        revisionIntent: "temporal_update",
        entity: "用户",
      }),
    ]);
  });
  it("plans multiple fact needs without forcing a recollection style", () => {
    expect(
      deriveFactQueryNeeds(
        "我那个项目编号是什么，妹妹的姓名和同事叫什么？",
      ).map((need) => need.subjectKey),
    ).toEqual([
      "user_fact:current:妹妹:name",
      "user_fact:current:同事:name",
      "user_fact:current:项目:identifier",
    ]);
  });
  it("keeps query ownership and local correction authority separate", () => {
    for (const text of [
      "你妹妹叫什么？",
      "我同事的妹妹叫什么？",
      "他同事的姓名是什么？",
    ])
      expect(deriveFactQueryNeeds(text)).toEqual([]);
    expect(deriveFactQueryNeeds("请告诉我项目编号是什么？")[0]?.entity).toBe(
      "项目",
    );
    expect(
      deriveFactQueryNeeds("同事姓名和项目编号是什么？").map(
        (need) => need.entity,
      ),
    ).toEqual(["同事", "项目"]);
    for (const text of [
      "同事叫林乔，不是妹妹叫沈禾。",
      "同事叫林乔，不是我说错了。",
    ])
      expect(
        extractExplicitCurrentFactProjections(text)[0]?.revisionIntent,
      ).toBeUndefined();
    expect(isFactHistoryQuery("编号之前记错了，现在项目编号是什么？")).toBe(
      false,
    );
  });
  it.each([
    "同事叫什么？",
    "同事说：同事叫林乔。",
    "如果同事叫林乔，妹妹叫沈禾。",
    "同事叫林乔，也可能叫林桥。",
    "同事叫林乔，同事叫林桥。",
    '有人说："同事叫林乔。妹妹叫沈禾。"',
    "朋友说：‘同事叫林乔。妹妹叫沈禾。’",
    "只在工作时，同事叫林桥。",
  ])(
    "does not convert unsupported or scoped text into a global fact: %s",
    (text) => {
      expect(extractExplicitCurrentFactProjections(text)).toEqual([]);
    },
  );
});
