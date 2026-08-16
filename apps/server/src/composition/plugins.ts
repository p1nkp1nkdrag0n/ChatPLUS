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
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock, SystemClock, type Clock } from "../runtime/clock.js";
import { HourlyScheduler } from "../runtime/hourly-scheduler.js";
import { CharacterService } from "../services/character-service.js";
import { ConversationService } from "../services/conversation-service.js";
import { LlmService } from "../services/llm-service.js";
import { ScheduleService } from "../services/schedule-service.js";
import { SettlementService } from "../services/settlement-service.js";
import { SseHub } from "../sse/hub.js";
import type { ServerSimulationBundle } from "./bundles.js";
import {
  ACTOR_QUEUE_TOKEN,
  CHARACTER_SERVICE_TOKEN,
  CONVERSATION_SERVICE_TOKEN,
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
        SERVER_SERVICE_IDS.conversations,
      ],
    },
    setup: (context) => {
      const store = context.services.resolve(STORE_TOKEN);
      const clock = context.services.resolve(SERVER_CLOCK_TOKEN);
      const llm = context.services.resolve(SERVER_LLM_SERVICE_TOKEN);
      const sse = context.services.resolve(SSE_HUB_TOKEN);
      const config = context.services.resolve(SERVER_CONFIG_TOKEN);
      const characters = new CharacterService(store, clock, llm);
      const schedules = new ScheduleService(store, clock, llm);
      const settlements = new SettlementService(
        store,
        clock,
        llm,
        schedules,
        sse,
      );
      const conversations = new ConversationService(
        store,
        clock,
        llm,
        schedules,
        settlements,
        sse,
        {
          chatEffectsMode: config.chatEffectsMode,
          scheduleNegotiationMode: config.scheduleNegotiationMode,
        },
      );

      context.services.provide(CHARACTER_SERVICE_TOKEN, characters);
      context.services.provide(SCHEDULE_SERVICE_TOKEN, schedules);
      context.services.provide(SETTLEMENT_SERVICE_TOKEN, settlements);
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
