import {
  LlmProviderInputSchema,
  normalizeLlmBaseUrl,
  type LlmCatalog,
  type LlmDiscoveryResult,
  type LlmModelSettings,
  type LlmProbeResult,
  type LlmProviderInput,
  type LlmProviderView,
  type LlmSelection,
  type LlmTarget,
} from "@personasim/contracts";
import { ApiError } from "../api/types";
import { newModel, providerDraft } from "./llmSettings";

export function availableSetupProviders(
  catalog: LlmCatalog,
): LlmProviderView[] {
  return catalog.providers.filter(
    (provider) =>
      provider.protocol !== "fixture" && provider.source !== "fixture",
  );
}

export function configuredDefault(catalog: LlmCatalog): boolean {
  return availableSetupProviders(catalog).some(
    (provider) =>
      provider.id === catalog.defaultSelection.providerId &&
      provider.credentialStatus === "ready" &&
      provider.models.some(
        (model) => model.id === catalog.defaultSelection.modelId,
      ),
  );
}

export function newSetupDraft(): LlmProviderInput {
  return { ...providerDraft(), name: "我的模型连接", apiKey: "" };
}

export function validateSetupConnection(
  draft: LlmProviderInput,
): string | null {
  try {
    normalizeLlmBaseUrl(draft.baseUrl, draft.protocol);
    return null;
  } catch {
    return "请填写有效的 HTTP(S) API 根地址，不含密钥或查询参数。";
  }
}

export function probeSucceeded(probe: LlmProbeResult): boolean {
  return (
    probe.status === "success" &&
    probe.text.status === "success" &&
    probe.structured.status === "success"
  );
}

export type ApiSetupTask =
  "idle" | "discovering" | "testing" | "saving" | "recovering";

export interface ApiSetupState {
  catalog: LlmCatalog;
  draft: LlmProviderInput;
  selectedProviderId: string;
  selectedProvider: LlmProviderView | undefined;
  modelId: string;
  models: LlmModelSettings[];
  task: ApiSetupTask;
  error: string | null;
  probe: LlmProbeResult | null;
  completed: boolean;
  needsRecovery: boolean;
  recoveryReady: boolean;
  canRetryDefault: boolean;
}

export interface ApiSetupApi {
  catalog(): Promise<LlmCatalog>;
  discover(
    target: LlmTarget,
    signal?: AbortSignal,
  ): Promise<LlmDiscoveryResult>;
  test(target: LlmTarget, signal?: AbortSignal): Promise<LlmProbeResult>;
  create(input: LlmProviderInput): Promise<LlmProviderView>;
  setDefault(
    selection: LlmSelection,
    expectedRevision?: number,
  ): Promise<LlmCatalog>;
}

function errorMessage(error: unknown, secret: string): string {
  const message =
    error instanceof ApiError
      ? error.message
      : "无法连接服务，请检查网络后重试。";
  return secret.trim()
    ? message.replaceAll(secret.trim(), "••••••••")
    : message;
}

function staleConfiguration(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 409 || error.status === 404)
  );
}

/** The controller owns request sequencing and save stages; the book owns page transitions. */
export function createApiSetupController(
  initialCatalog: LlmCatalog,
  api: ApiSetupApi,
) {
  let newDraft = newSetupDraft();
  let state: ApiSetupState = {
    catalog: initialCatalog,
    draft: newDraft,
    selectedProviderId: "new",
    selectedProvider: undefined,
    modelId: "",
    models: [],
    task: "idle",
    error: null,
    probe: null,
    completed: false,
    needsRecovery: false,
    recoveryReady: false,
    canRetryDefault: false,
  };
  const listeners = new Set<() => void>();
  let sequence = 0;
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tested: { selection: LlmSelection; revision: number } | undefined;

  function publish(patch: Partial<ApiSetupState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  function stopRequest() {
    sequence++;
    active?.abort();
    active = undefined;
    clearTimeout(timer);
    timer = undefined;
  }

  function begin(task: ApiSetupTask, timeoutMs = 30_000) {
    stopRequest();
    const id = sequence;
    active = new AbortController();
    const signal = active.signal;
    publish({ task, error: null });
    // Mutations are allowed to settle, so their outcome cannot be mistaken for a cancelled save.
    if (task === "testing" || task === "discovering") {
      timer = setTimeout(() => {
        if (sequence !== id) return;
        stopRequest();
        publish({
          task: "idle",
          error: "连接等待超时，请检查地址、网络或模型后重试。",
        });
      }, timeoutMs);
    }
    return { id, signal };
  }

  function finish(id: number) {
    if (sequence !== id) return;
    clearTimeout(timer);
    timer = undefined;
    active = undefined;
    publish({ task: "idle" });
  }

  function invalidate() {
    stopRequest();
    tested = undefined;
    publish({
      task: "idle",
      error: null,
      probe: null,
      completed: false,
      canRetryDefault: false,
    });
  }

  function applyCatalog(catalog: LlmCatalog) {
    const provider = availableSetupProviders(catalog).find(
      (entry) => entry.id === state.selectedProviderId,
    );
    publish({
      catalog,
      selectedProvider: provider,
      ...(state.selectedProviderId === "new"
        ? {}
        : {
            draft: provider ? providerDraft(provider) : state.draft,
            models: provider?.models ?? [],
          }),
    });
  }

  async function refreshConflict(id: number) {
    tested = undefined;
    publish({
      probe: null,
      canRetryDefault: false,
      task: "recovering",
      recoveryReady: false,
    });
    try {
      const catalog = await api.catalog();
      if (id !== sequence) return;
      applyCatalog(catalog);
      publish({
        error:
          "配置已在其他页面发生变化。已读取最新配置，请重新选择模型并测试。",
      });
    } catch {
      if (id === sequence)
        publish({
          error: "配置已经变化，读取最新配置失败，请刷新配置后重新测试。",
          needsRecovery: true,
        });
    }
  }

  async function recover() {
    if (state.task !== "idle") return;
    const { id } = begin("recovering");
    publish({ recoveryReady: false });
    try {
      const catalog = await api.catalog();
      if (id !== sequence) return;
      applyCatalog(catalog);
      publish({
        recoveryReady: true,
        error:
          "已重新读取配置。请返回连接服务，选择已保存的配置；确认没有保存后，可明确选择新建连接。",
      });
    } catch {
      if (id === sequence)
        publish({
          error: "暂时无法确认保存结果。请重新读取配置后再继续，避免重复保存。",
        });
    } finally {
      finish(id);
    }
  }

  function getTarget(requireModel: boolean): LlmTarget {
    if (state.selectedProviderId !== "new") {
      const provider = state.selectedProvider;
      if (!provider)
        throw new ApiError({
          status: 404,
          code: "provider_missing",
          message: "该配置已不存在，请返回连接服务重新选择。",
        });
      if (provider.credentialStatus !== "ready")
        throw new ApiError({
          status: 400,
          code: "credentials_unavailable",
          message: "此连接的密钥暂时无法读取，请前往模型设置修复后继续。",
        });
      if (
        requireModel &&
        !provider.models.some((model) => model.id === state.modelId)
      )
        throw new ApiError({
          status: 400,
          code: "model_required",
          message: "请选择此连接中已经保存的模型；添加模型请前往模型设置。",
        });
      return {
        providerId: provider.id,
        revision: provider.revision,
        ...(requireModel ? { modelId: state.modelId } : {}),
      };
    }
    const selectedModel = state.models.find(
      (model) => model.id === state.modelId,
    );
    if (
      requireModel &&
      (!state.modelId.trim() || state.modelId.trim().length > 250)
    )
      throw new ApiError({
        status: 400,
        code: "model_required",
        message: "请先选择或填写模型 ID（最多 250 个字符）。",
      });
    const parsed = LlmProviderInputSchema.safeParse({
      ...state.draft,
      models: requireModel ? [selectedModel ?? newModel(state.modelId)] : [],
    });
    if (!parsed.success)
      throw new ApiError({
        status: 400,
        code: "invalid_configuration",
        message: parsed.error.issues[0]?.message ?? "请检查连接配置。",
      });
    return {
      draft: parsed.data,
      ...(requireModel ? { modelId: state.modelId } : {}),
    };
  }

  async function discover() {
    if (state.task !== "idle" || state.needsRecovery) return;
    const { id, signal } = begin(
      "discovering",
      Math.min(state.draft.timeoutMs, 120_000) + 10_000,
    );
    try {
      const target = getTarget(false);
      if (target.providerId) {
        // Remote discovery on a saved provider mutates its model list; only refresh the saved choices here.
        const catalog = await api.catalog();
        if (id === sequence) applyCatalog(catalog);
      } else {
        const result = await api.discover(target, signal);
        if (id !== sequence) return;
        publish({
          models: result.models,
          ...(result.models.length
            ? {}
            : { error: "服务没有返回模型列表，可以手动填写模型 ID。" }),
        });
      }
    } catch (error) {
      if (id !== sequence) return;
      if (staleConfiguration(error)) await refreshConflict(id);
      else
        publish({
          error:
            `${errorMessage(error, state.draft.apiKey ?? "")} ${state.selectedProviderId === "new" ? "也可以手动填写模型 ID。" : ""}`.trim(),
        });
    } finally {
      finish(id);
    }
  }

  async function saveDefault(id: number) {
    if (!tested) return;
    const snapshot = tested;
    clearTimeout(timer);
    publish({ task: "saving", canRetryDefault: true });
    const catalog = await api.setDefault(snapshot.selection, snapshot.revision);
    if (id !== sequence) return;
    applyCatalog(catalog);
    const provider = catalog.providers.find(
      (entry) => entry.id === snapshot.selection.providerId,
    );
    if (
      !configuredDefault(catalog) ||
      catalog.defaultSelection.providerId !== snapshot.selection.providerId ||
      catalog.defaultSelection.modelId !== snapshot.selection.modelId ||
      provider?.revision !== snapshot.revision
    ) {
      throw new ApiError({
        status: 409,
        code: "model_configuration_changed",
        message: "默认模型与本次测试结果不一致，请重新测试。",
      });
    }
    tested = undefined;
    publish({
      completed: true,
      canRetryDefault: false,
      draft: { ...state.draft, apiKey: "" },
    });
  }

  async function submit() {
    if (state.task !== "idle" || state.completed || state.needsRecovery) return;
    const { id, signal } = begin(
      tested ? "saving" : "testing",
      Math.min(state.draft.timeoutMs, 120_000) * 2 + 15_000,
    );
    let creating = false;
    try {
      if (!tested) {
        const target = getTarget(true);
        const result = await api.test(target, signal);
        if (id !== sequence) return;
        publish({ probe: result });
        if (!probeSucceeded(result)) {
          publish({
            error: errorMessage(
              new ApiError({
                status: 400,
                code: "probe_failed",
                message:
                  result.text.error ??
                  result.structured.error ??
                  "短回复与结构化输出需要全部通过，请修改配置后重试。",
              }),
              state.draft.apiKey ?? "",
            ),
          });
          return;
        }
        if (
          result.modelId !== target.modelId ||
          (target.providerId &&
            (result.providerId !== target.providerId ||
              result.configRevision !== target.revision))
        ) {
          throw new ApiError({
            status: 409,
            code: "model_configuration_changed",
            message: "测试结果与当前配置不一致，请重新测试。",
          });
        }
        clearTimeout(timer);
        if (target.draft) {
          creating = true;
          publish({ task: "saving" });
          const provider = await api.create(target.draft);
          if (id !== sequence) return;
          creating = false;
          newDraft = newSetupDraft();
          publish({
            selectedProviderId: provider.id,
            selectedProvider: provider,
            draft: { ...providerDraft(provider), apiKey: "" },
            models: provider.models,
            catalog: {
              ...state.catalog,
              providers: [
                ...state.catalog.providers.filter(
                  (entry) => entry.id !== provider.id,
                ),
                provider,
              ],
            },
          });
          tested = {
            selection: { providerId: provider.id, modelId: state.modelId },
            revision: provider.revision,
          };
        } else {
          tested = {
            selection: {
              providerId: target.providerId!,
              modelId: state.modelId,
            },
            revision: target.revision!,
          };
        }
      }
      await saveDefault(id);
    } catch (error) {
      if (id !== sequence) return;
      if (creating && (!(error instanceof ApiError) || error.status >= 500)) {
        tested = undefined;
        newDraft = newSetupDraft();
        publish({
          task: "recovering",
          needsRecovery: true,
          recoveryReady: false,
          canRetryDefault: false,
          draft: { ...state.draft, apiKey: "" },
        });
        try {
          const catalog = await api.catalog();
          if (id !== sequence) return;
          applyCatalog(catalog);
          publish({
            recoveryReady: true,
            error:
              "保存结果暂时无法确认。已重新读取配置，请返回连接服务并选择已保存的配置，避免重复创建。",
          });
        } catch {
          if (id === sequence)
            publish({
              error:
                "保存结果暂时无法确认。请重新读取配置后再继续，避免重复创建。",
            });
        }
      } else if (staleConfiguration(error)) {
        await refreshConflict(id);
      } else {
        publish({
          error: tested
            ? `连接已经通过测试，但设置默认模型失败。${errorMessage(error, "")} 点击重试将继续设置默认模型。`
            : errorMessage(error, state.draft.apiKey ?? ""),
        });
      }
    } finally {
      finish(id);
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDraft(patch: Partial<LlmProviderInput>) {
      if (
        state.task === "saving" ||
        state.task === "recovering" ||
        state.selectedProviderId !== "new"
      )
        return;
      invalidate();
      newDraft = { ...newDraft, ...patch };
      publish({
        draft: newDraft,
        ...(patch.baseUrl !== undefined ||
        patch.protocol !== undefined ||
        patch.apiKey !== undefined
          ? { models: [] }
          : {}),
      });
    },
    selectProvider(id: string) {
      if (state.task === "saving" || state.task === "recovering") return;
      if (state.needsRecovery && !state.recoveryReady) return;
      const provider = availableSetupProviders(state.catalog).find(
        (entry) => entry.id === id,
      );
      if (id !== "new" && !provider) return;
      invalidate();
      publish({
        selectedProviderId: id,
        selectedProvider: provider,
        draft: provider ? providerDraft(provider) : newDraft,
        modelId: provider?.models[0]?.id ?? "",
        models: provider?.models ?? [],
        needsRecovery: false,
        recoveryReady: false,
      });
    },
    setModelId(modelId: string) {
      if (state.task === "saving" || state.task === "recovering") return;
      invalidate();
      publish({ modelId: modelId.trim() });
    },
    clearError: () => publish({ error: null }),
    discover,
    submit,
    recover,
    cancel() {
      if (state.task !== "testing" && state.task !== "discovering") return;
      stopRequest();
      publish({ task: "idle", error: "已取消，可以调整配置后重试。" });
    },
    dispose() {
      stopRequest();
      // Strict Mode reconnects effects using this controller. Keep non-secret fields
      // coherent with the snapshot, and notify any subscription that reconnects.
      newDraft = { ...newDraft, apiKey: "" };
      publish({ draft: { ...state.draft, apiKey: "" }, task: "idle" });
    },
  };
}
