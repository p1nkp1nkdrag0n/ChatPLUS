import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Flower2 } from "lucide-react";
import { type AchievementCategory } from "../api/achievements";
import { useAchievements } from "../hooks/useAchievements";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { AchievementCard } from "../components/achievements/AchievementBadge";
import { AchievementDetail } from "../components/achievements/AchievementDetail";

const categories: { value: AchievementCategory; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "global", label: "我的足迹" },
  { value: "character", label: "与角色的纪念" },
];

export default function AchievementsPage() {
  const [params, setParams] = useSearchParams();
  const [category, setCategory] = useState<AchievementCategory>("all");
  const [agentId, setAgentId] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const query = useAchievements({
    category,
    limit: 24,
    ...(agentId ? { agentId } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const items = query.data?.items ?? [];
  const filtersActive = category !== "all" || Boolean(agentId);
  const resetPage = () => {
    setCursor(undefined);
    setHistory([]);
  };
  const detailId = params.get("achievement");
  const closeDetail = () =>
    setParams((previous) => {
      previous.delete("achievement");
      return previous;
    });
  return (
    <div className="page achievements-page">
      <PageHeader
        title="成就收藏"
        description="把相处中值得记住的时刻，收进一枚小小的纪念。"
      />
      <section className="achievement-intro" aria-label="收藏寄语">
        <Flower2 size={37} strokeWidth={1.1} aria-hidden="true" />
        <div>
          <h2>一路走来，皆有回响</h2>
          <p>每一次回来，每一段相识，都会留下属于你的印记。</p>
        </div>
        <span aria-hidden="true">Dear moments, kept.</span>
      </section>
      <div className="achievement-filterbar">
        <div className="achievement-tabs" role="group" aria-label="成就类别">
          {categories.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={category === option.value}
              className={category === option.value ? "is-active" : ""}
              onClick={() => {
                setCategory(option.value);
                if (option.value === "global") setAgentId("");
                resetPage();
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {category !== "global" ? (
          <label className="achievement-character-filter">
            <span>角色</span>
            <select
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                resetPage();
              }}
            >
              <option value="">所有角色</option>
              {query.data?.agents.map((agent) => (
                <option value={agent.id} key={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {query.isPending ? <LoadingBlock label="正在打开成就收藏…" /> : null}
      {query.error ? (
        <ErrorBlock
          error={query.error}
          action={
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void query.refetch()}
            >
              重新加载
            </button>
          }
        />
      ) : null}
      {!query.isPending && !query.error && !items.length ? (
        <EmptyState
          title={filtersActive ? "这里还没有留下纪念" : "你的故事，正要开始"}
          description={
            filtersActive
              ? "继续自然地相处，值得记住的时刻会留在这里。"
              : "走进 Dearvale，遇见一个角色，写下第一句问候。属于你的纪念会慢慢到来。"
          }
          action={
            filtersActive ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setCategory("all");
                  setAgentId("");
                  resetPage();
                }}
              >
                查看全部收藏
              </button>
            ) : (
              <Link className="button button--secondary" to="/characters">
                去遇见角色
              </Link>
            )
          }
        />
      ) : null}
      {items.length ? (
        <div className="achievement-grid" aria-label="已获得的成就">
          {items.map((item) => (
            <AchievementCard
              key={item.id}
              achievement={item}
              onSelect={() => setParams({ achievement: item.id })}
            />
          ))}
        </div>
      ) : null}
      {history.length || query.data?.nextCursor ? (
        <nav className="achievement-pagination" aria-label="成就分页">
          <button
            type="button"
            className="button button--ghost"
            disabled={!history.length || query.isPending}
            onClick={() => {
              setCursor(history.at(-1));
              setHistory((previous) => previous.slice(0, -1));
            }}
          >
            <ChevronLeft size={16} />
            上一页
          </button>
          <span>第 {history.length + 1} 页</span>
          <button
            type="button"
            className="button button--ghost"
            disabled={!query.data?.nextCursor || query.isPending}
            onClick={() => {
              setHistory((previous) => [...previous, cursor]);
              setCursor(query.data?.nextCursor);
            }}
          >
            下一页
            <ChevronRight size={16} />
          </button>
        </nav>
      ) : null}
      {detailId ? (
        <AchievementDetail key={detailId} id={detailId} onClose={closeDetail} />
      ) : null}
    </div>
  );
}
