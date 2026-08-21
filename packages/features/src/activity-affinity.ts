import type { ScheduleCategory } from "@personasim/contracts";

import { clamp, normalizeText } from "./shared.js";

export const ACTIVITY_CATEGORIES = [
  "sleep",
  "work",
  "study",
  "meal",
  "exercise",
  "social",
  "travel",
  "leisure",
  "self_care",
  "errand",
  "other",
] as const satisfies readonly ScheduleCategory[];

const CATEGORY_KEYWORDS: Readonly<Record<ScheduleCategory, readonly string[]>> =
  {
    sleep: [
      "sleep",
      "nap",
      "bedtime",
      "rest",
      "dream",
      "\u7761\u7720",
      "\u7761\u89c9",
      "\u4f11\u606f",
      "\u5348\u7761",
    ],
    work: [
      "work",
      "job",
      "office",
      "career",
      "project",
      "business",
      "\u5de5\u4f5c",
      "\u804c\u4e1a",
      "\u9879\u76ee",
    ],
    study: [
      "study",
      "learn",
      "learning",
      "read",
      "reading",
      "book",
      "class",
      "research",
      "\u5b66\u4e60",
      "\u9605\u8bfb",
      "\u8bfe\u7a0b",
      "\u7814\u7a76",
    ],
    meal: [
      "meal",
      "food",
      "cook",
      "cooking",
      "breakfast",
      "lunch",
      "dinner",
      "coffee",
      "tea",
      "cafe",
      "\u505a\u996d",
      "\u7f8e\u98df",
      "\u65e9\u9910",
      "\u5348\u9910",
      "\u665a\u9910",
      "\u5496\u5561",
    ],
    exercise: [
      "exercise",
      "run",
      "running",
      "gym",
      "hike",
      "hiking",
      "sport",
      "yoga",
      "swim",
      "cycling",
      "marathon",
      "\u8fd0\u52a8",
      "\u8dd1\u6b65",
      "\u5065\u8eab",
      "\u5f92\u6b65",
      "\u6e38\u6cf3",
    ],
    social: [
      "friend",
      "friends",
      "party",
      "social",
      "community",
      "concert",
      "chat",
      "meetup",
      "\u670b\u53cb",
      "\u805a\u4f1a",
      "\u793e\u4ea4",
      "\u97f3\u4e50\u4f1a",
    ],
    travel: [
      "travel",
      "trip",
      "journey",
      "tour",
      "vacation",
      "explore",
      "exploring",
      "\u65c5\u884c",
      "\u65c5\u6e38",
      "\u63a2\u7d22",
    ],
    leisure: [
      "game",
      "gaming",
      "movie",
      "music",
      "photography",
      "photo",
      "stargazing",
      "art",
      "draw",
      "drawing",
      "garden",
      "\u6e38\u620f",
      "\u7535\u5f71",
      "\u97f3\u4e50",
      "\u6444\u5f71",
      "\u89c2\u661f",
      "\u7ed8\u753b",
    ],
    self_care: [
      "self care",
      "meditate",
      "meditation",
      "journal",
      "therapy",
      "wellness",
      "relax",
      "health",
      "\u81ea\u6211\u7167\u987e",
      "\u51a5\u60f3",
      "\u653e\u677e",
      "\u5065\u5eb7",
    ],
    errand: [
      "errand",
      "grocery",
      "shopping",
      "shop",
      "chores",
      "clean",
      "cleaning",
      "\u91c7\u8d2d",
      "\u8d2d\u7269",
      "\u5bb6\u52a1",
      "\u6253\u626b",
    ],
    other: [],
  };

const NIGHT_KEYWORDS = [
  "night owl",
  "late night",
  "midnight",
  "after dark",
  "stargazing",
  "night run",
  "insomnia",
  "\u591c\u732b",
  "\u6df1\u591c",
  "\u5348\u591c",
  "\u89c2\u661f",
  "\u591c\u8dd1",
  "\u5931\u7720",
] as const;

export interface ActivityAffinityCharacterLike {
  identity?: {
    workOrRole?: string;
    worldSetting?: string;
    selfDescription?: string;
  };
  persona?: {
    goals?: readonly {
      title: string;
      description?: string;
      priority?: number;
    }[];
    preferences?: readonly {
      subject: string;
      preference: string;
      intensity?: number;
      conditions?: readonly string[];
    }[];
    traits?: readonly {
      name: string;
      description?: string;
      strength?: number;
      triggers?: readonly string[];
    }[];
    values?: readonly {
      name: string;
      description?: string;
      priority?: number;
    }[];
  };
  dialogue?: {
    frequentPhrases?: readonly string[];
    greetingPatterns?: readonly string[];
    comfortingPatterns?: readonly string[];
  };
  routines?: readonly {
    title: string;
    category: string;
    recurrence?: string;
    priority?: number;
  }[];
}

export interface ActivityAffinities {
  categoryScores: Record<ScheduleCategory, number>;
  nightOwlBias: number;
}

function emptyScores(): Record<ScheduleCategory, number> {
  return Object.fromEntries(
    ACTIVITY_CATEGORIES.map((category) => [category, 0.1]),
  ) as Record<ScheduleCategory, number>;
}

function keywordMatches(text: string, keyword: string): boolean {
  const normalizedText = ` ${normalizeText(text)} `;
  const normalizedKeyword = normalizeText(keyword);
  if (normalizedKeyword === "") return false;
  if (/^[a-z0-9 ]+$/u.test(normalizedKeyword)) {
    return normalizedText.includes(` ${normalizedKeyword} `);
  }
  return normalizedText.includes(normalizedKeyword);
}

function matchingCategories(text: string): ScheduleCategory[] {
  return ACTIVITY_CATEGORIES.filter((category) =>
    CATEGORY_KEYWORDS[category].some((keyword) =>
      keywordMatches(text, keyword),
    ),
  );
}

function hasNightKeyword(text: string): boolean {
  return NIGHT_KEYWORDS.some((keyword) => keywordMatches(text, keyword));
}

function addTextAffinity(
  scores: Record<ScheduleCategory, number>,
  text: string,
  weight: number,
): void {
  for (const category of matchingCategories(text)) {
    scores[category] += weight;
  }
}

function directCategory(value: string): ScheduleCategory | undefined {
  const normalized = normalizeText(value).replace(/ /gu, "_");
  return ACTIVITY_CATEGORIES.find((category) => category === normalized);
}

function joined(values: readonly (string | undefined)[]): string {
  return values
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

/**
 * Deterministically derives runtime activity affinity from existing character
 * material. It never mutates CharacterSpec and never invokes a model.
 */
export function deriveActivityAffinities(
  character: ActivityAffinityCharacterLike,
): ActivityAffinities {
  const scores = emptyScores();
  let nightOwlBias = 0.05;

  for (const routine of character.routines ?? []) {
    const priority = clamp(routine.priority ?? 0.5);
    const text = joined([routine.title, routine.category, routine.recurrence]);
    const category = directCategory(routine.category);
    if (category !== undefined) scores[category] += 0.3 + priority * 0.25;
    addTextAffinity(scores, text, 0.12 + priority * 0.1);
    if (hasNightKeyword(text)) nightOwlBias += 0.06 + priority * 0.08;
  }

  for (const goal of character.persona?.goals ?? []) {
    const priority = clamp(goal.priority ?? 0.5);
    const text = joined([goal.title, goal.description]);
    addTextAffinity(scores, text, 0.14 + priority * 0.18);
    if (hasNightKeyword(text)) nightOwlBias += 0.04 + priority * 0.06;
  }

  for (const preference of character.persona?.preferences ?? []) {
    const intensity = clamp(preference.intensity ?? 0.5);
    const text = joined([
      preference.subject,
      preference.preference,
      ...(preference.conditions ?? []),
    ]);
    addTextAffinity(scores, text, 0.16 + intensity * 0.22);
    if (hasNightKeyword(text)) nightOwlBias += 0.06 + intensity * 0.1;
  }

  for (const trait of character.persona?.traits ?? []) {
    const strength = clamp(trait.strength ?? 0.5);
    const text = joined([
      trait.name,
      trait.description,
      ...(trait.triggers ?? []),
    ]);
    addTextAffinity(scores, text, 0.05 + strength * 0.08);
    if (hasNightKeyword(text)) nightOwlBias += 0.02 + strength * 0.03;
  }

  for (const value of character.persona?.values ?? []) {
    const priority = clamp(value.priority ?? 0.5);
    const text = joined([value.name, value.description]);
    addTextAffinity(scores, text, 0.04 + priority * 0.07);
    if (hasNightKeyword(text)) nightOwlBias += 0.02 + priority * 0.02;
  }

  const identityText = joined([
    character.identity?.workOrRole,
    character.identity?.worldSetting,
    character.identity?.selfDescription,
  ]);
  addTextAffinity(scores, identityText, 0.07);
  if (hasNightKeyword(identityText)) nightOwlBias += 0.03;

  const dialogueText = joined([
    ...(character.dialogue?.frequentPhrases ?? []),
    ...(character.dialogue?.greetingPatterns ?? []),
    ...(character.dialogue?.comfortingPatterns ?? []),
  ]);
  addTextAffinity(scores, dialogueText, 0.06);
  if (hasNightKeyword(dialogueText)) nightOwlBias += 0.04;

  for (const category of ACTIVITY_CATEGORIES) {
    scores[category] = clamp(scores[category]);
  }

  return {
    categoryScores: scores,
    nightOwlBias: clamp(nightOwlBias, 0, 0.4),
  };
}
