import {
  Download,
  Eraser,
  FileImage,
  LockKeyhole,
  MapPin,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type {
  KeepsakeSummaryResponse,
  RelationshipArchiveEntry,
  RelationshipShareProjection,
  ShareComposerSelection,
  ShareRedaction,
} from "@personasim/contracts";
import { useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import {
  addRedaction,
  canUseLetterForExcerpt,
  redactForPreview,
  shareEnvelopeLetters,
} from "../../lib/relationshipArchive";
import { exportRelationshipSharePng } from "../../lib/shareExport";
import { SharePreviewCard } from "./ArchivePrimitives";

export function ShareComposer({
  agentId,
  archiveEntries,
  keepsakes,
  initialLetterId,
  initialKeepsakeId,
}: {
  agentId: string;
  archiveEntries: readonly RelationshipArchiveEntry[];
  keepsakes: readonly KeepsakeSummaryResponse[];
  initialLetterId?: string;
  initialKeepsakeId?: string;
}) {
  const envelopeLetters = useMemo(
    () => shareEnvelopeLetters(archiveEntries),
    [archiveEntries],
  );
  const [letterChoice, setLetterChoice] = useState(initialLetterId ?? "");
  const [keepsakeChoice, setKeepsakeChoice] = useState(initialKeepsakeId ?? "");
  const letterChoiceAvailable = envelopeLetters.some(
    (entry) => entry.id === letterChoice,
  );
  const selectedLetterId = letterChoiceAvailable
    ? letterChoice
    : letterChoice.length === 0
      ? (envelopeLetters[0]?.id ?? "")
      : "";
  const requestedLetterUnavailable =
    letterChoice.length > 0 && !letterChoiceAvailable;
  const selectedLetter = envelopeLetters.find(
    (entry) => entry.id === selectedLetterId,
  );
  const excerptAllowed = selectedLetter
    ? canUseLetterForExcerpt(selectedLetter)
    : false;
  const keepsakeChoiceAvailable = keepsakes.some(
    (keepsake) => keepsake.id === keepsakeChoice,
  );
  const selectedKeepsakeId = keepsakeChoiceAvailable
    ? keepsakeChoice
    : keepsakeChoice.length === 0
      ? (keepsakes[0]?.id ?? "")
      : "";
  const requestedKeepsakeUnavailable =
    keepsakeChoice.length > 0 && !keepsakeChoiceAvailable;
  const [includeEnvelope, setIncludeEnvelope] = useState(true);
  const [includePostmark, setIncludePostmark] = useState(true);
  const [includeWaitingDays, setIncludeWaitingDays] = useState(true);
  // A URL/deep-link selection is an explicit keepsake choice. It may be sent
  // for server verification, but is never rendered before the safe projection
  // confirms the item is ready and belongs to this relationship.
  const [includeKeepsake, setIncludeKeepsake] = useState(
    Boolean(initialKeepsakeId),
  );
  const [includeExcerpt, setIncludeExcerpt] = useState(false);
  const [excerpt, setExcerpt] = useState("");
  const [redactions, setRedactions] = useState<ShareRedaction[]>([]);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [projection, setProjection] = useState<RelationshipShareProjection>();
  const [pending, setPending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string>();
  const excerptRef = useRef<HTMLTextAreaElement>(null);

  const resetProjection = () => {
    setProjection(undefined);
    setMessage(undefined);
  };

  const toggleExcerpt = (checked: boolean) => {
    setIncludeExcerpt(checked);
    if (!checked) {
      setExcerpt("");
      setRedactions([]);
      setSelection({ start: 0, end: 0 });
    }
    resetProjection();
  };

  const markSelection = (label: ShareRedaction["label"]) => {
    const next = addRedaction(
      redactions,
      excerpt,
      selection.start,
      selection.end,
      label,
    );
    if (next.length === redactions.length) {
      setMessage("请先在摘录中选择一段未被涂黑的文字。");
      excerptRef.current?.focus();
      return;
    }
    setRedactions(next);
    setMessage(undefined);
    setProjection(undefined);
  };

  const buildPreview = async () => {
    const useLetter = selectedLetterId.length > 0;
    const useKeepsake = includeKeepsake && selectedKeepsakeId.length > 0;
    if (!useLetter && !useKeepsake) {
      setMessage("请至少选择一封可分享的信或一件纪念物。");
      return;
    }
    if (includeExcerpt && !excerptAllowed) {
      setMessage("这封回信尚未启封，只能分享信封、邮戳和等待天数。");
      return;
    }
    if (includeExcerpt && excerpt.trim().length === 0) {
      setMessage("请手动粘贴或输入要分享的正文摘录。");
      excerptRef.current?.focus();
      return;
    }

    const payload: ShareComposerSelection = {
      templateVersion: "relationship-share-v1",
      includeEnvelope: useLetter && includeEnvelope,
      includePostmark: useLetter && includePostmark,
      includeWaitingDays: useLetter && includeWaitingDays,
      includeKeepsake: useKeepsake,
      includeExcerpt: useLetter && includeExcerpt && excerptAllowed,
      redactions:
        useLetter && includeExcerpt && excerptAllowed ? redactions : [],
      ...(useLetter ? { letterId: selectedLetterId } : {}),
      ...(useKeepsake ? { keepsakeId: selectedKeepsakeId } : {}),
      ...(useLetter && includeExcerpt && excerptAllowed ? { excerpt } : {}),
    };

    setPending(true);
    setMessage(undefined);
    try {
      // This local request verifies ownership/open state and returns only the
      // safe projection. The manually entered excerpt never enters query cache.
      setProjection(
        await api.relationshipArchive.previewShare(agentId, payload),
      );
    } catch (error) {
      setProjection(undefined);
      setMessage(error instanceof Error ? error.message : "预览生成失败");
    } finally {
      setPending(false);
    }
  };

  const exportPng = async () => {
    if (!projection) return;
    setExporting(true);
    setMessage(undefined);
    try {
      const filename = await exportRelationshipSharePng(projection);
      setMessage(`已在本机生成 ${filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "PNG 导出失败");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="share-composer">
      <section
        className="share-composer__controls"
        aria-labelledby="share-options-title"
      >
        <div className="share-composer__heading">
          <div>
            <h2 id="share-options-title">自定义分享图</h2>
            <p>只生成本地 PNG，不会上传，也不会创建公开链接。</p>
          </div>
          <LockKeyhole size={20} strokeWidth={1.6} aria-hidden="true" />
        </div>

        <fieldset className="share-composer__sources">
          <legend>选择来源</legend>
          <label>
            <span>信封与邮戳</span>
            <select
              value={selectedLetterId}
              disabled={envelopeLetters.length === 0}
              onChange={(event) => {
                setLetterChoice(event.target.value);
                setIncludeExcerpt(false);
                setExcerpt("");
                setRedactions([]);
                resetProjection();
              }}
            >
              {requestedLetterUnavailable ? (
                <option value="">指定信件不存在或不可分享</option>
              ) : envelopeLetters.length === 0 ? (
                <option value="">暂无可分享信件</option>
              ) : null}
              {envelopeLetters.map((entry) => (
                <option value={entry.id} key={entry.id}>
                  {entry.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>纪念物</span>
            <select
              value={selectedKeepsakeId}
              disabled={!includeKeepsake || keepsakes.length === 0}
              onChange={(event) => {
                setKeepsakeChoice(event.target.value);
                resetProjection();
              }}
            >
              {requestedKeepsakeUnavailable ? (
                <option value="">指定纪念物不存在或不可分享</option>
              ) : keepsakes.length === 0 ? (
                <option value="">暂无纪念物</option>
              ) : null}
              {keepsakes.map((keepsake) => (
                <option value={keepsake.id} key={keepsake.id}>
                  {keepsake.title}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset className="share-composer__toggles">
          <legend>画面内容</legend>
          <ShareToggle
            label="信封样式"
            checked={includeEnvelope}
            disabled={!selectedLetterId}
            onChange={(value) => {
              setIncludeEnvelope(value);
              resetProjection();
            }}
          />
          <ShareToggle
            label="邮戳"
            checked={includePostmark}
            disabled={!selectedLetterId}
            onChange={(value) => {
              setIncludePostmark(value);
              resetProjection();
            }}
          />
          <ShareToggle
            label="等待天数"
            checked={includeWaitingDays}
            disabled={!selectedLetterId}
            onChange={(value) => {
              setIncludeWaitingDays(value);
              resetProjection();
            }}
          />
          <ShareToggle
            label="纪念物"
            checked={includeKeepsake && Boolean(selectedKeepsakeId)}
            disabled={!selectedKeepsakeId}
            onChange={(value) => {
              setIncludeKeepsake(value);
              resetProjection();
            }}
          />
          <ShareToggle
            label="正文摘录（默认关闭）"
            checked={includeExcerpt && excerptAllowed}
            disabled={!selectedLetterId || !excerptAllowed}
            onChange={toggleExcerpt}
          />
        </fieldset>

        {includeExcerpt ? (
          <section
            className="share-composer__excerpt"
            aria-labelledby="excerpt-title"
          >
            <div>
              <h3 id="excerpt-title">手动选择正文摘录</h3>
              <p>
                仅可使用自己寄出的信或已经启封的回信。系统会在生成前再次校验。
              </p>
            </div>
            <label>
              <span className="sr-only">正文摘录</span>
              <textarea
                ref={excerptRef}
                value={excerpt}
                maxLength={500}
                rows={5}
                placeholder="手动粘贴一段已经启封的信件正文…"
                onChange={(event) => {
                  setExcerpt(event.target.value);
                  setRedactions([]);
                  resetProjection();
                }}
                onSelect={(event) =>
                  setSelection({
                    start: event.currentTarget.selectionStart,
                    end: event.currentTarget.selectionEnd,
                  })
                }
              />
            </label>
            <div className="share-composer__redaction-actions">
              <button type="button" onClick={() => markSelection("name")}>
                <UserRound size={15} aria-hidden="true" /> 涂黑选中姓名
              </button>
              <button type="button" onClick={() => markSelection("place")}>
                <MapPin size={15} aria-hidden="true" /> 涂黑选中地点
              </button>
              <button
                type="button"
                disabled={redactions.length === 0}
                onClick={() => {
                  setRedactions([]);
                  resetProjection();
                }}
              >
                <Eraser size={15} aria-hidden="true" /> 清除涂黑
              </button>
            </div>
            <div
              className="share-composer__redaction-preview"
              aria-live="polite"
            >
              <strong>涂黑预览</strong>
              <p>
                {excerpt.length > 0
                  ? redactForPreview(excerpt, redactions).map(
                      (segment, index) =>
                        segment.redacted ? (
                          <mark
                            key={`${segment.label ?? "custom"}-${index}`}
                            aria-label={`${segment.label === "name" ? "姓名" : segment.label === "place" ? "地点" : "内容"}已涂黑`}
                          >
                            {segment.text}
                          </mark>
                        ) : (
                          <span key={`text-${index}`}>{segment.text}</span>
                        ),
                    )
                  : "尚未填写摘录。"}
              </p>
            </div>
          </section>
        ) : (
          <div className="share-composer__privacy-default">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>正文摘录已关闭；默认导出中不会出现正文。</span>
          </div>
        )}

        {message ? (
          <p className="share-composer__message" role="status">
            {message}
          </p>
        ) : null}
        <div className="share-composer__actions">
          <button
            className="button button--ghost"
            type="button"
            disabled={pending}
            onClick={() => void buildPreview()}
          >
            <FileImage size={16} aria-hidden="true" />
            {pending ? "正在核对…" : "生成安全预览"}
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={!projection || exporting}
            onClick={() => void exportPng()}
          >
            <Download size={16} aria-hidden="true" />
            {exporting ? "正在导出…" : "导出本地 PNG"}
          </button>
        </div>
      </section>

      <section
        className="share-composer__preview"
        aria-labelledby="share-preview-title"
      >
        <div className="share-composer__preview-heading">
          <div>
            <h2 id="share-preview-title">分享预览</h2>
            <p>{projection ? "安全投影已核对" : "正文默认关闭"}</p>
          </div>
          <span>PNG · 1400 × 800</span>
        </div>
        <SharePreviewCard {...(projection ? { projection } : {})} />
        <p className="share-composer__local-note">
          <LockKeyhole size={15} aria-hidden="true" />
          预览只在本机显示；点击导出后才会创建下载文件。
        </p>
      </section>
    </div>
  );
}

function ShareToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
