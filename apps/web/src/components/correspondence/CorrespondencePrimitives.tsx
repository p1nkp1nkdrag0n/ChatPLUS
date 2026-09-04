import { Archive, Check, Eye, LockKeyhole, Mail, Send } from "lucide-react";
import type {
  LetterSummaryResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  formatCorrespondenceDate,
  statusLabel,
  transitPresentation,
} from "../../lib/correspondence";

export type PaperTemplate = "cotton" | "plain" | "midnight";

const PAPER_OPTIONS: Array<{
  value: PaperTemplate;
  label: string;
}> = [
  { value: "cotton", label: "棉纸" },
  { value: "plain", label: "素笺" },
  { value: "midnight", label: "夜蓝" },
];

export function PaperSelector({
  value,
  onChange,
}: {
  value: PaperTemplate;
  onChange: (value: PaperTemplate) => void;
}) {
  return (
    <fieldset className="paper-selector">
      <legend>信纸模板</legend>
      <div className="paper-selector__options">
        {PAPER_OPTIONS.map((option) => (
          <label key={option.value} className="paper-selector__option">
            <input
              type="radio"
              name="paper-template"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span
              className={`paper-selector__sample paper-selector__sample--${option.value}`}
              aria-hidden="true"
            >
              {value === option.value ? <Check size={15} /> : null}
            </span>
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function LetterPaper({
  paper = "cotton",
  subject,
  body,
  salutation,
  closing,
  signature,
  postscript,
  recipient,
  authoredDate,
  children,
  readingMode = false,
  headingRef,
}: {
  paper?: PaperTemplate;
  subject?: string;
  body?: string;
  salutation?: string;
  closing?: string;
  signature?: string;
  postscript?: string;
  recipient?: string;
  authoredDate?: string;
  children?: ReactNode;
  readingMode?: boolean;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <article
      className={`letter-paper letter-paper--${paper}${readingMode ? " letter-paper--clear" : ""}`}
    >
      <div className="letter-paper__postmark" aria-label="PersonaSim 邮戳">
        <span>PERSONASIM</span>
        <strong>{authoredDate?.replaceAll("-", ".") ?? "MAIL"}</strong>
      </div>
      {subject ? (
        <h1 ref={headingRef} tabIndex={-1} className="letter-paper__subject">
          {subject}
        </h1>
      ) : null}
      {recipient ? (
        <p className="letter-paper__recipient">{recipient}：</p>
      ) : null}
      {salutation ? (
        <p className="letter-paper__salutation">{salutation}</p>
      ) : null}
      {body ? <div className="letter-paper__body">{body}</div> : children}
      {closing ? <p className="letter-paper__closing">{closing}</p> : null}
      {signature ? (
        <p className="letter-paper__signature">{signature}</p>
      ) : null}
      {postscript ? (
        <aside className="letter-paper__postscript">
          <strong>附言</strong>
          <p>{postscript}</p>
        </aside>
      ) : null}
    </article>
  );
}

export function OpenedLetterPaper({
  opened,
  paper,
  readingMode,
  headingRef,
}: {
  opened: OpenLetterResponse;
  paper?: PaperTemplate;
  readingMode: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <LetterPaper
      {...(paper === undefined ? {} : { paper })}
      subject={opened.subject}
      body={opened.body}
      salutation={opened.salutation}
      closing={opened.closing}
      signature={opened.signature}
      {...(opened.postscript === undefined
        ? {}
        : { postscript: opened.postscript })}
      authoredDate={opened.letter.authoredDisplayDate}
      readingMode={readingMode}
      headingRef={headingRef}
    />
  );
}

export function EnvelopePanel({
  correspondent,
  letter,
  isRevealing = false,
  openPending = false,
  onOpen,
  openHref,
}: {
  correspondent: string;
  letter: LetterSummaryResponse;
  isRevealing?: boolean;
  openPending?: boolean;
  onOpen?: () => void;
  openHref?: string;
}) {
  const openLabel = letter.status === "read" ? "再次阅读" : "启封阅读";
  return (
    <section
      className={`envelope-panel${isRevealing ? " envelope-panel--revealing" : ""}`}
      aria-label={`来自 ${correspondent} 的信封`}
    >
      <div className="envelope-panel__address">
        <span>致：</span>
        <strong>你</strong>
      </div>
      <div className="envelope-panel__postmark" aria-label={letter.postmark}>
        <span>{correspondent.slice(0, 4)}</span>
        <strong>{letter.authoredDisplayDate.replaceAll("-", ".")}</strong>
        <small>寄出</small>
      </div>
      <div className="envelope-panel__flap" aria-hidden="true" />
      {onOpen ? (
        <button
          className="button envelope-panel__open"
          type="button"
          disabled={openPending}
          onClick={onOpen}
        >
          <LockKeyhole size={18} aria-hidden="true" />
          {openPending ? "正在读取…" : openLabel}
        </button>
      ) : openHref ? (
        <Link className="button envelope-panel__open" to={openHref}>
          <LockKeyhole size={18} aria-hidden="true" /> {openLabel}
        </Link>
      ) : null}
    </section>
  );
}

export function TransitProgress({
  letter,
  serverTimeUtc,
  timezone = "UTC",
}: {
  letter: LetterSummaryResponse;
  serverTimeUtc: string;
  timezone?: string;
}) {
  const transit = transitPresentation(letter, serverTimeUtc, "zh-CN", timezone);
  const percent = Math.round(transit.progress * 100);
  return (
    <section className="transit-progress" aria-labelledby="transit-heading">
      <h2 id="transit-heading">信件在途</h2>
      <div
        className="transit-progress__track"
        role="progressbar"
        aria-label="按日期计算的运输进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="transit-progress__steps">
        <li className="is-complete">
          <Check size={14} aria-hidden="true" />
          <span>寄出</span>
          <time>{transit.dispatchedLabel ?? "日期待定"}</time>
        </li>
        <li className={percent >= 100 ? "is-complete" : "is-current"}>
          <Send size={14} aria-hidden="true" />
          <span>
            {transit.statusLabel}
            {transit.dayLabel ? ` · ${transit.dayLabel}` : ""}
          </span>
          <time>{transit.dispatchedLabel ?? "运输中"}</time>
        </li>
        <li className={percent >= 100 ? "is-complete" : ""}>
          <Mail size={14} aria-hidden="true" />
          <span>{percent >= 100 ? "已经抵达" : "预计抵达"}</span>
          <time>{transit.arrivalLabel ?? "日期待定"}</time>
        </li>
      </ol>
    </section>
  );
}

export function ExchangeTimeline({
  letters,
  correspondent,
  agentId,
}: {
  letters: readonly LetterSummaryResponse[];
  correspondent: string;
  agentId: string;
}) {
  return (
    <ol className="exchange-timeline" aria-label={`与 ${correspondent} 的往来`}>
      {letters.map((letter) => {
        const Icon = timelineIcon(letter);
        return (
          <li key={letter.id}>
            <span className="exchange-timeline__node" aria-hidden="true">
              <Icon size={16} />
            </span>
            <div>
              <time>
                {formatCorrespondenceDate(letter.authoredDisplayDate)}
              </time>
              <strong>
                {letter.direction === "user_to_agent"
                  ? "你寄出"
                  : `${correspondent} 来信`}
              </strong>
              <span>{statusLabel(letter.status, letter.direction)}</span>
              <Link
                to={`/letters/${letter.id}?agentId=${encodeURIComponent(agentId)}`}
              >
                查看信件
              </Link>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function timelineIcon(letter: LetterSummaryResponse) {
  if (letter.status === "read")
    return letter.direction === "agent_to_user" ? Eye : Archive;
  return letter.direction === "agent_to_user" ? Mail : Send;
}
