import {
  PluginRuntime,
  ServiceRegistry,
  TypedEventBus,
} from "@personasim/kernel";
import type { FastifyBaseLogger } from "fastify";

import type { ServerConfig } from "../config.js";
import type { Database } from "../db/connection.js";
import type { RouteServices } from "../http/routes.js";
import type { Clock } from "../runtime/clock.js";
import type { HourlyScheduler } from "../runtime/hourly-scheduler.js";
import type { LlmServiceObservationOptions } from "../services/llm-service.js";
import type { FixtureTurnBehavior } from "../services/turn-decision-service.js";
import { resolveServerBundle, type ServerSimulationBundle } from "./bundles.js";
import {
  createKernelLogger,
  createServerPlugins,
  type ServerKernelEvents,
} from "./plugins.js";
import {
  ACTOR_QUEUE_TOKEN,
  AUTOBIOGRAPHY_SERVICE_TOKEN,
  CALENDAR_SERVICE_TOKEN,
  CHARACTER_SERVICE_TOKEN,
  CHECKPOINT_SERVICE_TOKEN,
  CONVERSATION_SERVICE_TOKEN,
  CONTINUITY_INDEX_SERVICE_TOKEN,
  CONVERSATION_ACTIVITY_TRACKER_TOKEN,
  DATE_DIGEST_SERVICE_TOKEN,
  FOLLOW_UP_SERVICE_TOKEN,
  LIFE_SERVICE_TOKEN,
  MEMORY_LIFECYCLE_SERVICE_TOKEN,
  MEMORY_RECALL_SERVICE_TOKEN,
  PERSONAL_LIFE_SERVICE_TOKEN,
  PROACTIVE_DELIVERY_SERVICE_TOKEN,
  PROACTIVE_GENERATION_SERVICE_TOKEN,
  RETRIEVAL_RUN_REPOSITORY_TOKEN,
  SCHEDULE_SERVICE_TOKEN,
  SCHEDULER_SERVICE_TOKEN,
  SERVER_CLOCK_TOKEN,
  SERVER_CONFIG_TOKEN,
  SERVER_LLM_SERVICE_TOKEN,
  SETTLEMENT_SERVICE_TOKEN,
  SSE_HUB_TOKEN,
  STORE_TOKEN,
} from "./service-tokens.js";

export interface ComposeServerOptions {
  readonly config: ServerConfig;
  readonly logger: FastifyBaseLogger;
  readonly database?: Database;
  readonly clock?: Clock;
  readonly llmObservation?: LlmServiceObservationOptions;
  readonly fixtureTurnBehavior?: FixtureTurnBehavior;
}

export interface ServerKernelHandle {
  readonly bundle: ServerSimulationBundle;
  readonly registry: ServiceRegistry;
  readonly events: TypedEventBus<ServerKernelEvents>;
  readonly runtime: PluginRuntime<ServerKernelEvents>;
  readonly pluginIds: readonly string[];
}

export interface ServerComposition {
  readonly kernel: ServerKernelHandle;
  readonly routeServices: RouteServices;
  readonly scheduler: HourlyScheduler;
  dispose(reason: "fastify_close" | "build_failed"): Promise<void>;
}

export async function composeServer(
  options: ComposeServerOptions,
): Promise<ServerComposition> {
  const bundle = resolveServerBundle(options.config.profile);
  const registry = new ServiceRegistry();
  const events = new TypedEventBus<ServerKernelEvents>();
  const runtime = new PluginRuntime<ServerKernelEvents>({
    services: registry,
    events,
    logger: createKernelLogger(options.logger),
  });
  const plugins = createServerPlugins({
    bundle,
    config: options.config,
    logger: options.logger,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.llmObservation === undefined
      ? {}
      : { llmObservation: options.llmObservation }),
    ...(options.fixtureTurnBehavior === undefined
      ? {}
      : { fixtureTurnBehavior: options.fixtureTurnBehavior }),
  });
  await runtime.activatePlugins(plugins);

  const routeServices: RouteServices = {
    config: registry.resolve(SERVER_CONFIG_TOKEN),
    store: registry.resolve(STORE_TOKEN),
    clock: registry.resolve(SERVER_CLOCK_TOKEN),
    actors: registry.resolve(ACTOR_QUEUE_TOKEN),
    sse: registry.resolve(SSE_HUB_TOKEN),
    llm: registry.resolve(SERVER_LLM_SERVICE_TOKEN),
    memoryRecalls: registry.resolve(MEMORY_RECALL_SERVICE_TOKEN),
    characters: registry.resolve(CHARACTER_SERVICE_TOKEN),
    schedules: registry.resolve(SCHEDULE_SERVICE_TOKEN),
    settlements: registry.resolve(SETTLEMENT_SERVICE_TOKEN),
    personalLife: registry.resolve(PERSONAL_LIFE_SERVICE_TOKEN),
    life: registry.resolve(LIFE_SERVICE_TOKEN),
    autobiographies: registry.resolve(AUTOBIOGRAPHY_SERVICE_TOKEN),
    calendar: registry.resolve(CALENDAR_SERVICE_TOKEN),
    checkpoints: registry.resolve(CHECKPOINT_SERVICE_TOKEN),
    continuityIndex: registry.resolve(CONTINUITY_INDEX_SERVICE_TOKEN),
    conversationActivity: registry.resolve(CONVERSATION_ACTIVITY_TRACKER_TOKEN),
    dateDigests: registry.resolve(DATE_DIGEST_SERVICE_TOKEN),
    followUps: registry.resolve(FOLLOW_UP_SERVICE_TOKEN),
    memoryLifecycle: registry.resolve(MEMORY_LIFECYCLE_SERVICE_TOKEN),
    proactiveDelivery: registry.resolve(PROACTIVE_DELIVERY_SERVICE_TOKEN),
    proactiveGeneration: registry.resolve(PROACTIVE_GENERATION_SERVICE_TOKEN),
    retrievalRuns: registry.resolve(RETRIEVAL_RUN_REPOSITORY_TOKEN),
    conversations: registry.resolve(CONVERSATION_SERVICE_TOKEN),
  };
  const scheduler = registry.resolve(SCHEDULER_SERVICE_TOKEN);
  let disposed = false;

  return {
    kernel: {
      bundle,
      registry,
      events,
      runtime,
      pluginIds: runtime.activePluginIds,
    },
    routeServices,
    scheduler,
    dispose: async (reason) => {
      if (disposed) return;
      disposed = true;
      try {
        await events.emit("server.stopping", {
          atUtc: routeServices.clock.nowUtc(),
          reason,
        });
      } finally {
        await runtime.disposeAll();
      }
    },
  };
}
