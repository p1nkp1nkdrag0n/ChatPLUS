import { describe, expect, it } from "vitest";

import {
  buildInteractionEvidence,
  inspectInteractionAttribution,
} from "./interaction-attribution.js";

const identities = { userId: "user-1", characterId: "character-1" };
const request = {
  id: "t9",
  role: "user" as const,
  text: "以后聊工作时，请先听我说，不要急着给建议。",
};
const evidence = buildInteractionEvidence({
  ...identities,
  messages: [request],
});
const check = (text: string) =>
  inspectInteractionAttribution({ text, evidence });

describe("directed interaction evidence", () => {
  it("builds requested direction from original user text, independently of active topic", () => {
    expect(evidence.historicalAnchors).toHaveLength(1);
    expect(evidence.historicalAnchors[0]).toMatchObject({
      expectedActor: "character:character-1",
      recipient: "user:user-1",
      requestedBy: "user:user-1",
      behavior: "listen_first",
      scope: { topic: "工作" },
      modality: "requested",
      sourceMessageIds: ["t9"],
      observedAdherenceEvidenceIds: [],
    });
    expect(evidence.activePracticeAnchorIds).toEqual([]);
    const active = buildInteractionEvidence({
      ...identities,
      messages: [request],
      activePractices: [
        {
          id: "practice-1",
          sourceMessageId: "t9",
          practice: "listen_first",
          scope: { topic: "工作" },
        },
      ],
    });
    expect(active.historicalAnchors).toEqual(evidence.historicalAnchors);
    expect(active.activePracticeAnchorIds).toEqual([
      evidence.historicalAnchors[0]!.id,
    ]);
  });

  it("I01 catches the original reversed history in spontaneous reply text", () => {
    const result = check(
      "嗯，明白了，是他对别人说的，跟你没关系。你之前一直记得先听我说不急着给建议，那份是你主动给的，跟这事是两码事。",
    );
    expect(result.allowed).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "INTERACTION_DIRECTION_INVERTED",
      "REQUEST_PROMOTED_TO_HISTORY",
      "UNSUPPORTED_REPEATED_BEHAVIOR_CLAIM",
    ]);
    expect(result.violations[0]).toMatchObject({
      evidenceStatus: "insufficient",
      sourceMessageIds: ["t9"],
      text: "你之前一直记得先听我说",
      surface: "text",
    });
  });

  it.each([
    "你希望我在工作话题先听你说。",
    "你之前说过希望我先听你说完。",
    "你要求我别急着给建议，先听你说。",
    "我会先听你说，等你说完再一起想。",
    "我之前听你说过这个项目。",
  ])("I02 preserves the request or a new intention: %s", (text) => {
    expect(check(text).allowed).toBe(true);
  });

  it.each([
    "这些年我一直先听你说。",
    "我每次都耐心等你讲完。",
    "过去我总是先听你倾诉。",
    "我昨天先听你说完了。",
    "我答应过你先听你说。",
  ])("I03 prevents a request becoming an observed history: %s", (text) => {
    expect(check(text).allowed).toBe(false);
  });

  it("I04 does not turn a third-party report into a dyadic request", () => {
    const thirdParty = buildInteractionEvidence({
      ...identities,
      messages: [
        {
          id: "t14",
          role: "user",
          text: "我有个朋友说‘以后少追问我’，那是他跟别人说的，不是在替我提要求。",
        },
      ],
    });
    expect(thirdParty.historicalAnchors).toEqual([]);
    expect(
      check("明白，是你朋友对另一个人说的，不是你在改我们之间的相处方式。")
        .allowed,
    ).toBe(true);
  });

  it("I05 accepts a later voluntary reverse direction without fabricating adherence", () => {
    const withOffer = buildInteractionEvidence({
      ...identities,
      messages: [
        request,
        { id: "offer", role: "user", text: "我也愿意先听你说。" },
      ],
    });
    expect(withOffer.historicalAnchors[1]).toMatchObject({
      expectedActor: "user:user-1",
      recipient: "character:character-1",
      modality: "willing",
    });
    expect(
      inspectInteractionAttribution({
        text: "你也愿意先听我说。",
        evidence: withOffer,
      }).allowed,
    ).toBe(true);
    const falseHistory = inspectInteractionAttribution({
      text: "你之前一直先听我说。",
      evidence: withOffer,
    });
    expect(falseHistory.allowed).toBe(false);
    expect(falseHistory.violations.map((violation) => violation.code)).toEqual([
      "UNSUPPORTED_REPEATED_BEHAVIOR_CLAIM",
    ]);
  });

  it.each([
    "我不是说你之前一直先听我说。",
    "你并没有一直先听我说，我也没有这么要求。",
    "你不总是先听我说，这不是固定规矩。",
    "不能说你之前一直听我说，这个说法没有依据。",
    "‘你之前一直先听我说’这句话把方向说反了。",
    "如果你一直先听我说，也许会有不同的感觉。",
    "你朋友说你一直先听我说，那只是他的转述。",
    "你之前一直先听我说吗？",
  ])(
    "I06 keeps negations, quotations, hypotheses and questions separate: %s",
    (text) => {
      expect(check(text).allowed).toBe(true);
    },
  );

  it("supports user-confirmed reverse history, not just the initial preference direction", () => {
    const withHistory = buildInteractionEvidence({
      ...identities,
      messages: [
        request,
        {
          id: "observed",
          role: "user",
          text: "这些年我一直先听你说，然后才说自己的事情。",
        },
      ],
    });
    expect(
      inspectInteractionAttribution({
        text: "你一直先听我说。",
        evidence: withHistory,
      }).allowed,
    ).toBe(true);
  });

  it("does not use one observed occasion as proof of repeated adherence", () => {
    const one = buildInteractionEvidence({
      ...identities,
      messages: [
        request,
        { id: "once", role: "user", text: "你昨天确实先听我说完了。" },
      ],
    });
    expect(
      inspectInteractionAttribution({
        text: "我昨天先听你说完了。",
        evidence: one,
      }).allowed,
    ).toBe(true);
    expect(
      inspectInteractionAttribution({
        text: "我每次都会先听你说。",
        evidence: one,
      }).allowed,
    ).toBe(false);
  });

  it("distinguishes a past promise from either a request or one successful interaction", () => {
    const promise = buildInteractionEvidence({
      ...identities,
      messages: [
        request,
        { id: "promise", role: "user", text: "你答应过我先听我说。" },
      ],
    });
    expect(
      inspectInteractionAttribution({
        text: "我答应过你先听你说。",
        evidence: promise,
      }).allowed,
    ).toBe(true);
    expect(
      inspectInteractionAttribution({
        text: "我每次先听你说。",
        evidence: promise,
      }).allowed,
    ).toBe(false);
    const one = buildInteractionEvidence({
      ...identities,
      messages: [
        { id: "once", role: "user", text: "你昨天确实先听我说完了。" },
      ],
    });
    expect(
      inspectInteractionAttribution({
        text: "我答应过你先听你说。",
        evidence: one,
      }).allowed,
    ).toBe(false);
  });

  it("checks historical requests without prohibiting a new request by the character", () => {
    expect(check("我以前希望你先听我说。").allowed).toBe(false);
    expect(check("我希望你先听我说。").allowed).toBe(true);
  });

  it("never lets an old assistant assertion corroborate itself", () => {
    const oldAssistant = buildInteractionEvidence({
      ...identities,
      messages: [
        request,
        { id: "bad-old", role: "assistant", text: "你之前一直先听我说。" },
      ],
    });
    expect(oldAssistant.historicalAnchors).toEqual(evidence.historicalAnchors);
    expect(
      inspectInteractionAttribution({
        text: "你之前一直先听我说。",
        evidence: oldAssistant,
      }).allowed,
    ).toBe(false);
  });

  it("checks the actual old chunk even when the main text has been repaired", () => {
    const result = inspectInteractionAttribution({
      text: "明白，是你朋友对别人说的。",
      chunks: ["明白，是你朋友对别人说的。", "你之前一直记得先听我说。"],
      evidence,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations[0]).toMatchObject({
      surface: "chunk",
      chunkIndex: 1,
    });
    const issue = result.violations[0]!;
    expect("你之前一直记得先听我说。".slice(issue.start, issue.end)).toBe(
      issue.text,
    );
  });

  it("handles fewer-question direction with separate user evidence", () => {
    const fewer = buildInteractionEvidence({
      ...identities,
      messages: [{ id: "fewer", role: "user", text: "以后请少追问我。" }],
    });
    expect(fewer.historicalAnchors[0]?.behavior).toBe("fewer_questions");
    expect(
      inspectInteractionAttribution({
        text: "你以前总是少追问我。",
        evidence: fewer,
      }).violations.map((violation) => violation.code),
    ).toContain("INTERACTION_DIRECTION_INVERTED");
  });

  it.each([
    "不用先听我说，直接给我建议。",
    "如果我请你先听我说，你会怎么做？",
    "她说‘以后先听我说’，但那是她对另一个人说的。",
    "我不希望你先听我说，给我建议就好。",
    "我不愿意先听你说。",
  ])(
    "does not invent request anchors from negation or quotation: %s",
    (text) => {
      expect(
        buildInteractionEvidence({
          ...identities,
          messages: [{ id: "control", role: "user", text }],
        }).historicalAnchors,
      ).toEqual([]);
    },
  );
});
