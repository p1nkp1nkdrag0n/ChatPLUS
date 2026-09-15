import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LlmPurposeSchema,
  type LlmSelection,
  type UserModelSettingsUpdateInput,
} from "@personasim/contracts";
import { Link } from "react-router-dom";
import { Check, SlidersHorizontal } from "lucide-react";
import { hostedApi } from "../api/hosted";
import { llmApi, llmCatalogKey, userModelSettingsKey } from "../api/llm";
import { PageHeader } from "../components/PageHeader";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { ModelSelect } from "../components/llm/ModelSelect";
import { ProviderSettings } from "../components/llm/ProviderSettings";
import { PlatformModelPrice } from "../components/llm/PlatformModelPrice";
import {
  allTextBindings,
  isUserProvider,
  modelFundingLabel,
  PLATFORM_PROVIDER_ID,
  purposeLabels,
} from "../lib/userModelSettings";

export default function ModelSettingsPage() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: userModelSettingsKey,
    queryFn: llmApi.userSettings,
  });
  const catalog = useQuery({
    queryKey: llmCatalogKey,
    queryFn: llmApi.catalog,
  });
  const prices = useQuery({
    queryKey: ["hosted", "public-models"],
    queryFn: hostedApi.publicModels,
  });
  const [platformSelection, setPlatformSelection] =
    useState<LlmSelection | null>(null);
  const [userSelection, setUserSelection] = useState<LlmSelection | null>(null);
  const [notice, setNotice] = useState("");
  const update = useMutation({
    mutationFn: (
      input: Omit<UserModelSettingsUpdateInput, "expectedRevision">,
    ) => {
      if (!settings.data) throw new Error("模型设置尚未加载");
      return llmApi.updateUserSettings({
        ...input,
        expectedRevision: settings.data.revision,
      });
    },
    onSuccess: (value) => {
      client.setQueryData(userModelSettingsKey, value);
      void client.invalidateQueries({ queryKey: llmCatalogKey });
      void client.invalidateQueries({ queryKey: ["llm", "session"] });
      setNotice("已保存到账号。网页与安卓端的新请求将使用这些设置。");
    },
    onError: () => {
      setNotice("");
    },
  });
  useEffect(() => {
    document.title = "模型与功能 · Dearvale";
  }, []);
  const providers = catalog.data?.providers ?? [];
  const platform = providers.filter((item) => item.id === PLATFORM_PROVIDER_ID);
  const own = providers.filter(isUserProvider);
  const imageModels =
    prices.data?.models.filter((item) => item.kind === "image") ?? [];
  const busy = update.isPending;
  return (
    <div className="page page--settings page--model-settings">
      <PageHeader
        title="模型与功能"
        description="管理你的供应商，为每个功能选择平台模型或自己的模型。设置随账号同步。"
        actions={
          <Link className="button button--secondary" to="/settings">
            返回设置
          </Link>
        }
      />
      <section className="function-model-settings" aria-label="功能模型设置">
        <div className="settings-section__title">
          <SlidersHorizontal size={22} />
          <div>
            <h2>每个功能，选择合适的模型</h2>
            <p>
              未设置时使用平台对应模型并消耗额度。自己的模型失败时会提示错误，由你决定是否切换。
            </p>
          </div>
        </div>
        {settings.isPending || catalog.isPending ? (
          <LoadingBlock label="正在读取功能设置…" />
        ) : null}
        {settings.error || catalog.error ? (
          <ErrorBlock
            error={settings.error ?? catalog.error}
            action={
              <button
                className="text-button"
                onClick={() => {
                  void settings.refetch();
                  void catalog.refetch();
                }}
              >
                重新读取
              </button>
            }
          />
        ) : null}
        {settings.data && catalog.data ? (
          <>
            <div className="function-model-bulk">
              <div>
                <h3>文本功能全部使用平台模型</h3>
                <ModelSelect
                  label="批量平台模型"
                  providers={platform}
                  value={platformSelection}
                  disabled={busy}
                  onChange={setPlatformSelection}
                />
                <button
                  className="button button--secondary"
                  disabled={busy || !platformSelection}
                  onClick={() => {
                    if (platformSelection)
                      update.mutate({
                        bindings: allTextBindings(platformSelection),
                      });
                  }}
                >
                  应用到全部文本功能
                </button>
              </div>
              <div>
                <h3>文本功能全部使用我的模型</h3>
                <ModelSelect
                  label="批量我的模型"
                  providers={own}
                  value={userSelection}
                  disabled={busy || !own.length}
                  onChange={setUserSelection}
                />
                <button
                  className="button button--secondary"
                  disabled={busy || !userSelection}
                  onClick={() => {
                    if (userSelection)
                      update.mutate({
                        bindings: allTextBindings(userSelection),
                      });
                  }}
                >
                  应用我的模型到全部文本功能
                </button>
                {!own.length ? (
                  <a className="text-button" href="#my-providers">
                    先添加自己的供应商
                  </a>
                ) : null}
              </div>
            </div>
            <div className="function-model-list">
              {LlmPurposeSchema.options.map((purpose) => {
                const selected = settings.data.bindings[purpose] ?? null;
                return (
                  <div className="function-model-row" key={purpose}>
                    <div>
                      <h3>{purposeLabels[purpose]}</h3>
                      <p>{modelFundingLabel(selected)}</p>
                    </div>
                    <ModelSelect
                      label={`${purposeLabels[purpose]}模型`}
                      providers={providers}
                      value={selected}
                      allowDefault
                      defaultLabel="平台对应模型 · 消耗额度"
                      defaultOptionLabel="未设置 · 使用平台对应模型（消耗额度）"
                      disabled={busy}
                      onChange={(selection) =>
                        update.mutate({ bindings: { [purpose]: selection } })
                      }
                    />
                  </div>
                );
              })}
              <div className="function-model-row function-model-row--image">
                <div>
                  <h3>图片生成</h3>
                  <p>使用平台图片模型，消耗平台额度。</p>
                </div>
                <label className="field">
                  <span className="sr-only">图片生成模型</span>
                  <select
                    aria-label="图片生成模型"
                    disabled={busy || prices.isPending || !!prices.error}
                    value={settings.data.imageSelection?.modelId ?? ""}
                    onChange={(event) =>
                      update.mutate({
                        bindings: {},
                        imageSelection: event.target.value
                          ? {
                              providerId: PLATFORM_PROVIDER_ID,
                              modelId: event.target.value,
                            }
                          : null,
                      })
                    }
                  >
                    <option value="">平台默认图片模型</option>
                    {settings.data.imageSelection &&
                    !imageModels.some(
                      (item) =>
                        item.publicModelId ===
                        settings.data.imageSelection?.modelId,
                    ) ? (
                      <option value={settings.data.imageSelection.modelId}>
                        当前图片模型暂不可用，请重新选择
                      </option>
                    ) : null}
                    {imageModels.map((item) => (
                      <option
                        key={item.publicModelId}
                        value={item.publicModelId}
                      >
                        {item.displayName}
                      </option>
                    ))}
                  </select>
                  <PlatformModelPrice
                    model={imageModels.find(
                      (item) =>
                        item.publicModelId ===
                        settings.data.imageSelection?.modelId,
                    )}
                  />
                </label>
              </div>
            </div>
            {prices.error ? (
              <ErrorBlock
                error={prices.error}
                action={
                  <button
                    className="text-button"
                    onClick={() => void prices.refetch()}
                  >
                    重新读取图片模型与价格
                  </button>
                }
              />
            ) : null}
            {update.error ? (
              <ErrorBlock
                error={update.error}
                action={
                  <button
                    className="text-button"
                    onClick={() => {
                      void settings.refetch();
                      update.reset();
                    }}
                  >
                    重新读取最新设置
                  </button>
                }
              />
            ) : null}
            {notice ? (
              <p className="llm-notice" role="status">
                <Check size={16} />
                {notice}
              </p>
            ) : null}
          </>
        ) : null}
      </section>
      <div id="my-providers">
        <ProviderSettings />
      </div>
    </div>
  );
}
