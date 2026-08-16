import {
  Braces,
  Clock3,
  Database,
  Play,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { api, unwrapList } from "../api/client";
import type { CharacterSummary } from "../api/types";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { readActiveCharacter } from "../lib/activeCharacter";

export default function DeveloperPage() {
  const queryClient = useQueryClient();
  const charactersQuery = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  const characters = charactersQuery.data
    ? unwrapList<CharacterSummary>(charactersQuery.data, "characters")
    : [];
  const [agentId, setAgentId] = useState(() => readActiveCharacter() ?? "");
  const activeId = agentId || characters[0]?.id || "";
  const snapshotQuery = useQuery({
    queryKey: ["developer", "snapshot", activeId],
    queryFn: () => api.developer.snapshot(activeId),
    enabled: Boolean(activeId),
  });
  const callsQuery = useQuery({
    queryKey: ["developer", "llm-calls"],
    queryFn: api.developer.llmCalls,
  });
  const [clockInput, setClockInput] = useState(() =>
    DateTime.utc().toFormat("yyyy-LL-dd'T'HH:mm"),
  );
  const [advanceMinutes, setAdvanceMinutes] = useState(60);

  const refresh = () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["developer"] }),
      queryClient.invalidateQueries({ queryKey: ["agent", activeId] }),
    ]);
  };
  const setClock = useMutation({
    mutationFn: () =>
      api.developer.setClock(
        DateTime.fromISO(clockInput, { zone: "utc" }).toISO()!,
      ),
    onSuccess: refresh,
  });
  const advance = useMutation({
    mutationFn: () => api.developer.advanceClock(advanceMinutes),
    onSuccess: refresh,
  });
  const settle = useMutation({
    mutationFn: () => api.developer.settle(activeId),
    onSuccess: refresh,
  });
  const mutationError = setClock.error ?? advance.error ?? settle.error;
  const snapshotJson = useMemo(
    () => JSON.stringify(snapshotQuery.data ?? {}, null, 2),
    [snapshotQuery.data],
  );

  return (
    <div className="page page--developer">
      <PageHeader
        title="开发者"
        description="检查领域状态、模型调用与时间推进；这里不显示密钥或完整敏感 Prompt。"
        actions={
          <button
            className="button button--ghost"
            type="button"
            onClick={refresh}
          >
            <RefreshCw size={16} /> 刷新
          </button>
        }
      />
      {charactersQuery.isPending ? (
        <LoadingBlock label="正在读取开发配置…" />
      ) : null}
      {charactersQuery.isError ? (
        <ErrorBlock error={charactersQuery.error} />
      ) : null}

      <div className="developer-grid">
        <section className="developer-panel developer-panel--clock">
          <div className="developer-panel__heading">
            <Clock3 size={19} />
            <div>
              <h2>FakeClock</h2>
              <p>这些路由只应在 test/dev profile 中注册。</p>
            </div>
          </div>
          <label className="field field--compact">
            <span>角色</span>
            <select
              value={activeId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              {characters.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--compact">
            <span>设置 UTC 时刻</span>
            <input
              type="datetime-local"
              value={clockInput}
              onChange={(event) => setClockInput(event.target.value)}
            />
          </label>
          <button
            className="button button--ghost button--wide"
            type="button"
            disabled={setClock.isPending}
            onClick={() => setClock.mutate()}
          >
            设置时钟
          </button>
          <div className="advance-control">
            <label>
              <span>推进分钟</span>
              <input
                type="number"
                min="1"
                value={advanceMinutes}
                onChange={(event) =>
                  setAdvanceMinutes(Number(event.target.value))
                }
              />
            </label>
            <button
              className="button button--quiet"
              type="button"
              disabled={advance.isPending}
              onClick={() => advance.mutate()}
            >
              <Play size={15} /> 推进
            </button>
          </div>
          <button
            className="button button--primary button--wide"
            type="button"
            disabled={!activeId || settle.isPending}
            onClick={() => settle.mutate()}
          >
            <Database size={15} /> 立即结算角色
          </button>
          {mutationError ? <ErrorBlock error={mutationError} /> : null}
        </section>

        <section className="developer-panel developer-panel--snapshot">
          <div className="developer-panel__heading">
            <Braces size={19} />
            <div>
              <h2>领域快照</h2>
              <p>人格版本、状态、日程、游标与候选消息。</p>
            </div>
          </div>
          {snapshotQuery.isPending ? <LoadingBlock label="读取快照…" /> : null}
          {snapshotQuery.isError ? (
            <ErrorBlock error={snapshotQuery.error} />
          ) : null}
          <pre>{snapshotJson}</pre>
        </section>

        <section className="developer-panel developer-panel--calls">
          <div className="developer-panel__heading">
            <TerminalSquare size={19} />
            <div>
              <h2>最近 LLM 调用</h2>
              <p>只保留 purpose、耗时、token、Provider 与错误码。</p>
            </div>
          </div>
          {callsQuery.isPending ? <LoadingBlock label="读取调用日志…" /> : null}
          {callsQuery.isError ? <ErrorBlock error={callsQuery.error} /> : null}
          <div className="llm-call-list">
            {(callsQuery.data?.calls ?? []).slice(0, 20).map((call, index) => (
              <div key={displayValue(call.id, String(index))}>
                <strong>{displayValue(call.purpose, "unknown")}</strong>
                <span>{displayValue(call.provider, "fixture")}</span>
                <span>{displayValue(call.latencyMs, "—")} ms</span>
                <code>{displayValue(call.status, "ok")}</code>
              </div>
            ))}
            {callsQuery.data?.calls.length === 0 ? (
              <p>还没有模型调用记录。</p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function displayValue(value: unknown, fallback: string): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : fallback;
}
