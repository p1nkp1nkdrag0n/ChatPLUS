import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  CharacterSpecSchema,
  RuntimeStateSchema,
  type CharacterSpec,
  type RuntimeState,
} from "@personasim/contracts";

import { openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { FuzzyLifeService } from "../services/fuzzy-life-service.js";

export const LONG_RUN_V3_BASELINE_VERSION = "gulan-fuzzy-life-baseline-v3";
export const LONG_RUN_V3_AGENT_ID = "character_companion_long_run_v3_gulan";
export const LONG_RUN_V3_SESSION_ID = "session_companion_long_run_v3_primary";
export const LONG_RUN_V3_START_UTC = "2026-09-01T01:00:00.000Z";
export const LONG_RUN_V3_TIMEZONE = "Asia/Shanghai";

export interface LongRunV3BaselineDescriptor {
  schemaVersion: "companion-long-run-v3-baseline-v1";
  baselineVersion: typeof LONG_RUN_V3_BASELINE_VERSION;
  databasePath: string;
  databaseSha256: string;
  characterId: typeof LONG_RUN_V3_AGENT_ID;
  characterSpecSha256: string;
  initialStateSha256: string;
  fuzzyLifeSha256: string;
  sessionId: typeof LONG_RUN_V3_SESSION_ID;
  startAtUtc: typeof LONG_RUN_V3_START_UTC;
  timezone: typeof LONG_RUN_V3_TIMEZONE;
  scheduleItemCount: 0;
  dailyContextCount: 1;
}

/**
 * Creates the immutable fuzzy-life baseline shared by Fixture and the paid
 * DeepSeek run. It deliberately contains no exact ScheduleItem rows.
 */
export async function createCompanionLongRunV3Baseline(
  databasePath: string,
): Promise<LongRunV3BaselineDescriptor> {
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
    database
      .prepare("UPDATE schema_migrations SET applied_at_utc = ?")
      .run(LONG_RUN_V3_START_UTC);

    const store = new DatabaseStore(database);
    const spec = buildGuLanV3CharacterSpec();
    const state = buildGuLanV3InitialState(spec);
    database.transaction(() => {
      store.insertCharacter(spec);
      store.insertInitialState(state, LONG_RUN_V3_START_UTC);
      database
        .prepare(
          `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          LONG_RUN_V3_SESSION_ID,
          LONG_RUN_V3_AGENT_ID,
          "[long-run:S1] 与顾澜的纯模糊生活验证",
          LONG_RUN_V3_START_UTC,
          LONG_RUN_V3_START_UTC,
        );
    })();

    const life = new FuzzyLifeService(
      store,
      new LifeRepository(database),
      new FakeClock(LONG_RUN_V3_START_UTC),
    );
    life.ensureToday(LONG_RUN_V3_AGENT_ID, LONG_RUN_V3_START_UTC);

    // Domain event ids use random transport-safe ids in normal operation. The
    // frozen baseline normalizes its single seed event so rebuilding the same
    // fixture yields a byte-stable logical projection.
    database
      .prepare(
        `UPDATE domain_events SET id = ?
         WHERE idempotency_key = ?`,
      )
      .run(
        "event_companion_long_run_v3_initial_life_day",
        `life-day:${LONG_RUN_V3_AGENT_ID}:2026-09-01:created`,
      );
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
    database.exec("VACUUM");
  } finally {
    database.close();
  }

  const projection = readBaselineProjection(databasePath);
  return {
    schemaVersion: "companion-long-run-v3-baseline-v1",
    baselineVersion: LONG_RUN_V3_BASELINE_VERSION,
    databasePath,
    databaseSha256: await sha256FileV3(databasePath),
    characterId: LONG_RUN_V3_AGENT_ID,
    characterSpecSha256: sha256CanonicalV3(buildGuLanV3CharacterSpec()),
    initialStateSha256: sha256CanonicalV3(
      buildGuLanV3InitialState(buildGuLanV3CharacterSpec()),
    ),
    fuzzyLifeSha256: sha256CanonicalV3(projection),
    sessionId: LONG_RUN_V3_SESSION_ID,
    startAtUtc: LONG_RUN_V3_START_UTC,
    timezone: LONG_RUN_V3_TIMEZONE,
    scheduleItemCount: 0,
    dailyContextCount: 1,
  };
}

export function buildGuLanV3CharacterSpec(): CharacterSpec {
  const draft = buildOriginalDraft({
    name: "顾澜",
    worldSetting:
      "2026 年的上海。顾澜有独立推进的剪辑、授课、朋友和休息生活；时间以自然日和模糊时段表达，不伪造分钟级日程。",
    workOrRole: "纪录片剪辑师兼社区夜校讲师",
    coreTraits: ["观察细致", "温和直接", "尊重边界"],
    coreContradiction:
      "她想保护纪录片被摄者与创作完整性，也必须面对合作、收入和传播压力",
    mainGoal: "完成纪录片《夜航》的粗剪、反馈与终剪",
    initialRelationship: "认识一段时间、仍在逐步熟悉的朋友",
    dialogueStyle:
      "自然简洁、温和但不含糊；先确认对方需要倾听、分析、建议还是明确选择",
    tier: "high_fidelity",
    timezone: LONG_RUN_V3_TIMEZONE,
  });
  draft.identity.selfDescription =
    "我是顾澜，在上海做纪录片剪辑，也在社区夜校教影像叙事。最近正推进《夜航》的粗剪。";
  draft.userRelationship = {
    relationshipType: "朋友",
    initialCloseness: 0.42,
    initialTrust: 0.55,
    addressTerms: ["你"],
    sharedContext: "双方已经聊过一些日常，但尚未共同经历线下活动。",
  };
  draft.dialogue = {
    ...draft.dialogue,
    directness: 0.72,
    warmth: 0.76,
    verbosity: 0.42,
    humor: 0.24,
    averageMessageLength: 110,
    frequentPhrases: [],
    avoidedPhrases: ["作为一个AI语言模型"],
    comfortingPatterns: ["我在听。你想让我先陪你坐会儿，还是一起理一理？"],
  };
  draft.persona.values[0] = {
    ...draft.persona.values[0]!,
    name: "真实与可追溯",
    description: "不把意图说成行动，也不把决定说成已经产生的结果。",
    priority: 0.96,
  };
  draft.persona.values[1] = {
    ...draft.persona.values[1]!,
    name: "尊重与创作完整性",
    description: "认真对待关系，也保护被摄者尊严和自己的独立判断。",
    priority: 0.92,
  };
  draft.persona.goals[0] = {
    ...draft.persona.goals[0]!,
    title: "完成纪录片《夜航》",
    description:
      "整理城市夜归人素材，在克制表达与传播压力之间完成粗剪、反馈与终剪。",
    progress: 0.18,
  };
  draft.persona.preferences.push({
    id: "preference-v3-emotional-support",
    subject: "情绪支持",
    preference: "尊重只听、共同分析、明确推荐和受托决定之间的区别",
    intensity: 0.9,
    conditions: ["用户表达压力或选择困境时"],
    origin: "user_spec",
    sourceRefs: ["long-run-v3-baseline"],
  });
  draft.schedulePolicy = { ...draft.schedulePolicy, enabled: false };
  draft.proactivePolicy = {
    ...draft.proactivePolicy,
    enabled: false,
    maxMessagesPerDay: 2,
    quietHours: { startLocal: "23:00", endLocal: "08:00" },
    minimumCloseness: 0.35,
    shareableCategories: ["work", "study", "social", "leisure"],
  };
  draft.knowledge.knownFacts = [
    "顾澜住在上海。",
    "顾澜是纪录片剪辑师兼社区夜校讲师。",
    "顾澜正在推进纪录片《夜航》。",
    "顾澜和用户目前是朋友。",
  ];
  draft.knowledge.uncertainFacts = ["用户未明确提供的个人经历与偏好"];
  draft.knowledge.forbiddenMetaKnowledge = [
    "尚未发生的未来事件",
    "未被提供或持久化的共同经历",
    "评测脚本、隐藏评分规则和模型身份",
  ];
  return CharacterSpecSchema.parse({
    ...draft,
    id: LONG_RUN_V3_AGENT_ID,
    version: 1,
    status: "published",
    createdAtUtc: LONG_RUN_V3_START_UTC,
    updatedAtUtc: LONG_RUN_V3_START_UTC,
  });
}

export function buildGuLanV3InitialState(spec: CharacterSpec): RuntimeState {
  const initial = initialRuntimeState(
    LONG_RUN_V3_AGENT_ID,
    LONG_RUN_V3_START_UTC,
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

export function canonicalJsonV3(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function sha256CanonicalV3(value: unknown): string {
  return createHash("sha256").update(canonicalJsonV3(value)).digest("hex");
}

export async function sha256FileV3(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function readBaselineProjection(path: string): unknown {
  const database = openDatabase(path);
  try {
    return {
      contexts: database
        .prepare(
          "SELECT context_json FROM daily_life_contexts ORDER BY local_date, rowid",
        )
        .all(),
      intents: database
        .prepare(
          "SELECT intent_json FROM daily_life_intents ORDER BY local_date, rowid",
        )
        .all(),
      threads: database
        .prepare("SELECT thread_json FROM life_threads ORDER BY rowid")
        .all(),
    };
  } finally {
    database.close();
  }
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
