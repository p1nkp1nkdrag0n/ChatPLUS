import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { LlmSelection, LlmSessionModel } from "@personasim/contracts";
import { llmApi, llmCatalogKey } from "../../api/llm";
import { ErrorBlock } from "../Feedback";
import { ModelProbe } from "./ModelProbe";
import { ModelSelect } from "./ModelSelect";

function modelErrorMessage(code?: string): string {
  switch (code?.toLowerCase()) {
    case "credential_unavailable":
      return "当前供应商的 API Key 无法读取，请在模型设置中恢复或重新配置凭据。";
    case "not_found":
      return "所选供应商或模型已不存在，请重新选择模型。";
    case "revision_conflict":
    case "configuration_changed":
      return "模型配置已更新，请重新选择模型以使用最新配置。";
    default:
      return "当前模型不可用，请检查供应商配置或重新选择模型。";
  }
}

export function ChatModelToolbar({
  model,
  disabled,
  onChange,
  notice,
  error,
}: {
  model: LlmSessionModel | undefined;
  disabled: boolean;
  onChange: (selection: LlmSelection | null) => void;
  notice: string;
  error: unknown;
}) {
  const catalog = useQuery({
    queryKey: llmCatalogKey,
    queryFn: llmApi.catalog,
  });
  const effective = model?.effective;
  const provider = catalog.data?.providers.find(
    (item) => item.id === effective?.providerId,
  );
  return (
    <div className="chat-model-toolbar" aria-label="当前会话模型">
      <ModelSelect
        label="会话模型"
        providers={catalog.data?.providers ?? []}
        value={model?.selection ?? null}
        allowDefault
        defaultLabel={effective?.modelId ?? "未配置"}
        disabled={disabled || !catalog.data}
        onChange={onChange}
      />
      {effective ? (
        <ModelProbe
          key={`${effective.providerId}:${effective.modelId}:${effective.revision}`}
          target={effective}
          compact
          disabled={disabled || provider?.source === "fixture"}
        />
      ) : null}
      <Link
        className="text-button chat-model-toolbar__manage"
        to={`/settings${effective ? `?provider=${encodeURIComponent(effective.providerId)}` : ""}`}
      >
        管理模型
      </Link>
      <span className="chat-model-toolbar__scope">仅当前会话</span>
      {notice ? (
        <p className="llm-notice chat-model-toolbar__notice" role="status">
          {notice}
        </p>
      ) : null}
      {model && !effective ? (
        <p
          className="provider-credential-error chat-model-toolbar__notice"
          role="alert"
        >
          {modelErrorMessage(model.error)}
        </p>
      ) : null}
      {error || catalog.error ? (
        <div className="chat-model-toolbar__notice">
          <ErrorBlock error={error ?? catalog.error} />
        </div>
      ) : null}
    </div>
  );
}
