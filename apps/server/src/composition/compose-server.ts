import { resolve } from "node:path";
import type { ReplySteeringMode } from "@personasim/features";
import type { FastifyBaseLogger } from "fastify";

import type { ServerConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { CalendarRepository } from "../repositories/calendar-repository.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import { KeepsakeRepository } from "../repositories/keepsake-repository.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { RetrievalRunRepository } from "../repositories/retrieval-run-repository.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import { PersonaRuntimeService } from "../services/persona-runtime-service.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock, SystemClock, type Clock } from "../runtime/clock.js";
import { HourlyScheduler } from "../runtime/hourly-scheduler.js";
import { TemporalTaskScheduler } from "../runtime/temporal-task-scheduler.js";
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
import {
  CorrespondenceCryptoService,
  CorrespondenceOpenService,
} from "../services/correspondence-crypto-service.js";
import { CorrespondenceService } from "../services/correspondence-service.js";
import { CorrespondenceSnapshotService } from "../services/correspondence-snapshot-service.js";
import { ContinuityIndexService } from "../services/continuity-index-service.js";
import { ContinuityMemoryRepository } from "../services/continuity-memory-repository.js";
import { ContinuityRepository } from "../services/continuity-repository.js";
import { DateDigestService } from "../services/date-digest-service.js";
import { FollowUpRepository } from "../services/follow-up-repository.js";
import { FollowUpService } from "../services/follow-up-service.js";
import { ConversationActivityTracker } from "../services/conversation-activity-tracker.js";
import { ProactiveGenerationRepository } from "../services/proactive-generation-repository.js";
import { ProactiveGenerationService } from "../services/proactive-generation-service.js";
import { ProactiveDeliveryService } from "../services/proactive-delivery-service.js";
import {
  ProactiveTaskRepository,
  PROACTIVE_TASK_KINDS,
} from "../services/proactive-task-repository.js";
import { ProactiveTaskService } from "../services/proactive-task-service.js";
import { FuzzyLifeService } from "../services/fuzzy-life-service.js";
import { LlmSettingsService } from "../services/llm-settings-service.js";
import {
  LlmService,
  type LlmServiceObservationOptions,
} from "../services/llm-service.js";
import { MemoryLifecycleService } from "../services/memory-lifecycle-service.js";
import { MemoryRecallService } from "../services/memory-recall-service.js";
import { LetterReplyGenerationService } from "../services/letter-reply-generation-service.js";
import { KeepsakeAssetStore } from "../services/keepsake-asset-store.js";
import { KeepsakeService } from "../services/keepsake-service.js";
import { PersonalIntentService } from "../services/personal-intent-service.js";
import { PersonalLifeService } from "../services/personal-life-service.js";
import { ReplyRepairService } from "../services/reply-repair-service.js";
import { RelationshipArchiveService } from "../services/relationship-archive-service.js";
import { SelfPlanningService } from "../services/self-planning-service.js";
import { ScheduleService } from "../services/schedule-service.js";
import { SettlementService } from "../services/settlement-service.js";
import { TurnCommitService } from "../services/turn-commit-service.js";
import { TemporalCatchUpService } from "../services/temporal-catch-up-service.js";
import {
  TurnDecisionService,
  type FixtureTurnBehavior,
} from "../services/turn-decision-service.js";
import { WorldEffectService } from "../services/world-effect-service.js";
import { SseHub } from "../sse/hub.js";
import { AchievementService } from "../services/achievement-service.js";
import { DiaryService } from "../services/diary-service.js";
import type { RouteServices } from "../http/routes.js";

export interface ComposeServerOptions {
  readonly replySteeringMode?: ReplySteeringMode;
  readonly config: ServerConfig;
  readonly logger: FastifyBaseLogger;
  readonly database?: Database;
  readonly clock?: Clock;
  readonly llmObservation?: LlmServiceObservationOptions;
  readonly fixtureTurnBehavior?: FixtureTurnBehavior;
}

export type ServerServices = RouteServices & {
  personalIntents: PersonalIntentService | undefined;
  selfPlanning: SelfPlanningService | undefined;
  personaRuntime: PersonaRuntimeService;
  conversationContext: ConversationContextService;
  replyRepairs: ReplyRepairService;
  turnDecisions: TurnDecisionService;
  worldEffects: WorldEffectService;
  turnCommits: TurnCommitService;
};

/** Typed service access for internal diagnostics and integration tests. */
export interface ServerKernelHandle {
  readonly services: ServerServices;
}
export interface ServerComposition {
  readonly kernel: ServerKernelHandle;
  readonly routeServices: ServerServices;
  readonly scheduler: HourlyScheduler;
  readonly temporalTaskScheduler: TemporalTaskScheduler;
  readonly proactiveTaskScheduler: TemporalTaskScheduler;
  readonly hourlyEnabled: boolean;
  dispose(reason: "fastify_close" | "build_failed"): Promise<void>;
}

export async function composeServer(
  options: ComposeServerOptions,
): Promise<ServerComposition> {
  const { config, logger, replySteeringMode, fixtureTurnBehavior } = options;
  const database = options.database ?? openDatabase(config.databasePath);
  const disposers: Array<() => void | Promise<void>> = [
    () => {
      if (database.open) database.close();
    },
  ];
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> =>
    (disposal ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [...disposers].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Server cleanup failed");
    })());
  try {
    runMigrations(database);
    const store = new DatabaseStore(database);
    const clock =
      options.clock ??
      (config.clockMode === "fake"
        ? new FakeClock(config.fakeClockStart)
        : new SystemClock());
    const actors = new ActorQueue();
    const sse = new SseHub();
    disposers.push(() => sse.close());
    const llm = new LlmService(
      config.llm,
      store,
      clock,
      options.llmObservation,
    );
    llm.settings = new LlmSettingsService(store, config, clock);
    const correspondenceMode = config.correspondenceMode ?? "off";
    const correspondenceCrypto = CorrespondenceCryptoService.initialize(
      database,
      {
        mode: correspondenceMode,
        ...(config.instanceSecret === undefined
          ? {}
          : { instanceSecret: config.instanceSecret }),
        nowUtc: clock.nowUtc(),
      },
    );
    const characters = new CharacterService(
      store,
      clock,
      llm,
      config.lifePlanningMode,
    );
    const legacy = config.lifePlanningMode === "legacy_exact";
    const schedules = legacy
      ? new ScheduleService(store, clock, llm, "legacy_exact")
      : undefined;
    const personalIntents = legacy
      ? new PersonalIntentService(store, clock)
      : undefined;
    const selfPlanning =
      schedules === undefined
        ? undefined
        : new SelfPlanningService(
            schedules,
            clock,
            config.selfInitiatedPlanningMode === "enforced"
              ? "enforced"
              : "shadow",
          );
    const personalLife =
      schedules === undefined ||
      personalIntents === undefined ||
      selfPlanning === undefined
        ? undefined
        : new PersonalLifeService(
            store,
            clock,
            personalIntents,
            selfPlanning,
            schedules,
            sse,
            config.selfInitiatedPlanningMode,
          );
    const life = new FuzzyLifeService(
      store,
      new LifeRepository(store.database),
      clock,
    );
    const correspondenceRepository = new CorrespondenceRepository(
      store.database,
    );
    const personaRuntime = new PersonaRuntimeService(
      store,
      new MemoryValidityRepository(store),
    );
    const correspondenceSnapshots = new CorrespondenceSnapshotService(
      store,
      {},
      config.personaRuntimeMode === "enforced"
        ? (baseSpec, nowUtc, topicText) =>
            personaRuntime.snapshotAsOf({ baseSpec, nowUtc, topicText })
        : undefined,
    );
    const letterReplyGeneration =
      correspondenceMode === "enforced" && correspondenceCrypto !== undefined
        ? new LetterReplyGenerationService(
            correspondenceRepository,
            llm,
            correspondenceCrypto,
            {
              provider: llm.providerName,
              model: llm.modelName,
            },
          )
        : undefined;
    const temporalCatchUp = new TemporalCatchUpService(
      correspondenceRepository,
      {
        advance: (agentId, toUtc) => {
          life.advance(agentId, toUtc);
        },
      },
      actors,
      clock,
      {
        leaseMs: config.correspondenceGenerationLeaseMs ?? 1_800_000,
        ...(correspondenceMode === "off"
          ? {}
          : {
              outboundArrivalTaskHandler:
                correspondenceSnapshots.createOutboundArrivalTaskHandler(
                  correspondenceMode,
                ),
            }),
        ...(letterReplyGeneration === undefined
          ? {}
          : {
              externalTaskHandler:
                letterReplyGeneration.createExternalHandler(),
            }),
      },
    );
    const correspondenceOpen =
      correspondenceCrypto === undefined
        ? undefined
        : new CorrespondenceOpenService(store.database, correspondenceCrypto);
    const correspondence = new CorrespondenceService(
      correspondenceRepository,
      store,
      clock,
      actors,
      temporalCatchUp,
      sse,
      {
        mode: correspondenceMode,
        transitPolicyVersion:
          config.correspondenceTransitPolicy ?? "fixed_5d_v1",
        ...(correspondenceCrypto === undefined
          ? {}
          : { crypto: correspondenceCrypto }),
        ...(correspondenceOpen === undefined
          ? {}
          : { openService: correspondenceOpen }),
      },
    );
    const keepsakeRepository = new KeepsakeRepository(store.database);
    const keepsakeAssets = new KeepsakeAssetStore(
      config.assetStoragePath ?? "./data/assets",
    );
    const keepsakes = new KeepsakeService(
      keepsakeRepository,
      correspondenceRepository,
      store,
      keepsakeAssets,
      clock,
      sse,
      {
        mode: config.keepsakeMode ?? "off",
        leaseMs: config.correspondenceGenerationLeaseMs ?? 1_800_000,
        onBackgroundError: (errorCode) => {
          logger.warn({ errorCode }, "Background keepsake enqueue failed");
        },
      },
    );
    correspondence.setOpenedLetterHandler((replyLetterId, openedAtUtc) =>
      keepsakes.receiveForOpenedLetter(replyLetterId, openedAtUtc),
    );
    correspondence.setRelatedKeepsakeResolver((replyLetterId) =>
      keepsakes.listReadyForReply(replyLetterId),
    );
    letterReplyGeneration?.setReplyCommittedHandler((notice) => {
      // Use the now-read incoming user letter as evidence. The newly created
      // reply is still in transit and therefore intentionally ineligible.
      keepsakes.enqueueLetterKeepsakeNonBlocking(
        notice.agentId,
        notice.incomingLetterId,
        notice.replyLetterId,
      );
    });
    const relationshipArchive = new RelationshipArchiveService(
      store.database,
      clock,
      correspondenceCrypto,
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
      (agentId, nowUtc) =>
        keepsakes.relationshipArtifactsPromptContext(agentId, nowUtc),
    );
    const settlements =
      schedules === undefined
        ? undefined
        : new SettlementService(
            store,
            clock,
            llm,
            schedules,
            sse,
            {
              continuityIndex,
            },
            config.lifePlanningMode,
          );
    const conversationOptions = {
      recordMemoryRecallDiagnostics: config.developerRoutes,
      ...(replySteeringMode === undefined ? {} : { replySteeringMode }),
      chatEffectsMode: config.chatEffectsMode,
      lifePlanningMode: config.lifePlanningMode,
      liveWorldEffectsMode: config.liveWorldEffectsMode,
      scheduleNegotiationMode: config.scheduleNegotiationMode,
      memoryRecallMode: config.memoryRecallMode,
      companionContextMode: config.companionContextMode ?? "off",
      personaRuntimeMode: config.personaRuntimeMode ?? "off",
      conversationRetention: config.conversationRetention,
      ...(fixtureTurnBehavior === undefined ? {} : { fixtureTurnBehavior }),
    };
    const replyRepairs = new ReplyRepairService(llm);
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
      life,
      personaRuntime,
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
        fuzzyLife: life,
        personaRuntime,
      },
    );

    const scheduler = new HourlyScheduler(
      clock,
      sse,
      actors,
      settlements,
      logger,
      personalLife,
      memoryLifecycle,
      life,
      config.lifePlanningMode,
    );
    disposers.push(() => scheduler.dispose());
    const temporalTaskScheduler = new TemporalTaskScheduler(
      correspondenceRepository,
      {
        catchUpAgent: async (agentId, observedNowUtc) => {
          await correspondence.catchUpAgent(agentId, observedNowUtc);
          await keepsakes.processDueForAgent(agentId, observedNowUtc);
        },
      },
      clock,
      logger,
      {
        execution: config.correspondenceExecution ?? "lazy",
        taskKinds: [
          ...(correspondenceMode === "enforced"
            ? ([
                "letter.outbound_arrival",
                "letter.reply_generation",
                "letter.return_arrival",
                "letter.generation_retry",
              ] as const)
            : correspondenceMode === "shadow"
              ? (["letter.outbound_arrival", "letter.return_arrival"] as const)
              : []),
          ...(config.keepsakeMode === "enforced"
            ? (["keepsake.generate"] as const)
            : []),
        ],
      },
    );
    disposers.push(() => temporalTaskScheduler.dispose());
    const proactiveActivity = new ConversationActivityTracker(database);
    const proactiveGenerations: ProactiveGenerationService =
      new ProactiveGenerationService(
        new ProactiveGenerationRepository(database),
        proactiveActivity,
        actors,
        clock,
        (agentId, nowUtc) => proactiveDelivery.loadPolicy(agentId, nowUtc),
      );
    const proactiveDelivery: ProactiveDeliveryService =
      new ProactiveDeliveryService(
        store,
        clock,
        llm,
        sse,
        proactiveGenerations,
      );
    const proactiveTasks = new ProactiveTaskRepository(
      database,
      config.proactiveMode ?? "shadow",
      (agentId, nowUtc) => {
        try {
          life.advance(agentId, nowUtc);
        } catch {
          logger.warn(
            { agentId },
            "proactive activity discovery failed for one character",
          );
        }
      },
    );
    const proactiveTaskService = new ProactiveTaskService(
      proactiveTasks,
      proactiveDelivery,
      store,
      clock,
    );
    const proactiveTaskScheduler = new TemporalTaskScheduler(
      {
        findNextTemporalTask: (nowUtc, kinds, excludedAgentIds) => {
          proactiveDelivery.flushNotifications();
          return proactiveTasks.findNextTemporalTask(
            nowUtc,
            kinds,
            excludedAgentIds,
          );
        },
      },
      proactiveTaskService,
      clock,
      logger,
      {
        execution: config.proactiveExecution ?? "resident",
        taskKinds: PROACTIVE_TASK_KINDS,
      },
    );
    disposers.push(() => proactiveTaskScheduler.dispose());
    correspondence.setAuxiliaryCatchUp((agentId, observedNowUtc) => {
      void temporalTaskScheduler.requestAgentCatchUp(agentId, observedNowUtc);
      return Promise.resolve();
    });
    const achievements = new AchievementService(database, clock, {
      databasePath: config.databasePath,
      assetRoot:
        resolve(config.assetStoragePath ?? "./data/assets") + "-achievements",
      developerMode: config.developerRoutes,
      ...(options.llmObservation?.fetch
        ? { fetch: options.llmObservation.fetch }
        : {}),
      ...(options.llmObservation?.imageProviderFactory
        ? { imageProviderFactory: options.llmObservation.imageProviderFactory }
        : {}),
      ...(options.llmObservation?.onImageAsset
        ? { onImageAsset: options.llmObservation.onImageAsset }
        : {}),
    });
    disposers.push(() => achievements.stop());
    const diaries = new DiaryService(store, clock, llm);
    const services: ServerServices = {
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
      autobiographies,
      calendar,
      checkpoints,
      continuityIndex,
      dateDigests,
      followUps,
      memoryLifecycle,
      retrievalRuns,
      conversations,
      correspondence,
      correspondenceRepository,
      temporalCatchUp,
      temporalTaskScheduler,
      proactiveActivity,
      proactiveDelivery,
      proactiveTaskScheduler,
      keepsakes,
      relationshipArchive,
      achievements,
      diaries,
      personalIntents,
      selfPlanning,
      personaRuntime,
      conversationContext,
      replyRepairs,
      turnDecisions,
      worldEffects,
      turnCommits,
    };
    achievements.start();
    return {
      kernel: { services },
      routeServices: services,
      scheduler,
      temporalTaskScheduler,
      proactiveTaskScheduler,
      hourlyEnabled: config.profile.trim().toLowerCase() !== "lightweight",
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Server composition and cleanup failed",
      );
    }
    throw error;
  }
}
