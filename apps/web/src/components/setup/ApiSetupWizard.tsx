import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useBeforeUnload, useBlocker } from "react-router-dom";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  RotateCw,
} from "lucide-react";
import type { LlmCatalog, LlmProtocol } from "@personasim/contracts";
import { llmCatalogKey } from "../../api/llm";
import { useApiSetup } from "../../hooks/useApiSetup";
import { useBookTurn } from "../../hooks/useBookTurn";
import {
  availableSetupProviders,
  validateSetupConnection,
} from "../../lib/apiSetup";
import { protocolLabels, protocolUrls } from "../../lib/llmSettings";
import { MagicBook } from "./MagicBook";
import { SETUP_LABELS, SETUP_STEPS, type SetupStep } from "./setupSteps";

const TITLES: Record<SetupStep, string> = {
  service: "连接你的模型服务",
  key: "写下你的 API Key",
  model: "选择一个对话模型",
  test: "点亮法杖",
  success: "魔法已经准备好了",
};

export default function ApiSetupWizard({
  initialCatalog,
  onComplete,
}: {
  initialCatalog: LlmCatalog;
  onComplete: () => void;
}) {
  const setup = useApiSetup(initialCatalog);
  const { discover, draft } = setup;
  const { motion, turnTo, finishTurn, finishReveal } = useBookTurn();
  const client = useQueryClient();
  const [showKey, setShowKey] = useState(false);
  const [help, setHelp] = useState(false);
  const [fieldError, setFieldError] = useState("");
  const [modelMenu, setModelMenu] = useState(true);
  const [modelSearch, setModelSearch] = useState("");
  const modelInput = useRef<HTMLInputElement>(null);
  const discoveredFor = useRef("");
  const completed = useRef(false);
  const providers = availableSetupProviders(setup.catalog);
  const readyProviders = providers.filter(
    (provider) => provider.credentialStatus === "ready",
  );
  const hasUnreadableCredentials = providers.some(
    (provider) => provider.credentialStatus === "unavailable",
  );
  const repairRequired = hasUnreadableCredentials && !readyProviders.length;
  const existing = setup.selectedProviderId !== "new";
  const locked = motion.phase !== "idle";
  const busy =
    setup.task === "testing" ||
    setup.task === "saving" ||
    setup.task === "recovering";
  const blocker = useBlocker(setup.task === "saving");
  useBeforeUnload((event) => {
    if (setup.task === "saving") {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  useEffect(() => {
    if (blocker.state === "blocked" && setup.task !== "saving")
      blocker.proceed();
  }, [blocker, setup.task]);
  const step = motion.step;
  useEffect(() => {
    document.title = "连接你的模型 · Dearvale";
  }, []);
  useEffect(() => {
    if (step !== "model" || locked || existing) return;
    const key = JSON.stringify([draft.protocol, draft.baseUrl, draft.apiKey]);
    if (discoveredFor.current === key) return;
    discoveredFor.current = key;
    void discover();
  }, [
    step,
    locked,
    existing,
    draft.protocol,
    draft.baseUrl,
    draft.apiKey,
    discover,
  ]);
  useEffect(() => {
    if (!setup.completed || completed.current) return;
    completed.current = true;
    setShowKey(false);
    discoveredFor.current = "";
    client.setQueryData(llmCatalogKey, setup.catalog);
    void client.invalidateQueries({ queryKey: ["llm", "session"] });
    turnTo("success");
  }, [setup.completed, setup.catalog, client, turnTo]);
  const go = (target: SetupStep) => {
    if (locked || busy) return;
    setShowKey(false);
    setFieldError("");
    setup.cancel();
    setup.clearError();
    turnTo(target);
  };
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (locked || busy) return;
    if (step === "service") {
      if (repairRequired || setup.needsRecovery) return;
      if (existing) {
        if (
          !setup.selectedProvider ||
          setup.selectedProvider.credentialStatus !== "ready"
        )
          return;
        go("model");
      } else {
        const error = validateSetupConnection(setup.draft);
        if (error) {
          setFieldError(error);
          return;
        }
        go("key");
      }
    } else if (step === "key") go("model");
    else if (step === "model") {
      if (
        !setup.modelId.trim() ||
        setup.modelId.length > 250 ||
        (existing && !setup.models.some((model) => model.id === setup.modelId))
      ) {
        setFieldError(
          existing
            ? "请选择此连接中已保存的模型。"
            : "请选择或填写模型名称（最多 250 个字符）。",
        );
        return;
      }
      go("test");
    } else if (step === "test") void setup.submit();
    else onComplete();
  };
  const previous = () =>
    go(
      step === "key" || (step === "model" && existing)
        ? "service"
        : step === "model"
          ? "key"
          : "model",
    );
  const updateProtocol = (protocol: LlmProtocol) => {
    const wasDefault = Object.values(protocolUrls).includes(
      setup.draft.baseUrl,
    );
    setup.setDraft({
      protocol,
      ...(wasDefault ? { baseUrl: protocolUrls[protocol] } : {}),
    });
    setFieldError("");
  };
  const error = fieldError || setup.error;
  const modelOptions = setup.models.filter((model) =>
    model.id.toLowerCase().includes(modelSearch.toLowerCase()),
  );
  const progress = Math.min(SETUP_STEPS.indexOf(step), 3);
  const primaryLabel =
    step === "success"
      ? "进入 Dearvale"
      : step !== "test"
        ? "下一步"
        : setup.task === "testing"
          ? "正在测试连接…"
          : setup.task === "saving"
            ? "正在保存配置…"
            : setup.task === "recovering"
              ? "正在读取配置…"
              : setup.canRetryDefault
                ? "重试保存默认模型"
                : "测试并保存";
  return (
    <div className="api-setup" data-testid="api-setup" data-step={step}>
      <header className="setup-header">
        <Link to="/" className="setup-brand">
          <img src="/dearvale/art/botanical.png" alt="" />
          Dearvale
        </Link>
        <Link to="/" className="setup-return">
          返回官网 <ChevronRight size={17} />
        </Link>
      </header>
      <img
        className="setup-botanical setup-botanical--top"
        src="/dearvale/art/botanical.png"
        alt=""
      />
      <img
        className="setup-botanical setup-botanical--bottom"
        src="/dearvale/art/botanical.png"
        alt=""
      />
      <main>
        <div className="setup-intro">
          <h1>
            <span>为故事，</span>
            <span>添一点魔法</span>
          </h1>
          <p>连接你的模型，让这里的故事慢慢苏醒。</p>
        </div>
        <ol className="setup-progress" aria-label="配置进度">
          {SETUP_LABELS.map((label, index) => (
            <li
              key={label}
              className={index <= progress ? "is-active" : ""}
              aria-current={
                index === progress && step !== "success" ? "step" : undefined
              }
            >
              <span className="setup-progress-node">
                {index < progress || step === "success" ? (
                  <Check size={22} aria-label="已完成" />
                ) : (
                  index + 1
                )}
              </span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
        <MagicBook
          motion={motion}
          onTurnEnd={finishTurn}
          onRevealEnd={finishReveal}
        >
          <form onSubmit={next} noValidate aria-busy={locked || busy}>
            <h2 tabIndex={-1} data-step-heading>
              {TITLES[step]}
            </h2>
            {step === "service" ? (
              <>
                <p className="setup-description">
                  先告诉我们，你准备使用哪个模型服务。
                </p>
                {repairRequired ? (
                  <div className="setup-repair" role="alert">
                    <p>
                      已保存的密钥暂时无法读取。请先前往设置恢复凭据，再继续配置。
                    </p>
                    <Link to="/settings">前往设置修复</Link>
                  </div>
                ) : (
                  <>
                    {providers.length ? (
                      <div className="setup-field setup-existing">
                        <div className="setup-existing-label">
                          <label htmlFor="setup-provider">使用已有配置</label>
                          {hasUnreadableCredentials ? (
                            <Link to="/settings">修复不可读取的密钥</Link>
                          ) : null}
                        </div>
                        <select
                          id="setup-provider"
                          value={setup.selectedProviderId}
                          disabled={locked || busy}
                          onChange={(e) => {
                            setup.selectProvider(e.target.value);
                            setModelMenu(false);
                            setFieldError("");
                            setModelSearch("");
                          }}
                        >
                          <option value="new">新建模型连接</option>
                          {providers.map((p) => (
                            <option
                              key={p.id}
                              value={p.id}
                              disabled={p.credentialStatus !== "ready"}
                            >
                              {p.name}
                              {p.credentialStatus !== "ready"
                                ? "（需要修复）"
                                : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    {existing ? (
                      <p className="setup-existing-note">
                        使用已保存的地址和密钥，接下来选择模型并测试连接。
                      </p>
                    ) : (
                      <>
                        <div className="setup-field">
                          <label htmlFor="setup-protocol">接口类型</label>
                          <div className="setup-select-wrap">
                            <select
                              id="setup-protocol"
                              value={setup.draft.protocol}
                              disabled={locked || busy}
                              onChange={(e) =>
                                updateProtocol(e.target.value as LlmProtocol)
                              }
                            >
                              {Object.entries(protocolUrls).map(([value]) => (
                                <option key={value} value={value}>
                                  {protocolLabels[value as LlmProtocol]}
                                </option>
                              ))}
                            </select>
                            <ChevronDown aria-hidden="true" size={20} />
                          </div>
                        </div>
                        <div className="setup-field">
                          <label htmlFor="setup-url">API 地址</label>
                          <input
                            id="setup-url"
                            type="url"
                            autoComplete="off"
                            spellCheck={false}
                            value={setup.draft.baseUrl}
                            disabled={locked || busy}
                            aria-invalid={!!fieldError}
                            onChange={(e) => {
                              setup.setDraft({ baseUrl: e.target.value });
                              setFieldError("");
                            }}
                          />
                          <p className="setup-field-hint">
                            使用中转或本地服务时，请填写服务商提供的 API
                            根地址。
                          </p>
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            ) : null}
            {step === "key" ? (
              <>
                <p className="setup-description">
                  从模型服务商处复制密钥，粘贴在这里。
                </p>
                <div className="setup-field">
                  <label htmlFor="setup-key">API Key</label>
                  <div className="setup-key-field">
                    <input
                      id="setup-key"
                      type={showKey && !locked ? "text" : "password"}
                      autoComplete="off"
                      spellCheck={false}
                      value={setup.draft.apiKey ?? ""}
                      disabled={locked || busy}
                      onChange={(e) =>
                        setup.setDraft({ apiKey: e.target.value })
                      }
                    />
                    <button
                      type="button"
                      aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                      disabled={locked}
                      onClick={() => setShowKey(!showKey)}
                    >
                      {showKey ? <EyeOff size={22} /> : <Eye size={22} />}
                    </button>
                  </div>
                  <button
                    className="setup-text-button"
                    type="button"
                    aria-expanded={help}
                    onClick={() => setHelp(!help)}
                  >
                    不知道在哪里获取？
                  </button>
                  {help ? (
                    <p className="setup-help">
                      打开你使用的模型服务商控制台，在 API
                      密钥页面创建并复制密钥。使用中转服务时，请使用中转服务提供的密钥。无需鉴权的本地服务可留空。
                    </p>
                  ) : null}
                  <p className="setup-key-optional">无需密钥的服务可留空。</p>
                </div>
              </>
            ) : null}
            {step === "model" ? (
              <>
                <p className="setup-description">
                  读取可用模型，或填写服务商提供的模型名称。
                </p>
                <div className="setup-field setup-model-picker">
                  <label htmlFor="setup-model">模型名称</label>
                  <div className="setup-model-input">
                    <input
                      ref={modelInput}
                      id="setup-model"
                      value={setup.modelId}
                      readOnly={existing}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="选择或填写模型名称"
                      maxLength={250}
                      disabled={locked || busy}
                      aria-invalid={!!fieldError}
                      onChange={(e) => {
                        setup.setModelId(e.target.value);
                        setFieldError("");
                        setModelMenu(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setModelMenu(false);
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setModelMenu(true);
                        }
                      }}
                    />
                    <button
                      type="button"
                      aria-label="显示模型列表"
                      aria-expanded={modelMenu}
                      disabled={locked || busy}
                      onClick={() => setModelMenu(!modelMenu)}
                    >
                      <ChevronDown size={22} />
                    </button>
                  </div>
                  {modelMenu && setup.models.length ? (
                    <div className="setup-model-menu">
                      <label className="sr-only" htmlFor="setup-search">
                        搜索模型
                      </label>
                      <input
                        id="setup-search"
                        placeholder="搜索模型…"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                      />
                      <div className="setup-model-options">
                        {modelOptions.length ? (
                          modelOptions.map((model) => (
                            <button
                              type="button"
                              key={model.id}
                              aria-pressed={setup.modelId === model.id}
                              onClick={() => {
                                setup.setModelId(model.id);
                                setModelMenu(false);
                                setFieldError("");
                              }}
                            >
                              {model.id}
                              {setup.modelId === model.id ? (
                                <Check size={16} />
                              ) : null}
                            </button>
                          ))
                        ) : (
                          <p>没有匹配的模型</p>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="setup-model-actions">
                  <button
                    className="setup-button setup-button--small setup-button--outline"
                    type="button"
                    disabled={locked || setup.task !== "idle"}
                    onClick={() => {
                      setModelMenu(true);
                      void setup.discover();
                    }}
                  >
                    {setup.task === "discovering" ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <RotateCw size={18} />
                    )}
                    {existing ? "刷新已保存模型" : "重新读取模型"}
                  </button>
                  {!existing ? (
                    <button
                      type="button"
                      className="setup-text-button"
                      onClick={() => {
                        setup.cancel();
                        setup.clearError();
                        setModelMenu(false);
                        modelInput.current?.focus();
                      }}
                    >
                      手动填写
                    </button>
                  ) : (
                    <Link to="/settings" className="setup-text-button">
                      在设置中添加模型
                    </Link>
                  )}
                </div>
              </>
            ) : null}
            {step === "test" ? (
              <>
                <p className="setup-description">
                  试着唤醒法杖，确认模型可以回应。
                </p>
                <dl className="setup-summary">
                  <div>
                    <dt>接口类型</dt>
                    <dd>{protocolLabels[setup.draft.protocol]}</dd>
                  </div>
                  <div>
                    <dt>API 地址</dt>
                    <dd>{setup.draft.baseUrl}</dd>
                  </div>
                  <div>
                    <dt>模型名称</dt>
                    <dd>{setup.modelId}</dd>
                  </div>
                </dl>
                {setup.probe ? (
                  <div className="setup-probe" role="status">
                    {[
                      ["短回复", setup.probe.text.status],
                      ["结构化输出", setup.probe.structured.status],
                    ].map(([label, status]) => (
                      <div
                        key={label}
                        className={status === "success" ? "is-passed" : ""}
                      >
                        {status === "success" ? (
                          <Check size={19} />
                        ) : (
                          <span aria-hidden="true">○</span>
                        )}
                        <span>
                          {label}测试
                          {status === "success"
                            ? "通过"
                            : status === "skipped"
                              ? "未执行"
                              : "未通过"}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {setup.task === "testing" ? (
                  <p className="setup-test-wait" role="status">
                    正在验证短回复与结构化输出，请稍等…
                  </p>
                ) : null}
              </>
            ) : null}
            {step === "success" ? (
              <>
                <p className="setup-description">
                  模型已连接，故事可以开始了。
                </p>
                <div className="setup-success-checks">
                  <p>
                    <Check aria-hidden="true" />
                    短回复测试通过
                  </p>
                  <p>
                    <Check aria-hidden="true" />
                    结构化输出测试通过
                  </p>
                </div>
                <p className="setup-saved-model">
                  <span>已保存为默认模型</span>
                  <strong>{setup.modelId}</strong>
                </p>
              </>
            ) : null}
            {error && step !== "success" ? (
              <p className="setup-error" role="alert">
                {error}
              </p>
            ) : null}
            {setup.needsRecovery ? (
              <div className="setup-recovery">
                <button
                  type="button"
                  className="setup-text-button"
                  disabled={busy || locked}
                  onClick={() => void setup.recover()}
                >
                  重新读取配置
                </button>
                {step !== "service" ? (
                  <button
                    type="button"
                    className="setup-text-button"
                    disabled={busy || locked}
                    onClick={() => go("service")}
                  >
                    返回连接服务
                  </button>
                ) : (
                  <button
                    type="button"
                    className="setup-text-button"
                    disabled={busy || locked || !setup.recoveryReady}
                    onClick={() => {
                      setup.selectProvider("new");
                      setFieldError("");
                    }}
                  >
                    确认未保存，新建连接
                  </button>
                )}
              </div>
            ) : null}
            {blocker.state === "blocked" ? (
              <p className="setup-test-wait" role="status">
                正在保存，完成后将离开。
              </p>
            ) : null}
            <div
              className={`setup-actions${step === "service" ? " setup-actions--first" : ""}`}
            >
              {step !== "service" && step !== "success" ? (
                <button
                  className="setup-button setup-button--outline"
                  type="button"
                  onClick={previous}
                  disabled={locked || busy}
                >
                  上一步
                </button>
              ) : null}
              <button
                className="setup-button"
                type="submit"
                disabled={
                  locked ||
                  busy ||
                  (step === "service" && repairRequired) ||
                  setup.needsRecovery
                }
              >
                {busy ? <LoaderCircle className="spin" size={19} /> : null}
                {primaryLabel}
              </button>
            </div>
            {setup.task === "testing" ? (
              <button
                type="button"
                className="setup-cancel setup-text-button"
                onClick={() => setup.cancel()}
              >
                取消测试
              </button>
            ) : null}
            {step === "key" ? (
              <p className="setup-footnote">
                <LockKeyhole size={17} aria-hidden="true" />
                密钥保存后不会完整显示。
              </p>
            ) : null}
            {step === "model" ? (
              <p className="setup-footnote">
                更多模型与高级选项，可以稍后在设置中调整。
              </p>
            ) : null}
            {step === "success" ? (
              <p className="setup-footnote">接下来，回到欢迎页。</p>
            ) : null}
          </form>
        </MagicBook>
      </main>
    </div>
  );
}
