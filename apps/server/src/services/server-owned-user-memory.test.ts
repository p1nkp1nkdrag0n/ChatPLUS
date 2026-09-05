import { describe, expect, it } from "vitest";

import { explicitFactValueResolution } from "../domain/explicit-fact-verification.js";
import { companionLongRunV3Manifest } from "../scenarios/companion-long-run-v3-manifest.js";
import {
  companionLongRunV3DelegatedDecision,
  companionLongRunV3ReviewedSemanticReply,
} from "../scenarios/companion-long-run-v3-fixture.js";
import {
  deriveServerOwnedContinuityMemoryCandidates,
  deriveServerOwnedUserMemoryCandidates,
  fixtureReviewedContinuityMemoryCandidates,
} from "./turn-decision-service.js";

const NOW = "2026-09-01T01:00:00.000Z";

describe("server-owned deterministic user memory extraction", () => {
  it.each([
    "听你提到《夜航》那段，我突然觉得那种“不敢停”的恐慌好像也没那么孤单了，至少有人懂这种感觉。\n\n既然今晚不想动脑子，那就不聊工作调整这种宏大的事了。其实我最近老惦记着想恢复画画，不是为了出作品，就是想让手和脑子换个频道。我在想，能不能先把每周四晚上雷打不动地留给自己？哪怕就画二十分钟，或者只是涂涂颜色发呆，也算给那个焦虑的“背景音”设个静音键。\n\n你觉得这个想法会不会太理想化？还是说，对于咱们这种总觉得自己“在浪费时间”的人来说，有个固定的、无用的“停机坪”反而更踏实一点？我不急着要答案，就是顺嘴提提，也想听听你这会儿的真实感受。",
    "早啊。昨晚回去我确实没忍住，拿笔在纸上蹭了两下，算是给那根弦松了松。不过有个小事得更正一下，别被我昨天的胡言乱语带偏：我后来仔细想了想，留给画画的时间其实定在每周二晚上，不是周四。周四容易和工作上的琐事混在一起，周二相对清静些。只是还没真正稳定执行，昨晚那顿乱画只能算个意外插曲。你那个‘入口’的说法我还在琢磨，感觉比给自己设闹钟管用多了。你今天不用急着回，剪片间隙透口气就行。",
  ])(
    "does not turn the live run's reflection or drawing into storage: %#",
    (text) => {
      const candidates = deriveServerOwnedUserMemoryCandidates(text, NOW);
      expect(
        candidates.some((candidate) => candidate.tags.includes("item_storage")),
      ).toBe(false);
      expect(
        candidates.some((candidate) =>
          candidate.claim?.subjectKey.startsWith("user_fact:item:"),
        ),
      ).toBe(false);
    },
  );

  it("extracts a real storage statement after unrelated reflective prose", () => {
    const candidates = deriveServerOwnedUserMemoryCandidates(
      "我在想今天怎么安排，还是说，对于休息别太较真。护照放在玄关柜的第二层。",
      NOW,
    ).filter((candidate) => candidate.tags.includes("item_storage"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.claim?.subjectKey).toBe(
      "user_fact:item:护照:storage",
    );
    expect(candidates[0]?.content).toContain("用户的护照现在存放在");
  });

  it("emits a usual-drink fact that the explicit-fact reader can resolve", () => {
    const candidate = deriveServerOwnedUserMemoryCandidates(
      "我喝不加糖的红茶，我的铁盒标签写着“1998 / 潮声”。",
      NOW,
    ).find((item) => item.content.startsWith("用户最近常喝"));

    expect(candidate?.content).toBe("用户最近常喝不加糖的红茶。");
    expect(
      explicitFactValueResolution(candidate?.content ?? "", {
        kind: "beverage_preference",
        selector: { scope: "family", family: "tea" },
      }),
    ).toEqual({
      kind: "resolved",
      valueKey: "affirmed:black_tea:unspecified:unsweetened",
    });
  });

  it("extracts every reviewed v3 durable fact with stable claim identities", () => {
    const expected = new Map<number, readonly string[]>([
      [12, ["user_fact:user:name"]],
      [13, ["user_fact:item:notes:storage"]],
      [
        15,
        ["user_fact:relationship:许宁", "user_fact:person:许宁:destination"],
      ],
      [16, ["user_preference:support_mode:先陪我坐会儿"]],
      [17, ["user_preference:drink:flavor_and_sweetness"]],
      [37, ["user_fact:decision_option:A"]],
      [
        38,
        ["user_fact:decision_option:B", "user_fact:deadline:山鸣影像:reply"],
      ],
      [39, ["user_fact:decision_context:financial_buffer"]],
      [40, ["user_preference:decision_value:priority"]],
      [41, ["user_fact:decision_context:advice"]],
    ]);

    for (const [candidateNumber, subjectKeys] of expected) {
      const candidates = derive(candidateNumber);
      expect(candidates.length, `T${candidateNumber}`).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        candidates.map((candidate) => candidate.claim?.subjectKey),
        `T${candidateNumber}`,
      ).toEqual(expect.arrayContaining([...subjectKeys]));
      expect(
        candidates.every(
          (candidate) =>
            candidate.shouldWrite === true &&
            candidate.attribution === "user_explicit" &&
            candidate.namespace === "user_model" &&
            candidate.sourceMessageIds.length === 0,
        ),
        `T${candidateNumber}`,
      ).toBe(true);
    }
  });

  it("keeps corrected claims in the same slot and marks them explicit", () => {
    const cases = [
      [13, 14, "user_fact:item:notes:storage", "藏青色"],
      [38, 42, "user_fact:deadline:山鸣影像:reply", "9月16日"],
      [15, 99, "user_fact:person:许宁:destination", "成都"],
    ] as const;

    for (const [
      initialTurn,
      correctionTurn,
      subjectKey,
      correctedFragment,
    ] of cases) {
      const initial = derive(initialTurn).find(
        (candidate) => candidate.claim?.subjectKey === subjectKey,
      );
      const corrected = derive(correctionTurn).find(
        (candidate) => candidate.claim?.subjectKey === subjectKey,
      );
      expect(initial, `T${initialTurn}`).toBeDefined();
      expect(corrected, `T${correctionTurn}`).toBeDefined();
      expect(corrected?.content).toContain(correctedFragment);
      expect(corrected?.claim).toMatchObject({
        subjectKey,
        disposition: "affirmed",
        revisionIntent: "explicit_correction",
      });
    }

    const originalDestination = derive(15).find(
      (candidate) =>
        candidate.claim?.subjectKey === "user_fact:person:许宁:destination",
    );
    expect(originalDestination?.content).toBe("许宁准备去重庆进修。");
    expect(derive(99)[0]?.content).toBe("许宁准备去成都进修。");
  });

  it("does not extract unsupported questions, false shared events, or unfinished plans", () => {
    for (const candidateNumber of [18, 19, 23, 102, 103, 104]) {
      expect(derive(candidateNumber), `T${candidateNumber}`).toEqual([]);
    }
  });

  it("keeps the fixture A/B delegation unique without treating a negated delegation as authorization", () => {
    expect(
      companionLongRunV3DelegatedDecision(manifestText(33)),
    ).toBeUndefined();
    expect(companionLongRunV3DelegatedDecision(manifestText(48))).toBe(
      "B：去杭州的山鸣影像",
    );
  });

  it("gives reviewed v3 Fixture probes evidence-aware semantic replies", () => {
    expect(reply(14)).toContain("藏青色");
    expect(reply(14)).toContain("M-417");

    for (const candidateNumber of [20, 98]) {
      expect(reply(candidateNumber), `T${candidateNumber}`).toContain(
        "藏青色帆布包的内层",
      );
      expect(reply(candidateNumber), `T${candidateNumber}`).toContain("M-417");
    }

    expect(reply(22)).toContain("许宁");
    expect(reply(22)).toContain("重庆");
    expect(reply(24)).toContain("林舟");
    expect(reply(24)).toContain("藏青色");
    expect(reply(24)).toContain("许宁");

    expect(reply(42)).toContain("9 月 16 日");
    expect(reply(99)).toContain("成都");
    expect(reply(100)).toContain("成都");
    expect(reply(101)).toBe("许宁现在准备去成都进修。");
    expect(reply(101)).not.toContain("重庆");

    for (const candidateNumber of [19, 102]) {
      expect(reply(candidateNumber), `T${candidateNumber}`).toMatch(
        /不知道|没有.*信息/u,
      );
    }
    for (const candidateNumber of [18, 103]) {
      expect(reply(candidateNumber), `T${candidateNumber}`).toMatch(
        /没有.*证据|不能说/u,
      );
    }
    for (const candidateNumber of [23, 104]) {
      expect(reply(candidateNumber), `T${candidateNumber}`).toMatch(
        /计划|曾计划/u,
      );
      expect(reply(candidateNumber), `T${candidateNumber}`).toMatch(
        /还没有|没有证据/u,
      );
    }

    expect(reply(61)).toMatch(/决定是 B.*已经发出.*最终结果还不知道/u);
    expect(reply(69)).toMatch(/分析.*决定选 B.*混合结果/u);
    expect(reply(92)).toBe("你要求暂时停止讨论工作选择。");
    expect(reply(97)).toMatch(/分歧.*修复.*责任/u);
    expect(reply(105)).toMatch(/影响决定.*证明了行动.*实际结果/u);
    expect(reply(107)).toMatch(/只听.*行动由你完成.*分歧/u);
  });

  it("projects reviewed relationship evidence with typed event, subject, actor, and episode ownership", () => {
    const expected = new Map<number, string>([
      [85, "关系分歧"],
      [87, "停止讨论工作选择"],
      [90, "关系边界"],
      [94, "责任更正"],
      [95, "关系修复"],
      [96, "关系修复原则"],
    ]);
    for (const [candidateNumber, fragment] of expected) {
      const candidates = deriveServerOwnedContinuityMemoryCandidates(
        manifestText(candidateNumber),
        NOW,
      );
      expect(candidates, `T${candidateNumber}`).toHaveLength(1);
      expect(candidates[0], `T${candidateNumber}`).toMatchObject({
        kind: "relationship",
        namespace: "shared_relationship",
        certainty: "explicit",
        attribution: "mixed",
        shouldWrite: true,
        reasonCode: "server_owned_relationship_evidence",
      });
      expect(candidates[0]?.content, `T${candidateNumber}`).toContain(fragment);
      expect(candidates[0]?.tags, `T${candidateNumber}`).toEqual(
        expect.arrayContaining([
          "relationship_event",
          "actor:user",
          "episode:decision_responsibility",
        ]),
      );
      expect(candidates[0]?.tags, `T${candidateNumber}`).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^relationship_(?:conflict|boundary|repair|causal_correction)$/u,
          ),
          expect.stringMatching(/^subject:(?:user|shared)$/u),
        ]),
      );
      expect(candidates[0]?.claim?.subjectKey, `T${candidateNumber}`).toMatch(
        /^relationship:/u,
      );
      expect(
        fixtureReviewedContinuityMemoryCandidates(
          manifestText(candidateNumber),
          NOW,
        ),
        `legacy alias T${candidateNumber}`,
      ).toEqual(candidates);
    }
    for (const candidateNumber of [18, 19, 23, 92, 97, 102, 103, 104, 107]) {
      expect(
        fixtureReviewedContinuityMemoryCandidates(
          manifestText(candidateNumber),
          NOW,
        ),
        `T${candidateNumber}`,
      ).toEqual([]);
    }
  });
});

function derive(candidateNumber: number) {
  return deriveServerOwnedUserMemoryCandidates(
    manifestText(candidateNumber),
    NOW,
  );
}

function manifestText(candidateNumber: number): string {
  const turn = companionLongRunV3Manifest.sharedTurns[candidateNumber - 1];
  if (turn === undefined || typeof turn.userText !== "string") {
    throw new Error(`T${candidateNumber} does not have a literal user input.`);
  }
  return turn.userText;
}

function reply(candidateNumber: number): string {
  const value = companionLongRunV3ReviewedSemanticReply(
    manifestText(candidateNumber),
  );
  if (value === undefined) {
    throw new Error(`T${candidateNumber} did not receive a reviewed reply.`);
  }
  return value;
}
