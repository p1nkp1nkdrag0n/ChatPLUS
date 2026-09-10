import { describe, expect, it } from "vitest";

import {
  buildBlindReview,
  commonReplySteeringResults,
  renderReplySteeringReport,
  summarizeReplySteering,
  type ReplySteeringResult,
} from "./reply-steering-report.js";

function result(
  overrides: Partial<ReplySteeringResult> = {},
): ReplySteeringResult {
  return {
    id: "row-1",
    profile: "model-profile-one",
    model: "provider-model-one",
    personaId: "warm-observant",
    scenarioId: "sharing-small-delight",
    repeat: 1,
    mode: "current",
    success: true,
    statusCode: 200,
    finalText: "猫把秤都占了。",
    rawVisibleReplies: ["猫把秤都占了。"],
    elapsedMs: 100,
    logicalCalls: 1,
    physicalRequests: 1,
    retries: 0,
    repairs: 0,
    inputTokens: 100,
    outputTokens: 20,
    usageComplete: true,
    error: null,
    promptSha256: "prompt-hash",
    nonTargetPromptSha256: "shared-prompt-hash",
    repairChanged: false,
    fallback: false,
    ...overrides,
  };
}

describe("reply-steering observational reporting", () => {
  it("keeps failures in denominators and separates unknown usage from actual zero", () => {
    const summary = summarizeReplySteering([
      result({
        id: "success",
        finalText: "猫🐈",
        inputTokens: 0,
        outputTokens: 5,
      }),
      result({
        id: "failure",
        success: false,
        statusCode: 502,
        finalText: null,
        rawVisibleReplies: [],
        elapsedMs: 500,
        inputTokens: null,
        outputTokens: null,
        usageComplete: false,
        error: "provider unavailable",
        physicalRequests: 3,
        retries: 2,
      }),
    ])[0]!;
    expect(summary.successCount).toBe(1);
    expect(summary.count).toBe(2);
    expect(summary.successRate).toBe(0.5);
    expect(summary.medianFinalCharacters).toBe(2);
    expect(summary.medianElapsedMs).toBe(300);
    expect(summary.medianSuccessfulElapsedMs).toBe(100);
    expect(summary.physicalRequests).toBe(4);
    expect(summary.retries).toBe(2);
    expect(summary.inputTokens).toEqual({
      total: null,
      knownTotal: 0,
      reportedRows: 1,
      missingRows: 1,
    });
    expect(summary.outputTokens.total).toBeNull();
    expect(summary.outputTokens.knownTotal).toBe(5);
  });

  it("does not fabricate usage, response length or successful latency for wholly failed runs", () => {
    const summary = summarizeReplySteering([
      result({
        success: false,
        finalText: null,
        rawVisibleReplies: [],
        inputTokens: null,
        outputTokens: null,
        usageComplete: false,
      }),
    ])[0]!;
    expect(summary.inputTokens.knownTotal).toBeNull();
    expect(summary.outputTokens.total).toBeNull();
    expect(summary.medianFinalCharacters).toBeNull();
    expect(summary.medianRawReplyCharacters).toBeNull();
    expect(summary.medianSuccessfulElapsedMs).toBeNull();
  });

  it("only compares the same common scenarios and first repeat across model budgets", () => {
    const common = result({ id: "common" });
    const rows = [
      common,
      result({ id: "extra-repeat", repeat: 2 }),
      result({ id: "extra-scenario", scenarioId: "sharing-quiet-observation" }),
    ];
    expect(commonReplySteeringResults(rows)).toEqual([common]);
    const markdown = renderReplySteeringReport(rows);
    expect(markdown).toContain("共 3 条记录");
    expect(markdown).toContain("更短、调用更少或 HTTP 成功不等于回复更好");
    expect(markdown).toContain("不能把预算不同的全量平均值直接排名");
    expect(markdown).not.toMatch(/质量得分|冠军/u);
  });

  it("separates personality, mode and profile and exposes repairs without scoring them", () => {
    const summaries = summarizeReplySteering([
      result({ id: "one", repairs: 1, repairChanged: true, fallback: true }),
      result({ id: "two", personaId: "reserved-direct" }),
      result({ id: "three", mode: "no_length_steering" }),
      result({ id: "four", profile: "model-profile-two" }),
    ]);
    expect(summaries).toHaveLength(4);
    expect(
      summaries.find(
        (row) =>
          row.profile === "model-profile-one" &&
          row.personaId === "warm-observant" &&
          row.mode === "current",
      ),
    ).toMatchObject({ repairs: 1, repairChangedCount: 1, fallbackCount: 1 });
  });
});

describe("reply-steering blind review exports", () => {
  function matrix(): ReplySteeringResult[] {
    return ["model-profile-one", "model-profile-two"].flatMap((profile) =>
      ["warm-observant", "reserved-direct"].flatMap((personaId) =>
        ["current", "no_length_steering"].map((mode) =>
          result({
            id: `${profile}_${personaId}_${mode}`,
            profile,
            model:
              profile === "model-profile-one"
                ? "provider-model-one"
                : "provider-model-two",
            personaId,
            mode: mode as ReplySteeringResult["mode"],
            finalText:
              personaId === "warm-observant"
                ? "我是顾澜，猫也有自己的摊位了。"
                : "我是沈砚，这秤今天归猫了。",
          }),
        ),
      ),
    );
  }

  it("builds valid fixed-input pairs and hides assignment identities in review material", () => {
    const { markdown, key } = buildBlindReview(matrix(), "review-seed");
    expect(key.groups).toHaveLength(12);
    for (const kind of ["paired-steering", "cross-model", "cross-persona"]) {
      expect(key.groups.filter((group) => group.kind === kind)).toHaveLength(4);
    }
    for (const group of key.groups) {
      expect(group.scenarioId).toBe("sharing-small-delight");
      expect(group.candidates).toHaveLength(2);
      if (group.kind === "paired-steering") {
        expect(new Set(group.candidates.map((item) => item.mode)).size).toBe(2);
        expect(new Set(group.candidates.map((item) => item.profile)).size).toBe(
          1,
        );
        expect(
          new Set(group.candidates.map((item) => item.personaId)).size,
        ).toBe(1);
      }
      if (group.kind === "cross-model") {
        expect(new Set(group.candidates.map((item) => item.mode)).size).toBe(1);
        expect(
          new Set(group.candidates.map((item) => item.personaId)).size,
        ).toBe(1);
      }
      if (group.kind === "cross-persona") {
        expect(new Set(group.candidates.map((item) => item.mode)).size).toBe(1);
        expect(new Set(group.candidates.map((item) => item.profile)).size).toBe(
          1,
        );
      }
    }
    for (const identity of [
      "顾澜",
      "沈砚",
      "唐棠",
      "model-profile-one",
      "model-profile-two",
      "provider-model-one",
      "provider-model-two",
      "current",
      "no_length_steering",
      "warm-observant",
      "reserved-direct",
    ]) {
      expect(markdown).not.toContain(identity);
    }
    expect(markdown).toContain("猫也有自己的摊位了");
    expect(markdown).toContain("性格设定");
    expect(markdown).toContain("并列 / 无法区分 / 不可评分");
  });

  it("is reproducible, independent of row order and sensitive to the review seed", () => {
    const rows = matrix();
    const first = buildBlindReview(rows, 712);
    expect(buildBlindReview(rows.toReversed(), 712)).toEqual(first);
    expect(buildBlindReview(rows, 713).key).not.toEqual(first.key);
    expect(JSON.stringify(first.key)).not.toContain('"seed":');
  });

  it("retains incomplete pairs and failed responses as explicitly unscorable", () => {
    const failed = result({
      success: false,
      finalText: null,
      error: "sensitive error",
    });
    const review = buildBlindReview([failed], "partial");
    expect(review.key.groups).toHaveLength(1);
    expect(review.markdown).toContain("配对覆盖不完整");
    expect(review.markdown).toContain("标记为不可评分");
    expect(review.markdown).not.toContain("sensitive error");
    expect(review.markdown).not.toContain("质量得分");
  });

  it("pairs each isolated intervention with current and labels the combined legacy arm only outside blind review", () => {
    const modes = [
      "current",
      "no_length_steering",
      "no_length_only_steering",
      "no_chunk_count_steering",
      "no_delivery_steering",
    ] as const;
    const rows = modes.map((mode) => result({ id: mode, mode }));
    const review = buildBlindReview(rows, "isolated");
    expect(review.key.groups).toHaveLength(4);
    for (const group of review.key.groups) {
      expect(group.kind).toBe("paired-steering");
      expect(group.candidates).toHaveLength(2);
      expect(
        group.candidates.filter((candidate) => candidate.mode === "current"),
      ).toHaveLength(1);
    }
    for (const mode of modes) expect(review.markdown).not.toContain(mode);
    expect(review.markdown).not.toContain("配对覆盖不完整");
    const report = renderReplySteeringReport(rows);
    expect(report).toContain("不能归因为单独的长度效应");
    expect(report).toContain(
      "| no_length_only_steering | softTargetCharacters, lengthGuidance |",
    );
    expect(report).toContain(
      "| no_chunk_count_steering | preferredChunkCount |",
    );
    expect(report).toContain(
      "| no_delivery_steering | deliveryPreference, deliveryGuidance |",
    );
  });
});
