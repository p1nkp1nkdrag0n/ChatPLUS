import { describe, expect, it } from "vitest";

import { LetterGenerationContextV1Schema } from "@personasim/contracts";

import {
  canonicalCorrespondenceJson,
  canonicalLetterContent,
  canonicalLetterGenerationSnapshot,
  canonicalLetterReplyContent,
} from "./canonical-json.js";

describe("canonicalCorrespondenceJson", () => {
  it("sorts object keys recursively while preserving arrays and Unicode", () => {
    expect(
      canonicalCorrespondenceJson({
        z: { later: "信", earlier: 1 },
        array: [{ b: 2, a: 1 }, "甲", "乙"],
        a: true,
      }),
    ).toBe(
      '{"a":true,"array":[{"a":1,"b":2},"甲","乙"],"z":{"earlier":1,"later":"信"}}',
    );
  });

  it("rejects values that cannot participate in canonical JSON", () => {
    expect(() =>
      canonicalCorrespondenceJson({ kept: 1, lost: undefined }),
    ).toThrow();
    expect(() => canonicalCorrespondenceJson([1, Number.NaN])).toThrow();
  });

  it("uses deterministic code-unit ordering for non-ASCII keys", () => {
    expect(canonicalCorrespondenceJson({ 甲: 1, a: 0, 乙: 2 })).toBe(
      '{"a":0,"乙":2,"甲":1}',
    );
  });

  it("binds visible subject/body content while excluding reply control metadata", () => {
    expect(
      canonicalLetterContent({ subject: "问候", body: "见字如面。" }),
    ).toBe('{"body":"见字如面。","subject":"问候"}');
    const base = {
      subject: "回信",
      salutation: "亲爱的朋友：",
      paragraphs: ["来信收到。"],
      closing: "顺颂安好",
      signature: "林",
      referencedEvidenceIds: ["evidence-1"],
    };
    expect(canonicalLetterReplyContent(base)).toBe(
      canonicalLetterReplyContent({
        ...base,
        referencedEvidenceIds: ["evidence-2"],
      }),
    );
  });

  it("binds snapshot context and ordered evidence IDs in one canonical value", () => {
    expect(
      canonicalLetterGenerationSnapshot({
        contextJson: { z: 2, a: 1 },
        evidenceIds: ["evidence-b", "evidence-a"],
      }),
    ).toBe(
      '{"contextJson":{"a":1,"z":2},"evidenceIds":["evidence-b","evidence-a"]}',
    );
  });

  it("does not materialize readyKeepsakes while parsing a legacy v1 snapshot", () => {
    const legacyContext = {
      schemaVersion: 1 as const,
      effectiveAtUtc: "2026-09-08T12:00:00.000Z",
      sourceWindow: {
        fromUtc: "2026-09-03T12:00:00.000Z",
        throughUtc: "2026-09-08T12:00:00.000Z",
      },
      character: {
        version: 1,
        identity: {},
        persona: {},
        dialogue: {},
        userRelationship: {},
        knowledge: {},
      },
      runtimeState: {},
      relationship: {},
      fuzzyLife: {
        dailyContext: null,
        intents: [],
        threads: [],
        verifiedOutcomes: [],
        causalRecords: [],
      },
      intervalDigest: { activityEvents: [], lifeOutcomes: [] },
      memoryEvidence: [],
      conversationTail: [],
      priorCorrespondence: [],
      budgets: {},
    };
    const before = canonicalLetterGenerationSnapshot({
      contextJson: legacyContext,
      evidenceIds: [],
    });
    const parsed = LetterGenerationContextV1Schema.parse(legacyContext);

    expect("readyKeepsakes" in parsed).toBe(false);
    expect(
      canonicalLetterGenerationSnapshot({
        contextJson: parsed,
        evidenceIds: [],
      }),
    ).toBe(before);
  });
});
