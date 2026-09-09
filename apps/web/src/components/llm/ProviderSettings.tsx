import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBeforeUnload, useBlocker, useSearchParams } from "react-router-dom";
import {
  Check,
  Eye,
  EyeOff,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  LlmProviderInputSchema,
  type LlmModelSettings,
  type LlmProtocol,
  type LlmProviderInput,
  type LlmProviderView,
} from "@personasim/contracts";
import { llmApi, llmCatalogKey } from "../../api/llm";
import { ErrorBlock, LoadingBlock } from "../Feedback";
import {
  mergeDiscoveredModels,
  newModel,
  protocolLabels,
  protocolUrls,
  providerDraft,
  sameSelection,
  withThinkingBudget,
  withThinkingEffort,
  withThinkingLevel,
} from "../../lib/llmSettings";
import { ModelSelect } from "./ModelSelect";
import { ModelProbe } from "./ModelProbe";
import { ApiError } from "../../api/types";

interface EditorHandle {
  save: () => Promise<boolean>;
  discard: () => void;
}

export function ProviderSettings() {
  const client = useQueryClient();
  const [params] = useSearchParams();
  const catalog = useQuery({
    queryKey: llmCatalogKey,
    queryFn: llmApi.catalog,
    refetchOnWindowFocus: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(
    params.get("provider"),
  );
  const [dirty, setDirty] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const editor = useRef<EditorHandle | null>(null);
  const blocker = useBlocker(dirty);
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const providers = catalog.data?.providers ?? [];
  const id = selectedId ?? providers[0]?.id ?? "new";
  const provider = providers.find((item) => item.id === id);
  const blocked = blocker.state === "blocked" || pendingAction !== null;
  useBeforeUnload((event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  useEffect(() => {
    if (blocked) dialog.current?.showModal();
    else dialog.current?.close();
  }, [blocked]);
  const select = (next: string) => {
    if (next === id) return;
    if (dirty)
      setPendingAction(() => () => {
        setSelectedId(next);
        setDirty(false);
      });
    else setSelectedId(next);
  };
  const proceed = () => {
    pendingAction?.();
    setPendingAction(null);
    if (blocker.state === "blocked") blocker.proceed();
  };
  const cancel = () => {
    setSaveError("");
    setPendingAction(null);
    if (blocker.state === "blocked") blocker.reset();
  };
  const defaultMutation = useMutation({
    mutationFn: llmApi.setDefault,
    onSuccess: (value) => {
      client.setQueryData(llmCatalogKey, value);
      void client.invalidateQueries({ queryKey: ["llm", "session"] });
      setNotice(
        "全局默认模型已更新，新会话、跟随默认的会话和后台任务将使用此模型。",
      );
    },
  });
  const refresh = async (saved?: LlmProviderView) => {
    await client.invalidateQueries({ queryKey: llmCatalogKey });
    await client.invalidateQueries({ queryKey: ["llm", "session"] });
    if (saved) setSelectedId(saved.id);
  };
  return (
    <section className="provider-settings" aria-label="语言模型设置">
      <div className="provider-settings__heading">
        <div>
          <span className="provider-settings__eyebrow">MODEL PROVIDERS</span>
          <h2>让对话连接你的模型</h2>
          <p>管理供应商与模型，为每段对话选择合适的声音。</p>
        </div>
        <ShieldCheck size={26} aria-hidden="true" />
      </div>
      {catalog.isPending ? <LoadingBlock label="正在读取模型配置…" /> : null}
      {catalog.isError ? <ErrorBlock error={catalog.error} /> : null}
      {catalog.data ? (
        <>
          <div className="provider-default">
            <div>
              <h3>全局默认模型</h3>
              <p>用于跟随默认的会话、角色生成和后台任务。</p>
            </div>
            <ModelSelect
              label="全局默认模型"
              providers={providers}
              value={catalog.data.defaultSelection}
              disabled={defaultMutation.isPending}
              onChange={(selection) => {
                if (
                  selection &&
                  !sameSelection(selection, catalog.data.defaultSelection)
                ) {
                  setNotice("");
                  defaultMutation.mutate(selection);
                }
              }}
            />
          </div>
          {notice ? (
            <p className="llm-notice" role="status">
              <Check size={16} aria-hidden="true" />
              {notice}
            </p>
          ) : null}
          {defaultMutation.isError ? (
            <ErrorBlock error={defaultMutation.error} />
          ) : null}
          <div className="provider-layout">
            <aside className="provider-list" aria-label="供应商列表">
              <div className="provider-list__heading">
                <h3>供应商</h3>
                <span>{providers.length}</span>
              </div>
              <button
                type="button"
                className="button button--secondary button--wide"
                onClick={() => select("new")}
              >
                <Plus size={16} aria-hidden="true" />
                添加供应商
              </button>
              <div className="provider-list__items">
                {providers.map((item) => (
                  <button
                    type="button"
                    className={`provider-list__item${item.id === id ? " is-selected" : ""}`}
                    aria-current={item.id === id ? "true" : undefined}
                    onClick={() => select(item.id)}
                    key={item.id}
                  >
                    <Server size={18} aria-hidden="true" />
                    <span>
                      <strong>{item.name}</strong>
                      <small>{protocolLabels[item.protocol]}</small>
                      <small>
                        {item.models.length} 个模型
                        {item.source === "environment" ? " · 环境配置" : ""}
                      </small>
                    </span>
                    {catalog.data.defaultSelection.providerId === item.id ? (
                      <span className="provider-list__default">默认</span>
                    ) : null}
                  </button>
                ))}
              </div>
              <p className="provider-list__hint">
                配置保存在本机后端。API Key 加密保存，不写入浏览器存储。
              </p>
            </aside>
            <ProviderEditor
              key={id}
              ref={editor}
              provider={provider}
              isDefault={
                catalog.data.defaultSelection.providerId === provider?.id
              }
              onDirtyChange={setDirty}
              onSaved={refresh}
              onRemoved={() => {
                setSelectedId(null);
                setDirty(false);
                void refresh();
              }}
            />
          </div>
        </>
      ) : null}
      <dialog
        ref={dialog}
        className="llm-dialog"
        aria-labelledby="llm-unsaved-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!saving) cancel();
        }}
      >
        <h2 id="llm-unsaved-title">保存当前配置？</h2>
        <p>当前供应商有未保存的修改。你可以保存后继续，或放弃本次修改。</p>
        {saveError ? (
          <p className="provider-credential-error" role="alert">
            {saveError}
          </p>
        ) : null}
        <div className="llm-dialog__actions">
          <button
            className="button button--quiet"
            disabled={saving}
            onClick={cancel}
          >
            继续编辑
          </button>
          <button
            className="button button--secondary"
            disabled={saving}
            onClick={() => {
              editor.current?.discard();
              setDirty(false);
              proceed();
            }}
          >
            放弃修改
          </button>
          <button
            className="button button--primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setSaveError("");
              void editor.current
                ?.save()
                .then((saved) => {
                  if (saved) proceed();
                  else
                    setSaveError(
                      "配置尚未保存。请选择“继续编辑”查看并修正表单中的错误。",
                    );
                })
                .finally(() => setSaving(false));
            }}
          >
            {saving ? "保存中…" : "保存并继续"}
          </button>
        </div>
      </dialog>
    </section>
  );
}

function ProviderEditor({
  provider,
  isDefault,
  onSaved,
  onRemoved,
  onDirtyChange,
  ref,
}: {
  provider: LlmProviderView | undefined;
  isDefault: boolean;
  onSaved: (value?: LlmProviderView) => Promise<void>;
  onRemoved: () => void;
  onDirtyChange: (value: boolean) => void;
  ref: Ref<EditorHandle>;
}) {
  const [draft, setDraft] = useState(() => providerDraft(provider));
  const [baseline, setBaseline] = useState(() =>
    JSON.stringify(providerDraft(provider)),
  );
  const [savedProvider, setSavedProvider] = useState(provider);
  const [modelId, setModelId] = useState(provider?.models[0]?.id ?? "");
  const [manualModel, setManualModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const [validation, setValidation] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<string | null>(null);
  const [discoveredAt, setDiscoveredAt] = useState(provider?.discoveredAt);
  const discoveryRequest = useRef<AbortController | null>(null);
  const discoverySequence = useRef(0);
  const readOnly = !!savedProvider && savedProvider.source !== "managed";
  const dirty = !readOnly && JSON.stringify(draft) !== baseline;
  const model = draft.models.find((item) => item.id === modelId);
  const shownProvider: LlmProviderView = {
    id: savedProvider?.id ?? "draft",
    source: "managed",
    hasApiKey: savedProvider?.hasApiKey ?? false,
    credentialStatus: "ready",
    referencedSessions: savedProvider?.referencedSessions ?? 0,
    revision: savedProvider?.revision ?? 1,
    ...draft,
  };
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(
    () => () => {
      discoveryRequest.current?.abort();
      discoverySequence.current += 1;
    },
    [],
  );
  const edit = (next: LlmProviderInput) => {
    discoverySequence.current += 1;
    discoveryRequest.current?.abort();
    setDiscovering(false);
    setDraft(next);
    setEditVersion((value) => value + 1);
    setNotice("");
    setValidation([]);
    setError(null);
  };
  const changeModel = (next: LlmModelSettings) =>
    edit({
      ...draft,
      models: draft.models.map((item) => (item.id === modelId ? next : item)),
    });
  const save = async () => {
    if (saving) return false;
    const parsed = LlmProviderInputSchema.safeParse(draft);
    if (!parsed.success) {
      setValidation(
        parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}：${issue.message}`,
        ),
      );
      return false;
    }
    setSaving(true);
    setError(null);
    setValidation([]);
    try {
      const saved = savedProvider
        ? await llmApi.update(savedProvider.id, parsed.data)
        : await llmApi.create(parsed.data);
      const next = providerDraft(saved);
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setSavedProvider(saved);
      setShowKey(false);
      setEditVersion((value) => value + 1);
      setNotice("配置已保存。保存不会自动调用模型。");
      onDirtyChange(false);
      await onSaved(saved);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    const next = providerDraft(savedProvider);
    edit(next);
    setBaseline(JSON.stringify(next));
    setShowKey(false);
    onDirtyChange(false);
  };
  useImperativeHandle(ref, () => ({ save, discard }));
  const target = {
    ...(savedProvider
      ? { providerId: savedProvider.id, revision: savedProvider.revision }
      : {}),
    ...(!savedProvider || dirty ? { draft } : {}),
    ...(modelId ? { modelId } : {}),
  };
  const discover = async () => {
    if (discovering) return;
    if (!readOnly && !LlmProviderInputSchema.safeParse(draft).success) {
      setValidation(["请先填写供应商名称和有效的 API 地址，再检测模型。"]);
      return;
    }
    const abort = new AbortController();
    discoveryRequest.current = abort;
    const ticket = ++discoverySequence.current;
    setDiscovering(true);
    setDiscovery(null);
    setError(null);
    try {
      const value = await llmApi.discover(target, abort.signal);
      if (ticket !== discoverySequence.current || abort.signal.aborted) return;
      if (!readOnly) {
        const models = mergeDiscoveredModels(draft.models, value.models);
        const next = { ...draft, models };
        setDraft(next);
        if (savedProvider && !dirty) {
          const updated = {
            ...savedProvider,
            models,
            discoveredAt: value.discoveredAt,
          };
          setSavedProvider(updated);
          setBaseline(JSON.stringify(next));
          await onSaved(updated);
          if (ticket !== discoverySequence.current || abort.signal.aborted)
            return;
        }
        if (!modelId) setModelId(models[0]?.id ?? "");
        setEditVersion((current) => current + 1);
      }
      setDiscoveredAt(value.discoveredAt);
      setDiscovery(
        `发现 ${value.models.length} 个模型，尚未验证回复能力${readOnly ? "。复制为可编辑配置后可保存更多模型。" : savedProvider && !dirty ? "。模型列表已更新。" : "。保存配置后可在对话中选择。"}`,
      );
    } catch (cause) {
      if (ticket === discoverySequence.current && !abort.signal.aborted)
        setDiscovery(
          `${cause instanceof ApiError ? cause.message : "模型列表暂不可用"}。已保留现有模型，可手动添加模型 ID 后测试回复。`,
        );
    } finally {
      if (ticket === discoverySequence.current) {
        setDiscovering(false);
        discoveryRequest.current = null;
      }
    }
  };
  return (
    <form
      className="provider-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="provider-editor__heading">
        <div>
          <h3>{savedProvider ? savedProvider.name : "添加供应商"}</h3>
          <p>
            {readOnly
              ? "环境来源为只读配置。复制后即可在这里编辑。"
              : "填写 API 地址与凭据，选择你想使用的模型。"}
          </p>
        </div>
        {dirty ? <span className="provider-editor__dirty">未保存</span> : null}
      </header>
      {readOnly ? (
        <div className="provider-readonly">
          <span>
            {savedProvider?.source === "fixture"
              ? "离线演示不发出真实供应商请求。添加供应商后即可接入云端或本地模型。"
              : "密钥由后端复制，不会返回浏览器。"}
          </span>
          {savedProvider?.source === "environment" ? (
            <button
              className="button button--secondary"
              type="button"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void llmApi
                  .importEnvironment(savedProvider.id)
                  .then((value) => onSaved(value))
                  .catch(setError)
                  .finally(() => setSaving(false));
              }}
            >
              复制为可编辑配置
            </button>
          ) : null}
        </div>
      ) : null}
      {savedProvider?.credentialStatus === "unavailable" ? (
        <div className="provider-credential-error" role="alert">
          <p>
            已保存的凭据当前无法解密。请通过实例恢复工具提供原主密钥；如果原密钥无法找回，可重置全部供应商凭据后重新填写。
          </p>
          <button
            className="button button--quiet"
            type="button"
            disabled={saving}
            onClick={() => {
              if (
                !window.confirm(
                  "重置全部供应商的已保存凭据？所有供应商都需要重新填写 API Key；供应商配置和聊天数据会保留。如果有原主密钥，请先使用实例恢复工具恢复。",
                )
              )
                return;
              setSaving(true);
              void llmApi
                .resetCredentials()
                .then(async (catalog) => {
                  const next = catalog.providers.find(
                    (item) => item.id === savedProvider.id,
                  );
                  setSavedProvider(next);
                  if (next) {
                    const nextDraft = providerDraft(next);
                    setDraft(nextDraft);
                    setBaseline(JSON.stringify(nextDraft));
                    setEditVersion((value) => value + 1);
                    onDirtyChange(false);
                  }
                  await onSaved(next);
                })
                .catch(setError)
                .finally(() => setSaving(false));
            }}
          >
            重置供应商凭据
          </button>
        </div>
      ) : null}
      <fieldset
        className="provider-editor__fields"
        disabled={readOnly || saving}
      >
        <div className="field-grid field-grid--two">
          <label className="field">
            <span>供应商名称</span>
            <input
              value={draft.name}
              maxLength={120}
              autoComplete="off"
              placeholder="例如：我的供应商"
              onChange={(event) => edit({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>接口类型</span>
            <select
              value={draft.protocol}
              onChange={(event) => {
                const protocol = event.target.value as LlmProtocol;
                edit({
                  ...draft,
                  protocol,
                  baseUrl: Object.values(protocolUrls).includes(draft.baseUrl)
                    ? protocolUrls[protocol]
                    : draft.baseUrl,
                });
              }}
            >
              {Object.entries(protocolLabels)
                .filter(([value]) => value !== "fixture")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>API 地址</span>
          <input
            aria-label="API 地址"
            aria-describedby="provider-api-url-hint"
            type="url"
            value={draft.baseUrl}
            placeholder={protocolUrls[draft.protocol]}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              edit({ ...draft, baseUrl: event.target.value })
            }
          />
          <small id="provider-api-url-hint">
            支持 HTTPS，以及本机或局域网 HTTP 地址。示例：
            {protocolUrls[draft.protocol]}
          </small>
        </label>
        <div className="field">
          <label htmlFor="provider-api-key">API Key</label>
          <div className="provider-key">
            <input
              id="provider-api-key"
              type={showKey ? "text" : "password"}
              value={draft.apiKey ?? ""}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                savedProvider?.hasApiKey
                  ? "已保存；输入新值可替换"
                  : "无需鉴权的服务可留空"
              }
              onChange={(event) =>
                edit({
                  ...draft,
                  apiKey: event.target.value,
                  clearApiKey: false,
                })
              }
            />
            <button
              className="icon-button"
              type="button"
              aria-label={showKey ? "隐藏新密钥" : "显示新密钥"}
              onClick={() => setShowKey((current) => !current)}
            >
              {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          {savedProvider?.hasApiKey ? (
            <label className="provider-clear-key">
              <input
                type="checkbox"
                checked={draft.clearApiKey ?? false}
                onChange={(event) =>
                  edit({
                    ...draft,
                    apiKey: "",
                    clearApiKey: event.target.checked,
                  })
                }
              />
              保存时清除已存密钥
            </label>
          ) : null}
        </div>
      </fieldset>
      <div className="provider-model-heading">
        <div>
          <h4>模型</h4>
          <p>检测列表后选择，或直接添加模型 ID。</p>
        </div>
        <button
          className="button button--secondary"
          type="button"
          disabled={
            discovering || saving || savedProvider?.source === "fixture"
          }
          onClick={() => void discover()}
        >
          {discovering ? "正在检测…" : "检测模型"}
        </button>
        {discovering ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              discoverySequence.current += 1;
              discoveryRequest.current?.abort();
              setDiscovering(false);
              setDiscovery("检测已取消，保留现有模型列表。");
            }}
          >
            取消检测
          </button>
        ) : null}
      </div>
      {discovery ? (
        <p className="provider-discovery" role="status">
          {discovery}
        </p>
      ) : null}
      {discoveredAt ? (
        <p className="provider-discovery-time">
          上次获取列表：{new Date(discoveredAt).toLocaleString("zh-CN")}
        </p>
      ) : null}
      <div className="provider-model-select">
        <ModelSelect
          label="当前配置模型"
          providers={[shownProvider]}
          value={modelId ? { providerId: shownProvider.id, modelId } : null}
          disabled={saving}
          onChange={(selection) => setModelId(selection?.modelId ?? "")}
        />
        {model && !readOnly ? (
          <button
            className="icon-button"
            type="button"
            aria-label="从配置中移除此模型"
            disabled={saving}
            onClick={() => {
              if (
                !window.confirm(
                  `从供应商配置中移除 ${modelId}？引用该模型的会话需重新选择。`,
                )
              )
                return;
              const models = draft.models.filter((item) => item.id !== modelId);
              edit({ ...draft, models });
              setModelId(models[0]?.id ?? "");
            }}
          >
            <Trash2 size={17} />
          </button>
        ) : null}
      </div>
      {!readOnly ? (
        <div className="provider-manual-model">
          <input
            aria-label="手动模型 ID"
            placeholder="手动输入模型 ID"
            value={manualModel}
            disabled={saving}
            onChange={(event) => setManualModel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                document.getElementById("add-manual-model")?.click();
              }
            }}
          />
          <button
            id="add-manual-model"
            className="button button--quiet"
            type="button"
            disabled={
              !manualModel.trim() || manualModel.trim().length > 250 || saving
            }
            onClick={() => {
              const next = manualModel.trim();
              if (!draft.models.some((item) => item.id === next))
                edit({ ...draft, models: [...draft.models, newModel(next)] });
              setModelId(next);
              setManualModel("");
            }}
          >
            添加模型
          </button>
        </div>
      ) : null}
      <details className="provider-advanced">
        <summary>
          高级设置 <span>请求超时、输出与思考参数</span>
        </summary>
        <fieldset disabled={readOnly || saving}>
          <label className="field">
            <span>供应商请求超时（秒）</span>
            <input
              type="number"
              min={1}
              max={600}
              value={draft.timeoutMs / 1000}
              onChange={(event) =>
                edit({ ...draft, timeoutMs: Number(event.target.value) * 1000 })
              }
            />
          </label>
          {model ? (
            <ModelAdvanced
              model={model}
              protocol={draft.protocol}
              onChange={changeModel}
            />
          ) : (
            <p>添加并选择模型后，可设置模型参数。</p>
          )}
        </fieldset>
      </details>
      <ModelProbe
        key={`${savedProvider?.id ?? "draft"}:${savedProvider?.revision ?? 0}:${modelId}:${editVersion}`}
        target={target}
        disabled={!modelId || saving || savedProvider?.source === "fixture"}
      />
      {validation.length ? (
        <div className="provider-validation" role="alert">
          <strong>请检查以下配置</strong>
          <ul>
            {validation.slice(0, 6).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <ErrorBlock error={error} /> : null}
      {notice ? (
        <p className="llm-notice" role="status">
          <Check size={16} aria-hidden="true" />
          {notice}
        </p>
      ) : null}
      {!readOnly ? (
        <footer className="provider-editor__footer">
          {savedProvider ? (
            <button
              className="text-button provider-delete"
              type="button"
              disabled={saving || isDefault}
              title={
                isDefault ? "请先更换全局默认模型，再删除此供应商" : undefined
              }
              onClick={() => {
                if (
                  !window.confirm(
                    `删除供应商“${savedProvider.name}”？${savedProvider.referencedSessions ? ` 有 ${savedProvider.referencedSessions} 个会话引用此供应商，删除后这些会话需要重新选择模型。` : ""}`,
                  )
                )
                  return;
                setSaving(true);
                void llmApi
                  .remove(savedProvider.id)
                  .then(onRemoved)
                  .catch(setError)
                  .finally(() => setSaving(false));
              }}
            >
              <Trash2 size={16} />
              删除供应商
            </button>
          ) : (
            <span />
          )}
          <div>
            <button
              className="button button--quiet"
              type="button"
              disabled={!dirty || saving}
              onClick={discard}
            >
              取消修改
            </button>
            <button
              className="button button--primary"
              type="submit"
              disabled={saving || (!!savedProvider && !dirty)}
            >
              {saving ? "保存中…" : "保存配置"}
            </button>
          </div>
        </footer>
      ) : null}
      {isDefault && !readOnly ? (
        <p className="provider-footer-note">
          删除此供应商前，请先更换全局默认模型。
        </p>
      ) : null}
    </form>
  );
}

function ModelAdvanced({
  model,
  protocol,
  onChange,
}: {
  model: LlmModelSettings;
  protocol: LlmProtocol;
  onChange: (model: LlmModelSettings) => void;
}) {
  const cap = model.capabilities;
  return (
    <>
      <p className="provider-advanced__model">当前模型：{model.id}</p>
      <div className="field-grid field-grid--two">
        <label className="field">
          <span>结构化输出方式</span>
          <select
            value={cap.structuredOutputMode}
            onChange={(event) =>
              onChange({
                ...model,
                capabilities: {
                  ...cap,
                  structuredOutputMode: event.target
                    .value as typeof cap.structuredOutputMode,
                },
              })
            }
          >
            <option value="prompt_json">提示词 JSON（兼容性优先）</option>
            <option value="native_schema">原生 JSON Schema</option>
            {protocol === "openai-compatible" ? (
              <option value="json_object">JSON Object</option>
            ) : null}
          </select>
        </label>
        <label className="field">
          <span>输出 token 上限</span>
          <input
            type="number"
            min={1}
            max={1000000}
            value={cap.maxOutputTokens ?? ""}
            placeholder="模型默认"
            onChange={(event) => {
              const capabilities = { ...cap };
              if (event.target.value)
                capabilities.maxOutputTokens = Number(event.target.value);
              else delete capabilities.maxOutputTokens;
              onChange({ ...model, capabilities });
            }}
          />
        </label>
        <label className="field">
          <span>上下文 token 上限</span>
          <input
            type="number"
            min={1}
            max={10000000}
            value={cap.maxContextTokens ?? ""}
            placeholder="未指定"
            onChange={(event) => {
              const capabilities = { ...cap };
              if (event.target.value)
                capabilities.maxContextTokens = Number(event.target.value);
              else delete capabilities.maxContextTokens;
              onChange({ ...model, capabilities });
            }}
          />
        </label>
        {protocol === "openai-compatible" ? (
          <label className="field">
            <span>输出 token 字段</span>
            <select
              value={model.tokenParameter}
              onChange={(event) =>
                onChange({
                  ...model,
                  tokenParameter: event.target
                    .value as LlmModelSettings["tokenParameter"],
                })
              }
            >
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">
                max_completion_tokens
              </option>
            </select>
          </label>
        ) : null}
        {protocol !== "gemini" ? (
          <label className="field">
            <span>思考深度</span>
            <select
              value={cap.reasoningEffort ?? ""}
              onChange={(event) => {
                onChange(
                  withThinkingEffort(
                    model,
                    protocol,
                    event.target.value
                      ? (event.target.value as NonNullable<
                          typeof cap.reasoningEffort
                        >)
                      : undefined,
                  ),
                );
              }}
            >
              <option value="">模型默认（不发送参数）</option>
              {["low", "medium", "high", "xhigh", "max"].map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {protocol === "openai-compatible" && cap.reasoningEffort ? (
          <label className="field">
            <span>思考参数格式</span>
            <select
              value={cap.reasoningRequestFormat}
              onChange={(event) =>
                onChange({
                  ...model,
                  capabilities: {
                    ...cap,
                    reasoningRequestFormat: event.target.value as NonNullable<
                      typeof cap.reasoningRequestFormat
                    >,
                  },
                })
              }
            >
              <option value="openai_reasoning_effort">reasoning_effort</option>
              <option value="anthropic_output_config">
                output_config.effort
              </option>
              <option value="openai_reasoning_effort_with_thinking">
                reasoning_effort + thinking
              </option>
            </select>
          </label>
        ) : null}
        {protocol !== "openai-compatible" ? (
          <label className="field">
            <span>思考 token 预算</span>
            <input
              type="number"
              min={protocol === "gemini" ? -1 : 0}
              max={1000000}
              placeholder="模型默认"
              value={model.thinkingBudget ?? ""}
              onChange={(event) => {
                onChange(
                  withThinkingBudget(
                    model,
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                  ),
                );
              }}
            />
            <small>
              {protocol === "gemini"
                ? "-1 自动，0 关闭（需模型支持）。"
                : "0 关闭，启用时通常至少需要 1024 tokens。"}
            </small>
          </label>
        ) : null}
        {protocol === "gemini" ? (
          <label className="field">
            <span>Gemini 思考级别</span>
            <select
              value={model.thinkingLevel ?? ""}
              onChange={(event) => {
                onChange(
                  withThinkingLevel(
                    model,
                    event.target.value
                      ? (event.target.value as NonNullable<
                          LlmModelSettings["thinkingLevel"]
                        >)
                      : undefined,
                  ),
                );
              }}
            >
              <option value="">模型默认</option>
              {["minimal", "low", "medium", "high"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <p className="provider-footer-note">
        参数只作用于当前模型。不同模型支持的思考参数不同，请使用测试确认。
      </p>
    </>
  );
}
