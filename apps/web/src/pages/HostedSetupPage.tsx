import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  Leaf,
  LoaderCircle,
} from "lucide-react";
import {
  LlmProviderInputSchema,
  type LlmProbeResult,
  type LlmProtocol,
  type LlmProviderInput,
  type LlmProviderView,
  type LlmSelection,
} from "@personasim/contracts";
import { llmApi, llmCatalogKey, userModelSettingsKey } from "../api/llm";
import { hostedApi } from "../api/hosted";
import { ApiError } from "../api/types";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { ModelSelect } from "../components/llm/ModelSelect";
import { ModelAdvanced } from "../components/llm/ProviderSettings";
import { ModelProbeResult } from "../components/llm/ModelProbe";
import { PlatformModelPrice } from "../components/llm/PlatformModelPrice";
import { ModelContextLimits } from "../components/llm/ModelContextLimits";
import {
  mergeDiscoveredModels,
  newModel,
  protocolLabels,
  protocolUrls,
  providerDraft,
} from "../lib/llmSettings";
import {
  DEFAULT_USER_CONTEXT_TOKENS,
  IMAGE_PLATFORM_NOTICE,
  PLATFORM_PROVIDER_ID,
  isUserProvider,
  safeModelSetupError,
  redactModelProbe,
} from "../lib/userModelSettings";
import { apiKeyNoticePath, hasAcceptedApiKeyNotice } from "../lib/apiKeyNotice";

export default function HostedSetupPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const settings = useQuery({
    queryKey: userModelSettingsKey,
    queryFn: llmApi.userSettings,
    staleTime: 30_000,
  });
  const catalog = useQuery({
    queryKey: llmCatalogKey,
    queryFn: llmApi.catalog,
  });
  const prices = useQuery({
    queryKey: ["hosted", "public-models"],
    queryFn: hostedApi.publicModels,
  });
  const [mode, setMode] = useState<"platform" | "user" | null>(() =>
    hasAcceptedApiKeyNotice(location.state, "setup") ? "user" : null,
  );
  const [selection, setSelection] = useState<LlmSelection | null>(null);
  const [draft, setDraft] = useState<LlmProviderInput>(() => ({
    ...providerDraft(),
    name: "我的供应商",
    baseUrl: "",
  }));
  const [saved, setSaved] = useState<LlmProviderView>();
  const [modelId, setModelId] = useState("");
  const [manualId, setManualId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [task, setTask] = useState<
    "discover" | "save" | "test" | "finish" | null
  >(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<LlmProbeResult>();
  const [saveNeedsRecovery, setSaveNeedsRecovery] = useState(false);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const busy = task !== null;
  const blocker = useBlocker(busy);
  useBeforeUnload((event) => {
    if (busy) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  useEffect(() => {
    if (!busy && blocker.state === "blocked") blocker.proceed();
  }, [busy, blocker]);
  useEffect(() => {
    document.title = "首次模型设置 · Dearvale";
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  const edit = (next: LlmProviderInput) => {
    setDraft(next);
    setResult(undefined);
    setError(undefined);
    setNotice("");
  };
  const model = draft.models.find((item) => item.id === modelId);
  const platform =
    catalog.data?.providers.filter(
      (item) => item.id === PLATFORM_PROVIDER_ID,
    ) ?? [];
  const owned = catalog.data?.providers.filter(isUserProvider) ?? [];
  const shown: LlmProviderView = {
    ...draft,
    id: "draft",
    source: "managed",
    revision: 1,
    hasApiKey: !!draft.apiKey || !!saved?.hasApiKey,
    credentialStatus: "ready",
    referencedSessions: 0,
  };
  const connection = () => {
    const parsed = LlmProviderInputSchema.safeParse(draft);
    if (!parsed.success)
      throw new Error(parsed.error.issues[0]?.message ?? "请检查供应商配置。");
    const value = parsed.data;
    if (!value.apiKey?.trim() && !saved?.hasApiKey)
      throw new Error("请填写 API Key。");
    return value;
  };
  const refreshConfiguration = async () => {
    const [, latest] = await Promise.all([
      settings.refetch(),
      catalog.refetch(),
    ]);
    if (!active.current || !latest.isSuccess) return;
    if (saveNeedsRecovery) setRecoveryLoaded(true);
    if (saved) {
      const provider = latest.data.providers.find(
        (item) => item.id === saved.id,
      );
      if (provider) {
        setSaved(provider);
        setDraft(providerDraft(provider));
        setShowKey(false);
        setResult(undefined);
        setError(undefined);
        if (!provider.models.some((item) => item.id === modelId))
          setModelId(provider.models[0]?.id ?? "");
        setNotice("已读取服务端最新供应商配置，请检查后重新测试。");
      }
    }
  };
  const discover = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setTask("discover");
    setError(undefined);
    setNotice("");
    try {
      const value = await llmApi.discover(
        {
          draft: connection(),
          ...(saved ? { providerId: saved.id, revision: saved.revision } : {}),
        },
        abort.signal,
      );
      if (!active.current || abort.signal.aborted) return;
      const found = value.models.map((item) => ({
        ...item,
        capabilities: {
          ...item.capabilities,
          maxContextTokens: DEFAULT_USER_CONTEXT_TOKENS,
        },
      }));
      const models = mergeDiscoveredModels(draft.models, found);
      edit({ ...draft, models });
      if (!modelId) setModelId(models[0]?.id ?? "");
      setNotice(
        `检测到 ${value.models.length} 个模型。可以选择模型，也可以手动填写模型 ID。`,
      );
    } catch (cause) {
      if (active.current && !abort.signal.aborted) {
        setError(safeModelSetupError(cause, draft.apiKey));
        setNotice("模型列表暂不可用。可手动填写模型 ID 后测试。");
      }
    } finally {
      inFlight.current = false;
      if (active.current) setTask(null);
    }
  };
  const finish = async () => {
    if (
      inFlight.current ||
      !settings.data ||
      !mode ||
      (mode === "user" && saveNeedsRecovery)
    )
      return;
    inFlight.current = true;
    setError(undefined);
    setNotice("");
    try {
      let chosen = selection;
      if (mode === "user") {
        if (!model) throw new Error("请先选择模型，或添加模型 ID。");
        const input = connection();
        setTask("save");
        let provider: LlmProviderView;
        try {
          provider = saved
            ? await llmApi.update(saved.id, input)
            : await llmApi.create(input);
        } catch (cause) {
          if (!saved && (!(cause instanceof ApiError) || cause.status >= 500)) {
            setSaveNeedsRecovery(true);
            setRecoveryLoaded(false);
            void catalog.refetch().then((value) => {
              if (active.current && value.isSuccess) setRecoveryLoaded(true);
            });
          }
          throw cause;
        }
        if (!active.current) return;
        setSaved(provider);
        setDraft(providerDraft(provider));
        setShowKey(false);
        void client.invalidateQueries({ queryKey: llmCatalogKey });
        const abort = new AbortController();
        controller.current = abort;
        setTask("test");
        const probe = await llmApi.test(
          { providerId: provider.id, revision: provider.revision, modelId },
          abort.signal,
        );
        if (!active.current || abort.signal.aborted) return;
        setResult(redactModelProbe(probe, input.apiKey));
        if (
          probe.status !== "success" ||
          probe.text.status !== "success" ||
          probe.structured.status !== "success"
        )
          return;
        chosen = { providerId: provider.id, modelId };
      }
      if (!chosen) throw new Error("请选择一个平台模型。");
      setTask("finish");
      const value = await llmApi.completeSetup({
        mode,
        selection: chosen,
        expectedRevision: settings.data.revision,
      });
      if (!active.current) return;
      client.setQueryData(userModelSettingsKey, value);
      void client.invalidateQueries({ queryKey: llmCatalogKey });
      void client.invalidateQueries({ queryKey: ["llm", "session"] });
      void navigate("/welcome", { replace: true });
    } catch (cause) {
      if (active.current) setError(safeModelSetupError(cause, draft.apiKey));
    } finally {
      inFlight.current = false;
      if (active.current) setTask(null);
    }
  };
  return (
    <main className="model-onboarding">
      <Link className="model-onboarding__brand" to="/welcome">
        Dearvale <Leaf size={19} aria-hidden="true" />
      </Link>
      <section
        className={`model-onboarding__panel${mode ? " model-onboarding__panel--form" : ""}`}
      >
        {mode ? (
          <button
            className="text-button model-onboarding__back"
            disabled={busy}
            onClick={() => {
              setMode(null);
              setError(undefined);
              setShowKey(false);
            }}
          >
            <ArrowLeft size={16} /> 返回选择
          </button>
        ) : (
          <span className="model-onboarding__eyebrow">开始之前</span>
        )}
        <h1>
          {mode === "platform"
            ? "选择平台模型"
            : mode === "user"
              ? "连接你自己的模型"
              : "我们需要确定一些设置"}
        </h1>
        <p className="model-onboarding__intro">
          {mode === "platform"
            ? "选择一个模型用于文本功能，之后可以按功能单独调整。"
            : mode === "user"
              ? "填写供应商信息，选择模型，完成一次短回复与结构化测试。"
              : "选择模型的使用方式，之后可以随时在设置中修改。"}
        </p>
        {!mode ? (
          <div className="model-onboarding__choices">
            <button
              className="model-onboarding__choice"
              onClick={() => navigate(apiKeyNoticePath("setup"))}
            >
              <KeyRound size={26} />
              <strong>我有API-KEY</strong>
              <span>连接自己的供应商与模型</span>
              <ArrowRight size={20} />
            </button>
            <button
              className="model-onboarding__choice"
              onClick={() => setMode("platform")}
            >
              <Leaf size={26} />
              <strong>我没有API-KEY</strong>
              <span>选择平台模型，使用平台额度</span>
              <ArrowRight size={20} />
            </button>
          </div>
        ) : null}
        {mode === "platform" ? (
          <>
            {catalog.isPending ? (
              <LoadingBlock label="正在读取平台模型…" />
            ) : null}
            {catalog.error ? <ErrorBlock error={catalog.error} /> : null}
            <ModelSelect
              label="平台模型"
              providers={platform}
              value={selection}
              disabled={busy}
              onChange={setSelection}
            />
            {platform.every((item) => !item.models.length) &&
            !catalog.isPending ? (
              <p role="status">
                平台暂未提供文本模型。可以返回填写自己的 API，或稍后重试。
              </p>
            ) : null}
            <PlatformModelPrice
              model={prices.data?.models.find(
                (item) => item.publicModelId === selection?.modelId,
              )}
            />
            <p className="model-onboarding__note">
              图片生成使用平台图片模型，并消耗平台额度。
            </p>
          </>
        ) : null}
        {mode === "user" ? (
          <>
            {saveNeedsRecovery ? (
              <div className="provider-credential-error" role="alert">
                <p>
                  保存请求的结果暂时无法确认。请刷新供应商列表，选择已经保存的配置后继续测试。
                </p>
                <button
                  className="button button--secondary"
                  disabled={catalog.isFetching}
                  onClick={() => {
                    void catalog.refetch().then((value) => {
                      if (value.isSuccess) setRecoveryLoaded(true);
                    });
                  }}
                >
                  刷新供应商列表
                </button>
                {recoveryLoaded ? (
                  <button
                    className="text-button"
                    onClick={() => {
                      setSaveNeedsRecovery(false);
                      setRecoveryLoaded(false);
                      setError(undefined);
                    }}
                  >
                    列表中没有此配置，重新添加
                  </button>
                ) : null}
              </div>
            ) : null}
            {owned.length ? (
              <label className="field">
                <span>继续使用已有供应商</span>
                <select
                  aria-label="继续使用已有供应商"
                  disabled={busy}
                  value={saved?.id ?? "new"}
                  onChange={(event) => {
                    const provider = owned.find(
                      (item) => item.id === event.target.value,
                    );
                    setSaved(provider);
                    if (provider) {
                      setSaveNeedsRecovery(false);
                      setRecoveryLoaded(false);
                    }
                    edit(
                      provider
                        ? providerDraft(provider)
                        : {
                            ...providerDraft(),
                            name: "我的供应商",
                            baseUrl: "",
                          },
                    );
                    setModelId(provider?.models[0]?.id ?? "");
                    setShowKey(false);
                  }}
                >
                  <option value="new">添加新供应商</option>
                  {owned.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <fieldset className="model-onboarding__fields" disabled={busy}>
              <div className="field-grid field-grid--two">
                <label className="field">
                  <span>供应商名称</span>
                  <input
                    value={draft.name}
                    maxLength={120}
                    onChange={(event) =>
                      edit({ ...draft, name: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>接口类型</span>
                  <select
                    value={draft.protocol}
                    onChange={(event) =>
                      edit({
                        ...draft,
                        protocol: event.target.value as LlmProtocol,
                      })
                    }
                  >
                    {Object.entries(protocolLabels)
                      .filter(([key]) => key !== "fixture")
                      .map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label className="field">
                <span>API URL</span>
                <input
                  type="url"
                  aria-label="API URL"
                  aria-describedby="setup-api-url-hint"
                  placeholder={protocolUrls[draft.protocol]}
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.baseUrl}
                  onChange={(event) =>
                    edit({ ...draft, baseUrl: event.target.value })
                  }
                />
                <small id="setup-api-url-hint">
                  填写公网 HTTPS 接口根地址，例如 {protocolUrls[draft.protocol]}
                </small>
              </label>
              <div className="field">
                <label htmlFor="setup-api-key">API Key</label>
                <div className="provider-key">
                  <input
                    id="setup-api-key"
                    autoComplete="off"
                    spellCheck={false}
                    type={showKey ? "text" : "password"}
                    value={draft.apiKey ?? ""}
                    placeholder={
                      saved?.hasApiKey
                        ? "已配置密钥；留空保留"
                        : "填写供应商 API Key"
                    }
                    onChange={(event) =>
                      edit({ ...draft, apiKey: event.target.value })
                    }
                  />
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
              <div className="model-onboarding__detect">
                <h2>选择模型</h2>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => void discover()}
                >
                  {task === "discover" ? "正在检测…" : "检测模型"}
                </button>
              </div>
              <ModelSelect
                label="我的模型"
                providers={[shown]}
                value={modelId ? { providerId: "draft", modelId } : null}
                disabled={busy}
                onChange={(value) => {
                  setModelId(value?.modelId ?? "");
                  setResult(undefined);
                }}
              />
              <div className="provider-manual-model">
                <input
                  aria-label="手动模型 ID"
                  placeholder="也可手动输入模型 ID"
                  value={manualId}
                  maxLength={250}
                  onChange={(event) => setManualId(event.target.value)}
                />
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={!manualId.trim()}
                  onClick={() => {
                    const id = manualId.trim();
                    if (!draft.models.some((item) => item.id === id))
                      edit({
                        ...draft,
                        models: [...draft.models, newModel(id)],
                      });
                    setModelId(id);
                    setManualId("");
                    setResult(undefined);
                  }}
                >
                  添加模型
                </button>
              </div>
              {model ? (
                <>
                  <label className="field">
                    <span>上下文预算（token）</span>
                    <input
                      type="number"
                      aria-label="上下文预算（token）"
                      min={1}
                      max={10000000}
                      value={
                        model.capabilities.maxContextTokens ??
                        DEFAULT_USER_CONTEXT_TOKENS
                      }
                      onChange={(event) =>
                        edit({
                          ...draft,
                          models: draft.models.map((item) =>
                            item.id === modelId
                              ? {
                                  ...item,
                                  capabilities: {
                                    ...item.capabilities,
                                    maxContextTokens: Number(
                                      event.target.value,
                                    ),
                                  },
                                }
                              : item,
                          ),
                        })
                      }
                    />
                    <small>默认 64,000。供应商和应用的实际限制仍然适用。</small>
                  </label>
                  <ModelContextLimits model={model} />
                  <details className="provider-advanced">
                    <summary>
                      高级参数 <span>输出、超时与思考设置</span>
                    </summary>
                    <label className="field">
                      <span>请求超时（秒）</span>
                      <input
                        type="number"
                        min={1}
                        max={600}
                        value={draft.timeoutMs / 1000}
                        onChange={(event) =>
                          edit({
                            ...draft,
                            timeoutMs: Number(event.target.value) * 1000,
                          })
                        }
                      />
                    </label>
                    <ModelAdvanced
                      model={model}
                      protocol={draft.protocol}
                      showContext={false}
                      onChange={(value) =>
                        edit({
                          ...draft,
                          models: draft.models.map((item) =>
                            item.id === modelId ? value : item,
                          ),
                        })
                      }
                    />
                  </details>
                </>
              ) : null}
            </fieldset>
            <p className="model-onboarding__note">{IMAGE_PLATFORM_NOTICE}</p>
            <p className="model-onboarding__privacy">
              URL 与 API Key
              加密保存在你的服务端账号中。测试可能产生供应商用量，不扣平台模型积分。
            </p>
            {result ? <ModelProbeResult result={result} /> : null}
          </>
        ) : null}
        {notice ? (
          <p className="llm-notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          error instanceof Error && !(error instanceof ApiError) ? (
            <p className="provider-credential-error" role="alert">
              {error.message}
            </p>
          ) : (
            <ErrorBlock
              error={error}
              action={
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    void refreshConfiguration();
                  }}
                >
                  重新读取最新配置
                </button>
              }
            />
          )
        ) : null}
        {mode ? (
          <button
            className="button button--primary model-onboarding__submit"
            disabled={
              busy ||
              !settings.data ||
              (mode === "platform" ? !selection : !model || saveNeedsRecovery)
            }
            onClick={() => void finish()}
          >
            {busy ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <ArrowRight size={18} />
            )}
            {task === "test"
              ? "正在测试短回复与结构化输出…"
              : task === "save" || task === "finish"
                ? "正在保存…"
                : mode === "platform"
                  ? "使用此模型并继续"
                  : "测试并完成设置"}
          </button>
        ) : null}
      </section>
      <p className="model-onboarding__footer">
        设置随账号同步，网页与安卓端共用。
      </p>
    </main>
  );
}
