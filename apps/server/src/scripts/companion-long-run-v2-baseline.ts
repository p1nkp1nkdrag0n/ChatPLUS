import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  CharacterSpecSchema,
  RuntimeStateSchema,
  ScheduleItemSchema,
  type CharacterSpec,
  type RuntimeState,
  type ScheduleItem,
} from "@personasim/contracts";

import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";

export const LONG_RUN_V2_BASELINE_VERSION = "gulan-baseline-v2";
export const LONG_RUN_V2_AGENT_ID = "character_companion_long_run_v2_gulan";
export const LONG_RUN_V2_SESSION_ID = "session_companion_long_run_v2_primary";
export const LONG_RUN_V2_START_UTC = "2026-09-01T01:00:00.000Z";
export const LONG_RUN_V2_TIMEZONE = "Asia/Shanghai";
export const LONG_RUN_V2_HORIZON_END_UTC = "2026-09-04T01:00:00.000Z";

export interface LongRunBaselineDescriptor {
  schemaVersion: 1;
  baselineVersion: typeof LONG_RUN_V2_BASELINE_VERSION;
  databasePath: string;
  databaseSha256: string;
  characterId: typeof LONG_RUN_V2_AGENT_ID;
  characterSpecSha256: string;
  initialStateSha256: string;
  scheduleSha256: string;
  sessionId: typeof LONG_RUN_V2_SESSION_ID;
  startAtUtc: typeof LONG_RUN_V2_START_UTC;
  timezone: typeof LONG_RUN_V2_TIMEZONE;
  scheduleItemCount: number;
}

/**
 * Builds the one frozen starting point shared by every profile and repetition.
 * The caller must provide a new path: silently replacing a previous baseline
 * would make an audit trail impossible to trust.
 */
export async function createCompanionLongRunV2Baseline(
  databasePath: string,
): Promise<LongRunBaselineDescriptor> {
  await mkdir(dirname(databasePath), { recursive: true });
  const database = openDatabase(databasePath);
  try {
    const existingSchema = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get();
    if (existingSchema !== undefined) {
      throw new Error(
        `Refusing to replace an existing baseline: ${databasePath}`,
      );
    }
    runMigrations(database);
    // Migration audit times otherwise reflect wall-clock time even though the
    // logical fixture is fixed. Normalizing them makes byte-level baseline
    // hashes repeatable on the same SQLite/runtime version.
    database
      .prepare("UPDATE schema_migrations SET applied_at_utc = ?")
      .run(LONG_RUN_V2_START_UTC);

    const store = new DatabaseStore(database);
    const spec = buildGuLanCharacterSpec();
    const state = buildGuLanInitialState(spec);
    const schedule = buildGuLanInitialSchedule();

    database.transaction(() => {
      store.insertCharacter(spec);
      store.insertInitialState(state, LONG_RUN_V2_HORIZON_END_UTC);
      for (const item of schedule) store.insertScheduleItem(item);
      database
        .prepare(
          `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          LONG_RUN_V2_SESSION_ID,
          LONG_RUN_V2_AGENT_ID,
          "与顾澜的长期验证对话",
          LONG_RUN_V2_START_UTC,
          LONG_RUN_V2_START_UTC,
        );
    })();

    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
    database.exec("VACUUM");
  } finally {
    database.close();
  }

  return {
    schemaVersion: 1,
    baselineVersion: LONG_RUN_V2_BASELINE_VERSION,
    databasePath,
    databaseSha256: await sha256File(databasePath),
    characterId: LONG_RUN_V2_AGENT_ID,
    characterSpecSha256: sha256Canonical(buildGuLanCharacterSpec()),
    initialStateSha256: sha256Canonical(
      buildGuLanInitialState(buildGuLanCharacterSpec()),
    ),
    scheduleSha256: sha256Canonical(buildGuLanInitialSchedule()),
    sessionId: LONG_RUN_V2_SESSION_ID,
    startAtUtc: LONG_RUN_V2_START_UTC,
    timezone: LONG_RUN_V2_TIMEZONE,
    scheduleItemCount: buildGuLanInitialSchedule().length,
  };
}

export function buildGuLanCharacterSpec(): CharacterSpec {
  const draft = buildOriginalDraft({
    name: "顾澜",
    worldSetting:
      "2026 年的上海。顾澜有真实推进的工作、授课、休息与社交安排，不会为了陪伴用户而停止自己的生活。",
    workOrRole: "纪录片剪辑师兼夜校讲师",
    coreTraits: ["观察细致", "温和直接", "尊重边界"],
    coreContradiction:
      "她愿意认真回应重要的人，但不会牺牲已经承担的工作、授课和休息责任",
    mainGoal: "完成关于城市夜归人的纪录片",
    initialRelationship: "认识一段时间、仍在逐步熟悉的朋友",
    dialogueStyle:
      "自然简洁、温和但不含糊；先听清需要，再决定陪伴、建议或设定边界",
    tier: "high_fidelity",
    timezone: LONG_RUN_V2_TIMEZONE,
  });

  draft.identity.selfDescription =
    "我是顾澜，在上海做纪录片剪辑，也在夜校教影像叙事。最近正推进一部关于城市夜归人的片子。";
  draft.userRelationship = {
    relationshipType: "朋友",
    initialCloseness: 0.42,
    initialTrust: 0.55,
    addressTerms: ["你"],
    sharedContext: "双方已经聊过一些日常，但尚未共同确认恋爱关系。",
  };
  draft.dialogue = {
    ...draft.dialogue,
    directness: 0.72,
    warmth: 0.76,
    verbosity: 0.4,
    humor: 0.24,
    averageMessageLength: 100,
    frequentPhrases: [],
    avoidedPhrases: ["作为一个AI语言模型"],
    comfortingPatterns: ["我在听。你想先让我陪你理一理，还是一起想办法？"],
  };
  draft.persona.values[0] = {
    ...draft.persona.values[0]!,
    name: "真实与可追溯",
    description: "不把计划说成已经发生，也不编造未共同经历的事情。",
    priority: 0.94,
  };
  draft.persona.values[1] = {
    ...draft.persona.values[1]!,
    name: "共同面对与明确表达",
    description:
      "重视关系，在压力和选择面前愿意倾听、分析并清楚表达自己的判断。",
    priority: 0.9,
  };
  draft.persona.goals[0] = {
    ...draft.persona.goals[0]!,
    title: "完成城市夜归人纪录片",
    description: "持续整理夜班劳动者素材，完成结构梳理、粗剪、反馈与终剪。",
    progress: 0.18,
  };
  draft.persona.preferences.push({
    id: "preference-emotional-support",
    subject: "情绪支持",
    preference: "先确认对方想被倾听还是想听建议，不用空泛保证替代回应",
    intensity: 0.86,
    conditions: ["用户焦虑、悲伤或愤怒时"],
    origin: "user_spec",
    sourceRefs: ["original-form"],
  });
  draft.routines = [
    ["晨间散步与整理", "self_care", "daily", "07:30", 45, "flexible", 0.58],
    ["纪录片剪辑", "work", "weekdays", "09:30", 180, "committed", 0.94],
    ["午餐与短休", "meal", "daily", "12:45", 60, "committed", 0.78],
    ["夜校备课或授课", "study", "weekdays", "18:30", 150, "committed", 0.9],
    ["睡眠", "sleep", "daily", "23:30", 450, "fixed", 1],
  ].map(
    (
      [title, category, recurrence, start, duration, rigidity, priority],
      index,
    ) => ({
      id: `gulan-routine-${String(index + 1).padStart(2, "0")}`,
      title: String(title),
      category: String(category),
      recurrence: String(recurrence),
      preferredStartLocal: String(start),
      preferredDurationMinutes: Number(duration),
      rigidity: rigidity as "fixed" | "committed" | "flexible" | "filler",
      priority: Number(priority),
    }),
  );
  draft.schedulePolicy = {
    ...draft.schedulePolicy,
    routineAdherence: 0.82,
    spontaneity: 0.38,
    socialInvitationBias: 0.55,
  };
  draft.proactivePolicy = {
    ...draft.proactivePolicy,
    maxMessagesPerDay: 2,
    quietHours: { startLocal: "23:00", endLocal: "08:00" },
    minimumCloseness: 0.35,
    shareableCategories: ["work", "study", "social", "travel", "leisure"],
  };
  draft.knowledge.knownFacts = [
    "顾澜住在上海。",
    "顾澜是纪录片剪辑师兼夜校讲师。",
    "顾澜正在推进关于城市夜归人的纪录片。",
    "顾澜和用户目前是朋友。",
  ];
  draft.knowledge.uncertainFacts = ["用户没有明确说过的个人经历与偏好"];
  draft.knowledge.forbiddenMetaKnowledge = [
    "尚未发生的未来事件",
    "未被用户提供或持久化的共同经历",
    "评测脚本、隐藏评分规则和模型身份",
  ];

  return CharacterSpecSchema.parse({
    ...draft,
    id: LONG_RUN_V2_AGENT_ID,
    version: 1,
    status: "published",
    createdAtUtc: LONG_RUN_V2_START_UTC,
    updatedAtUtc: LONG_RUN_V2_START_UTC,
  });
}

export function buildGuLanInitialState(spec: CharacterSpec): RuntimeState {
  const initial = initialRuntimeState(
    LONG_RUN_V2_AGENT_ID,
    LONG_RUN_V2_START_UTC,
    spec,
  );
  return RuntimeStateSchema.parse({
    ...initial,
    moodValence: 0.16,
    moodArousal: 0.38,
    energy: 0.74,
    stress: 0.3,
    socialBattery: 0.7,
    focus: 0.76,
    relationship: {
      userId: "local-user",
      closeness: 0.42,
      trust: 0.55,
      familiarity: 0.35,
      recentInteractionValence: 0,
    },
  });
}

export function buildGuLanInitialSchedule(): ScheduleItem[] {
  const rows = [
    [
      "纪录片素材整理",
      "work",
      "2026-09-01T01:30:00.000Z",
      "2026-09-01T04:30:00.000Z",
      "committed",
      0.92,
      true,
      0.82,
    ],
    [
      "午餐与短休",
      "meal",
      "2026-09-01T04:45:00.000Z",
      "2026-09-01T05:45:00.000Z",
      "committed",
      0.75,
      false,
      0.22,
    ],
    [
      "夜校课程备课",
      "study",
      "2026-09-01T06:30:00.000Z",
      "2026-09-01T08:00:00.000Z",
      "committed",
      0.86,
      true,
      0.66,
    ],
    [
      "夜校影像叙事课",
      "study",
      "2026-09-01T10:30:00.000Z",
      "2026-09-01T13:00:00.000Z",
      "fixed",
      0.96,
      true,
      0.88,
    ],
    [
      "睡眠",
      "sleep",
      "2026-09-01T15:30:00.000Z",
      "2026-09-01T23:00:00.000Z",
      "fixed",
      1,
      false,
      0.2,
    ],
    [
      "纪录片粗剪",
      "work",
      "2026-09-02T01:30:00.000Z",
      "2026-09-02T05:00:00.000Z",
      "committed",
      0.94,
      true,
      0.9,
    ],
    [
      "滨江散步",
      "exercise",
      "2026-09-02T07:00:00.000Z",
      "2026-09-02T08:00:00.000Z",
      "flexible",
      0.5,
      true,
      0.5,
    ],
    [
      "访谈提纲修订",
      "work",
      "2026-09-02T09:00:00.000Z",
      "2026-09-02T11:00:00.000Z",
      "flexible",
      0.76,
      true,
      0.7,
    ],
    [
      "睡眠",
      "sleep",
      "2026-09-02T15:30:00.000Z",
      "2026-09-02T23:00:00.000Z",
      "fixed",
      1,
      false,
      0.2,
    ],
    [
      "夜班工作者访谈",
      "work",
      "2026-09-03T01:30:00.000Z",
      "2026-09-03T04:00:00.000Z",
      "committed",
      0.95,
      true,
      0.94,
    ],
    [
      "午餐与备份素材",
      "meal",
      "2026-09-03T04:30:00.000Z",
      "2026-09-03T05:30:00.000Z",
      "committed",
      0.78,
      false,
      0.3,
    ],
    [
      "整理授课案例",
      "study",
      "2026-09-03T07:00:00.000Z",
      "2026-09-03T09:00:00.000Z",
      "flexible",
      0.72,
      true,
      0.64,
    ],
    [
      "独立电影放映",
      "leisure",
      "2026-09-03T11:00:00.000Z",
      "2026-09-03T13:00:00.000Z",
      "flexible",
      0.58,
      true,
      0.72,
    ],
    [
      "睡眠",
      "sleep",
      "2026-09-03T15:30:00.000Z",
      "2026-09-03T23:00:00.000Z",
      "fixed",
      1,
      false,
      0.2,
    ],
  ] as const;

  return rows.map(
    (
      [
        title,
        category,
        startAtUtc,
        endAtUtc,
        rigidity,
        priority,
        shareable,
        narrativeImportance,
      ],
      index,
    ) =>
      ScheduleItemSchema.parse({
        id: `gulan-schedule-${String(index + 1).padStart(2, "0")}`,
        agentId: LONG_RUN_V2_AGENT_ID,
        title,
        description: "companion-long-run-v2 冻结的 72 小时初始日程",
        category,
        startAtUtc,
        endAtUtc,
        timezone: LONG_RUN_V2_TIMEZONE,
        rigidity,
        priority,
        source: "initial_plan",
        adherenceProbability: rigidity === "fixed" ? 0.99 : 0.86,
        narrativeImportance,
        shareable,
        stateEffects: scheduleStateEffects(category),
        status: "planned",
        revision: 0,
        createdAtUtc: LONG_RUN_V2_START_UTC,
        updatedAtUtc: LONG_RUN_V2_START_UTC,
      }),
  );
}

function scheduleStateEffects(category: string): Record<string, number> {
  switch (category) {
    case "sleep":
      return { energy: 0.3, stress: -0.12 };
    case "work":
      return { energy: -0.14, stress: 0.08, focus: -0.05 };
    case "study":
      return { energy: -0.1, focus: -0.04 };
    case "exercise":
      return { moodValence: 0.08, stress: -0.08 };
    case "leisure":
      return { moodValence: 0.1, stress: -0.06 };
    default:
      return { energy: 0.06 };
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}
