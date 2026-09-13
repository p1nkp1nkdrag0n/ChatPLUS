import { useState } from "react";
import {
  Flower2,
  Image,
  Mail,
  NotebookPen,
  PencilLine,
  Ticket,
} from "lucide-react";
import type { KeepsakeKind } from "@personasim/contracts";
import { KEEPSAKE_KIND_LABELS } from "../../lib/relationshipArchive";
import "../../styles/keepsakes.css";

const KIND_ICONS = {
  postcard: Mail,
  ticket_stub: Ticket,
  polaroid: Image,
  sketch: PencilLine,
  pressed_flower: Flower2,
  recipe_or_note_card: NotebookPen,
} as const;

export function KeepsakeArtwork({
  keepsakeId,
  kind,
  title,
  src,
  eager = false,
}: {
  keepsakeId: string;
  kind: KeepsakeKind;
  title: string;
  src?: string | undefined;
  eager?: boolean;
}) {
  const [loaded, setLoaded] = useState<{ id: string; url: string }>();
  const [failedUrl, setFailedUrl] = useState<string>();
  const displayedUrl = loaded?.id === keepsakeId ? loaded.url : undefined;
  const candidateUrl = src && src !== failedUrl ? src : undefined;
  const imageFailed = Boolean(src && src === failedUrl);
  const Icon = KIND_ICONS[kind];

  return (
    <span
      className={`keepsake-artwork keepsake-artwork--${kind}`}
      role="img"
      aria-label={`${title}${imageFailed ? "，图案暂时无法显示，保留基础外观" : ""}`}
      data-artwork-ready={displayedUrl !== undefined}
    >
      <span className="keepsake-artwork__paper" aria-hidden="true">
        <span className="keepsake-artwork__eyebrow">一份共同的记忆</span>
        <Icon
          className="keepsake-artwork__symbol"
          size={52}
          strokeWidth={1.1}
        />
        <span className="keepsake-artwork__rule" />
        <span className="keepsake-artwork__kind">
          {KEEPSAKE_KIND_LABELS[kind]}
        </span>
        <span className="keepsake-artwork__seal">留念</span>
      </span>
      {displayedUrl && displayedUrl !== candidateUrl ? (
        <img
          key={displayedUrl}
          className="keepsake-artwork__image is-ready"
          src={displayedUrl}
          alt=""
          onError={() => setLoaded(undefined)}
        />
      ) : null}
      {candidateUrl ? (
        <img
          key={candidateUrl}
          className={`keepsake-artwork__image${candidateUrl === displayedUrl ? " is-ready" : ""}`}
          src={candidateUrl}
          alt=""
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setLoaded({ id: keepsakeId, url: candidateUrl })}
          onError={() => {
            setFailedUrl(candidateUrl);
            if (displayedUrl === candidateUrl) setLoaded(undefined);
          }}
        />
      ) : null}
      {imageFailed ? (
        <span className="keepsake-artwork__notice" aria-hidden="true">
          图案暂时无法显示
        </span>
      ) : null}
    </span>
  );
}
