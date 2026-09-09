import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  LoaderCircle,
  PlugZap,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  LlmProbeResult,
  LlmProbeStage,
  LlmTarget,
} from "@personasim/contracts";
import { llmApi } from "../../api/llm";
import { ApiError } from "../../api/types";

function ProbeStage({ label, stage }: { label: string; stage: LlmProbeStage }) {
  const Icon =
    stage.status === "success"
      ? CheckCircle2
      : stage.status === "failed"
        ? XCircle
        : Circle;
  return (
    <div className={`model-probe__stage model-probe__stage--${stage.status}`}>
      <Icon size={17} aria-hidden="true" />
      <div>
        <strong>
          {label}：
          {stage.status === "success"
            ? "通过"
            : stage.status === "failed"
              ? "未通过"
              : "未执行"}
        </strong>
        {stage.error ? <p>{stage.error}</p> : null}
      </div>
      {stage.status !== "skipped" ? (
        <span>{(stage.latencyMs / 1000).toFixed(2)} 秒</span>
      ) : null}
    </div>
  );
}

export function ModelProbeResult({ result }: { result: LlmProbeResult }) {
  const Icon =
    result.status === "success"
      ? CheckCircle2
      : result.status === "partial"
        ? AlertTriangle
        : XCircle;
  return (
    <section
      className={`model-probe__result model-probe__result--${result.status}`}
      role="status"
      aria-live="polite"
      aria-label="模型测试结果"
    >
      <header>
        <Icon size={22} aria-hidden="true" />
        <strong>
          {result.status === "success"
            ? "测试通过"
            : result.status === "partial"
              ? "模型能回复，但结构化测试未通过"
              : "测试失败"}
        </strong>
      </header>
      <p className="model-probe__meta">
        <span>{result.modelId}</span>
        <time dateTime={result.testedAt}>
          {new Date(result.testedAt).toLocaleString("zh-CN")}
        </time>
      </p>
      <ProbeStage label="短回复" stage={result.text} />
      <ProbeStage label="结构化输出" stage={result.structured} />
      {result.text.reply ? (
        <blockquote>实际回复：“{result.text.reply}”</blockquote>
      ) : null}
      {result.status === "success" ? (
        <p className="model-probe__note">
          此结果仅验证当前模型和配置的短回复与结构化输出能力。
        </p>
      ) : null}
    </section>
  );
}

/** Parents remount on configuration changes; cleanup aborts both saved-result reads and running probes. */
export function ModelProbe({
  target,
  disabled = false,
  compact = false,
}: {
  target: LlmTarget;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [result, setResult] = useState<LlmProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const initial = useRef(target);
  useEffect(() => {
    const saved = initial.current;
    const abort = new AbortController();
    const ticket = sequence.current;
    if (saved.providerId && saved.modelId && !saved.draft) {
      void llmApi
        .latestTest(saved.providerId, saved.modelId, abort.signal)
        .then(({ result: previous }) => {
          if (
            !abort.signal.aborted &&
            ticket === sequence.current &&
            previous &&
            previous.configRevision === saved.revision
          )
            setResult(previous);
        })
        .catch(() => {
          /* A history-read failure must not block a new explicit test. */
        });
    }
    return () => {
      abort.abort();
      controller.current?.abort();
      sequence.current += 1;
    };
  }, []);
  useEffect(() => {
    if (startedAt === null) return;
    const tick = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => window.clearInterval(tick);
  }, [startedAt]);
  const start = async () => {
    if (controller.current || disabled) return;
    const abort = new AbortController();
    controller.current = abort;
    const ticket = ++sequence.current;
    setResult(null);
    setError(null);
    setElapsed(0);
    setStartedAt(Date.now());
    try {
      const value = await llmApi.test(target, abort.signal);
      if (ticket === sequence.current && !abort.signal.aborted)
        setResult(value);
    } catch (cause) {
      if (ticket === sequence.current && !abort.signal.aborted)
        setError(
          cause instanceof ApiError
            ? cause.message
            : "测试请求未完成，请检查本地服务后重试。",
        );
    } finally {
      if (ticket === sequence.current) {
        controller.current = null;
        setStartedAt(null);
      }
    }
  };
  const cancel = () => {
    sequence.current += 1;
    controller.current?.abort();
    controller.current = null;
    setStartedAt(null);
    setError("测试已取消，未得到完整验证结果。");
  };
  return (
    <div className={`model-probe${compact ? " model-probe--compact" : ""}`}>
      <div className="model-probe__actions">
        <button
          type="button"
          className="button button--secondary"
          disabled={disabled || startedAt !== null}
          onClick={() => void start()}
        >
          {startedAt !== null ? (
            <LoaderCircle className="spin" size={16} aria-hidden="true" />
          ) : (
            <PlugZap size={16} aria-hidden="true" />
          )}
          {startedAt !== null ? `正在测试 · ${elapsed} 秒` : "测试连接与回复"}
        </button>
        {startedAt !== null ? (
          <button type="button" className="text-button" onClick={cancel}>
            取消测试
          </button>
        ) : null}
        {!result && startedAt === null && !error ? (
          <span className="model-probe__unverified">
            {compact ? "未验证" : "未验证 · 测试最多发出两次短请求"}
          </span>
        ) : null}
      </div>
      {startedAt !== null ? (
        <p className="model-probe__progress" role="status">
          正在依次验证短回复和结构化输出；每项最长 120 秒。
        </p>
      ) : null}
      {error ? (
        <div
          className="model-probe__result model-probe__result--failed"
          role="alert"
        >
          <XCircle size={19} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      {result ? <ModelProbeResult result={result} /> : null}
    </div>
  );
}
