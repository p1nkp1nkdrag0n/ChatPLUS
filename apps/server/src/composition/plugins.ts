import {
  LOGGER_SERVICE_TOKEN,
  type KernelLogger,
  type KernelPlugin,
} from "@personasim/kernel";
import type { FastifyBaseLogger } from "fastify";

import type { ServerConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { CalendarRepository } from "../repositories/calendar-repository.js";
import { RetrievalRunRepository } from "../repositories/retrieval-run-repository.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock, SystemClock, type Clock } from "../runtime/clock.js";
import { HourlyScheduler } from "../runtime/hourly-scheduler.js";
import { AutobiographyService } from "../services/autobiography-service.js";
import { CalendarService } from "../services/calendar-service.js";
import { CharacterService } from "../services/character-service.js";
import {
  CheckpointService,
  LlmCheckpointAutobiographyModel,
} from "../services/checkpoint-service.js";
import { ConversationContinuityService } from "../services/conversation-continuity-service.js";
import { ConversationContextService } from "../services/conversation-context-service.js";
import { ConversationService } from "../services/conversation-service.js";
import { ContextPlanService } from "../services/context-plan-service.js";
import { ContinuityIndexService } from "../services/continuity-index-service.js";
import { ContinuityMemoryRepository } from "../services/continuity-memory-repository.js";
import { ContinuityRepository } from "../services/continuity-repository.js";
import { ConversationActivityTracker } from "../services/conversation-activity-tracker.js";
import { DateDigestService } from "../services/date-digest-service.js";
import { FollowUpRepository } from "../services/follow-up-repository.js";
import { FollowUpService } from "../services/follow-up-service.js";
import { LlmService } from "../services/llm-service.js";
import { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import { MemoryRecallService } from "../services/memory-recall-service.js";
import { PersonalIntentService } from "../services/personal-intent-service.js";
import { PersonalLifeService } from "../services/personal-life-service.js";
import { ReplyRepairService } from "../services/reply-repair-service.js";
import { ReplyGenerationService } from "../services/reply-generation-service.js";
import { SelfPlanningService } from "../services/self-planning-service.js";
import { ScheduleService } from "../services/schedule-service.js";
import { SettlementService } from "../services/settlement-service.js";
import { ProactiveDeliveryService } from "../services/proactive-delivery-service.js";
import { ProactiveGenerationRepository } from "../services/proactive-generation-repository.js";
import { ProactiveGenerationService } from "../services/proactive-generation-service.js";
import { TurnCommitService } from "../services/turn-commit-service.js";
import { TurnDecisionService } from "../services/turn-decision-service.js";
import { TurnExecutionService } from "../services/turn-execution-service.js";
import { TurnUnderstandingService } from "../services/turn-understanding-service.js";
import { WorldEffectService } from "../services/world-effect-service.js";
import { SseHub } from "../sse/hub.js";
import type { ServerSimulationBundle } from "./bundles.js";
import {
  ACTOR_QUEUE_TOKEN,
  AUTOBIOGRAPHY_SERVICE_TOKEN,
  CALENDAR_SERVICE_TOKEN,
  CHARACTER_SERVICE_TOKEN,
  CHECKPOINT_SERVICE_TOKEN,
  CONVERSATION_CONTINUITY_SERVICE_TOKEN,
  CONVERSATION_CONTEXT_SERVICE_TOKEN,
  CONVERSATION_SERVICE_TOKEN,
  CONTEXT_PLAN_SERVICE_TOKEN,
  CONTINUITY_INDEX_SERVICE_TOKEN,
  CONVERSATION_ACTIVITY_TRACKER_TOKEN,
  DATE_DIGEST_SERVICE_TOKEN,
  FOLLOW_UP_SERVICE_TOKEN,
  MEMORY_LIFECYCLE_SERVICE_TOKEN,
  MEMORY_RECALL_SERVICE_TOKEN,
  PERSONAL_INTENT_SERVICE_TOKEN,
  PERSONAL_LIFE_SERVICE_TOKEN,
  PROACTIVE_DELIVERY_SERVICE_TOKEN,
  PROACTIVE_GENERATION_SERVICE_TOKEN,
  REPLY_REPAIR_SERVICE_TOKEN,
  REPLY_GENERATION_SERVICE_TOKEN,
  RETRIEVAL_RUN_REPOSITORY_TOKEN,
  SELF_PLANNING_SERVICE_TOKEN,
  SCHEDULE_SERVICE_TOKEN,
  SCHEDULER_SERVICE_TOKEN,
  SERVER_BUNDLE_TOKEN,
  SERVER_CLOCK_TOKEN,
  SERVER_CONFIG_TOKEN,
  SERVER_LLM_SERVICE_TOKEN,
  SERVER_SERVICE_IDS,
  SETTLEMENT_SERVICE_TOKEN,
  SSE_HUB_TOKEN,
  STORE_TOKEN,
  TURN_COMMIT_SERVICE_TOKEN,
  TURN_DECISION_SERVICE_TOKEN,
  TURN_EXECUTION_SERVICE_TOKEN,
  TURN_UNDERSTANDING_SERVICE_TOKEN,
  WORLD_EFFECT_SERVICE_TOKEN,
} from "./service-tokens.js";

export const SERVER_PLUGIN_IDS = {
  infrastructure: "server.infrastructure",
  domain: "server.domain",
  scheduler: "server.hourly-scheduler",
} as const;

export interface ServerKernelEvents {
  readonly "server.stopping": {
    readonly atUtc: string;
    readonly reason: "fastify_close" | "build_failed";
  };
}

export interface ServerPluginOptions {
  readonly bundle: ServerSimulationBundle;
  readonly config: ServerConfig;
  readonly logger: FastifyBaseLogger;
  readonly database?: Database;
  readonly clock?: Clock;
}

export function createServerPlugins(
  options: ServerPluginOptions,
): readonly KernelPlugin<ServerKernelEvents>[] {
  return [
    createBundlePlugin(options.bundle),
    createInfrastructurePlugin(options),
    createDomainPlugin(options.bundle.pluginId),
    createSchedulerPlugin(),
  ];
}

export function createKernelLogger(logger: FastifyBaseLogger): KernelLogger {
  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void => {
    if (context === undefined) logger[level](message);
    else logger[level](context, message);
  };
  return {
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
  };
}

function createBundlePlugin(
  bundle: ServerSimulationBundle,
): KernelPlugin<ServerKernelEvents> {
  return {
    manifest: {
      id: bundle.pluginId,
      displayName: `${bundle.id} simulation bundle`,
      version: "1.0.0",
      apiVersion: 1,
      requires: [],
      provides: [SERVER_SERVICE_IDS.bundle],
    },
    setup: (context) => {
      context.services.provide(SERVER_BUNDLE_TOKEN, bundle);
    },
  };
}

function createInfrastructurePlugin(
  options: ServerPluginOptions,
): KernelPlugin<ServerKernelEvents> {
  return {
    manifest: {
      id: SERVER_PLUGIN_IDS.infrastructure,
      displayName: "Server infrastructure",
      version: "1.0.0",
      apiVersion: 1,
      requires: [options.bundle.pluginId],
      provides: [
        SERVER_SERVICE_IDS.config,
        "core.storage",
        "core.clock",
        SERVER_SERVICE_IDS.actors,
        SERVER_SERVICE_IDS.sse,
        SERVER_SERVICE_IDS.llm,
        "core.logger",
      ],
    },
    setup: (context) => {
      const bundle = context.services.resolve(SERVER_BUNDLE_TOKEN);
      const database =
        options.database ?? openDatabase(options.config.databasePath);
      const sse = new SseHub();
      context.onDispose(() => {
        sse.close();
        if (database.open) database.close();
      });
      context.events.on("server.stopping", () => {
        sse.close();
      });

      runMigrations(database);
      const store = new DatabaseStore(database);
      const clock =
        options.clock ??
        (options.config.clockMode === "fake"
          ? new FakeClock(options.config.fakeClockStart)
          : new SystemClock());
      const actors = new ActorQueue();
      const llm = new LlmService(options.config.llm, store, clock);
      const logger = createKernelLogger(options.logger);

      context.services.provide(SERVER_CONFIG_TOKEN, options.config);
      context.services.provide(STORE_TOKEN, store);
      context.services.provide(SERVER_CLOCK_TOKEN, clock);
      context.services.provide(ACTOR_QUEUE_TOKEN, actors);
      context.services.provide(SSE_HUB_TOKEN, sse);
      context.services.provide(SERVER_LLM_SERVICE_TOKEN, llm);
      context.services.provide(LOGGER_SERVICE_TOKEN, logger);
      context.logger.info("Infrastructure services ready", {
        bundle: bundle.id,
        llmProvider: llm.providerName,
      });
    },
  };
}

function createDomainPlugin(
  bundlePluginId: string,
): KernelPlugin<ServerKernelEvents> {
  return {
    manifest: {
      id: SERVER_PLUGIN_IDS.domain,
      displayName: "PersonaSim domain services",
      version: "1.0.0",
      apiVersion: 1,
      requires: [bundlePluginId, SERVER_PLUGIN_IDS.infrastructure],
      provides: [
        SERVER_SERVICE_IDS.characters,
        SERVER_SERVICE_IDS.schedules,
        SERVER_SERVICE_IDS.settlements,
        SERVER_SERVICE_IDS.memoryRecalls,
        SERVER_SERVICE_IDS.personalIntents,
        SERVER_SERVICE_IDS.selfPlanning,
        SERVER_SERVICE_IDS.personalLife,
        SERVER_SERVICE_IDS.conversations,
        SERVER_SERVICE_IDS.turnDecisions,
        SERVER_SERVICE_IDS.turnUnderstandings,
        SERVER_SERVICE_IDS.turnExecutions,
        SERVER_SERVICE_IDS.replyGenerations,
        SERVER_SERVICE_IDS.contextPlans,
        SERVER_SERVICE_IDS.worldEffects,
        SERVER_SERVICE_IDS.turnCommits,
        SERVER_SERVICE_IDS.replyRepairs,
        SERVER_SERVICE_IDS.autobiographies,
        SERVER_SERVICE_IDS.calendar,
        SERVER_SERVICE_IDS.checkpoints,
        SERVER_SERVICE_IDS.continuityIndex,
        SERVER_SERVICE_IDS.conversationContinuity,
        SERVER_SERVICE_IDS.conversationContext,
        SERVER_SERVICE_IDS.conversationActivity,
        SERVER_SERVICE_IDS.dateDigests,
        SERVER_SERVICE_IDS.followUps,
        SERVER_SERVICE_IDS.memoryLifecycle,
        SERVER_SERVICE_IDS.proactiveDelivery,
        SERVER_SERVICE_IDS.proactiveGeneration,
        SERVER_SERVICE_IDS.retrievalRuns,
      ],
    },
    setup: (context) => {
      const store = context.services.resolve(STORE_TOKEN);
      const clock = context.services.resolve(SERVER_CLOCK_TOKEN);
      const llm = context.services.resolve(SERVER_LLM_SERVICE_TOKEN);
      const sse = context.services.resolve(SSE_HUB_TOKEN);
      const config = context.services.resolve(SERVER_CONFIG_TOKEN);
      const actors = context.services.resolve(ACTOR_QUEUE_TOKEN);
      const characters = new CharacterService(store, clock, llm);
      const schedules = new ScheduleService(store, clock, llm);
      const personalIntents = new PersonalIntentService(store, clock);
      const selfPlanning = new SelfPlanningService(
        schedules,
        clock,
        config.selfInitiatedPlanningMode === "enforced" ? "enforced" : "shadow",
      );
      const personalLife = new PersonalLifeService(
        store,
        clock,
        personalIntents,
        selfPlanning,
        schedules,
        sse,
        config.selfInitiatedPlanningMode,
      );
      const continuityRepository = new ContinuityRepository(store);
      const continuityMemoryRepository = new ContinuityMemoryRepository(store);
      const autobiographies = new AutobiographyService(continuityRepository);
      const continuityIndex = new ContinuityIndexService(
        continuityRepository,
        clock,
      );
      const checkpoints = new CheckpointService(
        continuityRepository,
        clock,
        new LlmCheckpointAutobiographyModel(llm),
        autobiographies,
        continuityIndex,
        config.conversationRetention,
      );
      const dateDigests = new DateDigestService(continuityMemoryRepository);
      const memoryLifecycle = new MemoryLifecycleService(
        continuityMemoryRepository,
        clock,
      );
      const calendar = new CalendarService(
        new CalendarRepository(store.database),
        clock,
      );
      const retrievalRuns = new RetrievalRunRepository(store.database);
      const memoryRecalls = new MemoryRecallService(store, retrievalRuns, {
        continuityIndex,
        dateDigests,
      });
      const conversationActivity = new ConversationActivityTracker(
        store.database,
      );
      const followUps = new FollowUpService(
        new FollowUpRepository(store.database),
        clock,
      );
      const conversationContinuity = new ConversationContinuityService(
        followUps,
        checkpoints,
        memoryLifecycle,
        config.autobiographyMode,
      );
      const conversationContext = new ConversationContextService(
        conversationContinuity,
        autobiographies,
        calendar,
        dateDigests,
        continuityIndex,
        config.autobiographyMode,
        config.memoryRecallMode,
      );
      const settlements = new SettlementService(
        store,
        clock,
        llm,
        schedules,
        sse,
        {
          continuityIndex,
        },
      );
      const proactiveDeliveryRef: {
        current?: ProactiveDeliveryService;
      } = {};
      const proactiveGeneration = new ProactiveGenerationService(
        new ProactiveGenerationRepository(store.database),
        conversationActivity,
        actors,
        clock,
        (agentId, nowUtc) => {
          const delivery = proactiveDeliveryRef.current;
          if (delivery === undefined) {
            throw new Error("Proactive delivery service is not composed.");
          }
          return delivery.loadPolicy(agentId, nowUtc);
        },
      );
      const proactiveDelivery = new ProactiveDeliveryService(
        store,
        clock,
        llm,
        sse,
        proactiveGeneration,
      );
      proactiveDeliveryRef.current = proactiveDelivery;
      const conversationOptions = {
        chatEffectsMode: config.chatEffectsMode,
        turnPipelineMode: config.turnPipelineMode,
        personaContextMode: config.personaContextMode,
        liveWorldEffectsMode: config.liveWorldEffectsMode,
        scheduleNegotiationMode: config.scheduleNegotiationMode,
        memoryRecallMode: config.memoryRecallMode,
        conversationRetention: config.conversationRetention,
      };
      const replyRepairs = new ReplyRepairService(llm);
      const turnUnderstandings = new TurnUnderstandingService(llm);
      const turnExecutions = new TurnExecutionService(
        store,
        schedules,
        conversationOptions,
      );
      const contextPlans = new ContextPlanService();
      const replyGenerations = new ReplyGenerationService(llm, replyRepairs);
      const turnDecisions = new TurnDecisionService(
        llm,
        schedules,
        replyRepairs,
        conversationOptions,
      );
      const worldEffects = new WorldEffectService(
        store,
        schedules,
        turnDecisions,
        replyRepairs,
        conversationOptions,
      );
      const turnCommits = new TurnCommitService(
        store,
        schedules,
        personalIntents,
        sse,
        conversationContext,
        conversationOptions,
        memoryLifecycle,
      );
      const conversations = new ConversationService(
        store,
        clock,
        llm,
        schedules,
        settlements,
        sse,
        conversationOptions,
        personalIntents,
        memoryRecalls,
        conversationContext,
        {
          replyRepairs,
          decisions: turnDecisions,
          worldEffects,
          commits: turnCommits,
          turnUnderstandings,
          turnExecutions,
          contextPlans,
          replyGenerations,
        },
      );

      context.services.provide(CHARACTER_SERVICE_TOKEN, characters);
      context.services.provide(SCHEDULE_SERVICE_TOKEN, schedules);
      context.services.provide(SETTLEMENT_SERVICE_TOKEN, settlements);
      context.services.provide(MEMORY_RECALL_SERVICE_TOKEN, memoryRecalls);
      context.services.provide(PERSONAL_INTENT_SERVICE_TOKEN, personalIntents);
      context.services.provide(SELF_PLANNING_SERVICE_TOKEN, selfPlanning);
      context.services.provide(PERSONAL_LIFE_SERVICE_TOKEN, personalLife);
      context.services.provide(AUTOBIOGRAPHY_SERVICE_TOKEN, autobiographies);
      context.services.provide(CALENDAR_SERVICE_TOKEN, calendar);
      context.services.provide(CHECKPOINT_SERVICE_TOKEN, checkpoints);
      context.services.provide(CONTINUITY_INDEX_SERVICE_TOKEN, continuityIndex);
      context.services.provide(
        CONVERSATION_CONTINUITY_SERVICE_TOKEN,
        conversationContinuity,
      );
      context.services.provide(
        CONVERSATION_CONTEXT_SERVICE_TOKEN,
        conversationContext,
      );
      context.services.provide(
        CONVERSATION_ACTIVITY_TRACKER_TOKEN,
        conversationActivity,
      );
      context.services.provide(DATE_DIGEST_SERVICE_TOKEN, dateDigests);
      context.services.provide(FOLLOW_UP_SERVICE_TOKEN, followUps);
      context.services.provide(MEMORY_LIFECYCLE_SERVICE_TOKEN, memoryLifecycle);
      context.services.provide(
        PROACTIVE_DELIVERY_SERVICE_TOKEN,
        proactiveDelivery,
      );
      context.services.provide(
        PROACTIVE_GENERATION_SERVICE_TOKEN,
        proactiveGeneration,
      );
      context.services.provide(RETRIEVAL_RUN_REPOSITORY_TOKEN, retrievalRuns);
      context.services.provide(REPLY_REPAIR_SERVICE_TOKEN, replyRepairs);
      context.services.provide(
        TURN_UNDERSTANDING_SERVICE_TOKEN,
        turnUnderstandings,
      );
      context.services.provide(TURN_EXECUTION_SERVICE_TOKEN, turnExecutions);
      context.services.provide(CONTEXT_PLAN_SERVICE_TOKEN, contextPlans);
      context.services.provide(
        REPLY_GENERATION_SERVICE_TOKEN,
        replyGenerations,
      );
      context.services.provide(TURN_DECISION_SERVICE_TOKEN, turnDecisions);
      context.services.provide(WORLD_EFFECT_SERVICE_TOKEN, worldEffects);
      context.services.provide(TURN_COMMIT_SERVICE_TOKEN, turnCommits);
      context.services.provide(CONVERSATION_SERVICE_TOKEN, conversations);
    },
  };
}

function createSchedulerPlugin(): KernelPlugin<ServerKernelEvents> {
  return {
    manifest: {
      id: SERVER_PLUGIN_IDS.scheduler,
      displayName: "Hourly settlement scheduler",
      version: "1.0.0",
      apiVersion: 1,
      requires: [SERVER_PLUGIN_IDS.domain],
      provides: [SERVER_SERVICE_IDS.scheduler],
    },
    setup: (context) => {
      const scheduler = new HourlyScheduler(
        context.services.resolve(SERVER_CLOCK_TOKEN),
        context.services.resolve(SSE_HUB_TOKEN),
        context.services.resolve(ACTOR_QUEUE_TOKEN),
        context.services.resolve(SETTLEMENT_SERVICE_TOKEN),
        optionsLogger(context.logger),
        context.services.resolve(PERSONAL_LIFE_SERVICE_TOKEN),
        context.services.resolve(PROACTIVE_DELIVERY_SERVICE_TOKEN),
        context.services.resolve(MEMORY_LIFECYCLE_SERVICE_TOKEN),
      );
      context.services.provide(SCHEDULER_SERVICE_TOKEN, scheduler);
      context.events.on("server.stopping", () => {
        scheduler.stop();
      });
      context.onDispose(() => {
        scheduler.stop();
      });
    },
  };
}

function optionsLogger(logger: KernelLogger): {
  error(bindings: Record<string, unknown>, message: string): void;
} {
  return {
    error: (bindings, message) => {
      logger.error(message, bindings);
    },
  };
}
