import { CORE_SERVICE_IDS } from "@personasim/contracts";
import { createServiceToken } from "@personasim/kernel";

import type { ServerConfig } from "../config.js";
import type { DatabaseStore } from "../db/store.js";
import type { ActorQueue } from "../runtime/actor-queue.js";
import type { Clock } from "../runtime/clock.js";
import type { HourlyScheduler } from "../runtime/hourly-scheduler.js";
import type { CharacterService } from "../services/character-service.js";
import type { ConversationService } from "../services/conversation-service.js";
import type { LlmService } from "../services/llm-service.js";
import type { ScheduleService } from "../services/schedule-service.js";
import type { SettlementService } from "../services/settlement-service.js";
import type { SseHub } from "../sse/hub.js";
import type { ServerSimulationBundle } from "./bundles.js";

export const SERVER_SERVICE_IDS = {
  bundle: "server.bundle",
  config: "server.config",
  actors: "server.actors",
  sse: "server.sse",
  llm: "server.llm",
  characters: "server.characters",
  schedules: "server.schedules",
  settlements: "server.settlements",
  conversations: "server.conversations",
  scheduler: "server.scheduler",
} as const;

export const SERVER_BUNDLE_TOKEN = createServiceToken<ServerSimulationBundle>(
  SERVER_SERVICE_IDS.bundle,
);
export const SERVER_CONFIG_TOKEN = createServiceToken<ServerConfig>(
  SERVER_SERVICE_IDS.config,
);
export const STORE_TOKEN = createServiceToken<DatabaseStore>(
  CORE_SERVICE_IDS.storage,
);
export const ACTOR_QUEUE_TOKEN = createServiceToken<ActorQueue>(
  SERVER_SERVICE_IDS.actors,
);
export const SSE_HUB_TOKEN = createServiceToken<SseHub>(SERVER_SERVICE_IDS.sse);
export const SERVER_LLM_SERVICE_TOKEN = createServiceToken<LlmService>(
  SERVER_SERVICE_IDS.llm,
);
export const CHARACTER_SERVICE_TOKEN = createServiceToken<CharacterService>(
  SERVER_SERVICE_IDS.characters,
);
export const SCHEDULE_SERVICE_TOKEN = createServiceToken<ScheduleService>(
  SERVER_SERVICE_IDS.schedules,
);
export const SETTLEMENT_SERVICE_TOKEN = createServiceToken<SettlementService>(
  SERVER_SERVICE_IDS.settlements,
);
export const CONVERSATION_SERVICE_TOKEN =
  createServiceToken<ConversationService>(SERVER_SERVICE_IDS.conversations);
export const SCHEDULER_SERVICE_TOKEN = createServiceToken<HourlyScheduler>(
  SERVER_SERVICE_IDS.scheduler,
);

/** Local alias retains the routes' richer Clock type while sharing core.clock. */
export const SERVER_CLOCK_TOKEN = createServiceToken<Clock>("core.clock");
