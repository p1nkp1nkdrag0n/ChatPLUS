import { describe, expect, it } from "vitest";
import {
  buildConversationContextPlan,
  buildInteractionEvidence,
  interactionEvidencePromptView,
} from "@personasim/features";
import type { AgentTurnDecision } from "../domain/schemas.js";
import {
  conservativeSemanticReply,
  inspectSemanticReply,
} from "./semantic-reply-guard.js";

const plan = buildConversationContextPlan({
  agentId: "character",
  sessionId: "session",
  recentMessages: [],
  originalQuery: "刚刚看到一朵很漂亮的云。",
});
const evidence = buildInteractionEvidence({
  userId: "user",
  characterId: "character",
  messages: [
    {
      id: "t9",
      role: "user",
      text: "以后聊工作时，请先听我说，不要急着给建议。",
    },
    { id: "unrelated", role: "user", text: "我给小猫拍了一张照片。" },
  ],
});
const decision = (text: string, chunks = [text]): AgentTurnDecision => ({
  reply: { text, chunks, toneTags: [] },
  scheduleEffects: [],
  memoryCandidates: [],
  reasonCode: "test",
  reasonSummary: "Semantic boundary regression.",
});

describe("final reply semantic inspection", () => {
  it("checks the aggregate action load even when each delivery chunk has only one light suggestion", () => {
    const chunks = ["不如休息一下吧。", "你可以喝口水。"];
    const result = inspectSemanticReply({
      conversationPlan: plan,
      decision: decision(chunks.join("\n"), chunks),
    });
    expect(result.diagnosis).toBe("uncertain");
    expect(result.issues).toEqual([]);
    const visible = result.adviceDiagnostics.find(
      (item) => item.surface === "chunks",
    )?.inspection;
    expect(visible?.issues).toContainEqual(
      expect.objectContaining({
        code: "ADVICE_LOAD_EXCEEDS_LIGHT",
      }),
    );
    expect(visible?.confirmedIssues).toEqual([]);
    expect(
      result.issues.filter(
        (issue) => "surface" in issue && issue.surface === "chunk",
      ),
    ).toHaveLength(0);
  });

  it("does not project away harmless content or uncertain style preferences", () => {
    const original = decision("云的形状真有意思。\n不如休息一下，也可以喝水。");
    expect(
      conservativeSemanticReply({ conversationPlan: plan, decision: original }),
    ).toBe(original);
  });

  it("keeps quoted action questions intact when delivery bubbles split the quote", () => {
    const current = buildConversationContextPlan({
      agentId: "character",
      sessionId: "session",
      recentMessages: [],
      originalQuery: "这轮不用给我建议。",
    });
    const chunks = ["朋友说：“要不要洗澡，", "或者列个清单？”"];
    const original = decision(chunks.join("\n"), chunks);
    expect(
      inspectSemanticReply({ conversationPlan: current, decision: original }),
    ).toMatchObject({
      diagnosis: "none",
      issues: [],
    });
    expect(
      conservativeSemanticReply({
        conversationPlan: current,
        decision: original,
      }),
    ).toBe(original);
  });

  it("confirms a current prohibition but leaves a content question available", () => {
    const current = buildConversationContextPlan({
      agentId: "character",
      sessionId: "session",
      recentMessages: [],
      originalQuery: "先听我说，不用给我建议。",
    });
    expect(
      inspectSemanticReply({
        conversationPlan: current,
        decision: decision("要不要洗澡？"),
      }),
    ).toMatchObject({ diagnosis: "confirmed" });
    expect(
      inspectSemanticReply({
        conversationPlan: current,
        decision: decision("那家店是什么店？"),
      }),
    ).toMatchObject({ diagnosis: "none", issues: [] });
  });

  it("confirms the actual combined T3 pilot advice and preserves its separate content question", () => {
    const current = buildConversationContextPlan({
      agentId: "character",
      sessionId: "session",
      recentMessages: [],
      originalQuery:
        "拿铁挺香的。换个话题，今晚煮了面，有点咸。先听我说，不用建议。",
    });
    // Literal provider output: correction-expression-qwen-20260907-remaining,
    // combined/T3. Replaying this text offline does not rerun the provider.
    const firstSentence =
      "面条偏咸确实有点可惜，尤其是刚忙完想好好吃口热乎的时候。";
    const adviceSentence =
      "这种时候往往越喝汤越觉得齁，或者配点清淡的小菜、喝口白水顺一顺。";
    const contentQuestion = "你今晚是煮的挂面还是别的什么面？";
    const original = decision(firstSentence + adviceSentence + contentQuestion);
    const inspected = inspectSemanticReply({
      conversationPlan: current,
      decision: original,
    });
    expect(inspected.diagnosis).toBe("confirmed");
    expect(inspected.advice).toMatchObject({
      policy: "none_now",
      policyEvidence: "explicit_current",
      diagnosis: "confirmed",
    });
    expect(inspected.advice?.confirmedIssues).toContainEqual(
      expect.objectContaining({
        code: "ADVICE_NOT_REQUESTED_NOW",
        text: "喝口白水",
      }),
    );
    expect(
      inspected.adviceDiagnostics.map((item) => item.inspection.diagnosis),
    ).toEqual(["confirmed", "confirmed"]);

    const safe = conservativeSemanticReply({
      conversationPlan: current,
      decision: original,
    });
    expect(safe.reply.text).toContain(firstSentence);
    expect(safe.reply.text).toContain(contentQuestion);
    expect(safe.reply.text).not.toContain(adviceSentence);
    expect(
      inspectSemanticReply({ conversationPlan: current, decision: safe }),
    ).toMatchObject({ diagnosis: "none", issues: [] });
  });

  it.each([
    ["description", "喝口白水的感觉确实清爽。你今晚煮的是什么面？"],
    ["reported action", "你刚才配点清淡的小菜、喝口白水顺一顺。"],
    ["quotation", "朋友说：“配点清淡的小菜、喝口白水顺一顺。”"],
    ["denial", "我不是让你配点清淡的小菜、喝口白水顺一顺。"],
  ])("does not repair the T3 activity when used as %s", (_label, text) => {
    const current = buildConversationContextPlan({
      agentId: "character",
      sessionId: "session",
      recentMessages: [],
      originalQuery: "先听我说，不用建议。",
    });
    const original = decision(text);
    const inspected = inspectSemanticReply({
      conversationPlan: current,
      decision: original,
    });
    expect(inspected).toMatchObject({ diagnosis: "none", issues: [] });
    expect(inspected.advice?.confirmedIssues).toEqual([]);
    expect(
      conservativeSemanticReply({
        conversationPlan: current,
        decision: original,
      }),
    ).toBe(original);
  });

  it("rebuilds divergent visible chunks from the independently valid full text", () => {
    const original = decision("云的形状真有意思。", [
      "你可以列清单，然后去散步。",
    ]);
    expect(
      inspectSemanticReply({ conversationPlan: plan, decision: original })
        .issues,
    ).toContainEqual(
      expect.objectContaining({ code: "REPLY_SURFACES_DIVERGED" }),
    );
    const safe = conservativeSemanticReply({
      conversationPlan: plan,
      decision: original,
    });
    expect(safe.reply).toMatchObject({
      text: original.reply.text,
      chunks: [original.reply.text],
    });
    expect(original.reply.chunks).toEqual(["你可以列清单，然后去散步。"]);
  });

  it("inspects whole quote scopes before projecting complete unsupported sentences", () => {
    const quote = "朋友说：“你以前一直先听我说。你总是很耐心。”";
    const bad = "你以前一直先听我说。";
    const safe = conservativeSemanticReply({
      interactionEvidence: evidence,
      decision: decision(`${quote}\n${bad}`),
    });
    expect(safe.reply.text).toBe(quote);
    expect(
      inspectSemanticReply({ interactionEvidence: evidence, decision: safe })
        .issues,
    ).toEqual([]);
  });

  it("leaves semantic checks disabled when neither feature supplied context", () => {
    expect(
      inspectSemanticReply({
        decision: decision("full text", ["different chunk"]),
      }).issues,
    ).toEqual([]);
  });

  it("shares complete anchor sources between generation and repair without including unrelated history", () => {
    const projected = interactionEvidencePromptView(evidence);
    expect(projected.sourceMessages.map((source) => source.id)).toEqual(["t9"]);
    expect(projected.historicalAnchors).toEqual(evidence.historicalAnchors);
    expect(evidence.sourceMessages.map((source) => source.id)).toEqual([
      "t9",
      "unrelated",
    ]);
  });
});
