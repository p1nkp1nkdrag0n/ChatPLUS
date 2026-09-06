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
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "ADVICE_LOAD_EXCEEDS_LIGHT",
        surface: "chunks",
      }),
    );
    expect(
      result.issues.filter(
        (issue) => "surface" in issue && issue.surface === "chunk",
      ),
    ).toHaveLength(0);
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
