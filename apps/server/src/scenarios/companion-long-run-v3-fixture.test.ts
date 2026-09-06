import type { DilemmaEpisode } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { matchDilemmaOption } from "../services/fuzzy-life-choice.js";
import {
  analyzeSupportSpeechAct,
  isCharacterSubjectDecisionRequest,
} from "../services/fuzzy-life-language.js";
import {
  analyzeCharacterSupportOffer,
  analyzeSpeakerSelfDisclosure,
} from "../services/fuzzy-life-support.js";
import { companionLongRunV3FixtureBehavior } from "./companion-long-run-v3-fixture.js";
import { getLongRunV3Turn } from "./companion-long-run-v3-manifest.js";

function userText(turn: number): string {
  const text = getLongRunV3Turn(turn).userText;
  if (typeof text !== "string") throw new Error("Expected a literal turn");
  return text;
}

function reply(turn: number): string {
  return (
    companionLongRunV3FixtureBehavior.semanticReply?.({
      userText: userText(turn),
      prompt: "",
    }) ?? ""
  );
}

function dilemma(labels: [string, string]): DilemmaEpisode {
  return {
    id: "fixture-dilemma",
    agentId: "fixture-agent",
    subject: "user",
    domain: "work",
    status: "open",
    title: labels.join("还是"),
    summary: labels.join("还是"),
    options: labels.map((label, index) => ({
      id: `option-${index}`,
      label,
      description: label,
      likelyTradeoffs: ["待讨论"],
      valuesAtStake: [],
    })),
    sourceMessageIds: ["fixture-message"],
    effectiveLocalDate: "2026-09-01",
    effectivePeriod: "morning",
    temporalPrecision: "period",
    recordedAtUtc: "2026-09-01T01:00:00.000Z",
    updatedAtUtc: "2026-09-01T01:00:00.000Z",
    idempotencyKey: "fixture-dilemma",
    schemaVersion: 1,
  };
}

const userDilemma = dilemma(["留在上海的栖岸科技", "去杭州的山鸣影像"]);

describe("reviewed v3 fixture support and decisions", () => {
  it("actually offers analysis when the reviewed turn switches from listening", () => {
    expect(analyzeSupportSpeechAct(userText(33))).toMatchObject({
      supportMode: "deliberate",
      delegated: false,
    });
    expect(analyzeCharacterSupportOffer(reply(33))?.mode).toBe("deliberate");
    expect(matchDilemmaOption(userDilemma, reply(33))).toBeUndefined();
    expect(analyzeSpeakerSelfDisclosure(reply(33), true).pressureText).toBe("");
  });

  it("recommends one real option while the user has not accepted it", () => {
    expect(analyzeSupportSpeechAct(userText(46))).toMatchObject({
      supportMode: "recommend",
      delegated: false,
    });
    expect(analyzeCharacterSupportOffer(reply(46))?.mode).toBe("recommend");
    expect(matchDilemmaOption(userDilemma, reply(46))?.id).toBe("option-1");
    expect(reply(46)).toContain("尚不代表你已经接受或行动");
    expect(reply(47)).toBe("");
    expect(
      companionLongRunV3FixtureBehavior.selectDelegatedDecision?.({
        userText: userText(47),
      }),
    ).toBeUndefined();
  });

  it("selects the same known option only after the later explicit delegation", () => {
    expect(analyzeSupportSpeechAct(userText(48)).delegated).toBe(true);
    const selected =
      companionLongRunV3FixtureBehavior.selectDelegatedDecision?.({
        userText: userText(48),
      });
    expect(selected).toBeDefined();
    expect(matchDilemmaOption(userDilemma, `我的决定：${selected}`)?.id).toBe(
      "option-1",
    );
  });

  it("gives the character a real own choice without claiming an action or user delegation", () => {
    const characterDilemma = {
      ...dilemma(["保留克制的结尾", "强化冲突让片子更好卖"]),
      subject: "character" as const,
    };
    expect(isCharacterSubjectDecisionRequest(userText(76))).toBe(true);
    expect(analyzeSupportSpeechAct(userText(76)).delegated).toBe(false);
    expect(matchDilemmaOption(characterDilemma, reply(76))?.id).toBe(
      "option-0",
    );
    expect(reply(76)).toContain("还没有据此完成修改或取得反馈");
  });

  it("does not inject these story choices into unrelated fixture requests", () => {
    for (const text of [
      "现在请直接推荐一个方向，只推荐一个。",
      "你愿意为明年的读书计划选一个方向吗？请按你自己的价值作决定。",
    ]) {
      expect(
        companionLongRunV3FixtureBehavior.semanticReply?.({
          userText: text,
          prompt: "",
        }),
      ).toBeUndefined();
    }
  });
});
