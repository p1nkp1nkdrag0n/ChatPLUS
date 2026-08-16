import { Check, KeyRound, Server, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AppSettings } from "../api/types";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: api.settings.get });
  const [form, setForm] = useState<AppSettings>();
  const mutation = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error("设置尚未加载");
      return api.settings.update(form);
    },
    onSuccess: (value) => {
      setForm(value);
      queryClient.setQueryData(["settings"], value);
    },
  });

  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  return (
    <div className="page page--settings">
      <PageHeader
        title="设置"
        description="模型凭证只保存在本地后端进程中，不会发送到浏览器存储或角色数据库。"
      />
      {query.isPending ? <LoadingBlock label="正在读取本地设置…" /> : null}
      {query.isError ? <ErrorBlock error={query.error} /> : null}
      {form ? (
        <form
          className="settings-document"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <section className="settings-section">
            <div className="settings-section__title">
              <Server size={20} />
              <div>
                <h2>语言模型</h2>
                <p>
                  Fixture 用于零配置演示；兼容 Provider 由本地服务器发起请求。
                </p>
              </div>
            </div>
            <div className="field-grid field-grid--two">
              <label className="field">
                <span>Provider</span>
                <select value={form.llmProvider} disabled>
                  <option value="fixture">Fixture（离线、确定性）</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                </select>
              </label>
              <label className="field">
                <span>模型</span>
                <input value={form.model} readOnly />
              </label>
            </div>
            <label className="field">
              <span>Base URL</span>
              <input value={form.baseUrl} readOnly />
            </label>
            <div className="settings-readonly">
              <span>运行时配置</span>
              <strong>修改根目录 .env 后重启服务生效</strong>
            </div>
            <label className="field">
              <span>API Key</span>
              <div className="secret-field">
                <KeyRound size={17} />
                <input
                  type="password"
                  readOnly
                  value=""
                  placeholder={
                    form.hasApiKey
                      ? "已通过本地环境变量配置"
                      : "请在根目录 .env 中配置后重启"
                  }
                />
              </div>
            </label>
          </section>

          <section className="settings-section">
            <div className="settings-section__title">
              <ShieldCheck size={20} />
              <div>
                <h2>时间与区域</h2>
                <p>所有时刻以 UTC 持久化，再按角色 IANA 时区显示。</p>
              </div>
            </div>
            <div className="field-grid field-grid--two">
              <label className="field">
                <span>界面语言</span>
                <select
                  value={form.locale}
                  onChange={(event) =>
                    setForm({ ...form, locale: event.target.value })
                  }
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </label>
              <label className="field">
                <span>默认角色时区</span>
                <input
                  value={form.defaultTimezone}
                  onChange={(event) =>
                    setForm({ ...form, defaultTimezone: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="settings-readonly">
              <span>当前时钟</span>
              <strong>
                {form.clockMode === "fake"
                  ? "FakeClock（开发配置）"
                  : "系统时间"}
              </strong>
            </div>
          </section>

          <div className="settings-footer">
            <div className="security-note">
              <ShieldCheck size={16} />
              <span>浏览器永远不会直接调用模型 Provider。</span>
            </div>
            {mutation.isSuccess ? (
              <span className="save-success">
                <Check size={15} /> 已保存
              </span>
            ) : null}
            <button
              className="button button--primary"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "保存中…" : "保存设置"}
            </button>
          </div>
          {mutation.isError ? <ErrorBlock error={mutation.error} /> : null}
        </form>
      ) : null}
    </div>
  );
}
