import { useEffect, useState } from "react";
import { Check, ImagePlus } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AchievementImageSettings,
  AchievementImageSettingsInput,
} from "@personasim/contracts";
import { achievementsApi } from "../../api/achievements";
import { achievementQueryKeys } from "../../hooks/useAchievements";
import { ErrorBlock, LoadingBlock } from "../Feedback";

type FormState = Pick<
  AchievementImageSettings,
  "enabled" | "protocol" | "baseUrl" | "model"
>;
function inputState(settings: AchievementImageSettings): FormState {
  return {
    enabled: settings.enabled,
    protocol: settings.protocol,
    baseUrl: settings.baseUrl,
    model: settings.model,
  };
}

export function BadgeImageSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: achievementQueryKeys.imageSettings,
    queryFn: achievementsApi.imageSettings,
    refetchOnWindowFocus: false,
  });
  const [form, setForm] = useState<FormState>();
  const [apiKey, setApiKey] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  useEffect(() => {
    if (query.data && !form) setForm(inputState(query.data));
  }, [query.data, form]);
  const save = useMutation({
    mutationFn: (input: AchievementImageSettingsInput) =>
      achievementsApi.saveImageSettings(input),
    onSuccess: (settings) => {
      setApiKey("");
      setClearApiKey(false);
      setForm(inputState(settings));
      queryClient.setQueryData(achievementQueryKeys.imageSettings, settings);
      void queryClient.invalidateQueries({
        queryKey: achievementQueryKeys.all,
      });
    },
  });
  const test = useMutation({ mutationFn: achievementsApi.testImageSettings });
  const dirty = Boolean(
    form &&
    query.data &&
    (JSON.stringify(form) !== JSON.stringify(inputState(query.data)) ||
      apiKey ||
      clearApiKey),
  );
  const change = (patch: Partial<FormState>) => {
    setForm((previous) => (previous ? { ...previous, ...patch } : previous));
    save.reset();
    test.reset();
  };
  return (
    <section
      className="settings-document badge-image-settings"
      aria-labelledby="badge-image-settings-title"
    >
      <div className="settings-section">
        <div className="settings-section__title">
          <ImagePlus size={20} />
          <div>
            <h2 id="badge-image-settings-title">徽章生图模型</h2>
            <p>为特别的相处时刻，绘制带有角色特色的专属纪念。</p>
          </div>
        </div>
        {query.isPending ? (
          <LoadingBlock label="正在读取徽章生图设置…" />
        ) : null}
        {query.error ? <ErrorBlock error={query.error} /> : null}
        {form ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              test.reset();
              save.mutate({
                ...form,
                baseUrl: form.baseUrl.trim(),
                model: form.model.trim(),
                ...(apiKey ? { apiKey } : {}),
                ...(clearApiKey ? { clearApiKey: true } : {}),
              });
            }}
          >
            <div className="settings-preference">
              <div className="settings-preference__copy">
                <h3 id="badge-enabled-label">绘制专属徽章</h3>
                <p>
                  获得特别纪念后，在后台生成图案。绘制完成前会先展示基础徽章。
                </p>
              </div>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={form.enabled}
                aria-labelledby="badge-enabled-label"
                disabled={save.isPending}
                onClick={() => change({ enabled: !form.enabled })}
              >
                <span />
              </button>
            </div>
            <fieldset
              disabled={save.isPending}
              className="badge-image-settings__fields"
            >
              <div className="field-grid field-grid--two">
                <label className="field">
                  <span>图片接口协议</span>
                  <select
                    value={form.protocol}
                    onChange={(event) =>
                      change({
                        protocol: event.target.value as FormState["protocol"],
                      })
                    }
                  >
                    <option value="openai-compatible">
                      OpenAI 兼容 Images API
                    </option>
                    <option value="gemini">Gemini 原生接口</option>
                    {form.protocol === "fixture" ? (
                      <option value="fixture" disabled>
                        本地测试生成器
                      </option>
                    ) : null}
                  </select>
                </label>
                <label className="field">
                  <span>模型名称</span>
                  <input
                    value={form.model}
                    required={form.enabled}
                    onChange={(event) => change({ model: event.target.value })}
                    placeholder="填写供应商提供的图片模型名称"
                    autoComplete="off"
                  />
                </label>
                <label className="field field--full">
                  <span>供应商地址</span>
                  <input
                    type="url"
                    value={form.baseUrl}
                    required={form.enabled && form.protocol !== "fixture"}
                    onChange={(event) =>
                      change({ baseUrl: event.target.value })
                    }
                    placeholder={
                      form.protocol === "gemini"
                        ? "https://generativelanguage.googleapis.com/v1beta"
                        : "https://api.openai.com/v1"
                    }
                    autoComplete="off"
                  />
                </label>
                <label className="field field--full">
                  <span>
                    API 密钥
                    {query.data?.apiKeyConfigured ? "（已保存，留空保留）" : ""}
                  </span>
                  <input
                    type="password"
                    value={apiKey}
                    disabled={clearApiKey}
                    autoComplete="new-password"
                    placeholder={
                      query.data?.apiKeyConfigured
                        ? "输入新密钥以替换"
                        : "输入生图服务的 API 密钥"
                    }
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      save.reset();
                      test.reset();
                    }}
                  />
                </label>
              </div>
              {query.data?.apiKeyConfigured ? (
                <label className="badge-image-settings__clear">
                  <input
                    type="checkbox"
                    checked={clearApiKey}
                    onChange={(event) => {
                      setClearApiKey(event.target.checked);
                      if (event.target.checked) setApiKey("");
                      save.reset();
                      test.reset();
                    }}
                  />
                  移除已保存的生图密钥
                </label>
              ) : null}
            </fieldset>
            <p className="badge-image-settings__note">
              密钥加密保存在本地服务端。此设置独立于对话模型；测试会生成一张图片，并产生供应商用量。
            </p>
            <div className="badge-image-settings__footer">
              {save.isSuccess && !dirty ? (
                <span className="save-success">
                  <Check size={15} />
                  已保存
                </span>
              ) : null}
              <button
                type="button"
                className="button button--secondary"
                disabled={
                  test.isPending ||
                  save.isPending ||
                  dirty ||
                  !query.data?.enabled
                }
                onClick={() => test.mutate()}
              >
                {test.isPending ? "正在测试绘图…" : "测试已保存配置"}
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={save.isPending || test.isPending}
              >
                {save.isPending ? "保存中…" : "保存生图设置"}
              </button>
            </div>
            {save.error ? <ErrorBlock error={save.error} /> : null}
            {test.error ? <ErrorBlock error={test.error} /> : null}
            {test.data ? (
              <p
                role="status"
                className={
                  test.data.success
                    ? "save-success"
                    : "badge-image-settings__note"
                }
              >
                {test.data.message ??
                  (test.data.success
                    ? "图片生成成功，配置可以使用。"
                    : "图片生成未完成，请检查配置。")}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
    </section>
  );
}
