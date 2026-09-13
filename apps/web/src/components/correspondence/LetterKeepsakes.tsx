import { useQueries } from "@tanstack/react-query";
import { ChevronRight, Gift } from "lucide-react";
import type { KeepsakeDetailResponse } from "@personasim/contracts";
import { Link } from "react-router-dom";
import {
  keepsakeDetailQueryOptions,
  keepsakeStatusDescription,
  keepsakeStatusLabel,
} from "../../lib/keepsakes";
import { KEEPSAKE_KIND_LABELS } from "../../lib/relationshipArchive";
import { KeepsakeArtwork } from "../archive/KeepsakeArtwork";

/** Mounted only after a reply has been opened and its reading view is visible. */
export function LetterKeepsakes({
  keepsakeIds,
}: {
  keepsakeIds: readonly string[];
}) {
  const queries = useQueries({
    queries: keepsakeIds.map(keepsakeDetailQueryOptions),
  });
  if (keepsakeIds.length === 0) return null;

  return (
    <section className="letter-keepsakes" aria-label="随信纪念物">
      <header>
        <Gift size={18} aria-hidden="true" />
        <div>
          <h2>随信送给你的纪念物</h2>
          <p>已经替你收好，也可以在纪念物陈列柜里再次找到。</p>
        </div>
      </header>
      <ul>
        {queries.map((query, index) => (
          <li key={keepsakeIds[index]}>
            {query.data ? (
              <LetterKeepsakeCard detail={query.data} />
            ) : query.isError ? (
              <div className="letter-keepsakes__unavailable">
                <p>这件随信纪念物暂时无法取出，你可以稍后再次查看。</p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void query.refetch()}
                >
                  再次查看
                </button>
              </div>
            ) : (
              <p className="letter-keepsakes__loading" role="status">
                正在取出随信纪念物…
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LetterKeepsakeCard({
  detail,
}: {
  detail: KeepsakeDetailResponse;
}) {
  const { keepsake, sources } = detail;
  const hasImage =
    keepsake.status === "ready" && keepsake.primaryAssetId !== undefined;
  return (
    <Link
      className="letter-keepsake-card"
      to={`/keepsakes/${encodeURIComponent(keepsake.id)}`}
    >
      <KeepsakeArtwork
        keepsakeId={keepsake.id}
        kind={keepsake.kind}
        title={keepsake.title}
        src={
          hasImage
            ? `/api/keepsakes/${encodeURIComponent(keepsake.id)}/thumbnail`
            : undefined
        }
      />
      <span className="letter-keepsake-card__story">
        <small>{KEEPSAKE_KIND_LABELS[keepsake.kind]} · 已收好</small>
        <strong>{keepsake.title}</strong>
        <span className="keepsake-status" data-status={keepsake.status}>
          {keepsakeStatusLabel(keepsake.status)}
        </span>
        <span>{keepsakeStatusDescription(keepsake.status)}</span>
        <span className="letter-keepsake-card__source">
          来历：{sources[0]?.label ?? keepsake.description}
        </span>
        <span className="letter-keepsake-card__open">
          打开纪念物 <ChevronRight size={14} aria-hidden="true" />
        </span>
      </span>
    </Link>
  );
}
