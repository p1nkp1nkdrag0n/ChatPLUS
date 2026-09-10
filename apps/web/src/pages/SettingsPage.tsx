import { Check, MessageCircleMore, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { AppSettings } from "../api/types";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { ProviderSettings } from "../components/llm/ProviderSettings";

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
        actions={
          <Link className="button button--secondary" to="/developer">
            开发者工具
          </Link>
        }
        description="配置模型、回复体验与本地偏好。"
      />
      <ProviderSettings />
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
              <MessageCircleMore size={20} />
              <div>
                <h2>回复体验</h2>
                <p>应用于所有会话，保存后从下一条消息生效。</p>
              </div>
            </div>
            <div className="settings-preference">
              <div className="settings-preference__copy">
                <h3 id="reply-goal-review-label">回复目标复核</h3>
                <p id="reply-goal-review-description">
                  发送前，让当前会话的模型结合上下文检查回复是否满足本轮对话目标，必要时重新生成。
                </p>
                <p className="settings-preference__note">
                  默认关闭。开启后会增加等待时间和模型用量；复核未通过时可重试。
                </p>
              </div>
              <button
                className="settings-switch"
                type="button"
                role="switch"
                aria-checked={form.replyGoalReviewEnabled}
                aria-labelledby="reply-goal-review-label"
                aria-describedby="reply-goal-review-description"
                disabled={mutation.isPending}
                onClick={() => {
                  mutation.reset();
                  setForm({
                    ...form,
                    replyGoalReviewEnabled: !form.replyGoalReviewEnabled,
                  });
                }}
              >
                <span />
              </button>
            </div>
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
