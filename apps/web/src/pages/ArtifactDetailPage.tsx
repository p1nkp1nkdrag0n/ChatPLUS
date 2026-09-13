import { ArrowLeft, Download, ExternalLink, LockKeyhole } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorBlock, LoadingBlock } from "../components/Feedback";
import { KeepsakeArtwork } from "../components/archive/KeepsakeArtwork";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import {
  keepsakeDetailQueryOptions,
  keepsakeStatusDescription,
  keepsakeStatusLabel,
} from "../lib/keepsakes";
import {
  KEEPSAKE_KIND_LABELS,
  SOURCE_TYPE_LABELS,
  formatArchiveDate,
} from "../lib/relationshipArchive";

export default function ArtifactDetailPage() {
  const { keepsakeId = "" } = useParams();
  const detailQuery = useQuery(keepsakeDetailQueryOptions(keepsakeId));
  const agentId = detailQuery.data?.keepsake.agentId;
  useEffect(() => {
    // AppShell owns the shared SSE connection for the active relationship.
    if (agentId) rememberActiveCharacter(agentId);
  }, [agentId]);

  if (detailQuery.isPending) {
    return <LoadingBlock label="正在取出纪念物…" fullPage />;
  }
  if (detailQuery.error && !detailQuery.data) {
    return <ErrorBlock error={detailQuery.error} />;
  }
  if (!detailQuery.data) return null;

  const { keepsake, sources } = detailQuery.data;
  const hasImage =
    keepsake.status === "ready" && keepsake.primaryAssetId !== undefined;
  const relatedLetters = sources.filter((source) => source.type === "letter");
  return (
    <div className="artifact-detail-page">
      <header className="artifact-detail-header">
        <Link
          className="archive-back-link"
          to={`/characters/${keepsake.agentId}/keepsakes`}
        >
          <ArrowLeft size={15} aria-hidden="true" /> 返回纪念物陈列柜
        </Link>
        <div>
          <span>{KEEPSAKE_KIND_LABELS[keepsake.kind]}</span>
          <h1>{keepsake.title}</h1>
          <time dateTime={keepsake.createdEffectiveAtUtc}>
            {formatArchiveDate(keepsake.createdEffectiveAtUtc, "UTC", false)}
          </time>
        </div>
        {hasImage ? (
          <Link
            className="button button--ghost"
            to={`/characters/${keepsake.agentId}/relationship-share?keepsakeId=${encodeURIComponent(keepsake.id)}`}
          >
            <Download size={16} aria-hidden="true" /> 制作分享图
          </Link>
        ) : (
          <div className="artifact-share-pending">
            <button className="button button--ghost" type="button" disabled>
              <Download size={16} aria-hidden="true" /> 制作分享图
            </button>
            <small>专属图案完成后，就可以制作分享图。</small>
          </div>
        )}
      </header>

      <main className="artifact-detail-layout">
        <figure className="artifact-hero">
          <KeepsakeArtwork
            keepsakeId={keepsake.id}
            kind={keepsake.kind}
            title={keepsake.title}
            src={
              hasImage
                ? `/api/keepsakes/${encodeURIComponent(keepsake.id)}/asset`
                : undefined
            }
            eager
          />
          <figcaption>
            {hasImage
              ? "图案已保存在你的收藏中。"
              : "先收好这份纪念，专属图案会在完成后补全。"}
          </figcaption>
        </figure>

        <div className="artifact-story">
          <section>
            <div className="artifact-image-status" aria-live="polite">
              <strong className="keepsake-status" data-status={keepsake.status}>
                {keepsakeStatusLabel(keepsake.status)}
              </strong>
              <p>{keepsakeStatusDescription(keepsake.status)}</p>
              {detailQuery.error ? (
                <p>暂时无法更新图案状态，已收到的纪念物仍为你保留。</p>
              ) : null}
            </div>
            <h2>这件物品的来历</h2>
            <p>{keepsake.description}</p>
          </section>
          <section className="artifact-provenance">
            <h2>来源与证据</h2>
            <ol>
              {sources.map((source) => (
                <li key={`${source.type}:${source.id}`}>
                  <span aria-hidden="true" />
                  <div>
                    <small>{SOURCE_TYPE_LABELS[source.type]}</small>
                    <strong>{source.label}</strong>
                    {source.effectiveAtUtc ? (
                      <time dateTime={source.effectiveAtUtc}>
                        {formatArchiveDate(source.effectiveAtUtc, "UTC", false)}
                      </time>
                    ) : null}
                  </div>
                  <Link to={source.href}>
                    打开来源 <ExternalLink size={14} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ol>
            <p className="artifact-privacy-note">
              <LockKeyhole size={15} aria-hidden="true" />
              来源只显示安全摘要；未启封信件与隐藏证据不会出现在此页。
            </p>
          </section>
          <section>
            <h2>相关信件</h2>
            {relatedLetters.length > 0 ? (
              <ul className="artifact-related-letters">
                {relatedLetters.map((letter) => (
                  <li key={letter.id}>
                    <Link to={letter.href}>{letter.label}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="artifact-muted">暂未关联已归档信件。</p>
            )}
          </section>
          <section>
            <h2>后续提及</h2>
            <p className="artifact-muted">
              当它再次出现在聊天、书信或关系记录中，会沿原始来源继续串联在这里。
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
