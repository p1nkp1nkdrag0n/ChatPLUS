import {
  ArrowRight,
  Clock3,
  MessageCircle,
  Pencil,
  Plus,
  Upload,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, unwrapList } from "../api/client";
import type { CharacterSummary } from "../api/types";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { TierLabel } from "../components/TierLabel";
import { formatLocalDateTime } from "../lib/date";

export default function CharacterLibraryPage() {
  const query = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters.list,
  });
  const characters = query.data
    ? unwrapList<CharacterSummary>(query.data, "characters")
    : [];

  return (
    <div className="page page--library">
      <PageHeader
        title="角色"
        description="创建、校准并继续每一个角色的生活。"
        actions={
          <div className="button-row">
            <Link className="button button--ghost" to="/import">
              <Upload size={16} aria-hidden="true" /> 导入作品角色
            </Link>
            <Link className="button button--primary" to="/create">
              <Plus size={16} aria-hidden="true" /> 创建角色
            </Link>
          </div>
        }
      />

      {query.isPending ? <LoadingBlock label="正在读取本地角色…" /> : null}
      {query.isError ? <ErrorBlock error={query.error} /> : null}

      {!query.isPending && !query.isError && characters.length === 0 ? (
        <EmptyState
          title="先创造一个会继续生活的角色"
          description="只需要八个简短答案。Fixture 模型无需 API Key，也能完成角色生成、持续生活和聊天演示。"
          action={
            <Link className="button button--primary" to="/create">
              开始创建 <ArrowRight size={16} aria-hidden="true" />
            </Link>
          }
        />
      ) : null}

      {characters.length > 0 ? (
        <section className="character-list" aria-label="角色列表">
          <div className="character-list__heading">
            <span>角色</span>
            <span>近期主线</span>
            <span>最近更新</span>
            <span className="sr-only">操作</span>
          </div>
          {characters.map((character) => (
            <article
              className="character-row"
              key={character.id}
              data-testid="character-row"
            >
              <div className="character-row__identity">
                <span className="character-monogram" aria-hidden="true">
                  {character.name.slice(0, 1)}
                </span>
                <div>
                  <div className="character-row__name">
                    <h2>{character.name}</h2>
                    <TierLabel tier={character.tier} />
                  </div>
                  <p>{character.workOrRole || "尚未定义社会身份"}</p>
                </div>
              </div>
              <div className="character-row__life">
                <span className={`life-dot life-dot--${character.status}`} />
                <div>
                  <strong>
                    {character.status === "draft" ? "等待发布" : "生活仍在继续"}
                  </strong>
                  <span>
                    {character.status === "draft"
                      ? "完成设定后开始长期陪伴"
                      : "选择、感受与共同经历会在交流中积累"}
                  </span>
                </div>
              </div>
              <div className="character-row__updated">
                <Clock3 size={15} aria-hidden="true" />
                <span>{formatLocalDateTime(character.updatedAtUtc)}</span>
                <small>v{character.version}</small>
              </div>
              <div className="character-row__actions">
                <Link
                  className="icon-button"
                  to={`/characters/${character.id}/edit`}
                  aria-label={`编辑 ${character.name}`}
                >
                  <Pencil size={17} aria-hidden="true" />
                </Link>
                <Link
                  className="button button--quiet"
                  to={
                    character.status === "published"
                      ? `/characters/${character.id}/chat`
                      : `/characters/${character.id}/edit`
                  }
                >
                  {character.status === "published" ? (
                    <MessageCircle size={16} aria-hidden="true" />
                  ) : (
                    <ArrowRight size={16} aria-hidden="true" />
                  )}
                  {character.status === "published" ? "继续聊天" : "继续编辑"}
                </Link>
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
