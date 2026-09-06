import { CORE_SERVICE_IDS } from "@personasim/contracts";
import { createServiceToken } from "@personasim/kernel";

import type { ServerConfig } from "../config.js";
import type { DatabaseStore } from "../db/store.js";
import type { ActorQueue } from "../runtime/actor-queue.js";
import type { Clock } from "../runtime/clock.js";
import type { HourlyScheduler } from "../runtime/hourly-scheduler.js";
import type { TemporalTaskScheduler } from "../runtime/temporal-task-scheduler.js";
import type { RetrievalRunRepository } from "../repositories/retrieval-run-repository.js";
import type { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import type { KeepsakeRepository } from "../repositories/keepsake-repository.js";
import type { AutobiographyService } from "../services/autobiography-service.js";
import type { CalendarService } from "../services/calendar-service.js";
import type { CharacterService } from "../services/character-service.js";
import type { CheckpointService } from "../services/checkpoint-service.js";
import type { ConversationContinuityService } from "../services/conversation-continuity-service.js";
import type { ConversationContextService } from "../services/conversation-context-service.js";
import type { ConversationService } from "../services/conversation-service.js";
import type {
  CorrespondenceCryptoService,
  CorrespondenceOpenService,
} from "../services/correspondence-crypto-service.js";
import type { CorrespondenceService } from "../services/correspondence-service.js";
import type { CorrespondenceSnapshotService } from "../services/correspondence-snapshot-service.js";
import type { ContinuityIndexService } from "../services/continuity-index-service.js";
import type { ConversationActivityTracker } from "../services/conversation-activity-tracker.js";
import type { DateDigestService } from "../services/date-digest-service.js";
import type { FuzzyLifeService } from "../services/fuzzy-life-service.js";
import type { FollowUpService } from "../services/follow-up-service.js";
import type { ProactiveDeliveryService } from "../services/proactive-delivery-service.js";
import type { LlmService } from "../services/llm-service.js";
import type { LetterReplyGenerationService } from "../services/letter-reply-generation-service.js";
import type { KeepsakeAssetStore } from "../services/keepsake-asset-store.js";
import type { KeepsakeService } from "../services/keepsake-service.js";
import type { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import type { MemoryRecallService } from "../services/memory-recall-service.js";
import type { PersonalIntentService } from "../services/personal-intent-service.js";
import type { PersonalLifeService } from "../services/personal-life-service.js";
import type { ProactiveGenerationService } from "../services/proactive-generation-service.js";
import type { ReplyRepairService } from "../services/reply-repair-service.js";
import type { RelationshipArchiveService } from "../services/relationship-archive-service.js";
import type { SelfPlanningService } from "../services/self-planning-service.js";
import type { ScheduleService } from "../services/schedule-service.js";
import type { SettlementService } from "../services/settlement-service.js";
import type { TurnCommitService } from "../services/turn-commit-service.js";
import type { TurnDecisionService } from "../services/turn-decision-service.js";
import type { TemporalCatchUpService } from "../services/temporal-catch-up-service.js";
import type { WorldEffectService } from "../services/world-effect-service.js";
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
  turnDecisions: "server.turn-decisions",
  worldEffects: "server.world-effects",
  turnCommits: "server.turn-commits",
  replyRepairs: "server.reply-repairs",
  memoryRecalls: "server.memory-recalls",
  personalIntents: "server.personal-intents",
  selfPlanning: "server.self-planning",
  personalLife: "server.personal-life",
  life: "server.fuzzy-life",
  autobiographies: "server.autobiographies",
  calendar: "server.calendar",
  checkpoints: "server.checkpoints",
  continuityIndex: "server.continuity-index",
  conversationContinuity: "server.conversation-continuity",
  conversationContext: "server.conversation-context",
  conversationActivity: "server.conversation-activity",
  dateDigests: "server.date-digests",
  followUps: "server.follow-ups",
  memoryLifecycle: "server.memory-lifecycle",
  proactiveGeneration: "server.proactive-generation",
  retrievalRuns: "server.retrieval-runs",
  proactiveDelivery: "server.proactive-delivery",
  scheduler: "server.scheduler",
  temporalTaskScheduler: "server.correspondence.temporal-task-scheduler",
  correspondenceRepository: "server.correspondence.repository",
  correspondenceCrypto: "server.correspondence.crypto",
  correspondenceSnapshots: "server.correspondence.snapshots",
  letterReplyGeneration: "server.correspondence.reply-generation",
  temporalCatchUp: "server.correspondence.temporal-catch-up",
  correspondenceOpen: "server.correspondence.open",
  correspondence: "server.correspondence",
  keepsakeRepository: "server.keepsake.repository",
  keepsakeAssets: "server.keepsake.assets",
  keepsakes: "server.keepsake",
  relationshipArchive: "server.relationship-archive",
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
export const MEMORY_RECALL_SERVICE_TOKEN =
  createServiceToken<MemoryRecallService>(SERVER_SERVICE_IDS.memoryRecalls);
export const PERSONAL_INTENT_SERVICE_TOKEN =
  createServiceToken<PersonalIntentService>(SERVER_SERVICE_IDS.personalIntents);
export const SELF_PLANNING_SERVICE_TOKEN =
  createServiceToken<SelfPlanningService>(SERVER_SERVICE_IDS.selfPlanning);
export const PERSONAL_LIFE_SERVICE_TOKEN =
  createServiceToken<PersonalLifeService>(SERVER_SERVICE_IDS.personalLife);
export const LIFE_SERVICE_TOKEN = createServiceToken<FuzzyLifeService>(
  SERVER_SERVICE_IDS.life,
);
export const AUTOBIOGRAPHY_SERVICE_TOKEN =
  createServiceToken<AutobiographyService>(SERVER_SERVICE_IDS.autobiographies);
export const CALENDAR_SERVICE_TOKEN = createServiceToken<CalendarService>(
  SERVER_SERVICE_IDS.calendar,
);
export const CHECKPOINT_SERVICE_TOKEN = createServiceToken<CheckpointService>(
  SERVER_SERVICE_IDS.checkpoints,
);
export const CONTINUITY_INDEX_SERVICE_TOKEN =
  createServiceToken<ContinuityIndexService>(
    SERVER_SERVICE_IDS.continuityIndex,
  );
export const CONVERSATION_CONTINUITY_SERVICE_TOKEN =
  createServiceToken<ConversationContinuityService>(
    SERVER_SERVICE_IDS.conversationContinuity,
  );
export const CONVERSATION_CONTEXT_SERVICE_TOKEN =
  createServiceToken<ConversationContextService>(
    SERVER_SERVICE_IDS.conversationContext,
  );
export const CONVERSATION_ACTIVITY_TRACKER_TOKEN =
  createServiceToken<ConversationActivityTracker>(
    SERVER_SERVICE_IDS.conversationActivity,
  );
export const DATE_DIGEST_SERVICE_TOKEN = createServiceToken<DateDigestService>(
  SERVER_SERVICE_IDS.dateDigests,
);
export const FOLLOW_UP_SERVICE_TOKEN = createServiceToken<FollowUpService>(
  SERVER_SERVICE_IDS.followUps,
);
export const MEMORY_LIFECYCLE_SERVICE_TOKEN =
  createServiceToken<MemoryLifecycleService>(
    SERVER_SERVICE_IDS.memoryLifecycle,
  );
export const PROACTIVE_GENERATION_SERVICE_TOKEN =
  createServiceToken<ProactiveGenerationService>(
    SERVER_SERVICE_IDS.proactiveGeneration,
  );
export const RETRIEVAL_RUN_REPOSITORY_TOKEN =
  createServiceToken<RetrievalRunRepository>(SERVER_SERVICE_IDS.retrievalRuns);
export const CONVERSATION_SERVICE_TOKEN =
  createServiceToken<ConversationService>(SERVER_SERVICE_IDS.conversations);
export const TURN_DECISION_SERVICE_TOKEN =
  createServiceToken<TurnDecisionService>(SERVER_SERVICE_IDS.turnDecisions);
export const WORLD_EFFECT_SERVICE_TOKEN =
  createServiceToken<WorldEffectService>(SERVER_SERVICE_IDS.worldEffects);
export const TURN_COMMIT_SERVICE_TOKEN = createServiceToken<TurnCommitService>(
  SERVER_SERVICE_IDS.turnCommits,
);
export const REPLY_REPAIR_SERVICE_TOKEN =
  createServiceToken<ReplyRepairService>(SERVER_SERVICE_IDS.replyRepairs);
export const PROACTIVE_DELIVERY_SERVICE_TOKEN =
  createServiceToken<ProactiveDeliveryService>(
    SERVER_SERVICE_IDS.proactiveDelivery,
  );
export const SCHEDULER_SERVICE_TOKEN = createServiceToken<HourlyScheduler>(
  SERVER_SERVICE_IDS.scheduler,
);
export const TEMPORAL_TASK_SCHEDULER_TOKEN =
  createServiceToken<TemporalTaskScheduler>(
    SERVER_SERVICE_IDS.temporalTaskScheduler,
  );
export const CORRESPONDENCE_REPOSITORY_TOKEN =
  createServiceToken<CorrespondenceRepository>(
    SERVER_SERVICE_IDS.correspondenceRepository,
  );
export const CORRESPONDENCE_CRYPTO_SERVICE_TOKEN = createServiceToken<
  CorrespondenceCryptoService | undefined
>(SERVER_SERVICE_IDS.correspondenceCrypto);
export const CORRESPONDENCE_SNAPSHOT_SERVICE_TOKEN =
  createServiceToken<CorrespondenceSnapshotService>(
    SERVER_SERVICE_IDS.correspondenceSnapshots,
  );
export const LETTER_REPLY_GENERATION_SERVICE_TOKEN = createServiceToken<
  LetterReplyGenerationService | undefined
>(SERVER_SERVICE_IDS.letterReplyGeneration);
export const TEMPORAL_CATCH_UP_SERVICE_TOKEN =
  createServiceToken<TemporalCatchUpService>(
    SERVER_SERVICE_IDS.temporalCatchUp,
  );
export const CORRESPONDENCE_OPEN_SERVICE_TOKEN = createServiceToken<
  CorrespondenceOpenService | undefined
>(SERVER_SERVICE_IDS.correspondenceOpen);
export const CORRESPONDENCE_SERVICE_TOKEN =
  createServiceToken<CorrespondenceService>(SERVER_SERVICE_IDS.correspondence);
export const KEEPSAKE_REPOSITORY_TOKEN = createServiceToken<KeepsakeRepository>(
  SERVER_SERVICE_IDS.keepsakeRepository,
);
export const KEEPSAKE_ASSET_STORE_TOKEN =
  createServiceToken<KeepsakeAssetStore>(SERVER_SERVICE_IDS.keepsakeAssets);
export const KEEPSAKE_SERVICE_TOKEN = createServiceToken<KeepsakeService>(
  SERVER_SERVICE_IDS.keepsakes,
);
export const RELATIONSHIP_ARCHIVE_SERVICE_TOKEN =
  createServiceToken<RelationshipArchiveService>(
    SERVER_SERVICE_IDS.relationshipArchive,
  );

/** Local alias retains the routes' richer Clock type while sharing core.clock. */
export const SERVER_CLOCK_TOKEN = createServiceToken<Clock>("core.clock");
