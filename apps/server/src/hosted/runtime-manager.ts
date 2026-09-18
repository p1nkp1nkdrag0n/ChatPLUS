import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "../config.js";
import {
  composeServer,
  type ServerComposition,
} from "../composition/compose-server.js";
import { readOrCreateDesktopInstanceSecret } from "../desktop-runtime.js";
import type { HostedControlStore } from "./control-store.js";
import type { HostedModelGateway } from "./model-gateway.js";
import { HostedError } from "./types.js";
import { UserModelSettingsService } from "./user-model-settings.js";
import {
  collectBusinessRoutes,
  type BusinessRegistry,
} from "./route-registry.js";

export interface TenantRuntime {
  composition: ServerComposition;
  registry: BusinessRegistry;
  modelSettings: UserModelSettingsService;
}
export class HostedRuntimeManager {
  private readonly runtimes = new Map<string, Promise<TenantRuntime>>();
  private closing = false;
  private readonly onboardingCutoff: string;
  constructor(
    private readonly options: {
      rootDirectory: string;
      baseConfig: ServerConfig;
      control: HostedControlStore;
      gateway: HostedModelGateway;
      logger: FastifyBaseLogger;
      startSchedulers?: boolean;
    },
  ) {
    const cutoff = new Date().toISOString();
    // Persist the rollout boundary before any registration can create a user.
    // Existing accounts without a tenant DB also keep their previous entry flow.
    if (options.control.database) {
      options.control.database
        .prepare(
          "INSERT OR IGNORE INTO settings(key,value_json) VALUES('user_model_onboarding_cutoff',?)",
        )
        .run(JSON.stringify(cutoff));
      const row = options.control.database
        .prepare(
          "SELECT value_json FROM settings WHERE key='user_model_onboarding_cutoff'",
        )
        .get() as { value_json: string };
      this.onboardingCutoff = JSON.parse(row.value_json) as string;
    } else this.onboardingCutoff = cutoff;
  }

  get(userId: string): Promise<TenantRuntime> {
    if (this.closing)
      throw new HostedError(
        503,
        "service_stopping",
        "服务正在维护，请稍后重试。",
      );
    const user = this.options.control.getUser(userId);
    if (!user || user.status !== "active")
      throw new HostedError(403, "account_unavailable", "账号不可用。");
    let runtime = this.runtimes.get(userId);
    if (!runtime) {
      runtime = this.create(userId).catch((error: unknown) => {
        this.runtimes.delete(userId);
        throw error;
      });
      this.runtimes.set(userId, runtime);
    }
    return runtime;
  }
  async restore(): Promise<void> {
    for (const user of this.options.control.listUsers({
      status: "active",
      limit: 1000,
    })) {
      if (user.role === "user") await this.get(user.id);
    }
  }
  private async create(userId: string): Promise<TenantRuntime> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(userId))
      throw new Error("Invalid server-generated user ID");
    const root = join(this.options.rootDirectory, "users", userId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const config: ServerConfig = {
      ...this.options.baseConfig,
      profile: "hosted",
      nodeEnv: "production",
      host: "127.0.0.1",
      databasePath: join(root, "business.sqlite"),
      assetStoragePath: join(root, "assets"),
      instanceSecret: readOrCreateDesktopInstanceSecret(root),
      developerRoutes: false,
      serveWeb: false,
      selfHostedReverseProxy: false,
      clockMode: "system",
      seedDemo: false,
      correspondenceExecution: "resident",
      llm: {
        provider: "fixture",
        baseUrl: "https://hosted.invalid",
        model: "unconfigured",
        timeoutMs: 120000,
        maxRetries: 0,
        maxOutputTokens: 8192,
      },
    };
    const resolverState: { modelSettings?: UserModelSettingsService } = {};
    const composition: ServerComposition = await composeServer({
      config,
      logger: this.options.logger,
      userDisplayName: this.options.control.getUser(userId)!.username,
      llmObservation: this.options.gateway.forUser(
        userId,
        (purpose, selection) =>
          resolverState.modelSettings?.resolve(purpose, selection),
        () => resolverState.modelSettings?.get().imageSelection ?? null,
        (selection) =>
          composition.routeServices.llm.settings!.resolve(selection),
      ),
    });
    const modelSettings = new UserModelSettingsService(
      composition.routeServices.store,
      composition.routeServices.llm.settings!,
      {
        initialOnboardingCompleted:
          this.options.control.getUser(userId)!.createdAtUtc <
          this.onboardingCutoff,
        validateImageSelection: (selection) => {
          const model = this.options.control.resolveModel(selection.modelId);
          if (model.kind !== "image" || !model.enabled)
            throw new HostedError(
              400,
              "invalid_image_model",
              "请选择可用的平台图片模型。",
            );
        },
      },
    );
    resolverState.modelSettings = modelSettings;
    const runtime = {
      composition,
      registry: collectBusinessRoutes(composition.routeServices),
      modelSettings,
    };
    this.syncModels(runtime);
    if (this.options.startSchedulers !== false) {
      composition.scheduler.start();
      await composition.temporalTaskScheduler.start();
      await composition.proactiveTaskScheduler.start();
    } else await composition.routeServices.achievements.pause();
    return runtime;
  }
  syncModels(runtime: TenantRuntime): void {
    const db = runtime.composition.routeServices.store.database;
    const models = this.options.control
      .listModels()
      .filter((model) => model.kind === "text" && model.enabled);
    const now = new Date().toISOString();
    const publicModels = models.map((model) => ({
      id: model.routeId,
      label: model.displayName,
      capabilities: {
        structuredOutputMode: "prompt_json",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxOutputTokens: model.maxOutputTokens,
        maxContextTokens:
          model.maxContextTokens ??
          Math.max(32000, model.maxOutputTokens + 8192),
      },
      tokenParameter: "max_tokens",
    }));
    let defaultId = models[0]?.routeId;
    try {
      defaultId = this.options.control.resolvePurpose("chat_turn").routeId;
    } catch {
      /* no model configured yet */
    }
    const modelsJson = JSON.stringify(publicModels);
    const chatBinding = runtime.modelSettings?.get().bindings.chat_turn;
    const selectionJson = chatBinding
      ? JSON.stringify(chatBinding)
      : defaultId
        ? JSON.stringify({ providerId: "hosted", modelId: defaultId })
        : null;
    const provider = db
      .prepare("SELECT models_json FROM llm_providers WHERE id='hosted'")
      .get() as { models_json: string } | undefined;
    const settings = db
      .prepare("SELECT default_selection_json FROM llm_settings WHERE id=1")
      .get() as { default_selection_json: string | null };
    // Reads of the managed catalog must not turn ordinary GETs into writes.
    // Compare the durable projection so a changed catalog or restored DB is
    // synchronized without depending on an in-memory invalidation protocol.
    const modelsChanged = provider?.models_json !== modelsJson;
    const selectionChanged = settings.default_selection_json !== selectionJson;
    if (!modelsChanged && !selectionChanged) return;
    db.transaction(() => {
      if (modelsChanged)
        db.prepare(
          `INSERT INTO llm_providers(id,name,protocol,base_url,timeout_ms,revision,models_json,credential_json,created_at_utc,updated_at_utc)
        VALUES('hosted','可用模型','openai-compatible','https://hosted.invalid',120000,1,?,NULL,?,?)
        ON CONFLICT(id) DO UPDATE SET models_json=excluded.models_json,updated_at_utc=excluded.updated_at_utc`,
        ).run(modelsJson, now, now);
      if (selectionChanged)
        db.prepare(
          "UPDATE llm_settings SET default_selection_json=? WHERE id=1",
        ).run(selectionJson);
    })();
  }
  async disconnect(userId: string): Promise<void> {
    const runtime = await this.runtimes.get(userId);
    if (!runtime) return;
    runtime.registry.close();
    // User HTTP sockets are closed by the outer server. Stop further discovery;
    // the gateway independently checks account state before every dispatch.
    runtime.composition.scheduler.stop();
    await runtime.composition.temporalTaskScheduler.dispose();
    await runtime.composition.proactiveTaskScheduler.dispose();
    await runtime.composition.routeServices.achievements.pause();
  }
  async resume(userId: string): Promise<void> {
    const runtime = await this.get(userId);
    if (this.options.startSchedulers !== false) {
      runtime.composition.scheduler.start();
      runtime.composition.routeServices.achievements.start();
      await runtime.composition.temporalTaskScheduler.start();
      await runtime.composition.proactiveTaskScheduler.start();
    }
  }
  async quiesce(): Promise<void> {
    for (const pending of this.runtimes.values()) {
      const { composition } = await pending;
      composition.scheduler.stop();
      await composition.temporalTaskScheduler.dispose();
      await composition.proactiveTaskScheduler.dispose();
      await composition.routeServices.achievements.pause();
    }
    const deadline = Date.now() + 240000;
    for (;;) {
      const runtimes = await Promise.all(this.runtimes.values());
      if (
        runtimes.every(
          (runtime) =>
            runtime.composition.routeServices.actors.activeActors === 0,
        )
      )
        return;
      if (Date.now() > deadline)
        throw new HostedError(
          409,
          "runtime_busy",
          "后台任务尚未完成，请稍后备份。",
        );
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  async resumeAll(): Promise<void> {
    for (const userId of this.runtimes.keys())
      if (this.options.control.getUser(userId)?.status === "active")
        await this.resume(userId);
  }
  async close(): Promise<void> {
    this.closing = true;
    const runtimes = await Promise.allSettled([...this.runtimes.values()]);
    for (const result of runtimes)
      if (result.status === "fulfilled") {
        result.value.registry.close();
        await result.value.composition.dispose("fastify_close");
      }
    this.runtimes.clear();
  }
  get size(): number {
    return this.runtimes.size;
  }
}
