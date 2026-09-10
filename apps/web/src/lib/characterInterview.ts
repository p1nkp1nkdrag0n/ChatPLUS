import {
  EntityIdSchema,
  SimulationTierSchema,
  type CharacterInterviewAnswers,
} from "@personasim/contracts";
import { z } from "zod";
import type { InterviewQuestion } from "../api/interview";

export const INTERVIEW_KEY = "dearvale.character-interview.v1";
const CHANGE_EVENT = "dearvale:character-interview-changed";
export const CREATION_TITLE = "描述你梦中的他/她";

export type AnswerField =
  | "gender"
  | "name"
  | "ageText"
  | "worldSetting"
  | "workOrRole"
  | "appearanceDescription"
  | "personality"
  | "dailyHabits"
  | "importantExperience"
  | "dialogueStyle"
  | "currentFocus"
  | "additionalDetails";

export interface MainQuestion {
  field: AnswerField;
  text: (subject: string) => string;
  required: boolean;
  maxLength: number;
  multiline?: boolean;
  placeholder: string;
}

export const INTERVIEW_QUESTIONS: readonly MainQuestion[] = [
  {
    field: "gender",
    text: () => "你梦中的这个人，是什么性别？",
    required: true,
    maxLength: 120,
    placeholder: "写下你想使用的性别描述",
  },
  {
    field: "name",
    text: (s) => `${s}叫什么名字？`,
    required: true,
    maxLength: 120,
    placeholder: "写下这个名字",
  },
  {
    field: "ageText",
    text: (s) => `${s}今年多大了？`,
    required: true,
    maxLength: 120,
    placeholder: "比如，24岁，或二十多岁",
  },
  {
    field: "worldSetting",
    text: (s) => `${s}生活在怎样的世界里？`,
    required: true,
    maxLength: 4000,
    multiline: true,
    placeholder: "一座当代小城，一个遥远的年代，或你想象的世界……",
  },
  {
    field: "workOrRole",
    text: (s) => `${s}平时做什么？`,
    required: true,
    maxLength: 240,
    placeholder: "写下身份、职业，或平日的生活",
  },
  {
    field: "appearanceDescription",
    text: (s) => `${s}看起来是什么样子？`,
    required: false,
    maxLength: 2000,
    multiline: true,
    placeholder: "发型、衣着、神情，或一个让你记住的细节……",
  },
  {
    field: "personality",
    text: (s) => `${s}是怎样的性格？`,
    required: true,
    maxLength: 120,
    multiline: true,
    placeholder: "想一想，和这个人相处会是什么感觉……",
  },
  {
    field: "dailyHabits",
    text: (s) => `${s}有什么日常小习惯？`,
    required: false,
    maxLength: 1000,
    multiline: true,
    placeholder: "比如，夜里读书，或下雨时开一扇窗……",
  },
  {
    field: "importantExperience",
    text: (s) => `${s}经历过什么重要的事？`,
    required: false,
    maxLength: 1000,
    multiline: true,
    placeholder: "可以是一段经历，也可以只是一次小小的改变……",
  },
  {
    field: "dialogueStyle",
    text: (s) => `${s}说话时是什么感觉？`,
    required: false,
    maxLength: 500,
    multiline: true,
    placeholder: "温和、简短，有一点幽默，或你熟悉的语气……",
  },
  {
    field: "currentFocus",
    text: (s) => `${s}最近有什么在意的事？`,
    required: false,
    maxLength: 1000,
    multiline: true,
    placeholder: "一份牵挂，一个愿望，或眼下正在做的事……",
  },
  {
    field: "additionalDetails",
    text: (s) => `关于${s}，还有什么是你特别想留下的？`,
    required: false,
    maxLength: 6000,
    multiline: true,
    placeholder: "把还没有说完的细节，留在这里……",
  },
];

export interface InterviewDraft {
  version: 1;
  requestId: string;
  answers: CharacterInterviewAnswers;
  step: number;
  phase: "main" | "followups" | "ready" | "preview";
  followUpQuestions: InterviewQuestion[];
  followUpIndex: number;
  followUpSnapshot?: string | undefined;
  characterId?: string | undefined;
  characterVersion?: number | undefined;
}

export function newInterviewDraft(): InterviewDraft {
  return {
    version: 1,
    requestId: crypto.randomUUID(),
    step: 0,
    phase: "main",
    followUpQuestions: [],
    followUpIndex: 0,
    answers: emptyAnswers(),
  };
}

function emptyAnswers(): CharacterInterviewAnswers {
  return {
    gender: "",
    name: "",
    ageText: "",
    worldSetting: "",
    workOrRole: "",
    personality: "",
    advanced: {
      tier: "high_fidelity",
      timezone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    },
  };
}

export function interviewSubject(
  answers: Pick<CharacterInterviewAnswers, "gender" | "name">,
): string {
  if (answers.gender === "女性") return "她";
  if (answers.gender === "男性") return "他";
  return answers.name.trim() || "这个人";
}

export function mainAnswersSnapshot(
  answers: CharacterInterviewAnswers,
): string {
  return JSON.stringify(
    INTERVIEW_QUESTIONS.map(({ field }) => answers[field]?.trim() ?? ""),
  );
}

export function firstMissingAnswer(answers: CharacterInterviewAnswers): number {
  return INTERVIEW_QUESTIONS.findIndex(
    (question) => question.required && !answers[question.field]?.trim(),
  );
}

// Storage holds unfinished writing, including a temporarily empty timezone or
// a two-digit story year. Server submission validation is intentionally stricter.
const incompleteAnswersSchema = z
  .object({
    gender: z.string().max(120).default(""),
    name: z.string().max(120).default(""),
    ageText: z.string().max(120).default(""),
    worldSetting: z.string().max(4_000).default(""),
    workOrRole: z.string().max(240).default(""),
    personality: z.string().max(120).default(""),
    appearanceDescription: z.string().max(2_000).optional(),
    dailyHabits: z.string().max(1_000).optional(),
    importantExperience: z.string().max(1_000).optional(),
    dialogueStyle: z.string().max(500).optional(),
    currentFocus: z.string().max(1_000).optional(),
    additionalDetails: z.string().max(6_000).optional(),
    followUps: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            question: z.string().min(1).max(240),
            answer: z.string().max(1_000),
          })
          .strict(),
      )
      .max(2)
      .optional(),
    advanced: z
      .object({
        tier: SimulationTierSchema.optional(),
        timezone: z.string().max(128).optional(),
        storyEra: z.string().max(240).optional(),
        storyAnchorYear: z.number().finite().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const storedDraftSchema = z
  .object({
    version: z.literal(1),
    requestId: EntityIdSchema,
    answers: incompleteAnswersSchema,
    step: z
      .number()
      .int()
      .min(0)
      .max(INTERVIEW_QUESTIONS.length - 1),
    phase: z.enum(["main", "followups", "ready", "preview"]),
    followUpQuestions: z
      .array(
        z
          .object({ id: EntityIdSchema, text: z.string().min(1).max(240) })
          .strict(),
      )
      .max(2)
      .default([]),
    followUpIndex: z.number().int().min(0).max(2).default(0),
    followUpSnapshot: z.string().max(24_000).optional(),
    characterId: EntityIdSchema.optional(),
    characterVersion: z.number().int().positive().optional(),
  })
  .strict();

function normalizeInterviewDraft(draft: InterviewDraft): InterviewDraft {
  let next = draft;
  const snapshot = mainAnswersSnapshot(next.answers);
  if (
    next.followUpSnapshot !== undefined &&
    next.followUpSnapshot !== snapshot
  ) {
    const withoutCache = { ...next };
    delete withoutCache.followUpSnapshot;
    next = {
      ...withoutCache,
      answers: { ...next.answers, followUps: [] },
      followUpQuestions: [],
      followUpIndex: 0,
      ...(next.phase === "followups" || next.phase === "ready"
        ? { phase: "main" as const, step: INTERVIEW_QUESTIONS.length - 1 }
        : {}),
    };
  }
  // A preview restored from the server can carry answered follow-ups without
  // the browser's question cache. Rebuild that cache without losing the writing.
  if (
    next.followUpSnapshot === undefined &&
    next.phase === "preview" &&
    next.characterId &&
    next.answers.followUps?.length
  ) {
    next = {
      ...next,
      followUpSnapshot: snapshot,
      followUpQuestions: next.answers.followUps.map((answer) => ({
        id: answer.id,
        text: answer.question,
      })),
      followUpIndex: next.answers.followUps.length,
    };
  }
  const ids = new Set<string>();
  const questions = next.followUpQuestions.filter((question) => {
    if (ids.has(question.id)) return false;
    ids.add(question.id);
    return true;
  });
  // Do not send stale or mismatched question/answer pairs back to compilation.
  const answeredIds = new Set<string>();
  const followUps = next.answers.followUps?.filter((answer) => {
    if (
      answeredIds.has(answer.id) ||
      !questions.some(
        (question) =>
          question.id === answer.id && question.text === answer.question,
      )
    )
      return false;
    answeredIds.add(answer.id);
    return true;
  });
  next = {
    ...next,
    followUpQuestions: questions,
    followUpIndex: Math.min(next.followUpIndex, questions.length),
    ...(followUps === undefined
      ? {}
      : { answers: { ...next.answers, followUps } }),
  };
  const missing = firstMissingAnswer(next.answers);
  if (next.characterId && next.characterVersion === undefined)
    return { ...next, phase: "preview" };
  if (!next.characterId) {
    const withoutVersion = { ...next };
    delete withoutVersion.characterVersion;
    next = {
      ...withoutVersion,
      ...(next.phase === "preview" ? { phase: "ready" as const } : {}),
    };
  }
  if (missing >= 0 && next.phase !== "main" && next.phase !== "preview")
    next = { ...next, phase: "main", step: missing };
  if (
    next.phase === "followups" &&
    (!questions.length || next.followUpIndex >= questions.length)
  )
    next = { ...next, phase: "ready" };
  return next;
}

export function updateInterviewAnswer(
  draft: InterviewDraft,
  field: AnswerField,
  value: string,
): InterviewDraft {
  return normalizeInterviewDraft({
    ...draft,
    answers: { ...draft.answers, [field]: value },
  });
}

export function restoredPreviewAnswers(
  preview: {
    characterId: string;
    characterVersion: number;
    answers: CharacterInterviewAnswers;
  },
  saved: InterviewDraft | undefined,
): CharacterInterviewAnswers {
  return saved?.characterId === preview.characterId &&
    saved.characterVersion === preview.characterVersion &&
    saved.phase === "preview"
    ? { ...preview.answers, advanced: saved.answers.advanced }
    : preview.answers;
}

export function previewInterviewDraft(
  preview: { characterId: string; characterVersion: number },
  answers: CharacterInterviewAnswers,
  saved = readInterviewDraft(),
): InterviewDraft {
  const base =
    saved?.characterId === preview.characterId &&
    saved.characterVersion === preview.characterVersion
      ? saved
      : newInterviewDraft();
  return normalizeInterviewDraft({
    ...base,
    characterId: preview.characterId,
    characterVersion: preview.characterVersion,
    answers,
    phase: "preview",
  });
}

export function readInterviewDraft(): InterviewDraft | undefined {
  try {
    const raw = localStorage.getItem(INTERVIEW_KEY);
    if (!raw || raw.length > 100_000) return undefined;
    const value: unknown = JSON.parse(raw, (key: string, item: unknown) => {
      if (key === "__proto__" || key === "prototype" || key === "constructor")
        throw new Error("Unexpected storage key");
      return item;
    });
    const parsed = storedDraftSchema.safeParse(value);
    if (!parsed.success) return undefined;
    return normalizeInterviewDraft(parsed.data);
  } catch {
    return undefined;
  }
}

export function saveInterviewDraft(draft: InterviewDraft): boolean {
  try {
    const parsed = storedDraftSchema.safeParse(draft);
    if (!parsed.success) return false;
    localStorage.setItem(
      INTERVIEW_KEY,
      JSON.stringify(normalizeInterviewDraft(parsed.data)),
    );
    window.dispatchEvent(new Event(CHANGE_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function clearInterviewDraft(characterId?: string): void {
  if (characterId && readInterviewDraft()?.characterId !== characterId) return;
  try {
    localStorage.removeItem(INTERVIEW_KEY);
  } catch {
    /* Direct routes remain available. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeInterviewDraft(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === INTERVIEW_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
