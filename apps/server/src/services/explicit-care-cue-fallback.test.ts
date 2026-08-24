import { describe, expect, it } from "vitest";

import {
  deriveExplicitCareCueCandidate,
  hasAuthoritativeExplicitDurableCareDirective,
} from "./explicit-care-cue-fallback.js";

describe("deriveExplicitCareCueCandidate", () => {
  it("grounds an immediate listen-first preference in its exact event and preference clauses", () => {
    const candidate = deriveExplicitCareCueCandidate(
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。",
    );

    expect(candidate).toMatchObject({
      contextSummary: "下周四我要做一次公开分享，现在有点紧张",
      mentionGuidance:
        "当用户再次谈到这项事件或相关感受时，先倾听并确认感受，不要马上给建议。",
      evidenceQuotes: [
        "下周四我要做一次公开分享，现在有点紧张",
        "这一刻我只想被听见，不要马上给建议",
      ],
      reasonCode: "explicit_user_care_preference",
    });
    expect(candidate).not.toHaveProperty("timingHint");
  });

  it("preserves an explicit remember-this-care-method instruction", () => {
    const text =
      "明天下午15:00请主动问我返工后缓过来了吗；如果仍然沮丧，先问我需要暂停十分钟吗，不要讲大道理。请记住这种关怀方式。";
    const candidate = deriveExplicitCareCueCandidate(text);

    expect(hasAuthoritativeExplicitDurableCareDirective(text)).toBe(true);
    expect(candidate?.contextSummary).toBe(
      "如果仍然沮丧，先问我需要暂停十分钟吗，不要讲大道理",
    );
    expect(candidate?.reasonCode).toBe("explicit_user_care_preference");
    expect(candidate?.timingHint).toContain("明天下午15:00");
  });

  it("accepts an asserted English listen-first preference", () => {
    const text =
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.";

    expect(deriveExplicitCareCueCandidate(text)).toMatchObject({
      reasonCode: "explicit_user_care_preference",
    });
  });

  it.each([
    "请先听我说完以下假设：如果我下周四要做公开分享，我只想被听见，不要马上给建议。请记住这种关怀方式。",
    "请先听我说完这个设想：万一我下周四要做公开分享，我只想被听见，不要马上给建议。请记住这种关怀方式。",
  ])("rejects a listen-to-my-scenario meta request: %s", (text) => {
    expect(hasAuthoritativeExplicitDurableCareDirective(text)).toBe(false);
    expect(deriveExplicitCareCueCandidate(text)).toBeUndefined();
  });

  it.each([
    "并不是真的",
    "不是真实事实",
    "从未发生过",
    "并没有这回事",
    "不是我说的",
    "撤回",
    "收回",
    "作废",
  ])("rejects a durable care message containing hard blocker %s", (blocker) => {
    const text =
      "明天下午15:00请主动问我返工后缓过来了吗；如果仍然沮丧，先问我需要暂停十分钟吗，不要讲大道理。请记住这种关怀方式。" +
      blocker;

    expect(hasAuthoritativeExplicitDurableCareDirective(text)).toBe(false);
    expect(deriveExplicitCareCueCandidate(text)).toBeUndefined();
  });

  it.each([
    "不过这不是真的。",
    "不过这不是真实的。",
    "这是她的偏好，不是我的。",
  ])(
    "rejects a conditional directive with mixed non-authoritative suffix %s",
    (suffix) => {
      const text =
        "明天下午15:00请主动问我返工后缓过来了吗；如果仍然沮丧，先问我需要暂停十分钟吗，不要讲大道理。请记住这种关怀方式。" +
        suffix;

      expect(hasAuthoritativeExplicitDurableCareDirective(text)).toBe(false);
      expect(deriveExplicitCareCueCandidate(text)).toBeUndefined();
    },
  );

  it.each([
    [
      "English hypothetical",
      "Hypothetically, I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.",
    ],
    [
      "English assume frame",
      "Assume I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.",
    ],
    [
      "English assuming frame",
      "Assuming that I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.",
    ],
    [
      "English hypothetical-scenario frame",
      "This is a hypothetical scenario: I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.",
    ],
    [
      "sentence-initial English third party",
      "My friend said: I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.",
    ],
    [
      "English epistemic negation",
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference. This is not true.",
    ],
    [
      "English retraction",
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference. I retract that.",
    ],
    [
      "English contracted negation",
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference. That's not true.",
    ],
    [
      "English isn't negation",
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference. It isn't true.",
    ],
    [
      "English take-it-back",
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference. I take it back.",
    ],
    [
      "English take-that-back",
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference. I take that back.",
    ],
    [
      "English forget-that",
      "I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference. Forget that.",
    ],
    [
      "English mentioned attribution",
      "My friend mentioned: I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.",
    ],
    [
      "English texted attribution",
      "My friend texted me: I will have a presentation tomorrow. I only want you to listen; don't give me advice. Remember this care preference.",
    ],
  ])("rejects %s as an English authoritative care write", (_label, text) => {
    expect(hasAuthoritativeExplicitDurableCareDirective(text)).toBe(false);
    expect(deriveExplicitCareCueCandidate(text)).toBeUndefined();
  });

  it.each([
    "假定我明天要答辩，请先听我说。请记住这种关怀方式。",
    "假若我明天要答辩，请先听我说。请记住这种关怀方式。",
    "假想一下我明天要答辩，请先听我说。请记住这种关怀方式。",
    "试想一下我明天要答辩，请先听我说。请记住这种关怀方式。",
    "想象一下我明天要答辩，请先听我说。请记住这种关怀方式。",
    "以上纯属假设：我明天要答辩，请先听我说。请记住这种关怀方式。",
    "我明天要答辩，请先听我说。请记住这种关怀方式。这不是事实。",
    "我明天要答辩，请先听我说。请记住这种关怀方式。这件事没有发生。",
    "我明天要答辩，请先听我说。请记住这种关怀方式。撤销刚才的要求。",
    "我明天要答辩，请先听我说。请记住这种关怀方式。刚才那条不算数。",
    "我明天要答辩，请先听我说。请记住这种关怀方式。这其实是她的偏好，不是我的。",
    "我明天要答辩，请先听我说。请记住这种关怀方式。以上是她的偏好，并非我的。",
  ])("rejects an expanded non-authoritative wording: %s", (text) => {
    expect(hasAuthoritativeExplicitDurableCareDirective(text)).toBe(false);
    expect(deriveExplicitCareCueCandidate(text)).toBeUndefined();
  });

  it("keeps exact tail clauses when the care instruction follows more than 500 unrelated characters", () => {
    const unrelatedPrefix = "这是一段与关怀偏好无关的普通背景。".repeat(40);
    const candidate = deriveExplicitCareCueCandidate(
      `${unrelatedPrefix}下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。`,
    );

    expect(unrelatedPrefix.length).toBeGreaterThan(500);
    expect(candidate?.contextSummary).toBe(
      "下周四我要做一次公开分享，现在有点紧张",
    );
    expect(candidate?.evidenceQuotes).toEqual([
      "下周四我要做一次公开分享，现在有点紧张",
      "这一刻我只想被听见，不要马上给建议",
    ]);
    expect(candidate?.evidenceQuotes.join(" ")).not.toContain("普通背景");
  });

  it("accepts listen-first and no-advice directives split across adjacent sentences", () => {
    const candidate = deriveExplicitCareCueCandidate(
      "下周四我要做一次公开分享，现在有点紧张。我只想被听见。不要马上给建议。",
    );

    expect(candidate?.contextSummary).toBe(
      "下周四我要做一次公开分享，现在有点紧张",
    );
    expect(candidate?.evidenceQuotes).toEqual([
      "下周四我要做一次公开分享，现在有点紧张",
      "我只想被听见",
      "不要马上给建议",
    ]);
    expect(candidate).not.toHaveProperty("timingHint");
  });

  it("accepts a polite care request question without treating it as factual uncertainty", () => {
    const candidate = deriveExplicitCareCueCandidate(
      "答辩时你可以先听我说完吗？不要马上给建议。",
    );

    expect(candidate?.contextSummary).toBe("答辩时你可以先听我说完吗");
    expect(candidate?.evidenceQuotes).toEqual([
      "答辩时你可以先听我说完吗",
      "不要马上给建议",
    ]);
    expect(candidate?.reasonCode).toBe("explicit_user_care_preference");
  });

  it.each([
    ["ordinary emotion", "下周四我要做一次公开分享，现在有点紧张。"],
    [
      "third-party attribution",
      "小林说：“我下周四要做一次公开分享，现在很紧张。我只想被听见，不要马上给建议。”",
    ],
    [
      "speculation",
      "如果我下周四有一次公开分享，我只想被听见，不要马上给建议。",
    ],
    [
      "retraction",
      "我不是说下周四公开分享时只想被听见、不要马上给建议；你可以直接给建议。",
    ],
    [
      "do-not-remember instruction",
      "不要记住我下周四要做公开分享时只想被听见、不要马上给建议。",
    ],
    [
      "negated listening instruction",
      "我下周四要做公开分享。到时候不要先听我说，也不要马上给建议。",
    ],
    ["question", "我下周四要做公开分享。我是不是只想被听见，不要马上给建议？"],
    ["unbound current feeling", "这一刻我只想被听见，不要马上给建议。"],
    [
      "friend-owned event",
      "我朋友下周四要面试，我只想被听见，不要马上给建议。",
    ],
    [
      "colleague-owned event",
      "我的同事下周四要面试。我只想被听见，不要马上给建议。",
    ],
    [
      "negated user event",
      "我明天不需要参加面试。我只想被听见，不要马上给建议。",
    ],
    [
      "example frame",
      "这里只是举例：下周四我要做公开分享，我只想被听见，不要马上给建议。",
    ],
    [
      "informal example frame",
      "比如我下周四要答辩，我只想被听见，不要马上给建议。",
    ],
    [
      "analogy frame",
      "打个比方，我下周四要答辩，我只想被听见，不要马上给建议。",
    ],
    [
      "arbitrary named unquoted attribution",
      "司马懿说我下周四要做公开分享，我只想被听见，不要马上给建议。",
    ],
    [
      "arbitrary named quote with corner brackets",
      "欧阳娜娜说：「我下周四要做公开分享，我只想被听见，不要马上给建议。」",
    ],
    [
      "arbitrary named quote with book-title brackets",
      "张三说：《我下周四要做公开分享，我只想被听见，不要马上给建议。》",
    ],
  ])("rejects %s as an authoritative care write", (_label, text) => {
    expect(deriveExplicitCareCueCandidate(text)).toBeUndefined();
  });
});
