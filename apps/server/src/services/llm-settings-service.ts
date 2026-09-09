import { randomInt } from "node:crypto";
import {
  DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES,
  createFixtureLlmProvider,
} from "@personasim/providers";
import {
  LlmModelSettingsSchema,
  LlmProviderInputSchema,
  LlmSelectionSchema,
  normalizeLlmBaseUrl,
  type LlmCatalog,
  type LlmExecutionSelection,
  type LlmModelSettings,
  type LlmProbeResult,
  type LlmProtocol,
  type LlmProviderInput,
  type LlmProviderView,
  type LlmSelection,
  type LlmSessionModel,
  type LlmTarget,
} from "@personasim/contracts";
import { readLlmProfileConfig, type ServerConfig } from "../config.js";
import type { DatabaseStore } from "../db/store.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import type { Clock } from "../runtime/clock.js";
import { LlmCredentialService } from "./llm-credential-service.js";

export interface ResolvedLlmConfiguration {
  selection: LlmExecutionSelection;
  protocol: LlmProtocol | "fixture";
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  model: LlmModelSettings;
  profileName: string;
  legacyConfig?: ServerConfig["llm"];
}
interface ProviderRow {
  id: string;
  name: string;
  protocol: LlmProtocol;
  base_url: string;
  timeout_ms: number;
  revision: number;
  models_json: string;
  credential_json: string | null;
  discovered_at_utc: string | null;
}
interface EnvironmentEntry {
  view: LlmProviderView;
  config: ServerConfig["llm"];
}

export class LlmSettingsService {
  private readonly credentials: LlmCredentialService;
  private readonly environment = new Map<string, EnvironmentEntry>();
  private readonly fallback: LlmSelection;
  constructor(
    private readonly store: DatabaseStore,
    config: ServerConfig,
    private readonly clock: Clock,
  ) {
    this.credentials = new LlmCredentialService(
      store.database,
      config.databasePath,
    );
    const active = this.addEnvironment(config.llm);
    this.fallback = { providerId: active.id, modelId: active.models[0]!.id };
    // Read only recognized profile names; no environment values are serialized or logged.
    for (const key of Object.keys(process.env)) {
      const match = /^LLM_PROFILE_(.+)_BASE_URL$/u.exec(key);
      if (!match?.[1]) continue;
      try {
        this.addEnvironment(readLlmProfileConfig(match[1].toLowerCase()));
      } catch {
        /* Invalid inactive profiles never prevent startup. */
      }
    }
  }

  catalog(): LlmCatalog {
    const managed = (
      this.store.database
        .prepare("SELECT * FROM llm_providers ORDER BY created_at_utc,id")
        .all() as ProviderRow[]
    ).map((row) => this.view(row));
    return {
      providers: [...this.environment.values()]
        .map((entry) => this.environmentView(entry))
        .concat(managed),
      defaultSelection: this.defaultSelection(),
    };
  }

  create(raw: LlmProviderInput): LlmProviderView {
    const input = LlmProviderInputSchema.parse(raw);
    const id = createEntityId("llmprovider");
    const key = input.apiKey?.trim();
    const encrypted = key ? this.credentials.encrypt(id, key) : null;
    this.store.database
      .prepare(
        `INSERT INTO llm_providers(id,name,protocol,base_url,timeout_ms,revision,models_json,credential_json,created_at_utc,updated_at_utc) VALUES(?,?,?,?,?,1,?,?,?,?)`,
      )
      .run(
        id,
        input.name,
        input.protocol,
        normalizeLlmBaseUrl(input.baseUrl, input.protocol),
        input.timeoutMs,
        JSON.stringify(input.models),
        encrypted,
        this.clock.nowUtc(),
        this.clock.nowUtc(),
      );
    return this.view(this.row(id));
  }

  update(id: string, raw: LlmProviderInput): LlmProviderView {
    const input = LlmProviderInputSchema.parse(raw);
    this.assertManaged(id);
    return this.store.database.transaction(() => {
      const row = this.row(id);
      this.assertRevision(row.revision, input.expectedRevision);
      const currentDefault = this.defaultSelection();
      if (
        currentDefault.providerId === id &&
        !input.models.some((model) => model.id === currentDefault.modelId)
      )
        throw new ApiError(
          409,
          "default_model_in_use",
          "请先更换系统默认模型，再移除此模型。",
        );
      let encrypted = row.credential_json;
      if (input.clearApiKey) encrypted = null;
      else if (input.apiKey?.trim())
        encrypted = this.credentials.encrypt(id, input.apiKey.trim());
      this.store.database
        .prepare(
          `UPDATE llm_providers SET name=?,protocol=?,base_url=?,timeout_ms=?,models_json=?,credential_json=?,revision=revision+1,discovered_at_utc=NULL,updated_at_utc=? WHERE id=?`,
        )
        .run(
          input.name,
          input.protocol,
          normalizeLlmBaseUrl(input.baseUrl, input.protocol),
          input.timeoutMs,
          JSON.stringify(input.models),
          encrypted,
          this.clock.nowUtc(),
          id,
        );
      this.store.database
        .prepare("DELETE FROM llm_probe_results WHERE provider_id=?")
        .run(id);
      return this.view(this.row(id));
    })();
  }

  delete(id: string): void {
    this.store.database
      .transaction(() => {
        this.assertManaged(id);
        this.row(id);
        if (this.defaultSelection().providerId === id)
          throw new ApiError(
            409,
            "default_provider_in_use",
            "请先更换系统默认供应商。",
          );
        this.store.database
          .prepare("DELETE FROM llm_providers WHERE id=?")
          .run(id);
      })
      .immediate();
    // Explicit session selections remain as invalid references, never silently falling back.
  }

  importEnvironment(id?: string): LlmProviderView {
    const entry = this.environment.get(id ?? this.fallback.providerId);
    if (!entry || entry.view.protocol === "fixture")
      throw new ApiError(
        400,
        "environment_import_unavailable",
        "请选择可复制的环境供应商配置。",
      );
    return this.create({
      name: `${entry.view.name}（副本）`,
      protocol: entry.view.protocol,
      baseUrl: entry.view.baseUrl,
      timeoutMs: entry.view.timeoutMs,
      models: structuredClone(entry.view.models),
      ...(entry.config.apiKey ? { apiKey: entry.config.apiKey } : {}),
    });
  }

  setDefault(raw: LlmSelection): LlmCatalog {
    const selection = LlmSelectionSchema.parse(raw);
    this.store.database
      .transaction(() => {
        this.resolve(selection);
        this.store.database
          .prepare(
            "UPDATE llm_settings SET default_selection_json=? WHERE id=1",
          )
          .run(JSON.stringify(selection));
      })
      .immediate();
    return this.catalog();
  }

  sessionModel(sessionId: string): LlmSessionModel {
    if (!this.store.getSession(sessionId)) throw notFound("Session");
    const row = this.store.database
      .prepare(
        "SELECT selection_json FROM llm_session_models WHERE session_id=?",
      )
      .get(sessionId) as { selection_json: string } | undefined;
    const selection = row
      ? LlmSelectionSchema.parse(JSON.parse(row.selection_json))
      : null;
    try {
      return {
        selection,
        effective: this.resolve(selection ?? undefined).selection,
      };
    } catch (error) {
      return {
        selection,
        effective: null,
        error: error instanceof ApiError ? error.code : "model_unavailable",
      };
    }
  }

  setSessionModel(
    sessionId: string,
    raw: LlmSelection | null,
  ): LlmSessionModel {
    if (!this.store.getSession(sessionId)) throw notFound("Session");
    if (raw === null)
      this.store.database
        .prepare("DELETE FROM llm_session_models WHERE session_id=?")
        .run(sessionId);
    else {
      const selection = LlmSelectionSchema.parse(raw);
      this.resolve(selection);
      this.store.database
        .prepare(
          "INSERT INTO llm_session_models(session_id,selection_json,updated_at_utc) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET selection_json=excluded.selection_json,updated_at_utc=excluded.updated_at_utc",
        )
        .run(sessionId, JSON.stringify(selection), this.clock.nowUtc());
    }
    return this.sessionModel(sessionId);
  }

  resolve(
    raw?: LlmSelection,
    expectedRevision?: number,
  ): ResolvedLlmConfiguration {
    const selection = LlmSelectionSchema.parse(raw ?? this.defaultSelection());
    const environment = this.environment.get(selection.providerId);
    if (environment) {
      this.assertRevision(environment.view.revision, expectedRevision);
      const model = this.model(environment.view.models, selection.modelId);
      return {
        selection: { ...selection, revision: environment.view.revision },
        protocol: environment.view.protocol,
        baseUrl: environment.view.baseUrl,
        apiKey: environment.config.apiKey ?? "",
        timeoutMs: environment.view.timeoutMs,
        model,
        profileName:
          environment.config.profileName ??
          (environment.view.protocol === "fixture" ? "fixture" : "legacy"),
        legacyConfig: structuredClone(environment.config),
      };
    }
    const row = this.row(selection.providerId);
    this.assertRevision(row.revision, expectedRevision);
    const model = this.model(this.models(row), selection.modelId);
    return {
      selection: { ...selection, revision: row.revision },
      protocol: row.protocol,
      baseUrl: row.base_url,
      apiKey:
        row.credential_json === null
          ? ""
          : this.credentials.decrypt(row.id, row.credential_json),
      timeoutMs: row.timeout_ms,
      model,
      profileName: row.id,
    };
  }

  resolveTarget(target: LlmTarget): ResolvedLlmConfiguration {
    if (!target.draft) {
      if (!target.providerId)
        throw new ApiError(400, "provider_required", "请选择供应商。");
      const view = this.catalog().providers.find(
        (entry) => entry.id === target.providerId,
      );
      if (!view) throw notFound("LLM provider");
      const modelId = target.modelId ?? view.models[0]?.id;
      // Discovery does not need a model; create a disposable descriptor for the adapter.
      if (!modelId)
        return this.resolveTarget({
          providerId: target.providerId,
          ...(target.revision === undefined
            ? {}
            : { revision: target.revision }),
          draft: {
            name: view.name,
            protocol:
              view.protocol === "fixture" ? "openai-compatible" : view.protocol,
            baseUrl: view.baseUrl,
            timeoutMs: view.timeoutMs,
            models: [],
          },
          modelId: "discovery",
        });
      return this.resolve(
        { providerId: target.providerId, modelId },
        target.revision,
      );
    }
    const draft = LlmProviderInputSchema.parse(target.draft);
    let apiKey = draft.apiKey?.trim() ?? "";
    let revision = 1;
    if (target.providerId) {
      const env = this.environment.get(target.providerId);
      const row = env ? undefined : this.row(target.providerId);
      revision = env?.view.revision ?? row!.revision;
      this.assertRevision(revision, target.revision ?? draft.expectedRevision);
      if (!draft.clearApiKey && !apiKey)
        apiKey =
          env?.config.apiKey ??
          (row?.credential_json
            ? this.credentials.decrypt(row.id, row.credential_json)
            : "");
    }
    if (draft.clearApiKey) apiKey = "";
    const modelId = target.modelId ?? draft.models[0]?.id ?? "discovery";
    const model =
      draft.models.find((item) => item.id === modelId) ??
      LlmModelSettingsSchema.parse({ id: modelId });
    return {
      selection: {
        providerId: target.providerId ?? "draft",
        modelId,
        revision,
      },
      protocol: draft.protocol,
      baseUrl: normalizeLlmBaseUrl(draft.baseUrl, draft.protocol),
      apiKey,
      timeoutMs: draft.timeoutMs,
      model: structuredClone(model),
      profileName: target.providerId ?? "draft",
    };
  }

  rememberDiscovery(
    id: string,
    revision: number,
    models: LlmModelSettings[],
    time: string,
  ): void {
    if (this.environment.has(id)) return;
    this.store.database.transaction(() => {
      const row = this.row(id);
      this.assertRevision(row.revision, revision);
      const merged = new Map(
        this.models(row).map((model) => [model.id, model]),
      );
      for (const model of models)
        if (!merged.has(model.id))
          merged.set(model.id, LlmModelSettingsSchema.parse(model));
      this.store.database
        .prepare(
          "UPDATE llm_providers SET models_json=?,discovered_at_utc=?,updated_at_utc=? WHERE id=?",
        )
        .run(
          JSON.stringify([...merged.values()].slice(0, 2000)),
          time,
          this.clock.nowUtc(),
          id,
        );
    })();
  }

  rememberProbe(result: LlmProbeResult): void {
    if (
      !result.providerId ||
      result.configRevision === undefined ||
      this.environment.has(result.providerId)
    )
      return;
    this.store.database
      .prepare(
        "INSERT INTO llm_probe_results(provider_id,model_id,revision,result_json) SELECT id,?,?,? FROM llm_providers WHERE id=? AND revision=? ON CONFLICT(provider_id,model_id) DO UPDATE SET revision=excluded.revision,result_json=excluded.result_json",
      )
      .run(
        result.modelId,
        result.configRevision,
        JSON.stringify(result),
        result.providerId,
        result.configRevision,
      );
  }

  latestProbe(providerId: string, modelId: string): LlmProbeResult | undefined {
    const row = this.store.database
      .prepare(
        "SELECT p.result_json FROM llm_probe_results p JOIN llm_providers c ON c.id=p.provider_id AND c.revision=p.revision WHERE p.provider_id=? AND p.model_id=?",
      )
      .get(providerId, modelId) as { result_json: string } | undefined;
    return row ? (JSON.parse(row.result_json) as LlmProbeResult) : undefined;
  }

  resetCredentials(): void {
    this.credentials.reset();
  }
  private row(id: string): ProviderRow {
    const row = this.store.database
      .prepare("SELECT * FROM llm_providers WHERE id=?")
      .get(id) as ProviderRow | undefined;
    if (!row) throw notFound("LLM provider");
    return row;
  }
  private models(row: ProviderRow): LlmModelSettings[] {
    return (JSON.parse(row.models_json) as unknown[]).map((model) =>
      LlmModelSettingsSchema.parse(model),
    );
  }
  private model(models: LlmModelSettings[], id: string): LlmModelSettings {
    const model = models.find((entry) => entry.id === id);
    if (!model)
      throw new ApiError(
        409,
        "model_unavailable",
        "此供应商没有该模型，请重新选择。",
      );
    return structuredClone(model);
  }
  private assertManaged(id: string): void {
    if (this.environment.has(id))
      throw new ApiError(
        409,
        "environment_read_only",
        "环境变量配置为只读，请先复制为可编辑配置。",
      );
  }
  private assertRevision(actual: number, expected?: number): void {
    if (expected !== undefined && actual !== expected)
      throw new ApiError(
        409,
        "model_configuration_changed",
        "供应商配置已更新，请刷新配置后重新发送。",
      );
  }
  private defaultSelection(): LlmSelection {
    const row = this.store.database
      .prepare("SELECT default_selection_json FROM llm_settings WHERE id=1")
      .get() as { default_selection_json: string | null };
    return row.default_selection_json
      ? LlmSelectionSchema.parse(JSON.parse(row.default_selection_json))
      : { ...this.fallback };
  }
  private references(id: string): number {
    return Number(
      (
        this.store.database
          .prepare(
            "SELECT count(*) AS count FROM llm_session_models WHERE json_extract(selection_json,'$.providerId')=?",
          )
          .get(id) as { count: number }
      ).count,
    );
  }
  private view(row: ProviderRow): LlmProviderView {
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      timeoutMs: row.timeout_ms,
      revision: row.revision,
      models: this.models(row),
      source: "managed",
      hasApiKey: row.credential_json !== null,
      credentialStatus:
        row.credential_json === null ||
        this.credentials.available(row.id, row.credential_json)
          ? "ready"
          : "unavailable",
      referencedSessions: this.references(row.id),
      ...(row.discovered_at_utc ? { discoveredAt: row.discovered_at_utc } : {}),
    };
  }
  private environmentView(entry: EnvironmentEntry): LlmProviderView {
    return {
      ...entry.view,
      models: structuredClone(entry.view.models),
      referencedSessions: this.references(entry.view.id),
    };
  }
  private addEnvironment(config: ServerConfig["llm"]): LlmProviderView {
    const fixture = config.provider === "fixture";
    const id = fixture ? "fixture" : `env:${config.profileName ?? "legacy"}`;
    const old = this.environment.get(id);
    if (old) return old.view;
    if (!fixture && config.profileName) {
      const alias = [...this.environment.values()].find(
        (entry) =>
          entry.config.profileName?.toLowerCase().replaceAll("-", "_") ===
          config.profileName!.toLowerCase().replaceAll("-", "_"),
      );
      if (alias) return alias.view;
    }
    const effectiveCapabilities = fixture
      ? createFixtureLlmProvider().capabilities
      : {
          ...(config.capabilities ?? DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES),
          maxOutputTokens: Math.min(
            config.maxOutputTokens ?? 8192,
            config.capabilities?.maxOutputTokens ??
              DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES.maxOutputTokens ??
              64000,
            64000,
          ),
        };
    const model = LlmModelSettingsSchema.parse({
      id: fixture ? "personasim-fixture-v1" : config.model,
      capabilities: effectiveCapabilities,
    });
    const view: LlmProviderView = {
      id,
      name: fixture
        ? "离线演示模型"
        : `环境配置 · ${config.profileName ?? "默认"}`,
      protocol: config.provider,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      revision: randomInt(1, 2147483647),
      models: [model],
      source: fixture ? "fixture" : "environment",
      hasApiKey: Boolean(config.apiKey),
      credentialStatus: "ready",
      referencedSessions: 0,
    };
    this.environment.set(id, { view, config });
    return view;
  }
}
