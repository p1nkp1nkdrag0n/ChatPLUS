import type { MemoryRecallPreviewResponse } from "@personasim/contracts";
import {
  BrainCircuit,
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
import type {
  CharacterSummary,
  RetrievalRun,
  RetrievalRunReplayResponse,
} from "../api/types";
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
  const [recallMessage, setRecallMessage] = useState("");
  const [retrievalRunSelection, setRetrievalRunSelection] = useState("");
  const retrievalRunsQuery = useQuery({
    queryKey: ["developer", "retrieval-runs", activeId],
    queryFn: () => api.developer.retrievalRuns(activeId),
    enabled: Boolean(activeId),
  });
  const retrievalRuns = retrievalRunsQuery.data?.runs ?? [];
  const selectedRetrievalRunId = retrievalRuns.some(
    (run) => run.id === retrievalRunSelection,
  )
    ? retrievalRunSelection
    : (retrievalRuns[0]?.id ?? "");
  const retrievalRunQuery = useQuery({
    queryKey: ["developer", "retrieval-run", selectedRetrievalRunId],
    queryFn: () => api.developer.retrievalRun(selectedRetrievalRunId),
    enabled: Boolean(selectedRetrievalRunId),
  });
  const retrievalReplayQuery = useQuery({
    queryKey: ["developer", "retrieval-run-replay", selectedRetrievalRunId],
    queryFn: () => api.developer.replayRetrievalRun(selectedRetrievalRunId),
    enabled: Boolean(selectedRetrievalRunId),
  });
  const selectedRetrievalRun =
    retrievalRunQuery.data?.run ??
    retrievalRuns.find((run) => run.id === selectedRetrievalRunId);

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
  const recall = useMutation({
    mutationFn: () =>
      api.developer.memoryRecallPreview(activeId, recallMessage.trim()),
    onSuccess: () => {
      setRetrievalRunSelection("");
      void queryClient.invalidateQueries({
        queryKey: ["developer", "retrieval-runs", activeId],
      });
    },
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
              <p>人格版本、状态、变化记录、游标与候选消息。</p>
            </div>
          </div>
          {snapshotQuery.isPending ? <LoadingBlock label="读取快照…" /> : null}
          {snapshotQuery.isError ? (
            <ErrorBlock error={snapshotQuery.error} />
          ) : null}
          <pre>{snapshotJson}</pre>
        </section>

        <section className="developer-panel developer-panel--recall">
          <div className="developer-panel__heading">
            <BrainCircuit size={19} />
            <div>
              <h2>Memory Recall Preview</h2>
              <p>
                Inspect deterministic candidates, evidence, scoring, and
                abstention.
              </p>
            </div>
          </div>
          <form
            className="memory-recall-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (activeId && recallMessage.trim()) recall.mutate();
            }}
          >
            <label className="field">
              <span>Test message</span>
              <textarea
                rows={3}
                value={recallMessage}
                onChange={(event) => setRecallMessage(event.target.value)}
                placeholder="What did we do by the river that night?"
              />
            </label>
            <button
              className="button button--primary"
              type="submit"
              disabled={!activeId || !recallMessage.trim() || recall.isPending}
            >
              {recall.isPending ? "Evaluating..." : "Run recall preview"}
            </button>
          </form>
          {recall.error ? <ErrorBlock error={recall.error} /> : null}
          {recall.data ? (
            <MemoryRecallInspector preview={recall.data} />
          ) : (
            <p className="memory-recall-empty">
              Submit a message to see why each memory was selected or rejected.
            </p>
          )}
        </section>

        <section className="developer-panel developer-panel--recall">
          <div className="developer-panel__heading">
            <BrainCircuit size={19} />
            <div>
              <h2>Retrieval Run Inspector</h2>
              <p>
                Inspect frozen inputs, all pipeline stages, candidate decisions,
                prompt fragments, and deterministic replay.
              </p>
            </div>
          </div>
          {retrievalRunsQuery.isPending ? (
            <LoadingBlock label="Loading retrieval runs..." />
          ) : null}
          {retrievalRunsQuery.isError ? (
            <ErrorBlock error={retrievalRunsQuery.error} />
          ) : null}
          {retrievalRuns.length > 0 ? (
            <label className="field field--compact">
              <span>Recorded run</span>
              <select
                value={selectedRetrievalRunId}
                onChange={(event) =>
                  setRetrievalRunSelection(event.target.value)
                }
              >
                {retrievalRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.createdAtUtc} · {run.result.mode} ·{" "}
                    {run.result.selectedMemoryIds.length} selected
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {selectedRetrievalRunId &&
          retrievalRunQuery.isPending &&
          selectedRetrievalRun === undefined ? (
            <LoadingBlock label="Loading run detail..." />
          ) : null}
          {retrievalRunQuery.isError ? (
            <ErrorBlock error={retrievalRunQuery.error} />
          ) : null}
          {retrievalReplayQuery.isError ? (
            <ErrorBlock error={retrievalReplayQuery.error} />
          ) : null}
          {selectedRetrievalRun ? (
            <RetrievalRunInspector
              run={selectedRetrievalRun}
              replay={retrievalReplayQuery.data}
              replayPending={retrievalReplayQuery.isPending}
            />
          ) : retrievalRunsQuery.isPending ? null : (
            <p className="memory-recall-empty">
              No retrieval runs have been recorded for this character.
            </p>
          )}
        </section>

        <section className="developer-panel developer-panel--calls">
          <div className="developer-panel__heading">
            <TerminalSquare size={19} />
            <div>
              <h2>最近 LLM 调用</h2>
              <p>只保留 purpose、耗时、token、Provider 档案与错误码。</p>
            </div>
          </div>
          {callsQuery.isPending ? <LoadingBlock label="读取调用日志…" /> : null}
          {callsQuery.isError ? <ErrorBlock error={callsQuery.error} /> : null}
          <div className="llm-call-list">
            {(callsQuery.data?.calls ?? []).slice(0, 20).map((call, index) => (
              <div key={displayValue(call.id, String(index))}>
                <strong>{displayValue(call.purpose, "unknown")}</strong>
                <span>
                  {displayValue(call.provider, "fixture")} /{" "}
                  {displayValue(call.providerProfile, "unrecorded")} /{" "}
                  {displayValue(call.model, "unknown")} / effort={""}
                  {displayValue(call.reasoningEffort, "not-configured")}
                </span>
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

function MemoryRecallInspector({
  preview,
}: {
  preview: MemoryRecallPreviewResponse;
}) {
  const evidenceBundle = preview.result.abstained
    ? undefined
    : preview.result.evidenceBundle;
  return (
    <div
      className="memory-recall-inspector"
      data-testid="memory-recall-preview-inspector"
    >
      <div className="memory-recall-summary">
        <div>
          <span>Mode</span>
          <strong>{preview.result.mode}</strong>
        </div>
        <div>
          <span>Score</span>
          <strong>{preview.result.score.toFixed(3)}</strong>
        </div>
        <div>
          <span>Candidates</span>
          <strong>{preview.candidateCount}</strong>
        </div>
        <div>
          <span>Evidence</span>
          <strong>{preview.evidenceCount}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{preview.timing.durationMs.toFixed(1)} ms</strong>
        </div>
      </div>

      {preview.result.abstained ? (
        <div className="memory-recall-abstention" role="status">
          <strong>Recall abstained</strong>
          <span>{preview.result.abstentionReason}</span>
        </div>
      ) : null}

      <section className="memory-recall-section">
        <div className="memory-recall-section__heading">
          <h3>Candidate memories</h3>
          <span>{preview.candidates.length} evaluated</span>
        </div>
        <div className="memory-recall-candidates">
          {preview.candidates.slice(0, 50).map((candidate) => (
            <article key={candidate.memoryId} className="memory-recall-card">
              <header>
                <strong>{candidate.content}</strong>
                <span
                  className={
                    candidate.selected
                      ? "memory-recall-status memory-recall-status--selected"
                      : "memory-recall-status memory-recall-status--rejected"
                  }
                >
                  {candidate.selected ? "selected" : "rejected"}
                </span>
              </header>
              <div className="memory-recall-meta">
                <code>{candidate.namespace}</code>
                <code>{candidate.temporalStatus}</code>
                <span>score {candidate.score.toFixed(3)}</span>
              </div>
              <p>Evidence IDs: {candidate.evidenceIds.join(", ") || "none"}</p>
              {candidate.rejectionReason ? (
                <p>Reason: {candidate.rejectionReason}</p>
              ) : null}
            </article>
          ))}
          {preview.candidates.length === 0 ? (
            <p className="memory-recall-empty">No candidate memories.</p>
          ) : null}
        </div>
      </section>

      <section className="memory-recall-section">
        <div className="memory-recall-section__heading">
          <h3>Final EvidenceBundle</h3>
          <span>{evidenceBundle?.evidence.length ?? 0} selected</span>
        </div>
        {evidenceBundle ? (
          <div className="memory-recall-evidence">
            {evidenceBundle.evidence.map((item) => (
              <article key={item.evidence.id} className="memory-recall-card">
                <strong>{item.memoryContent}</strong>
                <div className="memory-recall-meta">
                  <code>{item.evidence.sourceType}</code>
                  <code>{item.evidence.sourceId}</code>
                  <span>score {item.score.toFixed(3)}</span>
                </div>
                <p>
                  {item.evidence.quote ??
                    item.evidence.contextSummary ??
                    "No evidence excerpt."}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="memory-recall-empty">
            No reliable EvidenceBundle was produced.
          </p>
        )}
      </section>

      {preview.rejections.length > 0 ? (
        <details className="memory-recall-rejections">
          <summary>Rejected items ({preview.rejections.length})</summary>
          <ul>
            {preview.rejections.slice(0, 50).map((rejection) => (
              <li
                key={`${rejection.targetType}:${rejection.targetId}:${rejection.reasonCode}`}
              >
                <code>
                  {rejection.targetType}:{rejection.targetId}
                </code>
                <span>{rejection.reasonCode}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function RetrievalRunInspector({
  run,
  replay,
  replayPending,
}: {
  run: RetrievalRun;
  replay: RetrievalRunReplayResponse | undefined;
  replayPending: boolean;
}) {
  const memoriesById = new Map(
    run.inputSnapshot.memories.map((memory) => [memory.id, memory]),
  );
  const selectedCount = run.candidates.filter(
    (candidate) => candidate.decision === "selected",
  ).length;
  const excludedCount = run.candidates.length - selectedCount;

  return (
    <div
      className="memory-recall-inspector"
      data-testid="retrieval-run-inspector"
    >
      <div className="memory-recall-summary">
        <div>
          <span>Run</span>
          <strong title={run.id}>{run.id}</strong>
        </div>
        <div>
          <span>Mode</span>
          <strong>{run.result.mode}</strong>
        </div>
        <div>
          <span>Selected</span>
          <strong>{selectedCount}</strong>
        </div>
        <div>
          <span>Excluded</span>
          <strong>{excludedCount}</strong>
        </div>
        <div>
          <span>Replay</span>
          <strong>
            {replayPending
              ? "checking"
              : replay === undefined
                ? "unavailable"
                : replay.matchesRecordedResult
                  ? "exact match"
                  : "mismatch"}
          </strong>
        </div>
      </div>

      <section className="memory-recall-section">
        <div className="memory-recall-section__heading">
          <h3>Pipeline stages</h3>
          <span>{run.stages.length} recorded</span>
        </div>
        <div className="memory-recall-candidates">
          {run.stages.map((stage) => (
            <article
              key={stage.ordinal + ":" + stage.name}
              className="memory-recall-card"
            >
              <header>
                <strong>
                  {stage.ordinal + 1}. {stage.name}
                </strong>
                <span
                  className={
                    stage.status === "completed"
                      ? "memory-recall-status memory-recall-status--selected"
                      : "memory-recall-status memory-recall-status--rejected"
                  }
                >
                  {stage.status}
                </span>
              </header>
              <div className="memory-recall-meta">
                <span>input {stage.inputCount ?? "—"}</span>
                <span>output {stage.outputCount ?? "—"}</span>
                <span>{stage.durationMs.toFixed(3)} ms</span>
                {stage.reasonCode ? <code>{stage.reasonCode}</code> : null}
              </div>
              {stage.snapshot === undefined ? null : (
                <JsonDetails label="Stage snapshot" value={stage.snapshot} />
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="memory-recall-section">
        <div className="memory-recall-section__heading">
          <h3>Candidate selection and exclusion</h3>
          <span>
            {selectedCount} selected · {excludedCount} excluded
          </span>
        </div>
        <div className="memory-recall-candidates">
          {run.candidates.map((candidate) => {
            const memory = memoriesById.get(candidate.memoryId);
            return (
              <article key={candidate.memoryId} className="memory-recall-card">
                <header>
                  <strong>{memory?.content ?? candidate.memoryId}</strong>
                  <span
                    className={
                      candidate.decision === "selected"
                        ? "memory-recall-status memory-recall-status--selected"
                        : "memory-recall-status memory-recall-status--rejected"
                    }
                  >
                    {candidate.decision}
                    {candidate.selectionRank
                      ? " #" + candidate.selectionRank
                      : ""}
                  </span>
                </header>
                <div className="memory-recall-meta">
                  <code>{candidate.namespace}</code>
                  <span>score {candidate.score.toFixed(6)}</span>
                  <code>{candidate.reasonCode}</code>
                </div>
                <p>
                  Evidence IDs:{" "}
                  {candidate.evidenceIds.length === 0
                    ? "none"
                    : candidate.evidenceIds.map((evidenceId, index) => (
                        <span key={evidenceId}>
                          {index > 0 ? ", " : null}
                          <a href={`#${sourceAnchorId(evidenceId)}`}>
                            {evidenceId}
                          </a>
                        </span>
                      ))}
                </p>
                <p>
                  Breakdown: lexical{" "}
                  {candidate.scoreBreakdown.lexical.toFixed(3)}, tag{" "}
                  {candidate.scoreBreakdown.tag.toFixed(3)}, importance{" "}
                  {candidate.scoreBreakdown.importance.toFixed(3)}, recency{" "}
                  {candidate.scoreBreakdown.recency.toFixed(3)}, temporal{" "}
                  {candidate.scoreBreakdown.temporal.toFixed(3)}, namespace{" "}
                  {candidate.scoreBreakdown.namespace.toFixed(3)}, semantic{" "}
                  {candidate.semanticScore?.toFixed(3) ?? "n/a"}, relationship{" "}
                  {candidate.relationshipScore?.toFixed(3) ?? "n/a"}
                </p>
                {candidate.reasonSummary ? (
                  <p>{candidate.reasonSummary}</p>
                ) : null}
              </article>
            );
          })}
          {run.candidates.length === 0 ? (
            <p className="memory-recall-empty">No candidates were generated.</p>
          ) : null}
        </div>
      </section>

      <section className="memory-recall-section">
        <div className="memory-recall-section__heading">
          <h3>Source evidence</h3>
          <span>{run.inputSnapshot.evidence.length} frozen sources</span>
        </div>
        <div className="memory-recall-candidates">
          {run.inputSnapshot.evidence.map((evidence) => (
            <article
              id={sourceAnchorId(evidence.id)}
              key={evidence.id}
              className="memory-recall-card"
            >
              <header>
                <strong>
                  {evidence.quote ?? evidence.contextSummary ?? evidence.id}
                </strong>
                <code>{evidence.sourceType}</code>
              </header>
              <div className="memory-recall-meta">
                <code>{evidence.sourceId}</code>
                <span>{evidence.recordedAtUtc}</span>
                <span>memory {evidence.memoryId}</span>
              </div>
            </article>
          ))}
          {run.inputSnapshot.evidence.length === 0 ? (
            <p className="memory-recall-empty">No frozen source evidence.</p>
          ) : null}
        </div>
      </section>

      <section className="memory-recall-section">
        <div className="memory-recall-section__heading">
          <h3>Frozen diagnostics</h3>
          <span>{run.createdAtUtc}</span>
        </div>
        <JsonDetails
          label="Config snapshot"
          value={run.configSnapshot}
          initiallyOpen
        />
        <details className="memory-recall-rejections" open>
          <summary>Rendered prompt fragment</summary>
          <pre style={COMPACT_JSON_STYLE}>
            {run.renderedPromptFragment ??
              "No evidence fragment was rendered because recall abstained."}
          </pre>
        </details>
        <JsonDetails
          label="Recorded result and EvidenceBundle"
          value={{
            result: run.result,
            evidenceBundle: run.evidenceBundle ?? null,
          }}
        />
        {replayPending ? (
          <LoadingBlock label="Replaying frozen input..." />
        ) : null}
        {replay ? (
          <>
            <div className="memory-recall-card" role="status">
              <strong>Replay comparison</strong>
              <p>
                {replay.matchesRecordedResult
                  ? "Exact match with the recorded result."
                  : "Replay differs from the recorded result."}
              </p>
            </div>
            <JsonDetails
              label="Replay input"
              value={replay.input}
              initiallyOpen
            />
            <JsonDetails label="Replay result" value={replay.result} />
          </>
        ) : null}
      </section>
    </div>
  );
}

function JsonDetails({
  label,
  value,
  initiallyOpen = false,
}: {
  label: string;
  value: unknown;
  initiallyOpen?: boolean;
}) {
  return (
    <details className="memory-recall-rejections" open={initiallyOpen}>
      <summary>{label}</summary>
      <pre style={COMPACT_JSON_STYLE}>
        {JSON.stringify(value, null, 2) ?? String(value)}
      </pre>
    </details>
  );
}

const COMPACT_JSON_STYLE = {
  minHeight: 0,
  maxHeight: 360,
};

function sourceAnchorId(evidenceId: string): string {
  return `retrieval-source-${evidenceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function displayValue(value: unknown, fallback: string): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : fallback;
}
