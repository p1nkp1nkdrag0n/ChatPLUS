import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import {
  CharacterSpecSchema,
  CreateSessionResponseSchema,
  type CharacterSpec,
  type OriginalCharacterInput,
  type RuntimeState,
} from "@personasim/contracts";

import { buildApp, type PersonaSimApp } from "../app.js";
import type { ServerConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { companionLongRunV3FixtureBehavior } from "../scenarios/companion-long-run-v3-fixture.js";
import {
  LONG_RUN_V3_GENERATED_BASELINE_VERSION,
  readCompanionLongRunV3BaselineProjection,
  sha256CanonicalV3,
  sha256FileV3,
  type LongRunV3BaselineDescriptor,
} from "./companion-long-run-v3-baseline.js";
import {
  LongRunV2Observer,
  type ObservationSlice,
} from "./companion-long-run-v2-observer.js";

export interface LongRunV3CharacterBuildHttpEvidence {
  step: "generate" | "publish" | "create_session";
  method: "POST";
  path: string;
  status: number;
  latencyMs: number;
  requestBody: unknown;
  responseBody: unknown;
}

export interface LongRunV3CharacterBuildValidation {
  id: string;
  passed: boolean;
  detail: string;
}

export interface LongRunV3CharacterBuildEvidence {
  schemaVersion: "companion-long-run-v3-character-build-v1";
  success: boolean;
  startedAtUtc: string;
  completedAtUtc: string;
  input: OriginalCharacterInput;
  inputSha256: string;
  sourceSha256: string;
  http: LongRunV3CharacterBuildHttpEvidence[];
  observations: ObservationSlice;
  validations: LongRunV3CharacterBuildValidation[];
  draft?: CharacterSpec;
  published?: CharacterSpec;
  sessionId?: string;
  initialState?: RuntimeState;
  sources?: Array<Record<string, unknown>>;
  baseline?: LongRunV3BaselineDescriptor;
  error?: string;
}

export interface CreateLongRunV3CharacterBaselineInput {
  databasePath: string;
  config: ServerConfig;
  startAtUtc: string;
  characterInput: OriginalCharacterInput;
}

/**
 * Exercises the real public character construction flow and freezes the exact
 * resulting database as the long-run baseline. Provider evidence is returned
 * to the runner so it can be projected into the first turn's full model-I/O
 * stream without polluting the dialogue-only artifact.
 */
export async function createLongRunV3CharacterBaseline(
  input: CreateLongRunV3CharacterBaselineInput,
): Promise<LongRunV3CharacterBuildEvidence> {
  if (await pathExists(input.databasePath)) {
    throw new Error(
      `Refusing to replace an existing baseline: ${input.databasePath}`,
    );
  }
  await mkdir(dirname(input.databasePath), { recursive: true });

  const inputSha256 = sha256CanonicalV3(input.characterInput);
  const sourceSha256 = createHash("sha256")
    .update(input.characterInput.characterBrief ?? "")
    .digest("hex");
  const observer = new LongRunV2Observer(() => input.startAtUtc);
  const observationCursor = observer.cursor();
  const nativeFetch = globalThis.fetch;
  const database = openDatabase(input.databasePath);
  const clock = new FakeClock(input.startAtUtc);
  const http: LongRunV3CharacterBuildHttpEvidence[] = [];
  const startedAtUtc = new Date().toISOString();
  let app: PersonaSimApp | undefined;
  let origin: string | undefined;
  let draft: CharacterSpec | undefined;
  let published: CharacterSpec | undefined;
  let sessionId: string | undefined;
  let initialState: RuntimeState | undefined;
  let sources: Array<Record<string, unknown>> | undefined;
  let failure: unknown;

  try {
    const wrappedProviderFetch = observer.wrapFetch(nativeFetch);
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = wrappedProviderFetch;
      app = await buildApp({
        config: {
          ...input.config,
          nodeEnv: "test",
          profile: "companion-long-run-v3-character-build",
          databasePath: input.databasePath,
          clockMode: "fake",
          fakeClockStart: input.startAtUtc,
          developerRoutes: true,
          seedDemo: false,
          lifePlanningMode: "fuzzy",
          scheduleNegotiationMode: "legacy",
          selfInitiatedPlanningMode: "off",
          liveWorldEffectsMode: "enforced",
          memoryRecallMode: "enforced",
          autobiographyMode: "off",
        },
        database,
        clock,
        seedDemo: false,
        startScheduler: false,
        logger: false,
        llmObservation: {
          onMetric: observer.onMetric,
          onLogicalCall: observer.onLogicalCall,
        },
        ...(input.config.llm.provider === "fixture"
          ? { fixtureTurnBehavior: companionLongRunV3FixtureBehavior }
          : {}),
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
    origin = await app.listen({ host: "127.0.0.1", port: 0 });

    const generated = await localPost(
      nativeFetch,
      origin,
      "/api/characters/generate",
      input.characterInput,
    );
    http.push({ step: "generate", ...generated });
    if (generated.status !== 201) {
      throw new Error(
        `Character generation returned HTTP ${String(generated.status)}.`,
      );
    }
    draft = CharacterSpecSchema.parse(
      asRecord(generated.responseBody)["character"],
    );

    const publishPath = `/api/characters/${encodeURIComponent(draft.id)}/publish`;
    const publishRequest = { expectedVersion: draft.version };
    const publishedResponse = await localPost(
      nativeFetch,
      origin,
      publishPath,
      publishRequest,
    );
    http.push({ step: "publish", ...publishedResponse });
    if (publishedResponse.status !== 200) {
      throw new Error(
        `Character publish returned HTTP ${String(publishedResponse.status)}.`,
      );
    }
    published = CharacterSpecSchema.parse(
      asRecord(publishedResponse.responseBody)["character"],
    );

    const sessionPath = `/api/agents/${encodeURIComponent(published.id)}/sessions`;
    const sessionRequest = {
      title: "[long-run:S1] 与顾澜的纯模糊生活验证",
    };
    const sessionResponse = await localPost(
      nativeFetch,
      origin,
      sessionPath,
      sessionRequest,
    );
    http.push({ step: "create_session", ...sessionResponse });
    if (sessionResponse.status !== 201) {
      throw new Error(
        `Session creation returned HTTP ${String(sessionResponse.status)}.`,
      );
    }
    sessionId = CreateSessionResponseSchema.parse(sessionResponse.responseBody)
      .session.id;
    initialState = app.personasim.store.getRuntimeState(published.id);
    sources = app.personasim.store.listCharacterSources(published.id);
    if (initialState === undefined) {
      throw new Error("Generated character has no initial runtime state.");
    }
  } catch (error) {
    failure = error;
  } finally {
    if (app !== undefined) {
      await app.close().catch((closeError: unknown) => {
        failure ??= closeError;
      });
    } else if (database.open) {
      database.close();
    }
  }

  const observations = namespaceBootstrapObservations(
    observer.slice(observationCursor),
  );
  const validations = validateCharacterBuild({
    input: input.characterInput,
    draft,
    published,
    initialState,
    sources,
    sessionId,
    sourceSha256,
    databasePath: input.databasePath,
    requireRichCharacter: input.config.llm.provider !== "fixture",
  });
  const completedAtUtc = new Date().toISOString();
  const validationFailed = validations.some((check) => !check.passed);
  if (
    failure !== undefined ||
    validationFailed ||
    draft === undefined ||
    published === undefined ||
    initialState === undefined ||
    sessionId === undefined ||
    sources === undefined
  ) {
    return {
      schemaVersion: "companion-long-run-v3-character-build-v1",
      success: false,
      startedAtUtc,
      completedAtUtc,
      input: input.characterInput,
      inputSha256,
      sourceSha256,
      http,
      observations,
      validations,
      ...(draft === undefined ? {} : { draft }),
      ...(published === undefined ? {} : { published }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(initialState === undefined ? {} : { initialState }),
      ...(sources === undefined ? {} : { sources }),
      error:
        failure === undefined
          ? "Character build validation failed."
          : failure instanceof Error
            ? `${failure.name}: ${failure.message}`
            : describeUnknown(failure),
    };
  }
  if (
    draft === undefined ||
    published === undefined ||
    initialState === undefined ||
    sessionId === undefined ||
    sources === undefined
  ) {
    throw new Error("Successful character-build narrowing invariant failed.");
  }

  stabilizeBaselineDatabase(input.databasePath);
  const projection = readCompanionLongRunV3BaselineProjection(
    input.databasePath,
  );
  const counts = readBaselineCounts(input.databasePath, published.id);
  const baseline: LongRunV3BaselineDescriptor = {
    schemaVersion: "companion-long-run-v3-baseline-v1",
    baselineVersion: LONG_RUN_V3_GENERATED_BASELINE_VERSION,
    constructionMode: "product_character_generation",
    databasePath: input.databasePath,
    databaseSha256: await sha256FileV3(input.databasePath),
    characterId: published.id,
    characterSpecSha256: sha256CanonicalV3(published),
    initialStateSha256: sha256CanonicalV3(initialState),
    fuzzyLifeSha256: sha256CanonicalV3(projection),
    sessionId,
    startAtUtc: input.startAtUtc,
    timezone: published.identity.timezone,
    scheduleItemCount: counts.scheduleItemCount,
    dailyContextCount: counts.dailyContextCount,
    initialRelationship: initialState.relationship,
    characterBuildInputSha256: inputSha256,
    characterSourceSha256: sourceSha256,
  };
  return {
    schemaVersion: "companion-long-run-v3-character-build-v1",
    success: true,
    startedAtUtc,
    completedAtUtc,
    input: input.characterInput,
    inputSha256,
    sourceSha256,
    http,
    observations,
    validations,
    draft,
    published,
    sessionId,
    initialState,
    sources,
    baseline,
  };
}

function validateCharacterBuild(input: {
  input: OriginalCharacterInput;
  draft: CharacterSpec | undefined;
  published: CharacterSpec | undefined;
  initialState: RuntimeState | undefined;
  sources: Array<Record<string, unknown>> | undefined;
  sessionId: string | undefined;
  sourceSha256: string;
  databasePath: string;
  requireRichCharacter: boolean;
}): LongRunV3CharacterBuildValidation[] {
  const spec = input.published ?? input.draft;
  const originalSource = input.sources?.find(
    (source) => source["sourceType"] === "original_character_brief",
  );
  const goals = spec?.persona.goals ?? [];
  const evidenceDriven =
    spec?.compilationPolicyVersion === "companion_character_v2";
  const milestonesValid =
    goals.length > 0 &&
    goals.every((goal) => {
      const milestones = goal.milestones ?? [];
      return (
        milestones.length >= 4 &&
        milestones.length <= 6 &&
        milestones[0]?.afterDays === 0 &&
        milestones.every(
          (milestone, index) =>
            index === 0 ||
            milestone.afterDays > (milestones[index - 1]?.afterDays ?? -1),
        )
      );
    });
  const relationship = input.initialState?.relationship;
  const checks: Array<[string, boolean, string]> = [
    ["draft_created", input.draft !== undefined, input.draft?.id ?? "missing"],
    [
      "published",
      input.published?.status === "published",
      input.published?.status ?? "missing",
    ],
    [
      "identity_authority",
      spec?.identity.name === input.input.name &&
        spec?.identity.workOrRole === input.input.workOrRole,
      `${spec?.identity.name ?? "missing"} / ${spec?.identity.workOrRole ?? "missing"}`,
    ],
    [
      "source_full_text",
      originalSource?.["contentExcerpt"] === input.input.characterBrief,
      `bytes:${String(typeof originalSource?.["contentExcerpt"] === "string" ? new TextEncoder().encode(originalSource["contentExcerpt"]).byteLength : 0)}`,
    ],
    [
      "source_sha256",
      originalSource?.["sourceHash"] === input.sourceSha256,
      describeUnknown(originalSource?.["sourceHash"] ?? "missing"),
    ],
    [
      "biography_causal",
      !input.requireRichCharacter ||
        ((spec?.persona.biography?.length ?? 0) >= 2 &&
          (spec?.persona.biography ?? []).some(
            (entry) => (entry.lastingImpact?.length ?? 0) > 0,
          )),
      input.requireRichCharacter
        ? `entries:${String(spec?.persona.biography?.length ?? 0)}`
        : "fixture transport check",
    ],
    [
      "trait_behavior_rules",
      (spec?.persona.traits.length ?? 0) >=
        (evidenceDriven ? input.input.coreTraits.length : 3) &&
        (spec?.persona.traits ?? []).every(
          (trait) => trait.triggers.length > 0 && trait.exceptions.length > 0,
        ),
      `traits:${String(spec?.persona.traits.length ?? 0)}`,
    ],
    [
      "dialogue_author_guidance",
      (spec?.dialogue.authorGuidance?.length ?? 0) > 0,
      spec?.dialogue.authorGuidance ?? "missing",
    ],
    [
      "relationship_modes",
      !input.requireRichCharacter ||
        (spec?.userRelationship.behaviorModes?.length ?? 0) >= 2,
      input.requireRichCharacter
        ? `modes:${String(spec?.userRelationship.behaviorModes?.length ?? 0)}`
        : "fixture transport check",
    ],
    [
      evidenceDriven ? "goal_evidence_progression" : "goal_time_milestones",
      evidenceDriven
        ? goals.every((goal) => goal.milestones === undefined) &&
          (input.input.mainGoal === undefined ||
            goals.some(
              (goal) =>
                goal.title === input.input.mainGoal &&
                goal.origin === "user_spec",
            ))
        : milestonesValid,
      evidenceDriven
        ? "companion_character_v2: authored goals preserved; no calendar milestones"
        : goals
            .map((goal) =>
              (goal.milestones ?? []).map((milestone) => milestone.afterDays),
            )
            .map((days) => days.join(","))
            .join(" | "),
    ],
    [
      "friend_relationship_range",
      relationship !== undefined &&
        relationship.closeness >= 0.15 &&
        relationship.closeness <= 0.65 &&
        relationship.trust >= 0.2 &&
        relationship.trust <= 0.75,
      relationship === undefined
        ? "missing"
        : `closeness=${String(relationship.closeness)},trust=${String(relationship.trust)}`,
    ],
    [
      "session_created",
      input.sessionId !== undefined,
      input.sessionId ?? "missing",
    ],
    ["database_created", true, input.databasePath],
  ];
  return checks.map(([id, passed, detail]) => ({ id, passed, detail }));
}

function namespaceBootstrapObservations(
  observations: ObservationSlice,
): ObservationSlice {
  const idMap = new Map<string, string>();
  const logicalCalls = observations.logicalCalls.map((call) => {
    const previous = call.logicalCallId;
    if (previous === undefined) return call;
    const next = `character-build:${previous}`;
    idMap.set(previous, next);
    return { ...call, logicalCallId: next };
  });
  const providerAttempts = observations.providerAttempts.map((attempt) => ({
    ...attempt,
    ...(attempt.logicalCallId === undefined
      ? {}
      : {
          logicalCallId:
            idMap.get(attempt.logicalCallId) ??
            `character-build:${attempt.logicalCallId}`,
        }),
  }));
  return { logicalCalls, providerAttempts };
}

async function localPost(
  nativeFetch: typeof fetch,
  origin: string,
  path: string,
  requestBody: unknown,
): Promise<Omit<LongRunV3CharacterBuildHttpEvidence, "step">> {
  const started = performance.now();
  const response = await nativeFetch(new URL(path, origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const text = await response.text();
  let responseBody: unknown = text;
  try {
    responseBody = text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    // Preserve malformed text as evidence.
  }
  return {
    method: "POST",
    path,
    status: response.status,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    requestBody,
    responseBody,
  };
}

function stabilizeBaselineDatabase(path: string): void {
  const database = openDatabase(path);
  try {
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
    database.exec("VACUUM");
  } finally {
    database.close();
  }
}

function readBaselineCounts(
  path: string,
  agentId: string,
): { scheduleItemCount: number; dailyContextCount: number } {
  const database = openDatabase(path);
  try {
    const schedule = database
      .prepare(
        "SELECT COUNT(*) AS count FROM schedule_items WHERE agent_id = ?",
      )
      .get(agentId) as { count: number };
    const contexts = database
      .prepare(
        "SELECT COUNT(*) AS count FROM daily_life_contexts WHERE agent_id = ?",
      )
      .get(agentId) as { count: number };
    return {
      scheduleItemCount: schedule.count,
      dailyContextCount: contexts.count,
    };
  } finally {
    database.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`;
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return "unserializable_error";
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
