import { CharacterSpecSchema } from "@personasim/contracts";
import { describe, expect, it } from "vitest";
import { buildOriginalDraft } from "../domain/defaults.js";
import { DiaryReviewService } from "./diary-review-service.js";
import type { GenerateObjectInput } from "./llm-service.js";

class ReviewModel {
  calls: GenerateObjectInput<unknown>[] = [];
  constructor(private readonly result: unknown = { valid: true, issues: [] }) {}
  generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    this.calls.push(input);
    if (this.result instanceof Error) return Promise.reject(this.result);
    // Deliberately do not schema-parse in this test double: the service must
    // validate even a provider which bypasses its supplied schema.
    return Promise.resolve(this.result as T);
  }
}

function input(): Parameters<DiaryReviewService["review"]>[0] {
  const nowUtc = "2026-09-13T15:59:00.000Z";
  const character = CharacterSpecSchema.parse({
    ...buildOriginalDraft({
      name: "林夏",
      worldSetting: "当代城市",
      workOrRole: "插画师",
      coreTraits: ["温暖", "重视分寸"],
      initialRelationship: "陌生人",
      dialogueStyle: "自然简洁",
      tier: "daily",
      timezone: "Asia/Shanghai",
    }),
    id: "agent-review",
    version: 1,
    status: "published",
    createdAtUtc: nowUtc,
    updatedAtUtc: nowUtc,
  });
  return {
    agentId: character.id,
    operationId: "diary-review-test:0",
    entryDate: "2026-09-13",
    character,
    material: {
      fromUtc: "2026-09-12T16:00:00.000Z",
      toUtc: "2026-09-13T16:00:00.000Z",
      sourceMessages: [
        {
          id: "message-review",
          sourceOrder: 1,
          sessionId: "session-review",
          role: "user",
          content: "我只是在考虑辞职，还没决定。",
          createdAtUtc: nowUtc,
          inReplyToMessageId: null,
          sourceNeedsReview: false,
          includedAsDaySource: true,
        },
      ],
      sourceMessageIds: ["message-review"],
      historicalStates: [],
      appraisals: [],
      dependencies: [],
      sourceHash: "test-snapshot",
    },
    draft: {
      title: "慢一点",
      paragraphs: [
        {
          text: "回头想想，我有些不自在。我希望这些私人的话题可以聊得慢一点。",
          sourceMessageIds: ["message-review"],
        },
      ],
    },
  };
}

describe("bounded diary semantic review", () => {
  it("submits full negative prose, final qualifications, persona and appraisal as quoted review data", async () => {
    const model = new ReviewModel();
    const request = input();
    request.material.sourceMessages[0]!.content =
      "这只是转述。".repeat(900) + "最后更正：这些事没有发生在我身上。";
    request.material.appraisals = [
      {
        id: "appraisal-test",
        feelings: ["concern", "discomfort"],
        privateView: ["care_without_agreement"],
        publicExpression: "我在听。",
      },
    ];
    const result = await new DiaryReviewService(model).review(request);
    expect(result).toEqual({ valid: true, issues: [] });
    expect(model.calls).toHaveLength(1);
    const call = model.calls[0]!;
    const { originalInput } = JSON.parse(call.prompt) as {
      originalInput: Record<string, unknown>;
    };
    expect(originalInput["draft"]).toEqual(request.draft);
    expect(originalInput["material"]).toEqual(request.material);
    expect(originalInput["character"]).toEqual(request.character);
    expect(call.prompt).toContain("最后更正：这些事没有发生在我身上。");
    expect(call.system).toContain("不要求温暖或讨好");
    expect(call.system).toContain("合法 sourceMessageIds 只是引用地址");
    expect(call.system).toContain("没有对应回合感受记录时");
    expect(call.system).toContain("不要把混合感受误判为矛盾");
    expect(call).toMatchObject({
      purpose: "diary_review",
      maxRetries: 0,
      maxOutputTokens: 1_500,
      operationId: request.operationId,
    });
    // Plumbing fixture, not evidence that a test model performed semantic review.
    expect(call.fixture).toEqual({ valid: true, issues: [] });
  });

  it("returns a precise rejection for the caller's existing bounded repair, without retrying itself", async () => {
    const issues = [
      "段落1把用户未决定的计划写成角色已经辞职；请恢复主体与未完成状态。",
    ];
    const model = new ReviewModel({ valid: false, issues });
    const request = input();
    request.draft.paragraphs[0]!.text = "今天我辞职了。";
    await expect(
      new DiaryReviewService(model).review(request),
    ).resolves.toEqual({ valid: false, issues });
    expect(model.calls).toHaveLength(1);
  });

  it.each([
    { valid: true, issues: ["正文与来源相反"] },
    { valid: false, issues: [] },
    { accepted: true, issues: [] },
  ])(
    "does not silently approve malformed review output: %#",
    async (result) => {
      const model = new ReviewModel(result);
      await expect(
        new DiaryReviewService(model).review(input()),
      ).rejects.toThrow();
      expect(model.calls).toHaveLength(1);
    },
  );

  it("propagates a provider failure without falling back to fixture approval", async () => {
    const failure = new Error("review provider unavailable");
    const model = new ReviewModel(failure);
    await expect(new DiaryReviewService(model).review(input())).rejects.toBe(
      failure,
    );
    expect(model.calls).toHaveLength(1);
  });
});
