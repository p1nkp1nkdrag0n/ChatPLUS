import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { KeepsakeKind, KeepsakeSourceType } from "@personasim/contracts";
import { api, unwrapCharacter } from "../api/client";
import { KeepsakeShelf } from "../components/archive/ArchivePrimitives";
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/Feedback";
import { rememberActiveCharacter } from "../lib/activeCharacter";
import {
  KEEPSAKE_KIND_LABELS,
  SOURCE_TYPE_LABELS,
  relationshipArchiveQueryKeys,
} from "../lib/relationshipArchive";

type KeepsakeKindFilter = KeepsakeKind | "all";
type KeepsakeSourceFilter = KeepsakeSourceType | "all";

export default function KeepsakeCabinetPage() {
  const { characterId = "" } = useParams();
  const navigate = useNavigate();
  const [cursor, setCursor] = useState<string>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>(
    [],
  );
  const [kind, setKind] = useState<KeepsakeKindFilter>("all");
  const [period, setPeriod] = useState("all");
  const [source, setSource] = useState<KeepsakeSourceFilter>("all");

  useEffect(() => {
    if (characterId) rememberActiveCharacter(characterId);
  }, [characterId]);

  const characterQuery = useQuery({
    queryKey: ["character", characterId],
    queryFn: () => api.characters.get(characterId),
    enabled: Boolean(characterId),
  });
  const keepsakesQuery = useQuery({
    queryKey: relationshipArchiveQueryKeys.keepsakes(characterId, {
      ...(cursor ? { cursor } : {}),
      ...(kind === "all" ? {} : { kind }),
      ...(source === "all" ? {} : { sourceType: source }),
      ...(period === "all" ? {} : { period }),
    }),
    queryFn: () =>
      api.keepsakes.list(characterId, {
        limit: 6,
        ...(cursor ? { cursor } : {}),
        ...(kind === "all" ? {} : { kind }),
        ...(source === "all" ? {} : { sourceType: source }),
        ...(period === "all" ? {} : { period }),
      }),
    enabled: Boolean(characterId),
  });
  const items = keepsakesQuery.data?.items ?? [];
  const filterOptions = keepsakesQuery.data?.filterOptions ?? {
    kinds: [],
    sourceTypes: [],
    periods: [],
  };
  const character = characterQuery.data
    ? unwrapCharacter(characterQuery.data)
    : undefined;
  const timezone = character?.identity.timezone ?? "UTC";
  const filtersActive = kind !== "all" || period !== "all" || source !== "all";

  const resetPage = () => {
    setCursor(undefined);
    setCursorHistory([]);
  };
  const nextPage = () => {
    const next = keepsakesQuery.data?.nextCursor;
    if (!next) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(next);
  };
  const previousPage = () => {
    const previous = cursorHistory.at(-1);
    setCursorHistory((history) => history.slice(0, -1));
    setCursor(previous);
  };
  const clearFilters = () => {
    setKind("all");
    setPeriod("all");
    setSource("all");
    resetPage();
  };

  return (
    <div className="keepsake-cabinet-page">
      <header className="archive-header keepsake-header">
        <div>
          <Link
            className="archive-back-link"
            to={`/characters/${characterId}/relationship-archive`}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回关系档案
          </Link>
          <h1>纪念物陈列柜</h1>
          <p>{character?.identity.name ?? "角色"} 与你共同经历留下的物件。</p>
        </div>
      </header>

      <div className="keepsake-filterbar" aria-label="筛选纪念物">
        <SlidersHorizontal size={17} aria-hidden="true" />
        <label>
          <span>类型</span>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as KeepsakeKindFilter);
              resetPage();
            }}
          >
            <option value="all">全部类型</option>
            {filterOptions.kinds.map((value) => (
              <option value={value} key={value}>
                {KEEPSAKE_KIND_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>角色时期</span>
          <select
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value);
              resetPage();
            }}
          >
            <option value="all">全部时期</option>
            {filterOptions.periods.map((value) => (
              <option value={value} key={value}>
                {value.replace("-", " 年 ")} 月
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>来源</span>
          <select
            value={source}
            onChange={(event) => {
              setSource(event.target.value as KeepsakeSourceFilter);
              resetPage();
            }}
          >
            <option value="all">全部来源</option>
            {filterOptions.sourceTypes.map((value) => (
              <option value={value} key={value}>
                {SOURCE_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {characterQuery.isPending || keepsakesQuery.isPending ? (
        <LoadingBlock label="正在打开纪念物陈列柜…" />
      ) : null}
      {characterQuery.error || keepsakesQuery.error ? (
        <ErrorBlock error={characterQuery.error ?? keepsakesQuery.error} />
      ) : null}

      {!keepsakesQuery.isPending &&
      !keepsakesQuery.error &&
      items.length === 0 ? (
        <EmptyState
          title={
            filtersActive ? "没有符合筛选条件的纪念物" : "陈列柜里还没有纪念物"
          }
          description={
            filtersActive
              ? "这是整个陈列柜的筛选结果；可以调整类型、时期或来源后再看。"
              : "只有已经发生且能够追溯来源的经历，才会在这里留下物件。"
          }
          action={
            filtersActive ? (
              <button
                className="button button--ghost"
                type="button"
                onClick={clearFilters}
              >
                清除筛选
              </button>
            ) : (
              <Link
                className="button button--ghost"
                to={`/characters/${characterId}/relationship-archive`}
              >
                查看关系档案
              </Link>
            )
          }
        />
      ) : null}

      {items.length > 0 ? (
        <main className="keepsake-cabinet">
          <div className="keepsake-cabinet__heading">
            <p>当前页 {items.length} 件</p>
            <span>每件物品都保留可验证的来历</span>
          </div>
          <KeepsakeShelf
            items={items}
            timezone={timezone}
            onSelect={(item) => void navigate(`/keepsakes/${item.id}`)}
          />
          <nav className="keepsake-pagination" aria-label="纪念物分页">
            <button
              className="button button--ghost"
              type="button"
              disabled={cursorHistory.length === 0}
              onClick={previousPage}
            >
              <ChevronLeft size={16} aria-hidden="true" /> 上一页
            </button>
            <span>第 {cursorHistory.length + 1} 页</span>
            <button
              className="button button--ghost"
              type="button"
              disabled={!keepsakesQuery.data?.nextCursor}
              onClick={nextPage}
            >
              下一页 <ChevronRight size={16} aria-hidden="true" />
            </button>
          </nav>
        </main>
      ) : null}
    </div>
  );
}
