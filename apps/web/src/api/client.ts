import {
  CorrespondenceMailboxResponseSchema,
  DeveloperTemporalTasksResponseSchema,
  KeepsakeDetailResponseSchema,
  KeepsakePageResponseSchema,
  LetterDetailResponseSchema,
  OpenLetterResponseSchema,
  RelationshipArchivePageResponseSchema,
  RelationshipShareProjectionSchema,
  type CorrespondenceMailboxQuery,
  type CreateLetterDraftRequest,
  type KeepsakeListQuery,
  type MemoryRecallPreviewResponse,
  type RelationshipArchiveEntryId,
  type RelationshipArchiveFilter,
  type SealLetterRequest,
  type ShareComposerSelection,
  type UpdateLetterDraftRequest,
} from "@personasim/contracts";
import type {
  AgentSnapshot,
  AppSettings,
  CharacterDetail,
  CharacterSpec,
  CharacterSummary,
  ChatMessage,
  ChatSession,
  RetrievalRun,
  RetrievalRunReplayResponse,
  RuntimeState,
  ScheduleItem,
  SimulationTier,
  TimelineEvent,
} from "./types";
import { ApiError } from "./types";
import { projectLetterDetailForCache } from "../lib/correspondence";

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    issues?: Array<{ path?: string; message?: string }>;
    requestId?: string;
  };
}

type RelationshipArchiveListInput = {
  filter?: RelationshipArchiveFilter;
  includePreviewText?: boolean;
  limit?: number;
} & (
  | { cursor?: string; entryId?: never }
  | { entryId: RelationshipArchiveEntryId; cursor?: never }
);

type KeepsakeListInput = Partial<
  Pick<KeepsakeListQuery, "cursor" | "limit" | "kind" | "sourceType" | "period">
>;

type CorrespondenceMailboxListInput = Partial<
  Pick<CorrespondenceMailboxQuery, "cursor" | "limit">
>;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  headers.set("accept", "application/json");

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let payload: ErrorEnvelope = {};
    try {
      payload = (await response.json()) as ErrorEnvelope;
    } catch {
      // The typed fallback below is safer than exposing a raw server response.
    }
    const error = payload.error;
    throw new ApiError({
      code: error?.code ?? "HTTP_ERROR",
      message: error?.message ?? `请求失败（${response.status}）`,
      status: response.status,
      issues:
        error?.issues?.map((issue) => ({
          path: issue.path ?? "",
          message: issue.message ?? "字段无效",
        })) ?? [],
      ...(error?.requestId ? { requestId: error.requestId } : {}),
    });
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestWithFallback<T>(
  primaryPath: string,
  fallbackPath: string,
  init: RequestInit,
): Promise<T> {
  try {
    return await request<T>(primaryPath, init);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return request<T>(fallbackPath, init);
  }
}

function body(value: unknown): string {
  return JSON.stringify(value);
}

export const api = {
  health: async () => {
    const value = await request<Record<string, unknown>>("/api/health");
    return {
      ok: value.ok === true || value.status === "ok",
      deploymentMode:
        value.deploymentMode === "local_single_user"
          ? "local_single_user"
          : "unknown",
      nowUtc: stringValue(
        value.nowUtc ?? value.serverTimeUtc,
        new Date().toISOString(),
      ),
    };
  },
  characters: {
    list: async () => {
      const value = await request<
        | { characters?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
      >("/api/characters");
      const rows = Array.isArray(value) ? value : (value.characters ?? []);
      return {
        characters: rows.map((row): CharacterSummary => ({
          id: stringValue(row.id),
          name: stringValue(row.name, "未命名角色"),
          workOrRole: stringValue(row.workOrRole),
          tier: simulationTier(row.tier),
          status: characterStatus(row.status),
          sourceType:
            row.sourceType === "imported_character"
              ? "imported_character"
              : "original",
          version: numberValue(row.version ?? row.currentVersion, 1),
          updatedAtUtc: stringValue(row.updatedAtUtc, new Date().toISOString()),
          currentActivity: nullableString(row.currentActivity),
          nextActivityAtUtc: nullableString(row.nextActivityAtUtc),
        })),
      };
    },
    get: (id: string) =>
      request<CharacterDetail | CharacterSpec>(`/api/characters/${id}`),
    generate: (input: {
      name: string;
      worldSetting: string;
      storyEra?: string;
      storyAnchorYear?: string;
      workOrRole: string;
      traits: string[];
      coreContradiction: string;
      primaryGoal: string;
      initialRelationship: string;
      dialogueStyle: string;
      characterBrief?: string;
      tier: SimulationTier;
      timezone: string;
    }) =>
      request<CharacterDetail | CharacterSpec>("/api/characters/generate", {
        method: "POST",
        body: body({
          name: input.name,
          worldSetting: input.worldSetting,
          ...(input.storyEra?.trim()
            ? { storyEra: input.storyEra.trim() }
            : {}),
          ...(input.storyAnchorYear?.trim()
            ? { storyAnchorYear: Number(input.storyAnchorYear) }
            : {}),
          workOrRole: input.workOrRole,
          coreTraits: input.traits,
          coreContradiction: input.coreContradiction,
          mainGoal: input.primaryGoal,
          initialRelationship: input.initialRelationship,
          dialogueStyle: input.dialogueStyle,
          ...(input.characterBrief?.trim()
            ? { characterBrief: input.characterBrief.trim() }
            : {}),
          tier: input.tier,
          timezone: input.timezone,
        }),
      }),
    import: (input: {
      name: string;
      workTitle: string;
      storyStage: string;
      tier: SimulationTier;
      timezone: string;
      material: string;
      fileName?: string;
    }) =>
      request<CharacterDetail | CharacterSpec>("/api/characters/import", {
        method: "POST",
        body: body({
          characterName: input.name,
          workTitle: input.workTitle,
          storyStage: input.storyStage,
          tier: input.tier,
          timezone: input.timezone,
          sourceText: input.material,
          sourceFormat: input.fileName
            ? input.fileName.toLowerCase().endsWith(".srt")
              ? "srt"
              : input.fileName.toLowerCase().endsWith(".md")
                ? "md"
                : "txt"
            : "pasted_text",
          ...(input.fileName ? { fileName: input.fileName } : {}),
        }),
      }),
    updateDraft: (id: string, spec: CharacterSpec) =>
      requestWithFallback<CharacterDetail | CharacterSpec>(
        `/api/characters/${id}/draft`,
        `/api/characters/${id}`,
        {
          method: "PATCH",
          body: body({ spec, expectedVersion: spec.version }),
        },
      ),
    publish: (id: string, expectedVersion: number) =>
      request<CharacterDetail | CharacterSpec>(
        `/api/characters/${id}/publish`,
        {
          method: "POST",
          body: body({ expectedVersion }),
        },
      ),
    versions: (id: string) =>
      request<{ versions: CharacterSpec[] } | CharacterSpec[]>(
        `/api/characters/${id}/versions`,
      ),
    restore: (id: string, version: number) =>
      request<CharacterDetail | CharacterSpec>(
        `/api/characters/${id}/versions/${version}/restore`,
        {
          method: "POST",
        },
      ),
  },
  agents: {
    activate: (agentId: string) =>
      request<AgentSnapshot>(`/api/agents/${agentId}/activate`, {
        method: "POST",
      }),
    overview: (agentId: string) =>
      request<AgentSnapshot>(`/api/agents/${agentId}/overview`),
    state: async (agentId: string) => {
      const value = await request<RuntimeState | { state: RuntimeState }>(
        `/api/agents/${agentId}/state`,
      );
      return "state" in value ? value.state : value;
    },
    schedule: (agentId: string, fromUtc: string, toUtc: string) =>
      request<
        | {
            dataModel: "fuzzy_life" | "legacy_exact_schedule";
            items: ScheduleItem[];
            retired?: boolean;
            replacement?: "fuzzy_life_context";
          }
        | ScheduleItem[]
      >(
        `/api/agents/${agentId}/schedule?fromUtc=${encodeURIComponent(fromUtc)}&toUtc=${encodeURIComponent(toUtc)}`,
      ),
    timeline: async (agentId: string) => {
      const value = await request<
        | {
            events?: Array<Record<string, unknown>>;
            activityEvents?: Array<Record<string, unknown>>;
            domainEvents?: Array<Record<string, unknown>>;
          }
        | TimelineEvent[]
      >(`/api/agents/${agentId}/timeline`);
      if (Array.isArray(value)) return { events: value };
      if (value.events !== undefined) {
        return {
          events: dedupeAndSortTimelineEvents(
            value.events.map(normalizeCanonicalTimelineEvent),
          ),
        };
      }

      const activity = (value.activityEvents ?? []).map(
        normalizeLegacyActivityEvent,
      );
      const domain = (value.domainEvents ?? []).map(normalizeLegacyDomainEvent);
      return {
        events: dedupeAndSortTimelineEvents([...activity, ...domain]),
      };
    },
    sessions: (agentId: string) =>
      request<{ sessions: ChatSession[] } | ChatSession[]>(
        `/api/agents/${agentId}/sessions`,
      ),
    createSession: async (agentId: string) => {
      const value = await request<ChatSession | { session: ChatSession }>(
        `/api/agents/${agentId}/sessions`,
        { method: "POST" },
      );
      return "session" in value ? value.session : value;
    },
  },
  correspondence: {
    list: async (
      agentId: string,
      input: CorrespondenceMailboxListInput = {},
    ) => {
      const search = new URLSearchParams();
      if (input.limit !== undefined) search.set("limit", String(input.limit));
      if (input.cursor !== undefined) search.set("cursor", input.cursor);
      const query = search.size === 0 ? "" : `?${search.toString()}`;
      return CorrespondenceMailboxResponseSchema.parse(
        await request<unknown>(
          `/api/agents/${encodeURIComponent(agentId)}/correspondence${query}`,
        ),
      );
    },
  },
  relationshipArchive: {
    list: async (agentId: string, input: RelationshipArchiveListInput = {}) => {
      const search = new URLSearchParams({
        filter: input.filter ?? "all",
        limit: String(input.limit ?? 30),
      });
      if (input.cursor !== undefined) search.set("cursor", input.cursor);
      if (input.entryId !== undefined) search.set("entryId", input.entryId);
      if (input.includePreviewText !== undefined) {
        search.set("includePreviewText", String(input.includePreviewText));
      }
      return RelationshipArchivePageResponseSchema.parse(
        await request<unknown>(
          `/api/agents/${encodeURIComponent(agentId)}/relationship-archive?${search.toString()}`,
        ),
      );
    },
    previewShare: async (agentId: string, input: ShareComposerSelection) =>
      RelationshipShareProjectionSchema.parse(
        await request<unknown>(
          `/api/agents/${encodeURIComponent(agentId)}/relationship-share/preview`,
          { method: "POST", body: body(input) },
        ),
      ),
  },
  keepsakes: {
    list: async (agentId: string, input: KeepsakeListInput = {}) => {
      const search = new URLSearchParams({
        limit: String(input.limit ?? 24),
      });
      if (input.cursor !== undefined) search.set("cursor", input.cursor);
      if (input.kind !== undefined) search.set("kind", input.kind);
      if (input.sourceType !== undefined) {
        search.set("sourceType", input.sourceType);
      }
      if (input.period !== undefined) search.set("period", input.period);
      return KeepsakePageResponseSchema.parse(
        await request<unknown>(
          `/api/agents/${encodeURIComponent(agentId)}/keepsakes?${search.toString()}`,
        ),
      );
    },
    get: async (keepsakeId: string) =>
      KeepsakeDetailResponseSchema.parse(
        await request<unknown>(
          `/api/keepsakes/${encodeURIComponent(keepsakeId)}`,
        ),
      ),
  },
  letters: {
    createDraft: async (agentId: string, input: CreateLetterDraftRequest) =>
      LetterDetailResponseSchema.parse(
        await request<unknown>(
          `/api/agents/${encodeURIComponent(agentId)}/letters`,
          { method: "POST", body: body(input) },
        ),
      ),
    updateDraft: async (letterId: string, input: UpdateLetterDraftRequest) =>
      LetterDetailResponseSchema.parse(
        await request<unknown>(`/api/letters/${encodeURIComponent(letterId)}`, {
          method: "PATCH",
          body: body(input),
        }),
      ),
    seal: async (letterId: string, input: SealLetterRequest) =>
      LetterDetailResponseSchema.parse(
        await request<unknown>(
          `/api/letters/${encodeURIComponent(letterId)}/seal`,
          { method: "POST", body: body(input) },
        ),
      ),
    get: async (letterId: string) =>
      LetterDetailResponseSchema.parse(
        await request<unknown>(`/api/letters/${encodeURIComponent(letterId)}`),
      ),
    getCacheSafe: async (letterId: string) =>
      projectLetterDetailForCache(
        LetterDetailResponseSchema.parse(
          await request<unknown>(
            `/api/letters/${encodeURIComponent(letterId)}`,
          ),
        ),
      ),
    open: async (letterId: string) =>
      OpenLetterResponseSchema.parse(
        await request<unknown>(
          `/api/letters/${encodeURIComponent(letterId)}/open`,
          { method: "POST", body: body({}) },
        ),
      ),
  },
  sessions: {
    messages: async (sessionId: string) => {
      const value = await request<
        | { messages?: Array<Record<string, unknown>> }
        | Array<Record<string, unknown>>
      >(`/api/sessions/${sessionId}/messages`);
      const rows = Array.isArray(value) ? value : (value.messages ?? []);
      return { messages: rows.map(normalizeMessage) };
    },
    send: async (
      sessionId: string,
      input: { agentId: string; clientMessageId: string; text: string },
    ) => {
      const value = await request<
        {
          userMessage: ChatMessage;
          assistantMessage: ChatMessage;
          scheduleEffects?: unknown[];
          scheduleChanges?: unknown[];
          state?: RuntimeState;
          schedule?: ScheduleItem[];
        } & Record<string, unknown>
      >(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        body: body(input),
      });
      return {
        ...value,
        userMessage: normalizeMessage(
          value.userMessage as unknown as Record<string, unknown>,
        ),
        assistantMessage: normalizeMessage(
          value.assistantMessage as unknown as Record<string, unknown>,
        ),
      };
    },
  },
  settings: {
    get: async () => normalizeSettings(await request<unknown>("/api/settings")),
    update: async (settings: Partial<AppSettings>) => {
      const editable: Record<string, unknown> = { ...settings };
      delete editable.hasApiKey;
      delete editable.clockMode;
      delete editable.llmProvider;
      delete editable.llmProfile;
      delete editable.model;
      delete editable.baseUrl;
      delete editable.reasoningEffort;
      delete editable.reasoningRequestFormat;
      delete editable.correspondenceMode;
      delete editable.correspondenceExecution;
      delete editable.keepsakeMode;
      await request<unknown>("/api/settings", {
        method: "PUT",
        body: body(editable),
      });
      return normalizeSettings(await request<unknown>("/api/settings"));
    },
  },
  developer: {
    snapshot: async (agentId: string) => {
      const [status, overview, memories, timeline] = await Promise.all([
        request<Record<string, unknown>>("/api/developer/status"),
        request<Record<string, unknown>>(`/api/agents/${agentId}/overview`),
        request<Record<string, unknown>>(`/api/agents/${agentId}/memories`),
        request<Record<string, unknown>>(`/api/agents/${agentId}/timeline`),
      ]);
      return { status, overview, memories, timeline };
    },
    llmCalls: () =>
      request<{ calls: Array<Record<string, unknown>> }>(
        "/api/developer/llm-calls",
      ),
    memoryRecallPreview: (agentId: string, message: string) =>
      request<MemoryRecallPreviewResponse>(
        `/api/developer/agents/${agentId}/memory-recall-preview`,
        { method: "POST", body: body({ message }) },
      ),
    retrievalRuns: (agentId: string, limit = 50) =>
      request<{ runs: RetrievalRun[] }>(
        `/api/developer/agents/${encodeURIComponent(agentId)}/retrieval-runs?limit=${limit}`,
      ),
    retrievalRun: (runId: string) =>
      request<{ run: RetrievalRun }>(
        `/api/developer/retrieval-runs/${encodeURIComponent(runId)}`,
      ),
    replayRetrievalRun: (runId: string) =>
      request<RetrievalRunReplayResponse>(
        `/api/developer/retrieval-runs/${encodeURIComponent(runId)}/replay`,
      ),
    temporalTasks: async (agentId: string) => {
      return DeveloperTemporalTasksResponseSchema.parse(
        await request<unknown>(
          `/api/developer/agents/${encodeURIComponent(agentId)}/temporal-tasks`,
        ),
      );
    },
    processLetter: (letterId: string) =>
      request<{ result: Record<string, unknown> }>(
        `/api/developer/letters/${encodeURIComponent(letterId)}/process`,
        { method: "POST", body: body({}) },
      ),
    setClock: (nowUtc: string) =>
      request<{ nowUtc: string }>("/api/developer/clock/set", {
        method: "POST",
        body: body({ value: nowUtc }),
      }),
    advanceClock: (minutes: number) =>
      request<{ nowUtc: string }>("/api/developer/clock/advance", {
        method: "POST",
        body: body({ minutes }),
      }),
    settle: (agentId: string) =>
      requestWithFallback<Record<string, unknown>>(
        `/api/developer/settle/${agentId}`,
        `/api/developer/agents/${agentId}/settle`,
        { method: "POST" },
      ),
  },
};

export function unwrapList<T>(
  value: T[] | Record<string, T[]>,
  key: string,
): T[] {
  if (Array.isArray(value)) return value;
  return value[key] ?? [];
}

export function unwrapCharacter(
  value: CharacterDetail | CharacterSpec,
): CharacterSpec {
  if ("character" in value && value.character)
    return value.draft ?? value.character;
  if ("spec" in value && value.spec) return value.spec;
  return value as CharacterSpec;
}

function normalizeMessage(row: Record<string, unknown>): ChatMessage {
  const metadata = recordValue(row.metadata);
  const memoryRecall = normalizeMemoryRecall(metadata.memoryRecall);
  const rawChunks = Array.isArray(row.chunks)
    ? row.chunks
    : Array.isArray(metadata.chunks)
      ? metadata.chunks
      : undefined;
  const text = stringValue(row.text ?? row.content);
  const chunks =
    rawChunks?.length &&
    rawChunks.every(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
      ? rawChunks
      : undefined;
  const messageKind = stringValue(row.messageKind ?? row.kind);
  const rawDeliveryMode = row.deliveryMode ?? metadata.deliveryMode;
  const validatedChunks =
    chunks?.join("\n") === text && chunks.length > 0 ? chunks : undefined;
  const deliveryMode =
    rawDeliveryMode === "sequential" && (validatedChunks?.length ?? 0) > 1
      ? "sequential"
      : "single_block";
  return {
    id: stringValue(row.id),
    sessionId: stringValue(row.sessionId),
    agentId: stringValue(row.agentId),
    role: row.role === "user" || row.role === "system" ? row.role : "assistant",
    text,
    ...(validatedChunks ? { chunks: validatedChunks } : {}),
    deliveryMode,
    kind:
      messageKind === "assistant_proactive" || messageKind === "proactive"
        ? "proactive"
        : messageKind === "deterministic_fallback" ||
            metadata.reasonCode === "safe_schedule_fallback"
          ? "fallback"
          : "normal",
    triggerEventId: nullableString(
      row.triggerEventId ?? row.triggerActivityEventId,
    ),
    ...(memoryRecall === undefined ? {} : { memoryRecall }),
    createdAtUtc: stringValue(row.createdAtUtc, new Date().toISOString()),
  };
}

function normalizeMemoryRecall(
  value: unknown,
): ChatMessage["memoryRecall"] | undefined {
  const candidate = recordValue(value);
  const rolloutMode = candidate.rolloutMode;
  const promptStrategy = candidate.promptStrategy;
  const recallMode = candidate.recallMode;
  if (
    (rolloutMode !== "legacy" &&
      rolloutMode !== "shadow" &&
      rolloutMode !== "enforced") ||
    (promptStrategy !== "legacy_active" &&
      promptStrategy !== "evidence_selected") ||
    (recallMode !== "event_card" &&
      recallMode !== "verbatim_quote" &&
      recallMode !== "date_digest" &&
      recallMode !== "basic_memory" &&
      recallMode !== "none") ||
    typeof candidate.abstained !== "boolean" ||
    typeof candidate.score !== "number" ||
    typeof candidate.durationMs !== "number"
  ) {
    return undefined;
  }
  const stringIds = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
  return {
    rolloutMode,
    promptStrategy,
    legacyPromptMemoryIds: stringIds(candidate.legacyPromptMemoryIds),
    promptMemoryIds: stringIds(candidate.promptMemoryIds),
    selectedMemoryIds: stringIds(candidate.selectedMemoryIds),
    selectedEvidenceIds: stringIds(candidate.selectedEvidenceIds),
    rejectedMemoryIds: stringIds(candidate.rejectedMemoryIds),
    recallMode,
    score: Math.max(0, Math.min(1, candidate.score)),
    abstained: candidate.abstained,
    ...(typeof candidate.abstentionReason === "string"
      ? { abstentionReason: candidate.abstentionReason }
      : {}),
    durationMs: Math.max(0, candidate.durationMs),
  };
}

function normalizeSettings(value: unknown): AppSettings {
  const envelope = recordValue(value);
  const settings = recordValue(envelope.settings ?? value);
  const runtime = recordValue(envelope.runtime);
  const provider = runtime.llmProvider ?? settings.llmProvider;
  return {
    llmProvider:
      provider === "openai-compatible" ? "openai-compatible" : "fixture",
    llmProfile: stringValue(
      runtime.llmProfile ?? settings.llmProfile,
      provider === "openai-compatible" ? "legacy" : "fixture",
    ),
    model: stringValue(runtime.llmModel ?? settings.model, "deepseek-v4-flash"),
    baseUrl: stringValue(
      runtime.llmBaseUrl ?? settings.baseUrl,
      "https://api.deepseek.com",
    ),
    reasoningEffort: stringValue(
      runtime.llmReasoningEffort ?? settings.reasoningEffort,
      "未配置",
    ),
    reasoningRequestFormat: stringValue(
      runtime.llmReasoningRequestFormat ?? settings.reasoningRequestFormat,
      "未配置",
    ),
    hasApiKey: runtime.hasApiKey === true || settings.hasApiKey === true,
    clockMode:
      runtime.clockMode === "fake" || settings.clockMode === "fake"
        ? "fake"
        : "system",
    correspondenceMode:
      runtime.correspondenceMode === "enforced" ||
      runtime.correspondenceMode === "shadow"
        ? runtime.correspondenceMode
        : "off",
    correspondenceExecution:
      runtime.correspondenceExecution === "resident" ||
      runtime.correspondenceExecution === "worker"
        ? runtime.correspondenceExecution
        : "lazy",
    keepsakeMode:
      runtime.keepsakeMode === "enforced" || runtime.keepsakeMode === "shadow"
        ? runtime.keepsakeMode
        : "off",
    locale: stringValue(settings.locale, "zh-CN"),
    defaultTimezone: stringValue(settings.defaultTimezone, "Asia/Shanghai"),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function simulationTier(value: unknown): SimulationTier {
  return value === "lightweight" || value === "daily" ? value : "high_fidelity";
}

function characterStatus(value: unknown): CharacterSummary["status"] {
  return value === "published" || value === "archived" ? value : "draft";
}

function activityTitle(value: unknown): string {
  return (
    {
      started: "活动开始",
      completed: "活动完成",
      partial: "部分完成",
      skipped: "活动跳过",
      cancelled: "活动取消",
    }[stringValue(value)] ?? "活动事件"
  );
}

type TimelineLineageIds = Pick<
  TimelineEvent,
  | "sourceIntentId"
  | "scheduleItemId"
  | "activityEventId"
  | "memoryId"
  | "proactiveCandidateId"
  | "messageId"
>;

function normalizeCanonicalTimelineEvent(
  event: Record<string, unknown>,
): TimelineEvent {
  return {
    id: stringValue(event.id),
    type: stringValue(event.type, "activity"),
    title: stringValue(event.title, activityTitle(event.type)),
    summary: stringValue(event.summary),
    occurredAtUtc: stringValue(event.occurredAtUtc, new Date().toISOString()),
    provenance: timelineProvenance(event.provenance),
    ...timelineLineageIds(event),
    ...(typeof event.source === "string" ? { source: event.source } : {}),
    ...(typeof event.correlationId === "string"
      ? { correlationId: event.correlationId }
      : {}),
    ...(typeof event.causationId === "string"
      ? { causationId: event.causationId }
      : {}),
    metadata: recordValue(event),
  };
}

function normalizeLegacyActivityEvent(
  event: Record<string, unknown>,
): TimelineEvent {
  const id = stringValue(event.id);
  return {
    id,
    type: stringValue(event.eventType, "activity"),
    title: activityTitle(event.eventType),
    summary: stringValue(event.summary),
    occurredAtUtc: stringValue(event.occurredAtUtc, new Date().toISOString()),
    provenance: "life_simulation",
    ...timelineLineageIds({ ...event, activityEventId: id }),
    ...(typeof event.source === "string" ? { source: event.source } : {}),
    metadata: recordValue(event),
  };
}

function normalizeLegacyDomainEvent(
  event: Record<string, unknown>,
): TimelineEvent {
  return {
    id: stringValue(event.id ?? event.idempotencyKey),
    type: stringValue(event.eventType, "domain"),
    title: stringValue(event.eventType, "领域事件"),
    summary: summarizeRecord(event.payload ?? event.data),
    occurredAtUtc: stringValue(
      event.recordedAtUtc ?? event.occurredAtUtc,
      new Date().toISOString(),
    ),
    provenance: "system",
    ...timelineLineageIds(event),
    ...(typeof event.correlationId === "string"
      ? { correlationId: event.correlationId }
      : {}),
    ...(typeof event.causationId === "string"
      ? { causationId: event.causationId }
      : {}),
    metadata: recordValue(event),
  };
}

function timelineProvenance(value: unknown): TimelineEvent["provenance"] {
  return value === "conversation" ||
    value === "life_simulation" ||
    value === "character_spec"
    ? value
    : "system";
}

function timelineLineageIds(
  event: Record<string, unknown>,
): TimelineLineageIds {
  const result: TimelineLineageIds = {};
  for (const key of [
    "sourceIntentId",
    "scheduleItemId",
    "activityEventId",
    "memoryId",
    "proactiveCandidateId",
    "messageId",
  ] as const) {
    const id = event[key];
    if (typeof id === "string") result[key] = id;
  }
  return result;
}

function dedupeAndSortTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  const uniqueEvents = new Map<string, TimelineEvent>();
  for (const event of events) {
    if (!uniqueEvents.has(event.id)) uniqueEvents.set(event.id, event);
  }
  return [...uniqueEvents.values()].toSorted(
    (left, right) =>
      right.occurredAtUtc.localeCompare(left.occurredAtUtc) ||
      right.id.localeCompare(left.id),
  );
}

function summarizeRecord(value: unknown): string {
  if (typeof value === "string") return value;
  const record = recordValue(value);
  const summary = record.summary ?? record.reasonSummary ?? record.title;
  return stringValue(summary, "领域状态已更新");
}
