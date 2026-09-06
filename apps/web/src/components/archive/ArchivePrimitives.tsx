import {
  Archive,
  CheckCircle2,
  ChevronRight,
  Flower2,
  HeartHandshake,
  Image,
  Mail,
  MapPin,
  NotebookPen,
  Sparkles,
  Ticket,
} from "lucide-react";
import type {
  KeepsakeDetailResponse,
  KeepsakeKind,
  KeepsakeSummaryResponse,
  RelationshipArchiveEntry,
  RelationshipShareProjection,
} from "@personasim/contracts";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import {
  SOURCE_TYPE_LABELS,
  archiveEntryDisplayTitle,
  archiveEntryTypeLabel,
  formatArchiveDate,
  type ArchiveMonthGroup,
} from "../../lib/relationshipArchive";

export function ArchiveTimeline({
  groups,
  selectedId,
  timezone,
  onSelect,
}: {
  groups: readonly ArchiveMonthGroup[];
  selectedId?: string;
  timezone: string;
  onSelect: (entry: RelationshipArchiveEntry) => void;
}) {
  return (
    <div className="relationship-timeline">
      {groups.map((group) => (
        <section className="relationship-month" key={group.key}>
          <h2>{group.label}</h2>
          <ol>
            {group.items.map((entry) => {
              const Icon = archiveIcon(entry);
              const displayTitle = archiveEntryDisplayTitle(entry);
              return (
                <li
                  key={`${entry.entryType}:${entry.id}`}
                  data-archive-entry-id={entry.id}
                  className={selectedId === entry.id ? "is-selected" : ""}
                >
                  <span
                    className={`relationship-entry__icon relationship-entry__icon--${entry.entryType}`}
                    aria-hidden="true"
                  >
                    <Icon size={18} strokeWidth={1.7} />
                  </span>
                  <button
                    className="relationship-entry__select"
                    type="button"
                    onClick={() => onSelect(entry)}
                  >
                    <span className="relationship-entry__titleline">
                      <strong>{displayTitle}</strong>
                      <span>{archiveEntryTypeLabel(entry)}</span>
                    </span>
                    <span className="relationship-entry__summary">
                      {entry.summary}
                    </span>
                    <time dateTime={entry.effectiveAtUtc}>
                      {formatArchiveDate(entry.effectiveAtUtc, timezone)}
                    </time>
                  </button>
                  <Link
                    className="relationship-entry__source"
                    to={entry.href}
                    aria-label={`打开来源：${displayTitle}`}
                  >
                    打开来源 <ChevronRight size={14} aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function KeepsakeShelf({
  items,
  selectedId,
  timezone,
  onSelect,
}: {
  items: readonly KeepsakeSummaryResponse[];
  selectedId?: string | undefined;
  timezone: string;
  onSelect?: (keepsake: KeepsakeSummaryResponse) => void;
}) {
  return (
    <ul className="keepsake-shelf">
      {items.slice(0, 6).map((keepsake) => (
        <li
          key={keepsake.id}
          className={selectedId === keepsake.id ? "is-selected" : ""}
        >
          <button
            type="button"
            onClick={() => onSelect?.(keepsake)}
            aria-pressed={selectedId === keepsake.id}
          >
            <span className="keepsake-shelf__image">
              {keepsake.thumbnailUrl ? (
                <img
                  src={keepsake.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <KeepsakeGlyph kind={keepsake.kind} />
              )}
            </span>
            <strong>{keepsake.title}</strong>
            <time dateTime={keepsake.createdEffectiveAtUtc}>
              {formatArchiveDate(
                keepsake.createdEffectiveAtUtc,
                timezone,
                false,
              )}
            </time>
            <span>来自哪次经历</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ProvenancePanel({
  archiveEntry,
  keepsakeDetail,
}: {
  archiveEntry?: RelationshipArchiveEntry | undefined;
  keepsakeDetail?: KeepsakeDetailResponse | undefined;
}) {
  if (!archiveEntry && !keepsakeDetail) {
    return (
      <section className="provenance-panel" aria-labelledby="provenance-title">
        <h2 id="provenance-title">来自哪次经历</h2>
        <p className="provenance-panel__empty">
          选择一条档案或一件纪念物，查看它能够追溯到的来源。
        </p>
      </section>
    );
  }

  return (
    <section className="provenance-panel" aria-labelledby="provenance-title">
      <h2 id="provenance-title">来自哪次经历</h2>
      {keepsakeDetail ? (
        <>
          <h3>{keepsakeDetail.keepsake.title}</h3>
          <p>{keepsakeDetail.keepsake.description}</p>
          <ul>
            {keepsakeDetail.sources.map((source) => (
              <li key={`${source.type}:${source.id}`}>
                <span className="provenance-panel__source-icon">
                  {sourceIcon(source.type)}
                </span>
                <div>
                  <span>{SOURCE_TYPE_LABELS[source.type]}</span>
                  <strong>{source.label}</strong>
                  {source.effectiveAtUtc ? (
                    <time dateTime={source.effectiveAtUtc}>
                      {formatArchiveDate(source.effectiveAtUtc, "UTC", false)}
                    </time>
                  ) : null}
                </div>
                <Link to={source.href}>查看来源</Link>
              </li>
            ))}
          </ul>
        </>
      ) : archiveEntry ? (
        <>
          <h3>{archiveEntryDisplayTitle(archiveEntry)}</h3>
          <p>{archiveEntry.summary}</p>
          <div className="provenance-panel__archive-meta">
            <CheckCircle2 size={17} aria-hidden="true" />
            <span>{archiveEntryTypeLabel(archiveEntry)}</span>
            <Link to={archiveEntry.href}>查看可验证来源</Link>
          </div>
          <p className="provenance-panel__privacy">
            这里只显示安全投影，不展示隐藏证据或未启封信件正文。
          </p>
        </>
      ) : null}
    </section>
  );
}

export function SharePreviewCard({
  projection,
  keepsake,
  emptyLabel = "选择档案内容后生成预览",
}: {
  projection?: RelationshipShareProjection | undefined;
  keepsake?: KeepsakeSummaryResponse | undefined;
  emptyLabel?: string;
}) {
  const previewKeepsake = projection?.keepsake;
  const imageUrl = previewKeepsake?.assetUrl ?? keepsake?.thumbnailUrl;
  return (
    <div className="share-preview-card" aria-label="本地分享图片预览">
      <div className="share-preview-card__airmail" aria-hidden="true" />
      <div className="share-preview-card__keepsake">
        {imageUrl ? (
          <img src={imageUrl} alt="" />
        ) : (
          <Archive size={42} strokeWidth={1.2} aria-hidden="true" />
        )}
      </div>
      <div className="share-preview-card__content">
        <span>致重要的人：</span>
        <strong>
          {previewKeepsake?.title ?? keepsake?.title ?? "一段共同的回忆"}
        </strong>
        {projection?.envelope?.postmark ? (
          <span className="share-preview-card__postmark">
            {projection.envelope.postmark}
          </span>
        ) : null}
        {projection?.envelope?.waitingDays !== undefined ? (
          <span className="share-preview-card__waiting">
            已等待 {projection.envelope.waitingDays} 天
          </span>
        ) : null}
        {projection?.redactedExcerpt ? (
          <p>“{projection.redactedExcerpt}”</p>
        ) : (
          <p>{projection ? "正文未包含" : emptyLabel}</p>
        )}
      </div>
    </div>
  );
}

function archiveIcon(entry: RelationshipArchiveEntry): LucideIcon {
  switch (entry.entryType) {
    case "letter":
      return Mail;
    case "turning_point":
      return HeartHandshake;
    case "life":
      return NotebookPen;
    case "keepsake":
      return keepsakeIcon(entry.keepsakeKind);
  }
}

function keepsakeIcon(kind: KeepsakeKind): LucideIcon {
  switch (kind) {
    case "ticket_stub":
      return Ticket;
    case "pressed_flower":
      return Flower2;
    case "postcard":
    case "polaroid":
      return Image;
    case "recipe_or_note_card":
      return NotebookPen;
    case "sketch":
      return Sparkles;
  }
}

function KeepsakeGlyph({ kind }: { kind: KeepsakeKind }) {
  const Icon = keepsakeIcon(kind);
  return <Icon size={40} strokeWidth={1.2} aria-hidden="true" />;
}

function sourceIcon(type: keyof typeof SOURCE_TYPE_LABELS) {
  const Icon =
    type === "letter"
      ? Mail
      : type === "relationship_milestone"
        ? HeartHandshake
        : type === "reflection"
          ? NotebookPen
          : MapPin;
  return <Icon size={17} strokeWidth={1.7} aria-hidden="true" />;
}
