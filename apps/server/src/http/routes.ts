import { extname } from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { DateTime } from "luxon";
import { z } from "zod";
import { MemoryRecallPreviewRequestSchema } from "@personasim/contracts";

import type { ServerConfig } from "../config.js";
import type { DatabaseStore } from "../db/store.js";
import { capabilitiesForTier } from "../domain/capabilities.js";
import { ApiError, notFound } from "../domain/errors.js";
import {
  chatMessageInputSchema,
  clockAdvanceSchema,
  importedCharacterInputSchema,
  scheduleEffectProposalSchema,
} from "../domain/schemas.js";
import { compareUtc } from "../domain/time.js";
import type { ActorQueue } from "../runtime/actor-queue.js";
import type { Clock } from "../runtime/clock.js";
import { isMutableClock } from "../runtime/clock.js";
import { buildTimelineResponse } from "./timeline-projection.js";
import type { SseHub } from "../sse/hub.js";
import type { RetrievalRunRepository } from "../repositories/retrieval-run-repository.js";
import type { AutobiographyService } from "../services/autobiography-service.js";
import type { CalendarService } from "../services/calendar-service.js";
import type { CharacterService } from "../services/character-service.js";
import type { CheckpointService } from "../services/checkpoint-service.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { ContinuityIndexService } from "../services/continuity-index-service.js";
import type { ConversationActivityTracker } from "../services/conversation-activity-tracker.js";
import type { DateDigestService } from "../services/date-digest-service.js";
import type { FollowUpService } from "../services/follow-up-service.js";
import type { FuzzyLifeService } from "../services/fuzzy-life-service.js";
import type { LlmService } from "../services/llm-service.js";
import type { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import type { MemoryRecallService } from "../services/memory-recall-service.js";
import type { PersonalLifeService } from "../services/personal-life-service.js";
import type { ProactiveDeliveryService } from "../services/proactive-delivery-service.js";
import type { ProactiveGenerationService } from "../services/proactive-generation-service.js";
import type { ScheduleService } from "../services/schedule-service.js";
import type { SettlementService } from "../services/settlement-service.js";

export type RouteServices = {
  config: ServerConfig;
  store: DatabaseStore;
  clock: Clock;
  actors: ActorQueue;
  sse: SseHub;
  llm: LlmService;
  memoryRecalls: MemoryRecallService;
  characters: CharacterService;
  schedules: ScheduleService;
  settlements: SettlementService;
  personalLife: PersonalLifeService;
  life: FuzzyLifeService;
  autobiographies: AutobiographyService;
  calendar: CalendarService;
  checkpoints: CheckpointService;
  continuityIndex: ContinuityIndexService;
  conversationActivity: ConversationActivityTracker;
  dateDigests: DateDigestService;
  followUps: FollowUpService;
  memoryLifecycle: MemoryLifecycleService;
  proactiveDelivery: ProactiveDeliveryService;
  proactiveGeneration: ProactiveGenerationService;
  retrievalRuns: RetrievalRunRepository;
  conversations: ConversationService;
};

const idParamsSchema = z.object({ id: z.string().min(1) });
const versionParamsSchema = idParamsSchema.extend({
  version: z.coerce.number().int().positive(),
});
const sessionParamsSchema = z.object({ sessionId: z.string().min(1) });
const rangeQuerySchema = z.object({
  fromUtc: z.string().datetime({ offset: true }).optional(),
  toUtc: z.string().datetime({ offset: true }).optional(),
});

export function registerRoutes(
  app: FastifyInstance,
  services: RouteServices,
): void {
  const {
    config,
    store,
    clock,
    actors,
    sse,
    llm,
    memoryRecalls,
    characters,
    schedules,
    settlements,
    personalLife,
    life,
    conversationActivity,
    conversations,
  } = services;

  app.get("/api/health", () => ({
    status: "ok",
    serverTimeUtc: clock.nowUtc(),
    profile: config.profile,
    llmProvider: llm.providerName,
    llmProfile: llm.profileName,
    ...(llm.reasoningEffort === undefined
      ? {}
      : { llmReasoningEffort: llm.reasoningEffort }),
    ...(llm.reasoningRequestFormat === undefined
      ? {}
      : { llmReasoningRequestFormat: llm.reasoningRequestFormat }),
    clockMode: isMutableClock(clock) ? "fake" : "system",
  }));

  app.get("/api/characters", (request) => {
    const query = z
      .object({ includeArchived: z.coerce.boolean().default(false) })
      .parse(request.query);
    const items = characters.list(query.includeArchived).map((summary) => {
      const spec = store.getCharacterSpec(summary.id);
      return {
        ...summary,
        version: summary.currentVersion,
        workOrRole: spec?.identity.workOrRole ?? "",
      };
    });
    return { characters: items, items };
  });

  app.post("/api/characters/generate", async (request, reply) => {
    const spec = await characters.generate(request.body);
    return reply.code(201).send({ character: spec });
  });

  app.post("/api/characters/import", async (request, reply) => {
    const input = await readImportInput(request);
    const spec = await characters.import(input);
    return reply.code(201).send({ character: spec });
  });

  app.get("/api/characters/:id", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const detail = characters.get(id);
    return { character: detail.spec, ...detail };
  });

  app.patch("/api/characters/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return {
      character: await actors.runExclusive(id, () =>
        characters.updateDraft(id, request.body as never),
      ),
    };
  });

  app.patch("/api/characters/:id/draft", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const raw = z.record(z.string(), z.unknown()).parse(request.body);
    const mutation = "draft" in raw ? { ...raw, spec: raw.draft } : raw;
    return {
      character: await actors.runExclusive(id, () =>
        characters.updateDraft(id, mutation),
      ),
    };
  });

  app.put("/api/characters/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return {
      character: await actors.runExclusive(id, () =>
        characters.updateDraft(id, request.body as never),
      ),
    };
  });

  app.delete("/api/characters/:id", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return {
      character: await actors.runExclusive(id, () => characters.archive(id)),
    };
  });

  app.get("/api/characters/:id/versions", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { versions: characters.listVersions(id) };
  });

  app.post("/api/characters/:id/versions/:version/restore", async (request) => {
    const { id, version } = versionParamsSchema.parse(request.params);
    return {
      character: await actors.runExclusive(id, () =>
        characters.restore(id, version),
      ),
    };
  });

  app.post("/api/characters/:id/restore", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const { version } = z
      .object({ version: z.number().int().positive() })
      .parse(request.body);
    return {
      character: await actors.runExclusive(id, () =>
        characters.restore(id, version),
      ),
    };
  });

  app.post("/api/characters/:id/publish", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = z
      .object({ expectedVersion: z.number().int().positive().optional() })
      .parse(request.body ?? {});
    return actors.runExclusive(id, async () => {
      const character = characters.publish(id, body.expectedVersion);
      if (config.lifePlanningMode === "fuzzy") {
        return {
          character,
          schedule: [],
          lifeContext: life.promptContext(id),
        };
      }
      const plan = await schedules.ensure72Hours(
        id,
        store.listSchedule(id).length === 0,
      );
      return { character, schedule: plan.created };
    });
  });

  app.post("/api/agents/:id/activate", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const activated = await actors.runExclusive(id, async () => {
      const spec = store.getCharacterSpec(id);
      if (!spec) throw notFound("Character");
      const tierCapabilities = capabilitiesForTier(spec.tier);
      const capabilities =
        config.lifePlanningMode === "fuzzy"
          ? { ...tierCapabilities, schedule: false }
          : tierCapabilities;
      if (
        capabilities.proactiveDialogue &&
        store.listSessions(id).length === 0
      ) {
        store.createSession(
          id,
          `与${spec.identity.name}的对话`,
          clock.nowUtc(),
        );
      }
      if (config.lifePlanningMode === "fuzzy") {
        life.advance(id);
        return { capabilities };
      }
      const settlement = await settlements.settleAndExtend(id);
      personalLife.ensureSelfInitiatedPlans(id);
      return { capabilities, settlement };
    });
    const proactiveOutcome = activated.capabilities.proactiveDialogue
      ? await services.proactiveDelivery.deliverNext(id)
      : undefined;
    const proactiveMessage =
      proactiveOutcome?.status === "committed"
        ? proactiveOutcome.message
        : undefined;
    return buildAgentSnapshot(id, services, {
      ...activated,
      proactiveMessage,
    });
  });

  app.get("/api/agents/:id/state", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return buildAgentSnapshot(id, services);
  });

  app.get("/api/agents/:id/overview", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return buildAgentSnapshot(id, services);
  });

  app.get("/api/agents/:id/schedule", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const range = rangeQuerySchema.parse(request.query);
    if (config.lifePlanningMode === "fuzzy") {
      if (!store.getCharacterSummary(id)) throw notFound("Character");
      return {
        items: [],
        serverTimeUtc: clock.nowUtc(),
        retired: true,
        replacement: "fuzzy_life_context",
        lifeContext: life.promptContext(id),
      };
    }
    return {
      items: schedules.list(id, range.fromUtc, range.toUtc),
      serverTimeUtc: clock.nowUtc(),
    };
  });

  app.post("/api/agents/:id/schedule/effects", async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    if (config.lifePlanningMode === "fuzzy") {
      if (!store.getCharacterSummary(id)) throw notFound("Character");
      throw new ApiError(
        410,
        "exact_schedule_retired",
        "Exact schedule effects are retired in fuzzy life mode.",
      );
    }
    const body = z
      .object({ effects: z.array(z.unknown()) })
      .parse(request.body);
    return actors.runExclusive(id, () => {
      const effects = z.array(scheduleEffectProposalSchema).parse(body.effects);
      const validation = schedules.validateEffects(id, effects);
      if (!validation.valid) {
        throw new ApiError(
          422,
          "invalid_schedule_proposal",
          "Schedule effects failed validation.",
          validation.issues,
        );
      }
      const nowUtc = clock.nowUtc();
      const changed = store.transaction(() =>
        schedules.applyValidatedEffects(id, effects, nowUtc),
      );
      sse.publish({
        type: "schedule.updated",
        agentId: id,
        occurredAtUtc: nowUtc,
        data: changed,
      });
      return { changed };
    });
  });

  app.get("/api/agents/:id/timeline", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!store.getCharacterSummary(id)) throw notFound("Character");
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    return buildTimelineResponse(
      store,
      id,
      query.limit,
      config.lifePlanningMode,
    );
  });

  app.get("/api/agents/:id/memories", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!store.getCharacterSummary(id)) throw notFound("Character");
    const rows = store.database
      .prepare(
        `SELECT id, type, content, tags_json AS tagsJson, importance, confidence,
          source_message_id AS sourceMessageId, source_event_id AS sourceEventId,
          created_at_utc AS createdAtUtc, valid_until_utc AS validUntilUtc
         FROM memories WHERE agent_id = ? ORDER BY importance DESC, created_at_utc DESC`,
      )
      .all(id)
      .map((row) => {
        const value = row as Record<string, unknown>;
        const { tagsJson, ...rest } = value;
        const parsedTags: unknown = JSON.parse(
          typeof tagsJson === "string" ? tagsJson : "[]",
        );
        return { ...rest, tags: z.array(z.string()).parse(parsedTags) };
      });
    return { memories: rows };
  });

  app.get("/api/agents/:id/events", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!store.getCharacterSummary(id)) throw notFound("Character");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.flushHeaders();
    const unsubscribe = sse.subscribe(id, reply.raw);
    request.raw.once("close", unsubscribe);
  });

  app.get("/api/agents/:id/sessions", (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return { sessions: conversations.listSessions(id) };
  });

  app.post("/api/agents/:id/sessions", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const body = z
      .object({ title: z.string().max(200).optional() })
      .parse(request.body ?? {});
    const session = conversations.createSession(id, body.title);
    return reply.code(201).send({ session });
  });

  app.get("/api/sessions/:sessionId/messages", (request) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    return { messages: conversations.listMessages(sessionId, query.limit) };
  });

  app.post("/api/sessions/:sessionId/messages", async (request, reply) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const input = chatMessageInputSchema.parse(normalizeChatBody(request.body));
    const lease = conversationActivity.beginUserTurn(input.agentId);
    try {
      const result = await actors.runExclusive(input.agentId, async () => {
        const turn = await conversations.chat(sessionId, input);
        if (
          config.lifePlanningMode === "fuzzy" ||
          turn.idempotentReplay ||
          turn.scheduleChanges.length > 0
        ) {
          return turn;
        }
        const planning = personalLife.ensureSelfInitiatedPlans(input.agentId);
        return planning.state === undefined
          ? turn
          : { ...turn, state: planning.state };
      });
      return reply.code(result.idempotentReplay ? 200 : 201).send(result);
    } finally {
      lease.end();
    }
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = chatMessageInputSchema.parse({
      ...normalizeChatBody(request.body),
      agentId: id,
    });
    const lease = conversationActivity.beginUserTurn(id);
    try {
      const result = await actors.runExclusive(id, async () => {
        const session =
          conversations.listSessions(id)[0] ?? conversations.createSession(id);
        const turn = await conversations.chat(session.id, input);
        if (
          config.lifePlanningMode === "fuzzy" ||
          turn.idempotentReplay ||
          turn.scheduleChanges.length > 0
        ) {
          return turn;
        }
        const planning = personalLife.ensureSelfInitiatedPlans(id);
        return planning.state === undefined
          ? turn
          : { ...turn, state: planning.state };
      });
      return reply.code(result.idempotentReplay ? 200 : 201).send(result);
    } finally {
      lease.end();
    }
  });

  app.get("/api/settings", () => ({
    settings: store.getSettings(),
    runtime: {
      llmProvider: llm.providerName,
      llmProfile: llm.profileName,
      llmModel: llm.modelName,
      llmBaseUrl: config.llm.baseUrl,
      ...(llm.reasoningEffort === undefined
        ? {}
        : { llmReasoningEffort: llm.reasoningEffort }),
      ...(llm.reasoningRequestFormat === undefined
        ? {}
        : { llmReasoningRequestFormat: llm.reasoningRequestFormat }),
      hasApiKey: Boolean(config.llm.apiKey),
      clockMode: isMutableClock(clock) ? "fake" : "system",
      profile: config.profile,
    },
  }));

  const updateSettings = (request: FastifyRequest) => {
    const values = z.record(z.string(), z.unknown()).parse(request.body);
    const forbidden = Object.keys(values).filter((key) =>
      /(api.?key|secret|password|token|credential)/i.test(key),
    );
    if (forbidden.length > 0) {
      throw new ApiError(
        400,
        "secret_setting_forbidden",
        "Secrets may only be supplied through environment variables.",
        {
          keys: forbidden,
        },
      );
    }
    store.setSettings(values, clock.nowUtc());
    return { settings: store.getSettings() };
  };
  app.put("/api/settings", updateSettings);
  app.patch("/api/settings", updateSettings);

  if (config.developerRoutes) {
    app.post("/api/developer/agents/:id/memory-recall-preview", (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const spec = store.getCharacterSpec(id);
      if (spec === undefined) throw notFound("Character");
      const input = MemoryRecallPreviewRequestSchema.parse(request.body);
      return memoryRecalls.preview({
        agentId: id,
        query: input.message,
        nowUtc: clock.nowUtc(),
        timezone: spec.identity.timezone,
      });
    });
    app.get("/api/developer/agents/:id/retrieval-runs", (request) => {
      const { id } = idParamsSchema.parse(request.params);
      if (!store.getCharacterSummary(id)) throw notFound("Character");
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(50) })
        .parse(request.query);
      return { runs: services.retrievalRuns.listByAgent(id, query.limit) };
    });

    app.get("/api/developer/retrieval-runs/:id", (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const run = services.retrievalRuns.findById(id);
      if (run === undefined) throw notFound("Retrieval run");
      return { run };
    });

    app.get("/api/developer/retrieval-runs/:id/replay", (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const run = services.retrievalRuns.findById(id);
      const input = services.retrievalRuns.getReplayInput(id);
      if (run === undefined || input === undefined) {
        throw notFound("Retrieval run");
      }
      const result = memoryRecalls.replay(input);
      return {
        runId: id,
        input,
        result,
        matchesRecordedResult:
          JSON.stringify(result) === JSON.stringify(run.result),
      };
    });

    app.get("/api/developer/status", () => ({
      serverTimeUtc: clock.nowUtc(),
      activeSseConnections: sse.connectionCount(),
      activeActorQueues: actors.activeActors,
      tables: store.tableCounts(),
      runtime: {
        llmProvider: llm.providerName,
        llmProfile: llm.profileName,
        llmModel: llm.modelName,
        reasoningEffort: llm.reasoningEffort ?? "not-configured",
        reasoningRequestFormat: llm.reasoningRequestFormat ?? "not-configured",
      },
    }));

    app.get("/api/developer/events", (request) => {
      const query = z
        .object({
          agentId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(request.query);
      return { events: store.listDomainEvents(query.agentId, query.limit) };
    });

    app.get("/api/developer/llm-calls", (request) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(request.query);
      return { calls: store.listLlmCalls(query.limit) };
    });

    app.get("/api/developer/rejected-proposals", (request) => {
      const query = z
        .object({
          agentId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(request.query);
      return {
        proposals: store.listRejectedProposals(query.agentId, query.limit),
      };
    });

    app.post("/api/developer/clock/set", async (request) => {
      if (!isMutableClock(clock)) {
        throw new ApiError(
          409,
          "clock_not_mutable",
          "The configured clock is not mutable.",
        );
      }
      const { value } = z
        .object({ value: z.string().datetime({ offset: true }) })
        .parse(request.body);
      clock.setUtc(value);
      await settleActiveAgents(services);
      return { nowUtc: clock.nowUtc() };
    });

    app.post("/api/developer/clock/advance", async (request) => {
      if (!isMutableClock(clock)) {
        throw new ApiError(
          409,
          "clock_not_mutable",
          "The configured clock is not mutable.",
        );
      }
      const duration = clockAdvanceSchema.parse(request.body);
      clock.advance({
        ...(duration.days === undefined ? {} : { days: duration.days }),
        ...(duration.hours === undefined ? {} : { hours: duration.hours }),
        ...(duration.minutes === undefined
          ? {}
          : { minutes: duration.minutes }),
      });
      await settleActiveAgents(services);
      return { nowUtc: clock.nowUtc() };
    });

    app.post("/api/developer/agents/:id/settle", async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const lifecycle = await actors.runExclusive(id, async () => {
        if (config.lifePlanningMode === "fuzzy") {
          return {
            mode: "fuzzy" as const,
            result: life.advance(id),
          };
        }
        const settlement = await settlements.settleAndExtend(id);
        personalLife.ensureSelfInitiatedPlans(id);
        return { mode: "legacy_exact" as const, result: settlement };
      });
      const proactiveOutcome = await services.proactiveDelivery.deliverNext(id);
      return {
        ...(lifecycle.mode === "fuzzy"
          ? { lifecycle }
          : { settlement: lifecycle.result }),
        proactiveMessage:
          proactiveOutcome.status === "committed"
            ? proactiveOutcome.message
            : undefined,
        proactiveOutcome,
      };
    });
  }
}

function normalizeChatBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {};
  const input = body as Record<string, unknown>;
  return {
    ...input,
    text: input.text ?? input.content,
    clientMessageId: input.clientMessageId ?? input.idempotencyKey,
  };
}

async function readImportInput(request: FastifyRequest): Promise<unknown> {
  if (!request.isMultipart())
    return importedCharacterInputSchema.parse(request.body);
  const fields: Record<string, string> = {};
  let sourceText = "";
  let sourceTitle = "导入材料";
  for await (const part of request.parts()) {
    if (part.type === "file") {
      const extension = extname(part.filename).toLowerCase();
      if (![".txt", ".md", ".srt"].includes(extension)) {
        throw new ApiError(
          415,
          "unsupported_import_type",
          "Only .txt, .md and .srt files are supported.",
        );
      }
      const buffer = await part.toBuffer();
      if (buffer.byteLength > 512_000) {
        throw new ApiError(
          413,
          "import_too_large",
          "Imported text must not exceed 500 KB.",
        );
      }
      sourceText = buffer.toString("utf8");
      sourceTitle = part.filename;
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return importedCharacterInputSchema.parse({
    ...fields,
    tier: fields.tier,
    sourceText: fields.sourceText ?? sourceText,
    sourceTitle: fields.sourceTitle ?? sourceTitle,
  });
}

function buildAgentSnapshot(
  id: string,
  services: RouteServices,
  extra: Record<string, unknown> = {},
) {
  const spec = services.store.getCharacterSpec(id);
  const state = services.store.getRuntimeState(id);
  const cursor = services.store.getCursor(id);
  if (!spec || !state || !cursor) throw notFound("Character");
  const tierCapabilities = capabilitiesForTier(spec.tier);
  const capabilities =
    services.config.lifePlanningMode === "fuzzy"
      ? { ...tierCapabilities, schedule: false }
      : tierCapabilities;
  const nowUtc = services.clock.nowUtc();
  const next24Utc = DateTime.fromISO(nowUtc)
    .plus({ hours: 24 })
    .toUTC()
    .toISO()!;
  const schedule =
    services.config.lifePlanningMode === "legacy_exact" && capabilities.schedule
      ? services.store.listSchedule(id, { fromUtc: nowUtc, toUtc: next24Utc })
      : [];
  const currentActivity = schedule.find(
    (item) =>
      compareUtc(item.startAtUtc, nowUtc) <= 0 &&
      compareUtc(item.endAtUtc, nowUtc) > 0 &&
      item.status !== "cancelled",
  );
  return {
    agentId: id,
    character: spec,
    capabilities,
    state,
    cursor,
    serverTimeUtc: nowUtc,
    characterLocalTime: DateTime.fromISO(nowUtc)
      .setZone(spec.identity.timezone)
      .toISO(),
    currentActivity,
    schedule,
    ...(services.config.lifePlanningMode === "fuzzy"
      ? { lifeContext: services.life.promptContext(id, nowUtc) }
      : {}),
    ...extra,
  };
}

async function settleActiveAgents(services: RouteServices): Promise<void> {
  const nowUtc = services.clock.nowUtc();
  await Promise.all(
    services.sse.getActiveAgentIds().map(async (agentId) => {
      await services.actors.runExclusive(agentId, async () => {
        if (services.config.lifePlanningMode === "fuzzy") {
          services.life.advance(agentId, nowUtc);
        } else {
          await services.settlements.settleAndExtend(agentId, {
            toUtc: nowUtc,
          });
          services.personalLife.ensureSelfInitiatedPlans(agentId);
        }
        services.memoryLifecycle.maintainAgent(agentId);
      });
      await services.proactiveDelivery.deliverNext(agentId);
    }),
  );
}
