import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CharacterInterviewAnswersSchema,
  type CharacterInterviewAnswers,
} from "@personasim/contracts";
import {
  INTERVIEW_KEY,
  INTERVIEW_QUESTIONS,
  clearInterviewDraft,
  mainAnswersSnapshot,
  newInterviewDraft,
  previewInterviewDraft,
  readInterviewDraft,
  restoredPreviewAnswers,
  saveInterviewDraft,
  updateInterviewAnswer,
  type InterviewDraft,
} from "./characterInterview";

const answers: CharacterInterviewAnswers = {
  gender: "女性",
  name: "林澈",
  ageText: "二十多岁",
  worldSetting: "一座小城",
  workOrRole: "修书的人",
  personality: "温和但有自己的坚持",
  appearanceDescription: "短发",
  dailyHabits: "傍晚散步",
  importantExperience: "修过一本家谱",
  dialogueStyle: "自然克制",
  currentFocus: "那家老书店",
  additionalDetails: "  还没写完的细节\n下一行  ",
  advanced: {
    tier: "high_fidelity",
    timezone: "Asia/Shanghai",
    storyEra: "当代",
    storyAnchorYear: 2026,
  },
};
function completeDraft(): InterviewDraft {
  return {
    ...newInterviewDraft(),
    answers: { ...answers },
    phase: "ready",
    step: 11,
  };
}
function followUpDraft(): InterviewDraft {
  return {
    ...completeDraft(),
    phase: "followups",
    followUpSnapshot: mainAnswersSnapshot(answers),
    followUpQuestions: [
      { id: "question-1", text: "她喜欢怎样度过周末？" },
      { id: "question-2", text: "还有什么想留下？" },
    ],
    answers: {
      ...answers,
      followUps: [
        {
          id: "question-1",
          question: "她喜欢怎样度过周末？",
          answer: "听旧唱片",
        },
      ],
    },
    followUpIndex: 1,
  };
}

describe("character interview recovery", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps all twelve answers and unfinished whitespace after a reload", () => {
    const draft = completeDraft();
    expect(saveInterviewDraft(draft)).toBe(true);
    const restored = readInterviewDraft()!;
    expect(restored.requestId).toBe(draft.requestId);
    for (const { field } of INTERVIEW_QUESTIONS)
      expect(restored.answers[field]).toBe(answers[field]);
    expect(restored.answers.additionalDetails).toBe(
      "  还没写完的细节\n下一行  ",
    );
    expect(readInterviewDraft()?.requestId).toBe(draft.requestId);
  });

  it("retains partially entered required answers and more-settings values without accepting them for compilation", () => {
    const draft = newInterviewDraft();
    draft.answers.name = "  林";
    draft.answers.advanced = {
      timezone: "",
      storyAnchorYear: 20,
      storyEra: "  ",
    };
    expect(saveInterviewDraft(draft)).toBe(true);
    expect(readInterviewDraft()?.answers).toEqual(draft.answers);
    expect(
      CharacterInterviewAnswersSchema.safeParse(readInterviewDraft()?.answers)
        .success,
    ).toBe(false);
  });

  it.each(["{broken", "null", "[]", '"draft"', "x".repeat(100_001)])(
    "ignores corrupt or oversized storage (case %#)",
    (raw) => {
      storage.set(INTERVIEW_KEY, raw);
      expect(readInterviewDraft()).toBeUndefined();
    },
  );

  it("rejects unexpected nested properties and prototype payloads without mutating application objects", () => {
    const draft = completeDraft();
    storage.set(
      INTERVIEW_KEY,
      JSON.stringify({
        ...draft,
        answers: {
          ...draft.answers,
          advanced: { timezone: "UTC", administrator: true },
        },
      }),
    );
    expect(readInterviewDraft()).toBeUndefined();
    storage.set(
      INTERVIEW_KEY,
      JSON.stringify(draft).replace(
        '"answers":{',
        '"answers":{"__proto__":{"polluted":true},',
      ),
    );
    expect(readInterviewDraft()).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("keeps the previous recoverable draft when a malformed new save is rejected", () => {
    const draft = completeDraft();
    expect(saveInterviewDraft(draft)).toBe(true);
    expect(
      saveInterviewDraft({
        ...draft,
        answers: { ...answers, name: "x".repeat(121) },
      }),
    ).toBe(false);
    expect(readInterviewDraft()?.answers.name).toBe("林澈");
  });

  it("invalidates AI questions and answers immediately when the author's main answer changes", () => {
    const next = updateInterviewAnswer(followUpDraft(), "workOrRole", "钟表匠");
    expect(next.followUpQuestions).toEqual([]);
    expect(next.answers.followUps).toEqual([]);
    expect(next.followUpSnapshot).toBeUndefined();
    expect(next.phase).toBe("main");
    expect(saveInterviewDraft(next)).toBe(true);
    expect(readInterviewDraft()?.answers.workOrRole).toBe("钟表匠");
  });

  it("detects stale cached questions from a previous session and returns to the last main question", () => {
    const draft = followUpDraft();
    storage.set(
      INTERVIEW_KEY,
      JSON.stringify({
        ...draft,
        answers: { ...draft.answers, name: "另一个人" },
      }),
    );
    expect(readInterviewDraft()).toMatchObject({
      phase: "main",
      step: 11,
      followUpQuestions: [],
      answers: { followUps: [] },
    });
  });

  it("preserves valid cached answers across optional operational-settings changes", () => {
    const draft = followUpDraft();
    draft.answers.advanced = { ...draft.answers.advanced, timezone: "UTC" };
    expect(saveInterviewDraft(draft)).toBe(true);
    expect(readInterviewDraft()).toMatchObject({
      phase: "followups",
      followUpIndex: 1,
      answers: { followUps: draft.answers.followUps },
    });
  });

  it("does not compile mismatched answer/question pairs and never resumes a nonexistent follow-up", () => {
    const draft = followUpDraft();
    draft.answers.followUps![0]!.question = "另一条问题";
    draft.followUpIndex = 2;
    saveInterviewDraft(draft);
    expect(readInterviewDraft()).toMatchObject({
      phase: "ready",
      answers: { followUps: [] },
    });
  });

  it("sends incomplete ready drafts back to their missing main question", () => {
    const draft = completeDraft();
    draft.answers.personality = "  ";
    saveInterviewDraft(draft);
    expect(readInterviewDraft()).toMatchObject({ phase: "main", step: 6 });
  });

  it("restores server follow-up answers into an editable question cache", () => {
    const withFollowUps = followUpDraft().answers;
    const draft = previewInterviewDraft(
      { characterId: "character-1", characterVersion: 1 },
      withFollowUps,
    );
    saveInterviewDraft(draft);
    expect(readInterviewDraft()).toMatchObject({
      phase: "preview",
      characterId: "character-1",
      followUpQuestions: [{ id: "question-1", text: "她喜欢怎样度过周末？" }],
      answers: { followUps: withFollowUps.followUps },
    });
    const changed = updateInterviewAnswer(
      { ...draft, phase: "main" },
      "name",
      "林夏",
    );
    expect(changed.answers.followUps).toEqual([]);
  });

  it("recovers a known server character with a missing version through preview without turning it into a new creation", () => {
    const draft = { ...completeDraft(), characterId: "existing-character" };
    saveInterviewDraft(draft);
    expect(readInterviewDraft()).toMatchObject({
      phase: "preview",
      characterId: "existing-character",
    });
  });

  it("restores only uncompiled more-settings changes from the same character and version", () => {
    const preview = {
      characterId: "character-1",
      characterVersion: 2,
      answers,
    };
    const saved = previewInterviewDraft(preview, {
      ...answers,
      name: "stale name",
      advanced: { timezone: "", storyAnchorYear: 20 },
    });
    expect(restoredPreviewAnswers(preview, saved)).toEqual({
      ...answers,
      advanced: { timezone: "", storyAnchorYear: 20 },
    });
    expect(
      restoredPreviewAnswers({ ...preview, characterVersion: 3 }, saved),
    ).toEqual(answers);
    expect(
      restoredPreviewAnswers({ ...preview, characterId: "character-2" }, saved),
    ).toEqual(answers);
    expect(
      restoredPreviewAnswers(preview, { ...saved, phase: "main" }),
    ).toEqual(answers);
  });

  it("preserves deliberate removal of optional settings, rather than restoring prior values", () => {
    const preview = {
      characterId: "character-1",
      characterVersion: 1,
      answers,
    };
    const saved = previewInterviewDraft(preview, {
      ...answers,
      advanced: { timezone: "UTC" },
    });
    saveInterviewDraft(saved);
    const restored = restoredPreviewAnswers(preview, readInterviewDraft());
    expect(restored.advanced).toEqual({ timezone: "UTC" });
    expect(restored.advanced).not.toHaveProperty("storyEra");
    expect(restored.advanced).not.toHaveProperty("storyAnchorYear");
  });

  it("clears only the published character's draft, preserving separate writing", () => {
    const draft = completeDraft();
    saveInterviewDraft(draft);
    clearInterviewDraft("another-character");
    expect(readInterviewDraft()?.requestId).toBe(draft.requestId);
    saveInterviewDraft({
      ...draft,
      characterId: "character-1",
      characterVersion: 1,
    });
    clearInterviewDraft("character-1");
    expect(readInterviewDraft()).toBeUndefined();
  });

  it("reports storage failure without crashing the interview", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(readInterviewDraft()).toBeUndefined();
    expect(saveInterviewDraft(completeDraft())).toBe(false);
  });
});
